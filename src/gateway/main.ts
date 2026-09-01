import { z } from 'zod';
import { createGatewayApp } from './app.js';
import { PairingManager } from './pairing.js';
import { endpointLabelSchema, GatewayRegistry } from './registry.js';
import { AgentRouter, type AgentEndpointConfig } from './router.js';
import { createSlackReplyPoster, createSlackThreadPoster } from './slack.js';

const endpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
  label: endpointLabelSchema,
  harness: z.enum(['codex', 'hermes']),
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().transform(({ token_sha256, ...endpoint }) => ({ ...endpoint, tokenSha256: token_sha256 }));

const endpoints = parseEndpoints(required('AGENT_GATEWAY_CONNECTORS_JSON'));
const pairingConfig = readPairingConfig();
const registry = await GatewayRegistry.open(endpoints, pairingConfig?.registryFile ?? process.env.AGENT_GATEWAY_REGISTRY_FILE);
const masterEndpointId = required('AGENT_GATEWAY_MASTER_ENDPOINT');
if (!registry.list().some((endpoint) => endpoint.id === masterEndpointId)) throw new Error('AGENT_GATEWAY_MASTER_ENDPOINT is not configured');
const allowedSlackChannels = splitSlackIds('SLACK_ALLOWED_CHANNEL_IDS', /^[CG][A-Z0-9]+$/u);
const slackBotToken = requiredSecret('SLACK_BOT_TOKEN', 20, 'xoxb-');
const postThreadMessage = createSlackThreadPoster(slackBotToken);
const router = new AgentRouter(registry.connectorConfigs(), {
  allowedSlackChannels,
  onReply: createSlackReplyPoster(slackBotToken),
});
const pairingManager = pairingConfig ? new PairingManager(registry, router, {
  gatewayUrl: pairingConfig.publicUrl,
  workMapUrl: `${pairingConfig.publicUrl}/v1/work-map/mcp`,
}) : undefined;
const app = await createGatewayApp({
  router,
  masterKey: requiredSecret('AGENT_GATEWAY_MASTER_KEY', 32),
  masterEndpointId,
  allowedHosts: splitRequired('AGENT_GATEWAY_ALLOWED_HOSTS'),
  trustProxy: process.env.AGENT_GATEWAY_TRUST_PROXY === 'true',
  version: process.env.APP_VERSION,
  pairing: pairingConfig && pairingManager ? {
    manager: pairingManager,
    registry,
    adminPassword: pairingConfig.adminPassword,
    masterEndpointId,
    workMapUpstreamUrl: pairingConfig.workMapUrl,
    workMapUpstreamKey: pairingConfig.workMapKey,
  } : undefined,
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

interface PairingRuntimeConfig {
  registryFile: string;
  publicUrl: string;
  adminPassword: string;
  workMapUrl: string;
  workMapKey: string;
}

function readPairingConfig(): PairingRuntimeConfig | undefined {
  const values = {
    registryFile: process.env.AGENT_GATEWAY_REGISTRY_FILE,
    publicUrl: process.env.AGENT_GATEWAY_PUBLIC_URL,
    adminPassword: process.env.AGENT_GATEWAY_ADMIN_PASSWORD,
    workMapUrl: process.env.WORK_MAP_MCP_URL,
    workMapKey: process.env.WORK_MAP_MCP_API_KEY,
  };
  if (!Object.values(values).some(Boolean)) return undefined;
  if (!Object.values(values).every(Boolean)) {
    throw new Error('Pairing requires AGENT_GATEWAY_REGISTRY_FILE, AGENT_GATEWAY_PUBLIC_URL, AGENT_GATEWAY_ADMIN_PASSWORD, WORK_MAP_MCP_URL, and WORK_MAP_MCP_API_KEY');
  }
  return {
    registryFile: values.registryFile!,
    publicUrl: validatedBaseUrl(values.publicUrl!),
    adminPassword: validatedSecret('AGENT_GATEWAY_ADMIN_PASSWORD', values.adminPassword!, 16),
    workMapUrl: validatedMcpUrl(values.workMapUrl!),
    workMapKey: validatedSecret('WORK_MAP_MCP_API_KEY', values.workMapKey!, 32),
  };
}

function validatedBaseUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('AGENT_GATEWAY_PUBLIC_URL must use HTTPS (HTTP is allowed only for localhost)');
  if (url.username || url.password || url.search || url.hash) throw new Error('AGENT_GATEWAY_PUBLIC_URL must not contain credentials, query, or fragment');
  return url.toString().replace(/\/+$/u, '');
}

function validatedMcpUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('WORK_MAP_MCP_URL must use HTTPS (HTTP is allowed only for localhost)');
  if (url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/+$/u, '').endsWith('/mcp')) {
    throw new Error('WORK_MAP_MCP_URL must end in /mcp and contain no credentials, query, or fragment');
  }
  return url.toString().replace(/\/+$/u, '');
}

function validatedSecret(name: string, value: string, minimumLength: number): string {
  if (value.length < minimumLength || /replace|example/iu.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
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
