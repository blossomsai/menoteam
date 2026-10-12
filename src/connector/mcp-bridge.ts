import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WorkbenchConnectorClient } from './client.js';
import { createWorkSchema, dispatchPublicSchema, dispatchInputSchema, updateSettingsPublicSchema, updateSettingsInputSchema } from './mcp-schemas.js';

const contextFile = process.env.MENOTEAM_RUN_CONTEXT_FILE ?? '';
if (!contextFile) throw new Error('Run context file is missing');

const server = new McpServer({ name: 'menoteam', version: '0.1.0' });
const text = z.string().min(1).max(32_000);
const workId = z.string().min(1).max(200);

function tool(name: string, description: string, schema: z.ZodType, action: string, validateInput?: z.ZodType) {
  server.registerTool(name, { description, inputSchema: schema }, async (input, extra) => {
    try {
      const validatedInput = validateInput ? validateInput.parse(input) : input;
      const { serverUrl, token, runId, generation } = JSON.parse(await readFile(contextFile, 'utf8')) as {
        serverUrl: string; token: string; runId: string; generation: number;
      };
      const client = new WorkbenchConnectorClient({ serverUrl, token });
      const requestId = `${runId}:${name}:${randomUUID()}`;
      const result = await client.tool(runId, generation, action, validatedInput as Record<string, unknown>, requestId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: String(error).slice(0, 1500) }] };
    }
  });
}

tool('read_context', 'Read this project, its Works, conversation, runs, and artifacts.', z.object({}).strict(), 'read_context');
tool('read_work', 'Read one Work, its conversation, and artifacts.', z.object({ workId }), 'read_work');
tool('read_run', 'Read a run, its events, and artifacts.', z.object({ runId: workId }), 'read_run');
tool('submit_review_result', 'Submit the structured disposition and findings for this assigned candidate review.', z.object({ disposition: z.enum(['approved','changes_requested','insufficient_evidence']), findings: z.array(z.object({ id: z.string().min(1).max(120), blocking: z.boolean(), summary: z.string().min(1).max(2000) }).strict()).max(100), evidenceArtifactIds: z.array(workId).max(100) }).strict(), 'submit_review_result');
tool('create_work', 'Create a Work in this project.', createWorkSchema, 'create_work');
tool('update_work', 'Update a Work overview or status using its current revision.', z.object({ workId, revision: z.number().int().min(1), overview: z.string().max(32_000).optional(), status: z.enum(['queued','in_progress','paused','done']).optional() }).strict(), 'update_work');
tool('dispatch', 'Assign an implementation or review run for a Work. An explicit implementation handoff may select a new model and advertised reasoning effort while preserving the assigned Work thread.', dispatchPublicSchema, 'dispatch', dispatchInputSchema);
tool('request_delivery', 'Queue a draft pull request for an exact completed implementation candidate.', z.object({ workId, candidateRunId: workId, candidateRevision: z.string().min(1).max(200), action: z.literal('create_draft_pr'), requestId: z.string().min(1).max(200) }).strict(), 'request_delivery');
tool('request_merge', 'Queue a bounded merge for a completed draft receipt and its typed approved review.', z.object({priorDeliveryRunId:workId,reviewRunId:workId,requestId:z.string().min(1).max(200)}).strict(), 'request_merge');
tool('request_staging_deploy', 'Queue a staging deployment for the exact merged commit. The fixed Connector discovers its immutable image receipt and verifies provenance before any remote effect.', z.object({workId,sourceMergeRunId:workId,targetId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),requestId:z.string().min(1).max(200)}).strict(), 'request_staging_deploy');
tool('retire_staging_deploy', 'Explicitly retire a stopped pre-effect staging deployment and release only its target reservation. Cannot retire mutation intent or unknown remote outcomes.', z.object({runId:workId,generation:z.number().int().nonnegative()}).strict(), 'retire_staging_deploy');
tool('request_staging_rollback', 'Queue rollback to the previous health-verified deployment receipt for this staging target.', z.object({workId,deploymentRunId:workId,targetId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),requestId:z.string().min(1).max(200)}).strict(), 'request_staging_rollback');
tool('post_message', 'Post a message to a Work conversation.', z.object({ workId: workId.optional(), text }).strict(), 'post_message');
tool('update_settings', 'Update project instructions using the current expectedInstructions value, or rename/change a setting after reading its current updatedAt. Setting changes require settingId and expectedUpdatedAt, plus name and/or data; workspace-wide settings require an owner or admin.', updateSettingsPublicSchema, 'update_settings', updateSettingsInputSchema);
tool('create_skill', 'Create a skill in the explicitly selected project or workspace settings scope. Use the requested scope; if unclear, ask instead of broadening it to workspace.', z.object({ scope: z.enum(['project', 'workspace']), name: text, data: z.record(z.string(), z.unknown()) }).strict(), 'create_skill');

await server.connect(new StdioServerTransport());
