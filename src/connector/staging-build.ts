import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';

const execFile = promisify(execFileCb);
const REPOSITORY = 'blossomsai/menoteam';
const WORKFLOW_FILE = 'build-workbench-image.yml';
const WORKFLOW_PATH = '.github/workflows/build-workbench-image.yml';
const ARTIFACT = 'workbench-image-receipt';
const artifactName = (attempt: number) => `${ARTIFACT}-attempt-${attempt}`;
const IMAGE = 'ghcr.io/blossomsai/menoteam-work-map';
const RECEIPT_FILE = 'workbench-image-receipt.json';
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_ARCHIVE = 64 * 1024;
const MAX_RECEIPT = 4096;

export type StagingBuildStatus = 'unavailable' | 'running' | 'failed' | 'receipt_missing' | 'receipt_expired' | 'provenance_failed';
export type StagingBuildReceipt = {
  schemaVersion: 1;
  repository: typeof REPOSITORY;
  repositoryId: string;
  workflowPath: typeof WORKFLOW_PATH;
  runId: number;
  runAttempt: number;
  artifactId: number;
  archiveDigest: string;
  artifactExpiresAt: string;
  sourceSha: string;
  imageRepository: typeof IMAGE;
  imageDigest: string;
  runUrl: string;
};

export class StagingBuildDiscoveryError extends Error {
  constructor(public readonly status: StagingBuildStatus, message: string) { super(message); }
}

const receiptSchema = z.object({
  schemaVersion: z.literal(1), repository: z.literal(REPOSITORY), repositoryId: z.string().regex(/^\d+$/u),
  workflowPath: z.literal(WORKFLOW_PATH), runId: z.number().int().positive(), runAttempt: z.number().int().positive(),
  sourceSha: z.string().regex(SHA), imageRepository: z.literal(IMAGE), imageDigest: z.string().regex(DIGEST),
}).strict();

const runSchema = z.object({
  id: z.number().int().positive(), run_attempt: z.number().int().positive(), run_number: z.number().int().positive(),
  status: z.string(), conclusion: z.string().nullable(), event: z.string(), head_branch: z.string(), head_sha: z.string(),
  path: z.string(), html_url: z.string().url(),
  repository: z.object({ id: z.number().int().positive(), full_name: z.string() }).passthrough(),
  head_repository: z.object({ id: z.number().int().positive(), full_name: z.string() }).nullable(),
}).passthrough();

const artifactSchema = z.object({
  id: z.number().int().positive(), name: z.string(), size_in_bytes: z.number().int().positive(),
  expired: z.boolean(), expires_at: z.string().datetime(), digest: z.string().regex(DIGEST),
  workflow_run: z.object({id:z.number().int().positive(),repository_id:z.number().int().positive(),head_repository_id:z.number().int().positive(),head_sha:z.string().regex(SHA)}).passthrough(),
}).passthrough();

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];let total = 0;
  if (!response.body) throw new Error('Artifact response body is unavailable');
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_ARCHIVE) throw new Error('Staging build receipt archive exceeds its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function requestSignal(signal?:AbortSignal):AbortSignal{return signal?AbortSignal.any([signal,AbortSignal.timeout(20_000)]):AbortSignal.timeout(20_000);}

async function json<T>(fetcher: typeof fetch, url: string, token: string, schema: z.ZodType<T>, signal?:AbortSignal): Promise<T> {
  let response:Response;
  try { response = await fetcher(url, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' }, redirect: 'error', signal:requestSignal(signal) }); }
  catch { throw new StagingBuildDiscoveryError('unavailable', 'GitHub build lookup could not be reached'); }
  if (!response.ok) throw new StagingBuildDiscoveryError('unavailable', `GitHub build lookup failed (${response.status})`);
  try { return schema.parse(await response.json()); }
  catch { throw new StagingBuildDiscoveryError('receipt_missing', 'GitHub build metadata was malformed'); }
}

async function artifactBytes(fetcher:typeof fetch,url:string,token:string,signal?:AbortSignal):Promise<Uint8Array>{
  let response:Response;
  try { response=await fetcher(url,{headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28'},redirect:'follow',signal:requestSignal(signal)}); }
  catch { throw new StagingBuildDiscoveryError('unavailable','GitHub artifact download could not be reached'); }
  if(!response.ok)throw new StagingBuildDiscoveryError('receipt_missing','The staging build receipt could not be downloaded');
  try{return await boundedBytes(response);}catch{throw new StagingBuildDiscoveryError('receipt_missing','The staging build receipt archive exceeds its size limit');}
}

async function receiptBytes(archive: Uint8Array, signal?:AbortSignal): Promise<Buffer> {
  const directory = await mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/menoteam-build-receipt-`);
  try {
    const archivePath = `${directory}/receipt.zip`;
    await writeFile(archivePath, archive, { mode: 0o600, flag: 'wx' });
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' };
    const listing = await execFile('unzip', ['-Z1', archivePath], { encoding: 'utf8', maxBuffer: 4096, timeout: 10_000, ...(signal?{signal}:{}), env });
    if (listing.stdout.trim() !== RECEIPT_FILE) throw new Error('Build artifact must contain only the fixed receipt file');
    // Stream only a regular file; never materialize archive paths or symlinks.
    const attributes = await execFile('unzip', ['-Z', '-l', archivePath], { encoding: 'utf8', maxBuffer: 4096, timeout: 10_000, ...(signal?{signal}:{}), env });
    if (!attributes.stdout.split('\n').some(line => /^-[rwxstST-]{9}\s/u.test(line) && line.endsWith(` ${RECEIPT_FILE}`))) throw new Error('Build receipt must be a regular file');
    const output = await execFile('unzip', ['-p', archivePath, RECEIPT_FILE], { encoding: 'buffer', maxBuffer: MAX_RECEIPT, timeout: 10_000, ...(signal?{signal}:{}), env });
    if (!output.stdout.length || output.stdout.length > MAX_RECEIPT) throw new Error('Build receipt size is invalid');
    return output.stdout;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Resolve one immutable receipt for the newest matching run. Never falls back to an older build. */
export async function discoverStagingBuild(commitSha: string, fetcher: typeof fetch = fetch, token = process.env.MENOTEAM_GITHUB_TOKEN, signal?:AbortSignal): Promise<StagingBuildReceipt> {
  if (!SHA.test(commitSha) || !token) throw new StagingBuildDiscoveryError('unavailable', 'Staging build lookup is unavailable');
  try {
    const base = `https://api.github.com/repos/${REPOSITORY}`;
    const query = new URLSearchParams({ head_sha: commitSha, branch: 'main', event: 'workflow_dispatch', per_page: '100' });
    const listed = await json(fetcher, `${base}/actions/workflows/${WORKFLOW_FILE}/runs?${query}`, token, z.object({ workflow_runs: z.array(runSchema) }).passthrough(),signal);
    const candidates = listed.workflow_runs.filter(run => run.path === WORKFLOW_PATH && run.head_sha === commitSha && run.head_branch === 'main' && run.event === 'workflow_dispatch' && run.repository.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY && run.head_repository.id === run.repository.id);
    const latest = candidates.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
    if (!latest) throw new StagingBuildDiscoveryError('unavailable', 'No fixed staging image build exists for this merged commit');
    if (latest.status !== 'completed') throw new StagingBuildDiscoveryError('running', 'The newest staging image build is still running');
    if (latest.conclusion !== 'success') throw new StagingBuildDiscoveryError('failed', 'The newest staging image build did not succeed');
    const artifacts = await json(fetcher, `${base}/actions/runs/${latest.id}/artifacts?per_page=100`, token, z.object({ artifacts: z.array(artifactSchema) }).passthrough(),signal);
    const named = artifacts.artifacts.filter(item => item.name === artifactName(latest.run_attempt));
    if (named.length !== 1) throw new StagingBuildDiscoveryError('receipt_missing', 'The successful build does not have exactly one fixed receipt artifact');
    const artifact = named[0]!;
    if (artifact.workflow_run.id !== latest.id || artifact.workflow_run.repository_id !== latest.repository.id || artifact.workflow_run.head_repository_id !== latest.head_repository?.id || artifact.workflow_run.head_sha !== commitSha) throw new StagingBuildDiscoveryError('receipt_missing', 'The receipt artifact belongs to a different workflow run or repository');
    if (artifact.expired || Date.parse(artifact.expires_at) <= Date.now()) throw new StagingBuildDiscoveryError('receipt_expired', 'The staging build receipt has expired');
    if (artifact.size_in_bytes > MAX_ARCHIVE) throw new StagingBuildDiscoveryError('receipt_missing', 'The staging build receipt archive exceeds its size limit');
    const archive = await artifactBytes(fetcher,`${base}/actions/artifacts/${artifact.id}/zip`,token,signal);
    if (!archive.length || archive.length > MAX_ARCHIVE || createHash('sha256').update(archive).digest('hex') !== artifact.digest.slice(7)) throw new StagingBuildDiscoveryError('receipt_missing', 'The staging build receipt archive failed its size or digest check');
    const raw = await receiptBytes(archive,signal);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new StagingBuildDiscoveryError('receipt_missing', 'The staging build receipt is malformed'); }
    const receipt = receiptSchema.parse(parsed);
    if (receipt.repositoryId !== String(latest.repository.id) || receipt.runId !== latest.id || receipt.runAttempt !== latest.run_attempt || receipt.workflowPath !== latest.path || receipt.sourceSha !== commitSha) throw new StagingBuildDiscoveryError('receipt_missing', 'The staging build receipt does not match its workflow run');
    return { ...receipt, artifactId: artifact.id, archiveDigest: artifact.digest, artifactExpiresAt: artifact.expires_at, runUrl: latest.html_url };
  } catch (error) {
    if (error instanceof StagingBuildDiscoveryError) throw error;
    throw new StagingBuildDiscoveryError('receipt_missing', 'The staging build receipt could not be verified');
  }
}

/** Re-read the frozen artifact by ID on retry; never follow the current/latest build. */
export async function verifyFrozenStagingBuild(receipt: StagingBuildReceipt, fetcher: typeof fetch = fetch, token = process.env.MENOTEAM_GITHUB_TOKEN, signal?:AbortSignal): Promise<void> {
  if (!token || Date.parse(receipt.artifactExpiresAt) <= Date.now()) throw new StagingBuildDiscoveryError('receipt_expired', 'The frozen staging build receipt has expired');
  const base = `https://api.github.com/repos/${REPOSITORY}`;
  const run = await json(fetcher, `${base}/actions/runs/${receipt.runId}/attempts/${receipt.runAttempt}`, token, runSchema, signal);
  if (run.id !== receipt.runId || run.run_attempt !== receipt.runAttempt || run.path !== WORKFLOW_PATH || run.head_sha !== receipt.sourceSha || run.head_branch !== 'main' || run.event !== 'workflow_dispatch' || run.repository.full_name !== REPOSITORY || run.repository.id !== Number(receipt.repositoryId) || run.head_repository?.full_name !== REPOSITORY || run.head_repository.id !== run.repository.id || run.status !== 'completed' || run.conclusion !== 'success' || run.html_url !== receipt.runUrl) throw new StagingBuildDiscoveryError('receipt_missing', 'The frozen build attempt identity or outcome changed');
  const artifacts = await json(fetcher, `${base}/actions/runs/${receipt.runId}/artifacts?per_page=100`, token, z.object({ artifacts: z.array(artifactSchema) }).passthrough(),signal);
  const artifact = artifacts.artifacts.find(item => item.id === receipt.artifactId && item.name === artifactName(receipt.runAttempt));
  if (!artifact || artifact.expired || artifact.digest !== receipt.archiveDigest || artifact.expires_at !== receipt.artifactExpiresAt || Date.parse(artifact.expires_at) <= Date.now()) throw new StagingBuildDiscoveryError('receipt_expired', 'The frozen staging build receipt is unavailable or changed');
  if (artifact.workflow_run.id !== receipt.runId || artifact.workflow_run.repository_id !== Number(receipt.repositoryId) || artifact.workflow_run.head_repository_id !== Number(receipt.repositoryId) || artifact.workflow_run.head_sha !== receipt.sourceSha) throw new StagingBuildDiscoveryError('receipt_missing', 'The frozen receipt artifact belongs to a different workflow run or repository');
  if (artifact.size_in_bytes > MAX_ARCHIVE) throw new StagingBuildDiscoveryError('receipt_missing', 'The frozen staging receipt archive exceeds its size limit');
  const archive = await artifactBytes(fetcher,`${base}/actions/artifacts/${artifact.id}/zip`,token,signal);
  if (!archive.length || archive.length > MAX_ARCHIVE || createHash('sha256').update(archive).digest('hex') !== receipt.archiveDigest.slice(7)) throw new StagingBuildDiscoveryError('receipt_missing', 'The frozen staging build receipt archive failed its size or digest check');
  let actual:z.infer<typeof receiptSchema>;
  try { actual=receiptSchema.parse(JSON.parse((await receiptBytes(archive,signal)).toString('utf8'))); }
  catch { throw new StagingBuildDiscoveryError('receipt_missing','The frozen staging receipt content is malformed'); }
  if (!isDeepStrictEqual(actual, { schemaVersion: 1, repository: REPOSITORY, repositoryId: receipt.repositoryId, workflowPath: WORKFLOW_PATH, runId: receipt.runId, runAttempt: receipt.runAttempt, sourceSha: receipt.sourceSha, imageRepository: IMAGE, imageDigest: receipt.imageDigest })) throw new StagingBuildDiscoveryError('receipt_missing', 'The frozen staging receipt content changed');
}
