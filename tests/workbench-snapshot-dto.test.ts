import { afterEach, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkbenchApp, snapshotRun, snapshotSetting } from '../src/workbench/app.js';
import { WorkbenchStore } from '../src/workbench/store.js';
import { bytesHash, gitBlobHash, sealBundle, verifyBundle } from '../src/workbench/skill-bundle.js';
import type { Run, Setting } from '../src/workbench/types.js';

const file = (path: string, content: string) => {
  const bytes = Buffer.from(content);
  return { path, mode: '100644' as const, encoding: 'base64' as const, data: bytes.toString('base64'), bytes: bytes.length, sha256: bytesHash(bytes), sourceBlobSha: gitBlobHash(bytes) };
};
const bundle = sealBundle('', 'a'.repeat(40), [file('SKILL.md', '# Instructions'), file('references/guide.md', 'Full stored reference')]);
const skill: Setting = { id: 'skill', projectId: 'project', kind: 'skill', name: 'Skill', updatedAt: '2026-01-01T00:00:00.000Z', data: { content: '# Instructions', bundle, provenance: 'github-import', enabled: true } };
const run: Run = { id: 'run', projectId: 'project', kind: 'implementation', prompt: 'Private full prompt', execution: { provider: 'openai', method: 'codex-host', model: 'gpt-6-luna', profile: { id: 'profile', name: 'Luna', data: { model: 'gpt-6-luna', reasoning: 'medium' } }, skills: [{ id: skill.id, name: skill.name, content: '# Instructions', bundle }], tools: ['full-tool'] }, model: 'gpt-6-luna', reasoning: 'medium', status: 'cancelled', stoppedAt: '2026-01-02', generation: 2, createdAt: '2026-01-01', updatedAt: '2026-01-02', reviewBinding: { candidateRunId: 'candidate', diffArtifactId: 'diff', diffRevision: 'revision', commitSha: 'b'.repeat(40), candidateFingerprint: 'c'.repeat(64), qaArtifactIds: ['qa'] } };
afterEach(() => vi.restoreAllMocks());

it('projects exactly four payload fields without changing stored input; measures deterministic JSON bytes', () => {
  const input = { runs: [structuredClone(run)], settings: [structuredClone(skill), { ...skill, id: 'profile', kind: 'profile' as const, data: { ...skill.data, model: 'preserve' } }] };
  const before = JSON.stringify(input);
  const projected = { runs: input.runs.map(snapshotRun), settings: input.settings.map(snapshotSetting) };
  const expected = JSON.parse(before);
  delete expected.runs[0].prompt;
  delete expected.runs[0].execution.skills;
  delete expected.runs[0].execution.tools;
  delete expected.settings[0].data.bundle;
  expect(projected).toEqual(expected);
  expect(JSON.stringify(input)).toBe(before);
  const bytes = [Buffer.byteLength(before), Buffer.byteLength(JSON.stringify(projected))];
  console.info('snapshot DTO fixture JSON bytes before/after:', ...bytes);
  expect(bytes).toEqual([3180, 1729]);
  expect(projected.settings[1]!.data.bundle).toEqual(bundle);
});

it('snapshot route omits bundle while dedicated edit/copy still reads the full stored bundle', async () => {
  const member = { id: 'owner', email: 'owner@example.test', name: 'Owner', role: 'owner' };
  const stored = new Map<string, unknown>([['skill', structuredClone(skill)], ['project', { id: 'project' }]]);
  const sql = (async (strings: TemplateStringsArray) => strings.join('').includes('wb_sessions') ? [member] : []) as unknown as Sql;
  vi.spyOn(WorkbenchStore.prototype, 'transaction').mockImplementation(async (_scope, fn) => fn(sql));
  vi.spyOn(WorkbenchStore.prototype, 'get').mockImplementation(async (_kind, id) => structuredClone(stored.get(id)) as never);
  vi.spyOn(WorkbenchStore.prototype, 'put').mockImplementation(async (_kind, data) => { stored.set(data.id, structuredClone(data)); });
  vi.spyOn(WorkbenchStore.prototype, 'list').mockImplementation(async kind => (kind === 'project' ? [{ id: 'project' }] : kind === 'setting' ? [stored.get('skill')] : []) as never);
  vi.spyOn(WorkbenchStore.prototype, 'scopedList').mockImplementation(async kind => (kind === 'run' ? [run] : []) as never);
  vi.spyOn(WorkbenchStore.prototype, 'artifactMetadata').mockResolvedValue([]);
  const app = await createWorkbenchApp({ sql });
  const headers = { cookie: 'menoteam_session=dto-test' };
  try {
    const snapshot = await app.inject({ url: '/api/workbench/snapshot', headers });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().runs[0]).toEqual(snapshotRun(run));
    expect(snapshot.json().settings[0].data.bundle).toBeUndefined();
    expect((stored.get('skill') as Setting).data.bundle).toEqual(bundle);
    const edited = await app.inject({ method: 'PATCH', url: '/api/workbench/settings/skill', headers, payload: { expectedUpdatedAt: skill.updatedAt, data: { content: '# Edited' } } });
    expect(edited.statusCode).toBe(200);
    verifyBundle(edited.json().data.bundle);
    expect(edited.json().data.bundle.files.find((f: {path: string}) => f.path === 'references/guide.md')).toEqual(bundle.files.find(f => f.path === 'references/guide.md'));
    const copied = await app.inject({ method: 'POST', url: '/api/workbench/settings/skill/copy-to-workspace', headers, payload: {} });
    expect(copied.statusCode).toBe(200);
    expect(copied.json().data.bundle).toEqual(edited.json().data.bundle);
    expect(copied.json().data.content).toBe('# Edited');
  } finally { await app.close(); }
});
