import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWorkSchema } from '../src/connector/mcp-schemas.js';
import { ConnectorHttpError, WorkbenchConnectorClient } from '../src/connector/client.js';
import { ConnectorRunner } from '../src/connector/runner.js';
import type { CodexAppServer } from '../src/connector/codex.js';
import type { ClaimedRun } from '../src/connector/types.js';

// Isolated filesystem preparation; the HTTP authorization refusal is the boundary
// under test. This does not simulate a successful native review or PG validation.
vi.mock('../src/connector/git.js', () => ({
  ensureWorktree: vi.fn(async () => ({ path: tmpdir(), baseRevision: 'base' })),
  readWorktreeMap: vi.fn(async () => ({ artifactRevision: 'candidate' })),
  createDiff: vi.fn(async () => 'diff'), diffRevision: vi.fn(() => 'candidate'),
  fingerprint: vi.fn(async () => 'fingerprint'), checkpoint: vi.fn(), persistWorktreeMap: vi.fn(),
}));

describe('explicit provider correction at Connector boundaries', () => {
  it('retains an explicit project connection through the actual strict MCP schema and client HTTP body', async () => {
    const input = createWorkSchema.parse({ title: 'Project B', connectionId: 'connection-b', profileId: 'profile-b' });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ generation: 2, action: 'create_work', input: { title: 'Project B', connectionId: 'connection-b', profileId: 'profile-b' }, requestId: 'request' });
      return new Response(JSON.stringify({ id: 'work-b', connectionId: 'connection-b' }), { status: 200 });
    });
    const client = new WorkbenchConnectorClient({ serverUrl: 'http://127.0.0.1:3200', token: 'fixture' }, fetcher);
    await expect(client.tool('master-b', 2, 'create_work', input, 'request')).resolves.toMatchObject({ connectionId: 'connection-b' });
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3200/api/workbench/connector/runs/master-b/tools');
    expect(() => createWorkSchema.parse({ title: 'Invalid', connectionId: '' })).toThrow();
    expect(() => createWorkSchema.parse({ title: 'Invalid', connectionId: 'connection-b', apiKey: 'unsupported' })).toThrow();
  });

  it('does not start a review turn when fresh server authorization revokes Worktree capability', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'provider-review-revoked-'));
    const claim: ClaimedRun = {
      run: { id: 'review', projectId: 'project', workId: 'work', kind: 'review', prompt: 'Review candidate', targetRevision: 'candidate', model: 'gpt-6.1-sol', reasoning: 'medium', status: 'running', generation: 1, connectorId: 'enrolled', targetConnectorId: 'enrolled', createdAt: 'now', updatedAt: 'now', execution: { connectionId: 'connection', connectorId: 'enrolled', provider: 'openai', method: 'codex-host', model: 'gpt-6.1-sol', skills: [], tools: [] } },
      project: { id: 'project', name: 'Project', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: 'now' }, messages: [], settings: [],
    };
    const native = { start: vi.fn(async () => ['gpt-6.1-sol']), processIdentity: vi.fn(async () => ({ pid: 123, processGroupId: 123, startedAt: 'fixture', command: 'codex app-server' })), stop: vi.fn(async () => undefined), run: vi.fn() };
    const client = { readRun: vi.fn(async () => { throw new ConnectorHttpError(409, 'Selected Connector local Worktree capability is unavailable'); }), createBridgeToken: vi.fn(async () => ({ token: 'fixture', expiresAt: 'later' })), complete: vi.fn(), stopped: vi.fn() };
    const runner = new ConnectorRunner({ serverUrl: 'http://127.0.0.1:3200', token: 'fixture', connectorId: 'enrolled', dataDir, projects: {} }, { native: () => native as unknown as CodexAppServer, client: () => client as unknown as WorkbenchConnectorClient });
    (runner as unknown as { client: typeof client }).client = client;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runner.execute(claim)).rejects.toThrow('Worktree capability');
      expect(client.readRun).toHaveBeenCalledWith('review');
      expect(native.run).not.toHaveBeenCalled();
      expect(native.stop).toHaveBeenCalled();
      expect(claim.run.execution?.connectorId).toBe('enrolled');
    } finally { log.mockRestore(); await rm(dataDir, { recursive: true, force: true }); }
  });
});
