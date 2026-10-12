import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

it('advertises union tool fields through the actual SDK and validates exclusive branches before HTTP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'menoteam-mcp-schema-'));
  const requests: Array<{ action: string; input: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ marker: 'SCHEMA_FIXTURE_OK' }));
  });
  const client = new Client({ name: 'schema-fixture', version: '1' });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture listener unavailable');
    const context = path.join(directory, 'context.json');
    await writeFile(context, JSON.stringify({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'fixture-only', runId: 'master-fixture', generation: 1 }), { mode: 0o600 });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('src/connector/mcp-bridge.ts')], env: { MENOTEAM_RUN_CONTEXT_FILE: context }, stderr: 'ignore' }));
    const catalog = await client.listTools();
    const dispatch = catalog.tools.find(tool => tool.name === 'dispatch')!.inputSchema;
    const settings = catalog.tools.find(tool => tool.name === 'update_settings')!.inputSchema;
    expect(Object.keys(dispatch.properties!)).toEqual(['workId', 'prompt', 'kind', 'model', 'reasoning', 'handoff']);
    expect(dispatch.required).toEqual(['workId', 'prompt', 'kind']);
    expect(dispatch.additionalProperties).toBe(false);
    expect(dispatch.properties!.model).toMatchObject({ enum: ['gpt-6-luna', 'gpt-6.1-sol'], description: expect.stringContaining('Required for normal dispatch') });
    expect(Object.keys(settings.properties!)).toEqual(['settingId', 'expectedUpdatedAt', 'name', 'data', 'instructions', 'expectedInstructions']);
    expect(settings.additionalProperties).toBe(false);
    const accepted = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ marker: 'SCHEMA_FIXTURE_OK' }) }]);
      return requests.at(-1)!;
    };
    const normal = { workId: 'work', prompt: 'Implement', kind: 'implementation', model: 'gpt-6.1-sol' };
    expect((await accepted('dispatch', normal)).input).toEqual({ ...normal, reasoning: 'medium' });
    await accepted('dispatch', { ...normal, kind: 'review', reasoning: 'high' });
    const handoff = { workId: 'work', prompt: 'Continue', kind: 'implementation', handoff: { fromRunId: 'source', model: 'advertised-model', reasoning: 'advertised-effort' } };
    expect((await accepted('dispatch', handoff)).input).toEqual(handoff);
    await accepted('update_settings', { settingId: 'setting', expectedUpdatedAt: 'version', name: 'Renamed' });
    await accepted('update_settings', { settingId: 'setting', expectedUpdatedAt: 'version', data: {} });
    await accepted('update_settings', { instructions: '', expectedInstructions: '' });
    const rejected = async (name: string, args: Record<string, unknown>) => {
      const before = requests.length;
      await client.callTool({ name, arguments: args }).then(result => expect(result.isError).toBe(true), error => expect(error.code).toBe(-32602));
      expect(requests).toHaveLength(before);
    };
    await rejected('dispatch', { workId: 'work', prompt: 'Implement', kind: 'implementation' });
    await rejected('dispatch', { ...normal, profileId: 'profile', connectionId: 'connection' });
    await rejected('dispatch', { ...handoff, model: 'gpt-6.1-sol' });
    await rejected('dispatch', { ...handoff, reasoning: 'medium' });
    await rejected('dispatch', { ...handoff, kind: 'review' });
    await rejected('dispatch', { ...normal, model: 'unsupported' });
    await rejected('update_settings', { settingId: 'setting', expectedUpdatedAt: 'version' });
    await rejected('update_settings', { settingId: 'setting', name: 'Missing version' });
    await rejected('update_settings', { instructions: 'Missing previous value' });
    await rejected('update_settings', { instructions: '', expectedInstructions: '', settingId: 'mixed' });
    await rejected('update_settings', { instructions: '', expectedInstructions: '', unknown: true });
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
