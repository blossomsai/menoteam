import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DomainError } from '../domain/errors.js';
import type { WorkFilters } from '../domain/model.js';
import type { WorkMapRepository } from '../domain/repository.js';
import { createMcpServer } from './mcp.js';

export interface AppOptions {
  repository: WorkMapRepository;
  apiKey: string;
  version?: string;
  dashboardPassword?: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  registerDashboardRoutes?: (app: FastifyInstance) => void | Promise<void>;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  if (!options.apiKey) throw new Error('MCP_API_KEY is required');
  const app = Fastify({ bodyLimit: 1_048_576, logger: false });
  const origins = options.allowedOrigins ?? [];
  const hosts = options.allowedHosts ?? [];

  await app.register(helmet);
  await app.register(cors, { origin: origins.length ? origins : false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400;
      return reply.code(status).send({ error: error.code, message: error.message, ...error.details });
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode: unknown }).statusCode) < 500) {
      return reply.code(Number((error as { statusCode: number }).statusCode)).send({ error: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Bad request' });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.split(':')[0];
    if (hosts.length && (!host || !hosts.includes(host))) {
      await reply.code(400).send({ error: 'Invalid host' });
      return;
    }
    const origin = request.headers.origin;
    if (origins.length && origin && !origins.includes(origin)) {
      await reply.code(403).send({ error: 'Origin not allowed' });
      return;
    }
  });

  app.get('/healthz', async (_request, reply) => {
    const healthy = await options.repository.health();
    if (!healthy) return reply.code(503).send({ status: 'error', service: 'menoteam-work-map' });
    return reply.send({ status: 'ok', service: 'menoteam-work-map', version: options.version ?? process.env.APP_VERSION ?? '0.1.0' });
  });

  app.post('/mcp', { preHandler: authenticate(options.apiKey) }, async (request, reply) => {
    reply.hijack();
    const server = createMcpServer(options.repository);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
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

  app.get('/mcp', { preHandler: authenticate(options.apiKey) }, async (_request, reply) => reply.code(405).send({ error: 'Method not allowed' }));
  app.delete('/mcp', { preHandler: authenticate(options.apiKey) }, async (_request, reply) => reply.code(405).send({ error: 'Method not allowed' }));

  if (options.dashboardPassword) {
    const dashboardAuth = createDashboardAuth(options.dashboardPassword, origins);
    app.post('/api/dashboard/session', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      if (!sameOriginRequest(request, origins)) return reply.code(403).send({ error: 'Origin not allowed' });
      const body = request.body as { password?: unknown } | undefined;
      if (typeof body?.password !== 'string' || !secretMatches(body.password, options.dashboardPassword!)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      const token = createDashboardToken(options.dashboardPassword!);
      return reply.header('cache-control', 'no-store').header('set-cookie', dashboardCookie(token, request, origins)).send({ authenticated: true });
    });
    app.post('/api/dashboard/session/logout', async (request, reply) => {
      if (!sameOriginRequest(request, origins)) return reply.code(403).send({ error: 'Origin not allowed' });
      return reply.header('cache-control', 'no-store').header('set-cookie', clearDashboardCookie(request, origins)).send({ authenticated: false });
    });
    app.get('/api/works', { preHandler: dashboardAuth }, async (request) => {
      const query = request.query as Record<string, unknown>;
      const limit = boundedLimit(query.limit);
      const parent = query.parent === undefined ? undefined : query.parent === 'null' ? null : String(query.parent);
      const filters: WorkFilters = { title: query.title ? String(query.title) : undefined, parent, ancestor: query.ancestor ? String(query.ancestor) : undefined, owner: query.owner ? String(query.owner) : undefined, state: query.state === 'current' || query.state === 'completed' ? query.state : undefined };
      return options.repository.list('work', filters, typeof query.cursor === 'string' ? query.cursor : undefined, limit);
    });
    app.get('/api/teammates', { preHandler: dashboardAuth }, async (request) => {
      const query = request.query as Record<string, unknown>;
      return options.repository.list('teammate', {}, typeof query.cursor === 'string' ? query.cursor : undefined, boundedLimit(query.limit));
    });
    app.get('/api/search', { preHandler: dashboardAuth }, async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const term = typeof query.q === 'string' ? query.q.trim() : '';
      if (!term) return reply.code(400).send({ error: 'q is required' });
      return options.repository.search(term, typeof query.cursor === 'string' ? query.cursor : undefined, boundedLimit(query.limit));
    });
    app.get('/api/entity/:ref', { preHandler: dashboardAuth }, async (request) => options.repository.read((request.params as { ref: string }).ref));
  }

  if (options.registerDashboardRoutes) await options.registerDashboardRoutes(app);
  return app;
}

function authenticate(apiKey: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!secretMatches(request.headers.authorization, `Bearer ${apiKey}`)) {
      await reply.header('www-authenticate', 'Bearer').code(401).send({ error: 'Unauthorized' });
    }
  };
}

export function createDashboardAuth(dashboardPassword: string, allowedOrigins: string[] = []) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!sameOriginRequest(request, allowedOrigins)) {
      await reply.code(403).send({ error: 'Origin not allowed' });
      return;
    }
    const token = readDashboardCookie(request.headers.cookie);
    if (!verifyDashboardToken(token, dashboardPassword)) {
      await reply.header('set-cookie', clearDashboardCookie(request, allowedOrigins)).code(401).send({ error: 'Unauthorized' });
      return;
    }
    reply.header('cache-control', 'no-store');
  };
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function boundedLimit(value: unknown): number {
  const parsed = Number(value ?? 50);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 50;
}

const DASHBOARD_COOKIE_NAME = 'menoteam_dashboard';
const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DASHBOARD_SESSION_TTL_SECONDS = DASHBOARD_SESSION_TTL_MS / 1_000;
const DASHBOARD_TOKEN_VERSION = 'v1';
const DASHBOARD_TOKEN_MAX_LENGTH = 128;
const DASHBOARD_NONCE_BYTES = 32;
const DASHBOARD_SIGNATURE_BYTES = 32;
const DASHBOARD_TOKEN_PATTERN = /^v1\.([1-9]\d{0,9})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u;
const DASHBOARD_SIGNING_CONTEXT = 'menoteam/dashboard-session/v1';

export function createDashboardToken(dashboardPassword: string, now = Date.now()): string {
  const expiry = Math.floor(now / 1_000) + DASHBOARD_SESSION_TTL_SECONDS;
  const payload = `${DASHBOARD_TOKEN_VERSION}.${expiry}.${randomBytes(DASHBOARD_NONCE_BYTES).toString('base64url')}`;
  const signature = signDashboardPayload(payload, dashboardPassword);
  return `${payload}.${signature}`;
}

export function verifyDashboardToken(token: string | undefined, dashboardPassword: string, now = Date.now()): boolean {
  if (!dashboardPassword || !token || token.length > DASHBOARD_TOKEN_MAX_LENGTH) return false;
  const match = DASHBOARD_TOKEN_PATTERN.exec(token);
  if (!match) return false;
  const expiry = Number(match[1]);
  const nowSeconds = Math.floor(now / 1_000);
  if (!Number.isSafeInteger(expiry) || expiry <= nowSeconds) return false;
  const nonce = Buffer.from(match[2]!, 'base64url');
  const signature = Buffer.from(match[3]!, 'base64url');
  if (nonce.length !== DASHBOARD_NONCE_BYTES || signature.length !== DASHBOARD_SIGNATURE_BYTES) return false;
  const expected = Buffer.from(signDashboardPayload(`${DASHBOARD_TOKEN_VERSION}.${match[1]}.${match[2]}`, dashboardPassword), 'base64url');
  return expected.length === signature.length && timingSafeEqual(signature, expected);
}

function signDashboardPayload(payload: string, dashboardPassword: string): string {
  const signingKey = createHmac('sha256', Buffer.from(dashboardPassword, 'utf8')).update(DASHBOARD_SIGNING_CONTEXT, 'utf8').digest();
  return createHmac('sha256', signingKey).update(payload, 'utf8').digest('base64url');
}

function readDashboardCookie(header: string | undefined): string | undefined {
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${DASHBOARD_COOKIE_NAME}=`))?.slice(DASHBOARD_COOKIE_NAME.length + 1);
}

function dashboardCookie(token: string, request: FastifyRequest, allowedOrigins: string[]): string {
  const secure = request.protocol === 'https' || allowedOrigins.some((origin) => origin.startsWith('https://'));
  return `${DASHBOARD_COOKIE_NAME}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${DASHBOARD_SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function clearDashboardCookie(request: FastifyRequest, allowedOrigins: string[]): string {
  const secure = request.protocol === 'https' || allowedOrigins.some((origin) => origin.startsWith('https://'));
  return `${DASHBOARD_COOKIE_NAME}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

function sameOriginRequest(request: FastifyRequest, allowedOrigins: string[]): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return false;
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return true;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  return origin === `${request.protocol}://${request.headers.host}`;
}
