import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkpoint, createDiff, ensureWorktree, git, gitWithEnv, waitForGit } from '../src/connector/git.js';
import { ConnectorRunner } from '../src/connector/runner.js';
import type { CodexAppServer } from '../src/connector/codex.js';
import type { WorkbenchConnectorClient } from '../src/connector/client.js';
import type { ClaimedRun, ConnectorConfig } from '../src/connector/types.js';
import { stateKey, writeSecureJson } from '../src/connector/state.js';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
let temporary = '';
vi.setConfig({ testTimeout: 15_000 });
afterEach(async () => { vi.unstubAllEnvs(); if (temporary) await rm(temporary, { recursive: true, force: true }); temporary = ''; });
async function fixture() {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'menoteam-git-lifecycle-')));
  const repo = path.join(temporary, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-q'); await git(repo, 'config', 'user.name', 'Fixture'); await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repo, 'source.txt'), 'base\n'); await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'base');
  const base = (await git(repo, 'rev-parse', 'HEAD')).trim();
  const ready = path.join(temporary, 'ready.json');
  const config: ConnectorConfig = { serverUrl: 'http://127.0.0.1:3200', token: 'unused', connectorId: 'one', dataDir: path.join(temporary, 'data'), projects: { project: repo }, pollIntervalMs: 1, leaseRenewIntervalMs: 5 };
  return { repo, base, ready, config };
}
async function shim(program: string) {
  const bin = path.join(temporary, 'bin'); await mkdir(bin);
  const file = path.join(bin, 'git');
  await writeFile(file, `#!${process.execPath}\nconst {spawnSync,spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const args=process.argv.slice(2);\n${program}\nconst result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);\n`);
  await chmod(file, 0o700); vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
}
const hang = (ready: string) => `writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
async function readyFile(file: string): Promise<{pid:number;descendant?:number}> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  throw new Error('Owned Git did not reach the fixture barrier');
}
function stopped(pid: number) { expect(() => process.kill(-pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' })); }

it('bounds a hung workspace preparation command and confirms its group stopped', async () => {
  const f = await fixture(); const bin = path.join(temporary, 'bin'); await mkdir(bin);
  const file = path.join(bin, 'git');
  await writeFile(file, `#!/bin/sh\nprintf '{"pid":%s}' "$$" > '${f.ready}'\nwhile :; do sleep 60; done\n`);
  await chmod(file, 0o700); vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  const started = Date.now(); const kill = vi.spyOn(process, 'kill');
  try {
    await expect(ensureWorktree(f.config, 'project', 'work', 'HEAD', { timeoutMs: 600 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    const group = kill.mock.calls.find(([pid, signal]) => pid < 0 && signal === 'SIGKILL')?.[0];
    expect(group).toBeLessThan(-1); stopped(-group!); expect(Date.now() - started).toBeLessThan(4500);
  } finally { kill.mockRestore(); }
});

it('bounds OS-delayed termination and refuses to report an unconfirmed group as stopped', async () => {
  const f = await fixture(); await shim(`if(args[0]==='unconfirmed'){${hang(f.ready)}return;}`);
  const originalKill = process.kill.bind(process); let pid = 0; let reportedStop = false; const abort = new AbortController();
  const signal = vi.spyOn(process, 'kill').mockImplementation((target, value) => {
    if (target === -pid && value === 'SIGKILL') return true; // Simulate a signal accepted while the OS keeps the group alive.
    return originalKill(target, value);
  });
  try {
    const started = Date.now();
    await expect(gitWithEnv(f.repo, {}, ['unconfirmed'], async value => { pid = value; }, async () => { reportedStop = true; }, 600, abort.signal)).rejects.toMatchObject({ code: 'EUNCONFIRMEDPROCESS' });
    expect(Date.now() - started).toBeLessThan(3500); expect(reportedStop).toBe(false); expect(originalKill(-pid, 0)).toBe(true);
    await expect(waitForGit(abort.signal)).rejects.toMatchObject({ code: 'EUNCONFIRMEDPROCESS' });
  } finally { signal.mockRestore(); if (pid) originalKill(-pid, 'SIGKILL'); }
});

it('cancels a checkpoint hook with a TERM-resistant descendant before returning', async () => {
  const f = await fixture(); await writeFile(path.join(f.repo, 'source.txt'), 'candidate\n');
  const hook = path.join(f.repo, '.git', 'hooks', 'pre-commit');
  const descendantProgram = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(f.ready)},JSON.stringify({pid:Number(process.argv[1]),descendant:process.pid}));setInterval(()=>{},1000);`;
  await writeFile(hook, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantProgram)},String(process.ppid)],{stdio:'inherit'});setInterval(()=>{},1000);\n`); await chmod(hook, 0o700);
  const abort = new AbortController(); const result = checkpoint(f.repo, 'candidate', { signal: abort.signal });
  const rejected = expect(result).rejects.toMatchObject({ code: 'ABORT_ERR' });
  const identity = await readyFile(f.ready); abort.abort(); await rejected; await waitForGit(abort.signal);
  stopped(identity.pid); expect(() => process.kill(identity.descendant!, 0)).toThrow();
  expect((await git(f.repo, 'rev-parse', 'HEAD')).trim()).toBe(f.base);
  expect(await git(f.repo, 'status', '--porcelain')).toContain('M  source.txt');
});

it('cancels the streamed binary diff rather than waiting for its output pipes', async () => {
  const f = await fixture(); await shim(`if(args.includes('--binary')){${hang(f.ready)}return;}`);
  const abort = new AbortController(); const result = createDiff(f.repo, f.base, { signal: abort.signal });
  const rejected = expect(result).rejects.toMatchObject({ code: 'ABORT_ERR' });
  const identity = await readyFile(f.ready); abort.abort(); await rejected; stopped(identity.pid);
});

it('drains large diff stdout and stderr while retaining only the bounded preview', async () => {
  const f = await fixture(); await shim(`if(args.includes('--binary')){process.stdout.write('x'.repeat(5*1024*1024));process.stderr.write('y'.repeat(5*1024*1024));return;}`);
  const diff = await createDiff(f.repo, f.base, { timeoutMs: 10_000 });
  expect(diff.patch.length).toBe(280_000); expect(diff.truncated).toBe(true);
});

it('rejects oversized ordinary Git output and confirms stop before its callback', async () => {
  const f = await fixture(); await shim(`if(args[0]==='oversized'){process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000);return;}`);
  let pid = 0; let confirmed = false;
  await expect(gitWithEnv(f.repo, {}, ['oversized'], async value => { pid = value; }, async () => { stopped(pid); confirmed = true; })).rejects.toMatchObject({ code: 'ENOBUFS' });
  expect(confirmed).toBe(true);
});

it.each(['remote-cancel', 'connector-stop'])('stops Git preparation on %s and never starts the native worker', async mode => {
  const f = await fixture(); await shim(`if(args.includes('--show-toplevel')){${hang(f.ready)}return;}`);
  const claim: ClaimedRun = { run: { id: 'run', connectorId: 'one', projectId: 'project', requestedBy: 'owner', workId: 'work', kind: 'implementation', prompt: 'Implement', model: 'gpt-6-luna', reasoning: 'low', status: 'running', generation: 1, createdAt: 'now', updatedAt: 'now', execution: { provider: 'openai', method: 'codex-host', skills: [], tools: [] } }, project: { id: 'project', name: 'Fixture', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: 'now' }, messages: [], settings: [] };
  let claimed = false; let paused = false; let runner: ConnectorRunner; let acknowledged = false; let renewals = 0;
  const workerStart = vi.fn(async () => ['gpt-6-luna']); const workerRun = vi.fn();
  const discovery = { start: async () => ['gpt-6-luna'], stop: async () => {} } as unknown as CodexAppServer;
  const worker = { start: workerStart, run: workerRun, stop: async () => {} } as unknown as CodexAppServer; let nativeCount = 0;
  const client = { claim: async () => { if (!claimed) { claimed = true; return claim; } if (acknowledged) await runner.stop(); return undefined; }, readRun: async () => ({ ...claim.run, status: paused ? 'cancelled' : 'running' }), renew: async () => { renewals++; }, stopped: async () => { stopped((await readyFile(f.ready)).pid); acknowledged = true; }, complete: async () => { throw new Error('Cancelled preparation must not complete'); } } as unknown as WorkbenchConnectorClient;
  runner = new ConnectorRunner(f.config, { native: () => nativeCount++ === 0 ? discovery : worker, client: () => client });
  const execution = runner.run();
  try {
    const identity = await readyFile(f.ready);
    if (mode === 'connector-stop') { await runner.stop(); stopped(identity.pid); } else paused = true;
    await execution;
    expect(acknowledged).toBe(true); expect(workerStart).not.toHaveBeenCalled(); expect(workerRun).not.toHaveBeenCalled();
    const renewalsAfterStop = renewals; await new Promise(resolve => setTimeout(resolve, 20)); expect(renewals).toBe(renewalsAfterStop);
  } finally { await runner.stop(); await execution; }
});

it('retains an unconfirmed Git reservation during recovery even when old native identity exists', async () => {
  const f = await fixture(); let runner: ConnectorRunner;
  const spoolPath = path.join(f.config.dataDir, 'spool', `${stateKey('run', '1')}.json`);
  const spool = { runId: 'run', generation: 1, events: [], artifacts: [], gitStopUnconfirmed: true, processIdentity: { pid: 123, processGroupId: 123, startedAt: 'old', command: 'codex app-server' } };
  await writeSecureJson(spoolPath, spool);
  const native = { start: async () => ['gpt-6-luna'], stop: async () => {} } as unknown as CodexAppServer;
  const acknowledge = vi.fn(); const client = { claim: async () => { await runner.stop(); return undefined; }, readRun: async () => { throw new Error('Unconfirmed Git cannot be released through native proof'); }, stopped: acknowledge } as unknown as WorkbenchConnectorClient;
  runner = new ConnectorRunner(f.config, { native: () => native, client: () => client }); await runner.run();
  expect(JSON.parse(await readFile(spoolPath, 'utf8'))).toEqual(spool); expect(acknowledge).not.toHaveBeenCalled();
});
