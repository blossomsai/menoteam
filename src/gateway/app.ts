import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createGatewayMcpServer } from './mcp.js';
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
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GatewayError) {
      return reply.code(statusFor(error.code)).send({ error: error.code, message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Invalid request body' });
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

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
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
