import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCodex } from '../src/local/runner.js';
import type { LocalJob, LocalProject } from '../src/local/types.js';

const folders: string[] = [];
const active: ReturnType<typeof runCodex>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of active.splice(0)) { handle.cancel(); await handle.result.catch(() => undefined); }
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
async function fake(source: string, onEvent: Parameters<typeof runCodex>[0]['onEvent'] = () => undefined) {
  const folder = await mkdtemp(join(tmpdir(), 'menoteam-runner-')); folders.push(folder);
  const executable = join(folder, 'codex-fake');
  await writeFile(executable, `#!${process.execPath}\nprocess.chdir(process.argv[process.argv.indexOf("-C") + 1]);\n${source}`, { mode: 0o700 });
  const project: LocalProject = { id: 'p', name: 'Test', path: folder, repositoryUrl: '', goal: 'Project goal', instructions: 'Project instructions', workRef: 'work_test', createdAt: '', updatedAt: '' };
  const job: LocalJob = { id: 'j', projectId: 'p', prompt: 'Request checkpoint', mode: 'read-only', status: 'running', createdAt: '', updatedAt: '', output: '', events: [] };
  const handle = runCodex({ project, job, codexBinary: executable, onEvent }); active.push(handle);
  return { handle, folder };
}
async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await readFile(file, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(`File was not created: ${file}`);
}
const treeScript = (exitParent: boolean) => `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
process.stdin.resume();
const heartbeat = join(process.cwd(), 'heartbeat');
const child = spawn(process.execPath, ['-e', "const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20)", heartbeat], { stdio:'ignore' });
writeFileSync(join(process.cwd(),'child-pid'), String(child.pid));
${exitParent ? "setTimeout(()=>process.exit(0),100);" : "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"}
`;

describe('local Codex executable runner', () => {
  it('parses fragmented JSONL, flushes the final line, and passes bounded execution context', async () => {
    const events: Array<{ type: string; text: string; threadId?: string }> = [];
    const { handle } = await fake(`
let input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{
 const expected=['--sandbox','read-only','-m','gpt-6-luna','approval_policy="never"'];
 if (!expected.every(arg=>process.argv.includes(arg)) || !['Project goal','Project instructions','Request checkpoint','Do not send external messages'].every(s=>input.includes(s))) process.exit(2);
 process.stdout.write('{"type":"thread.');
 setTimeout(()=>{ process.stdout.write('started","thread_id":"thread_one"}\\n'); process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'final reply'}})); },20);
});`, (event) => events.push(event));
    await expect(handle.result).resolves.toEqual({ output: 'final reply', threadId: 'thread_one' });
    expect(events.map((event) => event.type)).toEqual(['thread.started', 'agent_message']);
    expect(events[1]?.threadId).toBe('thread_one');
  });

  it.each([0, 1])('reports stdout turn.failed even when exit code is %s', async (code) => {
    const { handle } = await fake(`process.stdin.resume(); process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'model unavailable'}})+'\\n',()=>process.exit(${code}));`);
    await expect(handle.result).rejects.toThrow('model unavailable');
  });

  it('rejects event callback failures rather than treating them as parse errors', async () => {
    const { handle } = await fake(`process.stdin.resume(); process.stdout.write('{"type":"thread.started","thread_id":"t"}\\n'); setInterval(()=>{},1000);`, () => { throw new Error('disk failure'); });
    await expect(handle.result).rejects.toThrow('Codex event callback failed: disk failure');
  });

  it('bounds output/events and rejects oversized JSONL instead of parsing its tail', async () => {
    const events: Array<{ text: string }> = [];
    const { handle } = await fake(`process.stdin.resume(); process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'a'.repeat(100000)}})+'\\n');`, (event) => events.push(event));
    const result = await handle.result;
    expect(result.output).toHaveLength(64_000);
    expect(events[0]?.text).toHaveLength(16_000);
    const oversized = await fake(`process.stdin.resume(); process.stdout.write('x'.repeat(300000)); setInterval(()=>{},1000);`);
    await expect(oversized.handle.result).rejects.toThrow('JSONL event exceeds');
  });

  it('kills TERM-resistant child trees before cancellation settles', async () => {
    const { handle, folder } = await fake(treeScript(false));
    const heartbeat = join(folder, 'heartbeat'); await waitForFile(heartbeat);
    const rejected = expect(handle.result).rejects.toThrow('Codex run cancelled');
    handle.cancel(); await rejected;
    const stopped = await readFile(heartbeat, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await readFile(heartbeat, 'utf8')).toBe(stopped);
  }, 12_000);

  it('cleans up a leaked child after the parent exits successfully', async () => {
    const { handle, folder } = await fake(treeScript(true));
    const heartbeat = join(folder, 'heartbeat'); await waitForFile(heartbeat);
    await expect(handle.result).resolves.toEqual({ output: '' });
    const stopped = await readFile(heartbeat, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await readFile(heartbeat, 'utf8')).toBe(stopped);
  }, 12_000);

  it('times out and terminates an actual spawned process', async () => {
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => realTimeout(fn, delay === 30 * 60_000 ? 150 : delay, ...args)) as typeof setTimeout);
    const { handle } = await fake(`process.stdin.resume(); setInterval(()=>{},1000);`);
    await expect(handle.result).rejects.toThrow('Codex run timed out');
  });

  it('reports missing executable errors without waiting for a timeout', async () => {
    const missing = runCodex({ project: { id:'p', name:'p', path:tmpdir(), repositoryUrl:'',goal:'',instructions:'',workRef:'w',createdAt:'',updatedAt:'' }, job: { id:'j',projectId:'p',prompt:'test',mode:'read-only',status:'running',createdAt:'',updatedAt:'',output:'',events:[] }, codexBinary: '/nonexistent/menoteam-codex', onEvent:()=>undefined });
    active.push(missing);
    await expect(missing.result).rejects.toThrow('ENOENT');
  });
});
