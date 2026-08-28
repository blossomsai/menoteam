#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addEndpoint, listEndpoints, parseEnvFile, parseRegistry, revokeEndpoint, rotateEndpoint } from './gateway-admin.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'menoteam-gateway-admin-'));
try {
  const envPath = join(temporary, '.env.gateway');
  const workMapEnvPath = join(temporary, '.env.work-map');
  const teammateHandoff = join(temporary, 'alice.env');
  const rotatedHandoff = join(temporary, 'alice-rotated.env');
  const masterHandoff = join(temporary, 'new-master.env');
  const rotatedMasterHandoff = join(temporary, 'new-master-rotated.env');
  const originalToken = 'o'.repeat(32);
  const originalDigest = await sha256(originalToken);
  await writeFile(workMapEnvPath, `MCP_API_KEY='${'w'.repeat(32)}'\n`, { mode: 0o600 });
  await writeFile(envPath, [
    `AGENT_GATEWAY_MASTER_KEY='${'m'.repeat(32)}'`,
    `AGENT_GATEWAY_CONNECTORS_JSON='${JSON.stringify([{ id: 'old-master', label: 'MASTER', harness: 'codex', token_sha256: originalDigest }])}'`,
    "AGENT_GATEWAY_MASTER_ENDPOINT='old-master'",
    "SLACK_SIGNING_SECRET='preserve-me'",
    '',
  ].join('\n'), { mode: 0o600 });

  await addEndpoint({
    env: envPath,
    id: 'alice-codex',
    label: 'Alice · Codex',
    role: 'teammate',
    harness: 'codex',
    'gateway-url': 'https://agents.example.com/',
    'work-map-url': 'https://team.example.com/mcp',
    'work-map-env': workMapEnvPath,
    'repository-cwd': '/srv/menoteam',
    output: teammateHandoff,
  });
  const teammateValues = parseEnvFile(await readFile(teammateHandoff, 'utf8'));
  const serverContents = await readFile(envPath, 'utf8');
  const serverValues = parseEnvFile(serverContents);
  const registry = parseRegistry(serverValues.AGENT_GATEWAY_CONNECTORS_JSON);
  assert.equal(registry.length, 2);
  assert.equal(registry.find(({ id }) => id === 'alice-codex').token_sha256, await sha256(teammateValues.MENOTEAM_AGENT_TOKEN));
  assert.doesNotMatch(serverContents, new RegExp(teammateValues.MENOTEAM_AGENT_TOKEN, 'u'));
  assert.equal(teammateValues.MENOTEAM_MASTER_MCP_KEY, undefined);
  assert.equal(teammateValues.MENOTEAM_AGENT_HARNESS, 'codex');
  assert.equal(teammateValues.WORK_MAP_MCP_URL, 'https://team.example.com/mcp');
  assert.equal(teammateValues.WORK_MAP_MCP_API_KEY, 'w'.repeat(32));
  assert.equal((await stat(teammateHandoff)).mode & 0o777, 0o600);
  assert.equal(serverValues.SLACK_SIGNING_SECRET, 'preserve-me');
  await rotateEndpoint({
    env: envPath,
    id: 'alice-codex',
    'gateway-url': 'https://agents.example.com',
    'work-map-url': 'https://team.example.com/mcp',
    'work-map-env': workMapEnvPath,
    output: rotatedHandoff,
  });
  const rotatedValues = parseEnvFile(await readFile(rotatedHandoff, 'utf8'));
  assert.notEqual(rotatedValues.MENOTEAM_AGENT_TOKEN, teammateValues.MENOTEAM_AGENT_TOKEN);
  assert.equal(rotatedValues.MENOTEAM_AGENT_ROLE, 'teammate');
  assert.equal(rotatedValues.MENOTEAM_MASTER_MCP_KEY, undefined);
  assert.equal(parseRegistry(parseEnvFile(await readFile(envPath, 'utf8')).AGENT_GATEWAY_CONNECTORS_JSON).find(({ id }) => id === 'alice-codex').token_sha256, await sha256(rotatedValues.MENOTEAM_AGENT_TOKEN));
  await assert.rejects(addEndpoint({
    env: envPath,
    id: 'alice-codex',
    label: 'Duplicate',
    role: 'teammate',
    harness: 'codex',
    'gateway-url': 'https://agents.example.com',
    'work-map-url': 'https://team.example.com/mcp',
    'work-map-env': workMapEnvPath,
    'repository-cwd': '/srv/menoteam',
    output: join(temporary, 'duplicate.env'),
  }), /already exists/u);

  await addEndpoint({
    env: envPath,
    id: 'new-master',
    label: 'MASTER',
    role: 'master',
    harness: 'hermes',
    'gateway-url': 'https://agents.example.com',
    'work-map-url': 'https://team.example.com/mcp',
    'work-map-env': workMapEnvPath,
    'repository-cwd': '/srv/menoteam',
    output: masterHandoff,
  });
  const masterValues = parseEnvFile(await readFile(masterHandoff, 'utf8'));
  const afterMasterAdd = parseEnvFile(await readFile(envPath, 'utf8'));
  assert.equal(masterValues.MENOTEAM_MASTER_MCP_KEY, afterMasterAdd.AGENT_GATEWAY_MASTER_KEY);
  assert.equal(masterValues.MENOTEAM_AGENT_HARNESS, 'hermes');
  assert.notEqual(masterValues.MENOTEAM_MASTER_MCP_KEY, 'm'.repeat(32));
  assert.equal(afterMasterAdd.AGENT_GATEWAY_MASTER_ENDPOINT, 'new-master');
  await rotateEndpoint({
    env: envPath,
    id: 'new-master',
    'gateway-url': 'https://agents.example.com',
    'work-map-url': 'https://team.example.com/mcp',
    'work-map-env': workMapEnvPath,
    output: rotatedMasterHandoff,
  });
  const rotatedMasterValues = parseEnvFile(await readFile(rotatedMasterHandoff, 'utf8'));
  const afterMasterRotation = parseEnvFile(await readFile(envPath, 'utf8'));
  assert.equal(rotatedMasterValues.MENOTEAM_MASTER_MCP_KEY, afterMasterRotation.AGENT_GATEWAY_MASTER_KEY);
  assert.notEqual(rotatedMasterValues.MENOTEAM_MASTER_MCP_KEY, masterValues.MENOTEAM_MASTER_MCP_KEY);
  assert.equal(parseRegistry(afterMasterRotation.AGENT_GATEWAY_CONNECTORS_JSON).find(({ id }) => id === 'new-master').harness, 'hermes');
  await revokeEndpoint({ env: envPath, id: 'old-master' });
  assert.deepEqual((await listEndpoints({ env: envPath })).map(({ id }) => id), ['alice-codex', 'new-master']);
  await assert.rejects(revokeEndpoint({ env: envPath, id: 'new-master' }), /active Master/u);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('Menoteam Gateway admin self-check passed');

async function sha256(value) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}
