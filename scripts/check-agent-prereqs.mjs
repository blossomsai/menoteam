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
  hermes: { command: 'hermes', config: ['.hermes/config.yaml', '.hermes/.env'], nativeChannels: ['discord'] },
  openclaw: { command: 'openclaw', config: ['.openclaw/openclaw.json5', '.openclaw/openclaw.json', '.openclaw/config.json', '.openclaw/.env'], nativeChannels: ['discord'] },
  codex: { command: 'codex', config: ['config.toml'], nativeChannels: [] },
  pi: { generic: true },
  other: { generic: true },
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
  const teammateRouteRequired = roleNeedsTeammateRoute(role);

  const mcpUrl = parseMcpUrl(urlValue);
  if (mcpUrl) pass(checks, 'Work Map URL format is valid');
  else fail(checks, 'WORK_MAP_MCP_URL must be an https URL ending in /mcp (localhost may use http)');

  if (usableSecret(apiKey)) pass(checks, 'WORK_MAP_MCP_API_KEY is present (value hidden)');
  else fail(checks, 'WORK_MAP_MCP_API_KEY is missing, too short, or still a template placeholder');

  if (!teammateRouteRequired || (typeof teammateRef === 'string' && REF.test(teammateRef))) pass(checks, teammateRouteRequired ? 'Teammate reference format is valid' : 'Master does not require a teammate owner reference');
  else fail(checks, 'WORK_MAP_TEAMMATE_REF must look like teammate_alice');

  if (!teammateRouteRequired || usableAddress(agentAddress)) pass(checks, teammateRouteRequired ? 'Native agent address is present (value hidden)' : 'Master address is owned by the native harness (no teammate address required)');
  else fail(checks, 'WORK_MAP_AGENT_ADDRESS is missing or still a template placeholder');

  if (role === 'master' || role === 'team-agent') pass(checks, `Agent role is ${role}`);
  else fail(checks, 'WORK_MAP_ROLE must be master or team-agent');

  if (channel === 'discord' || channel === 'slack' || channel === 'none') pass(checks, `Channel is ${channel}`);
  else fail(checks, 'WORK_MAP_CHANNEL must be discord, slack, or none');

  const harness = HARNESS[harnessName];
  if (harness) {
    let executable = null;
    if (harness.generic) {
      warn(checks, `${harnessName} uses the generic MCP/Skill path; executable, config, and native channel checks remain harness-owned`);
    } else {
      executable = findExecutable(harness.command);
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

    if (channel !== 'none' && !harness.generic && !harness.nativeChannels.includes(channel)) {
      const reason = harnessName === 'codex' && channel === 'discord'
        ? 'Codex has no native Discord gateway in this setup; Work Map MCP registration alone cannot wake a local Codex app. Use WORK_MAP_CHANNEL=none or a harness with native Discord delivery'
        : `${harnessName} has no verified native ${channel} gateway; use a harness with native ${channel} delivery`;
      fail(checks, reason);
    }

    if (channel !== 'none') {
      if (masterMention === '@Master') pass(checks, 'Channel activation is explicitly @Master');
      else fail(checks, 'WORK_MAP_MASTER_MENTION must be set to @Master');

      if (harness.generic) {
        warn(checks, `Native ${channel} credential and route are delegated to ${harnessName}; complete the harness's own allowlist and mention/reply proof`);
      } else if (channel === 'discord') {
        if (hasDiscordToken(harness.config)) {
          pass(checks, 'Native Discord credential is present (value hidden)');
        } else {
          fail(checks, 'Native Discord credential was not detected; inject it through the selected harness secret path');
        }
      }

      if (channel === 'discord' && harnessName === 'hermes') {
        if (/^\d{5,25}$/u.test(String(discordChannelId ?? ''))) pass(checks, 'Discord channel ID is present');
        else fail(checks, 'DISCORD_CHANNEL_ID must be the selected Discord channel snowflake');

        const configPath = join(homedir(), '.hermes/config.yaml');
        const binding = readHermesDiscordBinding(configPath, discordChannelId);
        if (binding.ok) pass(checks, 'Hermes binds the selected channel to the Work Map Master skill at gateway start');
        else fail(checks, `Hermes Discord binding is incomplete: ${binding.reason}`);
      }

      warn(checks, `${channel[0].toUpperCase()}${channel.slice(1)} guild/channel/user allowlists and one real mention/reply remain operator proof in the native harness`);
    }
  } else {
    fail(checks, 'WORK_MAP_HARNESS must be hermes, openclaw, codex, pi, or other');
  }

  const structuralReady = mcpUrl && usableSecret(apiKey) && (!teammateRouteRequired || (REF.test(String(teammateRef ?? '')) && usableAddress(agentAddress)));
  if (input.noNetwork) {
    warn(checks, 'Network checks skipped by --no-network; run without it before onboarding');
  } else if (structuralReady) {
    await checkRemote(mcpUrl, apiKey, teammateRef, agentAddress, channel, role, checks);
  } else {
    warn(checks, 'Remote checks skipped because required local values are missing');
  }

  return { checks, failed: checks.some((check) => check.status === 'fail') };
}

async function checkRemote(mcpUrl, apiKey, teammateRef, agentAddress, channel, role, checks) {
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

    if (role === 'master') {
      const list = await rpc(mcpUrl, apiKey, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list', arguments: { kind: 'work', filters: {}, limit: 1 } },
      }, sessionId);
      const page = list.result?.structuredContent;
      if (list.error || !page || !Array.isArray(page.items) || typeof page.total_count !== 'number') {
        fail(checks, 'Master could not read the shared Work Map through authenticated MCP');
      } else {
        pass(checks, 'Master can read the shared Work Map through authenticated MCP');
      }
      return;
    }

    const read = await rpc(mcpUrl, apiKey, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read', arguments: { ref: teammateRef } },
    }, sessionId);
    const entity = extractEntity(read.result);
    if (read.error || !entity || entity.ref !== teammateRef) {
      fail(checks, 'Teammate record could not be read through authenticated MCP');
      return;
    }
    const addresses = entity.default_agent_addresses;
    if (channel !== 'none' && addresses?.[channel] === agentAddress) {
      pass(checks, `Teammate record is readable and matches the supplied ${channel} route`);
    } else if (channel === 'none') {
      pass(checks, 'Teammate record is readable');
    } else if (channel !== 'none' && addresses?.[channel]) {
      fail(checks, `Teammate record has a different ${channel} route; reconcile it through native MCP after human confirmation`);
    } else {
      fail(checks, `Teammate record is readable but has no ${channel} route; update it through native MCP after human confirmation`);
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

function roleNeedsTeammateRoute(role) {
  return role === 'team-agent';
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
  return parseHermesDiscordBinding(contents, channelId, process.env);
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

function parseHermesDiscordBinding(contents, channelId, environment = process.env) {
  const discord = section(contents, 'discord');
  const bindings = section(discord, 'channel_skill_bindings');
  if (!/require_mention\s*:\s*true(?:\s|$)/u.test(discord)) return { ok: false, reason: 'require_mention is not true' };
  if (!/thread_require_mention\s*:\s*true(?:\s|$)/u.test(discord)) return { ok: false, reason: 'thread_require_mention is not true' };
  if (!settingIsFalse(discord, 'history_backfill', environment.DISCORD_HISTORY_BACKFILL)) return { ok: false, reason: 'history_backfill must be false for explicit-mention privacy' };
  if (!settingIsFalse(discord, 'auto_thread', environment.DISCORD_AUTO_THREAD)) return { ok: false, reason: 'auto_thread must be false for the selected inline channel' };
  if (!settingIsFalse(discord, 'reactions', environment.DISCORD_REACTIONS)) return { ok: false, reason: 'reactions must be false for the selected channel' };
  if (!settingIsTrue(discord, 'bots_require_inline_mention', environment.DISCORD_BOTS_REQUIRE_INLINE_MENTION)) return { ok: false, reason: 'bots_require_inline_mention must be true for multi-agent safety' };
  if (String(environment.DISCORD_ALLOW_BOTS ?? '').trim().toLowerCase() !== 'mentions') return { ok: false, reason: 'DISCORD_ALLOW_BOTS must be mentions for multi-agent safety' };
  const allowedChannels = configuredAllowedChannels(discord, environment);
  if (!allowedChannels.values.includes(String(channelId)) || allowedChannels.values.includes('*')) return { ok: false, reason: `${allowedChannels.source} must explicitly allow the selected channel and must not use a wildcard` };
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

function settingIsFalse(contents, key, environmentValue) {
  if (environmentValue !== undefined && String(environmentValue).trim() !== '') return isFalseSetting(environmentValue);
  return new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*:\\s*false(?:\\s|$)`, 'iu').test(contents);
}

function settingIsTrue(contents, key, environmentValue) {
  if (environmentValue !== undefined && String(environmentValue).trim() !== '') return /^(?:true|1|yes|on)$/iu.test(String(environmentValue).trim());
  return new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*:\\s*true(?:\\s|$)`, 'iu').test(contents);
}

function configuredAllowedChannels(contents, environment) {
  const environmentValue = String(environment.DISCORD_ALLOWED_CHANNELS ?? '').trim();
  if (environmentValue) return { source: 'DISCORD_ALLOWED_CHANNELS', values: splitConfiguredValues(environmentValue) };
  const lines = String(contents).split(/\r?\n/u);
  const index = lines.findIndex((line) => /^\s*allowed_channels\s*:/u.test(line));
  if (index < 0) return { source: 'discord.allowed_channels', values: [] };
  const line = lines[index];
  const baseIndent = line.match(/^\s*/u)?.[0].length ?? 0;
  const inline = line.replace(/^\s*allowed_channels\s*:\s*/u, '').trim();
  if (inline) return { source: 'discord.allowed_channels', values: splitConfiguredValues(inline) };
  const values = [];
  for (const candidate of lines.slice(index + 1)) {
    if (!candidate.trim() || candidate.trimStart().startsWith('#')) continue;
    const indent = candidate.match(/^\s*/u)?.[0].length ?? 0;
    if (indent <= baseIndent) break;
    const item = candidate.match(/^\s*-\s*(.+)$/u);
    if (item) values.push(...splitConfiguredValues(item[1]));
  }
  return { source: 'discord.allowed_channels', values };
}

function splitConfiguredValues(value) {
  return String(value)
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .split(',')
    .map((item) => item.replace(/\s+#.*$/u, '').trim().replace(/^(['"])(.*)\1$/u, '$2'))
    .filter(Boolean);
}

function section(contents, key) {
  const match = String(contents).match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*:\\s*\\n([\\s\\S]*?)(?=\\n\\S|$)`));
  return match?.[1] ?? '';
}

function isFalseSetting(value) {
  return /^(?:false|0|no|off)$/iu.test(String(value).trim());
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
WORK_MAP_HARNESS, WORK_MAP_ROLE, and WORK_MAP_CHANNEL. A team-agent additionally
requires WORK_MAP_TEAMMATE_REF and WORK_MAP_AGENT_ADDRESS; a master does not.
Native Hermes/Discord additionally requires DISCORD_CHANNEL_ID,
DISCORD_ALLOW_BOTS=mentions, the strict channel binding, and the native
DISCORD_BOT_TOKEN secret path.

Options: --harness hermes|openclaw|codex|pi|other, --role master|team-agent,
--channel discord|slack|none, --discord-channel-id ID, --no-network, --json,
--self-test`);
}

function printChecks(checks, json) {
  if (json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }
  for (const check of checks) console.log(`${icon(check.status)} ${check.message}`);
  console.log(checks.some((check) => check.status === 'fail') ? '\nOnboarding preflight failed.' : '\nOnboarding preflight passed; complete any native channel proof warning before calling it connected.');
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
  assert.equal(roleNeedsTeammateRoute('master'), false);
  assert.equal(roleNeedsTeammateRoute('team-agent'), true);
  assert.equal(HARNESS.codex.nativeChannels.includes('discord'), false);
  const validHermes = `discord:\n  require_mention: true\n  thread_require_mention: true\n  history_backfill: false\n  auto_thread: false\n  reactions: false\n  bots_require_inline_mention: true\n  allowed_channels:\n    - "123456"\n  channel_skill_bindings:\n    - id: "123456"\n      skills: ["master"]\n`;
  const validHermesEnv = { DISCORD_ALLOW_BOTS: 'mentions' };
  assert.equal(parseHermesDiscordBinding(validHermes, '123456', validHermesEnv).ok, true);
  const unsafeHermes = validHermes.replace('thread_require_mention: true', 'thread_require_mention: false');
  assert.equal(parseHermesDiscordBinding(unsafeHermes, '123456', validHermesEnv).reason, 'thread_require_mention is not true');
  const unsafeHistory = validHermes.replace('history_backfill: false', 'history_backfill: true');
  assert.equal(parseHermesDiscordBinding(unsafeHistory, '123456', validHermesEnv).reason, 'history_backfill must be false for explicit-mention privacy');
  assert.equal(parseHermesDiscordBinding(validHermes, '123456', { ...validHermesEnv, DISCORD_AUTO_THREAD: 'true' }).reason, 'auto_thread must be false for the selected inline channel');
  assert.equal(parseHermesDiscordBinding(validHermes, '123456', { ...validHermesEnv, DISCORD_REACTIONS: 'true' }).reason, 'reactions must be false for the selected channel');
  assert.equal(parseHermesDiscordBinding(validHermes, '123456', { ...validHermesEnv, DISCORD_BOTS_REQUIRE_INLINE_MENTION: 'false' }).reason, 'bots_require_inline_mention must be true for multi-agent safety');
  const unsafeChannel = validHermes.replace('- "123456"', '- "654321"');
  assert.equal(parseHermesDiscordBinding(unsafeChannel, '123456', validHermesEnv).reason, 'discord.allowed_channels must explicitly allow the selected channel and must not use a wildcard');
  const wrongChannelSkill = validHermes.replace('skills: ["master"]', 'skills: ["unrelated"]');
  assert.equal(parseHermesDiscordBinding(wrongChannelSkill, '123456', validHermesEnv).reason, 'selected channel is not bound to the registered master skill');
  const unsafeBots = { DISCORD_ALLOW_BOTS: 'all' };
  assert.equal(parseHermesDiscordBinding(validHermes, '123456', unsafeBots).reason, 'DISCORD_ALLOW_BOTS must be mentions for multi-agent safety');
  const envAllowedChannel = { ...validHermesEnv, DISCORD_ALLOWED_CHANNELS: '123456' };
  assert.equal(parseHermesDiscordBinding(validHermes.replace('- "123456"', '- "654321"'), '123456', envAllowedChannel).ok, true);
  assert.equal(extractDiscordToken('# DISCORD_BOT_TOKEN=' + 'x'.repeat(MIN_SECRET_LENGTH)), undefined);
  assert.equal(extractDiscordToken('DISCORD_BOT_TOKEN=' + 'x'.repeat(MIN_SECRET_LENGTH)), 'x'.repeat(MIN_SECRET_LENGTH));
  console.log('onboarding preflight self-test passed');
}
