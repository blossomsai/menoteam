import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentRouter, GatewayError } from './router.js';

const endpointId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u);
const slackChannelId = z.string().regex(/^[CDG][A-Z0-9]{2,}$/u);
const slackThreadTs = z.string().regex(/^\d{1,20}\.\d{1,20}$/u);

export function createGatewayMcpServer(router: AgentRouter, masterEndpointId: string): McpServer {
  const server = new McpServer({ name: 'menoteam-agent-gateway', version: process.env.APP_VERSION ?? '0.1.0' });

  server.registerTool('list_agent_endpoints', {
    description: 'List configured teammate agent endpoints and fresh online/offline presence. Never infer online status from Work Map ownership.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      endpoints: z.array(z.object({
        id: z.string(),
        label: z.string(),
        harness: z.enum(['codex', 'hermes']),
        status: z.enum(['online', 'offline']),
        last_seen_at: z.string().nullable(),
      })),
    }),
  }, async () => execute(() => ({
    endpoints: router.listEndpoints().map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.label,
      harness: endpoint.harness,
      status: endpoint.status,
      last_seen_at: endpoint.lastSeenAt,
    })),
  })));

  server.registerTool('send_agent_message', {
    description: 'Route one explicit, human-originated information request to one online teammate agent. The reply is posted by the Gateway into the supplied allowlisted Slack thread. Do not use this tool for autonomous chaining or more than one hop.',
    inputSchema: z.object({
      endpoint_id: endpointId,
      prompt: z.string().trim().min(1).max(12_000),
      slack_channel_id: slackChannelId,
      slack_thread_ts: slackThreadTs,
    }).strict(),
    outputSchema: z.object({ job_id: z.string().uuid(), endpoint_id: z.string(), status: z.literal('routed') }),
  }, async (input) => execute(() => {
    if (input.endpoint_id === masterEndpointId) {
      throw new GatewayError('INVALID_ORIGIN', 'Master cannot route a job to itself');
    }
    const job = router.route(input.endpoint_id, input.prompt, {
      channelId: input.slack_channel_id,
      threadTs: input.slack_thread_ts,
    });
    return { job_id: job.id, endpoint_id: input.endpoint_id, status: 'routed' as const };
  }));

  return server;
}

async function execute<T extends object>(action: () => T | Promise<T>): Promise<{
  content: [{ type: 'text'; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  try {
    const value = await action();
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
  } catch (error) {
    const body = error instanceof GatewayError
      ? { error: { code: error.code, message: error.message } }
      : { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
  }
}
