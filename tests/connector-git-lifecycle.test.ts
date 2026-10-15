import { withRecoveryState } from './helpers/connector-recovery.js';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { appendFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkpoint, createDiff, ensureWorktree, fingerprint, git, gitWithEnv, waitForGit, type GitOptions } from '../src/connector/git.js';
import { ConnectorRunner } from '../src/connector/runner.js';
import { readProcessIdentity, type CodexAppServer, type CodexProcessIdentity } from '../src/connector/codex.js';
import type { WorkbenchConnectorClient } from '../src/connector/client.js';
import type { ClaimedRun, ConnectorConfig } from '../src/connector/types.js';
import { stateKey, writeSecureJson } from '../src/connector/state.js';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
type Ownership = {
  active: boolean;
  abort: AbortController;
  pending: Set<Promise<unknown>>;
  groups: Set<number>;
  identities: Map<number, CodexProcessIdentity>;
  pidFiles: Set<string>;
  directories: Set<string>;
  abortDisposers: Set<() => void>;
  disposers: Set<() => Promise<unknown>>;
};
let ownership: Ownership | undefined;
vi.setConfig({ testTimeout: 15_000 });
async function cleanup(current: Ownership) {
  current.active = false;
  current.abort.abort();
  for (const abort of current.abortDisposers) abort();
  // Start disposers without awaiting: their completion can depend on the groups below stopping.
  const disposeTask = Promise.allSettled([...current.disposers].map(dispose => dispose()));
  const unresolved = new Set<number>();
  const captureGroups = async () => {
    unresolved.clear();
    for (const file of current.pidFiles) {
      try {
        const state = new Map<number, { status: string; identity?: CodexProcessIdentity }>();
        for (const line of (await readFile(file, 'utf8')).trim().split('\n')) {
          const match = /^([+x-])(\d+)(?: (.+))?$/u.exec(line); if (!match) continue;
          const pid = Number(match[2]); if (pid <= 1) continue;
          const identity = match[3] ? JSON.parse(match[3]) as CodexProcessIdentity : undefined;
          state.set(pid, { status: match[1]!, identity });
        }
        for (const [pid, { status, identity }] of state) {
          // Only an active record's saved spawn identity can grant signaling ownership.
          if (status === '+' && identity?.pid === pid && identity.processGroupId === pid && typeof identity.startedAt === 'string' && typeof identity.command === 'string') {
            current.groups.add(pid);
            if (!current.identities.has(pid)) current.identities.set(pid, identity);
          } else if (status !== '-' && !current.groups.has(pid)) unresolved.add(pid);
        }
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  };
  const signalGroups = async () => {
    for (const pid of current.groups) {
      const expected = current.identities.get(pid);
      if (!expected) continue;
      const live = await readProcessIdentity(pid);
      if (!live || live.startedAt !== expected.startedAt || live.processGroupId !== pid || live.command !== expected.command) continue;
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
        // EPERM is unresolved until the bounded stop proof below; never target a bare PID.
      }
    }
  };
  await captureGroups(); await signalGroups();
  const drainDeadline = Date.now() + 5000;
  while (current.pending.size && Date.now() < drainDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (current.pending.size) throw new Error(`Fixture cleanup could not drain ${current.pending.size} owned operation(s); retaining environment and temporary directories`);
  let disposeTimer: ReturnType<typeof setTimeout>;
  let disposeFinished: boolean;
  try { disposeFinished = await Promise.race([disposeTask.then(() => true), new Promise<false>(resolve => { disposeTimer = setTimeout(() => resolve(false), 5000); })]); }
  finally { clearTimeout(disposeTimer!); }
  if (!disposeFinished) throw new Error('Fixture cleanup could not stop owned runners; retaining environment and temporary directories');
  const disposeFailures = (await disposeTask).filter(result => result.status === 'rejected');
  await captureGroups(); await signalGroups();
  // Give close/reap callbacks a turn after owned operations drain before probing stopped groups.
  await new Promise<void>(resolve => setImmediate(resolve));
  const stopDeadline = Date.now() + 5000;
  for (const pid of new Set([...current.groups, ...unresolved])) {
    let stopped = false;
    let probeError: unknown;
    while (Date.now() < stopDeadline) {
      try { process.kill(-pid, 0); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') { stopped = true; break; }
        if (code !== 'EPERM') throw error;
        probeError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!stopped) throw new Error(`Fixture cleanup cannot confirm process group ${pid} stopped; retaining ownership and temporary directories`, { cause: probeError });
    current.groups.delete(pid); current.identities.delete(pid);
  }
  if (disposeFailures.length) throw new Error('Fixture cleanup stopped groups but an owned runner disposer failed; retaining environment and temporary directories', { cause: disposeFailures[0]!.status === 'rejected' ? disposeFailures[0]!.reason : undefined });
  vi.unstubAllEnvs();
  await Promise.all([...current.directories].map(directory => rm(directory, { recursive: true, force: true })));
}
afterEach(async () => {
  if (!ownership) return;
  await cleanup(ownership);
  ownership = undefined;
});
function newOwnership(): Ownership {
  return { active: true, abort: new AbortController(), pending: new Set(), groups: new Set(), identities: new Map(), pidFiles: new Set(), directories: new Set(), abortDisposers: new Set(), disposers: new Set() };
}
function ownedIt(name: string, run: () => Promise<void>) {
  return it(name, async () => {
    if (ownership) throw new Error('Previous fixture cleanup did not finish; refusing to start another owned test');
    const current = newOwnership();
    ownership = current;
    const operation = run(); current.pending.add(operation);
    try { await operation; } finally { current.pending.delete(operation); }
  });
}
function own<T>(operation: Promise<T>, current = ownership): Promise<T> {
  if (!current) return operation;
  current.pending.add(operation);
  void operation.finally(() => current.pending.delete(operation)).catch(() => undefined);
  return operation;
}
function assertActive(current = ownership) { if (!current?.active) throw new Error('Fixture ownership was cancelled'); }
function ownRunner(runner: ConnectorRunner) { ownership!.disposers.add(() => runner.stop()); return runner; }
async function fixture(current = ownership!) {
  assertActive(current);
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'menoteam-git-lifecycle-'))); current.directories.add(temporary);
  const repo = path.join(temporary, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-q'); await git(repo, 'config', 'user.name', 'Fixture'); await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repo, 'source.txt'), 'base\n'); await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'base');
  const base = (await git(repo, 'rev-parse', 'HEAD')).trim();
  const ready = path.join(temporary, 'ready.json');
  const config: ConnectorConfig = { serverUrl: 'http://127.0.0.1:3200', token: 'unused', connectorId: 'one', dataDir: path.join(temporary, 'data'), projects: { project: repo }, pollIntervalMs: 1, leaseRenewIntervalMs: 5 };
  const pidFile = path.join(temporary, 'owned-git.pid'); current.pidFiles.add(pidFile);
  return { ownership: current, temporary, repo, base, ready, config, pidFile };
}
async function shim(f: Awaited<ReturnType<typeof fixture>>, program: string) {
  const current = f.ownership; assertActive(current);
  const bin = path.join(f.temporary, 'bin'); await mkdir(bin);
  current.pidFiles.add(f.pidFile);
  const file = path.join(bin, 'git');
  await writeFile(file, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const {appendFileSync,writeFileSync}=require('node:fs');const args=process.argv.slice(2);appendFileSync(${JSON.stringify(f.pidFile)},'+'+process.pid+'\\n');process.on('exit',()=>appendFileSync(${JSON.stringify(f.pidFile)},'x'+process.pid+'\\n'));\n${program}\nconst result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);\n`);
  await chmod(file, 0o700); assertActive(current); vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
}
const hang = (ready: string) => `writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
async function readyFile(file: string, current = ownership!): Promise<{pid:number;descendant?:number}> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { assertActive(current); try { const identity = JSON.parse(await readFile(file, 'utf8')); assertActive(current); await ownGroup(current, identity.pid, path.dirname(file)); return identity; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  throw new Error('Owned Git did not reach the fixture barrier');
}
function stopped(pid: number, current = ownership!) { expect(() => process.kill(-pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' })); current.groups.delete(pid); current.identities.delete(pid); appendFileSync([...current.pidFiles][0]!, `-${pid}\n`); }

async function ownGroup(current: Ownership, pid: number, fixtureDirectory?: string) {
  if (!fixtureDirectory) current.groups.add(pid); // The live spawn callback owns this PID already.
  if (current.identities.has(pid)) return;
  const identity = await readProcessIdentity(pid);
  if (identity?.processGroupId !== pid) return;
  // A ready marker alone may be stale; only its unique fixture command can establish ownership.
  if (fixtureDirectory && !identity.command.includes(`${fixtureDirectory}${path.sep}`)) return;
  current.groups.add(pid); current.identities.set(pid, identity);
}

function trackedGit(current: Ownership, started?: (pid: number) => void): GitOptions & { signal: AbortSignal; cancel: () => void } {
  assertActive(current);
  const abort = new AbortController();
  current.abortDisposers.add(() => abort.abort());
  const processes = new Map<string, number>();
  return { signal: abort.signal, cancel: () => abort.abort(), processTracking: {
    intent: async () => {},
    started: async (id, pid) => { processes.set(id, pid); await ownGroup(current, pid); started?.(pid); },
    stopped: async id => {
      const pid = processes.get(id);
      if (pid === undefined) return;
      stopped(pid, current); // Only real ESRCH releases ownership, including failed barriers.
      processes.delete(id);
    },
  } };
}

it('cleans a spawned Git without a ready marker and cancels a late shim before restoring PATH', async () => {
  if (ownership) throw new Error('Previous fixture cleanup did not finish');
  const current = newOwnership(); ownership = current;
  const originalPath = process.env.PATH;
  const cwdBin = path.join(process.cwd(), 'bin');
  const binEntries = async () => readdir(cwdBin).then(entries => entries.sort()).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  const originalBinEntries = await binEntries();
  const f = await fixture(current);
  await shim(f, "setInterval(()=>{},1000);return;");
  let started!: (pid: number) => void;
  const spawned = new Promise<number>(resolve => { started = resolve; });
  const options = trackedGit(current, started);
  let gitSettled = false; let shimSettled = false;
  const gitTask = own(createDiff(f.repo, f.base, options).finally(() => { gitSettled = true; }), current);
  const gitOutcome = gitTask.then(() => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }));
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  current.abortDisposers.add(release);
  const lateShim = own(barrier.then(() => shim(f, '')).finally(() => { shimSettled = true; }), current);
  const shimOutcome = lateShim.then(() => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }));
  const pid = await spawned;
  expect(existsSync(f.ready)).toBe(false);
  await cleanup(current);
  expect(await gitOutcome).toMatchObject({ status: 'rejected', error: { code: 'ABORT_ERR' } });
  expect(await shimOutcome).toMatchObject({ status: 'rejected', error: { message: 'Fixture ownership was cancelled' } });
  expect(gitSettled).toBe(true); expect(shimSettled).toBe(true); expect(current.pending.size).toBe(0);
  expect(current.groups.size).toBe(0);
  expect(() => process.kill(-pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  expect(process.env.PATH).toBe(originalPath); expect(existsSync(f.temporary)).toBe(false);
  expect(await binEntries()).toEqual(originalBinEntries);
  ownership = undefined;
});

ownedIt('bounds a hung workspace preparation command and confirms its group stopped', async () => {
  const f = await fixture(); const bin = path.join(f.temporary, 'bin'); await mkdir(bin);
  const file = path.join(bin, 'git');
  f.ownership.pidFiles.add(f.pidFile); await writeFile(file, `#!/bin/sh\nprintf '+%s\\n' "$$" > '${f.pidFile}'\nprintf '{"pid":%s}' "$$" > '${f.ready}'\nwhile :; do sleep 60; done\n`);
  await chmod(file, 0o700); assertActive(f.ownership); vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  const started = Date.now(); const kill = vi.spyOn(process, 'kill');
  try {
    await expect(ensureWorktree(f.config, 'project', 'work', 'HEAD', { timeoutMs: 600, signal: f.ownership.abort.signal })).rejects.toMatchObject({ code: 'ETIMEDOUT', git: { command: 'repository-root', code: 'ETIMEDOUT', timeoutMs: 600, elapsedMs: expect.any(Number), stdoutBytes: 0, stderrBytes: 0, pid: expect.any(Number) } });
    const group = kill.mock.calls.find(([pid, signal]) => pid < 0 && signal === 'SIGKILL')?.[0];
    expect(group).toBeLessThan(-1); stopped(-group!, f.ownership); expect(Date.now() - started).toBeLessThan(4500);
  } finally { kill.mockRestore(); }
});

ownedIt('bounds OS-delayed termination and refuses to report an unconfirmed group as stopped', async () => {
  const f = await fixture(); await shim(f, `if(args[0]==='unconfirmed'){${hang(f.ready)}return;}`);
  const originalKill = process.kill.bind(process); let pid = 0; let reportedStop = false; const abort = new AbortController();
  f.ownership.abortDisposers.add(() => abort.abort());
  const signal = vi.spyOn(process, 'kill').mockImplementation((target, value) => {
    if (target === -pid && value === 'SIGKILL') return true; // Simulate a signal accepted while the OS keeps the group alive.
    return originalKill(target, value);
  });
  try {
    const started = Date.now();
    await expect(gitWithEnv(f.repo, {}, ['unconfirmed'], async value => { pid = value; await ownGroup(f.ownership, value); }, async () => { reportedStop = true; }, 600, abort.signal)).rejects.toMatchObject({ code: 'EUNCONFIRMEDPROCESS' });
    expect(Date.now() - started).toBeLessThan(3500); expect(reportedStop).toBe(false); expect(originalKill(-pid, 0)).toBe(true);
    await expect(waitForGit(abort.signal)).rejects.toMatchObject({ code: 'EUNCONFIRMEDPROCESS' });
  } finally { signal.mockRestore(); }
});

ownedIt('cancels a checkpoint hook with a TERM-resistant descendant before returning', async () => {
  const f = await fixture(); await writeFile(path.join(f.repo, 'source.txt'), 'candidate\n');
  const hook = path.join(f.repo, '.git', 'hooks', 'pre-commit');
  const descendantProgram = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(f.ready)},JSON.stringify({pid:Number(process.argv[1]),descendant:process.pid}));setInterval(()=>{},1000);`;
  await writeFile(hook, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantProgram)},String(process.ppid)],{stdio:'inherit'});setInterval(()=>{},1000);\n`); await chmod(hook, 0o700);
  const options = trackedGit(f.ownership); const result = own(checkpoint(f.repo, 'candidate', options));
  const rejected = expect(result).rejects.toMatchObject({ code: 'ABORT_ERR' });
  const identity = await readyFile(f.ready, f.ownership); options.cancel(); await rejected; await waitForGit(options.signal);
  stopped(identity.pid, f.ownership); expect(() => process.kill(identity.descendant!, 0)).toThrow();
  expect((await git(f.repo, 'rev-parse', 'HEAD')).trim()).toBe(f.base);
  expect(await git(f.repo, 'status', '--porcelain')).toContain('M  source.txt');
});

ownedIt('cancels the streamed binary diff rather than waiting for its output pipes', async () => {
  const f = await fixture(); await shim(f, `if(args.includes('--binary')){${hang(f.ready)}return;}`);
  const options = trackedGit(f.ownership); const result = own(createDiff(f.repo, f.base, options));
  const rejected = expect(result).rejects.toMatchObject({ code: 'ABORT_ERR' });
  const identity = await readyFile(f.ready, f.ownership); options.cancel(); await rejected; stopped(identity.pid, f.ownership);
});

ownedIt('drains large diff stdout and stderr while retaining only the bounded preview', async () => {
  const f = await fixture(); await shim(f, `if(args.includes('--binary')){process.stdout.write('x'.repeat(5*1024*1024));process.stderr.write('y'.repeat(5*1024*1024));return;}`);
  const diff = await own(createDiff(f.repo, f.base, { timeoutMs: 10_000 }));
  expect(diff.patch.length).toBe(280_000); expect(diff.truncated).toBe(true);
});

ownedIt('rejects oversized ordinary Git output and confirms stop before its callback', async () => {
  const f = await fixture(); await shim(f, `if(args[0]==='oversized'){process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000);return;}`);
  let pid = 0; let confirmed = false;
  const failure=await gitWithEnv(f.repo, {}, ['oversized'], async value => { pid = value; await ownGroup(f.ownership, value); }, async () => { stopped(pid, f.ownership); confirmed = true; }).catch(error=>error);
  expect(failure).toMatchObject({ code: 'ENOBUFS', git: { command: 'other', code: 'ENOBUFS', timeoutMs: 30_000, elapsedMs: expect.any(Number), stderrBytes: 0, pid: expect.any(Number) } });
  expect(failure.git.stdoutBytes).toBeGreaterThan(4*1024*1024);
  expect(confirmed).toBe(true);
});

for (const mode of ['remote-cancel', 'connector-stop'] as const) ownedIt(`stops Git preparation on ${mode} and never starts the native worker`, async () => {
  const f = await fixture(); await shim(f, `if(args.includes('--show-toplevel')){${hang(f.ready)}return;}`);
  const claim: ClaimedRun = { run: { id: 'run', connectorId: 'one', projectId: 'project', requestedBy: 'owner', workId: 'work', kind: 'implementation', prompt: 'Implement', model: 'gpt-6-luna', reasoning: 'low', status: 'running', generation: 1, createdAt: 'now', updatedAt: 'now', execution: { provider: 'openai', method: 'codex-host', skills: [], tools: [] } }, project: { id: 'project', name: 'Fixture', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: 'now' }, messages: [], settings: [] };
  let claimed = false; let paused = false; let runner: ConnectorRunner; let acknowledged = false; let renewals = 0;
  const workerStart = vi.fn(async () => ['gpt-6-luna']); const workerRun = vi.fn();
  const discovery = { start: async () => ['gpt-6-luna'], stop: async () => {} } as unknown as CodexAppServer;
  const worker = { start: workerStart, run: workerRun, stop: async () => {} } as unknown as CodexAppServer; let nativeCount = 0;
  const client = { claim: async () => { if (!claimed) { claimed = true; return claim; } if (acknowledged) await runner.stop(); return undefined; }, readRun: async () => ({ ...claim.run, status: paused ? 'cancelled' : 'running' }), renew: async () => { renewals++; }, stopped: async () => { stopped((await readyFile(f.ready, f.ownership)).pid); acknowledged = true; }, complete: async () => { throw new Error('Cancelled preparation must not complete'); } } as unknown as WorkbenchConnectorClient;
  runner = ownRunner(new ConnectorRunner(f.config, { native: () => nativeCount++ === 0 ? discovery : worker, client:()=>withRecoveryState(client)}));
  const execution = own(runner.run());
  try {
    const identity = await readyFile(f.ready, f.ownership);
    if (mode === 'connector-stop') { await runner.stop(); stopped(identity.pid, f.ownership); } else paused = true;
    await execution;
    expect(acknowledged).toBe(true); expect(workerStart).not.toHaveBeenCalled(); expect(workerRun).not.toHaveBeenCalled();
    const renewalsAfterStop = renewals; await new Promise(resolve => setTimeout(resolve, 20)); expect(renewals).toBe(renewalsAfterStop);
  } finally { await runner.stop(); await execution; }
});

ownedIt('retains an unconfirmed Git reservation during recovery even when old native identity exists', async () => {
  const f = await fixture(); let runner: ConnectorRunner;
  const spoolPath = path.join(f.config.dataDir, 'spool', `${stateKey('run', '1')}.json`);
  const spool = { runId: 'run', generation: 1, events: [], artifacts: [], gitStopUnconfirmed: true, processIdentity: { pid: 123, processGroupId: 123, startedAt: 'old', command: 'codex app-server' } };
  await writeSecureJson(spoolPath, spool);
  const savedSpool = await readFile(spoolPath, 'utf8');
  const native = { start: async () => ['gpt-6-luna'], stop: async () => {} } as unknown as CodexAppServer;
  const recoveryState = vi.fn(async (runId: string, generation: number) => {
    expect(runId).toBe('run'); expect(generation).toBe(1);
    return { id: 'run', generation: 1, status: 'interrupted', preEffectStaging: false, stagingRetired: false, merged: false };
  });
  const readRun = vi.fn(async () => { throw new Error('Unconfirmed Git cannot be released through native proof'); });
  const acknowledge = vi.fn(); const client = { claim: async () => { await runner.stop(); return undefined; }, recoveryState, readRun, stopped: acknowledge } as unknown as WorkbenchConnectorClient;
  const signalling = vi.spyOn(process, 'kill');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  runner = ownRunner(new ConnectorRunner(f.config, { native: () => native, client: () => client }));
  try {
    await own(runner.run());
    expect(recoveryState).toHaveBeenCalledWith('run', 1); expect(readRun).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Git process group stop remains unconfirmed; manual Connector recovery is required');
    expect(signalling).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
    expect(await readFile(spoolPath, 'utf8')).toBe(savedSpool);
    expect(JSON.parse(await readFile(spoolPath, 'utf8'))).toEqual(spool);
  } finally { signalling.mockRestore(); log.mockRestore(); await runner.stop(); }
});

ownedIt('stops active native on remote cancel even when its Git fingerprint group cannot be confirmed stopped', async () => {
  const f = await fixture(); await shim(f, `if(args[0]==='ls-files'){${hang(f.ready)}return;}`);
  const claim: ClaimedRun = { run: { id: 'run', connectorId: 'one', projectId: 'project', requestedBy: 'owner', workId: 'work', kind: 'implementation', prompt: 'Implement', model: 'gpt-6-luna', reasoning: 'low', status: 'running', generation: 1, createdAt: 'now', updatedAt: 'now', execution: { provider: 'openai', method: 'codex-host', skills: [], tools: [] } }, project: { id: 'project', name: 'Fixture', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: 'now' }, messages: [], settings: [] };
  let paused = false; let claimed = false; let rejectTurn: ((error: Error) => void) | undefined; let gitTask: Promise<unknown> | undefined; let nativeStopped = false; let pid = 0;
  let exit!: () => void; const exiting = new Promise<void>(resolve => { exit = resolve; });
  const workerStop = vi.fn(async () => { if (rejectTurn) { nativeStopped = true; rejectTurn(new Error('Native stopped')); rejectTurn = undefined; } });
  const worker = { start: async () => ['gpt-6-luna'], processIdentity: async () => ({ pid: 123, processGroupId: 123, startedAt: 'fixture', command: 'codex app-server' }), stop: workerStop, run: async (_claim: unknown, cwd: string, _prompt: string, _thread: string, _event: unknown, _bridge: unknown, options: GitOptions) => { gitTask = fingerprint(cwd, options).catch(() => undefined); return new Promise((_resolve, reject) => { rejectTurn = reject; }); } } as unknown as CodexAppServer;
  const discovery = { start: async () => ['gpt-6-luna'], stop: async () => {} } as unknown as CodexAppServer; let count = 0;
  const complete = vi.fn(); const acknowledge = vi.fn();
  const client = { claim: async () => { if (!claimed) { claimed = true; return claim; } await exiting; return undefined; }, readRun: async () => ({ ...claim.run, status: paused ? 'cancelled' : 'running' }), renew: async () => {}, complete, stopped: acknowledge } as unknown as WorkbenchConnectorClient;
  const runner = ownRunner(new ConnectorRunner(f.config, { native: () => count++ === 0 ? discovery : worker, client:()=>withRecoveryState(client)}));
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((target, value) => target === -pid && (value === 'SIGKILL' || value === 'SIGTERM') ? true : originalKill(target, value));
  const execution = own(runner.run()); const spoolPath = path.join(f.config.dataDir, 'spool', `${stateKey('run', '1')}.json`);
  try {
    pid = (await readyFile(f.ready, f.ownership)).pid; paused = true;
    const deadline = Date.now() + 6000;
    let retained: {gitStopUnconfirmed?:boolean;gitProcesses?:Record<string,unknown>;completion?:unknown;stopped?:boolean} = {};
    while (Date.now() < deadline) { retained = JSON.parse(await readFile(spoolPath, 'utf8')); if (retained.gitStopUnconfirmed) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(nativeStopped).toBe(true); expect(workerStop).toHaveBeenCalled(); expect(originalKill(-pid, 0)).toBe(true);
    expect(retained.gitStopUnconfirmed).toBe(true); expect(Object.keys(retained.gitProcesses ?? {})).toHaveLength(1); expect(retained.completion).toBeUndefined(); expect(retained.stopped).toBeUndefined();
    expect(complete).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
    await runner.stop().catch(() => undefined); exit(); await execution;
  } finally { kill.mockRestore(); await gitTask; await runner.stop().catch(() => undefined); exit(); await execution; }
});

for (const mode of ['missing-identity', 'unverifiable-identity'] as const) ownedIt(`retains a crashed checkpoint Git reservation with ${mode} despite old native stop proof`, async () => {
  const f = await fixture(); let runner: ConnectorRunner;
  const spoolPath = path.join(f.config.dataDir, 'spool', `${stateKey('run', '1')}.json`);
  const spool = { runId: 'run', generation: 1, events: [], artifacts: [], gitExecutorPid: process.pid, gitProcesses: { checkpoint: mode === 'missing-identity' ? null : { pid: process.pid, processGroupId: Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()), startedAt: 'unverifiable', command: 'git commit' } }, processIdentity: { pid: 123, processGroupId: 123, startedAt: 'old', command: 'codex app-server' } };
  await writeSecureJson(spoolPath, spool);
  const native = { start: async () => ['gpt-6-luna'], stop: async () => {} } as unknown as CodexAppServer;
  const acknowledge = vi.fn(); const complete = vi.fn();
  const client = { claim: async () => { await runner.stop(); return undefined; }, readRun: async () => ({ generation: 1, status: 'cancelled' }), stopped: acknowledge, complete } as unknown as WorkbenchConnectorClient;
  runner = ownRunner(new ConnectorRunner(f.config, { native: () => native, client:()=>withRecoveryState(client)})); await own(runner.run());
  expect(JSON.parse(await readFile(spoolPath, 'utf8'))).toEqual(spool); expect(acknowledge).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
});

ownedIt('keeps a real crashed checkpoint parent reservation through the Git identity persistence window', async () => {
  const f = await fixture(); await writeFile(path.join(f.repo, 'source.txt'), 'candidate\n');
  const hook = path.join(f.repo, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(f.ready)},JSON.stringify({pid:process.ppid}));setInterval(()=>{},1000);\n`); await chmod(hook, 0o700);
  const spoolPath = path.join(f.config.dataDir, 'spool', `${stateKey('run', '1')}.json`);
  const script = path.join(f.temporary, 'checkpoint-parent.mjs');
  const identityReady = path.join(f.temporary, 'checkpoint-identity-ready.json');
  await writeFile(script, `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import {checkpoint} from ${JSON.stringify(path.join(process.cwd(), 'src/connector/git.ts'))};import {readGitProcessIdentity} from ${JSON.stringify(path.join(process.cwd(), 'src/connector/codex.ts'))};import {writeSecureJson} from ${JSON.stringify(path.join(process.cwd(), 'src/connector/state.ts'))};
const processes=new Map();const spool={runId:'run',generation:1,events:[],artifacts:[],gitExecutorPid:process.pid,gitProcesses:{},processIdentity:{pid:123,processGroupId:123,startedAt:'old',command:'codex app-server'}};const save=()=>writeSecureJson(${JSON.stringify(spoolPath)},spool);
await checkpoint(${JSON.stringify(f.repo)},'candidate',{processTracking:{intent:async id=>{spool.gitProcesses[id]=null;await save();},started:async(id,pid)=>{processes.set(id,pid);appendFileSync(${JSON.stringify(f.pidFile)},'+'+pid+'\\n');let identity=await readGitProcessIdentity(pid);if(identity?.command.includes('commit')){
const initial=identity;const deadline=Date.now()+5000;let hookReady=false;
while(Date.now()<deadline){try{hookReady=JSON.parse(readFileSync(${JSON.stringify(f.ready)},'utf8')).pid===pid;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}if(hookReady)break;await new Promise(resolve=>setTimeout(resolve,10));}
if(!hookReady)throw new Error('Checkpoint hook did not reach the fixture barrier');
identity=await readGitProcessIdentity(pid);if(!identity||identity.pid!==initial.pid||identity.processGroupId!==initial.processGroupId||identity.startedAt!==initial.startedAt)throw new Error('Checkpoint Git identity changed before hook readiness');
appendFileSync(${JSON.stringify(f.pidFile)},'+'+pid+' '+JSON.stringify(identity)+'\\n');writeFileSync(${JSON.stringify(identityReady)},JSON.stringify({pid:identity.pid,processGroupId:identity.processGroupId,startedAt:identity.startedAt,command:identity.command}));await new Promise(()=>{});
}if(identity){appendFileSync(${JSON.stringify(f.pidFile)},'+'+pid+' '+JSON.stringify(identity)+'\\n');spool.gitProcesses[id]=identity;await save();}},stopped:async id=>{const pid=processes.get(id);if(pid!==undefined){let confirmed=false;try{process.kill(-pid,0);}catch(error){if(error.code!=='ESRCH')throw error;confirmed=true;}if(!confirmed)throw new Error('Checkpoint fixture group is still alive');appendFileSync(${JSON.stringify(f.pidFile)},'-'+pid+'\\n');processes.delete(id);}delete spool.gitProcesses[id];await save();}}});`);
  const parent = spawn(process.execPath, ['--import', path.join(process.cwd(), 'node_modules/tsx/dist/loader.mjs'), script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; parent.stdout.on('data', chunk => { output += chunk; }); parent.stderr.on('data', chunk => { output += chunk; });
  const closed = own(new Promise<void>(resolve => parent.once('close', () => resolve()))); let gitPid = 0; let runner: ConnectorRunner | undefined;
  f.ownership.disposers.add(async () => { if (parent.exitCode === null) parent.kill('SIGKILL'); await closed; });
  try {
    try {
      const readyDeadline = Date.now() + 5000;
      gitPid = (await readyFile(f.ready, f.ownership)).pid;
      let identity: CodexProcessIdentity | undefined;
      while (Date.now() < readyDeadline) {
        assertActive(f.ownership);
        try { identity = JSON.parse(await readFile(identityReady, 'utf8')) as CodexProcessIdentity; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(identity).toMatchObject({ pid: gitPid, processGroupId: gitPid, startedAt: expect.any(String), command: expect.stringContaining('commit') });
      const journalLine = (await readFile(f.pidFile, 'utf8')).trim().split('\n').filter(line => line.startsWith(`+${gitPid} `)).at(-1);
      expect(journalLine).toBe(`+${gitPid} ${JSON.stringify(identity)}`);
      expect(await readProcessIdentity(gitPid)).toEqual(identity);
      assertActive(f.ownership);
      f.ownership.groups.add(gitPid); f.ownership.identities.set(gitPid, identity!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nestedCause = error instanceof Error ? error.cause : undefined;
      const nestedMessage = nestedCause instanceof Error ? nestedCause.message : nestedCause === undefined ? '' : String(nestedCause);
      throw new Error(`Checkpoint parent fixture failed: ${message}${nestedMessage ? `; cause: ${nestedMessage}` : ''}; child output: ${output}`, { cause: error });
    }
    parent.kill('SIGKILL'); await closed; expect(process.kill(-gitPid, 0)).toBe(true);
    const persisted = JSON.parse(await readFile(spoolPath, 'utf8')); expect(Object.values(persisted.gitProcesses)).toEqual([null]);
    const native = { start: async () => ['gpt-6-luna'], stop: async () => {} } as unknown as CodexAppServer; const acknowledge = vi.fn(); const complete = vi.fn();
    const client = { claim: async () => { await runner!.stop(); return undefined; }, readRun: async () => ({ generation: 1, status: 'cancelled' }), stopped: acknowledge, complete } as unknown as WorkbenchConnectorClient;
    runner = ownRunner(new ConnectorRunner(f.config, { native: () => native, client:()=>withRecoveryState(client)})); await own(runner.run());
    expect(process.kill(-gitPid, 0)).toBe(true); expect(acknowledge).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(spoolPath, 'utf8'))).toEqual(persisted);
  } finally { parent.kill('SIGKILL'); await closed; await runner?.stop(); }
});
