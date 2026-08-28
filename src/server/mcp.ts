import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { asDomainError } from '../domain/errors.js';
import type { WorkMapRepository } from '../domain/repository.js';

const ref = z.string().regex(/^(?:work|teammate)_[A-Za-z0-9_-]+$/u);
const teammateRef = z.string().regex(/^teammate_[A-Za-z0-9_-]+$/u);
const workRef = z.string().regex(/^work_[A-Za-z0-9_-]+$/u);
const ownerSource = z.enum(['confirmed', 'inferred', 'unresolved']);
const ownerEvidence = z.object({
  kind: z.string().min(1).max(100),
  label: z.string().min(1).max(1_000),
  ref: z.string().max(500).optional(),
  detail: z.string().max(2_000).optional(),
  url: z.string().url().max(2_000).optional(),
}).strict();
const ownerEvidenceList = z.array(ownerEvidence).max(12);
const addressMap = z.record(z.string().min(1), z.string().min(1));
const compactPageOutput = z.object({ items: z.array(z.record(z.string(), z.unknown())), next_cursor: z.string().nullable(), total_count: z.number().int().nonnegative() });
const entityOutput = z.object({ entity: z.record(z.string(), z.unknown()) });

export function createMcpServer(repository: WorkMapRepository): McpServer {
  const server = new McpServer({ name: 'menoteam-work-map', version: process.env.APP_VERSION ?? '0.1.1' });

  server.registerTool('list', {
    description: 'List deterministic paginated compact Work or teammate summaries. total_count counts filter matches; each Work subtree_count counts that Work plus all descendants and is the authoritative branch size. Work title is exact; ancestor filters to a root and its descendants.',
    inputSchema: z.object({
      kind: z.enum(['work', 'teammate']),
      filters: z.object({ title: z.string().min(1).max(500).optional(), parent: workRef.nullable().optional(), ancestor: workRef.optional(), owner: teammateRef.optional(), state: z.enum(['current', 'completed']).optional() }).strict().default({}),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    outputSchema: compactPageOutput,
  }, async ({ kind, filters, cursor, limit }) => execute(async () => ({
    ...(kind === 'work' ? await repository.list('work', filters, cursor, limit) : await repository.list('teammate', {}, cursor, limit)),
  })));

  server.registerTool('search', {
    description: 'Search Work and teammate context using relevance-ranked summaries.',
    inputSchema: z.object({ query: z.string().min(1).max(500), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    outputSchema: compactPageOutput,
  }, async ({ query, cursor, limit }) => execute(() => repository.search(query, cursor, limit)));

  server.registerTool('read', {
    description: 'Read one complete Work Node with its Living Doc or one teammate with full Memory.',
    inputSchema: z.object({ ref }).strict(),
    outputSchema: entityOutput,
  }, async ({ ref: entityRef }) => execute(async () => ({ entity: await repository.read(entityRef) })));

  server.registerTool('create_work', {
    description: 'Atomically create a Work Node and its required Living Doc at revision one.',
    inputSchema: z.object({
      title: z.string().min(1).max(500),
      owner: teammateRef,
      owner_source: ownerSource.optional(),
      owner_evidence: ownerEvidenceList.optional(),
      state: z.enum(['current', 'completed']).default('current'),
      parent: workRef.nullable().optional(),
      dependencies: z.array(workRef).max(100).default([]),
      current_summary: z.string().min(1).max(10_000),
      living_doc_markdown: z.string().min(1).max(100_000),
    }).strict(),
    outputSchema: z.object({ work: z.record(z.string(), z.unknown()) }),
  }, async (input) => execute(async () => ({ work: await repository.createWork(input) })));

  server.registerTool('update_work', {
    description: 'Update a Work Node with optimistic concurrency using expected_revision.',
    inputSchema: z.object({
      ref: workRef,
      expected_revision: z.number().int().min(1),
      changes: z.object({
        owner: teammateRef.optional(),
        owner_source: ownerSource.optional(),
        owner_evidence: ownerEvidenceList.optional(),
        state: z.enum(['current', 'completed']).optional(),
        parent: workRef.nullable().optional(),
        dependencies: z.array(workRef).max(100).optional(),
        current_summary: z.string().min(1).max(10_000).optional(),
        living_doc_markdown: z.string().min(1).max(100_000).optional(),
      }).strict(),
    }).strict(),
    outputSchema: z.object({ work: z.record(z.string(), z.unknown()) }),
  }, async ({ ref: work, expected_revision, changes }) => execute(async () => ({ work: await repository.updateWork(work, expected_revision, changes) })));

  server.registerTool('update_teammate', {
    description: 'Create or update a teammate and its 200-word maximum Teammate Memory.',
    inputSchema: z.object({
      ref: teammateRef,
      expected_revision: z.number().int().min(0),
      changes: z.object({ display_name: z.string().min(1).max(300).optional(), default_agent_addresses: addressMap.optional(), memory: z.string().max(20_000).optional() }).strict(),
    }).strict(),
    outputSchema: z.object({ teammate: z.record(z.string(), z.unknown()) }),
  }, async ({ ref: teammate, expected_revision, changes }) => execute(async () => ({ teammate: await repository.updateTeammate(teammate, expected_revision, changes) })));

  return server;
}

async function execute<T extends object>(action: () => Promise<T>): Promise<{ content: [{ type: 'text'; text: string }]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  try {
    const value = await action();
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
  } catch (error) {
    const domainError = asDomainError(error);
    const body = { error: { code: domainError.code, message: domainError.message, ...domainError.details } };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
  }
}
