import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createGatewayMcpServer } from './mcp.js';
import { agentAdminClient, agentAdminCss, renderAgentAdminShell } from './admin-dashboard.js';
import { PairingError, PairingManager } from './pairing.js';
import { endpointLabelSchema, GatewayRegistry } from './registry.js';
import { AgentRouter, GatewayError } from './router.js';
import { registerSlackEvents, type SlackEventsOptions } from './slack-events.js';

const replyBody = z.object({
  status: z.enum(['completed', 'failed']),
  text: z.string().max(100_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'completed' && !value.text?.trim()) {
    context.addIssue({ code: 'custom', message: 'text is required for a completed job' });
  }
});

export interface GatewayAppOptions {
  router: AgentRouter;
  masterKey: string;
  masterEndpointId: string;
  allowedHosts?: string[];
  trustProxy?: boolean;
  version?: string;
  slack?: Omit<SlackEventsOptions, 'router'>;
  pairing?: {
    manager: PairingManager;
    registry: GatewayRegistry;
    adminPassword: string;
    masterEndpointId: string;
    workMapUpstreamUrl: string;
    workMapUpstreamKey: string;
  };
}

export async function createGatewayApp(options: GatewayAppOptions): Promise<FastifyInstance> {
  if (!options.masterKey) throw new Error('AGENT_GATEWAY_MASTER_KEY is required');
  const app = Fastify({ bodyLimit: 131_072, logger: false, trustProxy: options.trustProxy ?? false });
  const allowedHosts = options.allowedHosts ?? [];

  await app.register(helmet);
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.split(':')[0];
    if (allowedHosts.length && (!host || !allowedHosts.includes(host))) {
      await reply.code(400).send({ error: 'Invalid host' });
      return;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GatewayError) {
      return reply.code(statusFor(error.code)).send({ error: error.code, message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Invalid request body' });
    }
    if (error instanceof PairingError) {
      const status = error.code === 'UNAUTHORIZED' ? 401 : error.code === 'NOT_FOUND' ? 404 : error.code === 'EXPIRED' ? 410 : error.code === 'REJECTED' ? 403 : 409;
      return reply.code(status).send({ error: error.code, message: error.message });
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode: unknown }).statusCode) < 500) {
      return reply.code(Number((error as { statusCode: number }).statusCode)).send({ error: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Bad request' });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'menoteam-agent-gateway',
    version: options.version ?? process.env.APP_VERSION ?? '0.1.0',
  }));

  if (options.pairing) registerPairingRoutes(app, options.pairing);

  app.get('/v1/connectors/:endpointId/jobs/next', async (request, reply) => {
    const endpointId = String((request.params as { endpointId: string }).endpointId);
    options.router.authenticate(endpointId, request.headers.authorization);
    const query = request.query as { wait_ms?: unknown };
    const waitMs = boundedWait(query.wait_ms);
    const job = await options.router.waitForJob(endpointId, waitMs);
    if (!job) return reply.code(204).send();
    return reply.header('cache-control', 'no-store').send({ job });
  });

  app.post('/v1/connectors/:endpointId/jobs/:jobId/reply', async (request, reply) => {
    const params = request.params as { endpointId: string; jobId: string };
    options.router.authenticate(params.endpointId, request.headers.authorization);
    const body = replyBody.parse(parseJsonBody(request.body));
    await options.router.reply(params.endpointId, params.jobId, body.status, body.text?.trim());
    return reply.code(202).send({ accepted: true });
  });

  app.post('/mcp', { preHandler: authenticate(options.masterKey) }, async (request, reply) => {
    reply.hijack();
    const server = createGatewayMcpServer(options.router, options.masterEndpointId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, parseJsonBody(request.body));
    } catch (error) {
      request.log.error(error);
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  app.get('/mcp', { preHandler: authenticate(options.masterKey) }, async (_request, reply) => reply.code(405).send({ error: 'Method not allowed' }));
  app.delete('/mcp', { preHandler: authenticate(options.masterKey) }, async (_request, reply) => reply.code(405).send({ error: 'Method not allowed' }));

  if (options.slack) registerSlackEvents(app, { ...options.slack, router: options.router });

  app.addHook('onClose', async () => options.router.close());
  return app;
}

function registerPairingRoutes(app: FastifyInstance, options: NonNullable<GatewayAppOptions['pairing']>): void {
  const createPairingBody = z.object({
    label: endpointLabelSchema,
    harness: z.literal('codex'),
    connector_token_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    work_map_token_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict();

  app.get('/agents', async (_request, reply) => reply.type('text/html; charset=utf-8').send(renderAgentAdminShell()));
  app.get('/agents/styles.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(agentAdminCss));
  app.get('/agents/client.js', async (_request, reply) => reply.type('application/javascript; charset=utf-8').send(agentAdminClient));

  app.post('/v1/pairings', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = createPairingBody.parse(parseJsonBody(request.body));
    const deviceCode = bearerToken(request.headers.authorization);
    if (!deviceCode || deviceCode.length < 32) return reply.header('www-authenticate', 'Bearer').code(401).send({ error: 'Unauthorized' });
    const pairing = await options.manager.create({
      label: body.label,
      harness: body.harness,
      connectorTokenSha256: body.connector_token_sha256,
      workMapTokenSha256: body.work_map_token_sha256,
      deviceCode,
    });
    return reply.header('cache-control', 'no-store').code(201).send(pairing);
  });
  app.post('/v1/pairings/:pairingId/token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const status = options.manager.poll(String((request.params as { pairingId: string }).pairingId), request.headers.authorization);
      return reply.header('cache-control', 'no-store').send(status);
    } catch (error) {
      if (!(error instanceof PairingError)) throw error;
      const status = error.code === 'PENDING' ? 202 : error.code === 'UNAUTHORIZED' ? 401 : error.code === 'NOT_FOUND' ? 404 : error.code === 'EXPIRED' ? 410 : error.code === 'REJECTED' ? 403 : 409;
      return reply.header('cache-control', 'no-store').code(status).send({ status: error.code.toLocaleLowerCase(), message: error.message });
    }
  });

  app.post('/api/agent-admin/session', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!sameOriginRequest(request)) return reply.code(403).send({ error: 'Origin not allowed' });
    const body = parseJsonBody(request.body) as { password?: unknown };
    if (typeof body?.password !== 'string' || !secretMatches(body.password, options.adminPassword)) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.header('cache-control', 'no-store').header('set-cookie', adminCookie(createAdminToken(options.adminPassword), request)).send({ authenticated: true });
  });
  app.post('/api/agent-admin/session/logout', async (request, reply) => {
    if (!sameOriginRequest(request)) return reply.code(403).send({ error: 'Origin not allowed' });
    return reply.header('cache-control', 'no-store').header('set-cookie', clearAdminCookie(request)).send({ authenticated: false });
  });

  const adminAuth = createAdminAuth(options.adminPassword);
  app.get('/api/agent-admin/snapshot', { preHandler: adminAuth }, async () => ({
    pairings: options.manager.listPairings(),
    endpoints: options.manager.listEndpoints(),
    managed_endpoint_ids: options.manager.managedEndpointIds(),
    master_endpoint_id: options.masterEndpointId,
  }));
  app.post('/api/agent-admin/pairings/:pairingId/approve', { preHandler: adminAuth }, async (request, reply) => {
    const pairingId = String((request.params as { pairingId: string }).pairingId);
    await options.manager.approve(pairingId);
    return reply.code(204).send();
  });
  app.post('/api/agent-admin/pairings/:pairingId/reject', { preHandler: adminAuth }, async (request, reply) => {
    await options.manager.reject(String((request.params as { pairingId: string }).pairingId));
    return reply.code(204).send();
  });
  app.delete('/api/agent-admin/endpoints/:endpointId', { preHandler: adminAuth }, async (request, reply) => {
    const endpointId = String((request.params as { endpointId: string }).endpointId);
    if (endpointId === options.masterEndpointId) return reply.code(409).send({ error: 'CONFLICT', message: 'Replace the active Master before revoking it' });
    await options.manager.revokeEndpoint(endpointId);
    return reply.code(204).send();
  });

  app.post('/v1/work-map/mcp', async (request, reply) => {
    try {
      options.registry.authenticateWorkMap(request.headers.authorization);
    } catch {
      return reply.header('www-authenticate', 'Bearer').code(401).send({ error: 'Unauthorized' });
    }
    const upstream = await fetch(options.workMapUpstreamUrl, {
      method: 'POST',
      headers: {
        accept: String(request.headers.accept ?? 'application/json, text/event-stream'),
        authorization: `Bearer ${options.workMapUpstreamKey}`,
        'content-type': 'application/json',
      },
      body: Buffer.isBuffer(request.body) ? request.body.toString('utf8') : JSON.stringify(request.body),
      signal: AbortSignal.timeout(60_000),
    });
    const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8';
    return reply.header('cache-control', 'no-store').type(contentType).code(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  });
  app.get('/v1/work-map/mcp', async (_request, reply) => reply.code(405).send({ error: 'Method not allowed' }));
  app.delete('/v1/work-map/mcp', async (_request, reply) => reply.code(405).send({ error: 'Method not allowed' }));
}

function parseJsonBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON body') as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
}

function authenticate(key: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!secretMatches(request.headers.authorization, `Bearer ${key}`)) {
      await reply.header('www-authenticate', 'Bearer').code(401).send({ error: 'Unauthorized' });
    }
  };
}

const ADMIN_COOKIE = 'menoteam_agent_admin';
const ADMIN_TTL_SECONDS = 8 * 60 * 60;

function createAdminAuth(password: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!sameOriginRequest(request) || !verifyAdminToken(readCookie(request.headers.cookie, ADMIN_COOKIE), password)) {
      await reply.header('set-cookie', clearAdminCookie(request)).code(401).send({ error: 'Unauthorized' });
    }
  };
}

function createAdminToken(password: string, now = Date.now()): string {
  const expiry = Math.floor(now / 1_000) + ADMIN_TTL_SECONDS;
  const payload = `v1.${expiry}.${randomBytes(24).toString('base64url')}`;
  return `${payload}.${createHmac('sha256', password).update(payload).digest('base64url')}`;
}

function verifyAdminToken(token: string | undefined, password: string, now = Date.now()): boolean {
  const match = /^v1\.([1-9]\d{0,10})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/u.exec(token ?? '');
  if (!match || Number(match[1]) <= Math.floor(now / 1_000)) return false;
  const payload = `v1.${match[1]}.${match[2]}`;
  return secretMatches(match[3], createHmac('sha256', password).update(payload).digest('base64url'));
}

function adminCookie(token: string, request: FastifyRequest): string {
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_TTL_SECONDS}${request.protocol === 'https' ? '; Secure' : ''}`;
}

function clearAdminCookie(request: FastifyRequest): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${request.protocol === 'https' ? '; Secure' : ''}`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function sameOriginRequest(request: FastifyRequest): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  return typeof origin !== 'string' || origin === `${request.protocol}://${request.headers.host}`;
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
}

function boundedWait(value: unknown): number {
  const parsed = Number(value ?? 25_000);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 30_000 ? parsed : 25_000;
}

function statusFor(code: GatewayError['code']): 400 | 401 | 404 | 409 | 503 {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'CONFLICT') return 409;
  if (code === 'OFFLINE') return 503;
  return 400;
}
