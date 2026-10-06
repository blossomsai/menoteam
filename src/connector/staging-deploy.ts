import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { StagingDeploymentTarget } from './types.js';
import { readProcessIdentity, terminateProcessGroup, waitProcessGroup, type CodexProcessIdentity } from './codex.js';

const execFile = promisify(execFileCb);
const HELPER = '/usr/local/libexec/menoteam-staging-delivery';
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const requestSchema = z.object({
  action: z.enum(['deploy', 'verify', 'rollback', 'status']),
  operationId: z.string().regex(/^run_[a-f0-9-]{36}$/u),
  targetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  commitSha: z.string().regex(SHA),
  imageDigest: z.string().regex(DIGEST),
  expectedCurrentDeploymentId: z.union([z.string().regex(/^deploy_[A-Za-z0-9_-]{1,100}$/u), z.null()]),
  previousDeploymentId: z.string().regex(/^deploy_[A-Za-z0-9_-]{1,100}$/u).optional(),
}).strict();

export type StagingRequest = z.infer<typeof requestSchema>;
export type StagingReceipt = {
  operationId: string;
  targetId: string;
  phase: 'deployed' | 'health_passed' | 'rolled_back' | 'target_offline' | 'unknown';
  deploymentId?: string;
  commitSha: string;
  imageDigest: string;
  activeCommitSha?: string;
  activeImageDigest?: string;
  previousDeploymentId?: string;
  previousImageDigest?: string;
  checkedAt: string;
};
export type StagingTracking = {
  starting?: () => Promise<void>;
  started: (identity: CodexProcessIdentity) => Promise<void>;
  stopped: () => Promise<void>;
};
export type StagingEffect = 'provenance' | 'transport';
export type StagingAuthorization = (effect: StagingEffect) => Promise<void>;
export type StagingTransport = (target: StagingDeploymentTarget, request: StagingRequest, tracking?: StagingTracking) => Promise<StagingReceipt>;

const receiptSchema = z.object({
  operationId: z.string(), targetId: z.string(),
  phase: z.enum(['deployed', 'health_passed', 'rolled_back', 'target_offline', 'unknown']),
  deploymentId: z.string().regex(/^deploy_[A-Za-z0-9_-]{1,100}$/u).optional(),
  commitSha: z.string().regex(SHA), imageDigest: z.string().regex(DIGEST),
  activeCommitSha: z.string().regex(SHA).optional(), activeImageDigest: z.string().regex(DIGEST).optional(),
  previousDeploymentId: z.string().regex(/^deploy_[A-Za-z0-9_-]{1,100}$/u).optional(),
  previousImageDigest: z.string().regex(DIGEST).optional(), checkedAt: z.string().datetime(),
}).strict();

export function validateStagingRequest(input: StagingRequest): StagingRequest {
  const request = requestSchema.parse(input);
  if (request.action === 'rollback' && !request.previousDeploymentId) throw new Error('Rollback requires a previously verified deployment receipt');
  if (request.action !== 'rollback' && request.previousDeploymentId) throw new Error('Previous deployment is accepted only for rollback');
  return request;
}

/** Verify the exact GHCR digest against the repository's fixed image workflow before any SSH effect. */
export async function verifyStagingImage(target: StagingDeploymentTarget, commitSha: string, imageDigest: string, verifier: (args: string[]) => Promise<string> = verifyWithGh): Promise<void> {
  if (!SHA.test(commitSha) || !DIGEST.test(imageDigest)) throw new Error('Staging image provenance is invalid');
  const args = ['attestation', 'verify', `oci://${target.imageRepository}@${imageDigest}`, '--repo', 'blossomsai/menoteam', '--signer-workflow', 'blossomsai/menoteam/.github/workflows/build-workbench-image.yml', '--source-digest', commitSha, '--source-ref', 'refs/heads/main', '--deny-self-hosted-runners', '--format', 'json'];
  const output = await verifier(args);
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error('Image attestation response was not valid JSON'); }
  const results = z.array(z.object({ verificationResult: z.object({ statement: z.object({ subject: z.array(z.object({ name: z.string(), digest: z.record(z.string(), z.string()) }).passthrough()).min(1) }).passthrough() }).passthrough() }).passthrough()).min(1).parse(parsed);
  const expectedDigest = imageDigest.slice('sha256:'.length);
  if (!results.some(result => result.verificationResult.statement.subject.some(subject => subject.name === target.imageRepository && subject.digest.sha256 === expectedDigest))) throw new Error('Attested image digest does not match the requested image');
}

async function verifyWithGh(args: string[]): Promise<string> {
  const token = process.env.MENOTEAM_GITHUB_TOKEN;
  if (!token) throw new Error('Staging image provenance verifier is unavailable');
  const { stdout } = await execFile('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 30_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', GH_TOKEN: token } });
  return stdout;
}

async function validateTarget(target: StagingDeploymentTarget): Promise<void> {
  const identity = await lstat(target.identityFile);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.uid !== process.getuid?.() || (identity.mode & 0o077) !== 0) throw new Error('Staging SSH identity must be a regular owner-only file');
  const known = await lstat(target.knownHostsFile);
  if (!known.isFile() || known.isSymbolicLink() || known.uid !== process.getuid?.() || (known.mode & 0o022) !== 0) throw new Error('Pinned SSH known-hosts file must be regular, owner-controlled and not group/world writable');
  const match = await execFile('ssh-keygen', ['-F', target.sshHost, '-f', target.knownHostsFile], { encoding: 'utf8', maxBuffer: 16_384, timeout: 10_000 });
  const entries = match.stdout.split('\n').filter(line => line && !line.startsWith('#'));
  if (!entries.length) throw new Error('Pinned SSH host has no known-hosts entry');
  const directory = await mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/menoteam-hostkey-`);
  try {
    const hostFile = `${directory}/host_keys`;
    await writeFile(hostFile, `${entries.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    const { stdout } = await execFile('ssh-keygen', ['-lf', hostFile], { encoding: 'utf8', maxBuffer: 16_384, timeout: 10_000 });
    if (!stdout.split('\n').some(line => line.split(/\s+/u).includes(target.hostKeyFingerprint))) throw new Error('Pinned SSH host key does not match configured host fingerprint');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Fixed helper path and JSON stdin; no request field is interpreted as a command, path, or URL. */
export async function runStagingOperation(targetId: string, target: StagingDeploymentTarget, input: StagingRequest, tracking?: StagingTracking, transport: StagingTransport = sshTransport, provenanceVerifier?: (args: string[]) => Promise<string>, authorize?: StagingAuthorization, targetValidator: (target: StagingDeploymentTarget) => Promise<void> = validateTarget): Promise<StagingReceipt> {
  const request = validateStagingRequest(input);
  if (request.targetId !== targetId) throw new Error('Staging target binding changed');
  if (request.action === 'deploy' || request.action === 'rollback') {
    await authorize?.('provenance');
    await verifyStagingImage(target, request.commitSha, request.imageDigest, provenanceVerifier);
  }
  await targetValidator(target);
  await authorize?.('transport');
  const receipt = receiptSchema.parse(await transport(target, request, tracking));
  if (receipt.operationId !== request.operationId || receipt.targetId !== targetId || receipt.commitSha !== request.commitSha || receipt.imageDigest !== request.imageDigest) throw new Error('Staging helper receipt does not match the immutable operation');
  if (request.action === 'verify' && receipt.phase !== 'health_passed' && receipt.phase !== 'unknown' || request.action === 'rollback' && receipt.phase !== 'rolled_back' && receipt.phase !== 'unknown' && receipt.phase !== 'target_offline' || request.action === 'status' && !['health_passed', 'rolled_back', 'target_offline', 'unknown'].includes(receipt.phase)) throw new Error('Staging helper returned an invalid operation phase');
  return receipt;
}

export type StagingSshRuntime = {
  spawn: typeof spawn;
  readProcessIdentity: typeof readProcessIdentity;
  stopStagingProcess: typeof stopStagingProcess;
  waitProcessGroup: typeof waitProcessGroup;
  timeoutMs?: number;
};

export async function sshTransport(target: StagingDeploymentTarget, request: StagingRequest, tracking?: StagingTracking, runtime: StagingSshRuntime = { spawn, readProcessIdentity, stopStagingProcess, waitProcessGroup }): Promise<StagingReceipt> {
  await tracking?.starting?.();
  const args = ['-T', '-F', '/dev/null', '-i', target.identityFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${target.knownHostsFile}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '--', `${target.sshUser}@${target.sshHost}`, HELPER];
  return new Promise((resolve, reject) => {
    const child = runtime.spawn('ssh', args, { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' } });
    let stdout = '', settled = false, timedOut = false, trackingStarted = false, childClosed = false;
    let identity: CodexProcessIdentity | undefined;
    let timer: NodeJS.Timeout | undefined;
    let startTask: Promise<void> | undefined;
    let stopTask: Promise<boolean> | undefined;
    let stopConfirmed = false, stopAcknowledged = false;
    const acknowledgeStopped = async () => {
      if (!trackingStarted || stopAcknowledged || !tracking?.stopped) return;
      stopAcknowledged = true;
      await tracking.stopped();
    };
    const finish = async (error?: Error, value?: StagingReceipt, processStopped = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (processStopped) {
        stopConfirmed = true;
        if (startTask && !trackingStarted) void startTask.then(acknowledgeStopped).catch(() => {});
      }
      if (processStopped && trackingStarted) {
        try { await acknowledgeStopped(); }
        catch { reject(new Error('SSH process stopped but durable stop acknowledgement failed; operation remains unreconciled')); return; }
      }
      if (error) reject(error); else resolve(value!);
    };
    const stopAndFinish = async (reason: string) => {
      let stopped = false;
      try {
        if (identity) {
          stopTask ??= runtime.stopStagingProcess(identity).catch(() => false);
          stopped = await stopTask;
        }
      } catch { stopped = false; }
      if (!stopped) await finish(new Error('Staging SSH stop is unconfirmed; remote outcome remains unknown'));
      else await finish(new Error(reason), undefined, true);
    };
    const requestStop = (reason: string) => {
      if (!settled) void stopAndFinish(reason).catch(() => { void finish(new Error('Staging SSH outcome remains unknown')); });
    };
    child.once('spawn', () => {
      void (async () => {
        timer = setTimeout(() => { timedOut = true; requestStop('Staging SSH operation timed out; remote outcome remains unknown'); }, runtime.timeoutMs ?? 180_000);
        timer.unref();
        if (!child.pid) throw new Error('SSH process identity is unavailable');
        identity = await runtime.readProcessIdentity(child.pid);
        if (!identity || identity.processGroupId !== child.pid) throw new Error('SSH process identity could not be verified');
        if (settled || childClosed) { await stopAndFinish('Staging SSH process exited before the request was sent; remote outcome remains unknown'); return; }
        startTask = Promise.resolve(tracking?.started(identity)).then(() => { trackingStarted = true; });
        await startTask;
        if (settled || childClosed) { await stopAndFinish('Staging SSH process exited before the request was sent; remote outcome remains unknown'); return; }
        child.stdin.end(`${JSON.stringify(request)}\n`);
      })().catch(async error => {
        await stopAndFinish(error instanceof Error ? error.message : 'SSH process could not be prepared; remote outcome remains unknown');
      });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      stdout += String(chunk);
      if (stdout.length > 16_384) requestStop('Staging helper receipt exceeded its limit; remote outcome remains unknown');
    });
    child.stdin.on('error', () => requestStop('Staging SSH request pipe failed; remote outcome remains unknown'));
    child.once('error', () => { void finish(new Error('Staging SSH executor could not start')); });
    child.once('close', (code, signal) => {
      childClosed = true;
      void (async () => {
        if (startTask) { try { await startTask; } catch { /* spawn preparation path will settle the operation */ } }
        if (!identity) { await finish(new Error('Staging SSH process identity is unavailable; remote outcome remains unknown')); return; }
        let groupStopped = false;
        try { groupStopped = await runtime.waitProcessGroup(identity.processGroupId, 300); } catch { groupStopped = false; }
        if (!groupStopped) { await stopAndFinish('Staging SSH process group exited incompletely; remote outcome remains unknown'); return; }
        if (timedOut) { await finish(new Error('Staging SSH operation timed out; remote outcome is unknown'), undefined, true); return; }
        if (code !== 0) { await finish(new Error(`Staging SSH executor failed (${code ?? signal ?? 'unknown'})`), undefined, true); return; }
        try { await finish(undefined, receiptSchema.parse(JSON.parse(stdout.trim())), true); } catch { await finish(new Error('Staging helper returned an invalid receipt'), undefined, true); }
      })().catch(() => { void finish(new Error('Staging SSH outcome remains unknown')); });
    });
  });
}

export async function stopStagingProcess(identity: CodexProcessIdentity): Promise<boolean> {
  if (await waitProcessGroup(identity.processGroupId, 1)) return true;
  const current = await readProcessIdentity(identity.pid);
  if (!current || current.processGroupId !== identity.processGroupId || current.startedAt !== identity.startedAt || current.command !== identity.command || !/\bssh\b/u.test(current.command)) return false;
  return terminateProcessGroup(identity.processGroupId);
}
