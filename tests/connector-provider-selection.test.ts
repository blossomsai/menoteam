import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertExecutionSelection } from '../src/connector/selection.js';
import { ConnectorRunner } from '../src/connector/runner.js';
import { ConnectorHttpError, type WorkbenchConnectorClient } from '../src/connector/client.js';
import type { CodexAppServer } from '../src/connector/codex.js';
import type { Run } from '../src/workbench/types.js';
import type { ClaimedRun } from '../src/connector/types.js';

function selectedRun(): Run {
  return { id: 'run', projectId: 'project', kind: 'master', prompt: 'Continue', model: 'gpt-6.1-sol', reasoning: 'medium', status: 'running', generation: 1, connectorId: 'enrolled', targetConnectorId: 'enrolled', threadId: 'native-thread', createdAt: '2026-10-06', updatedAt: '2026-10-06', execution: { connectionId: 'connection', connectorId: 'enrolled', provider: 'openai', method: 'codex-host', model: 'gpt-6.1-sol', profileId: 'profile', profile: { id: 'profile', name: 'Original', data: { model: 'gpt-6.1-sol' } }, skills: [], tools: [] } };
}

describe('Connector frozen selection at actual use', () => {
  it.each(['configured host', 'claimed host', 'continuation host', 'model', 'method', 'profile'])('rejects a changed %s without routing to another host', field => {
    const run = selectedRun();
    let host = 'enrolled';
    if (field === 'configured host') host = 'other';
    if (field === 'claimed host') run.connectorId = 'other';
    if (field === 'continuation host') run.targetConnectorId = 'other';
    if (field === 'model') run.model = 'gpt-6-luna';
    if (field === 'method') (run.execution as unknown as { method: string }).method = 'oauth';
    if (field === 'profile') run.execution!.profileId = 'other';
    expect(() => assertExecutionSelection(run, host)).toThrow();
  });

  it('accepts proven historical Connector identity without inventing a connection record', () => {
    const run = selectedRun();
    run.execution = { provider: 'openai', method: 'codex-host', skills: [], tools: [] };
    const before = structuredClone(run);
    expect(() => assertExecutionSelection(run, 'enrolled')).not.toThrow();
    expect(run).toEqual(before);
    delete run.targetConnectorId; delete run.connectorId;
    expect(() => assertExecutionSelection(run, 'enrolled')).toThrow();
  });

  it.each(['revoked grant', 'disabled connection', 'changed model', 'changed profile', 'changed generation', 'changed reasoning', 'changed project', 'changed Work', 'changed kind', 'paused'])('prevents native turn start after %s during preparation', async change => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'provider-use-'));
    const run = selectedRun();
    const remote = structuredClone(run);
    if (change === 'changed model') remote.model = 'gpt-6-luna';
    if (change === 'changed profile') remote.execution!.profile!.data = { model: 'gpt-6-luna' };
    if (change === 'changed generation') remote.generation++;
    if (change === 'changed reasoning') remote.reasoning = 'high';
    if (change === 'changed project') remote.projectId = 'other';
    if (change === 'changed Work') remote.workId = 'other';
    if (change === 'changed kind') remote.kind = 'implementation';
    if (change === 'paused') remote.status = 'paused';
    const native = { start: vi.fn(async () => ['gpt-6.1-sol']), processIdentity: vi.fn(async () => ({ pid: 123, processGroupId: 123, startedAt: 'fixture', command: 'codex app-server' })), stop: vi.fn(async () => undefined), run: vi.fn() };
    const client = { readRun: vi.fn(async () => {
      if (change === 'revoked grant' || change === 'disabled connection') throw new ConnectorHttpError(403, 'Selected connection unavailable');
      return remote;
    }), createBridgeToken: vi.fn(async () => ({ token: 'scoped-fixture', expiresAt: 'later' })), complete: vi.fn(async () => remote), stopped: vi.fn(async () => remote) };
    const runner = new ConnectorRunner({ serverUrl: 'http://127.0.0.1:3200', token: 'fixture-only', connectorId: 'enrolled', dataDir, projects: {} }, { native: () => native as unknown as CodexAppServer, client: () => client as unknown as WorkbenchConnectorClient });
    (runner as unknown as { client: typeof client }).client = client;
    const claim: ClaimedRun = { run, project: { id: 'project', name: 'Project', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: '2026-10-06' }, messages: [], settings: [] };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runner.execute(claim)).rejects.toThrow();
      expect(client.readRun).toHaveBeenCalledWith('run');
      expect(native.run).not.toHaveBeenCalled();
      expect(native.stop).toHaveBeenCalled();
      expect(claim.run).toEqual(run);
    } finally { log.mockRestore(); await rm(dataDir, { recursive: true, force: true }); }
  });
});
