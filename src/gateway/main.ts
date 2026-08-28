import { z } from 'zod';
import { createGatewayApp } from './app.js';
import { AgentRouter, type AgentEndpointConfig } from './router.js';
import { createSlackReplyPoster, createSlackThreadPoster } from './slack.js';

const endpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
  label: z.string().trim().min(1).max(80).refine((value) => !/[<>]/u.test(value), 'label cannot contain Slack control characters'),
  harness: z.enum(['codex', 'hermes']),
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().transform(({ token_sha256, ...endpoint }) => ({ ...endpoint, tokenSha256: token_sha256 }));

const endpoints = parseEndpoints(required('AGENT_GATEWAY_CONNECTORS_JSON'));
const masterEndpointId = required('AGENT_GATEWAY_MASTER_ENDPOINT');
if (!endpoints.some((endpoint) => endpoint.id === masterEndpointId)) throw new Error('AGENT_GATEWAY_MASTER_ENDPOINT is not configured');
const allowedSlackChannels = splitSlackIds('SLACK_ALLOWED_CHANNEL_IDS', /^[CG][A-Z0-9]+$/u);
const slackBotToken = requiredSecret('SLACK_BOT_TOKEN', 20, 'xoxb-');
const postThreadMessage = createSlackThreadPoster(slackBotToken);
const router = new AgentRouter(endpoints, {
  allowedSlackChannels,
  onReply: createSlackReplyPoster(slackBotToken),
});
const app = await createGatewayApp({
  router,
  masterKey: requiredSecret('AGENT_GATEWAY_MASTER_KEY', 32),
  masterEndpointId,
  allowedHosts: splitRequired('AGENT_GATEWAY_ALLOWED_HOSTS'),
  trustProxy: process.env.AGENT_GATEWAY_TRUST_PROXY === 'true',
  version: process.env.APP_VERSION,
  slack: {
    signingSecret: requiredSecret('SLACK_SIGNING_SECRET', 20),
    botUserId: validatedSlackId('SLACK_BOT_USER_ID', /^U[A-Z0-9]+$/u),
    allowedUserIds: splitSlackIds('SLACK_ALLOWED_USER_IDS', /^[UW][A-Z0-9]+$/u),
    allowedChannelIds: allowedSlackChannels,
    masterEndpointId,
    postThreadMessage,
  },
});

await app.listen({
  port: boundedPort(process.env.AGENT_GATEWAY_PORT),
  host: process.env.AGENT_GATEWAY_HOST ?? '127.0.0.1',
});

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

export function parseEndpoints(value: string): AgentEndpointConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AGENT_GATEWAY_CONNECTORS_JSON must be valid JSON');
  }
  const endpoints = z.array(endpointSchema).min(1).max(200).parse(parsed);
  if (new Set(endpoints.map((endpoint) => endpoint.id)).size !== endpoints.length) {
    throw new Error('AGENT_GATEWAY_CONNECTORS_JSON contains duplicate endpoint IDs');
  }
  if (new Set(endpoints.map((endpoint) => endpoint.tokenSha256)).size !== endpoints.length) {
    throw new Error('AGENT_GATEWAY_CONNECTORS_JSON contains duplicate endpoint token digests');
  }
  return endpoints;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredSecret(name: string, minimumLength: number, prefix?: string): string {
  const value = required(name);
  if (value.length < minimumLength || (prefix && !value.startsWith(prefix)) || /replace|example/iu.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function splitRequired(name: string): string[] {
  const values = splitOptional(process.env[name]);
  if (!values?.length) throw new Error(`${name} is required`);
  return values;
}

function splitSlackIds(name: string, pattern: RegExp): string[] {
  const values = splitRequired(name);
  if (values.some((value) => !pattern.test(value))) throw new Error(`${name} contains an invalid Slack ID`);
  return values;
}

function validatedSlackId(name: string, pattern: RegExp): string {
  const value = required(name);
  if (!pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function splitOptional(value: string | undefined): string[] | undefined {
  const values = value?.split(',').map((item) => item.trim()).filter(Boolean);
  return values?.length ? values : undefined;
}

function boundedPort(value: string | undefined): number {
  const port = Number(value ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('AGENT_GATEWAY_PORT must be a valid port');
  return port;
}
