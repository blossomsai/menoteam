import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp, createDashboardToken, verifyDashboardToken } from '../src/server/app.js';
import { createMcpServer } from '../src/server/mcp.js';
import { InMemoryWorkMapRepository } from '../src/db/in-memory-repository.js';
import type { WorkMapRepository } from '../src/domain/repository.js';

const apiKey = 'test-api-key';

describe('Work Map backend public seams', () => {
  let repository: WorkMapRepository;

  beforeEach(() => {
    repository = new InMemoryWorkMapRepository();
  });

  afterEach(async () => {
    await repository.close();
  });

  it('signs stateless dashboard tokens with an expiry and rejects malformed or rotated credentials', () => {
    const now = Date.parse('2026-08-27T12:00:00.000Z');
    const token = createDashboardToken('dashboard-secret', now);

    expect(token).toMatch(/^v1\.[1-9]\d{0,9}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);
    expect(verifyDashboardToken(token, 'dashboard-secret', now)).toBe(true);
    // A replica whose clock is five seconds behind must accept a freshly signed token.
    expect(verifyDashboardToken(token, 'dashboard-secret', now - 5_000)).toBe(true);
    expect(verifyDashboardToken(token.slice(0, -1), 'dashboard-secret', now)).toBe(false);
    expect(verifyDashboardToken(`${token}.extra`, 'dashboard-secret', now)).toBe(false);
    expect(verifyDashboardToken(token, 'rotated-dashboard-secret', now)).toBe(false);
    expect(verifyDashboardToken(token, 'dashboard-secret', now + 8 * 60 * 60 * 1_000 + 1)).toBe(false);
  });

  it('reports health through the Fastify endpoint', async () => {
    const app = await createApp({ repository, apiKey });
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'menoteam-work-map' });
    await app.close();
  });

  it('lists deterministic work and teammate summaries with filters and cursors', async () => {
    const client = await connectClient(repository);
    const teammate = await call(client, 'update_teammate', {
      ref: 'teammate_alice',
      expected_revision: 0,
      changes: { display_name: 'Alice', default_agent_addresses: { slack: '@alice' }, memory: 'Owns backend reliability.' },
    });
    expect(teammate.teammate.revision).toBe(1);

    await call(client, 'create_work', {
      title: 'API reliability', owner: 'teammate_alice', state: 'current', current_summary: 'Keep APIs reliable.', living_doc_markdown: '# API reliability\n',
    });
    await call(client, 'create_work', {
      title: 'Dashboard', owner: 'teammate_alice', state: 'completed', current_summary: 'Read-only view.', living_doc_markdown: '# Dashboard\n',
    });

    const page = await call(client, 'list', { kind: 'work', filters: { owner: 'teammate_alice' }, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total_count).toBe(2);
    expect(page.items[0]).toMatchObject({ title: 'API reliability', owner: 'teammate_alice', state: 'current', revision: 1 });
    expect(page.next_cursor).toEqual(expect.any(String));

    const next = await call(client, 'list', { kind: 'work', filters: { owner: 'teammate_alice' }, limit: 1, cursor: page.next_cursor });
    expect(next.total_count).toBe(2);
    expect(next.items[0].title).toBe('Dashboard');
    await client.close();
  });

  it('searches work and teammate context and read returns the complete entity', async () => {
    const client = await connectClient(repository);
    await call(client, 'update_teammate', {
      ref: 'teammate_alice', expected_revision: 0,
      changes: { display_name: 'Alice', default_agent_addresses: { discord: 'alice#1' }, memory: 'PostgreSQL and incident response.' },
    });
    const created = await call(client, 'create_work', {
      title: 'PostgreSQL recovery', owner: 'teammate_alice', state: 'current', current_summary: 'Restore from verified backups.', living_doc_markdown: '# Recovery\nDocument restore steps.',
    });

    const search = await call(client, 'search', { query: 'PostgreSQL recovery' });
    expect(search.items[0]).toMatchObject({ ref: created.work.ref, kind: 'work', title: 'PostgreSQL recovery' });

    const readWork = await call(client, 'read', { ref: created.work.ref });
    expect(readWork.entity).toMatchObject({ ref: created.work.ref, living_doc_markdown: '# Recovery\nDocument restore steps.', revision: 1 });
    const readTeammate = await call(client, 'read', { ref: 'teammate_alice' });
    expect(readTeammate.entity).toMatchObject({ ref: 'teammate_alice', memory: 'PostgreSQL and incident response.' });
    await client.close();
  });

  it('creates work and its Living Doc atomically at revision one', async () => {
    const client = await connectClient(repository);
    await call(client, 'update_teammate', {
      ref: 'teammate_alice', expected_revision: 0,
      changes: { display_name: 'Alice', default_agent_addresses: {}, memory: '' },
    });
    const result = await call(client, 'create_work', {
      title: 'Ship export', owner: 'teammate_alice', state: 'current', current_summary: 'Provide portable export.', living_doc_markdown: '# Ship export\n',
    });

    expect(result.work).toMatchObject({ title: 'Ship export', owner: 'teammate_alice', owner_source: 'confirmed', owner_evidence: [], revision: 1, living_doc_markdown: '# Ship export\n' });
    await expect(call(client, 'read', { ref: result.work.ref })).resolves.toMatchObject({ entity: { revision: 1 } });
    await client.close();
  });

  it('persists owner provenance through create, list, read, search, and explicit confirmation', async () => {
    const client = await connectClient(repository);
    await call(client, 'update_teammate', { ref: 'teammate_alice', expected_revision: 0, changes: { display_name: 'Alice', default_agent_addresses: {}, memory: '' } });
    const evidence = [{ kind: 'commit', label: 'Added the roster', ref: 'abc1234' }];
    const created = await call(client, 'create_work', {
      title: 'Imported roster', owner: 'teammate_alice', owner_source: 'inferred', owner_evidence: evidence,
      state: 'current', current_summary: 'Imported from repository evidence.', living_doc_markdown: '# Imported roster\n',
    });
    expect(created.work).toMatchObject({ owner_source: 'inferred', owner_evidence: evidence });
    await expect(repository.list('work', {}, undefined, 10)).resolves.toMatchObject({ items: [expect.objectContaining({ owner_source: 'inferred' })] });
    await expect(repository.search('Imported roster', undefined, 10)).resolves.toMatchObject({ items: [expect.objectContaining({ owner_source: 'inferred' })] });
    expect((await repository.list('work', {}, undefined, 10)).items[0]).not.toHaveProperty('owner_evidence');

    const confirmed = await call(client, 'update_work', {
      ref: created.work.ref, expected_revision: 1,
      changes: { owner_source: 'confirmed', owner_evidence: [] },
    });
    expect(confirmed.work).toMatchObject({ owner_source: 'confirmed', owner_evidence: [], revision: 2 });
    await client.close();
  });

  it('clears stale inference when a human owner is directly reassigned', async () => {
    const client = await connectClient(repository);
    await call(client, 'update_teammate', { ref: 'teammate_alice', expected_revision: 0, changes: { display_name: 'Alice', default_agent_addresses: {}, memory: '' } });
    await call(client, 'update_teammate', { ref: 'teammate_bob', expected_revision: 0, changes: { display_name: 'Bob', default_agent_addresses: {}, memory: '' } });
    const created = await call(client, 'create_work', {
      title: 'Reassign owner', owner: 'teammate_alice', owner_source: 'inferred',
      owner_evidence: [{ kind: 'commit', label: 'Alice changed related code' }],
      state: 'current', current_summary: 'Awaiting confirmation.', living_doc_markdown: '# Reassign owner\n',
    });
    const reassigned = await call(client, 'update_work', {
      ref: created.work.ref, expected_revision: 1, changes: { owner: 'teammate_bob' },
    });
    expect(reassigned.work).toMatchObject({ owner: 'teammate_bob', owner_source: 'confirmed', owner_evidence: [] });
    await client.close();
  });

  it('updates work only with the expected revision and rejects stale writes', async () => {
    const client = await connectClient(repository);
    await call(client, 'update_teammate', { ref: 'teammate_alice', expected_revision: 0, changes: { display_name: 'Alice', default_agent_addresses: {}, memory: '' } });
    const created = await call(client, 'create_work', {
      title: 'Concurrency test', owner: 'teammate_alice', state: 'current', current_summary: 'Initial.', living_doc_markdown: '# Initial\n',
    });

    const updated = await call(client, 'update_work', {
      ref: created.work.ref, expected_revision: 1, changes: { current_summary: 'First writer.', living_doc_markdown: '# First writer\n' },
    });
    expect(updated.work.revision).toBe(2);
    const stale = await call(client, 'update_work', {
      ref: created.work.ref, expected_revision: 1, changes: { current_summary: 'Lost writer.' },
    }, false);
    expect(stale).toMatchObject({ error: { code: 'CONFLICT', current_revision: 2 } });
    const current = await call(client, 'read', { ref: created.work.ref });
    expect(current.entity.current_summary).toBe('First writer.');
    await client.close();
  });

  it('updates teammate memory, enforces 200 words, and rejects duplicate identities', async () => {
    const client = await connectClient(repository);
    const first = await call(client, 'update_teammate', {
      ref: 'teammate_alice', expected_revision: 0,
      changes: { display_name: 'Alice', default_agent_addresses: { slack: '@alice' }, memory: 'Owns the backend.' },
    });
    expect(first.teammate.revision).toBe(1);
    const second = await call(client, 'update_teammate', {
      ref: 'teammate_alice', expected_revision: 1,
      changes: { memory: 'Owns the backend and database reliability.' },
    });
    expect(second.teammate.revision).toBe(2);

    const tooLong = Array.from({ length: 201 }, (_, index) => `word${index}`).join(' ');
    const longResult = await call(client, 'update_teammate', {
      ref: 'teammate_alice', expected_revision: 2, changes: { memory: tooLong },
    }, false);
    expect(longResult).toMatchObject({ error: { code: 'VALIDATION' } });

    const duplicate = await call(client, 'update_teammate', {
      ref: 'teammate_bob', expected_revision: 0,
      changes: { display_name: 'Alice', default_agent_addresses: { slack: '@alice' }, memory: '' },
    }, false);
    expect(duplicate).toMatchObject({ error: { code: 'DUPLICATE_IDENTITY' } });
    await client.close();
  });

  it('protects the MCP endpoint with the instance API key', async () => {
    const app = await createApp({ repository, apiKey });
    const response = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('keeps read-only dashboard routes behind a same-origin server-side session', async () => {
    const app = await createApp({ repository, apiKey, dashboardPassword: 'dashboard-secret' });
    const denied = await app.inject({ method: 'GET', url: '/api/teammates' });
    expect(denied.statusCode).toBe(401);

    const crossSiteLogin = await app.inject({
      method: 'POST',
      url: '/api/dashboard/session',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: { password: 'dashboard-secret' },
    });
    expect(crossSiteLogin.statusCode).toBe(403);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/dashboard/session',
      payload: { password: 'wrong-password' },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/dashboard/session',
      payload: { password: 'dashboard-secret' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['cache-control']).toBe('no-store');
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/iu);
    expect(setCookie).toMatch(/SameSite=Strict/iu);
    expect(setCookie).toMatch(/Max-Age=28800/iu);
    expect(setCookie).not.toMatch(/x-dashboard-password|dashboard-secret/iu);
    expect(setCookie).not.toMatch(/; Secure/iu);
    const cookie = setCookie.split(';', 1)[0];

    const legacyHeader = await app.inject({ method: 'GET', url: '/api/teammates', headers: { 'x-dashboard-password': 'dashboard-secret' } });
    expect(legacyHeader.statusCode).toBe(401);
    const crossSiteRead = await app.inject({ method: 'GET', url: '/api/teammates', headers: { cookie, origin: 'https://evil.example' } });
    expect(crossSiteRead.statusCode).toBe(403);
    const allowed = await app.inject({ method: 'GET', url: '/api/teammates', headers: { cookie } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['cache-control']).toBe('no-store');
    const missing = await app.inject({ method: 'GET', url: '/api/entity/work_missing', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'NOT_FOUND' });

    const logout = await app.inject({ method: 'POST', url: '/api/dashboard/session/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['cache-control']).toBe('no-store');
    const clearedCookie = String(logout.headers['set-cookie']);
    expect(clearedCookie).toMatch(/Max-Age=0/iu);
    const afterLogout = await app.inject({ method: 'GET', url: '/api/teammates', headers: { cookie: clearedCookie.split(';', 1)[0] } });
    expect(afterLogout.statusCode).toBe(401);
    const statelessTokenStillWorks = await app.inject({ method: 'GET', url: '/api/teammates', headers: { cookie } });
    expect(statelessTokenStillWorks.statusCode).toBe(200);

    const secondLogin = await app.inject({ method: 'POST', url: '/api/dashboard/session', payload: { password: 'dashboard-secret' } });
    const secondCookie = String(secondLogin.headers['set-cookie']).split(';', 1)[0];
    await app.close();

    const restarted = await createApp({ repository, apiKey, dashboardPassword: 'dashboard-secret' });
    const afterRestart = await restarted.inject({ method: 'GET', url: '/api/teammates', headers: { cookie: secondCookie } });
    expect(afterRestart.statusCode).toBe(200);
    const rotated = await createApp({ repository, apiKey, dashboardPassword: 'rotated-dashboard-secret' });
    const afterRotation = await rotated.inject({ method: 'GET', url: '/api/teammates', headers: { cookie: secondCookie } });
    expect(afterRotation.statusCode).toBe(401);
    await rotated.close();
    await restarted.close();
  });

  it('marks dashboard sessions Secure when an HTTPS origin is configured', async () => {
    const app = await createApp({ repository, apiKey, dashboardPassword: 'dashboard-secret', allowedOrigins: ['https://team.example'] });
    const login = await app.inject({
      method: 'POST',
      url: '/api/dashboard/session',
      headers: { origin: 'https://team.example' },
      payload: { password: 'dashboard-secret' },
    });

    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/; Secure/iu);
    await app.close();
  });

  it('serves the six tools over official Streamable HTTP', async () => {
    const app = await createApp({ repository, apiKey });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } });
    const client = new Client({ name: 'streamable-http-test-client', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['list', 'search', 'read', 'create_work', 'update_work', 'update_teammate']);
    await client.close();
    await app.close();
  });
});

async function connectClient(repository: WorkMapRepository): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(repository);
  await server.connect(serverTransport);
  const client = new Client({ name: 'work-map-test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>, expectSuccess = true): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  if (expectSuccess) {
    expect(result.isError).not.toBe(true);
    return result.structuredContent;
  }
  expect(result.isError).toBe(true);
  const [first] = result.content;
  const parsed = JSON.parse(first?.type === 'text' ? first.text : '{}');
  return parsed;
}
