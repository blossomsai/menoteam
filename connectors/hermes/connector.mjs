#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONVERSATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const SENSITIVE_CHILD_ENV = new Set([
  'AGENT_GATEWAY_MASTER_KEY',
  'AGENT_GATEWAY_CONNECTORS_JSON',
  'MENOTEAM_AGENT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
]);

export const MASTER_INSTRUCTIONS = [
  'You are the Menoteam Master agent reached through one human-visible Slack thread.',
  'Read the shared Work Map before guessing about team goals, ownership, standards, or active work.',
  'Answer directly when you can. If one concrete information gap remains, use Agent Gateway MCP at most once to send one precise request to one online teammate endpoint.',
  'Never route recursively, never invent an endpoint, and use only the exact Slack channel_id and thread_ts supplied in the request.',
  'Never reveal credentials, tokens, private configuration, or hidden reasoning. Never claim an action you did not verify.',
  'Your final answer is posted to the same Slack thread under the MASTER label.',
].join(' ');

export function configFromEnv(env = process.env) {
  if (required(env, 'MENOTEAM_AGENT_HARNESS') !== 'hermes') throw new Error('This Connector requires MENOTEAM_AGENT_HARNESS=hermes');
  if (required(env, 'MENOTEAM_AGENT_ROLE') !== 'master') throw new Error('The Hermes Connector is only supported for the Master role');
  const endpointId = required(env, 'MENOTEAM_AGENT_ENDPOINT');
  if (!ENDPOINT_PATTERN.test(endpointId)) throw new Error('MENOTEAM_AGENT_ENDPOINT is invalid');
  const profile = env.MENOTEAM_HERMES_PROFILE?.trim() || undefined;
  if (profile && !PROFILE_PATTERN.test(profile)) throw new Error('MENOTEAM_HERMES_PROFILE is invalid');
  const conversation = env.MENOTEAM_HERMES_CONVERSATION?.trim() || `menoteam:${endpointId}`;
  if (!CONVERSATION_PATTERN.test(conversation)) throw new Error('MENOTEAM_HERMES_CONVERSATION is invalid');
  const stateRoot = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const lockFile = resolve(env.MENOTEAM_HERMES_LOCK_FILE || join(stateRoot, 'menoteam-hermes', `${endpointId}.lock`));
  return {
    gatewayUrl: validatedBaseUrl(required(env, 'MENOTEAM_GATEWAY_URL'), 'MENOTEAM_GATEWAY_URL'),
    endpointId,
    token: validatedSecret(env, 'MENOTEAM_AGENT_TOKEN'),
    role: 'master',
    harness: 'hermes',
    workMapUrl: validatedMcpUrl(required(env, 'WORK_MAP_MCP_URL')),
    workMapKey: validatedSecret(env, 'WORK_MAP_MCP_API_KEY'),
    masterKey: validatedSecret(env, 'MENOTEAM_MASTER_MCP_KEY'),
    repositoryCwd: resolve(required(env, 'MENOTEAM_REPOSITORY_CWD')),
    lockFile,
    hermesBin: env.HERMES_BIN || 'hermes',
    hermesApiUrl: validatedHermesApiUrl(env.MENOTEAM_HERMES_API_URL || 'http://127.0.0.1:8642'),
    hermesApiKey: validatedSecret(env, 'API_SERVER_KEY'),
    manageHermesGateway: booleanSetting(env.MENOTEAM_MANAGE_HERMES_GATEWAY, true),
    conversation,
    sessionKey: `menoteam:master:${endpointId}`,
    profile,
    pollWaitMs: boundedInteger(env.MENOTEAM_POLL_WAIT_MS, 25_000, 1_000, 30_000),
    turnTimeoutMs: boundedInteger(env.MENOTEAM_TURN_TIMEOUT_MS, 8 * 60_000, 10_000, 9 * 60_000),
    apiStartupTimeoutMs: boundedInteger(env.MENOTEAM_HERMES_API_STARTUP_TIMEOUT_MS, 60_000, 5_000, 5 * 60_000),
  };
}

export class HermesMasterSession {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async assertReady() {
    const response = await this.request('/v1/capabilities', {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    const capabilities = await response.json().catch(() => null);
    if (!capabilities?.features?.responses_api) {
      throw new Error('Hermes API Server does not advertise Responses API support; update Hermes');
    }
  }

  async run(prompt) {
    const response = await this.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: wrapPrompt(prompt),
        instructions: MASTER_INSTRUCTIONS,
        conversation: this.config.conversation,
        store: true,
      }),
      signal: AbortSignal.timeout(this.config.turnTimeoutMs),
    });
    const result = await response.json().catch(() => null);
    if (result?.status !== 'completed') throw new Error('Hermes did not complete the Master turn');
    const text = extractOutputText(result);
    if (!text) throw new Error('Hermes returned no final response');
    if (text.length > 100_000) throw new Error('Hermes response exceeded the Connector limit');
    return text;
  }

  async request(path, init) {
    const response = await this.fetchImpl(`${this.config.hermesApiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.hermesApiKey}`,
        'x-hermes-session-key': this.config.sessionKey,
        ...(init.headers || {}),
      },
    });
    if (!response.ok) throw new HermesHttpError(response.status);
    return response;
  }
}

export function extractOutputText(result) {
  if (typeof result?.output_text === 'string' && result.output_text.trim()) return result.output_text.trim();
  if (!Array.isArray(result?.output)) return '';
  return result.output
    .filter((item) => item?.type === 'message' && item?.role === 'assistant' && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function childEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !SENSITIVE_CHILD_ENV.has(key)));
}

export function hermesGatewayArgs(config) {
  return [...(config.profile ? ['--profile', config.profile] : []), 'gateway'];
}

export function startManagedHermesGateway(config, spawnImpl = spawn) {
  const child = spawnImpl(config.hermesBin, hermesGatewayArgs(config), {
    cwd: config.repositoryCwd,
    env: childEnvironment(process.env),
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: false,
  });
  child.stderr?.resume();
  return child;
}

export function wrapPrompt(prompt) {
  return [
    'This request arrived through the Menoteam Agent Gateway.',
    '',
    'Request:',
    prompt,
  ].join('\n');
}

export function wrapGatewayJob(job) {
  const origin = job?.origin;
  if (!origin || typeof origin.channelId !== 'string' || typeof origin.threadTs !== 'string') return String(job?.prompt ?? '');
  return [
    `Slack routing metadata: channel_id=${origin.channelId} thread_ts=${origin.threadTs}`,
    'Use those exact values only when calling the Agent Gateway routing tool for this request.',
    '',
    String(job.prompt ?? ''),
  ].join('\n');
}

export async function waitForHermesApi(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await session.assertReady();
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof HermesHttpError && [401, 403].includes(error.status)) throw error;
      await delay(500);
    }
  }
  throw new Error(`Hermes API Server did not become ready: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

export async function runConnector(config, session = new HermesMasterSession(config)) {
  if (!(await stat(config.repositoryCwd)).isDirectory()) throw new Error('MENOTEAM_REPOSITORY_CWD must be a directory');
  let retry = 0;
  for (;;) {
    try {
      const job = await pollForJob(config);
      retry = 0;
      if (!job) continue;
      let status = 'completed';
      let text;
      try {
        text = await session.run(wrapGatewayJob(job));
      } catch {
        status = 'failed';
      }
      await submitReply(config, job.id, status, text);
    } catch (error) {
      if (error instanceof GatewayHttpError && [401, 404, 409].includes(error.status)) throw error;
      retry = Math.min(retry + 1, 5);
      await delay(Math.min(1_000 * 2 ** retry, 30_000));
    }
  }
}

async function pollForJob(config) {
  const response = await gatewayFetch(config, `/v1/connectors/${encodeURIComponent(config.endpointId)}/jobs/next?wait_ms=${config.pollWaitMs}`, {
    method: 'GET',
    signal: AbortSignal.timeout(config.pollWaitMs + 10_000),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw await GatewayHttpError.fromResponse(response);
  const job = (await response.json())?.job;
  if (!job || typeof job.id !== 'string' || typeof job.prompt !== 'string') throw new Error('Gateway returned an invalid job');
  return job;
}

async function submitReply(config, jobId, status, text) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await gatewayFetch(config, `/v1/connectors/${encodeURIComponent(config.endpointId)}/jobs/${encodeURIComponent(jobId)}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(status === 'completed' ? { status, text } : { status }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw await GatewayHttpError.fromResponse(response);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof GatewayHttpError && [400, 401, 404].includes(error.status)) throw error;
      await delay(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function gatewayFetch(config, path, init) {
  return fetch(`${config.gatewayUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.token}`, ...(init.headers || {}) },
  });
}

class GatewayHttpError extends Error {
  constructor(status, code) {
    super(`Gateway request failed (${status}${code ? ` ${code}` : ''})`);
    this.status = status;
  }

  static async fromResponse(response) {
    let code;
    try { code = (await response.json())?.error; } catch { /* no response body */ }
    return new GatewayHttpError(response.status, typeof code === 'string' ? code : undefined);
  }
}

class HermesHttpError extends Error {
  constructor(status) {
    super(`Hermes API request failed (${status})`);
    this.status = status;
  }
}

async function acquireLock(lockFile) {
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => unlink(lockFile).catch(() => undefined);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const oldPid = Number((await readFile(lockFile, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(oldPid) && processIsAlive(oldPid)) throw new Error('This Hermes Master endpoint is already running');
      await unlink(lockFile).catch(() => undefined);
    }
  }
  throw new Error('Could not acquire the Hermes Connector lock');
}

function validatedBaseUrl(value, name) {
  const url = new URL(value);
  const isLocal = isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) throw new Error(`${name} must use HTTPS (HTTP is allowed only for localhost)`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, query, or fragment`);
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

function validatedHermesApiUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !isLoopback(url.hostname)) {
    throw new Error('MENOTEAM_HERMES_API_URL must be a loopback HTTP URL');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('MENOTEAM_HERMES_API_URL must not contain credentials, a path, query, or fragment');
  }
  return url.toString().replace(/\/$/u, '');
}

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

function validatedMcpUrl(value) {
  const url = validatedBaseUrl(value, 'WORK_MAP_MCP_URL');
  if (new URL(url).pathname !== '/mcp') throw new Error('WORK_MAP_MCP_URL must end in /mcp');
  return url;
}

function validatedSecret(env, name) {
  const value = required(env, name);
  if (value.length < 32 || /replace|example/iu.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function booleanSetting(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Invalid boolean Connector setting');
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error('Invalid numeric Connector setting');
  return number;
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function gatewayExit(child) {
  return new Promise((_, reject) => {
    child.once('error', () => reject(new Error('Hermes gateway could not start')));
    child.once('exit', (code) => reject(new Error(`Hermes gateway stopped (${code ?? 'signal'})`)));
  });
}

async function main() {
  const config = configFromEnv();
  const releaseLock = await acquireLock(config.lockFile);
  let gateway;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await releaseLock();
  };
  const shutdown = async () => {
    gateway?.kill('SIGTERM');
    await release();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    if (!(await stat(config.repositoryCwd)).isDirectory()) throw new Error('MENOTEAM_REPOSITORY_CWD must be a directory');
    const session = new HermesMasterSession(config);
    const gatewayStopped = config.manageHermesGateway
      ? gatewayExit(gateway = startManagedHermesGateway(config))
      : new Promise(() => undefined);
    await Promise.race([waitForHermesApi(session, config.apiStartupTimeoutMs), gatewayStopped]);
    process.stdout.write(`Menoteam Hermes Master online: ${config.endpointId}\n`);
    await Promise.race([runConnector(config, session), gatewayStopped]);
  } finally {
    gateway?.kill('SIGTERM');
    await release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write(`Menoteam Hermes Connector stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
