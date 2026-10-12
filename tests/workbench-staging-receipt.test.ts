import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';
import type { Run } from '../src/workbench/types.js';

const runId = 'run_11111111-2222-3333-4444-555555555555';
const commitSha = 'a'.repeat(40), imageDigest = `sha256:${'b'.repeat(64)}`;
const oldSha = 'c'.repeat(40), oldDigest = `sha256:${'d'.repeat(64)}`;
const checkedAt = '2026-10-12T01:00:00.000Z';
const fallback = { operationId: runId, targetId: 'staging', phase: 'rolled_back' as const, deploymentId: 'deploy_old', commitSha, imageDigest, activeCommitSha: oldSha, activeImageDigest: oldDigest, previousDeploymentId: `deploy_${runId.slice(4)}`, previousImageDigest: imageDigest, checkedAt };

function deployment(id = runId): Run {
  return { id, projectId: 'project', workId: 'work', kind: 'delivery', prompt: '', model: 'internal', reasoning: 'none', status: 'running', generation: 1, connectorId: 'connector', requestedBy: 'owner', createdAt: checkedAt, updatedAt: checkedAt,
    operation: { action: 'deploy_staging', phase: 'deploy_intent', effectIntentGeneration: 1, targetId: 'staging', expectedCurrentDeploymentId: 'deploy_old', commitSha, imageDigest, actorId: 'owner', candidateRunId: 'candidate', candidateRevision: commitSha, artifactRevision: 'diff', candidateFingerprint: 'e'.repeat(64), repositoryUrl: 'https://github.com/blossomsai/menoteam', baseRevision: 'f'.repeat(40), baseBranch: 'main', remoteBranch: 'codex/fix', workTitle: '', changeSummary: '', qaStatus: 'current' } };
}

async function fixture(edit?: (run: Run, prior: Run) => void) {
  const run = deployment(), prior = deployment('run_previous');
  prior.status = 'completed'; prior.createdAt = '2026-10-11T01:00:00.000Z';
  Object.assign(prior.operation!, { phase: 'health_passed', commitSha: oldSha, imageDigest: oldDigest, stagingReceipt: { operationId: prior.id, targetId: 'staging', phase: 'health_passed', deploymentId: 'deploy_old', commitSha: oldSha, imageDigest: oldDigest, activeCommitSha: oldSha, activeImageDigest: oldDigest, checkedAt: prior.createdAt } });
  edit?.(run, prior);
  const records = new Map<string, { kind: string; data: unknown }>([[run.id, { kind: 'run', data: run }], [prior.id, { kind: 'run', data: prior }]]);
  let reserved = true;
  // Exercise the real HTTP, receipt gate and persistence calls; no PostgreSQL connection.
  const adapter = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('pg_advisory_xact_lock')) return [];
    if (query.includes('FROM wb_connectors')) return values[0] === digest('fixture-connector') ? [{ id: 'connector', project_ids: ['project'] }] : [];
    if (query.includes('FROM wb_records')) {
      if (query.includes('WHERE id=')) {
        const record = records.get(String(values[0]));
        return record?.kind === values[1] ? [{ data: structuredClone(record.data) }] : [];
      }
      return [...records.values()].filter(record => record.kind === values[0] && (values[1] === undefined || (record.data as Run).projectId === values[1])).map(record => ({ data: structuredClone(record.data) }));
    }
    if (query.includes('INSERT INTO wb_records')) { records.set(String(values[0]), { kind: String(values[1]), data: structuredClone(values[3]) }); return [{ id: values[0] }]; }
    if (query.includes('DELETE FROM wb_requests')) {
      expect(values).toEqual(['staging-target:project:staging', runId]);
      reserved = false; return [];
    }
    throw new Error(`Unexpected fixture query: ${query}`);
  }, { json: (value: unknown) => value, begin: async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => fn(adapter as unknown as Sql) });
  const app = await createWorkbenchApp({ sql: adapter as unknown as Sql });
  const send = (receipt: unknown, token = 'fixture-connector') => app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${runId}/staging-progress`, headers: { authorization: `Bearer ${token}` }, payload: { generation: 1, receipt } });
  return { app, send, records, reserved: () => reserved };
}

it('ACKs a proven automatic deploy fallback, releases its reservation, and repeats the terminal ACK after response loss', async () => {
  const f = await fixture();
  try {
    const first = await f.send(fallback);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().run.operation).toMatchObject({ phase: 'rolled_back', commitSha, imageDigest, stagingReceipt: fallback });
    expect(f.reserved()).toBe(false);
    const repeated = await f.send(fallback);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().artifact).toEqual(first.json().artifact);
    expect([...f.records.values()].filter(record => record.kind === 'artifact')).toHaveLength(1);
  } finally { await f.app.close(); }
});

it('reconciles a failed deploy from status using the prior active receipt, even when that prior deployment was itself a fallback', async () => {
  const f = await fixture((run, prior) => {
    run.status = 'cancelled'; run.operation!.phase = 'deploy_unknown';
    const previous = prior.operation!;
    previous.phase = 'rolled_back'; previous.commitSha = 'e'.repeat(40); previous.imageDigest = `sha256:${'f'.repeat(64)}`;
    Object.assign(previous.stagingReceipt!, { phase: 'rolled_back', commitSha: previous.commitSha, imageDigest: previous.imageDigest });
  });
  try {
    const response = await f.send(fallback);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().run.operation.stagingReceipt).toMatchObject({ phase: 'rolled_back', activeCommitSha: oldSha, activeImageDigest: oldDigest });
    expect(f.reserved()).toBe(false);
  } finally { await f.app.close(); }
});

it.each([
  { deploymentId: 'deploy_wrong' }, { previousDeploymentId: 'deploy_wrong' }, { previousImageDigest: oldDigest },
  { activeCommitSha: 'f'.repeat(40) }, { activeImageDigest: imageDigest },
  { operationId: 'run_other' }, { targetId: 'other' }, { commitSha: oldSha }, { imageDigest: oldDigest },
  { phase: 'health_passed' },
])('rejects unbound fallback receipt %j and retains reservation', async delta => {
  const f = await fixture();
  try { expect((await f.send({ ...fallback, ...delta })).statusCode).toBe(409); expect(f.reserved()).toBe(true); }
  finally { await f.app.close(); }
});

it.each(['project', 'target', 'deployment', 'future', 'unverified', 'operation', 'candidate'])('rejects fallback without the original proven %s identity', async field => {
  const f = await fixture((_run, prior) => {
    if (field === 'project') prior.projectId = 'other';
    if (field === 'target') prior.operation!.targetId = 'other';
    if (field === 'deployment') prior.operation!.stagingReceipt!.deploymentId = 'deploy_wrong';
    if (field === 'future') prior.createdAt = '2026-10-13T01:00:00.000Z';
    if (field === 'unverified') prior.operation!.phase = 'deploy_unknown';
    if (field === 'operation') prior.operation!.stagingReceipt!.operationId = 'run_other';
    if (field === 'candidate') prior.operation!.stagingReceipt!.commitSha = 'f'.repeat(40);
  });
  try { expect((await f.send(fallback)).statusCode).toBe(409); expect(f.reserved()).toBe(true); }
  finally { await f.app.close(); }
});

it('keeps explicit rollback bound to its saved previous and expected-current deployment identities', async () => {
  const f = await fixture(run => { Object.assign(run.operation!, { action: 'rollback_staging', previousDeploymentId: 'deploy_previous' }); });
  const receipt = { ...fallback, deploymentId: 'deploy_previous', activeCommitSha: commitSha, activeImageDigest: imageDigest, previousDeploymentId: 'deploy_old', previousImageDigest: oldDigest };
  try {
    expect((await f.send({ ...receipt, deploymentId: 'deploy_wrong' })).statusCode).toBe(409);
    expect((await f.send({ ...receipt, previousDeploymentId: 'deploy_wrong' })).statusCode).toBe(409);
    const response = await f.send(receipt);
    expect(response.statusCode, response.body).toBe(200); expect(f.reserved()).toBe(false);
  } finally { await f.app.close(); }
});

it('requires Connector authentication for fallback ACK', async () => {
  const f = await fixture();
  try { expect((await f.send(fallback, 'wrong-token')).statusCode).toBe(401); expect(f.reserved()).toBe(true); }
  finally { await f.app.close(); }
});
