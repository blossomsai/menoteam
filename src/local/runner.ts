import { spawn } from 'node:child_process';
import type { LocalRunner } from './types.js';

const MAX_OUTPUT = 64_000;
const MAX_EVENT = 16_000;
const MAX_LINE = 256_000;
const TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 5_000;

export const runCodex: LocalRunner = ({ project, job, codexBinary = 'codex', onEvent }) => {
  const args = ['exec', '--json', '--color', 'never', '--sandbox', job.mode, '-C', project.path, '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="medium"', '-c', 'approval_policy="never"', '--skip-git-repo-check'];
  const child = spawn(codexBinary, args, { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let output = ''; let stderr = ''; let buffer = ''; let threadId: string | undefined;
  let failure: Error | undefined; let structuredFailure = ''; let closed = false; let cleanupDone = false; let settled = false;
  let exitCode: number | null = null; let exitSignal: NodeJS.Signals | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let resolveResult!: (value: { output: string; threadId?: string }) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<{ output: string; threadId?: string }>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const timeout = setTimeout(() => stop(new Error('Codex run timed out')), TIMEOUT_MS);

  function kill(signal: NodeJS.Signals): boolean {
    if (!child.pid) return false;
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = Object.assign(new Error(`Codex process cleanup failed: ${message(error)}`), { recoveryRequired: true });
      return false;
    }
  }
  function groupExists(): boolean {
    if (!child.pid || process.platform === 'win32') return !closed;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  function cleanup(): void {
    if (cleanupDone || cleanupTimer) return;
    clearTimeout(timeout);
    kill('SIGTERM');
    const deadline = Date.now() + KILL_GRACE_MS;
    cleanupTimer = setInterval(() => {
      if (groupExists() && Date.now() < deadline) return;
      // A successful group SIGKILL also covers children which closed their pipes.
      // Zombie group members cannot execute and need not hold a scheduler slot.
      if (groupExists()) kill('SIGKILL');
      clearInterval(cleanupTimer); cleanupTimer = undefined; cleanupDone = true; finish();
    }, 50);
  }
  function stop(error: Error): void { failure ??= error; cleanup(); }
  function finish(): void {
    if (settled || !closed || !cleanupDone) return;
    settled = true; clearTimeout(timeout);
    if (!failure && structuredFailure) failure = new Error(structuredFailure);
    if (!failure && exitCode !== 0) failure = new Error(stderr.trim() || `Codex exited ${exitCode ?? exitSignal}`);
    if (failure) rejectResult(failure); else resolveResult({ output, ...(threadId ? { threadId } : {}) });
  }
  function emit(type: string, text: string): void {
    if (failure) return;
    try { onEvent({ type, text: text.slice(0, MAX_EVENT), ...(threadId ? { threadId } : {}) }); }
    catch (error) { stop(new Error(`Codex event callback failed: ${message(error)}`)); }
  }
  function consume(line: string): void {
    if (!line.trim() || failure) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { output = append(output, line); emit('output', line); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { output = append(output, line); emit('output', line); return; }
    const event = parsed as Record<string, unknown>;
    const type = typeof event.type === 'string' ? event.type : 'event';
    if (type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
    if (type === 'error' || type === 'turn.failed') {
      const detail = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : event;
      structuredFailure = String(detail.message ?? event.message ?? `Codex ${type}`).slice(0, MAX_EVENT);
    }
    if (type === 'item.completed' && event.item && typeof event.item === 'object') {
      const item = event.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') output = append(output, item.text);
      if (item.type === 'command_execution' && typeof item.command === 'string') output = append(output, `$ ${item.command}\n${String(item.aggregated_output ?? '')}`);
      emit(String(item.type ?? type), String(item.text ?? item.aggregated_output ?? item.command ?? ''));
    } else emit(type, line);
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (failure) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset);
      const end = newline < 0 ? chunk.length : newline;
      if (buffer.length + end - offset > MAX_LINE) { buffer = ''; stop(new Error(`Codex JSONL event exceeds ${MAX_LINE} characters`)); return; }
      buffer += chunk.slice(offset, end);
      if (newline < 0) break;
      consume(buffer); buffer = ''; offset = newline + 1;
    }
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr = append(stderr, chunk); });
  child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') stop(error); });
  child.on('error', (error) => stop(error));
  child.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; cleanup(); });
  child.on('close', (code, signal) => { exitCode = code; exitSignal = signal; if (buffer) consume(buffer); buffer = ''; closed = true; cleanup(); finish(); });
  child.stdin.end(buildPrompt(project.goal, project.instructions, job.prompt));
  return { result, cancel: () => { if (!settled) stop(Object.assign(new Error('Codex run cancelled'), { cancelled: true })); } };
};

function append(current: string, next: string): string { return (current + next).slice(-MAX_OUTPUT); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function buildPrompt(goal: string, instructions: string, prompt: string): string {
  return [goal && `Project goal:\n${goal}`, instructions && `Project instructions:\n${instructions}`, 'Execution boundaries: work only on this request. Do not send external messages, publish changes, or merge automatically. Report results for human review.', `Request:\n${prompt}`].filter(Boolean).join('\n\n');
}
