import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { CodexAppServer, readCodexProcessIdentity, readGitProcessIdentity, terminateProcessGroup, terminateVerifiedGitProcessGroup, terminateVerifiedProcessGroup, waitProcessGroup } from '../src/connector/codex.js';

it.skipIf(process.platform === 'win32')('stops descendants even after the process-group leader exits', async () => {
  const child = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'}); setTimeout(()=>process.exit(0),100)"], { detached: true, stdio: ['ignore','ignore','ignore'] });
  const pid = child.pid;
  if (!pid) throw new Error('No process-group leader PID');
  await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
  expect(await waitProcessGroup(pid, 100)).toBe(false);
  expect(await terminateProcessGroup(pid, 300)).toBe(true);
  expect(await waitProcessGroup(pid, 100)).toBe(true);
});

it.skipIf(process.platform === 'win32')('requires a matching process start identity before restart cleanup', async context => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)', 'codex', 'app-server'], { detached: true, stdio: ['ignore','ignore','ignore'] });
  const pid = child.pid;
  if (!pid) throw new Error('No process-group leader PID');
  const identity = await readCodexProcessIdentity(pid);
  if (!identity) { child.kill('SIGKILL'); context.skip(); return; }
  expect(await terminateVerifiedProcessGroup({ ...identity, startedAt: `${identity.startedAt}:stale` }, 100)).toBe(false);
  expect(await waitProcessGroup(pid, 100)).toBe(false);
  expect(await terminateVerifiedProcessGroup(identity, 300)).toBe(true);
  expect(await waitProcessGroup(pid, 100)).toBe(true);
});

it.skipIf(process.platform === 'win32')('tracks and stops a bounded Git transport process group after restart', async context => {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)','git','push'],{detached:true,stdio:['ignore','ignore','ignore']});
  const pid=child.pid;if(!pid)throw new Error('No Git process-group leader PID');
  const identity=await readGitProcessIdentity(pid);if(!identity){child.kill('SIGKILL');context.skip();return;}
  expect(identity.processGroupId).toBe(pid);
  expect(await terminateVerifiedGitProcessGroup({...identity,startedAt:`${identity.startedAt}:stale`},100)).toBe(false);
  expect(await waitProcessGroup(pid,100)).toBe(false);
  expect(await terminateVerifiedGitProcessGroup(identity,300)).toBe(true);
  expect(await waitProcessGroup(pid,100)).toBe(true);
});

it('settles cleanup when the Codex binary cannot be spawned', async () => {
  const appServer = new CodexAppServer('/missing/codex-binary-for-test');
  await expect(appServer.start(process.cwd())).rejects.toThrow();
  await expect(appServer.stop()).resolves.toBeUndefined();
});
