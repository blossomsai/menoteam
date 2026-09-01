import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayApp } from '../src/gateway/app.js';
import { PairingError, PairingManager } from '../src/gateway/pairing.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { AgentRouter } from '../src/gateway/router.js';

const connectorToken = 'c'.repeat(43);
const workMapToken = 'w'.repeat(43);
const deviceCode = 'd'.repeat(43);
const masterToken = 'm'.repeat(43);
const seed = [{ id: 'master-hermes', label: 'MASTER', harness: 'hermes' as const, tokenSha256: sha256(masterToken) }];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Gateway device pairing', () => {
  it('persists only credential digests and restores an approved endpoint after restart', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'menoteam-pairing-'));
    const stateFile = join(temporary, 'gateway', 'state.json');
    try {
      const registry = await GatewayRegistry.open(seed, stateFile);
      const router = createRouter(registry);
      const manager = createManager(registry, router);
      const request = await manager.create({
        label: 'Alice · Codex',
        harness: 'codex',
        connectorTokenSha256: sha256(connectorToken),
        workMapTokenSha256: sha256(workMapToken),
        deviceCode,
      });

      expect(() => manager.poll(request.pairing_id, `Bearer ${deviceCode}`)).toThrowError(PairingError);
      await manager.approve(request.pairing_id);
      expect(manager.poll(request.pairing_id, `Bearer ${deviceCode}`)).toMatchObject({ status: 'approved', endpoint_id: 'alice-codex' });
      expect(() => router.authenticate('alice-codex', `Bearer ${connectorToken}`)).not.toThrow();
      expect(registry.authenticateWorkMap(`Bearer ${workMapToken}`).id).toBe('alice-codex');

      const stored = await readFile(stateFile, 'utf8');
      expect(stored).not.toContain(connectorToken);
      expect(stored).not.toContain(workMapToken);
      expect(stored).not.toContain(deviceCode);
      expect((await stat(stateFile)).mode & 0o777).toBe(0o600);

      const restored = await GatewayRegistry.open(seed, stateFile);
      const restoredRouter = createRouter(restored);
      expect(() => restoredRouter.authenticate('alice-codex', `Bearer ${connectorToken}`)).not.toThrow();
      expect(restored.authenticateWorkMap(`Bearer ${workMapToken}`).id).toBe('alice-codex');
      await createManager(restored, restoredRouter).revokeEndpoint('alice-codex');
      expect(() => restoredRouter.authenticate('alice-codex', `Bearer ${connectorToken}`)).toThrow();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('exposes a sanitized admin approval flow and protects legacy endpoints', async () => {
    const registry = await GatewayRegistry.open(seed);
    const router = createRouter(registry);
    const manager = createManager(registry, router);
    const app = await createGatewayApp({
      router,
      masterKey: 'k'.repeat(32),
      masterEndpointId: 'master-hermes',
      pairing: {
        manager,
        registry,
        adminPassword: 'admin-password-strong',
        masterEndpointId: 'master-hermes',
        workMapUpstreamUrl: 'https://work-map.example.com/mcp',
        workMapUpstreamKey: 'u'.repeat(32),
      },
    });
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      headers: { authorization: `Bearer ${deviceCode}` },
      payload: {
        label: 'Alice · Codex',
        harness: 'codex',
        connector_token_sha256: sha256(connectorToken),
        work_map_token_sha256: sha256(workMapToken),
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(connectorToken);
    expect(created.body).not.toContain(workMapToken);
    expect(created.body).not.toContain(deviceCode);
    expect(created.headers['cache-control']).toBe('no-store');

    const unsafeLabel = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      headers: { authorization: `Bearer ${'x'.repeat(32)}` },
      payload: {
        label: '*MASTER*\n<@everyone>',
        harness: 'codex',
        connector_token_sha256: sha256('y'.repeat(32)),
        work_map_token_sha256: sha256('z'.repeat(32)),
      },
    });
    expect(unsafeLabel.statusCode).toBe(400);

    const denied = await app.inject({ method: 'GET', url: '/api/agent-admin/snapshot' });
    expect(denied.statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/agent-admin/session',
      payload: { password: 'admin-password-strong' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const snapshot = await app.inject({ method: 'GET', url: '/api/agent-admin/snapshot', headers: { cookie } });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      pairings: [{ label: 'Alice · Codex', status: 'pending' }],
      managed_endpoint_ids: [],
      master_endpoint_id: 'master-hermes',
    });
    expect(snapshot.body).not.toMatch(/Sha256|token/iu);

    const pairingId = created.json().pairing_id as string;
    const approved = await app.inject({ method: 'POST', url: `/api/agent-admin/pairings/${pairingId}/approve`, headers: { cookie } });
    expect(approved.statusCode).toBe(204);
    const poll = await app.inject({ method: 'POST', url: `/v1/pairings/${pairingId}/token`, headers: { authorization: `Bearer ${deviceCode}` } });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({ status: 'approved', endpoint_id: 'alice-codex', work_map_url: 'https://agents.example.com/v1/work-map/mcp' });
    expect(() => router.authenticate('alice-codex', `Bearer ${connectorToken}`)).not.toThrow();

    const protectedMaster = await app.inject({ method: 'DELETE', url: '/api/agent-admin/endpoints/master-hermes', headers: { cookie } });
    expect(protectedMaster.statusCode).toBe(409);
    const revoked = await app.inject({ method: 'DELETE', url: '/api/agent-admin/endpoints/alice-codex', headers: { cookie } });
    expect(revoked.statusCode).toBe(204);
    expect(() => router.authenticate('alice-codex', `Bearer ${connectorToken}`)).toThrow();

    const shell = await app.inject({ method: 'GET', url: '/agents' });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('Approve only devices you recognize');
    expect(shell.body).toContain('/agents/client.js');
  });

  it('proxies Work Map MCP with a revocable per-device credential', async () => {
    const upstreamKey = 'u'.repeat(32);
    const upstream = Fastify({ logger: false });
    upstream.post('/mcp', async (request, reply) => {
      expect(request.headers.authorization).toBe(`Bearer ${upstreamKey}`);
      return reply.send(request.body);
    });
    await upstream.listen({ port: 0, host: '127.0.0.1' });
    apps.push(upstream);
    const address = upstream.server.address();
    if (!address || typeof address === 'string') throw new Error('Upstream test server did not bind');

    const registry = await GatewayRegistry.open(seed);
    const router = createRouter(registry);
    const manager = createManager(registry, router);
    const pairing = await manager.create({
      label: 'Alice · Codex',
      harness: 'codex',
      connectorTokenSha256: sha256(connectorToken),
      workMapTokenSha256: sha256(workMapToken),
      deviceCode,
    });
    await manager.approve(pairing.pairing_id);
    const app = await createGatewayApp({
      router,
      masterKey: 'k'.repeat(32),
      masterEndpointId: 'master-hermes',
      pairing: {
        manager,
        registry,
        adminPassword: 'admin-password-strong',
        masterEndpointId: 'master-hermes',
        workMapUpstreamUrl: `http://127.0.0.1:${address.port}/mcp`,
        workMapUpstreamKey: upstreamKey,
      },
    });
    apps.push(app);

    const denied = await app.inject({ method: 'POST', url: '/v1/work-map/mcp', payload: { jsonrpc: '2.0' } });
    expect(denied.statusCode).toBe(401);
    const proxied = await app.inject({
      method: 'POST',
      url: '/v1/work-map/mcp',
      headers: { authorization: `Bearer ${workMapToken}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(proxied.statusCode).toBe(200);
    expect(proxied.json()).toMatchObject({ id: 1, method: 'tools/list' });
  });
});

function createRouter(registry: GatewayRegistry): AgentRouter {
  return new AgentRouter(registry.connectorConfigs(), { allowedSlackChannels: ['C123'], onReply: async () => undefined });
}

function createManager(registry: GatewayRegistry, router: AgentRouter): PairingManager {
  return new PairingManager(registry, router, {
    gatewayUrl: 'https://agents.example.com',
    workMapUrl: 'https://agents.example.com/v1/work-map/mcp',
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
