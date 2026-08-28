#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { JsonRpcClient, childEnvironment, configFromEnv, wrapGatewayJob, wrapPrompt } from './connector.mjs';
import { agentPaths, installAgent, parseHandoff, renderLaunchAgent, renderSystemdUnit, sanitizedConfig, statusAgent, uninstallAgent } from './setup.mjs';

const config = configFromEnv({
  MENOTEAM_GATEWAY_URL: 'https://agents.example.com/',
  MENOTEAM_AGENT_ENDPOINT: 'alice-codex',
  MENOTEAM_AGENT_TOKEN: 'a'.repeat(32),
  MENOTEAM_AGENT_HARNESS: 'codex',
  MENOTEAM_REPOSITORY_CWD: '/tmp/menoteam',
  WORK_MAP_MCP_URL: 'https://team.example.com/mcp',
  WORK_MAP_MCP_API_KEY: 'w'.repeat(32),
  XDG_STATE_HOME: '/tmp/state',
});
assert.equal(config.gatewayUrl, 'https://agents.example.com');
assert.equal(config.stateFile, '/tmp/state/menoteam-agent/alice-codex.json');
assert.throws(() => configFromEnv({
  MENOTEAM_GATEWAY_URL: 'http://agents.example.com',
  MENOTEAM_AGENT_ENDPOINT: 'alice-codex',
    MENOTEAM_AGENT_TOKEN: 'a'.repeat(32),
    MENOTEAM_AGENT_HARNESS: 'codex',
    MENOTEAM_REPOSITORY_CWD: '/tmp/menoteam',
    WORK_MAP_MCP_URL: 'https://team.example.com/mcp',
    WORK_MAP_MCP_API_KEY: 'w'.repeat(32),
}), /HTTPS/u);

const childEnv = childEnvironment({
  HOME: '/home/alice',
  WORK_MAP_MCP_API_KEY: 'local-tool-secret',
  MENOTEAM_AGENT_TOKEN: 'gateway-secret',
  SLACK_BOT_TOKEN: 'slack-secret',
  SLACK_SIGNING_SECRET: 'signing-secret',
});
assert.equal(childEnv.HOME, '/home/alice');
assert.equal(childEnv.WORK_MAP_MCP_API_KEY, 'local-tool-secret');
assert.equal(childEnv.MENOTEAM_AGENT_TOKEN, undefined);
assert.equal(childEnv.SLACK_BOT_TOKEN, undefined);
assert.equal(childEnv.SLACK_SIGNING_SECRET, undefined);
assert.match(wrapPrompt('What changed?'), /Request:\nWhat changed\?/u);
assert.match(wrapPrompt('Who knows?', 'master'), /may use the configured Agent Gateway MCP once/u);
assert.match(wrapGatewayJob({ prompt: 'Who knows?', origin: { channelId: 'C1', threadTs: '1.2' } }, 'master'), /channel_id=C1 thread_ts=1\.2/u);
assert.equal(wrapGatewayJob({ prompt: 'Who knows?' }, 'teammate'), 'Who knows?');

const teammateHandoff = {
  MENOTEAM_GATEWAY_URL: 'https://agents.example.com',
  MENOTEAM_AGENT_ENDPOINT: 'alice-codex',
  MENOTEAM_AGENT_TOKEN: 'a'.repeat(32),
  MENOTEAM_AGENT_ROLE: 'teammate',
  MENOTEAM_AGENT_HARNESS: 'codex',
  MENOTEAM_REPOSITORY_CWD: '/tmp/menoteam',
  WORK_MAP_MCP_URL: 'https://team.example.com/mcp',
  WORK_MAP_MCP_API_KEY: 'w'.repeat(32),
};
const teammateSetup = sanitizedConfig(teammateHandoff, { codexPath: '/opt/codex' });
assert.equal(parseHandoff(teammateSetup.contents).CODEX_BIN, '/opt/codex');
assert.doesNotMatch(teammateSetup.contents, /MASTER_MCP_KEY/u);
assert.throws(() => sanitizedConfig({ ...teammateHandoff, MENOTEAM_MASTER_MCP_KEY: 'm'.repeat(32) }, { codexPath: '/opt/codex' }), /must not contain/u);
const masterSetup = sanitizedConfig({ ...teammateHandoff, MENOTEAM_AGENT_ROLE: 'master', MENOTEAM_MASTER_MCP_KEY: 'm'.repeat(32) }, { codexPath: '/opt/codex' });
assert.match(masterSetup.contents, /MENOTEAM_MASTER_MCP_KEY/u);

const launchAgent = renderLaunchAgent({
  label: 'ai.menoteam.agent.alice-codex',
  configPath: '/Users/alice/.config/menoteam-agent/alice-codex.env',
  nodePath: '/opt/node',
  connectorPath: '/opt/connector.mjs',
  repositoryCwd: '/Users/alice/menoteam',
  stdoutPath: '/tmp/out.log',
  stderrPath: '/tmp/err.log',
});
assert.match(launchAgent, /KeepAlive/u);
assert.doesNotMatch(launchAgent, /a{32}|MENOTEAM_AGENT_TOKEN/u);
const systemdUnit = renderSystemdUnit({
  configPath: '/home/alice/.config/menoteam-agent/alice-codex.env',
  nodePath: '/opt/node',
  connectorPath: '/opt/connector.mjs',
  repositoryCwd: '/home/alice/menoteam',
});
assert.match(systemdUnit, /Restart=always/u);
assert.doesNotMatch(systemdUnit, /MENOTEAM_AGENT_TOKEN/u);
assert.equal(agentPaths('master-codex', { platformName: 'linux', home: '/root', uid: 0 }).service, '/etc/systemd/system/menoteam-agent-master-codex.service');
assert.equal(agentPaths('alice-codex', { platformName: 'darwin', home: '/Users/alice', uid: 501 }).label, 'ai.menoteam.agent.alice-codex');

const input = new PassThrough();
const output = new PassThrough();
const rpc = new JsonRpcClient(input, output);
let sent = '';
input.on('data', (chunk) => { sent += chunk; });
const pending = rpc.request('initialize', { safe: true });
await new Promise((resolve) => setImmediate(resolve));
const request = JSON.parse(sent.trim());
assert.deepEqual(request, { id: 1, method: 'initialize', params: { safe: true } });
output.write(`${JSON.stringify({ id: request.id, result: { ready: true } })}\n`);
assert.deepEqual(await pending, { ready: true });

const temporary = await mkdtemp(join(tmpdir(), 'menoteam-agent-setup-'));
try {
  const home = join(temporary, 'home');
  const repository = join(temporary, 'repo');
  const handoff = join(temporary, 'alice.env');
  await mkdir(repository, { recursive: true });
  await writeFile(handoff, [
    "MENOTEAM_GATEWAY_URL='https://agents.example.com'",
    "MENOTEAM_AGENT_ENDPOINT='alice-codex'",
    `MENOTEAM_AGENT_TOKEN='${'a'.repeat(32)}'`,
    "MENOTEAM_AGENT_ROLE='teammate'",
    "MENOTEAM_AGENT_HARNESS='codex'",
    "WORK_MAP_MCP_URL='https://team.example.com/mcp'",
    `WORK_MAP_MCP_API_KEY='${'w'.repeat(32)}'`,
    `MENOTEAM_REPOSITORY_CWD='${repository}'`,
    '',
  ].join('\n'), { mode: 0o600 });
  const runtime = { platform: 'darwin', home, skipCommands: true, codexPath: process.execPath, nodePath: process.execPath };
  const installed = await installAgent({ config: handoff }, runtime);
  assert.equal((await stat(installed.config)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(installed.service, 'utf8'), /a{32}/u);
  assert.deepEqual(await statusAgent({ endpoint: 'alice-codex' }, runtime), expectStatus(installed));
  await uninstallAgent({ endpoint: 'alice-codex' }, runtime);
  await assert.rejects(access(installed.config));
  await assert.rejects(access(installed.service));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('Menoteam Agent plugin self-check passed');

function expectStatus(installed) {
  return {
    endpointId: installed.endpointId,
    role: installed.role,
    active: false,
    config: installed.config,
    service: installed.service,
  };
}
