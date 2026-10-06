import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStagingOperation, stopStagingProcess, validateStagingRequest, verifyStagingImage, type StagingReceipt, type StagingRequest } from '../src/connector/staging-deploy.js';
import { readProcessIdentity, waitProcessGroup } from '../src/connector/codex.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { StagingDeploymentTarget } from '../src/connector/types.js';
import { sshTransport, type StagingSshRuntime } from '../src/connector/staging-deploy.js';

const execFile = promisify(execFileCallback);
const commitSha = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const request: StagingRequest = { action: 'deploy', operationId: `run_${'1'.repeat(8)}-${'2'.repeat(4)}-${'3'.repeat(4)}-${'4'.repeat(4)}-${'5'.repeat(12)}`, targetId: 'staging', commitSha, imageDigest, expectedCurrentDeploymentId: null };
let directory = '';
let target: StagingDeploymentTarget;

class FakeSshChild extends EventEmitter {
  pid = 24680;
  stdin = new PassThrough();
  stdout = new PassThrough();
  dispose(): void { this.stdin.destroy(); this.stdout.destroy(); }
}

function fakeSshRuntime(child: FakeSshChild, options: { timeoutMs?: number; stop?: () => Promise<boolean>; readIdentity?: () => ReturnType<typeof readProcessIdentity> } = {}): StagingSshRuntime {
  return {
    spawn: (() => { queueMicrotask(() => child.emit('spawn')); return child; }) as unknown as typeof spawn,
    readProcessIdentity: options.readIdentity ?? (async () => ({ pid: child.pid!, processGroupId: child.pid!, startedAt: 'test-start', command: 'ssh -T staging' })),
    stopStagingProcess: options.stop ?? (async () => true),
    waitProcessGroup: async () => true,
    timeoutMs: options.timeoutMs,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'menoteam-staging-adapter-'));
  const identityFile = path.join(directory, 'id_ed25519');
  await execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', identityFile]);
  const publicKey = (await readFile(`${identityFile}.pub`, 'utf8')).trim();
  const knownHostsFile = path.join(directory, 'known_hosts');
  await writeFile(knownHostsFile, `stage.example ${publicKey}\n`, { mode: 0o600 });
  const { stdout } = await execFile('ssh-keygen', ['-lf', knownHostsFile]);
  const fingerprint = stdout.trim().split(/\s+/u)[1];
  target = { sshHost: 'stage.example', sshUser: 'deploy', identityFile, knownHostsFile, hostKeyFingerprint: fingerprint, imageRepository: 'ghcr.io/blossomsai/menoteam-work-map' };
});

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('fixed staging deployment adapter', () => {
  it('rejects mutable images, caller-supplied commands and rollback without a prior receipt', () => {
    expect(() => validateStagingRequest({ ...request, imageDigest: 'latest' } as StagingRequest)).toThrow();
    expect(() => validateStagingRequest({ ...request, command: 'sh' } as StagingRequest & { command: string })).toThrow();
    expect(() => validateStagingRequest({ ...request, action: 'rollback' })).toThrow(/previously verified/u);
  });

  it('asks GitHub to prove the fixed workflow, repository, main ref, source SHA and exact OCI digest', async () => {
    let received: string[] = [];
    const output = JSON.stringify([{ verificationResult: { statement: { subject: [{ name: target.imageRepository, digest: { sha256: imageDigest.slice(7) } }] } } }]);
    await verifyStagingImage(target, commitSha, imageDigest, async args => { received = args; return output; });
    expect(received).toContain('--deny-self-hosted-runners');
    expect(received).toContain('--source-ref');
    expect(received).toContain('refs/heads/main');
    expect(received).toContain(commitSha);
    expect(received).toContain('blossomsai/menoteam/.github/workflows/build-workbench-image.yml');
  });

  it('fails closed when an attested subject digest differs from the requested image', async () => {
    const output = JSON.stringify([{ verificationResult: { statement: { subject: [{ name: target.imageRepository, digest: { sha256: 'c'.repeat(64) } }] } } }]);
    await expect(verifyStagingImage(target, commitSha, imageDigest, async () => output)).rejects.toThrow(/does not match/u);
  });

  it('only sends the typed request to the fixed helper transport and rejects mismatched receipts', async () => {
    let sent: StagingRequest | undefined;
    const transport = async (_target: StagingDeploymentTarget, input: StagingRequest): Promise<StagingReceipt> => {
      sent = input;
      return { operationId: input.operationId, targetId: input.targetId, phase: 'health_passed', deploymentId: 'deploy_123', commitSha: input.commitSha, imageDigest: input.imageDigest, checkedAt: new Date().toISOString() };
    };
    const provenance = async () => JSON.stringify([{ verificationResult: { statement: { subject: [{ name: target.imageRepository, digest: { sha256: imageDigest.slice(7) } }] } } }]);
    const result = await runStagingOperation('staging', target, request, undefined, transport, provenance);
    expect(sent).toEqual(request);
    expect(result.phase).toBe('health_passed');
    await expect(runStagingOperation('wrong-target', target, request, undefined, transport, provenance)).rejects.toThrow(/binding changed/u);
    const wrongReceipt = async (_target: StagingDeploymentTarget, input: StagingRequest): Promise<StagingReceipt> => ({ operationId: input.operationId, targetId: input.targetId, phase: 'health_passed', commitSha: 'c'.repeat(40), imageDigest: input.imageDigest, checkedAt: new Date().toISOString() });
    await expect(runStagingOperation('staging', target, request, undefined, wrongReceipt, provenance)).rejects.toThrow(/does not match/u);
    const statusRequest = { ...request, action: 'status' as const };
    for (const phase of ['rolled_back', 'target_offline'] as const) {
      const statusTransport = async (_target: StagingDeploymentTarget, input: StagingRequest): Promise<StagingReceipt> => ({ operationId: input.operationId, targetId: input.targetId, phase, commitSha: input.commitSha, imageDigest: input.imageDigest, checkedAt: new Date().toISOString() });
      await expect(runStagingOperation('staging', target, statusRequest, undefined, statusTransport)).resolves.toMatchObject({ phase });
    }
  });

  it('rejects group-readable SSH private keys before transport', async () => {
    await chmod(target.identityFile, 0o644);
    let invoked = false;
    const transport = async (): Promise<StagingReceipt> => { invoked = true; throw new Error('must not run'); };
    const provenance = async () => JSON.stringify([{ verificationResult: { statement: { subject: [{ name: target.imageRepository, digest: { sha256: imageDigest.slice(7) } }] } } }]);
    await expect(runStagingOperation('staging', target, request, undefined, transport, provenance)).rejects.toThrow(/owner-only/u);
    expect(invoked).toBe(false);
    await chmod(target.identityFile, 0o600);
  });

  it('binds the pinned fingerprint to the configured host entry', async () => {
    const other = path.join(directory, 'other_ed25519');
    await execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
    const otherPublicKey = (await readFile(`${other}.pub`, 'utf8')).trim();
    const configuredPublicKey = (await readFile(`${target.identityFile}.pub`, 'utf8')).trim();
    const mixedKnownHosts = path.join(directory, 'mixed_known_hosts');
    await writeFile(mixedKnownHosts, `stage.example ${configuredPublicKey}\nother.example ${otherPublicKey}\n`, { mode: 0o600 });
    const { stdout } = await execFile('ssh-keygen', ['-lf', other]);
    const wrongFingerprint = stdout.trim().split(/\s+/u)[1];
    let invoked = false;
    const transport = async (): Promise<StagingReceipt> => { invoked = true; throw new Error('must not run'); };
    const provenance = async () => JSON.stringify([{ verificationResult: { statement: { subject: [{ name: target.imageRepository, digest: { sha256: imageDigest.slice(7) } }] } } }]);
    await expect(runStagingOperation('staging', { ...target, knownHostsFile: mixedKnownHosts, hostKeyFingerprint: wrongFingerprint }, request, undefined, transport, provenance)).rejects.toThrow(/host fingerprint/u);
    expect(invoked).toBe(false);
  });

  it('terminates only an identity-verified SSH process group and confirms it is gone', async context => {
    const executable = path.join(directory, 'ssh-staging-fake');
    await writeFile(executable, '#!/bin/sh\nsleep 60 &\nwait\n', { mode: 0o700 });
    await chmod(executable, 0o700);
    const child = spawn(executable, [], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const identity = await readProcessIdentity(child.pid!);
    if (!identity) {
      child.kill('SIGKILL');
      await new Promise<void>(resolve => child.once('close', () => resolve()));
      context.skip();
      return;
    }
    expect(identity?.processGroupId).toBe(child.pid);
    expect(await stopStagingProcess(identity!)).toBe(true);
    expect(await waitProcessGroup(identity!.processGroupId, 100)).toBe(true);
  });

  it('turns timeout stop failures into a bounded unknown rejection without an unhandled rejection', async () => {
    const child = new FakeSshChild();
    let stopCalls = 0;
    try {
      const transport = sshTransport(target, { ...request, action: 'status' }, undefined, fakeSshRuntime(child, { timeoutMs: 5, stop: async () => { stopCalls++; throw new Error('stop denied'); } }));
      await expect(transport).rejects.toThrow(/stop is unconfirmed.*unknown/u);
      expect(stopCalls).toBe(1);
    } finally { child.dispose(); }
  });

  it('starts the deadline before process identity inspection and stops a child that becomes identifiable late', async () => {
    const child = new FakeSshChild();
    let releaseIdentity!: () => void;
    const identityGate = new Promise<void>(resolve => { releaseIdentity = resolve; });
    let stopCalls = 0;
    try {
      const transport = sshTransport(target, { ...request, action: 'status' }, undefined, fakeSshRuntime(child, {
        timeoutMs: 5,
        readIdentity: async () => { await identityGate; return { pid: child.pid!, processGroupId: child.pid!, startedAt: 'test-start', command: 'ssh -T staging' }; },
        stop: async () => { stopCalls++; return true; },
      }));
      await expect(transport).rejects.toThrow(/stop is unconfirmed.*unknown/u);
      releaseIdentity();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(stopCalls).toBe(1);
      expect(child.stdin.writableEnded).toBe(false);
    } finally { child.dispose(); }
  });

  it('does not send a request after the SSH child closes while durable start tracking is pending', async () => {
    const child = new FakeSshChild();
    let releaseStarted!: () => void;
    let markStarted!: () => void;
    const startedEntered = new Promise<void>(resolve => { markStarted = resolve; });
    const startGate = new Promise<void>(resolve => { releaseStarted = resolve; });
    let stopped = 0;
    const tracking = { started: async () => { markStarted(); await startGate; }, stopped: async () => { stopped++; } };
    try {
      const transport = sshTransport(target, { ...request, action: 'status' }, tracking, fakeSshRuntime(child));
      await startedEntered;
      child.emit('close', 1, null);
      releaseStarted();
      await expect(transport).rejects.toThrow(/before the request was sent|executor failed/u);
      expect(child.stdin.writableEnded).toBe(false);
      expect(stopped).toBe(1);
    } finally { child.dispose(); }
  });

  it('handles helper-output overflow without leaking a rejected stop task', async () => {
    const child = new FakeSshChild();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    try {
      const transport = sshTransport(target, { ...request, action: 'status' }, { started: async () => { markStarted(); }, stopped: async () => {} }, fakeSshRuntime(child));
      await started;
      child.stdout.write('x'.repeat(16_385));
      await expect(transport).rejects.toThrow(/receipt exceeded.*unknown/u);
    } finally { child.dispose(); }
  });
});
