import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createWorkbenchApp } from '../src/workbench/app.js';

// This destructive-capable integration suite is opt-in. It only writes to a
// dedicated loopback *_test database after an operator explicitly serializes it.
const databaseUrl = process.env.MENOTEAM_PROVIDER_TEST_DATABASE_URL;
const serialAuthorized = process.env.MENOTEAM_PROVIDER_TEST_SERIAL_AUTHORIZED === '1';
const enabled = Boolean(databaseUrl && serialAuthorized);

const legacyMigrationFiles = [
  '001_initial.sql',
  '002_owner_provenance.sql',
  '003_workbench.sql',
  '004_workbench_constraints.sql',
  '005_workbench_bridge_tokens.sql'
];
const providerIndexes = ['wb_provider_single_default', 'wb_provider_connector_identity'];

async function verifyProviderMigrationBoundary(databaseUrl: string): Promise<void> {
  const location = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(location.hostname) || !location.pathname.replace(/^\//u, '').endsWith('_test'))
    throw new Error('Migration boundary tests require a loopback *_test database');

  const sql = postgres(databaseUrl, { max: 1 });
  const legacyDir = await mkdtemp(join(tmpdir(), 'menoteam-provider-legacy-migrations-'));
  const fixtureIds = [`migration-provider-a-${randomUUID()}`, `migration-provider-b-${randomUUID()}`];
  const insertedFixtureIds: string[] = [];
  try {
    const existingTables = await sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
    if (existingTables.length)
      throw new Error('Migration boundary test requires a fresh empty *_test database; existing tables were left untouched');

    for (const file of legacyMigrationFiles)
      await copyFile(join(process.cwd(), 'migrations', file), join(legacyDir, file));

    await migrate(databaseUrl, legacyDir);
    const legacyLedger = await sql<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`;
    expect(legacyLedger.map(row => row.version)).toEqual(legacyMigrationFiles);

    const duplicateConnectorId = `migration-connector-${randomUUID()}`;
    for (const id of fixtureIds) {
      const record = {
        id,
        kind: 'provider',
        name: `Migration fixture ${id}`,
        data: { provider: 'openai', method: 'codex-host', connectorId: duplicateConnectorId, enabled: true, default: false }
      };
      await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${id},'setting',NULL,${sql.json(record)})`;
      insertedFixtureIds.push(id);
    }

    await expect(migrate(databaseUrl)).rejects.toMatchObject({ code: '23505' });
    const failedLedger = await sql<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`;
    expect(failedLedger.map(row => row.version)).toEqual(legacyMigrationFiles);
    const indexesAfterFailure = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname=ANY(${sql.array(providerIndexes, 'text')})
      ORDER BY indexname`;
    expect(indexesAfterFailure).toHaveLength(0);
    const preservedAfterFailure = await sql<{ id: string; connector_id: string }[]>`
      SELECT id,data->'data'->>'connectorId' AS connector_id FROM wb_records WHERE id=ANY(${sql.array(fixtureIds, 'text')}) ORDER BY id`;
    expect(preservedAfterFailure).toHaveLength(2);
    expect(preservedAfterFailure.map(row => row.connector_id)).toEqual([duplicateConnectorId, duplicateConnectorId]);

    await sql`DELETE FROM wb_records WHERE id=${fixtureIds[1]}`;
    const uniqueRecord = {
      id: fixtureIds[1],
      kind: 'provider',
      name: `Migration fixture ${fixtureIds[1]}`,
      data: { provider: 'openai', method: 'codex-host', connectorId: `migration-connector-${randomUUID()}`, enabled: true, default: true }
    };
    await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${fixtureIds[1]},'setting',NULL,${sql.json(uniqueRecord)})`;

    await migrate(databaseUrl);
    const upgradedLedger = await sql<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`;
    expect(upgradedLedger.map(row => row.version)).toEqual([...legacyMigrationFiles, '006_workbench_provider_connections.sql']);
    const indexesAfterSuccess = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname=ANY(${sql.array(providerIndexes, 'text')})
      ORDER BY indexname`;
    expect(indexesAfterSuccess.map(row => row.indexname)).toEqual([...providerIndexes].sort());
    await expect(migrate(databaseUrl, legacyDir)).rejects.toThrow('Database schema 006_workbench_provider_connections.sql is newer than this application');

    const preservedAfterOldMigrator = await sql<{ id: string }[]>`
      SELECT id FROM wb_records WHERE id=ANY(${sql.array(fixtureIds, 'text')}) ORDER BY id`;
    expect(preservedAfterOldMigrator.map(row => row.id)).toEqual([...fixtureIds].sort());
    const ledgerAfterOldMigrator = await sql<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`;
    expect(ledgerAfterOldMigrator.map(row => row.version)).toEqual([...legacyMigrationFiles, '006_workbench_provider_connections.sql']);
    const indexesAfterOldMigrator = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname=ANY(${sql.array(providerIndexes, 'text')})
      ORDER BY indexname`;
    expect(indexesAfterOldMigrator.map(row => row.indexname)).toEqual([...providerIndexes].sort());
  } finally {
    try {
      const hasRecordsTable = await sql<{ present: boolean }[]>`SELECT to_regclass('public.wb_records') IS NOT NULL AS present`;
      if (hasRecordsTable[0]?.present && insertedFixtureIds.length)
        await sql`DELETE FROM wb_records WHERE id=ANY(${sql.array(insertedFixtureIds, 'text')})`;
    } finally {
      await sql.end();
      await rm(legacyDir, { recursive: true, force: true });
    }
  }
}

describe.skipIf(!enabled)('Provider migration 006 PostgreSQL boundary', () => {
  it('rolls back a failed unique index upgrade and keeps newer schemas intact when an older migrator runs', async () => {
    await verifyProviderMigrationBoundary(databaseUrl as string);
  }, 30_000);
});

describe.skipIf(!enabled)('Provider connection PostgreSQL HTTP contracts', () => {
  let sql: ReturnType<typeof postgres>;
  let app: Awaited<ReturnType<typeof createWorkbenchApp>>;
  let activeApp: typeof app | undefined;
  const suffix = randomUUID();
  const ownerEmail = `provider-owner-${suffix}@test.invalid`;
  const password = `provider-${randomUUID()}-Password`;
  const projectIds: string[] = [];
  const connectorIds: string[] = [];
  const settingIds: string[] = [];
  const userEmails = [ownerEmail];
  const runIds: string[] = [];
  let ownerCookie = '';
  let ownsDatabase = false;

  const user = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown, cookie = ownerCookie) => app.inject({
    method,
    url: `/api/workbench${path}`,
    headers: { cookie },
    payload: payload as never
  });
  const checked = (response: { statusCode: number; body: string; json(): any }, status = 200) => {
    expect(response.statusCode, response.statusCode === status ? undefined : response.body).toBe(status);
    return response.json();
  };
  async function makeProject(name: string) {
    const project = checked(await user('POST', '/projects', { name: `${name} ${suffix}` }));
    projectIds.push(project.id);
    return project;
  }
  async function enrollFixtureConnector(id: string, projectId: string, models = ['gpt-6-luna', 'gpt-6.1-sol']) {
    const connectorId = `${id}-${suffix}`;
    connectorIds.push(connectorId);
    const enrollment = checked(await user('POST', '/connectors', { id: connectorId, projectIds: [projectId] }));
    const heartbeat = await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${enrollment.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models, runKinds: [] } } });
    expect(heartbeat.statusCode).toBe(204);
    const persisted = await sql`SELECT last_seen,capabilities FROM wb_connectors WHERE id=${connectorId}`;
    expect(persisted[0]?.last_seen).toBeTruthy();
    expect(persisted[0]?.capabilities).toMatchObject({ codexAppServer: true, localWorktrees: true, models });
    return { connectorId, token: enrollment.token };
  }
  async function addConnection(connectorId: string, name = `Codex ${connectorId}`) {
    const setting = checked(await user('POST', '/settings', {
      kind: 'provider', name,
      data: { provider: 'openai', method: 'codex-host', connectorId, enabled: true, default: false }
    }));
    settingIds.push(setting.id);
    return setting;
  }
  beforeAll(async () => {
    if (!databaseUrl || !serialAuthorized) throw new Error('Provider PostgreSQL tests require MENOTEAM_PROVIDER_TEST_DATABASE_URL and MENOTEAM_PROVIDER_TEST_SERIAL_AUTHORIZED=1');
    const location = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(location.hostname) || !location.pathname.replace(/^\//u, '').endsWith('_test'))
      throw new Error('Provider test database must be a loopback *_test database');
    sql = postgres(databaseUrl);
    await migrate(databaseUrl);
    const existing = await sql`SELECT (SELECT count(*) FROM wb_users)::int AS users,(SELECT count(*) FROM wb_records)::int AS records,(SELECT count(*) FROM wb_connectors)::int AS connectors,(SELECT count(*) FROM wb_requests)::int AS requests,(SELECT count(*) FROM wb_bridge_tokens)::int AS bridge_tokens,(SELECT count(*) FROM wb_sessions)::int AS sessions,(SELECT count(*) FROM wb_memberships)::int AS memberships,(SELECT count(*) FROM wb_invites)::int AS invites`;
    if (Number(existing[0]?.users) || Number(existing[0]?.records) || Number(existing[0]?.connectors) || Number(existing[0]?.requests) || Number(existing[0]?.bridge_tokens) || Number(existing[0]?.sessions) || Number(existing[0]?.memberships) || Number(existing[0]?.invites))
      throw new Error('Provider contract suite requires a dedicated empty *_test database; existing workbench data was left untouched');
    ownsDatabase = true;
    app = await createWorkbenchApp({ sql, bootstrapEmail: ownerEmail, bootstrapPassword: password });
    activeApp = app;
    const login = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: ownerEmail, password } });
    expect(login.statusCode).toBe(200);
    ownerCookie = String(login.headers['set-cookie']).split(';')[0]!;
    await app.close();
    activeApp = undefined;
  });

  beforeEach(async () => {
    // Keep the production limiter enabled while giving each HTTP contract a fresh bucket.
    app = await createWorkbenchApp({ sql });
    activeApp = app;
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = undefined;
    }
  });

  afterAll(async () => {
    let foreignSentinelsCreated = false;
    let appCloseError: unknown;
    try {
      if (activeApp) {
        try {
          await activeApp.close();
        } catch (error) {
          appCloseError = error;
        }
        activeApp = undefined;
      }
      // A non-empty test database is never owned by this suite and remains untouched.
      if (!sql || !ownsDatabase) return;

      // Gather every suite-project run before deleting records. This includes generated
      // completion wakes and any runs left by a test that failed partway through.
      runIds.push(...(await sql`SELECT id FROM wb_records WHERE kind='run' AND project_id=ANY(${projectIds})`).map(row => String(row.id)));
      const requestScopes = [...projectIds.map(id => `message:${id}`), ...runIds.map(id => `tools:${id}`)];

      // Foreign sentinels prove that scoped cleanup preserves neighboring lifecycle data.
      const foreignProjectId = `foreign-project-${suffix}`;
      const foreignRunId = `foreign-run-${suffix}`;
      const foreignRequestId = `foreign-request-${suffix}`;
      const foreignTokenDigest = createHash('sha256').update(`foreign-token-${suffix}`).digest('hex');
      await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${foreignProjectId},'project',NULL,${sql.json({ id: foreignProjectId, name: 'Unrelated teardown sentinel' })})`;
      foreignSentinelsCreated = true;
      await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${foreignRunId},'run',${foreignProjectId},${sql.json({ id: foreignRunId, projectId: foreignProjectId, kind: 'master', status: 'queued', generation: 0 })})`;
      await sql`INSERT INTO wb_requests(scope,request_id,result) VALUES (${'tools:' + foreignRunId},${foreignRequestId},${sql.json({ preserved: true })})`;
      await sql`INSERT INTO wb_bridge_tokens(digest,run_id,generation,expires_at) VALUES (${foreignTokenDigest},${foreignRunId},1,now()+interval '1 minute')`;

      // Remove all run-associated state before deleting the runs themselves.
      if (requestScopes.length) await sql`DELETE FROM wb_requests WHERE scope=ANY(${requestScopes})`;
      if (runIds.length) await sql`DELETE FROM wb_bridge_tokens WHERE run_id=ANY(${runIds})`;
      if (projectIds.length) await sql`DELETE FROM wb_records WHERE project_id=ANY(${projectIds})`;
      if (settingIds.length) await sql`DELETE FROM wb_records WHERE id=ANY(${settingIds})`;
      if (projectIds.length) await sql`DELETE FROM wb_records WHERE id=ANY(${projectIds})`;
      if (connectorIds.length) await sql`DELETE FROM wb_connectors WHERE id=ANY(${connectorIds})`;
      if (userEmails.length) {
        await sql`DELETE FROM wb_memberships WHERE user_id IN (SELECT id FROM wb_users WHERE email=ANY(${userEmails}))`;
        await sql`DELETE FROM wb_sessions WHERE user_id IN (SELECT id FROM wb_users WHERE email=ANY(${userEmails}))`;
        await sql`DELETE FROM wb_invites WHERE email=ANY(${userEmails})`;
        await sql`DELETE FROM wb_users WHERE email=ANY(${userEmails})`;
      }

      const ownedRecordIds = [...projectIds, ...settingIds, ...runIds];
      const remainingOwnedRecords = ownedRecordIds.length ? await sql`SELECT id FROM wb_records WHERE project_id=ANY(${projectIds}) OR id=ANY(${ownedRecordIds})` : [];
      const remainingOwnedRequests = requestScopes.length ? await sql`SELECT scope,request_id FROM wb_requests WHERE scope=ANY(${requestScopes})` : [];
      const remainingOwnedTokens = runIds.length ? await sql`SELECT digest FROM wb_bridge_tokens WHERE run_id=ANY(${runIds})` : [];
      expect(remainingOwnedRecords).toHaveLength(0);
      expect(remainingOwnedRequests).toHaveLength(0);
      expect(remainingOwnedTokens).toHaveLength(0);

      expect(await sql`SELECT id FROM wb_records WHERE id=${foreignProjectId} AND kind='project'`).toHaveLength(1);
      expect(await sql`SELECT id FROM wb_records WHERE id=${foreignRunId} AND kind='run' AND project_id=${foreignProjectId}`).toHaveLength(1);
      expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${'tools:' + foreignRunId} AND request_id=${foreignRequestId}`).toHaveLength(1);
      expect(await sql`SELECT digest FROM wb_bridge_tokens WHERE digest=${foreignTokenDigest} AND run_id=${foreignRunId}`).toHaveLength(1);
      if (appCloseError) throw appCloseError;
    } finally {
      if (sql) {
        try {
          if (foreignSentinelsCreated) {
            const foreignProjectId = `foreign-project-${suffix}`;
            const foreignRunId = `foreign-run-${suffix}`;
            const foreignRequestId = `foreign-request-${suffix}`;
            const foreignTokenDigest = createHash('sha256').update(`foreign-token-${suffix}`).digest('hex');
            await sql`DELETE FROM wb_requests WHERE scope=${'tools:' + foreignRunId} AND request_id=${foreignRequestId}`;
            await sql`DELETE FROM wb_bridge_tokens WHERE digest=${foreignTokenDigest} AND run_id=${foreignRunId}`;
            await sql`DELETE FROM wb_records WHERE id=${foreignRunId}`;
            await sql`DELETE FROM wb_records WHERE id=${foreignProjectId}`;
          }
        } finally {
          await sql.end();
        }
      }
    }
  });

  it('binds only an enrolled connector with proven capabilities and enforces workspace roles', async () => {
    const project = await makeProject('Provider access');
    const enrolled = await enrollFixtureConnector('enrolled', project.id);
    const unavailable = await enrollFixtureConnector('no-capabilities', project.id, []);
    const outsiderProject = await makeProject('Outside access');
    const outsideConnector = await enrollFixtureConnector('outside', outsiderProject.id);

    const connection = await addConnection(enrolled.connectorId, 'Primary Codex');
    expect(connection.data).toMatchObject({ provider: 'openai', method: 'codex-host', connectorId: enrolled.connectorId, enabled: true, default: true });
    expect((await user('POST', '/settings', { kind: 'provider', name: 'No model capabilities', data: { provider: 'openai', method: 'codex-host', connectorId: unavailable.connectorId } })).statusCode).toBe(409);
    expect((await user('POST', '/settings', { kind: 'provider', name: 'Unenrolled', data: { provider: 'openai', method: 'codex-host', connectorId: `missing-${suffix}` } })).statusCode).toBe(400);
    const outsideConnection = await addConnection(outsideConnector.connectorId, 'Other project runtime');
    expect((await user('POST', `/projects/${project.id}/works`, { title: 'Cross-project connector grant', connectionId: outsideConnection.id })).statusCode).toBe(403);

    const memberEmail = `member-${suffix}@test.invalid`;
    userEmails.push(memberEmail);
    const invite = checked(await user('POST', '/invites', { email: memberEmail, projectId: project.id, role: 'member' }));
    const memberPassword = `member-${randomUUID()}-Password`;
    checked(await app.inject({ method: 'POST', url: '/api/workbench/invites/accept', payload: { token: invite.token, name: 'Member', password: memberPassword } }));
    const memberResponse = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: memberEmail, password: memberPassword } });
    const deniedCookie = String(memberResponse.headers['set-cookie']).split(';')[0]!;
    expect(memberResponse.statusCode).toBe(200);
    expect((await user('POST', '/settings', { kind: 'provider', name: 'Member attempt', data: { provider: 'openai', method: 'codex-host', connectorId: enrolled.connectorId } }, deniedCookie)).statusCode).toBe(403);

    const adminEmail = `project-admin-${suffix}@test.invalid`;
    userEmails.push(adminEmail);
    const adminInvite = checked(await user('POST', '/invites', { email: adminEmail, projectId: project.id, role: 'admin' }));
    const adminPassword = `project-admin-${randomUUID()}-Password`;
    checked(await app.inject({ method: 'POST', url: '/api/workbench/invites/accept', payload: { token: adminInvite.token, name: 'Project admin', password: adminPassword } }));
    await sql`UPDATE wb_users SET role='admin' WHERE email=${adminEmail}`;
    const adminLogin = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: adminEmail, password: adminPassword } });
    expect(adminLogin.statusCode).toBe(200);
    const adminCookie = String(adminLogin.headers['set-cookie']).split(';')[0]!;
    expect((await user('POST', `/projects/${outsiderProject.id}/works`, { title: 'Outside project admin denial', connectionId: outsideConnection.id }, adminCookie)).statusCode).toBe(403);
    expect((await user('POST', '/settings', { kind: 'provider', name: 'Outside host denial', data: { provider: 'openai', method: 'codex-host', connectorId: outsideConnector.connectorId } }, adminCookie)).statusCode).toBe(403);
    const adminHost = await enrollFixtureConnector('admin-accessible', project.id);
    const adminConnection = checked(await user('POST', '/settings', { kind: 'provider', name: 'Admin Codex', data: { provider: 'openai', method: 'codex-host', connectorId: adminHost.connectorId } }, adminCookie));
    settingIds.push(adminConnection.id);
    expect(adminConnection.data.connectorId).toBe(adminHost.connectorId);
    expect((await user('PATCH', `/settings/${connection.id}`, { name: 'Member denied rename' }, deniedCookie)).statusCode).toBe(403);

    const renamed = checked(await user('PATCH', `/settings/${connection.id}`, { name: 'Renamed Codex', expectedUpdatedAt: connection.updatedAt }));
    expect(renamed.name).toBe('Renamed Codex');
    expect(checked(await user('GET', '/snapshot')).providerConnections).toEqual(expect.arrayContaining([expect.objectContaining({ id: connection.id, name: 'Renamed Codex', connectorId: enrolled.connectorId, status: 'available' })]));
  });

  it('serializes duplicate connector binding and reports missing execution capabilities', async () => {
    const project = await makeProject('Provider capability status');
    const host = await enrollFixtureConnector('capability-status', project.id);
    const additions = await Promise.all([
      user('POST', '/settings', { kind: 'provider', name: 'Concurrent binding A', data: { provider: 'openai', method: 'codex-host', connectorId: host.connectorId } }),
      user('POST', '/settings', { kind: 'provider', name: 'Concurrent binding B', data: { provider: 'openai', method: 'codex-host', connectorId: host.connectorId } })
    ]);
    expect(additions.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const bound = additions.find(result => result.statusCode === 200)!.json();
    settingIds.push(bound.id);
    expect((await sql`SELECT count(*)::int AS count FROM wb_records WHERE kind='setting' AND data->>'kind'='provider' AND data->'data'->>'connectorId'=${host.connectorId}`).map(row => Number(row.count))).toEqual([1]);

    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: true, localWorktrees: false, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: [] })} WHERE id=${host.connectorId}`;
    const connection = checked(await user('GET', '/snapshot'));
    const reported = connection.providerConnections.find((item: any) => item.id === bound.id);
    expect(reported).toMatchObject({ status: 'capability_unavailable', localWorktrees: false });
    expect(reported.reason).toMatch(/worktree/i);
    expect((await user('PATCH', `/settings/${bound.id}`, { data: { default: true } })).statusCode).toBe(409);
    expect((await user('POST', `/projects/${project.id}/works`, { title: 'Cannot bind missing worktree capability', connectionId: bound.id })).statusCode).toBe(409);
  });

  it('keeps the workspace default in Project A while a Project B Master explicitly selects its granted connection', async () => {
    const projectA = await makeProject('Default provider Project A');
    const projectB = await makeProject('Explicit provider Project B');
    const connectorA = await enrollFixtureConnector('default-a', projectA.id);
    const connectorB = await enrollFixtureConnector('explicit-b', projectB.id);
    const connectionA = await addConnection(connectorA.connectorId, 'Project A default');
    const connectionB = await addConnection(connectorB.connectorId, 'Project B explicit');
    const defaultA = checked(await user('PATCH', `/settings/${connectionA.id}`, { data: { default: true } }));
    expect(defaultA.data.default).toBe(true);
    expect(connectionB.data.default).toBe(false);

    const master = checked(await user('POST', `/projects/${projectB.id}/messages`, { text: 'Use Project B provider', connectionId: connectionB.id, requestId: `master-b-${suffix}` }));
    expect(master.run.execution).toMatchObject({ connectionId: connectionB.id, connectorId: connectorB.connectorId });
    const masterClaim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${connectorB.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master'] } } }));
    expect(masterClaim.run.id).toBe(master.run.id);
    const bridgeToken = checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.run.id}/bridge-token`, headers: { authorization: `Bearer ${connectorB.token}` }, payload: { generation: masterClaim.run.generation } })).token;
    const bridgeCall = (action: string, input: Record<string, unknown>, requestId: string) => app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.run.id}/tools`, headers: { authorization: `Bearer ${bridgeToken}` }, payload: { generation: masterClaim.run.generation, action, input, requestId } });
    const context = checked(await bridgeCall('read_context', {}, `context-b-${suffix}`));
    expect(context.runtimeProviders.map((item: any) => item.connectorId)).toEqual([connectorB.connectorId]);
    expect(context.providerConnections.map((item: any) => item.id)).toEqual([connectionB.id]);
    const createWork = await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.run.id}/tools`, headers: { authorization: `Bearer ${bridgeToken}` }, payload: { generation: masterClaim.run.generation, action: 'create_work', input: { title: 'Project B explicit Work', connectionId: connectionB.id }, requestId: `create-b-${suffix}` } });
    const created = checked(createWork);
    expect(created).toMatchObject({ projectId: projectB.id, connectionId: connectionB.id });
    const dispatch = await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.run.id}/tools`, headers: { authorization: `Bearer ${bridgeToken}` }, payload: { generation: masterClaim.run.generation, action: 'dispatch', input: { workId: created.id, kind: 'implementation', model: 'gpt-6-luna', prompt: 'Implement this explicitly selected Work' }, requestId: `dispatch-b-${suffix}` } });
    const implementationRun = checked(dispatch);
    expect(implementationRun).toMatchObject({ workId: created.id, targetConnectorId: connectorB.connectorId, execution: { connectionId: connectionB.id, connectorId: connectorB.connectorId, model: 'gpt-6-luna' } });
    expect((await user('GET', '/snapshot')).json().providerConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: connectionA.id, default: true, projectIds: [projectA.id] }),
      expect.objectContaining({ id: connectionB.id, default: false, projectIds: [projectB.id] })
    ]));
    const wrongHostClaim = await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${connectorA.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['implementation'] } } });
    expect(wrongHostClaim.statusCode).toBe(204);
    expect((await sql`SELECT data->>'status' AS status,data->>'targetConnectorId' AS target FROM wb_records WHERE id=${implementationRun.id}`).at(0)).toMatchObject({ status: 'queued', target: connectorB.connectorId });
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.run.id}/complete`, headers: { authorization: `Bearer ${connectorB.token}` }, payload: { generation: masterClaim.run.generation } }));
    const implementation = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${connectorB.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna'], runKinds: ['implementation'] } } }));
    expect(implementation.run.id).toBe(implementationRun.id);
    expect(implementation.run.workId).toBe(created.id);
    expect(implementation.execution).toMatchObject({ connectionId: connectionB.id, connectorId: connectorB.connectorId, model: 'gpt-6-luna' });

    const outsider = await makeProject('Outside explicit provider');
    expect((await user('POST', `/projects/${outsider.id}/works`, { title: 'Cross-project explicit selection', connectionId: connectionB.id })).statusCode).toBe(403);
    const memberEmail = `explicit-member-${suffix}@test.invalid`;
    userEmails.push(memberEmail);
    const invite = checked(await user('POST', '/invites', { email: memberEmail, projectId: projectA.id, role: 'member' }));
    const memberPassword = `explicit-member-${randomUUID()}-Password`;
    checked(await app.inject({ method: 'POST', url: '/api/workbench/invites/accept', payload: { token: invite.token, name: 'Project A member', password: memberPassword } }));
    const memberLogin = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: memberEmail, password: memberPassword } });
    const memberCookie = String(memberLogin.headers['set-cookie']).split(';')[0]!;
    expect(memberLogin.statusCode).toBe(200);
    expect((await user('POST', `/projects/${projectB.id}/works`, { title: 'Member cannot select B connection', connectionId: connectionB.id }, memberCookie)).statusCode).toBe(403);
    expect((await user('POST', `/projects/${projectB.id}/messages`, { text: 'Member cannot run in B', connectionId: connectionB.id, requestId: `member-b-${suffix}` }, memberCookie)).statusCode).toBe(403);
  });

  it('serializes concurrent default changes and freezes Work and run execution identity', async () => {
    const project = await makeProject('Provider execution');
    const firstConnector = await enrollFixtureConnector('first', project.id);
    const secondConnector = await enrollFixtureConnector('second', project.id);
    const first = await addConnection(firstConnector.connectorId, 'First Codex');
    const second = await addConnection(secondConnector.connectorId, 'Second Codex');
    const profile = checked(await user('POST', '/settings', { kind: 'profile', name: 'Frozen profile', data: { model: 'gpt-6-luna', reasoning: 'medium', skillIds: [], tools: [] } }));
    settingIds.push(profile.id);
    const work = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Frozen Work', profileId: profile.id, connectionId: first.id }));
    expect(work.connectionId).toBe(first.id);

    const toggleDefault = (id: string) => user('PATCH', `/settings/${id}`, { data: { default: true } });
    checked(await toggleDefault(first.id));
    const [results, creationRacingDefault] = await Promise.all([
      Promise.all([toggleDefault(first.id), toggleDefault(second.id)]),
      user('POST', `/projects/${project.id}/works`, { title: 'Work created during default race', profileId: profile.id })
    ]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 200]);
    const racedWork = checked(creationRacingDefault);
    expect([first.id, second.id]).toContain(racedWork.connectionId);
    const defaults = await sql`SELECT count(*)::int AS count FROM wb_records WHERE kind='setting' AND data->>'kind'='provider' AND data->'data'->>'default'='true'`;
    expect(Number(defaults[0]?.count)).toBe(1);
    const duplicate = { id: `duplicate-default-${suffix}`, kind: 'provider', name: 'Constraint probe', data: { provider: 'openai', method: 'codex-host', connectorId: `constraint-probe-${suffix}`, enabled: true, default: true }, updatedAt: new Date().toISOString() };
    await expect(sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${duplicate.id},'setting',NULL,${sql.json(duplicate)})`).rejects.toMatchObject({ code: '23505' });

    const selected = work.connectionId === first.id ? firstConnector : secondConnector;
    const other = selected.connectorId === firstConnector.connectorId ? secondConnector : firstConnector;
    const dispatched = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Start frozen run', workId: work.id, requestId: `dispatch-${suffix}` }));
    const run = dispatched.run;
    expect(run.execution).toMatchObject({ connectionId: work.connectionId, connectorId: selected.connectorId, provider: 'openai', method: 'codex-host', profileId: profile.id, profile: { id: profile.id, name: 'Frozen profile', data: { model: 'gpt-6-luna', reasoning: 'medium' } } });
    expect(run.execution.model).toBe('gpt-6-luna');
    const renamedAndCreated = await Promise.all([
      user('PATCH', `/settings/${first.id}`, { name: 'Renamed during explicit Work creation' }),
      user('POST', `/projects/${project.id}/works`, { title: 'Work created during rename', profileId: profile.id, connectionId: first.id })
    ]);
    expect(renamedAndCreated.map(response => response.statusCode).sort()).toEqual([200, 200]);
    const renameRaceWork = renamedAndCreated[1]!.json();
    expect(renameRaceWork.connectionId).toBe(first.id);
    checked(await user('PATCH', `/settings/${profile.id}`, { name: 'Edited after dispatch', data: { model: 'gpt-6.1-sol', reasoning: 'high' } }));
    const claim = (token: string) => app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['implementation'] } } });
    expect((await claim(other.token)).statusCode).toBe(204);
    const claimed = checked(await claim(selected.token));
    expect(claimed.run.id).toBe(run.id);
    expect(claimed.execution).toMatchObject({ connectionId: work.connectionId, connectorId: selected.connectorId, model: 'gpt-6-luna', profile: { id: profile.id, name: 'Frozen profile', data: { model: 'gpt-6-luna', reasoning: 'medium' } } });
    const racedRun = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Use the atomically selected default', workId: racedWork.id, requestId: `default-race-dispatch-${suffix}` })).run;
    const racedExecution = structuredClone(racedRun.execution);
    expect(racedExecution).toMatchObject({ connectionId: racedWork.connectionId, connectorId: racedWork.connectionId === first.id ? firstConnector.connectorId : secondConnector.connectorId });

    checked(await user('PATCH', `/settings/${first.id}`, { data: { default: true } }));
    const disabledAndCreated = await Promise.all([
      user('PATCH', `/settings/${second.id}`, { data: { enabled: false } }),
      user('POST', `/projects/${project.id}/works`, { title: 'Work created during disable race', profileId: profile.id, connectionId: second.id })
    ]);
    expect(disabledAndCreated[0]!.statusCode).toBe(200);
    expect([200, 409]).toContain(disabledAndCreated[1]!.statusCode);
    if (disabledAndCreated[1]!.statusCode === 200) {
      const disableRaceWork = disabledAndCreated[1]!.json();
      expect(disableRaceWork.connectionId).toBe(second.id);
      expect((await user('POST', `/projects/${project.id}/messages`, { text: 'Disabled selection cannot fallback', workId: disableRaceWork.id, requestId: `disable-race-message-${suffix}` })).statusCode).toBe(409);
    } else {
      expect((await sql`SELECT count(*)::int AS count FROM wb_records WHERE kind='work' AND data->>'title'='Work created during disable race'`).map(row => Number(row.count))).toEqual([0]);
    }
    const nextWork = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Default Work' }));
    expect(nextWork.connectionId).toBe((await sql`SELECT id FROM wb_records WHERE kind='setting' AND data->>'kind'='provider' AND data->'data'->>'default'='true'`).map(row => row.id)[0]);
    expect((await user('GET', `/works/${work.id}`)).json().runs[0].execution).toMatchObject({ connectionId: work.connectionId, connectorId: selected.connectorId });
    checked(await user('PATCH', `/settings/${work.connectionId}`, { data: { enabled: false } }));
    const actualUse = await app.inject({ method: 'GET', url: `/api/workbench/connector/runs/${run.id}`, headers: { authorization: `Bearer ${selected.token}` } });
    expect(actualUse.statusCode).toBe(409);
    expect((await user('GET', `/works/${racedWork.id}`)).json().runs.find((item: any) => item.id === racedRun.id).execution).toEqual(racedExecution);
  });

  it('requires Worktree capability for review request, claim, lease renewal, and live reads', async () => {
    const project = await makeProject('Review Worktree capability');
    const host = await enrollFixtureConnector('review-host', project.id);
    const connection = await addConnection(host.connectorId, 'Review Codex');
    checked(await user('PATCH', `/settings/${connection.id}`, { data: { default: true } }));
    const work = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Review requires a local Worktree', connectionId: connection.id }));
    const implementation = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Create review candidate', workId: work.id, requestId: `review-candidate-${suffix}` })).run;
    const implementationClaim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${host.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['implementation'] } } }));
    expect(implementationClaim.run.id).toBe(implementation.id);
    const diff = await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${implementation.id}/artifacts`, headers: { authorization: `Bearer ${host.token}` }, payload: { generation: implementationClaim.run.generation, kind: 'diff', revision: `candidate-${suffix}`, data: { files: [{ path: 'src/example.ts', added: 1, removed: 0 }], candidateRevision: 'a'.repeat(40) }, requestId: `review-diff-${suffix}` } });
    const diffArtifact=checked(diff);
    const qaArtifact=checked(await app.inject({method:'POST',url:`/api/workbench/connector/runs/${implementation.id}/artifacts`,headers:{authorization:`Bearer ${host.token}`},payload:{generation:implementationClaim.run.generation,kind:'qa',revision:`candidate-${suffix}`,data:{candidateFingerprint:'b'.repeat(64),stale:false,checks:[]},requestId:`review-qa-${suffix}`}}));
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${implementation.id}/complete`, headers: { authorization: `Bearer ${host.token}` }, payload: { generation: implementationClaim.run.generation, threadId: `review-candidate-thread-${suffix}` } }));

    const masterClaim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${host.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master'] } } }));
    const master = masterClaim.run;
    expect(master).toMatchObject({ kind: 'master', projectId: project.id, execution: { connectionId: connection.id, connectorId: host.connectorId } });
    expect(master.prompt).toContain(implementation.id);
    const bridge = checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.id}/bridge-token`, headers: { authorization: `Bearer ${host.token}` }, payload: { generation: masterClaim.run.generation } })).token;
    const tool = (kind: 'review', requestId: string) => app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.id}/tools`, headers: { authorization: `Bearer ${bridge}` }, payload: { generation: masterClaim.run.generation, action: 'dispatch', input: { workId: work.id, kind, model: 'gpt-6.1-sol', prompt: 'Review the recorded candidate' }, requestId } });

    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: true, localWorktrees: false, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master', 'review'] })} WHERE id=${host.connectorId}`;
    const deniedReview = await tool('review', `review-request-denied-${suffix}`);
    expect(deniedReview.statusCode).toBe(409);
    expect(deniedReview.body).toMatch(/worktree/i);
    expect((await sql`SELECT count(*)::int AS count FROM wb_records WHERE kind='run' AND data->>'kind'='review' AND data->>'workId'=${work.id}`).map(row => Number(row.count))).toEqual([0]);

    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master', 'review'] })} WHERE id=${host.connectorId}`;
    const review = checked(await tool('review', `review-request-accepted-${suffix}`));
    expect(review.reviewBinding).toMatchObject({candidateRunId:implementation.id,commitSha:'a'.repeat(40),candidateFingerprint:'b'.repeat(64),diffArtifactId:diffArtifact.id,diffRevision:`candidate-${suffix}`,qaArtifactIds:[qaArtifact.id]});
    expect(review).toMatchObject({ kind: 'review', workId: work.id, targetConnectorId: host.connectorId, execution: { connectionId: connection.id, connectorId: host.connectorId } });
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.id}/complete`, headers: { authorization: `Bearer ${host.token}` }, payload: { generation: masterClaim.run.generation } }));
    const reviewClaim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${host.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['review'] } } }));
    expect(reviewClaim.run.id).toBe(review.id);
    const liveHeaders = { authorization: `Bearer ${host.token}` };
    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: true, localWorktrees: false, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['review'] })} WHERE id=${host.connectorId}`;
    expect((await app.inject({ method: 'GET', url: `/api/workbench/connector/runs/${review.id}`, headers: liveHeaders })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${review.id}/renew`, headers: liveHeaders, payload: { generation: reviewClaim.run.generation } })).statusCode).toBe(409);

    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master', 'review'] })} WHERE id=${host.connectorId}`;
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${review.id}/complete`, headers: liveHeaders, payload: { generation: reviewClaim.run.generation } }));
    const secondMasterClaim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: liveHeaders, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master'] } } }));
    const secondMaster = secondMasterClaim.run;
    expect(secondMaster).toMatchObject({ kind: 'master', projectId: project.id, execution: { connectionId: connection.id, connectorId: host.connectorId } });
    expect(secondMaster.prompt).toContain(review.id);
    const secondBridge = checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${secondMaster.id}/bridge-token`, headers: liveHeaders, payload: { generation: secondMasterClaim.run.generation } })).token;
    const secondReview = checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${secondMaster.id}/tools`, headers: { authorization: `Bearer ${secondBridge}` }, payload: { generation: secondMasterClaim.run.generation, action: 'dispatch', input: { workId: work.id, kind: 'review', model: 'gpt-6.1-sol', prompt: 'Review again after rechecking capability' }, requestId: `review-dispatch-second-${suffix}` } }));
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${secondMaster.id}/complete`, headers: liveHeaders, payload: { generation: secondMasterClaim.run.generation } }));
    expect(secondReview.kind).toBe('review');
    const revokedAtClaim = await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: liveHeaders, payload: { capabilities: { codexAppServer: true, localWorktrees: false, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['review'] } } });
    expect(revokedAtClaim.statusCode).toBe(204);
    expect((await sql`SELECT data->>'status' AS status,data->>'error' AS error FROM wb_records WHERE kind='run' AND id=${secondReview.id}`).at(0)).toMatchObject({ status: 'failed', error: expect.stringMatching(/worktree/i) });
  });

  it('uses review settings for a first cross-kind review of legacy and connected implementation Work', async () => {
    for (const legacy of [true, false]) {
      const mode = legacy ? 'legacy' : 'connected';
      const project = await makeProject(`Cross-kind ${mode} review snapshot`);
      const host = await enrollFixtureConnector(`cross-kind-review-${mode}`, project.id);
      const connection = await addConnection(host.connectorId, 'Implementation connection');
      const selectedDefault = checked(await user('PATCH', `/settings/${connection.id}`, { data: { default: true } }));
      expect(selectedDefault.data).toMatchObject({ connectorId: host.connectorId, default: true });
      const grantedProjectIds = await sql`SELECT project_ids FROM wb_connectors WHERE id=${host.connectorId}`;
      expect(grantedProjectIds[0]?.project_ids).toContain(project.id);
      const skill = checked(await user('POST', '/settings', { kind: 'skill', name: `Implementation-only skill ${mode}`, data: { content: 'Do not carry this into review' } }));
      settingIds.push(skill.id);
      const profile = checked(await user('POST', '/settings', { kind: 'profile', name: `Implementation profile ${mode}`, data: { model: 'gpt-6-luna', reasoning: 'low', skillIds: [skill.id], tools: [] } }));
      settingIds.push(profile.id);
      const work = checked(await user('POST', `/projects/${project.id}/works`, { title: `Implementation to review ${mode}`, profileId: profile.id, connectionId: connection.id }));
      const implementation = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Create the implementation candidate', workId: work.id, requestId: `cross-kind-impl-${mode}-${suffix}` })).run;
      const headers = { authorization: `Bearer ${host.token}` };
      const claim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['implementation'] } } }));
      expect(claim.run.id).toBe(implementation.id);
      const diffArtifact=checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${implementation.id}/artifacts`, headers, payload: { generation: claim.run.generation, kind: 'diff', revision: `cross-kind-candidate-${mode}-${suffix}`, data: { files: [{ path: 'src/implementation.ts', added: 1, removed: 0 }],candidateRevision:'c'.repeat(40) }, requestId: `cross-kind-diff-${mode}-${suffix}` } }));
      const qaArtifact=checked(await app.inject({method:'POST',url:`/api/workbench/connector/runs/${implementation.id}/artifacts`,headers,payload:{generation:claim.run.generation,kind:'qa',revision:`cross-kind-candidate-${mode}-${suffix}`,data:{candidateFingerprint:'d'.repeat(64),stale:false,checks:[]},requestId:`cross-kind-qa-${mode}-${suffix}`}}));

      // Simulate a valid frozen historical record through the test-store boundary;
      // public profile settings intentionally reject configurable tools.
      const historicalExecution = { ...claim.run.execution, tools: ['read_context'], ...(legacy ? { legacy: true } : {}) };
      if (legacy) {
        delete historicalExecution.connectionId;
        await sql`UPDATE wb_records SET data=data-'connectionId' WHERE kind='work' AND id=${work.id}`;
      }
      await sql`UPDATE wb_records SET data=jsonb_set(data, '{execution}', ${sql.json(historicalExecution)}) WHERE kind='run' AND id=${implementation.id}`;
      checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${implementation.id}/complete`, headers, payload: { generation: claim.run.generation, threadId: `implementation-thread-${mode}-${suffix}` } }));

      const originalImplementation = (await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${implementation.id}`)[0]?.data;

      const completionWakeRows = await sql`SELECT data FROM wb_records WHERE kind='run' AND project_id=${project.id} AND data->>'kind'='master' AND data->>'prompt' LIKE ${`%Assigned implementation run ${implementation.id} finished%`}`;
      expect(completionWakeRows).toHaveLength(1);
      const completionWake = completionWakeRows[0]!.data;
      expect(completionWake).toMatchObject({ kind: 'master', projectId: project.id, status: 'queued', targetConnectorId: host.connectorId, execution: { connectorId: host.connectorId, ...(legacy ? {} : { connectionId: connection.id }) } });
      const masterClaim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master'] } } }));
      expect(masterClaim.run).toMatchObject({ id: completionWake.id, kind: 'master', projectId: project.id, targetConnectorId: host.connectorId, execution: { connectorId: host.connectorId, ...(legacy ? {} : { connectionId: connection.id }) } });
      expect(masterClaim.run.threadId).toBeUndefined();
      const bridge = checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${masterClaim.run.id}/bridge-token`, headers, payload: { generation: masterClaim.run.generation } })).token;
      const review = checked(await app.inject({
        method: 'POST', url: `/api/workbench/connector/runs/${masterClaim.run.id}/tools`,
        headers: { authorization: `Bearer ${bridge}` },
        payload: { generation: masterClaim.run.generation, action: 'dispatch', input: { workId: work.id, kind: 'review', model: 'gpt-6.1-sol', reasoning: 'high', prompt: 'Review the recorded candidate with review settings' }, requestId: `cross-kind-review-${mode}-${suffix}` }
      }));

      expect(review.reviewBinding).toMatchObject({candidateRunId:implementation.id,commitSha:'c'.repeat(40),candidateFingerprint:'d'.repeat(64),diffArtifactId:diffArtifact.id,diffRevision:`cross-kind-candidate-${mode}-${suffix}`,qaArtifactIds:[qaArtifact.id]});
      expect(review).toMatchObject({ kind: 'review', workId: work.id, model: 'gpt-6.1-sol', reasoning: 'high', targetRevision: `cross-kind-candidate-${mode}-${suffix}`, targetRunId: implementation.id, targetConnectorId: host.connectorId, execution: { provider: 'openai', method: 'codex-host', connectorId: host.connectorId, model: 'gpt-6.1-sol', skills: [], tools: [] } });
      expect(review.threadId).toBeUndefined();
      expect(review.execution.connectionId).toBe(legacy ? undefined : connection.id);
      expect(review.execution.profileId).toBeUndefined();
      expect(review.execution.profile).toBeUndefined();
      expect(review.execution.skills).not.toContainEqual(expect.objectContaining({ id: skill.id }));
      expect((await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${implementation.id}`)[0]?.data).toEqual(originalImplementation);
      expect((await sql`SELECT data FROM wb_records WHERE kind='work' AND id=${work.id}`)[0]?.data.connectionId).toBe(legacy ? undefined : connection.id);
    }
  });

  it('rejects unavailable, disabled, deleted, revoked, or model-incompatible selections without fallback', async () => {
    const project = await makeProject('Provider failure states');
    const selectedConnector = await enrollFixtureConnector('selected', project.id, ['gpt-6-luna']);
    const selected = await addConnection(selectedConnector.connectorId, 'Selected connection');
    const fallbackConnector = await enrollFixtureConnector('fallback', project.id, ['gpt-6.1-sol']);
    await addConnection(fallbackConnector.connectorId, 'Fallback connection');
    const work = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Pinned unavailable Work', connectionId: selected.id }));
    const disabled = checked(await user('PATCH', `/settings/${selected.id}`, { data: { enabled: false } }));
    expect(disabled.data.enabled).toBe(false);
    const refused = await user('POST', `/projects/${project.id}/messages`, { text: 'Must not route elsewhere', workId: work.id, requestId: `disabled-${suffix}` });
    expect(refused.statusCode).toBe(409);
    expect((await user('GET', '/snapshot')).json().runs).not.toEqual(expect.arrayContaining([expect.objectContaining({ workId: work.id })]));

    await user('PATCH', `/settings/${selected.id}`, { data: { enabled: true } });
    const profile = checked(await user('POST', '/settings', { kind: 'profile', name: 'Unsupported model', data: { model: 'gpt-6.1-sol', reasoning: 'medium', skillIds: [], tools: [] } }));
    settingIds.push(profile.id);
    const incompatible = await user('POST', `/projects/${project.id}/works`, { title: 'Model unavailable', connectionId: selected.id, profileId: profile.id });
    expect(incompatible.statusCode).toBe(409);

    const revokedWork = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Grant revoked Work', connectionId: selected.id }));
    await sql`UPDATE wb_connectors SET project_ids='[]'::jsonb WHERE id=${selectedConnector.connectorId}`;
    const revoked = await user('POST', `/projects/${project.id}/messages`, { text: 'Grant revoked', workId: revokedWork.id, requestId: `revoked-${suffix}` });
    expect(revoked.statusCode).toBe(403);

    await sql`UPDATE wb_connectors SET project_ids=${sql.json([project.id])},last_seen=now() WHERE id=${selectedConnector.connectorId}`;
    const disconnectedWork = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Disconnected Work', connectionId: selected.id }));
    await sql`UPDATE wb_connectors SET last_seen=now()-interval '10 minutes' WHERE id=${selectedConnector.connectorId}`;
    const disconnected = await user('POST', `/projects/${project.id}/messages`, { text: 'Disconnected connection', workId: disconnectedWork.id, requestId: `offline-${suffix}` });
    expect(disconnected.statusCode).toBe(409);
    expect(checked(await user('GET', '/snapshot')).providerConnections).toEqual(expect.arrayContaining([expect.objectContaining({ id: selected.id, status: 'offline' })]));

    await sql`DELETE FROM wb_records WHERE id=${selected.id} AND kind='setting'`;
    const deleted = await user('POST', `/projects/${project.id}/messages`, { text: 'Deleted connection', workId: work.id, requestId: `deleted-${suffix}` });
    expect(deleted.statusCode).toBe(409);
    expect((await user('POST', '/settings', { kind: 'provider', name: 'Unsupported arbitrary credentials', data: { provider: 'openai', method: 'codex-host', connectorId: fallbackConnector.connectorId, apiKey: 'never-store-this' } })).statusCode).toBe(400);
  });

  it('rejects contradictory historical identities before continuing either Work or Project Master', async () => {
    for (const surface of ['work', 'master'] as const) {
      const project = await makeProject(`Contradictory ${surface}`);
      const original = await enrollFixtureConnector(`contradictory-${surface}-original`, project.id);
      const other = await enrollFixtureConnector(`contradictory-${surface}-other`, project.id);
      const connection = await addConnection(original.connectorId);
      const otherConnection = await addConnection(other.connectorId);
      const profile = checked(await user('POST', '/settings', { kind: 'profile', name: 'Historical snapshot', data: { model: 'gpt-6-luna', reasoning: 'high', skillIds: [], tools: [] } }));
      settingIds.push(profile.id);
      const work = surface === 'work' ? checked(await user('POST', `/projects/${project.id}/works`, { title: 'Historical Work', profileId: profile.id, connectionId: connection.id })) : undefined;
      const seed = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Seed history', workId: work?.id, connectionId: work ? undefined : connection.id, requestId: `history-${surface}-${suffix}` })).run;
      const recorded = { ...seed, status: 'completed', connectorId: original.connectorId, threadId: `historical-${surface}-thread-${suffix}`, execution: { ...seed.execution, profileId: profile.id, profile: { id: profile.id, name: profile.name, data: profile.data } } };
      const variants = [
        { label: 'connector', record: { ...recorded, connectorId: other.connectorId, targetConnectorId: other.connectorId } },
        { label: 'target', record: { ...recorded, targetConnectorId: other.connectorId } },
        { label: 'model', record: { ...recorded, execution: { ...recorded.execution, model: recorded.model === 'gpt-6-luna' ? 'gpt-6.1-sol' : 'gpt-6-luna' } } },
        { label: 'profile', record: { ...recorded, execution: { ...recorded.execution, profileId: `different-${profile.id}` } } },
        { label: 'provider', record: { ...recorded, execution: { ...recorded.execution, provider: 'unsupported' } } },
        { label: 'method', record: { ...recorded, execution: { ...recorded.execution, method: 'unsupported' } } },
        { label: 'connection', record: { ...recorded, execution: { ...recorded.execution, connectionId: otherConnection.id } } }
      ];
      if (work) variants.push({ label: 'work-profile', record: { ...recorded, execution: { ...recorded.execution, profileId: `different-${profile.id}`, profile: { ...recorded.execution.profile, id: `different-${profile.id}` } } } });
      for (const variant of variants) {
        await sql`UPDATE wb_records SET data=${sql.json(variant.record)} WHERE kind='run' AND id=${seed.id}`;
        const before = await sql`SELECT id,kind,data FROM wb_records WHERE project_id=${project.id} ORDER BY id`;
        const requestId = `reject-${surface}-${variant.label}-${suffix}`;
        const response = await user('POST', `/projects/${project.id}/messages`, { text: 'Do not normalize history', workId: work?.id, requestId });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.body).toMatch(/frozen|identity|unsupported/i);
        expect(await sql`SELECT id,kind,data FROM wb_records WHERE project_id=${project.id} ORDER BY id`).toEqual(before);
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`message:${project.id}`} AND request_id=${requestId}`).toHaveLength(0);
      }
      // Absence of new fields is valid historical proof, unlike contradiction.
      // Keep the recorded profile/skills/tools and native model independent of today's defaults.
      const legacy = { ...recorded, execution: { ...recorded.execution, legacy: true, skills: [{ id: `frozen-skill-${suffix}`, name: 'Frozen skill', content: 'Historical instructions' }], tools: [] } };
      delete legacy.execution.connectionId;
      delete legacy.execution.connectorId;
      delete legacy.execution.model;
      if (work) await sql`UPDATE wb_records SET data=data-'connectionId' WHERE kind='work' AND id=${work.id}`;
      await sql`UPDATE wb_records SET data=${sql.json(legacy)} WHERE kind='run' AND id=${seed.id}`;
      checked(await user('PATCH', `/settings/${otherConnection.id}`, { data: { default: true } }));
      checked(await user('PATCH', `/settings/${profile.id}`, { name: 'Current profile changed', data: { model: 'gpt-6.1-sol', reasoning: 'low' } }));
      const next = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Continue proven legacy identity', workId: work?.id, requestId: `valid-legacy-${surface}-${suffix}` })).run;
      expect(next).toMatchObject({ threadId: legacy.threadId, targetConnectorId: original.connectorId, model: legacy.model, reasoning: legacy.reasoning, execution: { ...legacy.execution, connectorId: original.connectorId, model: legacy.model } });
      expect(next.execution.connectionId).toBeUndefined();
      expect((await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${seed.id}`)[0]?.data).toEqual(legacy);
      const claim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${original.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: [surface === 'work' ? 'implementation' : 'master'] } } }));
      expect(claim.run).toMatchObject({ id: next.id, connectorId: original.connectorId, targetConnectorId: original.connectorId, threadId: legacy.threadId, model: legacy.model, generation: 1, execution: next.execution });
      checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${next.id}/complete`, headers: { authorization: `Bearer ${original.token}` }, payload: { generation: claim.run.generation, threadId: legacy.threadId } }));
    }
  });

  it('fences a completion wake when Project Master history contradicts its native Connector', async () => {
    const project = await makeProject('Contradictory wake');
    const original = await enrollFixtureConnector('wake-original', project.id);
    const other = await enrollFixtureConnector('wake-other', project.id);
    const connection = await addConnection(original.connectorId);
    const master = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Seed Project Master', connectionId: connection.id, requestId: `wake-history-${suffix}` })).run;
    const contradiction = { ...master, status: 'completed', connectorId: other.connectorId, targetConnectorId: other.connectorId, threadId: `other-native-thread-${suffix}` };
    await sql`UPDATE wb_records SET data=${sql.json(contradiction)} WHERE kind='run' AND id=${master.id}`;
    const work = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Wake must not migrate Master', connectionId: connection.id }));
    const implementation = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Finish Work', workId: work.id, requestId: `wake-work-${suffix}` })).run;
    const claim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${original.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['implementation'] } } }));
    expect(claim.run.id).toBe(implementation.id);
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${implementation.id}/complete`, headers: { authorization: `Bearer ${original.token}` }, payload: { generation: claim.run.generation, threadId: `work-thread-${suffix}` } }));
    const wakes = await sql`SELECT data FROM wb_records WHERE kind='run' AND project_id=${project.id} AND data->>'kind'='master' AND id<>${master.id}`;
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.data).toMatchObject({ status: 'failed', error: expect.stringContaining('Frozen Connector identity mismatch') });
    expect(wakes[0]?.data.threadId).toBeUndefined();
    expect((await sql`SELECT data FROM wb_records WHERE id=${master.id}`)[0]?.data).toEqual(contradiction);
    expect((await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${original.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master'] } } })).statusCode).toBe(204);
    const followup = await user('POST', `/projects/${project.id}/messages`, { text: 'Contradictory native identity must stay fenced', requestId: `wake-history-followup-${suffix}` });
    expect(followup.statusCode, followup.body).toBe(409);
    expect((await sql`SELECT data FROM wb_records WHERE id=${master.id}`)[0]?.data).toEqual(contradiction);
  });

  it('keeps queued no-thread Master affinity across a failed B completion wake', async () => {
    const project = await makeProject('Queued Master wake affinity');
    const connectorA = await enrollFixtureConnector('queued-master-a', project.id);
    const connectorB = await enrollFixtureConnector('queued-master-b', project.id);
    const connectionA = await addConnection(connectorA.connectorId, 'Frozen Master A');
    const connectionB = await addConnection(connectorB.connectorId, 'Workspace default B');
    checked(await user('PATCH', `/settings/${connectionB.id}`, { data: { default: true } }));
    const skill = checked(await user('POST', '/settings', { kind: 'skill', name: 'Frozen Master skill', data: { content: 'Preserve this historical skill' } }));
    settingIds.push(skill.id);
    const profile = checked(await user('POST', '/settings', { kind: 'profile', name: 'Frozen Master profile', data: { model: 'gpt-6.1-sol', reasoning: 'high', skillIds: [skill.id], tools: [] } }));
    settingIds.push(profile.id);

    const seededMaster = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Queue Master on A', connectionId: connectionA.id, requestId: `queued-master-a-${suffix}` })).run;
    const master = { ...seededMaster, model: 'gpt-6.1-sol', reasoning: 'high', execution: { ...seededMaster.execution, model: 'gpt-6.1-sol', profileId: profile.id, profile: { id: profile.id, name: profile.name, data: profile.data }, skills: [{ id: skill.id, name: skill.name, content: String(skill.data.content) }], tools: ['read_context'] } };
    await sql`UPDATE wb_records SET data=${sql.json(master)} WHERE kind='run' AND id=${master.id}`;
    const originalMaster = (await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${master.id}`)[0]?.data;
    expect(master).toMatchObject({ status: 'queued', targetConnectorId: connectorA.connectorId, execution: { connectionId: connectionA.id, connectorId: connectorA.connectorId } });
    expect(master.threadId).toBeUndefined();

    const work = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Explicit B work', connectionId: connectionB.id }));
    const implementation = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Complete B work', workId: work.id, requestId: `queued-master-work-${suffix}` })).run;
    const bHeaders = { authorization: `Bearer ${connectorB.token}` };
    const claim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: bHeaders, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['implementation'] } } }));
    expect(claim.run.id).toBe(implementation.id);
    // Claim B while A is still valid. The claim endpoint also fences every queued
    // run, so taking A offline before this claim tests that separate code path.
    await sql`UPDATE wb_connectors SET last_seen=now()-interval '10 minutes' WHERE id=${connectorA.connectorId}`;
    const completion = await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${implementation.id}/complete`, headers: bHeaders, payload: { generation: claim.run.generation, threadId: `work-b-thread-${suffix}` } });
    expect(completion.statusCode, completion.body).toBe(200);
    expect(completion.json()).toMatchObject({ status: 'completed', threadId: `work-b-thread-${suffix}` });
    expect(completion.json().execution).toEqual(claim.run.execution);
    expect(completion.json().model).toBe(claim.run.model);
    expect(completion.json().connectorId).toBe(connectorB.connectorId);
    expect(completion.json().targetConnectorId).toBe(connectorB.connectorId);
    expect(completion.json().generation).toBe(claim.run.generation);
    expect((await sql`SELECT data->>'status' AS status FROM wb_records WHERE kind='run' AND id=${implementation.id}`).at(0)?.status).toBe('completed');

    const wakeRow = (await sql`SELECT data FROM wb_records WHERE kind='run' AND project_id=${project.id} AND data->>'kind'='master' AND id<>${master.id}`)[0];
    expect(wakeRow?.data).toMatchObject({ status: 'failed', causedByRunId: implementation.id, error: expect.stringContaining('Selected Connector is offline') });
    expect(wakeRow?.data.targetConnectorId).toBeUndefined();
    expect(wakeRow?.data.execution).toBeUndefined();
    expect(wakeRow?.data.threadId).toBeUndefined();

    const beforeMarkedAttempt = await sql`SELECT id,kind,data FROM wb_records WHERE project_id=${project.id} ORDER BY id`;
    const markedFollowupRequest = `queued-master-marked-followup-${suffix}`;
    const markedFollowup = await user('POST', `/projects/${project.id}/messages`, { text: 'Marked diagnostic cannot become affinity', requestId: markedFollowupRequest });
    expect(markedFollowup.statusCode, markedFollowup.body).toBe(409);
    expect(await sql`SELECT id,kind,data FROM wb_records WHERE project_id=${project.id} ORDER BY id`).toEqual(beforeMarkedAttempt);
    expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`message:${project.id}`} AND request_id=${markedFollowupRequest}`).toHaveLength(0);

    // Recreate the pre-fix persisted diagnostic shape, including its misleading B affinity.
    const legacyWake = { ...wakeRow?.data, targetConnectorId: connectorB.connectorId, execution: { provider: 'openai', method: 'codex-host', connectionId: connectionB.id, connectorId: connectorB.connectorId, model: 'gpt-6.1-sol', legacy: false, skills: [], tools: [] } };
    delete legacyWake.causedByRunId;
    await sql`UPDATE wb_records SET data=${sql.json(legacyWake)} WHERE kind='run' AND id=${wakeRow?.data.id}`;

    const beforeLegacyAttempt = await sql`SELECT id,kind,data FROM wb_records WHERE project_id=${project.id} ORDER BY id`;
    const legacyFollowupRequest = `queued-master-followup-offline-${suffix}`;
    const unavailableFollowup = await user('POST', `/projects/${project.id}/messages`, { text: 'Must remain on unavailable A', requestId: legacyFollowupRequest });
    expect(unavailableFollowup.statusCode, unavailableFollowup.body).toBe(409);
    expect(unavailableFollowup.body).toMatch(/offline|unavailable/i);
    expect(await sql`SELECT id,kind,data FROM wb_records WHERE project_id=${project.id} ORDER BY id`).toEqual(beforeLegacyAttempt);
    expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`message:${project.id}`} AND request_id=${legacyFollowupRequest}`).toHaveLength(0);
    expect((await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${master.id}`)[0]?.data).toEqual(originalMaster);
    expect(await sql`SELECT id FROM wb_records WHERE project_id=${project.id} AND kind='run' AND data->>'kind'='master' AND data->>'status'='queued' AND data->>'targetConnectorId'=${connectorB.connectorId}`).toHaveLength(0);

    checked(await user('PATCH', `/settings/${profile.id}`, { name: 'Changed after historical snapshot', data: { model: 'gpt-6-luna', reasoning: 'low', skillIds: [], tools: [] } }));
    await sql`UPDATE wb_connectors SET last_seen=now() WHERE id=${connectorA.connectorId}`;
    const resumed = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Resume on original A', requestId: `queued-master-followup-online-${suffix}` })).run;
    expect(resumed).toMatchObject({ status: 'queued', targetConnectorId: connectorA.connectorId, model: master.model, reasoning: 'high', execution: { connectionId: connectionA.id, connectorId: connectorA.connectorId, model: master.model, profileId: profile.id, profile: { id: profile.id }, skills: [{ id: skill.id, name: skill.name, content: 'Preserve this historical skill' }], tools: ['read_context'] } });
    expect(resumed.execution).toEqual(master.execution);
    expect(resumed.reasoning).toBe(master.reasoning);
    expect(resumed.threadId).toBeUndefined();
    expect((await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${master.id}`)[0]?.data).toEqual(originalMaster);
    expect((await sql`SELECT data FROM wb_records WHERE kind='setting' AND id=${connectionB.id}`)[0]?.data).toMatchObject({ data: { default: true } });
  });

  it('fails an offline queued Master during Connector claim without changing its frozen snapshot', async () => {
    const project = await makeProject('Claim fences offline historical Master');
    const connectorA = await enrollFixtureConnector('claim-offline-master-a', project.id);
    const connectorB = await enrollFixtureConnector('claim-offline-master-b', project.id);
    const connectionA = await addConnection(connectorA.connectorId, 'Claim Master A');
    const connectionB = await addConnection(connectorB.connectorId, 'Claim Work B');
    const skill = checked(await user('POST', '/settings', { kind: 'skill', name: 'Claim snapshot skill', data: { content: 'Frozen claim-time skill' } }));
    settingIds.push(skill.id);
    const profile = checked(await user('POST', '/settings', { kind: 'profile', name: 'Claim snapshot profile', data: { model: 'gpt-6.1-sol', reasoning: 'high', skillIds: [skill.id], tools: [] } }));
    settingIds.push(profile.id);
    const seeded = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Keep this queued on A', connectionId: connectionA.id, requestId: `claim-master-a-${suffix}` })).run;
    const master = { ...seeded, model: 'gpt-6.1-sol', reasoning: 'high', execution: { ...seeded.execution, model: 'gpt-6.1-sol', profileId: profile.id, profile: { id: profile.id, name: profile.name, data: profile.data }, skills: [{ id: skill.id, name: skill.name, content: String(skill.data.content) }], tools: ['read_context'] } };
    await sql`UPDATE wb_records SET data=${sql.json(master)} WHERE kind='run' AND id=${master.id}`;
    const original = (await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${master.id}`)[0]?.data;
    const work = checked(await user('POST', `/projects/${project.id}/works`, { title: 'B work eligible for claim', connectionId: connectionB.id }));
    const bRun = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Queue work on B', workId: work.id, requestId: `claim-work-b-${suffix}` })).run;
    await sql`UPDATE wb_connectors SET last_seen=now()-interval '10 minutes' WHERE id=${connectorA.connectorId}`;

    const claim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${connectorB.token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['implementation'] } } }));
    expect(claim.run.id).toBe(bRun.id);
    const after = (await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${master.id}`)[0]?.data;
    expect(after).toMatchObject({ status: 'failed', error: expect.stringContaining('Selected Connector is offline'), targetConnectorId: connectorA.connectorId, model: master.model, reasoning: master.reasoning, execution: master.execution });
    expect({ ...after, status: original.status, error: original.error, updatedAt: original.updatedAt }).toEqual(original);
    expect(await sql`SELECT id FROM wb_records WHERE kind='run' AND data->>'targetConnectorId'=${connectorB.connectorId} AND data->>'kind'='master'`).toHaveLength(0);
  });

  it('retains affinity from a genuine failed Master run without a native thread', async () => {
    const project = await makeProject('Failed Master affinity');
    const connectorA = await enrollFixtureConnector('failed-master-a', project.id);
    const connectorB = await enrollFixtureConnector('failed-master-b', project.id);
    const connectionA = await addConnection(connectorA.connectorId, 'Failed Master A');
    const connectionB = await addConnection(connectorB.connectorId, 'Default B after Master failure');
    checked(await user('PATCH', `/settings/${connectionB.id}`, { data: { default: true } }));
    const master = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Start on A', connectionId: connectionA.id, requestId: `failed-master-seed-${suffix}` })).run;
    const aHeaders = { authorization: `Bearer ${connectorA.token}` };
    const claim = checked(await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: aHeaders, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['master'] } } }));
    expect(claim.run.id).toBe(master.id);
    await sql`UPDATE wb_connectors SET last_seen=now()-interval '10 minutes' WHERE id=${connectorA.connectorId}`;
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${master.id}/complete`, headers: aHeaders, payload: { generation: claim.run.generation, error: 'Genuine Master execution failure' } }));
    const failed = (await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${master.id}`)[0]?.data;
    expect(failed).toMatchObject({ status: 'failed', generation: 1, targetConnectorId: connectorA.connectorId, execution: { connectionId: connectionA.id, connectorId: connectorA.connectorId } });
    expect(failed.threadId).toBeUndefined();

    const followup = await user('POST', `/projects/${project.id}/messages`, { text: 'Do not route genuine failure to default B', requestId: `failed-master-followup-${suffix}` });
    expect(followup.statusCode, followup.body).toBe(409);
    expect(followup.body).toMatch(/offline|unavailable/i);
    expect((await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${master.id}`)[0]?.data).toEqual(failed);
    expect((await sql`SELECT data FROM wb_records WHERE kind='setting' AND id=${connectionB.id}`)[0]?.data).toMatchObject({ data: { default: true } });
  });

  it('preserves queued, running, paused, and native-thread connector affinity across default changes', async () => {
    const project = await makeProject('Provider affinity');
    const originalConnector = await enrollFixtureConnector('original-affinity', project.id);
    const newConnector = await enrollFixtureConnector('new-affinity', project.id);
    const original = await addConnection(originalConnector.connectorId, 'Original Codex');
    const replacement = await addConnection(newConnector.connectorId, 'Replacement Codex');
    const legacyExecution = { provider: 'openai', method: 'codex-host', legacy: true, skills: [], tools: [] };
    const pausedWork = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Historical paused Work', connectionId: original.id }));
    const pausedRun = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Pause historical run', workId: pausedWork.id, requestId: `legacy-paused-${suffix}` })).run;
    checked(await user('POST', `/runs/${pausedRun.id}/pause`, {}));
    await sql`UPDATE wb_records SET data=data-'connectionId' WHERE id=${pausedWork.id} AND kind='work'`;
    const pausedNativeThread = `paused-native-${suffix}`;
    await sql`UPDATE wb_records SET data=(data-'execution') || ${sql.json({ connectorId: originalConnector.connectorId, threadId: pausedNativeThread, execution: { ...legacyExecution, model: pausedRun.model, connectorId: originalConnector.connectorId } })} WHERE id=${pausedRun.id} AND kind='run'`;

    const work = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Historical running Work', connectionId: original.id }));
    const first = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Start legacy run', workId: work.id, requestId: `legacy-running-${suffix}` })).run;
    await sql`UPDATE wb_records SET data=data-'connectionId' WHERE id=${work.id} AND kind='work'`;
    const nativeThread = `native-thread-${suffix}`;
    await sql`UPDATE wb_records SET data=(data-'execution') || ${sql.json({ connectorId: originalConnector.connectorId, threadId: nativeThread, execution: { ...legacyExecution, model: first.model, connectorId: originalConnector.connectorId } })} WHERE id=${first.id} AND kind='run'`;

    const frozenRows = await sql`SELECT id,data->'execution' AS execution,data->>'model' AS model,data->>'connectorId' AS connector_id,data->>'targetConnectorId' AS target_connector_id,data->>'threadId' AS thread_id FROM wb_records WHERE kind='run' AND id=ANY(${[pausedRun.id, first.id]}) ORDER BY id`;
    const frozenBeforeResume = new Map(frozenRows.map(row => [String(row.id), {
      execution: row.execution,
      model: String(row.model),
      connectorId: String(row.connector_id),
      targetConnectorId: String(row.target_connector_id),
      threadId: String(row.thread_id)
    }]));

    checked(await user('PATCH', `/settings/${replacement.id}`, { data: { default: true } }));
    expect((await user('GET', '/snapshot')).json().runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pausedRun.id, status: 'paused', execution: expect.objectContaining({ legacy: true, connectorId: originalConnector.connectorId }) }),
      expect.objectContaining({ id: first.id, status: 'queued', execution: expect.objectContaining({ legacy: true, connectorId: originalConnector.connectorId }) })
    ]));
    const claim = (token: string) => app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${token}` }, payload: { capabilities: { codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], runKinds: ['implementation'] } } });
    expect((await claim(newConnector.token)).statusCode).toBe(204);
    const resumed = checked(await user('POST', `/runs/${pausedRun.id}/resume`, {}));
    expect(resumed).toMatchObject({ status: 'queued', execution: { legacy: true, connectorId: originalConnector.connectorId } });
    const claimed = [] as any[];
    for (let index = 0; index < 2; index++) {
      const next = checked(await claim(originalConnector.token));
      expect([pausedRun.id, first.id]).toContain(next.run.id);
      const frozen = frozenBeforeResume.get(next.run.id)!;
      expect(next.run).toMatchObject({ id: next.run.id, targetConnectorId: frozen.targetConnectorId, connectorId: originalConnector.connectorId, model: frozen.model, threadId: frozen.threadId, status: 'running', generation: 1 });
      expect(next.run.execution).toEqual(frozen.execution);
      expect(next.execution).toEqual(frozen.execution);
      expect(next.execution).toMatchObject({ legacy: true, connectorId: originalConnector.connectorId, model: frozen.model });
      expect(next.execution.connectionId).toBeUndefined();
      claimed.push(next);
      if (next.run.id === pausedRun.id)
        checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${next.run.id}/complete`, headers: { authorization: `Bearer ${originalConnector.token}` }, payload: { generation: next.run.generation, threadId: pausedNativeThread } }));
    }
    expect(claimed.map(item => item.run.id).sort()).toEqual([pausedRun.id, first.id].sort());
    expect((await claim(originalConnector.token)).statusCode).toBe(204);
    const claimedPaused = claimed.find(item => item.run.id === pausedRun.id)!;
    const claimedRunning = claimed.find(item => item.run.id === first.id)!;
    expect(claimedPaused.run.generation).toBe(1);
    expect((await sql`SELECT data->>'threadId' AS thread_id FROM wb_records WHERE id=${pausedRun.id}`).at(0)?.thread_id).toBe(pausedNativeThread);
    const generation = claimedRunning.run.generation;
    const connectorPath = `/api/workbench/connector/runs/${first.id}`;
    const connectorHeaders = { authorization: `Bearer ${originalConnector.token}` };
    expect((await app.inject({ method: 'GET', url: connectorPath, headers: connectorHeaders })).statusCode).toBe(200);

    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: true, models: ['gpt-6-luna', 'gpt-6.1-sol'] })} WHERE id=${originalConnector.connectorId}`;
    expect((await app.inject({ method: 'GET', url: connectorPath, headers: connectorHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${connectorPath}/renew`, headers: connectorHeaders, payload: { generation } })).statusCode).toBe(200);
    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: false, localWorktrees: false, models: ['gpt-6-luna', 'gpt-6.1-sol'] })} WHERE id=${originalConnector.connectorId}`;
    expect((await app.inject({ method: 'GET', url: connectorPath, headers: connectorHeaders })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `${connectorPath}/renew`, headers: connectorHeaders, payload: { generation } })).statusCode).toBe(409);
    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: true, localWorktrees: true, models: [] })} WHERE id=${originalConnector.connectorId}`;
    expect((await app.inject({ method: 'GET', url: connectorPath, headers: connectorHeaders })).statusCode).toBe(409);
    const evidence = await app.inject({ method: 'POST', url: `${connectorPath}/events`, headers: connectorHeaders, payload: { generation, events: [{ id: `evidence-${suffix}`, type: 'agent_message', text: 'Fenced completion evidence', threadId: `native-thread-${suffix}` }] } });
    expect(evidence.statusCode).toBe(200);
    const completed = await app.inject({ method: 'POST', url: `${connectorPath}/complete`, headers: connectorHeaders, payload: { generation, threadId: nativeThread } });
    expect(completed.statusCode).toBe(200);

    await sql`UPDATE wb_connectors SET capabilities=${sql.json({ codexAppServer: true, localWorktrees: true, models: ['gpt-6-luna', 'gpt-6.1-sol'] })} WHERE id=${originalConnector.connectorId}`;
    const continuation = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Continue original native thread', workId: work.id, requestId: `legacy-native-next-${suffix}` })).run;
    expect(continuation).toMatchObject({ targetConnectorId: originalConnector.connectorId, threadId: nativeThread, execution: { legacy: true, connectorId: originalConnector.connectorId, model: first.model } });
    const continued = checked(await claim(originalConnector.token));
    expect(continued.run.id).toBe(continuation.id);
    expect(continued.run).toMatchObject({ targetConnectorId: originalConnector.connectorId, connectorId: originalConnector.connectorId, threadId: nativeThread, model: first.model, execution: frozenBeforeResume.get(first.id)!.execution });
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${continuation.id}/complete`, headers: { authorization: `Bearer ${originalConnector.token}` }, payload: { generation: continued.run.generation, threadId: nativeThread } }));

    const pausedContinuation = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'Continue paused native thread', workId: pausedWork.id, requestId: `legacy-paused-next-${suffix}` })).run;
    expect(pausedContinuation).toMatchObject({ targetConnectorId: originalConnector.connectorId, threadId: pausedNativeThread, model: pausedRun.model, execution: frozenBeforeResume.get(pausedRun.id)!.execution });
    const pausedContinued = checked(await claim(originalConnector.token));
    expect(pausedContinued.run).toMatchObject({ id: pausedContinuation.id, targetConnectorId: originalConnector.connectorId, connectorId: originalConnector.connectorId, threadId: pausedNativeThread, model: pausedRun.model, execution: frozenBeforeResume.get(pausedRun.id)!.execution });
    checked(await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${pausedContinuation.id}/complete`, headers: { authorization: `Bearer ${originalConnector.token}` }, payload: { generation: pausedContinued.run.generation, threadId: pausedNativeThread } }));

    const orphanWork = checked(await user('POST', `/projects/${project.id}/works`, { title: 'Legacy run without recorded Connector identity' }));
    const orphan = checked(await user('POST', `/projects/${project.id}/messages`, { text: 'No historical identity', workId: orphanWork.id, requestId: `legacy-orphan-${suffix}` })).run;
    await sql`UPDATE wb_records SET data=data-'connectionId' WHERE id=${orphanWork.id} AND kind='work'`;
    await sql`UPDATE wb_records SET data=(data-'execution'-'targetConnectorId'-'connectorId') || ${sql.json({ execution: { provider: 'openai', method: 'codex-host', legacy: true, model: orphan.model, skills: [], tools: [] } })} WHERE id=${orphan.id} AND kind='run'`;
    expect((await claim(newConnector.token)).statusCode).toBe(204);
    expect((await claim(originalConnector.token)).statusCode).toBe(204);
    expect((await sql`SELECT data->>'status' AS status,data->>'targetConnectorId' AS target FROM wb_records WHERE id=${orphan.id}`).at(0)).toMatchObject({ status: 'queued', target: null });
    expect((await user('GET', '/snapshot')).json().runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: orphan.id, status: 'queued', error: expect.stringContaining('Historical Connector identity'), execution: expect.objectContaining({ legacy: true }) })]));
  });
});
