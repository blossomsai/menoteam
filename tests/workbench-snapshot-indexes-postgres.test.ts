import postgres from 'postgres';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.WORK_MAP_TEST_DATABASE_URL;
const projectIds = ['target', 'target-2'];
const messageIndex = `CREATE INDEX wb_records_snapshot_run_evidence_idx
  ON wb_records (project_id, (data->>'runId'))
  WHERE kind='message' AND data->>'role' IN ('master','agent','subagent')`;
const baselineIndexes = [
  { name: 'wb_records_pkey', definition: 'PRIMARY KEY (id)' },
  { name: 'wb_records_scope', definition: '(kind, project_id)' },
  { name: 'wb_message_history', definition: "(project_id,(data->>'workId'),(data->>'createdAt'),id) WHERE kind='message'" },
  { name: 'wb_run_status', definition: "(project_id,(data->>'status')) WHERE kind='run'" }
];
const excludedIndexes = {
  wb_records_latest_work_diff_idx: {
    definition: "(project_id,(data->>'workId'),updated_at DESC,id DESC) WHERE kind='artifact' AND data->>'kind'='diff'",
    reason: 'predicate only covers diff artifacts; artifactMetadata includes other artifact kinds and has no workId equality'
  },
  wb_run_events: 'event rows are not read by either measured query',
  wb_provider_single_default: 'provider settings are not read by either measured query',
  wb_provider_connector_identity: 'provider settings are not read by either measured query',
  wb_slack_active_source_identity: 'Slack settings are not read by either measured query'
};

function explainMetrics(wrapper: Record<string, unknown>) {
  const plan = wrapper['Plan'] as Record<string, unknown>;
  const nodes: Array<{ node: unknown; index: unknown; actualRows: unknown; loops: unknown }> = [];
  const visit = (node: Record<string, unknown>) => {
    nodes.push({ node: node['Node Type'], index: node['Index Name'] ?? null, actualRows: node['Actual Rows'], loops: node['Actual Loops'] });
    for (const child of (node['Plans'] as Array<Record<string, unknown>> | undefined) ?? []) visit(child);
  };
  visit(plan);
  const buffers: Record<string, number> = {};
  for (const key of ['Local Hit Blocks', 'Local Read Blocks', 'Local Dirtied Blocks', 'Local Written Blocks', 'Shared Hit Blocks', 'Shared Read Blocks', 'Shared Dirtied Blocks', 'Shared Written Blocks', 'Temp Read Blocks', 'Temp Written Blocks'])
    if (typeof plan[key] === 'number') buffers[key] = plan[key] as number;
  return {
    planningTimeMs: wrapper['Planning Time'], executionTimeMs: wrapper['Execution Time'],
    actualRows: plan['Actual Rows'], actualLoops: plan['Actual Loops'], buffers, nodes
  };
}

it('extracts plan and local buffer metrics from the EXPLAIN JSON wrapper', () => {
  expect(explainMetrics({
    'Planning Time': 0.2, 'Execution Time': 0.4,
    Plan: { 'Node Type': 'Limit', 'Actual Rows': 2, 'Actual Loops': 1, 'Local Hit Blocks': 13, 'Local Read Blocks': 4,
      Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'fixture_idx', 'Actual Rows': 2, 'Actual Loops': 1 }] }
  })).toEqual({
    planningTimeMs: 0.2, executionTimeMs: 0.4, actualRows: 2, actualLoops: 1,
    buffers: { 'Local Hit Blocks': 13, 'Local Read Blocks': 4 },
    nodes: [
      { node: 'Limit', index: null, actualRows: 2, loops: 1 },
      { node: 'Index Scan', index: 'fixture_idx', actualRows: 2, loops: 1 }
    ]
  });
});

describe.skipIf(!databaseUrl)('Snapshot evidence index PostgreSQL regression', () => {
  let sql: ReturnType<typeof postgres>;
  let fixtureRowCount = 0;
  let fixtureRowsByKind: Record<string, number> = {};
  let expectedArtifactIds: string[] = [];
  const connectors = [
    { id: 'fixture-connector-a', projectIds: ['target', 'target-2'] },
    { id: 'fixture-connector-b', projectIds: ['target'] },
    { id: 'fixture-connector-c', projectIds: ['target-2'] },
    { id: 'fixture-connector-d', projectIds: ['target', 'target-2'] }
  ];

  beforeAll(async () => {
    const location = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1'].includes(location.hostname) || !location.pathname.endsWith('_test')) {
      throw new Error('Snapshot index fixture requires loopback *_test database');
    }
    sql = postgres(databaseUrl!, { max: 1, connection: { statement_timeout: 10_000, lock_timeout: 2_000 } });
    await sql`CREATE TEMP TABLE wb_records (
      id text PRIMARY KEY, kind text NOT NULL, project_id text, data jsonb NOT NULL,
      updated_at timestamptz NOT NULL
    ) ON COMMIT PRESERVE ROWS`;
    await sql.unsafe('CREATE INDEX wb_records_scope ON wb_records(kind, project_id)');
    await sql.unsafe("CREATE INDEX wb_message_history ON wb_records(project_id,(data->>'workId'),(data->>'createdAt'),id) WHERE kind='message'");
    await sql.unsafe("CREATE INDEX wb_run_status ON wb_records(project_id,(data->>'status')) WHERE kind='run'");

    const rows: Array<{ id: string; kind: string; project_id: string; data: postgres.JSONValue; updated_at: string }> = [];
    const artifactOrder: Array<{ id: string; projectId: string; kind: string | null; updatedAt: string }> = [];
    const start = Date.UTC(2025, 0, 1);
    const at = (offset: number) => new Date(start + offset).toISOString();
    const addArtifact = (id: string, projectId: string, artifactKind: string | null, updatedAt: string) => {
      rows.push({
        id, kind: 'artifact', project_id: projectId,
        data: { id, kind: artifactKind, projectId, workId: `work-${id}`, runId: `run-${id}`, createdAt: updatedAt, updatedAt, data: { contentBase64: 'eA=='.repeat(256) } },
        updated_at: updatedAt
      });
      artifactOrder.push({ id, projectId, kind: artifactKind, updatedAt });
    };
    for (let i = 0; i < 2400; i++) {
      const project = i % 8 === 0 ? 'foreign' : i % 2 === 0 ? 'target' : 'target-2';
      const kind = i % 5 === 0 ? 'diff_file_chunk' : ['diff', 'qa', 'delivery', 'source'][i % 4]!;
      addArtifact(`artifact-${String(i).padStart(5, '0')}`, project, kind, at(Math.floor(i / 4) * 1000));
    }
    addArtifact('artifact-null-kind', 'target', null, at(2_401_000));
    for (let i = 0; i < 198; i++)
      addArtifact(`artifact-limit-top-${String(i).padStart(3, '0')}`, 'target', 'qa', at(1_601_000 + i * 1000));
    for (let i = 0; i < 4; i++)
      addArtifact(`artifact-limit-tie-${String(i).padStart(2, '0')}`, 'target-2', 'delivery', at(1_600_000));
    expectedArtifactIds = artifactOrder
      .filter(row => projectIds.includes(row.projectId) && row.kind !== null && row.kind !== 'diff_file_chunk')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, 200)
      .map(row => row.id);

    let messageNumber = 0;
    const addMessage = (projectId: string, runId: string | null, role: string | null, createdAt: string, workId: string) => {
      const id = `message-${String(messageNumber++).padStart(5, '0')}`;
      rows.push({ id, kind: 'message', project_id: projectId, data: { id, projectId, workId, runId, role, createdAt }, updated_at: createdAt });
    };
    const addRun = (connectorId: string, connectorIndex: number, runNumber: number, projectId: string, updatedAt: string, latestTie = false) => {
      const id = `run-${connectorIndex}-${String(runNumber).padStart(3, '0')}`;
      const status = latestTie || runNumber % 4 !== 0 ? 'completed' : 'running';
      const threadId = latestTie || runNumber % 5 !== 0 ? `thread-${connectorIndex}-${runNumber}` : '';
      rows.push({ id, kind: 'run', project_id: projectId, data: { id, connectorId, status, threadId, updatedAt }, updated_at: updatedAt });
      addMessage(projectId, id, 'user', updatedAt, `work-${connectorIndex}-${runNumber}`);
      addMessage(projectId, `unmatched-${id}`, 'agent', updatedAt, `work-${connectorIndex}-${runNumber}`);
      addMessage(projectId === 'foreign' ? 'target' : 'foreign', id, 'subagent', updatedAt, `work-${connectorIndex}-${runNumber}`);
      addMessage(projectId, id, null, updatedAt, `work-${connectorIndex}-${runNumber}`);
      addMessage(projectId, null, 'master', updatedAt, `work-${connectorIndex}-${runNumber}`);
      if ((latestTie || (runNumber % 13 !== 0 && runNumber % 4 !== 0)) && threadId)
        addMessage(projectId, id, ['master', 'agent', 'subagent'][runNumber % 3]!, updatedAt, `work-${connectorIndex}-${runNumber}`);
    };
    connectors.forEach((connector, connectorIndex) => {
      for (let i = 0; i < 72; i++) {
        const projectId = i % 12 === 0 ? 'foreign' : i % 2 === 0 ? 'target' : 'target-2';
        addRun(connector.id, connectorIndex, i, projectId, at(1_000_000 + Math.floor(i / 2) * 1000));
      }
      const tieProjects = connector.projectIds.length === 1 ? [connector.projectIds[0], connector.projectIds[0]] : ['target', 'target-2'];
      tieProjects.forEach((projectId, tieIndex) => addRun(connector.id, connectorIndex, 72 + tieIndex, projectId!, at(1_200_000), true));
    });
    for (let i = 0; i < 120; i++) {
      const projectId = i % 11 === 0 ? 'foreign' : i % 2 === 0 ? 'target' : 'target-2';
      const id = `unrelated-run-${String(i).padStart(5, '0')}`;
      const updatedAt = at(i * 1000);
      rows.push({ id, kind: 'run', project_id: projectId, data: { id, connectorId: 'unrelated-connector', status: i % 7 === 0 ? 'running' : 'completed', threadId: `thread-${i}`, updatedAt }, updated_at: updatedAt });
    }
    fixtureRowCount = rows.length;
    fixtureRowsByKind = rows.reduce<Record<string, number>>((counts, row) => { counts[row.kind] = (counts[row.kind] ?? 0) + 1; return counts; }, {});
    await sql`INSERT INTO wb_records ${sql(rows)}`;
    await sql`ANALYZE wb_records`;
  }, 15_000);

  afterAll(async () => { await sql?.end(); });

  it('preserves complete metadata and connector evidence results while measuring both query plans', async () => {
    const artifacts = () => sql`SELECT CASE WHEN data->>'kind'='diff' THEN jsonb_set(data,'{data}',(data->'data')-'patch') ELSE data-'data' END AS data FROM wb_records WHERE kind='artifact'
      AND project_id=ANY(${projectIds}) AND data->>'kind'<>'diff_file_chunk'
      AND (${null}::text IS NULL OR data->>'workId'=${null}::text)
      ORDER BY updated_at DESC,id DESC LIMIT 200`;
    const evidence = (connector: typeof connectors[number]) => sql<{ id: string; verified_at: string }[]>`SELECT r.id,r.data->>'updatedAt' AS verified_at FROM wb_records r
      WHERE r.kind='run' AND r.project_id IN ${sql(connector.projectIds)}
      AND r.data->>'connectorId'=${connector.id} AND r.data->>'status'='completed'
      AND COALESCE(r.data->>'threadId','')<>''
      AND EXISTS(SELECT 1 FROM wb_records m WHERE m.kind='message' AND m.project_id=r.project_id
        AND m.data->>'runId'=r.id AND m.data->>'role' IN ('master','agent','subagent'))
      ORDER BY r.updated_at DESC LIMIT 1`;
    const eligibleNewest = (connector: typeof connectors[number]) => sql<{ id: string; updated_at: Date; verified_at: string }[]>`SELECT r.id,r.updated_at,r.data->>'updatedAt' AS verified_at FROM wb_records r
      WHERE r.kind='run' AND r.project_id IN ${sql(connector.projectIds)}
      AND r.data->>'connectorId'=${connector.id} AND r.data->>'status'='completed'
      AND COALESCE(r.data->>'threadId','')<>''
      AND EXISTS(SELECT 1 FROM wb_records m WHERE m.kind='message' AND m.project_id=r.project_id
        AND m.data->>'runId'=r.id AND m.data->>'role' IN ('master','agent','subagent'))
      ORDER BY r.updated_at DESC`;
    const explainArtifact = async () => {
      const result = await sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) SELECT CASE WHEN data->>'kind'='diff' THEN jsonb_set(data,'{data}',(data->'data')-'patch') ELSE data-'data' END AS data FROM wb_records WHERE kind='artifact' AND project_id=ANY(${projectIds}) AND data->>'kind'<>'diff_file_chunk' AND (${null}::text IS NULL OR data->>'workId'=${null}::text) ORDER BY updated_at DESC,id DESC LIMIT 200`;
      return (result[0]!['QUERY PLAN'] as Array<Record<string, unknown>>)[0]!;
    };
    const explainEvidence = async (connector: typeof connectors[number]) => {
      const result = await sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) SELECT r.id,r.data->>'updatedAt' AS verified_at FROM wb_records r WHERE r.kind='run' AND r.project_id IN ${sql(connector.projectIds)} AND r.data->>'connectorId'=${connector.id} AND r.data->>'status'='completed' AND COALESCE(r.data->>'threadId','')<>'' AND EXISTS(SELECT 1 FROM wb_records m WHERE m.kind='message' AND m.project_id=r.project_id AND m.data->>'runId'=r.id AND m.data->>'role' IN ('master','agent','subagent')) ORDER BY r.updated_at DESC LIMIT 1`;
      return (result[0]!['QUERY PLAN'] as Array<Record<string, unknown>>)[0]!;
    };
    const beforeArtifacts = await artifacts();
    const beforeEvidence = new Map<string, Awaited<ReturnType<typeof evidence>>>();
    const beforeEligible = new Map<string, Awaited<ReturnType<typeof eligibleNewest>>>();
    for (const connector of connectors) {
      beforeEvidence.set(connector.id, await evidence(connector));
      beforeEligible.set(connector.id, await eligibleNewest(connector));
    }
    const beforePlans = { artifacts: await explainArtifact(), evidence: new Map<string, Record<string, unknown>>() };
    for (const connector of connectors) beforePlans.evidence.set(connector.id, await explainEvidence(connector));
    await sql.unsafe(messageIndex);
    const afterArtifacts = await artifacts();
    const afterEvidence = new Map<string, Awaited<ReturnType<typeof evidence>>>();
    const afterPlans = { artifacts: await explainArtifact(), evidence: new Map<string, Record<string, unknown>>() };
    for (const connector of connectors) {
      afterEvidence.set(connector.id, await evidence(connector));
      afterPlans.evidence.set(connector.id, await explainEvidence(connector));
    }

    const measurementPath = join(process.cwd(), '.local', 'snapshot-index-fixture-measurement-safe.json');
    const report = {
      fixture: 'synthetic session-local TEMP wb_records only',
      baselineIndexes,
      candidateIndexes: ['wb_records_snapshot_run_evidence_idx'],
      excludedIndexes,
      fixtureRows: fixtureRowCount,
      fixtureRowsByKind,
      resultRows: {
        before: { artifacts: beforeArtifacts.length, evidenceByConnector: Object.fromEntries([...beforeEvidence].map(([id, result]) => [id, result.length])) },
        after: { artifacts: afterArtifacts.length, evidenceByConnector: Object.fromEntries([...afterEvidence].map(([id, result]) => [id, result.length])) }
      },
      before: { artifacts: explainMetrics(beforePlans.artifacts), evidenceByConnector: Object.fromEntries([...beforePlans.evidence].map(([id, plan]) => [id, explainMetrics(plan)])) },
      after: { artifacts: explainMetrics(afterPlans.artifacts), evidenceByConnector: Object.fromEntries([...afterPlans.evidence].map(([id, plan]) => [id, explainMetrics(plan)])) }
    };
    await writeFile(measurementPath, `${JSON.stringify(report, null, 2)}\n`);
    console.info('snapshot index fixture aggregate plans', JSON.stringify(report));

    const artifactIds = (result: typeof beforeArtifacts) => (result as unknown as Array<{ data: { id: string } }>).map(row => row.data.id);
    expect(afterArtifacts).toEqual(beforeArtifacts);
    expect(beforeArtifacts).toHaveLength(200);
    expect(artifactIds(beforeArtifacts)).toEqual(expectedArtifactIds);
    expect(artifactIds(afterArtifacts)).toEqual(expectedArtifactIds);
    expect((afterArtifacts as unknown as Array<{ data: { projectId: string } }>).every(row => projectIds.includes(row.data.projectId))).toBe(true);
    expect(expectedArtifactIds.slice(-2)).toEqual(['artifact-limit-tie-03', 'artifact-limit-tie-02']);
    for (const connector of connectors) {
      const eligibleBefore = beforeEligible.get(connector.id)!;
      const eligibleAfter = await eligibleNewest(connector);
      const latestTime = eligibleBefore[0]?.updated_at.getTime();
      const latestIds = eligibleBefore.filter(row => row.updated_at.getTime() === latestTime).map(row => row.id).sort();
      expect(eligibleAfter.filter(row => row.updated_at.getTime() === latestTime).map(row => row.id).sort()).toEqual(latestIds);
      expect(latestIds).toHaveLength(2);
      for (const actual of [beforeEvidence.get(connector.id)![0], afterEvidence.get(connector.id)![0]]) {
        expect(actual).toBeDefined();
        expect(latestIds).toContain(actual!.id);
        expect(actual!.verified_at).toBe(eligibleBefore[0]!.verified_at);
      }
      expect(beforeEvidence.get(connector.id)).toHaveLength(1);
      expect(afterEvidence.get(connector.id)).toHaveLength(1);
    }
  }, 30_000);
});
