#!/usr/bin/env node

import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';

const REQUIRED_MCP_TOOLS = ['list', 'search', 'read', 'create_work', 'update_work', 'update_teammate'];
const MIN_SECRET_LENGTH = 32;
const MASTER_SKILL_NAMES = ['master'];
const PLACEHOLDER = /^(?:<|\$\{|set[-_ ]?this|replace[-_ ]?with|read[-_ ]?this|change[-_ ]?me|your[-_ ]|todo|example)/iu;
const REF = /^teammate_[A-Za-z0-9_-]+$/u;
const HARNESS = {
  hermes: { command: 'hermes', config: ['.hermes/config.yaml', '.hermes/.env'], discord: true },
  openclaw: { command: 'openclaw', config: ['.openclaw/openclaw.json5', '.openclaw/openclaw.json', '.openclaw/config.json', '.openclaw/.env'], discord: true },
  codex: { command: 'codex', config: ['config.toml'], discord: false },
};
const COMMON_EXECUTABLES = {
  hermes: [join(homedir(), '.local/bin/hermes')],
  codex: ['/Applications/ChatGPT.app/Contents/Resources/codex'],
  openclaw: [join(homedir(), '.local/bin/openclaw')],
};

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printUsage();
} else if (options.selfTest) {
  selfTest();
} else {
  const result = await run(options);
  printChecks(result.checks, options.json);
  process.exitCode = result.failed ? 1 : 0;
}

async function run(input) {
  const checks = [];
  const env = process.env;
  const urlValue = input.url ?? env.WORK_MAP_MCP_URL;
  const apiKey = env.WORK_MAP_MCP_API_KEY;
  const teammateRef = input.teammateRef ?? env.WORK_MAP_TEAMMATE_REF;
  const agentAddress = input.agentAddress ?? env.WORK_MAP_AGENT_ADDRESS;
  const harnessName = input.harness ?? env.WORK_MAP_HARNESS;
  const role = input.role ?? env.WORK_MAP_ROLE ?? 'team-agent';
  const channel = input.channel ?? env.WORK_MAP_CHANNEL ?? 'discord';
  const masterMention = input.masterMention ?? env.WORK_MAP_MASTER_MENTION;
  const discordChannelId = input.discordChannelId ?? env.DISCORD_CHANNEL_ID;

  const mcpUrl = parseMcpUrl(urlValue);
  if (mcpUrl) pass(checks, 'Work Map URL format is valid');
  else fail(checks, 'WORK_MAP_MCP_URL must be an https URL ending in /mcp (localhost may use http)');

  if (usableSecret(apiKey)) pass(checks, 'WORK_MAP_MCP_API_KEY is present (value hidden)');
  else fail(checks, 'WORK_MAP_MCP_API_KEY is missing, too short, or still a template placeholder');

  if (typeof teammateRef === 'string' && REF.test(teammateRef)) pass(checks, 'Teammate reference format is valid');
  else fail(checks, 'WORK_MAP_TEAMMATE_REF must look like teammate_alice');

  if (usableAddress(agentAddress)) pass(checks, 'Native agent address is present (value hidden)');
  else fail(checks, 'WORK_MAP_AGENT_ADDRESS is missing or still a template placeholder');

  if (role === 'master' || role === 'team-agent') pass(checks, `Agent role is ${role}`);
  else fail(checks, 'WORK_MAP_ROLE must be master or team-agent');

  if (channel === 'discord' || channel === 'none') pass(checks, `Channel is ${channel}`);
  else fail(checks, 'WORK_MAP_CHANNEL must be discord or none');

  const harness = HARNESS[harnessName];
  if (harness) {
    const executable = findExecutable(harness.command);
    if (!executable) {
      fail(checks, `${harness.command} is not available on PATH`);
    } else if (!probeExecutable(executable)) {
      fail(checks, `${harness.command} is present but its version probe failed`);
    } else {
      pass(checks, `${harness.command} CLI is available`);
    }

    const configRoot = harnessName === 'codex' ? (process.env.CODEX_HOME ?? join(homedir(), '.codex')) : homedir();
    const configPaths = harness.config.map((relative) => join(configRoot, relative));
    if (configPaths.some((path) => existsSync(path))) {
      pass(checks, `${harnessName} native config exists (contents not printed)`);
    } else {
      fail(checks, `${harnessName} native config was not found under the expected home directory`);
    }

    if (harnessName === 'codex' && executable && probeCodexMcp(executable)) {
      pass(checks, 'Codex work-map MCP registration is present');
    } else if (harnessName === 'codex') {
      fail(checks, 'Codex work-map MCP registration was not found; run codex mcp add after injecting the key');
    }

    if (harnessName === 'hermes') {
      const skillName = role === 'master' ? 'master' : 'team-agent';
      if (hasTrustedHermesSkill(skillName)) pass(checks, `Hermes ${skillName} Skill is installed inside its trusted skill root`);
      else fail(checks, `Hermes ${skillName} Skill is missing or resolves outside ~/.hermes/skills; install a reviewed copy, not an external symlink`);
    }

    if (channel === 'discord' && !harness.discord) {
      fail(checks, 'Codex has no native Discord gateway; use Hermes or OpenClaw for Discord delivery');
    }

    if (channel === 'discord') {
      if (masterMention === '@Master') pass(checks, 'Discord activation is explicitly @Master');
      else fail(checks, 'WORK_MAP_MASTER_MENTION must be set to @Master');

      if (hasDiscordToken(harness.config)) {
        pass(checks, 'Native Discord credential is present (value hidden)');
      } else {
        fail(checks, 'Native Discord credential was not detected; inject it through the selected harness secret path');
      }

      if (harnessName === 'hermes') {
        if (/^\d{5,25}$/u.test(String(discordChannelId ?? ''))) pass(checks, 'Discord channel ID is present');
        else fail(checks, 'DISCORD_CHANNEL_ID must be the selected Discord channel snowflake');

        const configPath = join(homedir(), '.hermes/config.yaml');
        const binding = readHermesDiscordBinding(configPath, discordChannelId);
        if (binding.ok) pass(checks, 'Hermes binds the selected channel to the Work Map Master skill at gateway start');
        else fail(checks, `Hermes Discord binding is incomplete: ${binding.reason}`);
      }

      warn(checks, 'Guild/channel/user allowlists and one real mention/reply remain operator proof in native Discord');
    }
  } else {
    fail(checks, 'WORK_MAP_HARNESS must be hermes, openclaw, or codex');
  }

  const structuralReady = mcpUrl && usableSecret(apiKey) && REF.test(String(teammateRef ?? '')) && usableAddress(agentAddress);
  if (input.noNetwork) {
    warn(checks, 'Network checks skipped by --no-network; run without it before onboarding');
  } else if (structuralReady) {
    await checkRemote(mcpUrl, apiKey, teammateRef, channel, checks);
  } else {
    warn(checks, 'Remote checks skipped because required local values are missing');
  }

  return { checks, failed: checks.some((check) => check.status === 'fail') };
}

async function checkRemote(mcpUrl, apiKey, teammateRef, channel, checks) {
  try {
    const healthUrl = new URL(mcpUrl.href);
    healthUrl.pathname = healthUrl.pathname.replace(/\/mcp\/?$/u, '/healthz');
    const health = await fetch(healthUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    const healthBody = await readJson(health);
    if (!health.ok || healthBody?.status !== 'ok') {
      fail(checks, `Work Map /healthz is not healthy (HTTP ${health.status})`);
      return;
    }
    pass(checks, 'Work Map /healthz is healthy');

    const initialize = await rpc(mcpUrl, apiKey, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'menoteam-onboarding-check', version: '1.0.0' },
      },
    });
    if (initialize.error || !initialize.result) {
      fail(checks, 'Authenticated MCP initialize failed');
      return;
    }
    pass(checks, 'Authenticated MCP initialize succeeded');

    const sessionId = initialize.sessionId;
    await rpc(mcpUrl, apiKey, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sessionId);
    const tools = await rpc(mcpUrl, apiKey, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
    const names = Array.isArray(tools.result?.tools) ? tools.result.tools.map((tool) => tool?.name) : [];
    const missing = REQUIRED_MCP_TOOLS.filter((name) => !names.includes(name));
    if (tools.error || missing.length) {
      fail(checks, missing.length ? `MCP tool list is missing: ${missing.join(', ')}` : 'Authenticated MCP tools/list failed');
      return;
    }
    pass(checks, 'Authenticated MCP exposes all six V1 tools');

    const read = await rpc(mcpUrl, apiKey, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read', arguments: { ref: teammateRef } },
    }, sessionId);
    const entity = extractEntity(read.result);
    if (read.error || !entity || entity.ref !== teammateRef) {
      fail(checks, 'Teammate record could not be read through authenticated MCP');
      return;
    }
    const addresses = entity.default_agent_addresses;
    if (channel === 'discord' && addresses?.discord === agentAddress) {
      pass(checks, 'Teammate record is readable and matches the supplied Discord route');
    } else if (channel === 'none') {
      pass(checks, 'Teammate record is readable');
    } else if (channel === 'discord' && addresses?.discord) {
      fail(checks, 'Teammate record has a different Discord route; reconcile it through native MCP after human confirmation');
    } else {
      fail(checks, 'Teammate record is readable but has no Discord route; update it through native MCP after human confirmation');
    }
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    fail(checks, `Work Map remote checks ${reason}`);
  }
}

async function rpc(url, apiKey, message, sessionId) {
  const headers = {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(10_000) });
  const body = await readRpc(response);
  if (!response.ok) return { error: true, status: response.status, sessionId: response.headers.get('mcp-session-id') };
  return { ...(body ?? {}), sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function readRpc(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const data = text.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).pop();
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractEntity(result) {
  if (result?.structuredContent?.entity) return result.structuredContent.entity;
  const text = result?.content?.find((item) => item?.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text)?.entity ?? null;
  } catch {
    return null;
  }
}

function parseMcpUrl(value) {
  if (typeof value !== 'string' || !value.trim() || PLACEHOLDER.test(value.trim())) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const documentationHost = url.hostname === 'example.com' || url.hostname.endsWith('.example.com') || url.hostname === 'example.net' || url.hostname.endsWith('.example.net') || url.hostname === 'example.org' || url.hostname.endsWith('.example.org');
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || documentationHost || url.username || url.password || url.hash || !/\/mcp\/?$/u.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

function usableSecret(value) {
  return typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH && !PLACEHOLDER.test(value.trim());
}

function usableAddress(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value) && !PLACEHOLDER.test(value.trim());
}

function hasDiscordToken(relativePaths) {
  if (usableSecret(process.env.DISCORD_BOT_TOKEN)) return true;
  return relativePaths.some((relative) => {
    const path = join(homedir(), relative);
    if (!existsSync(path)) return false;
    let contents;
    try {
      contents = readFileSync(path, 'utf8');
    } catch {
      return false;
    }
    return usableSecret(extractDiscordToken(contents));
  });
}

function extractDiscordToken(contents) {
  for (const line of String(contents).split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?DISCORD_BOT_TOKEN\s*=\s*["']?([^\s"'#]+)["']?/u);
    if (match) return match[1];
  }
  return undefined;
}

function readHermesDiscordBinding(path, channelId) {
  if (!/^\d{5,25}$/u.test(String(channelId ?? ''))) return { ok: false, reason: 'selected channel ID is missing' };
  if (!existsSync(path)) return { ok: false, reason: '~/.hermes/config.yaml was not found' };
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'config could not be read' };
  }
  return parseHermesDiscordBinding(contents, channelId);
}

function hasTrustedHermesSkill(skillName) {
  try {
    const root = realpathSync(join(homedir(), '.hermes/skills'));
    const file = realpathSync(join(root, skillName, 'SKILL.md'));
    const fromRoot = relative(root, file);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return false;
    const contents = readFileSync(file, 'utf8');
    return new RegExp(`^---[\\s\\S]*?^name\\s*:\\s*["']?${escapeRegExp(skillName)}["']?\\s*$[\\s\\S]*?^---$`, 'mu').test(contents);
  } catch {
    return false;
  }
}

function parseHermesDiscordBinding(contents, channelId) {
  const discord = section(contents, 'discord');
  const bindings = section(discord, 'channel_skill_bindings');
  if (!/require_mention\s*:\s*true(?:\s|$)/u.test(discord)) return { ok: false, reason: 'require_mention is not true' };
  if (!/thread_require_mention\s*:\s*true(?:\s|$)/u.test(discord)) return { ok: false, reason: 'thread_require_mention is not true' };
  const entries = bindings.split(/(?=^\s*-\s*id\s*:)/mu).filter((entry) => /^\s*-\s*id\s*:/mu.test(entry));
  const selected = entries.find((entry) => {
    const match = entry.match(/^\s*-\s*id\s*:\s*["']?([^\s"'#]+)["']?/mu);
    return match?.[1] === String(channelId);
  });
  if (!selected) return { ok: false, reason: 'selected channel ID is not bound' };
  const selectedActive = selected.split(/\r?\n/u).map((line) => line.replace(/\s+#.*$/u, '')).join('\n');
  const skillTokens = selectedActive.match(/[A-Za-z0-9_-]+/gu) ?? [];
  const skills = MASTER_SKILL_NAMES.some((name) => skillTokens.includes(name));
  if (!skills) return { ok: false, reason: 'selected channel is not bound to the registered master skill' };
  return { ok: true };
}

function section(contents, key) {
  const match = String(contents).match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*:\\s*\\n([\\s\\S]*?)(?=\\n\\S|$)`));
  return match?.[1] ?? '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function findExecutable(command) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, command);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Keep searching without printing the path or command output.
    }
  }
  for (const path of COMMON_EXECUTABLES[command] ?? []) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Keep searching common install paths.
    }
  }
  return null;
}

function probeExecutable(path) {
  const result = spawnSync(path, ['--version'], { stdio: 'ignore', timeout: 5_000 });
  return !result.error && result.status === 0;
}

function probeCodexMcp(path) {
  const result = spawnSync(path, ['mcp', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
  return !result.error && result.status === 0 && /(?:^|\s)work-map(?:\s|$)/imu.test(`${result.stdout ?? ''}`);
}

function parseArgs(args) {
  const options = { noNetwork: false, json: false, help: false, selfTest: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--no-network') options.noNetwork = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (['--url', '--harness', '--role', '--channel', '--teammate-ref', '--agent-address', '--master-mention', '--discord-channel-id'].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[{ '--url': 'url', '--harness': 'harness', '--role': 'role', '--channel': 'channel', '--teammate-ref': 'teammateRef', '--agent-address': 'agentAddress', '--master-mention': 'masterMention', '--discord-channel-id': 'discordChannelId' }[arg]] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`Usage: pnpm onboarding:check -- [options]

Required environment: WORK_MAP_MCP_URL, WORK_MAP_MCP_API_KEY,
WORK_MAP_TEAMMATE_REF, WORK_MAP_AGENT_ADDRESS, WORK_MAP_HARNESS.
Hermes/Discord additionally requires DISCORD_CHANNEL_ID and the native
DISCORD_BOT_TOKEN secret path.

Options: --harness hermes|openclaw|codex, --role master|team-agent,
--channel discord|none, --discord-channel-id ID, --no-network, --json,
--self-test`);
}

function printChecks(checks, json) {
  if (json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }
  for (const check of checks) console.log(`${icon(check.status)} ${check.message}`);
  console.log(checks.some((check) => check.status === 'fail') ? '\nOnboarding preflight failed.' : '\nOnboarding preflight passed; complete any native Discord proof warning before calling it connected.');
}

function pass(checks, message) {
  checks.push({ status: 'pass', message });
}

function fail(checks, message) {
  checks.push({ status: 'fail', message });
}

function warn(checks, message) {
  checks.push({ status: 'warn', message });
}

function icon(status) {
  return status === 'pass' ? '✓' : status === 'fail' ? '✗' : '⚠';
}

function selfTest() {
  assert.ok(parseMcpUrl('https://work-map.invalid/mcp')?.pathname === '/mcp');
  assert.ok(parseMcpUrl('http://localhost:3000/mcp'));
  assert.equal(parseMcpUrl('https://team.example.com/mcp'), null);
  assert.equal(parseMcpUrl('https://team.example.net/not-mcp'), null);
  assert.equal(usableSecret('replace-with-a-long-random-secret'), false);
  assert.equal(usableSecret('x'.repeat(MIN_SECRET_LENGTH)), true);
  assert.ok(REF.test('teammate_alice'));
  assert.equal(REF.test('alice'), false);
  assert.equal(usableAddress('replace-with-native-discord-address'), false);
  const validHermes = `discord:\n  require_mention: true\n  thread_require_mention: true\n  channel_skill_bindings:\n    - id: "123456"\n      skills: ["master"]\n`;
  assert.equal(parseHermesDiscordBinding(validHermes, '123456').ok, true);
  const unsafeHermes = validHermes.replace('thread_require_mention: true', 'thread_require_mention: false');
  assert.equal(parseHermesDiscordBinding(unsafeHermes, '123456').ok, false);
  const wrongChannelSkill = `discord:\n  require_mention: true\n  thread_require_mention: true\n  channel_skill_bindings:\n    - id: "123456"\n      skills: ["unrelated"]\n    - id: "999999"\n      skills: ["master"]\n`;
  assert.equal(parseHermesDiscordBinding(wrongChannelSkill, '123456').ok, false);
  assert.equal(extractDiscordToken('# DISCORD_BOT_TOKEN=' + 'x'.repeat(MIN_SECRET_LENGTH)), undefined);
  assert.equal(extractDiscordToken('DISCORD_BOT_TOKEN=' + 'x'.repeat(MIN_SECRET_LENGTH)), 'x'.repeat(MIN_SECRET_LENGTH));
  console.log('onboarding preflight self-test passed');
}
