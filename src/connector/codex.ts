import { execFile as execFileCb, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile as readFileCb } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ClaimedRun, ConnectorEvent, QaCheck } from './types.js';
import { fingerprint } from './git.js';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string; code?: number } };
type ToolHandler = (name: string, input: Record<string, unknown>, requestId: string) => Promise<unknown>;

const MASTER_BRIDGE_TOOLS = ['read_context','read_work','read_run','create_work','update_work','dispatch','post_message','update_settings','create_skill'];
const REVIEW_BRIDGE_TOOLS = ['read_work','read_run'];

function scopedBridgeConfig(contextFile: string, tools: string[]) {
  const compiledPath = fileURLToPath(new URL('./mcp-bridge.js', import.meta.url));
  const sourcePath = fileURLToPath(new URL('./mcp-bridge.ts', import.meta.url));
  const isSource = import.meta.url.endsWith('.ts');
  const bridgePath = isSource ? sourcePath : compiledPath;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  return { mcp_servers: { menoteam: {
    command: isSource ? path.join(repoRoot, 'node_modules/.bin/tsx') : process.execPath,
    args: [bridgePath],
    env: { MENOTEAM_RUN_CONTEXT_FILE: contextFile },
    enabled: true,
    required: true,
    enabled_tools: tools,
    tools: Object.fromEntries(tools.map(name => [name, { approval_mode: 'approve' }]))
  } } };
}

export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private readonly events = new EventEmitter();
  private serial = 0;
  private buffer = '';
  private readonly activeRejectors = new Set<(error: Error) => void>();
  private childClosed = false;
  private closeWaiter?: () => void;

  constructor(private readonly binary = 'codex') {}

  async start(cwd: string): Promise<string[]> {
    if (this.child) return this.models;
    const child = spawn(this.binary, ['app-server'], { cwd, stdio: ['pipe','pipe','pipe'], shell: false, detached: process.platform !== 'win32' });
    this.child = child;
    this.childClosed = false;
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.consume(String(chunk)));
    child.once('exit', code => { const error = new Error(`Codex app-server exited (${code ?? 'signal'})`); this.failAll(error); for (const reject of this.activeRejectors) reject(error); });
    child.once('close', () => { this.childClosed = true; this.closeWaiter?.(); this.closeWaiter = undefined; });
    child.once('error', () => this.failAll(new Error('Codex app-server could not start')));
    await this.request('initialize', { clientInfo: { name: 'menoteam-connector', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.notify('initialized', {});
    const models = await this.request('model/list', { limit: 100 });
    this.models = Array.isArray(models?.data) ? models.data.map((m: any) => String(m.id)).filter(Boolean) : [];
    if (!this.models.length) throw new Error('Codex app-server returned no available models');
    return this.models;
  }

  models: string[] = [];

  async processIdentity(): Promise<CodexProcessIdentity | undefined> {
    const pid = this.child?.pid;
    return pid ? readCodexProcessIdentity(pid) : undefined;
  }

  async run(claim: ClaimedRun, cwd: string, prompt: string, threadId: string | undefined,
    onEvent: (event: Omit<ConnectorEvent, 'id'>) => void,
    bridgeContextFile?: string): Promise<{ threadId: string; text: string; checks: QaCheck[] }> {
    if (!this.child) await this.start(cwd);
    if (!this.models.includes(claim.run.model)) throw Object.assign(new Error(`Requested model is unavailable on this connector: ${claim.run.model}`), {nativeStage:'model-validation',nativeCategory:'unavailable-model'});
    if ((claim.run.kind === 'master' || claim.run.kind === 'review') && !bridgeContextFile) {
      throw new Error(`${claim.run.kind} run needs its scoped MCP context file`);
    }
    const bridgeTools = claim.run.kind === 'master' ? MASTER_BRIDGE_TOOLS : claim.run.kind === 'review' ? REVIEW_BRIDGE_TOOLS : undefined;
    const config = bridgeTools ? scopedBridgeConfig(bridgeContextFile!, bridgeTools) : undefined;
    const sandbox = claim.run.kind === 'implementation' ? 'workspace-write' : 'read-only';
    const boundary = { cwd, sandbox, approvalPolicy: 'never', model: claim.run.model, ...(config ? { config } : {}) };
    const thread = threadId
      ? await this.request('thread/resume', { threadId, excludeTurns: true, ...boundary })
      : await this.request('thread/start', {
        ...boundary,
      });
    const id = thread?.thread?.id ?? thread?.id;
    if (typeof id !== 'string') throw new Error('Codex app-server did not return a thread ID');
    onEvent({ type: 'thread_started', text: `Native Codex thread ${id} is active.`, threadId: id });
    const checks: QaCheck[] = [];
    const pendingChecks = new Set<Promise<void>>();
    const commandStarts = new Map<string, Promise<string | null>>();
    let finalText = '';
    let turnId: string | undefined;
    let finish!: (result: any) => void;
    let fail!: (error: Error) => void;
    const done = new Promise<any>((resolve, reject) => { finish = resolve; fail = reject; });
    this.activeRejectors.add(fail);
    const listener = async (message: RpcMessage) => {
      if (message.method && message.id !== undefined) {
        try {
          if (message.method.includes('Approval')) this.respond(message.id, { decision: 'decline' });
          else this.respond(message.id, undefined, { code: -32601, message: 'Interactive requests are not available' });
        } catch (error) { this.respond(message.id, { contentItems: [{ type: 'inputText', text: String(error).slice(0, 1000) }], success: false }); }
        return;
      }
      const p = message.params ?? {};
      if (p.threadId && p.threadId !== id) return;
      const item = p.item;
      if (message.method === 'item/started' && item?.type === 'commandExecution' && isVerificationCommand(item)) {
        commandStarts.set(item.id, fingerprint(cwd).catch(() => null));
      }
      if (message.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') {
        finalText = item.text;
        onEvent({ type: 'agent_message', text: item.text, threadId: id });
      }
      if (message.method === 'item/completed' && item?.type === 'commandExecution') {
        const command = String(item.command ?? '');
        if (isVerificationCommand(item)) {
          const evidence = (async () => {
            const before = await commandStarts.get(item.id) ?? null;
            const finishedAt = new Date().toISOString();
            let after: string | null = null; try { after = await fingerprint(cwd); } catch { /* unproven */ }
            const testedRevision = before && before === after ? before : null;
            const durationMs = typeof item.durationMs === 'number' ? item.durationMs : null;
            checks.push({ name: command.slice(0, 160), command: command.slice(0, 1000), exitCode: item.exitCode ?? null, output: String(item.aggregatedOutput ?? '').slice(0, 30_000), outputChannel: 'combined', durationMs, startedAt: durationMs === null ? null : new Date(Date.parse(finishedAt) - durationMs).toISOString(), finishedAt, testedRevision, source: 'codex-command' });
          })();
          commandStarts.delete(item.id);
          pendingChecks.add(evidence);
          void evidence.finally(() => pendingChecks.delete(evidence));
        }
      }
      if (message.method === 'turn/completed' && (!turnId || p.turn?.id === turnId)) {
        if (p.turn?.status === 'failed' || p.turn?.status === 'interrupted') fail(new Error(`Codex turn ${p.turn.status}`));
        else void Promise.all([...pendingChecks]).then(() => finish(p.turn), fail);
      }
    };
    this.events.on('message', listener);
    try {
      const started = await this.request('turn/start', { threadId: id, input: [{ type: 'text', text: prompt }], model: claim.run.model, effort: claim.run.reasoning, cwd, approvalPolicy: 'never' });
      turnId = started?.turn?.id;
      if (!turnId) throw new Error('Codex app-server did not start a turn');
      await done;
      return { threadId: id, text: finalText, checks };
    } finally { this.events.off('message', listener); this.activeRejectors.delete(fail); }
  }

  async stop(): Promise<void> {
    const child = this.child; this.child = undefined;
    if (!child) return;
    const pid = child.pid;
    child.stdin.end(); signalGroup(child, 'SIGTERM');
    if (!pid) {
      if (!this.childClosed) await new Promise<void>(resolve => { this.closeWaiter = resolve; });
      return;
    }
    const stopped = await terminateProcessGroup(pid, 1500);
    if (!stopped) throw new Error('Codex process group is still alive; run stop cannot be confirmed');
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.serial;
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC timed out: ${method}`)); }, 30_000);
      timeout.unref();
      this.pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) { this.pending.delete(id); clearTimeout(timeout); reject(error); } });
    }).catch(error => {
      const stages:Record<string,string> = {initialize:'native-initialize','model/list':'model-list','thread/resume':'thread-resume','thread/start':'thread-start','turn/start':'turn-start'};
      throw Object.assign(error instanceof Error ? error : new Error('Native RPC failed'), {nativeStage:stages[method] ?? 'native-rpc',nativeCategory:'rpc-failure'});
    });
  }
  private notify(method: string, params: unknown): void { this.child!.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  private respond(id: number | string, result?: unknown, error?: { code: number; message: string }): void { this.child!.stdin.write(`${JSON.stringify({ id, ...(error ? { error } : { result }) })}\n`); }
  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) { const error = new Error('Codex app-server output buffer exceeded limit'); this.failAll(error); for (const reject of this.activeRejectors) reject(error); void this.stop(); return; }
    for (;;) { const end = this.buffer.indexOf('\n'); if (end < 0) return; const line = this.buffer.slice(0,end).trim(); this.buffer = this.buffer.slice(end+1); if (!line) continue; let msg: RpcMessage; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && !msg.method && this.pending.has(Number(msg.id))) { const p = this.pending.get(Number(msg.id))!; this.pending.delete(Number(msg.id)); msg.error ? p.reject(Object.assign(new Error(msg.error.message ?? 'Codex RPC error'), {nativeCode:typeof msg.error.code==='number' ? msg.error.code : undefined})) : p.resolve(msg.result); }
      else this.events.emit('message', msg);
    }
  }
  private failAll(error: Error): void { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); }
}

function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return; } catch { /* fall back to parent */ } }
  child.kill(signal);
}

export async function waitProcessGroup(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  try { process.kill(-pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export async function terminateProcessGroup(pid: number, graceMs = 1500): Promise<boolean> {
  try { process.kill(-pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
  if (await waitProcessGroup(pid, graceMs)) return true;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
  return waitProcessGroup(pid, 2000);
}

export interface CodexProcessIdentity { pid: number; processGroupId: number; startedAt: string; command: string; }

/** Capture a PID-reuse-resistant identity before persisting a live app-server handle. */
export async function readCodexProcessIdentity(pid: number): Promise<CodexProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    if (process.platform === 'linux') {
      const stat = await readFileCb(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return undefined;
      const fields = stat.slice(close + 2).trim().split(/\s+/u);
      const processGroupId = Number(fields[2]);
      const startTicks = fields[19];
      if (!Number.isSafeInteger(processGroupId) || !startTicks) return undefined;
      const bootId = (await readFileCb('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      if (!bootId) return undefined;
      const command = (await readFileCb(`/proc/${pid}/cmdline`)).toString('utf8').replaceAll('\0', ' ').trim();
      if (!command.includes('codex') || !command.includes('app-server')) return undefined;
      return { pid, processGroupId, startedAt: `linux:${bootId}:${startTicks}`, command };
    }
    const [group, started, command] = await Promise.all(['pgid=', 'lstart=', 'command='].map(async field =>
      (await execFile('ps', ['-o', field, '-p', String(pid)], { encoding: 'utf8', maxBuffer: 16_384 })).stdout.trim()));
    const processGroupId = Number(group);
    const startedText = started ?? ''; const commandText = command ?? '';
    if (!startedText || !commandText || !Number.isSafeInteger(processGroupId) || !commandText.includes('codex') || !commandText.includes('app-server')) return undefined;
    return { pid, processGroupId, startedAt: `ps:${startedText}`, command: commandText };
  } catch { return undefined; }
}

/** Never kill a recycled PID: require the saved process identity to still match. */
export async function terminateVerifiedProcessGroup(identity: CodexProcessIdentity, graceMs = 1500): Promise<boolean> {
  if (!Number.isSafeInteger(identity.processGroupId) || identity.processGroupId !== identity.pid) return false;
  const current = await readCodexProcessIdentity(identity.pid);
  if (!current || current.startedAt !== identity.startedAt || current.command !== identity.command || current.processGroupId !== identity.processGroupId) return false;
  return terminateProcessGroup(identity.processGroupId, graceMs);
}

function isVerificationCommand(item: any): boolean {
  const command = String(item.command ?? '');
  const actions = Array.isArray(item.commandActions) ? item.commandActions.map((a: any) => `${a.type ?? ''} ${a.command ?? a.name ?? ''}`).join(' ') : '';
  return /\b(test|typecheck|lint|build|check|vitest|tsc)\b/iu.test(`${command} ${actions}`);
}
