#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const SENSITIVE_CHILD_ENV = new Set([
  'AGENT_GATEWAY_MASTER_KEY',
  'AGENT_GATEWAY_CONNECTORS_JSON',
  'MENOTEAM_AGENT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
]);

export function configFromEnv(env = process.env) {
  const harness = env.MENOTEAM_AGENT_HARNESS || 'codex';
  if (harness !== 'codex') throw new Error('This Connector requires MENOTEAM_AGENT_HARNESS=codex');
  const endpointId = required(env, 'MENOTEAM_AGENT_ENDPOINT');
  if (!ENDPOINT_PATTERN.test(endpointId)) throw new Error('MENOTEAM_AGENT_ENDPOINT is invalid');
  const gatewayUrl = new URL(required(env, 'MENOTEAM_GATEWAY_URL'));
  const isLocal = gatewayUrl.hostname === 'localhost' || gatewayUrl.hostname === '127.0.0.1' || gatewayUrl.hostname === '::1';
  if (gatewayUrl.protocol !== 'https:' && !(isLocal && gatewayUrl.protocol === 'http:')) {
    throw new Error('MENOTEAM_GATEWAY_URL must use HTTPS (HTTP is allowed only for localhost)');
  }
  gatewayUrl.pathname = gatewayUrl.pathname.replace(/\/$/u, '');
  const token = required(env, 'MENOTEAM_AGENT_TOKEN');
  if (token.length < 32 || /replace|example/iu.test(token)) throw new Error('MENOTEAM_AGENT_TOKEN is missing or invalid');
  const workMapUrl = validatedMcpUrl(required(env, 'WORK_MAP_MCP_URL'));
  const workMapKey = required(env, 'WORK_MAP_MCP_API_KEY');
  if (workMapKey.length < 32 || /replace|example/iu.test(workMapKey)) throw new Error('WORK_MAP_MCP_API_KEY is missing or invalid');
  const repositoryCwd = resolve(required(env, 'MENOTEAM_REPOSITORY_CWD'));
  const stateRoot = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const stateFile = resolve(env.MENOTEAM_AGENT_STATE_FILE || join(stateRoot, 'menoteam-agent', `${endpointId}.json`));
  return {
    gatewayUrl: gatewayUrl.toString().replace(/\/$/u, ''),
    harness,
    endpointId,
    token,
    workMapUrl,
    workMapKey,
    repositoryCwd,
    stateFile,
    lockFile: `${stateFile}.lock`,
    codexBin: env.CODEX_BIN || 'codex',
    role: agentRole(env.MENOTEAM_AGENT_ROLE),
    pollWaitMs: boundedInteger(env.MENOTEAM_POLL_WAIT_MS, 25_000, 1_000, 30_000),
    turnTimeoutMs: boundedInteger(env.MENOTEAM_TURN_TIMEOUT_MS, 8 * 60_000, 10_000, 15 * 60_000),
  };
}

function validatedMcpUrl(value) {
  const url = new URL(value);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) throw new Error('WORK_MAP_MCP_URL must use HTTPS (HTTP is allowed only for localhost)');
  if (url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/+$/u, '').endsWith('/mcp')) {
    throw new Error('WORK_MAP_MCP_URL must end in /mcp and contain no credentials, query, or fragment');
  }
  return url.toString().replace(/\/+$/u, '');
}

export class JsonRpcClient {
  constructor(input, output) {
    this.input = input;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    let buffered = '';
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      buffered += chunk;
      for (;;) {
        const end = buffered.indexOf('\n');
        if (end < 0) break;
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message || 'Codex RPC error'));
          else pending.resolve(message.result);
          continue;
        }
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    this.input.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, params) {
    this.input.write(`${JSON.stringify({ method, params })}\n`);
  }

  rejectServerRequest(id) {
    this.input.write(`${JSON.stringify({ id, error: { code: -32601, message: 'Interactive requests are unavailable through the Menoteam Connector' } })}\n`);
  }
}

export class CodexLinkedSession {
  constructor(config) {
    this.config = config;
  }

  async run(prompt) {
    const child = spawn(this.config.codexBin, ['app-server'], {
      cwd: this.config.repositoryCwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: childEnvironment(process.env),
      shell: false,
    });
    const rpc = new JsonRpcClient(child.stdin, child.stdout);
    const failed = new Promise((_, reject) => {
      child.once('error', () => reject(new Error('Codex process could not start')));
      child.once('exit', (code) => reject(new Error(`Codex process exited (${code ?? 'signal'})`)));
    });
    try {
      return await Promise.race([
        this.runProtocol(rpc, wrapPrompt(prompt, this.config.role)),
        failed,
        timeout(this.config.turnTimeoutMs, 'Codex turn timed out'),
      ]);
    } finally {
      child.stdin.end();
      setTimeout(() => child.kill('SIGTERM'), 500).unref();
    }
  }

  async runProtocol(rpc, prompt) {
    await rpc.request('initialize', { clientInfo: { name: 'menoteam-agent-connector', version: '0.1.0' } });
    rpc.notify('initialized', {});
    const savedThreadId = await readThreadId(this.config.stateFile);
    const boundary = {
      cwd: this.config.repositoryCwd,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    };
    let thread;
    try {
      thread = savedThreadId
        ? await rpc.request('thread/resume', { threadId: savedThreadId, ...boundary })
        : await rpc.request('thread/start', boundary);
    } catch (error) {
      if (!savedThreadId || !/thread.+not found|unknown thread/iu.test(String(error?.message))) throw error;
      thread = await rpc.request('thread/start', boundary);
    }
    const threadId = thread?.thread?.id ?? thread?.id;
    if (!threadId) throw new Error('Codex did not return a thread ID');
    await writeThreadId(this.config.stateFile, threadId);

    const messages = [];
    let turnId;
    let resolveComplete;
    let rejectComplete;
    const complete = new Promise((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    const listener = (message) => {
      if (message.id !== undefined && message.method) {
        rpc.rejectServerRequest(message.id);
        return;
      }
      if (message.params?.threadId !== threadId) return;
      const messageTurnId = message.params?.turnId ?? message.params?.turn?.id;
      if (turnId && messageTurnId && messageTurnId !== turnId) return;
      const item = message.params?.item;
      if (message.method === 'item/completed' && item?.type === 'agentMessage' && item.text) messages.push(item.text);
      if (message.method === 'turn/completed') {
        const turn = message.params?.turn;
        if (turn?.status === 'failed') rejectComplete(new Error('Codex turn failed'));
        else resolveComplete(messages.at(-1) ?? turn?.output_text ?? '');
      }
    };
    rpc.listeners.add(listener);
    try {
      const started = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
      turnId = started?.turn?.id;
      if (!turnId) throw new Error('Codex did not return a turn ID');
      return await complete;
    } finally {
      rpc.listeners.delete(listener);
    }
  }
}

export function childEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !SENSITIVE_CHILD_ENV.has(key)));
}

export function wrapPrompt(prompt, role = 'teammate') {
  const routePolicy = role === 'master'
    ? 'If shared context is insufficient, you may use the configured Agent Gateway MCP once to route one precise gap to one online endpoint, using the exact Slack routing metadata below.'
    : 'Do not route to another agent; this request is already the single allowed routing hop.';
  return [
    'You were contacted through the Menoteam Agent Gateway by a human-visible Slack thread.',
    `Answer the request directly. ${routePolicy}`,
    'Never reveal secrets or claim actions you did not verify.',
    'Your final answer will be posted back to that Slack thread under your configured speaker label.',
    '',
    'Request:',
    prompt,
  ].join('\n');
}

export function wrapGatewayJob(job, role = 'teammate') {
  if (role !== 'master') return String(job?.prompt ?? '');
  const origin = job?.origin;
  if (!origin || typeof origin.channelId !== 'string' || typeof origin.threadTs !== 'string') return String(job?.prompt ?? '');
  return [
    `Slack routing metadata: channel_id=${origin.channelId} thread_ts=${origin.threadTs}`,
    'Use those exact values only when calling the Agent Gateway routing tool for this request.',
    '',
    String(job.prompt ?? ''),
  ].join('\n');
}

export async function runConnector(config) {
  if (!(await stat(config.repositoryCwd)).isDirectory()) throw new Error('MENOTEAM_REPOSITORY_CWD must be a directory');
  const session = new CodexLinkedSession(config);
  let retry = 0;
  for (;;) {
    try {
      const job = await pollForJob(config);
      retry = 0;
      if (!job) continue;
      let status = 'completed';
      let text;
      try {
        text = await session.run(wrapGatewayJob(job, config.role));
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
  const body = await response.json();
  const job = body?.job;
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
        body: JSON.stringify(status === 'completed' ? { status, text: String(text || 'Codex returned no text.') } : { status }),
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
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(init.headers || {}),
    },
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

async function readThreadId(stateFile) {
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    return typeof state.threadId === 'string' && state.threadId ? state.threadId : null;
  } catch {
    return null;
  }
}

async function writeThreadId(stateFile, threadId) {
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ threadId })}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, stateFile);
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
      if (Number.isInteger(oldPid) && processIsAlive(oldPid)) throw new Error('This Menoteam endpoint is already running');
      await unlink(lockFile).catch(() => undefined);
    }
  }
  throw new Error('Could not acquire the Menoteam Connector lock');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function agentRole(value) {
  if (value === undefined || value === '' || value === 'teammate') return 'teammate';
  if (value === 'master') return 'master';
  throw new Error('MENOTEAM_AGENT_ROLE must be teammate or master');
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error('Invalid numeric connector setting');
  return number;
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function main() {
  const config = configFromEnv();
  const releaseLock = await acquireLock(config.lockFile);
  const shutdown = async () => {
    await releaseLock();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(`Menoteam Connector online: ${config.endpointId}\n`);
  try {
    await runConnector(config);
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write(`Menoteam Connector stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
