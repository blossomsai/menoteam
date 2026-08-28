#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const VALID_HARNESSES = new Set(['codex', 'hermes']);

export function parseEnvFile(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    if (Object.hasOwn(values, match[1])) throw new Error(`Duplicate ${match[1]} in environment file`);
    values[match[1]] = parseEnvValue(match[2].trim());
  }
  return values;
}

export function replaceEnvValue(contents, name, value) {
  const lines = contents.split(/\r?\n/u);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (new RegExp(`^\\s*(?:export\\s+)?${name}=`, 'u').test(lines[index])) matches.push(index);
  }
  if (matches.length > 1) throw new Error(`Duplicate ${name} in environment file`);
  const assignment = `${name}=${shellQuote(value)}`;
  if (matches.length === 1) lines[matches[0]] = assignment;
  else {
    while (lines.at(-1) === '') lines.pop();
    lines.push(assignment, '');
  }
  return lines.join('\n');
}

export function createEndpoint({ id, label, harness, token }) {
  validateEndpointId(id);
  validateHarness(harness);
  const cleanLabel = String(label ?? '').trim();
  if (!cleanLabel || cleanLabel.length > 80 || /[<>]/u.test(cleanLabel)) throw new Error('Endpoint label is invalid');
  return {
    id,
    label: cleanLabel,
    harness,
    token_sha256: createHash('sha256').update(token).digest('hex'),
  };
}

export function parseRegistry(value) {
  let registry;
  try { registry = JSON.parse(value || '[]'); } catch { throw new Error('AGENT_GATEWAY_CONNECTORS_JSON must be valid JSON'); }
  if (!Array.isArray(registry)) throw new Error('AGENT_GATEWAY_CONNECTORS_JSON must be an array');
  for (const endpoint of registry) {
    validateEndpointId(endpoint?.id);
    if (typeof endpoint?.label !== 'string' || !endpoint.label.trim()) throw new Error('Registry contains an invalid label');
    validateHarness(endpoint?.harness);
    if (!/^[a-f0-9]{64}$/u.test(endpoint?.token_sha256)) throw new Error('Registry contains an invalid token digest');
  }
  if (new Set(registry.map(({ id }) => id)).size !== registry.length) throw new Error('Registry contains duplicate endpoint IDs');
  if (new Set(registry.map(({ token_sha256 }) => token_sha256)).size !== registry.length) throw new Error('Registry contains duplicate endpoint token digests');
  return registry;
}

export function createHandoff({ gatewayUrl, id, harness, token, role, repositoryCwd, masterKey, workMap }) {
  const url = validatedGatewayUrl(gatewayUrl);
  validateEndpointId(id);
  validateHarness(harness);
  if (role !== 'master' && role !== 'teammate') throw new Error('Role must be master or teammate');
  if (token.length < 32) throw new Error('Generated endpoint token is too short');
  const values = {
    MENOTEAM_GATEWAY_URL: url,
    MENOTEAM_AGENT_ENDPOINT: id,
    MENOTEAM_AGENT_TOKEN: token,
    MENOTEAM_AGENT_ROLE: role,
    MENOTEAM_AGENT_HARNESS: harness,
    WORK_MAP_MCP_URL: workMap.url,
    WORK_MAP_MCP_API_KEY: workMap.apiKey,
  };
  if (repositoryCwd) values.MENOTEAM_REPOSITORY_CWD = resolve(repositoryCwd);
  if (role === 'master') {
    if (!masterKey || masterKey.length < 32) throw new Error('AGENT_GATEWAY_MASTER_KEY is missing or invalid');
    values.MENOTEAM_MASTER_MCP_KEY = masterKey;
  }
  return `${Object.entries(values).map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n')}\n`;
}

export async function addEndpoint(options) {
  const envPath = resolve(requiredOption(options, 'env'));
  const outputPath = resolve(requiredOption(options, 'output'));
  const id = requiredOption(options, 'id');
  const role = requiredOption(options, 'role');
  const harness = options.harness || 'codex';
  validateHarness(harness);
  const workMap = await readWorkMap(options);
  const token = randomBytes(32).toString('base64url');
  const original = await readFile(envPath, 'utf8');
  const env = parseEnvFile(original);
  const registry = parseRegistry(env.AGENT_GATEWAY_CONNECTORS_JSON);
  if (registry.some((endpoint) => endpoint.id === id)) throw new Error(`Endpoint already exists: ${id}`);
  const endpoint = createEndpoint({ id, label: requiredOption(options, 'label'), harness, token });
  const updatedRegistry = [...registry, endpoint];
  if (new Set(updatedRegistry.map(({ token_sha256 }) => token_sha256)).size !== updatedRegistry.length) {
    throw new Error('Generated endpoint token conflicts with the registry');
  }
  let updated = replaceEnvValue(original, 'AGENT_GATEWAY_CONNECTORS_JSON', JSON.stringify(updatedRegistry));
  let masterKey = env.AGENT_GATEWAY_MASTER_KEY;
  if (role === 'master') {
    masterKey = randomBytes(32).toString('base64url');
    updated = replaceEnvValue(updated, 'AGENT_GATEWAY_MASTER_KEY', masterKey);
    updated = replaceEnvValue(updated, 'AGENT_GATEWAY_MASTER_ENDPOINT', id);
  }
  const handoff = createHandoff({
    gatewayUrl: requiredOption(options, 'gateway-url'),
    id,
    harness,
    token,
    role,
    repositoryCwd: options['repository-cwd'],
    masterKey,
    workMap,
  });

  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, handoff, { flag: 'wx', mode: 0o600 });
  await chmod(outputPath, 0o600);
  try {
    await atomicSecretWrite(envPath, updated);
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
  return { id, role, harness, envPath, outputPath };
}

export async function revokeEndpoint(options) {
  const envPath = resolve(requiredOption(options, 'env'));
  const id = requiredOption(options, 'id');
  validateEndpointId(id);
  const original = await readFile(envPath, 'utf8');
  const env = parseEnvFile(original);
  if (env.AGENT_GATEWAY_MASTER_ENDPOINT === id) {
    throw new Error('Cannot revoke the active Master; add a replacement Master first');
  }
  const registry = parseRegistry(env.AGENT_GATEWAY_CONNECTORS_JSON);
  const updatedRegistry = registry.filter((endpoint) => endpoint.id !== id);
  if (updatedRegistry.length === registry.length) throw new Error(`Endpoint does not exist: ${id}`);
  if (!updatedRegistry.length) throw new Error('Cannot revoke the last endpoint');
  await atomicSecretWrite(envPath, replaceEnvValue(original, 'AGENT_GATEWAY_CONNECTORS_JSON', JSON.stringify(updatedRegistry)));
  return { id, envPath };
}

export async function rotateEndpoint(options) {
  const envPath = resolve(requiredOption(options, 'env'));
  const outputPath = resolve(requiredOption(options, 'output'));
  const id = requiredOption(options, 'id');
  validateEndpointId(id);
  const original = await readFile(envPath, 'utf8');
  const env = parseEnvFile(original);
  const registry = parseRegistry(env.AGENT_GATEWAY_CONNECTORS_JSON);
  const existing = registry.find((endpoint) => endpoint.id === id);
  if (!existing) throw new Error(`Endpoint does not exist: ${id}`);
  const workMap = await readWorkMap(options);
  const token = randomBytes(32).toString('base64url');
  const role = env.AGENT_GATEWAY_MASTER_ENDPOINT === id ? 'master' : 'teammate';
  const replacement = createEndpoint({ id, label: existing.label, harness: existing.harness, token });
  const updatedRegistry = registry.map((endpoint) => endpoint.id === id ? replacement : endpoint);
  if (new Set(updatedRegistry.map(({ token_sha256 }) => token_sha256)).size !== updatedRegistry.length) {
    throw new Error('Generated endpoint token conflicts with the registry');
  }
  let updated = replaceEnvValue(original, 'AGENT_GATEWAY_CONNECTORS_JSON', JSON.stringify(updatedRegistry));
  let masterKey = env.AGENT_GATEWAY_MASTER_KEY;
  if (role === 'master') {
    masterKey = randomBytes(32).toString('base64url');
    updated = replaceEnvValue(updated, 'AGENT_GATEWAY_MASTER_KEY', masterKey);
  }
  const handoff = createHandoff({
    gatewayUrl: requiredOption(options, 'gateway-url'),
    id,
    harness: existing.harness,
    token,
    role,
    repositoryCwd: options['repository-cwd'],
    masterKey,
    workMap,
  });

  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, handoff, { flag: 'wx', mode: 0o600 });
  await chmod(outputPath, 0o600);
  try {
    await atomicSecretWrite(envPath, updated);
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
  return { id, role, harness: existing.harness, envPath, outputPath };
}

async function readWorkMap(options) {
  const workMapUrl = requiredOption(options, 'work-map-url');
  const workMapEnvPath = resolve(requiredOption(options, 'work-map-env'));
  const values = parseEnvFile(await readFile(workMapEnvPath, 'utf8'));
  const apiKey = values.WORK_MAP_MCP_API_KEY || values.MCP_API_KEY;
  if (!apiKey || apiKey.length < 32 || /replace|example/iu.test(apiKey)) {
    throw new Error('Work Map environment file does not contain a valid MCP_API_KEY');
  }
  return { url: validatedMcpUrl(workMapUrl), apiKey };
}

export async function listEndpoints(options) {
  const envPath = resolve(requiredOption(options, 'env'));
  const env = parseEnvFile(await readFile(envPath, 'utf8'));
  return parseRegistry(env.AGENT_GATEWAY_CONNECTORS_JSON).map(({ id, label, harness }) => ({
    id,
    label,
    harness,
    role: id === env.AGENT_GATEWAY_MASTER_ENDPOINT ? 'master' : 'teammate',
  }));
}

async function atomicSecretWrite(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function parseEnvValue(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/'\\''/gu, "'");
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error('Invalid double-quoted environment value'); }
  }
  return value.replace(/\s+#.*$/u, '');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validatedGatewayUrl(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Gateway URL must use HTTPS (HTTP is allowed only for localhost)');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Gateway URL must not contain credentials, query, or fragment');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

function validatedMcpUrl(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Work Map MCP URL must use HTTPS (HTTP is allowed only for localhost)');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/u, '') !== '/mcp') {
    throw new Error('Work Map MCP URL must end in /mcp and contain no credentials, query, or fragment');
  }
  return url.toString().replace(/\/+$/u, '');
}

function validateHarness(harness) {
  if (!VALID_HARNESSES.has(harness)) throw new Error('Harness must be codex or hermes');
}

function validateEndpointId(id) {
  if (!ENDPOINT_PATTERN.test(String(id ?? ''))) throw new Error('Endpoint ID is invalid');
}

function requiredOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith('--') || args[index + 1] === undefined) throw new Error(`Invalid option: ${flag ?? ''}`);
    options[flag.slice(2)] = args[index + 1];
  }
  return { command, options };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/gateway-admin.mjs add --env .env.gateway --id alice-codex --label "Alice · Codex" --role teammate --harness codex --gateway-url https://agents.example.com --work-map-url https://team.example.com/mcp --work-map-env .env --output /safe/path/alice.env',
    '  node scripts/gateway-admin.mjs rotate --env .env.gateway --id alice-codex --gateway-url https://agents.example.com --work-map-url https://team.example.com/mcp --work-map-env .env --output /safe/path/alice.env',
    '  node scripts/gateway-admin.mjs revoke --env .env.gateway --id alice-codex',
    '  node scripts/gateway-admin.mjs list --env .env.gateway',
  ].join('\n');
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'add') {
    const result = await addEndpoint(options);
    process.stdout.write(`Added ${result.role} endpoint ${result.id}. Secret handoff written to ${result.outputPath}.\nRestart the Gateway to apply the registry.\n`);
    return;
  }
  if (command === 'revoke') {
    const result = await revokeEndpoint(options);
    process.stdout.write(`Revoked endpoint ${result.id}. Restart the Gateway to apply the registry.\n`);
    return;
  }
  if (command === 'rotate') {
    const result = await rotateEndpoint(options);
    process.stdout.write(`Rotated ${result.role} endpoint ${result.id}. Secret handoff written to ${result.outputPath}.\nRestart the Gateway to revoke the old token.\n`);
    return;
  }
  if (command === 'list') {
    for (const endpoint of await listEndpoints(options)) process.stdout.write(`${endpoint.id}\t${endpoint.role}\t${endpoint.label}\t${endpoint.harness}\n`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Gateway admin failed'}\n`);
    process.exitCode = 1;
  });
}
