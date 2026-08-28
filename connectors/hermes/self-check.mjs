#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MASTER_INSTRUCTIONS,
  HermesMasterSession,
  childEnvironment,
  configFromEnv,
  extractOutputText,
  hermesGatewayArgs,
  wrapGatewayJob,
} from './connector.mjs';
import { installHermesMaster, uninstallHermesMaster } from './setup.mjs';

const SECRET = 's'.repeat(43);
const API_KEY = 'a'.repeat(43);
const WORK_MAP_KEY = 'w'.repeat(43);
const MASTER_KEY = 'm'.repeat(43);

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'menoteam-hermes-check-'));
  try {
    const repository = join(root, 'repo');
    const home = join(root, 'home');
    const hermesHome = join(home, '.hermes');
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(hermesHome, { recursive: true }),
    ]);

    const received = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        sessionKey: request.headers['x-hermes-session-key'],
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/capabilities') {
        response.end(JSON.stringify({ features: { responses_api: true } }));
        return;
      }
      response.end(JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Master answer' }] }],
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');

    const values = baseValues(repository, `http://127.0.0.1:${address.port}`);
    const config = configFromEnv(values);
    assert.equal(config.harness, 'hermes');
    assert.equal(config.role, 'master');
    assert.equal(config.manageHermesGateway, true);
    assert.deepEqual(hermesGatewayArgs(config), ['gateway']);
    assert.deepEqual(hermesGatewayArgs({ ...config, profile: 'team' }), ['--profile', 'team', 'gateway']);
    assert.throws(() => configFromEnv({ ...values, MENOTEAM_HERMES_API_URL: 'https://remote.example.com' }), /loopback/u);
    assert.throws(() => configFromEnv({ ...values, MENOTEAM_AGENT_ROLE: 'teammate' }), /Master role/u);

    const childEnv = childEnvironment({
      MENOTEAM_AGENT_TOKEN: SECRET,
      SLACK_BOT_TOKEN: 'xoxb-secret',
      MENOTEAM_MASTER_MCP_KEY: MASTER_KEY,
      WORK_MAP_MCP_API_KEY: WORK_MAP_KEY,
      API_SERVER_KEY: API_KEY,
    });
    assert.equal(childEnv.MENOTEAM_AGENT_TOKEN, undefined);
    assert.equal(childEnv.SLACK_BOT_TOKEN, undefined);
    assert.equal(childEnv.MENOTEAM_MASTER_MCP_KEY, MASTER_KEY);
    assert.equal(childEnv.WORK_MAP_MCP_API_KEY, WORK_MAP_KEY);
    assert.equal(childEnv.API_SERVER_KEY, API_KEY);

    const session = new HermesMasterSession(config);
    await session.assertReady();
    assert.equal(await session.run('What is active?'), 'Master answer');
    const turn = received.at(-1);
    assert.equal(turn.authorization, `Bearer ${API_KEY}`);
    assert.equal(turn.sessionKey, 'menoteam:master:master-hermes');
    assert.equal(turn.body.conversation, 'menoteam:master-hermes');
    assert.equal(turn.body.store, true);
    assert.equal(turn.body.instructions, MASTER_INSTRUCTIONS);
    assert.match(turn.body.input, /What is active\?/u);
    assert.equal(extractOutputText({ output_text: ' direct ' }), 'direct');
    assert.equal(extractOutputText({ output: [] }), '');
    assert.match(wrapGatewayJob({ prompt: 'ask', origin: { channelId: 'C123', threadTs: '123.456' } }), /channel_id=C123 thread_ts=123\.456/u);

    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    const fakeHermes = join(root, 'hermes');
    await writeFile(fakeHermes, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(fakeHermes, 0o700);
    const handoff = join(root, 'master-hermes.env');
    await writeFile(handoff, handoffContents(repository), { mode: 0o600 });
    const runtime = {
      platform: 'linux',
      home,
      hermesHome,
      hermesPath: fakeHermes,
      nodePath: process.execPath,
      skipCommands: true,
    };
    const installed = await installHermesMaster({ config: handoff }, runtime);
    const installedConfig = await readFile(installed.config, 'utf8');
    assert.match(installedConfig, /API_SERVER_KEY='[^']{32,}'/u);
    assert.match(installedConfig, /MENOTEAM_MANAGE_HERMES_GATEWAY='true'/u);
    assert.match(installedConfig, /API_SERVER_HOST='127\.0\.0\.1'/u);
    assert.equal((await stat(installed.config)).mode & 0o777, 0o600);
    const unit = await readFile(installed.service, 'utf8');
    assert.match(unit, /Menoteam Hermes Master Connector/u);
    assert.doesNotMatch(unit, new RegExp(API_KEY, 'u'));
    assert.doesNotMatch(unit, /xoxb-/u);

    await installHermesMaster({ config: handoff }, runtime);
    assert.equal(await readFile(installed.config, 'utf8'), installedConfig, 'reinstall should preserve the local API key');

    const skillPath = installed.skill;
    assert.equal((await stat(skillPath)).isFile(), true);
    await uninstallHermesMaster({ endpoint: 'master-hermes' }, runtime);
    await assert.rejects(() => stat(installed.config), { code: 'ENOENT' });
    assert.equal((await stat(skillPath)).isFile(), true, 'uninstall keeps the reusable Hermes skill');

    process.stdout.write('Hermes Master self-check passed.\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function baseValues(repository, apiUrl) {
  return {
    MENOTEAM_GATEWAY_URL: 'https://agents.example.com',
    MENOTEAM_AGENT_ENDPOINT: 'master-hermes',
    MENOTEAM_AGENT_TOKEN: SECRET,
    MENOTEAM_AGENT_ROLE: 'master',
    MENOTEAM_AGENT_HARNESS: 'hermes',
    MENOTEAM_MASTER_MCP_KEY: MASTER_KEY,
    MENOTEAM_REPOSITORY_CWD: repository,
    WORK_MAP_MCP_URL: 'https://team.example.com/mcp',
    WORK_MAP_MCP_API_KEY: WORK_MAP_KEY,
    MENOTEAM_HERMES_API_URL: apiUrl,
    MENOTEAM_MANAGE_HERMES_GATEWAY: 'true',
    API_SERVER_KEY: API_KEY,
  };
}

function handoffContents(repository) {
  return [
    "MENOTEAM_GATEWAY_URL='https://agents.example.com'",
    "MENOTEAM_AGENT_ENDPOINT='master-hermes'",
    `MENOTEAM_AGENT_TOKEN='${SECRET}'`,
    "MENOTEAM_AGENT_ROLE='master'",
    "MENOTEAM_AGENT_HARNESS='hermes'",
    `MENOTEAM_MASTER_MCP_KEY='${MASTER_KEY}'`,
    `MENOTEAM_REPOSITORY_CWD='${repository}'`,
    "WORK_MAP_MCP_URL='https://team.example.com/mcp'",
    `WORK_MAP_MCP_API_KEY='${WORK_MAP_KEY}'`,
    '',
  ].join('\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
