import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGatewayApp } from '../src/gateway/app.js';
import { createGatewayMcpServer } from '../src/gateway/mcp.js';
import { AgentRouter, GatewayError, type AgentReply } from '../src/gateway/router.js';
import { splitSlackText } from '../src/gateway/slack.js';

const endpointToken = 'a'.repeat(32);
const endpoint = { id: 'alice-codex', label: 'Alice · Codex', harness: 'codex' as const, tokenSha256: createHash('sha256').update(endpointToken).digest('hex') };

describe('Agent Gateway', () => {
  it('authenticates each endpoint without exposing its credential', () => {
    const router = createRouter();
    expect(() => router.authenticate(endpoint.id, `Bearer ${endpointToken}`)).not.toThrow();
    expect(() => router.authenticate(endpoint.id, 'Bearer wrong')).toThrowError(GatewayError);
    expect(router.listEndpoints()[0]).not.toHaveProperty('tokenSha256');
  });

  it('rejects a credential shared by multiple endpoints', () => {
    expect(() => new AgentRouter([
      endpoint,
      { ...endpoint, id: 'bob-codex' },
    ], { allowedSlackChannels: ['C123'], onReply: async () => undefined })).toThrow(/tokens must be distinct/u);
  });

  it('routes one job to one online connector and preserves Slack origin', async () => {
    const replies: AgentReply[] = [];
    const router = createRouter(replies);
    const waiting = router.waitForJob(endpoint.id, 10_000);
    const job = router.route(endpoint.id, 'What changed?', { channelId: 'C123', threadTs: '123.456' });

    await expect(waiting).resolves.toEqual(job);
    expect(router.listEndpoints()[0]).toMatchObject({ status: 'online', label: 'Alice · Codex' });
    expect(() => router.route(endpoint.id, 'Second request', { channelId: 'C123', threadTs: '123.456' })).toThrow(/busy/u);
    await router.reply(endpoint.id, job.id, 'completed', 'The tests pass.');
    expect(replies).toEqual([expect.objectContaining({
      endpoint: { id: endpoint.id, label: endpoint.label, harness: 'codex' },
      job: expect.objectContaining({ origin: { channelId: 'C123', threadTs: '123.456' } }),
      status: 'completed',
      text: 'The tests pass.',
    })]);
    router.close();
  });

  it('rejects offline endpoints, unallowlisted channels, and cross-endpoint replies', async () => {
    const bob = { id: 'master-hermes', label: 'MASTER', harness: 'hermes' as const, tokenSha256: createHash('sha256').update('b'.repeat(32)).digest('hex') };
    const router = new AgentRouter([endpoint, bob], { allowedSlackChannels: ['C123'], onReply: async () => undefined });
    expect(() => router.route(endpoint.id, 'Hello', { channelId: 'C123', threadTs: '1.2' })).toThrow(/offline/u);
    const waiting = router.waitForJob(endpoint.id, 10_000);
    expect(() => router.route(endpoint.id, 'Hello', { channelId: 'C999', threadTs: '1.2' })).toThrow(/allowlisted/u);
    const job = router.route(endpoint.id, 'Hello', { channelId: 'C123', threadTs: '1.2' });
    await waiting;
    await expect(router.reply(bob.id, job.id, 'completed', 'Forged')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    router.close();
  });

  it('exposes connector routes with endpoint auth and posts a reply callback', async () => {
    const replies: AgentReply[] = [];
    const router = createRouter(replies);
    const app = await createGatewayApp({ router, masterKey: 'm'.repeat(32), masterEndpointId: 'master-hermes' });
    const denied = await app.inject({ method: 'GET', url: `/v1/connectors/${endpoint.id}/jobs/next?wait_ms=0` });
    expect(denied.statusCode).toBe(401);

    const poll = app.inject({
      method: 'GET',
      url: `/v1/connectors/${endpoint.id}/jobs/next?wait_ms=10000`,
      headers: { authorization: `Bearer ${endpointToken}` },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const job = router.route(endpoint.id, 'Inspect the repo', { channelId: 'C123', threadTs: '123.456' });
    const polled = await poll;
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toMatchObject({ job: { id: job.id, prompt: 'Inspect the repo' } });

    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/connectors/${endpoint.id}/jobs/${job.id}/reply`,
      headers: { authorization: `Bearer ${endpointToken}` },
      payload: { status: 'completed', text: 'Done.' },
    });
    expect(accepted.statusCode).toBe(202);
    expect(replies).toHaveLength(1);
    await app.close();
  });

  it('gives Master only the two bounded routing tools', async () => {
    const router = createRouter();
    const waiting = router.waitForJob(endpoint.id, 10_000);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createGatewayMcpServer(router, 'master-hermes');
    await server.connect(serverTransport);
    const client = new Client({ name: 'gateway-test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['list_agent_endpoints', 'send_agent_message']);
    const result = await client.callTool({ name: 'send_agent_message', arguments: {
      endpoint_id: endpoint.id,
      prompt: 'Give a concise status.',
      slack_channel_id: 'C123',
      slack_thread_ts: '123.456',
    } });
    expect(result.isError).not.toBe(true);
    await expect(waiting).resolves.toMatchObject({ prompt: 'Give a concise status.' });
    await client.close();
    await server.close();
    router.close();
  });

  it('prevents Master from routing recursively to its own endpoint', async () => {
    const router = createRouter();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createGatewayMcpServer(router, endpoint.id);
    await server.connect(serverTransport);
    const client = new Client({ name: 'gateway-test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'send_agent_message', arguments: {
      endpoint_id: endpoint.id,
      prompt: 'Route this back to yourself.',
      slack_channel_id: 'C123',
      slack_thread_ts: '123.456',
    } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('Master cannot route a job to itself') })]);
    await client.close();
    await server.close();
    router.close();
  });

  it('serves the Master tools over authenticated Streamable HTTP', async () => {
    const router = createRouter();
    const masterKey = 'm'.repeat(32);
    const app = await createGatewayApp({ router, masterKey, masterEndpointId: 'master-hermes' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${masterKey}` } },
    });
    const client = new Client({ name: 'gateway-http-test-client', version: '1.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['list_agent_endpoints', 'send_agent_message']);
    await client.close();
    await app.close();
  });

  it('accepts a signed allowlisted Slack mention and wakes only the Master endpoint', async () => {
    const router = createRouter();
    const waiting = router.waitForJob(endpoint.id, 10_000);
    const signingSecret = 'slack-signing-secret';
    const now = Date.parse('2026-08-28T16:00:00.000Z');
    const app = await createGatewayApp({
      router,
      masterKey: 'm'.repeat(32),
      masterEndpointId: endpoint.id,
      slack: {
        signingSecret,
        botUserId: 'UBOT',
        allowedUserIds: ['U123'],
        allowedChannelIds: ['C123'],
        masterEndpointId: endpoint.id,
        postThreadMessage: async () => undefined,
        now: () => now,
      },
    });
    const payload = Buffer.from(JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev123',
      event: { type: 'app_mention', user: 'U123', channel: 'C123', ts: '123.456', text: '<@UBOT> who owns the API?' },
    }));
    const timestamp = String(Math.floor(now / 1_000));
    const signature = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(payload).digest('hex')}`;
    const response = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    await expect(waiting).resolves.toMatchObject({
      prompt: 'who owns the API?',
      origin: { channelId: 'C123', threadTs: '123.456' },
    });
    await app.close();
  });

  it('chunks long Slack output within the transport limit', () => {
    expect(splitSlackText('a'.repeat(8_001))).toSatisfy((parts: string[]) => parts.length === 3 && parts.every((part) => part.length <= 3_900));
  });
});

function createRouter(replies: AgentReply[] = []): AgentRouter {
  return new AgentRouter([endpoint], {
    allowedSlackChannels: ['C123'],
    onReply: async (reply) => { replies.push(reply); },
  });
}
