// @vitest-environment happy-dom
import { qaPolicyFixture, requiredQaFixture } from './helpers/local-qa-fixture';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { workbenchApi, type Snapshot } from '../src/workbench/web/api';

const owner = { id: 'owner', email: 'owner@example.test', name: 'Owner', role: 'owner' as const };
const admin = { ...owner, id: 'admin', email: 'admin@example.test', role: 'admin' as const };
const member = { ...owner, id: 'member', email: 'member@example.test', role: 'member' as const };
const project = { id: 'project', name: 'Project', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: '2026-10-06' };
const runtime = { provider: 'openai' as const, method: 'codex-host' as const, connectorId: 'connector-real-123', available: true, codexAppServer: true, localWorktrees: true, projectIds: ['project'], models: ['gpt-6-luna'], lastSeen: '2026-10-06T10:00:00.000Z' };
const providerSetting = { id: 'provider-1', kind: 'provider' as const, name: 'Team Codex', data: { provider: 'openai', method: 'codex-host', connectorId: runtime.connectorId, default: true, enabled: true }, updatedAt: '2026-10-06T10:00:00.000Z' };
const profileSetting = { id: 'profile-1', kind: 'profile' as const, name: 'Builder', data: { model: 'gpt-6.1-sol', reasoning: 'medium', skillIds: [] }, updatedAt: '2026-10-06T10:00:00.000Z' };
function snapshot(currentMember = owner, settings = [] as Snapshot['settings'], runtimes = [runtime]): Snapshot {
  return { member: currentMember, projects: [project], works: [], messages: [], runs: [], artifacts: [], settings, runtimeProviders: runtimes, providerConnections: settings.filter(item => item.kind === 'provider').map(item => ({ id: item.id, name: item.name, connectorId: String(item.data.connectorId ?? ''), enabled: item.data.enabled !== false, default: item.data.default === true, status: item.data.enabled === false ? 'disabled' : 'available', models: runtime.models, projectIds: ['project'], localWorktrees: true })) };
}
function localQaFixture(projectId: string, fingerprint: string, checkCount = 2) {
  const version = new Date(Date.now() - 60_000).toISOString();
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const finishedAt = new Date(Date.now() - 20_000).toISOString();
  const capturedAt = new Date(Date.now() - 10_000).toISOString();
  const requirements = [
    { id: 'full-suite', category: 'tests' as const, commands: [{ executable: 'repo-bin' as const, bin: 'vitest', args: ['run'], timeoutMs: 60_000 }], report: 'vitest-json' as const },
    { id: 'typecheck', category: 'typecheck' as const, commands: [{ executable: 'repo-bin' as const, bin: 'tsc', args: ['--noEmit'], timeoutMs: 60_000 }], report: 'none' as const },
  ];
  const policy = { id: 'policy-current', version, projectId, repositoryUrl: 'https://github.com/blossomsai/menoteam', configuredBy: owner.id, coverage: 'project/v1' as const, requirements };
  const checks = requirements.slice(0, checkCount).map((requirement, index) => ({ requirementId: requirement.id, category: requirement.category, source: 'fixed-connector' as const, name: requirement.id, command: JSON.stringify(requirement.commands), exitCode: 0, output: 'ok', outputChannel: 'combined' as const, durationMs: 1, startedAt, finishedAt, testedRevision: fingerprint, ...(index === 0 ? { metrics: { total: 1, passed: 1, failed: 0, skipped: 0 } } : {}) }));
  return { policy, data: { localQaContract: 'project-local-qa/v2', policy, candidateFingerprint: fingerprint, stale: false, verification: 'current', capturedAt, checks } };
}

let root: Root;
let host: HTMLDivElement;
async function flush(action: () => void = () => undefined) { await act(async () => { action(); }); }
async function mount(current: Snapshot) {
  vi.spyOn(workbenchApi, 'me').mockResolvedValue(current.member);
  vi.spyOn(workbenchApi, 'snapshot').mockResolvedValue(current);
  vi.spyOn(workbenchApi, 'projectMessages').mockResolvedValue({ messages: [], nextBefore: null });
  vi.spyOn(workbenchApi, 'projectMembers').mockResolvedValue({ members: [current.member] });
  await flush(() => root.render(createElement(App)));
}
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing button ${label}: ${host.textContent}`);
  return found;
}
async function type(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await typeInput(input, value);
}
async function typeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await flush(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(selector: string, value: string) { const select = host.querySelector<HTMLSelectElement>(selector)!; await flush(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function chooseSelect(select: HTMLSelectElement, value: string) { await flush(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected live fetch in mounted UI test'))));
  sessionStorage.clear();
  window.history.replaceState(null, '', '/workbench/?view=model-providers');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

it('shows a saved Agent profile name in the Work composer without exposing its setting ID', async () => {
  const profileId = 'setting_263d-profile';
  const work = { id: 'work', projectId: project.id, title: 'Current Work', overview: '', status: 'in_progress' as const, revision: 1, profileId, connectionId: 'provider-1', sources: [], createdAt: '', updatedAt: '' };
  const current = snapshot(owner, [{ ...profileSetting, id: profileId, name: 'Readable Builder' }]);
  current.works = [work];
  window.history.replaceState(null, '', `/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
  await mount(current);

  const composer = host.querySelector<HTMLInputElement>('input[placeholder="Message Readable Builder…"]');
  expect(composer?.getAttribute('aria-label')).toBe('Message Readable Builder');
  expect(composer?.placeholder).toBe('Message Readable Builder…');
  expect(composer?.outerHTML).not.toContain(profileId);
  expect(current.works[0]?.profileId).toBe(profileId);
});

it('falls back to Agent when a saved Work profile is unavailable', async () => {
  const profileId = 'setting_missing-profile';
  const work = { id: 'work', projectId: project.id, title: 'Current Work', overview: '', status: 'in_progress' as const, revision: 1, profileId, connectionId: 'provider-1', sources: [], createdAt: '', updatedAt: '' };
  const current = snapshot();
  current.works = [work];
  window.history.replaceState(null, '', `/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
  await mount(current);

  const composer = host.querySelector<HTMLInputElement>('input[placeholder="Message Agent…"]');
  expect(composer?.getAttribute('aria-label')).toBe('Message Agent');
  expect(composer?.placeholder).toBe('Message Agent…');
  expect(composer?.outerHTML).not.toContain(profileId);
});

describe('mounted marketplace skill selection', () => {
  const catalogUrl = 'https://github.com/example/catalog/blob/main/marketplace.json';
  const listing = { name: 'Catalog', url: catalogUrl, commit: 'catalog-a', plugins: [{ name: 'alpha', description: '', category: 'Test' }, { name: 'beta', description: '', category: 'Test' }] };
  const pluginPreview = (pluginName = 'alpha', catalogCommit = 'catalog-a', pluginCommit = 'plugin-a') => ({
    catalog: { name: listing.name, url: catalogUrl, commit: catalogCommit },
    plugin: { name: pluginName, description: '', commit: pluginCommit, version: null }, unsupported: [],
    skills: ['one', 'two'].map(name => ({ name, description: `Metadata ${name}`, license: null, path: `skills/${name}/SKILL.md` })),
  });
  const hydratedPreview = (catalogCommit = 'catalog-a', pluginCommit = 'plugin-a') => ({
    ...pluginPreview('alpha', catalogCommit, pluginCommit),
    skills: ['one', 'two'].map(name => ({ name, description: `Verified ${name}`, license: null, path: `skills/${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: Verified ${name}\n---\n`, includedReferences: [], bundleFiles: [{ path: 'SKILL.md', mode: '100644', bytes: 42, sha256: 'a'.repeat(64) }], bundleSha256: `${name === 'one' ? 'b' : 'c'}${'0'.repeat(63)}`, contentSha256: 'd'.repeat(64) })),
  });
  async function openMarketplace(current = snapshot()) {
    localStorage.clear();
    window.history.replaceState(null, '', '/workbench/?view=skills&project=project');
    vi.spyOn(workbenchApi, 'listCatalog').mockResolvedValue(listing);
    await mount(current);
    await type('#marketplace-url-project', catalogUrl);
    const form = host.querySelector<HTMLInputElement>('#marketplace-url-project')!.closest('form')!;
    await flush(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await choose('#marketplace-plugin-project', 'alpha');
  }
  async function inspectPlugin() { await flush(() => button('Inspect plugin').click()); }
  async function selectFirstSkill() { await flush(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }

  it('drops hydration results after the selection, plugin or project changes', async () => {
    const pending = deferred<Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>>();
    const previewCall = vi.spyOn(workbenchApi, 'previewCatalogPlugin').mockImplementation(input => input.selectedPaths ? pending.promise : Promise.resolve(pluginPreview() as Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>));
    const projects = [project, { ...project, id: 'project-b', name: 'Project B' }];
    await openMarketplace({ ...snapshot(), projects });
    await inspectPlugin(); await selectFirstSkill(); await flush(() => button('Load selected skill details').click());
    expect(previewCall.mock.calls.at(-1)?.[0].selectedPaths).toEqual(['skills/one/SKILL.md']);
    await flush(() => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click());
    pending.resolve(hydratedPreview() as Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>);
    await flush();
    expect(host.textContent).not.toContain('Inspect verified SKILL.md');
    expect(button('Import 2 selected skills').disabled).toBe(true);

    const nextPending = deferred<Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>>();
    previewCall.mockImplementation(input => input.selectedPaths ? nextPending.promise : Promise.resolve(pluginPreview(input.pluginName) as Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>));
    await flush(() => button('Load selected skill details').click());
    await choose('#marketplace-plugin-project', 'beta');
    nextPending.resolve(hydratedPreview() as Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>);
    await flush();
    expect(host.textContent).not.toContain('Verified one');
    expect(host.textContent).not.toContain('Inspect verified SKILL.md');

    await choose('#marketplace-plugin-project', 'alpha'); await inspectPlugin(); await selectFirstSkill();
    const projectPending = deferred<Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>>();
    previewCall.mockImplementation(input => input.selectedPaths ? projectPending.promise : Promise.resolve(pluginPreview() as Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>));
    await flush(() => button('Load selected skill details').click());
    window.history.replaceState(null, '', '/workbench/?view=skills&project=project-b');
    await flush(() => root.render(createElement(App)));
    projectPending.resolve(hydratedPreview() as Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>);
    await flush();
    expect(host.textContent).not.toContain('Inspect verified SKILL.md');
    expect(host.textContent).not.toContain('Verified one');
  });

  it.each(['catalog', 'plugin'] as const)('invalidates selection when hydrated %s commit moves', async moved => {
    vi.spyOn(workbenchApi, 'previewCatalogPlugin').mockImplementation(input => Promise.resolve(input.selectedPaths ? hydratedPreview(moved === 'catalog' ? 'catalog-b' : 'catalog-a', moved === 'plugin' ? 'plugin-b' : 'plugin-a') : pluginPreview() as Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>>));
    await openMarketplace(); await inspectPlugin(); await selectFirstSkill();
    await flush(() => button('Load selected skill details').click());
    expect(host.textContent).toContain('changed. Inspect the plugin again');
    expect(host.textContent).not.toContain('Inspect verified SKILL.md');
    expect(host.textContent).not.toContain('Import 1 selected skill');
  });
});
afterEach(async () => { await flush(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('mounted provider connection settings', () => {
  it('shows the supported initial Work selection before its first execution snapshot exists', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=new-work');
    const work = { id: 'new-work', projectId: project.id, title: 'New Work', overview: '', status: 'queued' as const, revision: 1, profileId: '', connectionId: providerSetting.id, sources: [], createdAt: '', updatedAt: '' };
    await mount({ ...snapshot(owner, [providerSetting]), works: [work] });
    expect(host.textContent).toContain('gpt-6-luna');
    expect(host.textContent).not.toContain('This model is not reported');
    expect(host.textContent).not.toContain('Historical profile snapshot unavailable');
  });

  it('shows the implementation snapshot profile after the Work selection has drifted', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=frozen-work');
    const work = { id: 'frozen-work', projectId: project.id, title: 'Frozen Work', overview: '', status: 'in_progress' as const, revision: 2, profileId: 'changed-profile', connectionId: providerSetting.id, sources: [], createdAt: '', updatedAt: '' };
    const run = { id: 'implementation-1', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Build', model: 'gpt-6.1-sol', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:01:00.000Z', execution: { provider: 'openai' as const, method: 'codex-host' as const, connectionId: providerSetting.id, connectorId: runtime.connectorId, model: 'gpt-6.1-sol', profileId: profileSetting.id, profile: { id: profileSetting.id, name: 'Original Builder', data: profileSetting.data }, skills: [], tools: [] } };
    await mount({ ...snapshot(owner, [providerSetting, profileSetting]), works: [work], runs: [run] });
    expect(host.textContent).toContain('Original Builder');
    expect(host.textContent).toContain('Frozen after implementation starts.');
    expect(host.querySelector(`#work-profile-${work.id}`)).toBeNull();
  });

  it.each(['revoked project grant', 'unrecorded identity', 'explicit capability revocation'])('does not present legacy continuation after %s', async change => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=legacy-work');
    const work = { id: 'legacy-work', projectId: project.id, title: 'Legacy Work', overview: '', status: 'paused' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const run = { id: 'legacy-run', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Continue', model: 'gpt-6-luna', reasoning: 'medium', status: 'paused' as const, generation: 1, connectorId: change === 'unrecorded identity' ? undefined : runtime.connectorId, threadId: 'original-thread', createdAt: '', updatedAt: '', execution: { provider: 'openai' as const, method: 'codex-host' as const, skills: [], tools: [] } };
    const current = { ...snapshot(owner), works: [work], runs: [run], runtimeProviders: [{ ...runtime, projectIds: change === 'revoked project grant' ? ['another-project'] : [project.id], localWorktrees: change === 'explicit capability revocation' ? false : true }] };
    await mount(current);
    expect(host.textContent).not.toContain('This legacy Work continues');
    expect(host.textContent).toContain('original-thread');
    expect(host.textContent).toContain(change === 'unrecorded identity' ? 'binding cannot be proven' : change === 'revoked project grant' ? 'no matching Connector is currently authorized' : 'no longer reports required execution capabilities');
  });

  it('adds only the selected enrolled Connector identity and marks the first connection default', async () => {
    await mount(snapshot());
    vi.spyOn(workbenchApi, 'saveSetting').mockResolvedValue(providerSetting);
    vi.mocked(workbenchApi.snapshot).mockResolvedValue(snapshot(owner, [providerSetting]));
    await type('#provider-connection-name', 'Team Codex');
    const select = host.querySelector<HTMLSelectElement>('#provider-connector')!;
    await flush(() => { select.value = runtime.connectorId; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush(() => button('Add connection').click());
    expect(workbenchApi.saveSetting).toHaveBeenCalledWith({ kind: 'provider', name: 'Team Codex', data: { provider: 'openai', method: 'codex-host', connectorId: runtime.connectorId, default: true, enabled: true } });
    expect(host.textContent).toContain('Team Codex');
  });

  it('lets workspace admins rename, set default, and disable a bound connection', async () => {
    await mount(snapshot(admin, [providerSetting]));
    const update = vi.spyOn(workbenchApi, 'updateSetting').mockResolvedValue(providerSetting);
    expect(host.textContent).toContain('Available'); expect(host.textContent).toContain('Default'); expect(host.textContent).toContain('gpt-6-luna');
    await flush(() => button('Rename').click()); await type('#provider-name-provider-1', 'Renamed Codex'); await flush(() => button('Save name').click());
    expect(update).toHaveBeenCalledWith('provider-1', { name: 'Renamed Codex', expectedUpdatedAt: providerSetting.updatedAt });
    await flush(() => button('Disable').click());
    expect(update).toHaveBeenLastCalledWith('provider-1', { data: { enabled: false }, expectedUpdatedAt: providerSetting.updatedAt });
  });

  it('shows host availability separately from the last completed native-run evidence', async () => {
    const verified = { ...runtime, verifiedRunId: 'run-native-verified', verifiedAt: '2026-10-06T10:03:00.000Z' };
    const current = snapshot(owner, [providerSetting], [verified]);
    current.providerConnections = [{ id: providerSetting.id, name: providerSetting.name, connectorId: verified.connectorId, enabled: true, default: true, status: 'available', models: verified.models, projectIds: ['project'], localWorktrees: true }];
    await mount(current);
    expect(host.textContent).toContain('Available');
    expect(host.textContent).toContain('online');
    expect(host.textContent).toContain('Codex app available');
    expect(host.textContent).toContain('local worktrees available');
    expect(host.textContent).toContain('Last completed native run');
    expect(host.textContent).toContain(verified.verifiedRunId);
  });

  it('does not infer a completed native run from heartbeat alone', async () => {
    await mount(snapshot(owner, [providerSetting], [{ ...runtime, verifiedRunId: undefined, verifiedAt: undefined }]));
    expect(host.textContent).toContain('Available');
    expect(host.textContent).toContain('No completed native run has been verified yet.');
  });

  it('does not call an online host Available when a required capability is absent', async () => {
    const unsupported = { ...runtime, localWorktrees: false };
    const current = snapshot(owner, [providerSetting], [unsupported]);
    current.providerConnections = [{ id: providerSetting.id, name: providerSetting.name, connectorId: unsupported.connectorId, enabled: true, default: true, status: 'available', models: unsupported.models, projectIds: ['project'], localWorktrees: false }];
    await mount(current);
    expect(host.textContent).toContain('Capability unavailable');
    expect(host.textContent).not.toContain('DefaultAvailable');
  });

  it('keeps the rename draft when the server rejects a stale update', async () => {
    await mount(snapshot(owner, [providerSetting]));
    vi.spyOn(workbenchApi, 'updateSetting').mockRejectedValue(new Error('Setting changed; reload before updating'));
    await flush(() => button('Rename').click()); await type('#provider-name-provider-1', 'My draft name'); await flush(() => button('Save name').click());
    expect(host.querySelector<HTMLInputElement>('#provider-name-provider-1')?.value).toBe('My draft name');
    expect(host.textContent).toContain('Setting changed; reload before updating');
  });

  it('hides workspace provider management from members', async () => {
    await mount(snapshot(member, [providerSetting]));
    expect(host.textContent).toContain('Workspace administrator access required');
    expect(host.textContent).not.toContain('Add connection'); expect(host.textContent).not.toContain('Rename');
  });

  it('shows offline and disabled truth without offering them as a default', async () => {
    const disabled = { ...providerSetting, data: { ...providerSetting.data, default: false, enabled: false } };
    await mount(snapshot(owner, [disabled]));
    expect(host.textContent).toContain('Disabled');
    expect(host.textContent).not.toContain('Make default');
    const addSelect = host.querySelector<HTMLSelectElement>('#provider-connector')!;
    expect([...addSelect.options].some(option => option.value === runtime.connectorId)).toBe(false);
  });

  it('offers the default action only for an available connection', async () => {
    const secondRuntime = { ...runtime, connectorId: 'connector-second' };
    const secondSetting = { ...providerSetting, id: 'provider-2', name: 'Second Codex', data: { ...providerSetting.data, connectorId: secondRuntime.connectorId, default: false } };
    await mount(snapshot(owner, [providerSetting, secondSetting], [runtime, secondRuntime]));
    vi.spyOn(workbenchApi, 'updateSetting').mockResolvedValue(secondSetting);
    await flush(() => button('Make default').click());
    expect(workbenchApi.updateSetting).toHaveBeenCalledWith('provider-2', { data: { default: true }, expectedUpdatedAt: secondSetting.updatedAt });
  });

  it('marks a connected but capability-incompatible host and blocks selecting it for Add', async () => {
    const unsupported = { ...runtime, codexAppServer: false };
    await mount(snapshot(owner, [], [unsupported]));
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false); // Workspace navigation remains available.
    expect([...host.querySelectorAll('#provider-connector option')].map(option => option.value)).toEqual(['']);
  });

  it.each([
    ['disabled', 'Disabled'], ['unbound', 'Unbound'], ['disconnected', 'Disconnected'], ['offline', 'Offline'], ['capability_unavailable', 'Capability unavailable'], ['available', 'Available'],
  ])('renders server status %s as %s', async (status, label) => {
    const current = snapshot(owner, [providerSetting]);
    current.providerConnections = [{ id: providerSetting.id, name: providerSetting.name, connectorId: runtime.connectorId, enabled: status !== 'disabled', default: true, status, models: runtime.models, projectIds: ['project'] }];
    await mount(current);
    expect(host.textContent).toContain(label);
  });

  it('offers the union of available connection models and permits metadata edits to an unavailable saved model', async () => {
    window.history.replaceState(null, '', '/workbench/?view=agent-profiles');
    const secondRuntime = { ...runtime, connectorId: 'connector-secondary', models: ['gpt-6.1-sol'] };
    const secondProvider = { ...providerSetting, id: 'provider-2', name: 'Secondary Codex', data: { ...providerSetting.data, connectorId: secondRuntime.connectorId, default: false } };
    const current = snapshot(owner, [providerSetting, secondProvider, profileSetting], [runtime, secondRuntime]);
    current.providerConnections = [
      { id: providerSetting.id, name: providerSetting.name, connectorId: runtime.connectorId, enabled: true, default: true, status: 'available', models: runtime.models, projectIds: ['project'] },
      { id: secondProvider.id, name: secondProvider.name, connectorId: secondRuntime.connectorId, enabled: true, default: false, status: 'available', models: secondRuntime.models, projectIds: ['project'] },
    ];
    await mount(current);
    const newProfileModels = [...host.querySelectorAll<HTMLSelectElement>('#profile-model option')].map(option => option.value);
    expect(newProfileModels).toContain('gpt-6-luna'); expect(newProfileModels).toContain('gpt-6.1-sol');
    vi.spyOn(workbenchApi, 'saveSetting').mockResolvedValue({ ...profileSetting, name: 'Supported profile', data: { ...profileSetting.data, model: 'gpt-6.1-sol' } });
    vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
    await type('#profile-name', 'Supported profile');
    const newModel = host.querySelector<HTMLSelectElement>('#profile-model')!;
    await flush(() => { newModel.value = 'gpt-6.1-sol'; newModel.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush(() => button('Add profile').click());
    expect(workbenchApi.saveSetting).toHaveBeenCalledWith({ kind: 'profile', name: 'Supported profile', data: { model: 'gpt-6.1-sol', reasoning: 'medium', skillIds: [] } });
    await flush(() => button('Edit').click());
    expect(button('Save').disabled).toBe(false);
  });

  it('retains an unavailable saved profile model while allowing a metadata-only rename', async () => {
    window.history.replaceState(null, '', '/workbench/?view=agent-profiles');
    const current = snapshot(owner, [providerSetting, profileSetting]);
    await mount(current);
    vi.spyOn(workbenchApi, 'updateSetting').mockResolvedValue(profileSetting);
    vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
    await flush(() => button('Edit').click());
    const model = host.querySelector<HTMLSelectElement>('#setting-model-profile-1')!;
    expect([...model.options].find(option => option.value === 'gpt-6.1-sol')?.disabled).toBe(true);
    expect(button('Save').disabled).toBe(false);
    await type('#setting-name-profile-1', 'Builder renamed'); await flush(() => button('Save').click());
    expect(workbenchApi.updateSetting).toHaveBeenCalledWith(profileSetting.id, { name: 'Builder renamed', data: profileSetting.data, expectedUpdatedAt: profileSetting.updatedAt });
  });

  it('shows each Work’s frozen provider and blocks a model missing from that connection', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1');
    const work = { id: 'work-1', projectId: 'project', title: 'Bound Work', overview: 'Implementation', status: 'queued' as const, revision: 1, profileId: profileSetting.id, connectionId: providerSetting.id, sources: [], createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z' };
    const run = { id: 'run-1', projectId: 'project', workId: work.id, prompt: 'Implement', kind: 'implementation' as const, model: 'gpt-6.1-sol', reasoning: 'medium', status: 'queued' as const, generation: 0, createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z', execution: { provider: 'openai' as const, method: 'codex-host' as const, connectionId: providerSetting.id, connectorId: runtime.connectorId, model: 'gpt-6.1-sol', profileId: profileSetting.id, profile: { id: profileSetting.id, name: profileSetting.name, data: profileSetting.data }, skills: [], tools: [] } };
    const current = { ...snapshot(owner, [providerSetting, profileSetting]), works: [work], runs: [run] };
    await mount(current);
    expect(host.textContent).toContain('Provider connection'); expect(host.textContent).toContain('Team Codex'); expect(host.textContent).toContain(runtime.connectorId); expect(host.textContent).toContain('This model is not reported by the Work’s bound provider connection.');
  });

  it.each(['empty stored draft','existing draft'])('New work opens Master preset without automatic creation or sending: %s',async scenario=>{
    const projectB={...project,id:'project-b',name:'Project B'};
    const current=snapshot(owner,[]);current.projects=[project,projectB];
    const preset='Help me plan a new work:';
    sessionStorage.setItem(`menoteam-workbench:draft:${owner.id}:${projectB.id}:master`,scenario==='existing draft'?'My unsent draft':'');
    window.history.replaceState(null,'',`/workbench/?view=master&project=${projectB.id}&draft=${encodeURIComponent(preset)}`);
    const send=vi.spyOn(workbenchApi,'sendMessage');const create=vi.spyOn(workbenchApi,'createWork');
    await mount(current);
    const expected=scenario==='existing draft'?'My unsent draft':preset;
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')?.value).toBe(expected);
    expect(host.querySelector('[aria-label="Create new Work"]')).toBeNull();
    expect(new URL(window.location.href).searchParams.has('draft')).toBe(false);
    expect(send).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
    vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);await flush();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')?.value).toBe(expected);
    await flush(()=>root.unmount());root=createRoot(host);await mount(current);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')?.value).toBe(expected);
    expect(send).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
  });

  it.each(['marked diagnostic', 'legacy diagnostic', 'genuine failed Master', 'queued Master', 'claimed Master with diagnostic wording', 'native Master with diagnostic wording'])('preserves bootstrap semantics after a %s', async scenario => {
    const connection = { id: 'provider-b', name: 'B Codex', connectorId: 'connector-b', enabled: true, default: false, status: 'available', models: ['gpt-6.1-sol'], projectIds: [project.id] };
    const diagnostic = scenario === 'marked diagnostic' || scenario === 'legacy diagnostic';
    const current = snapshot(owner, [providerSetting]); current.providerConnections = [connection];
    current.runs = [{ id: 'master-history', projectId: project.id, kind: 'master', prompt: 'Wake', model: 'gpt-6.1-sol', reasoning: 'medium', status: scenario === 'queued Master' ? 'queued' : 'failed', generation: scenario === 'genuine failed Master' || scenario.startsWith('claimed') ? 1 : 0, createdAt: '', updatedAt: '', ...(scenario === 'marked diagnostic' ? { causedByRunId: 'completed-worker' } : {}), ...(scenario.startsWith('native') ? { threadId: 'responsible-native-thread' } : {}), error: scenario === 'legacy diagnostic' || scenario.includes('wording') ? 'Master wake was not dispatched: Selected Connector is offline' : 'Selected Connector is offline', ...(!diagnostic ? { targetConnectorId: 'connector-a' } : {}) }];
    window.history.replaceState(null, '', '/workbench/?view=all');
    await mount(current);
    const selector = host.querySelector<HTMLSelectElement>('[aria-label="Master provider connection"]');
    if (!diagnostic) { expect(selector).toBeNull(); return; }
    expect(selector).toBeTruthy();
    const send = vi.spyOn(workbenchApi, 'sendMessage').mockResolvedValue({ message: {} as never, run: {} as never });
    await chooseSelect(selector!, connection.id); await type('input[aria-label="Message Master"]', 'Explicit first Master');
    await flush(() => button('Send message').click());
    expect(send).toHaveBeenCalledWith(project.id, expect.objectContaining({ connectionId: connection.id }));
    expect(providerSetting.data.default).toBe(true); expect(connection.default).toBe(false);
  });

  it('selects a project-granted connection for a new Master bootstrap without changing the default', async () => {
    const projectB = { ...project, id: 'project-b', name: 'Project B' };
    const connectionB = { id: 'provider-b', name: 'B Codex', connectorId: 'connector-b', enabled: true, default: false, status: 'available', models: ['gpt-6.1-sol'], projectIds: [projectB.id] };
    const current = snapshot(owner, []); current.projects = [project, projectB]; current.providerConnections = [connectionB];
    current.runtimeProviders = [{ ...runtime, connectorId: 'connector-b', projectIds: [projectB.id], models: ['gpt-6.1-sol'] }];
    window.history.replaceState(null, '', `/workbench/?view=master&project=${projectB.id}`);
    await mount(current);
    const send = vi.spyOn(workbenchApi, 'sendMessage').mockResolvedValue({ message: {} as never, run: {} as never });
    await type('input[aria-label="Message Master"]', 'Start Project B Master'); await choose('[aria-label="Master provider connection"]', 'provider-b');
    await flush(() => button('Send message').click());
    expect(send).toHaveBeenCalledWith(projectB.id, expect.objectContaining({ text: 'Start Project B Master', connectionId: 'provider-b' }));
    expect(connectionB.default).toBe(false);
  });

  it('lets the All projects Project B composer bootstrap explicitly on B while filtering other grants and unavailable hosts', async () => {
    const projectB = { ...project, id: 'project-b', name: 'Project B' };
    const connectionA = { id: 'provider-a', name: 'A Codex', connectorId: 'connector-a', enabled: true, default: true, status: 'available', models: ['gpt-6.1-sol'], projectIds: [project.id], localWorktrees: true };
    const connectionB = { id: 'provider-b', name: 'B Codex', connectorId: 'connector-b', enabled: true, default: false, status: 'available', models: ['gpt-6.1-sol'], projectIds: [projectB.id], localWorktrees: true };
    const offline = { id: 'provider-offline', name: 'Offline Codex', connectorId: 'connector-offline', enabled: true, default: false, status: 'offline', models: ['gpt-6.1-sol'], projectIds: [projectB.id], localWorktrees: true };
    const current = snapshot(owner, []); current.projects = [project, projectB]; current.providerConnections = [connectionA, connectionB, offline];
    window.history.replaceState(null, '', '/workbench/?view=all');
    await mount(current);
    const card = host.querySelector('[aria-label="Project B conversation"]')?.closest('section');
    const selector = card?.querySelector<HTMLSelectElement>('[aria-label="Master provider connection"]');
    expect(selector).toBeTruthy();
    expect([...selector!.options].map(option => option.value)).toEqual(['', 'provider-b']);
    const send = vi.spyOn(workbenchApi, 'sendMessage').mockResolvedValue({ message: {} as never, run: {} as never });
    await typeInput(card!.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')!, 'Start Project B Master from All projects');
    await chooseSelect(selector!, 'provider-b');
    await flush(() => (card!.querySelector('[aria-label="Send message"]') as HTMLButtonElement).click());
    expect(send).toHaveBeenCalledWith(projectB.id, expect.objectContaining({ text: 'Start Project B Master from All projects', connectionId: 'provider-b' }));
    expect(connectionA.default).toBe(true); expect(connectionB.default).toBe(false);
    const cardA = host.querySelector('[aria-label="Project conversation"]')?.closest('section');
    expect(cardA?.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')?.value).toBe('');
    expect(cardA?.querySelector<HTMLSelectElement>('[aria-label="Master provider connection"]')?.value).toBe('');
  });

  it('keeps an All projects project draft and explicit connection through refresh and focused Master navigation after a server denial', async () => {
    const projectB = { ...project, id: 'project-b', name: 'Project B' };
    const connectionA = { id: 'provider-a', name: 'A Codex', connectorId: 'connector-a', enabled: true, default: true, status: 'available', models: ['gpt-6.1-sol'], projectIds: [project.id], localWorktrees: true };
    const connectionB = { id: 'provider-b', name: 'B Codex', connectorId: 'connector-b', enabled: true, default: false, status: 'available', models: ['gpt-6.1-sol'], projectIds: [projectB.id], localWorktrees: true };
    const work = { id: 'work-b', projectId: projectB.id, title: 'Existing B Work', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', connectionId: 'provider-b', sources: [], createdAt: '', updatedAt: '' };
    const current = snapshot(owner, []); current.projects = [project, projectB]; current.works = [work]; current.providerConnections = [connectionA, connectionB];
    window.history.replaceState(null, '', '/workbench/?view=all');
    await mount(current);
    const send = vi.spyOn(workbenchApi, 'sendMessage').mockRejectedValueOnce(new Error('Project connection grant was revoked')).mockResolvedValue({ message: {} as never, run: {} as never });
    const card = host.querySelector('[aria-label="Project B conversation"]')?.closest('section')!;
    await typeInput(card.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')!, 'Keep this scoped B draft');
    await chooseSelect(card.querySelector<HTMLSelectElement>('[aria-label="Master provider connection"]')!, 'provider-b');
    await flush(() => (card.querySelector('[aria-label="Send message"]') as HTMLButtonElement).click());
    expect(send).toHaveBeenCalledWith(projectB.id, expect.objectContaining({ connectionId: 'provider-b', text: 'Keep this scoped B draft' }));
    expect(host.textContent).toContain('Project connection grant was revoked');
    expect(send).toHaveBeenCalledTimes(1);
    await flush(() => button('Retry').click());
    expect(card.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')?.value).toBe('Keep this scoped B draft');
    window.history.replaceState(null, '', `/workbench/?view=work-detail&project=${projectB.id}&work=${work.id}`);
    await flush(() => root.render(createElement(App)));
    await type('input[aria-label="Message Agent"]', 'Continue existing B Work');
    await flush(() => button('Send message').click());
    expect(send).toHaveBeenLastCalledWith(projectB.id, expect.not.objectContaining({ connectionId: expect.anything() }));
    expect(send).toHaveBeenLastCalledWith(projectB.id, expect.objectContaining({ workId: work.id, text: 'Continue existing B Work' }));
    window.history.replaceState(null, '', '/workbench/?view=all');
    await flush(() => root.render(createElement(App)));
    const projectBCard = host.querySelector('[aria-label="Project B conversation"]')?.closest('section');
    expect(projectBCard?.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')?.value).toBe('Keep this scoped B draft');
    expect(projectBCard?.querySelector<HTMLSelectElement>('[aria-label="Master provider connection"]')?.value).toBe('provider-b');
    window.history.replaceState(null, '', `/workbench/?view=master&project=${projectB.id}`);
    await flush(() => root.render(createElement(App)));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')?.value).toBe('Keep this scoped B draft');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Master provider connection"]')?.value).toBe('provider-b');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.filter(([projectId, input]) => projectId === projectB.id && input.workId !== undefined)).toHaveLength(1);
    vi.mocked(workbenchApi.snapshot).mockResolvedValue({ ...current, providerConnections: [connectionA, { ...connectionB, status: 'offline' }] });
    await flush(() => { vi.advanceTimersByTime(2_000); });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Master provider connection"]')?.value).toBe('provider-b');
    expect(button('Send message').disabled).toBe(true);
    expect(host.textContent).toContain('Selected connection unavailable; no default will be substituted.');
    await flush(() => button('Send message').click());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('renders legacy Connector/thread affinity when the old execution snapshot lacks execution.connectorId', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=legacy-work');
    const work = { id: 'legacy-work', projectId: project.id, title: 'Legacy Work', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const legacyRun = { id: 'legacy-run', projectId: project.id, workId: work.id, prompt: 'Continue', kind: 'implementation' as const, model: 'gpt-6-luna', reasoning: 'medium', status: 'running' as const, generation: 0, connectorId: runtime.connectorId, threadId: 'thread-native-1', createdAt: '', updatedAt: '', execution: { provider: 'openai' as const, method: 'codex-host' as const, model: 'gpt-6-luna', skills: [], tools: [] } } as Snapshot['runs'][number];
    const current = { ...snapshot(owner), runtimeProviders: [{ ...runtime, localWorktrees: undefined }], works: [work], runs: [legacyRun] };
    await mount(current);
    expect(host.textContent).toContain('Historical Connector (no connection record)'); expect(host.textContent).toContain(runtime.connectorId); expect(host.textContent).toContain('thread-native-1');
    expect(host.textContent).toContain('This legacy Work continues on its recorded Connector and native thread.'); expect(host.textContent).not.toContain('Execution is blocked'); expect(host.textContent).not.toContain('Connector unavailable');
  });

  it('uses the authorized legacy runtime provider when the entire execution snapshot is absent', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=legacy-work');
    const work = { id: 'legacy-work', projectId: project.id, title: 'Legacy Work', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const run = { id: 'legacy-run-private-id', projectId: project.id, workId: work.id, prompt: 'Continue', kind: 'implementation' as const, model: 'gpt-6-luna', reasoning: 'medium', status: 'running' as const, generation: 1, connectorId: runtime.connectorId, threadId: 'legacy-thread-private-id', createdAt: '', updatedAt: '' } as Snapshot['runs'][number];
    await mount({ ...snapshot(owner), works: [work], runs: [run] });
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    const collapsedSummary = host.textContent?.replace(details.textContent ?? '', '') ?? '';
    expect(collapsedSummary).toContain('OpenAI'); expect(collapsedSummary).toContain('gpt-6-luna'); expect(collapsedSummary).toContain('historical affinity');
    expect(collapsedSummary).not.toContain('Provider not recorded'); expect(collapsedSummary).not.toContain('unavailable');
    expect(collapsedSummary).not.toContain('legacy-run-private-id'); expect(collapsedSummary).not.toContain(runtime.connectorId); expect(collapsedSummary).not.toContain('legacy-thread-private-id');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(details.textContent).toContain('legacy-run-private-id'); expect(details.textContent).toContain(runtime.connectorId); expect(details.textContent).toContain('legacy-thread-private-id');
    details.open = true;
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('legacy-thread-private-id');
  });

  it('keeps unknown provider metadata neutral and reports an unavailable legacy runtime', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=unknown-provider-work');
    const work = { id: 'unknown-provider-work', projectId: project.id, title: 'Unknown Provider Work', overview: '', status: 'paused' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const run = { id: 'unknown-provider-run', projectId: project.id, workId: work.id, prompt: 'Continue', kind: 'implementation' as const, model: 'gpt-6-luna', reasoning: 'medium', status: 'paused' as const, generation: 1, connectorId: runtime.connectorId, threadId: 'unknown-provider-thread', createdAt: '', updatedAt: '' } as Snapshot['runs'][number];
    const unknownRuntime = { ...runtime, provider: undefined, available: false } as unknown as Snapshot['runtimeProviders'][number];
    await mount({ ...snapshot(owner), runtimeProviders: [unknownRuntime], works: [work], runs: [run] });
    const details = host.querySelector('details')!;
    const collapsedSummary = host.textContent?.replace(details.textContent ?? '', '') ?? '';
    expect(collapsedSummary).toContain('Provider not recorded');
    expect(collapsedSummary).toContain('historical ID recorded · unavailable');
    expect(collapsedSummary).not.toContain('historical affinity');
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.closest('details')).toBeNull();
    expect(alert?.textContent).toContain('historical Connector identity is recorded, but that Connector is currently unavailable.');
  });

  it('keeps readable handoff summary and actual failures visible while IDs stay in collapsed diagnostics', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=handoff-work');
    const work = { id: 'handoff-work', projectId: project.id, title: 'Handoff Work', overview: '', status: 'failed' as const, revision: 2, profileId: 'profile-private-id', connectionId: providerSetting.id, sources: [], createdAt: '', updatedAt: '' };
    const run = { id: 'run-private-id', projectId: project.id, workId: work.id, prompt: 'Continue', kind: 'implementation' as const, model: 'gpt-6.1-sol', reasoning: 'medium', status: 'failed' as const, generation: 2, handoffFromRunId: 'prior-run-private-id', error: 'Runtime failed in run-private-id', connectorId: runtime.connectorId, threadId: 'native-thread-private-id', createdAt: '', updatedAt: '', execution: { provider: 'openai' as const, method: 'codex-host' as const, connectionId: providerSetting.id, connectorId: runtime.connectorId, model: 'gpt-6.1-sol', profileId: 'profile-private-id', profile: { id: 'profile-private-id', name: 'Original Builder', data: { ...profileSetting.data, model: 'gpt-6-luna' } }, skills: [], tools: [] } } as Snapshot['runs'][number];
    await mount({ ...snapshot(owner, [providerSetting, profileSetting]), works: [work], runs: [run] });
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    const collapsedSummary = host.textContent?.replace(details.textContent ?? '', '') ?? '';
    expect(collapsedSummary).toContain('OpenAI'); expect(collapsedSummary).toContain('Team Codex'); expect(collapsedSummary).toContain('Original Builder'); expect(collapsedSummary).toContain('gpt-6.1-sol'); expect(collapsedSummary).toContain('failed'); expect(collapsedSummary).toContain('Explicit model handoff');
    expect(collapsedSummary).not.toContain('prior-run-private-id'); expect(collapsedSummary).not.toContain('native-thread-private-id'); expect(collapsedSummary).not.toContain('connector-real-123'); expect(collapsedSummary).not.toContain('profile-private-id');
    const alerts = [...host.querySelectorAll('[role="alert"]')];
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(alerts.every(alert => alert.closest('details') === null)).toBe(true);
    expect(alerts.map(alert => alert.textContent).join(' ')).toContain('Runtime failed in run-private-id');
    expect(alerts.map(alert => alert.textContent).join(' ')).toContain('This model is not reported by the Work’s bound provider connection.');
    expect(details.textContent).toContain('run-private-id'); expect(details.textContent).toContain('prior-run-private-id'); expect(details.textContent).toContain('native-thread-private-id'); expect(details.textContent).toContain('connector-real-123'); expect(details.textContent).toContain('profile-private-id'); expect(details.textContent).toContain(providerSetting.id);
    details.open = true;
    expect(details.open).toBe(true);
    expect(details.querySelector('dd')?.textContent).toBe('run-private-id');
  });

  it('shows revoked Worktree capability and does not offer an incompatible default action', async () => {
    const incompatibleRuntime = { ...runtime, localWorktrees: false };
    const current = snapshot(owner, [providerSetting], [incompatibleRuntime]);
    current.providerConnections = [{ id: providerSetting.id, name: providerSetting.name, connectorId: runtime.connectorId, enabled: true, default: true, status: 'capability_unavailable', models: runtime.models, projectIds: ['project'], localWorktrees: false, reason: 'Local Worktree capability unavailable' }];
    await mount(current);
    expect(host.textContent).toContain('Capability unavailable'); expect(host.textContent).toContain('Local Worktree capability unavailable');
    expect(host.textContent).not.toContain('Make default');
    expect([...host.querySelectorAll<HTMLSelectElement>('#provider-connector option')].map(option => option.value)).toEqual(['']);
  });


  it('keeps the New work Master draft after an explicit project connection denial without substituting a default',async()=>{
    const projectB={...project,id:'project-b',name:'Project B'};
    const current=snapshot(owner,[]);current.projects=[project,projectB];current.providerConnections=[{id:'provider-b',name:'B Codex',connectorId:'connector-b',enabled:true,default:false,status:'available',models:['gpt-6.1-sol'],projectIds:[projectB.id],localWorktrees:true}];
    window.history.replaceState(null,'',`/workbench/?view=master&project=${projectB.id}&draft=Help%20me%20plan%20a%20new%20work%3A`);
    const send=vi.spyOn(workbenchApi,'sendMessage').mockRejectedValue(new Error('Project connection grant was revoked'));
    const create=vi.spyOn(workbenchApi,'createWork');await mount(current);
    const select=host.querySelector<HTMLSelectElement>('select[aria-label="Master provider connection"]');
    expect(select).not.toBeNull();await flush(()=>{select!.value='provider-b';select!.dispatchEvent(new Event('change',{bubbles:true}));});
    await flush(()=>button('Send message').click());
    expect(send).toHaveBeenCalledWith(projectB.id,expect.objectContaining({connectionId:'provider-b',text:'Help me plan a new work:'}));
    expect(host.textContent).toContain('Project connection grant was revoked');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Message Master"]')?.value).toBe('Help me plan a new work:');
    expect(create).not.toHaveBeenCalled();
  });

  it('shows a recorded legacy Connector ID as unavailable when no scoped runtime is present', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=legacy-work');
    const work = { id: 'legacy-work', projectId: project.id, title: 'Legacy Work', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const run = { id: 'legacy-run', projectId: project.id, workId: work.id, prompt: 'Continue', kind: 'implementation' as const, model: 'gpt-6-luna', reasoning: 'medium', status: 'paused' as const, generation: 0, connectorId: runtime.connectorId, threadId: 'thread-native-1', createdAt: '', updatedAt: '', execution: { provider: 'openai' as const, method: 'codex-host' as const, model: 'gpt-6-luna', skills: [], tools: [] } } as Snapshot['runs'][number];
    const current = { ...snapshot(owner), runtimeProviders: [], works: [work], runs: [run] };
    await mount(current);
    expect(host.textContent).toContain('historical ID recorded · unavailable'); expect(host.textContent).toContain(runtime.connectorId);
    expect(host.textContent).toContain('no matching Connector is currently authorized for this project'); expect(host.textContent).not.toContain('cannot be proven');
    expect(host.textContent).not.toContain('This legacy Work continues on its recorded Connector and native thread.');
  });

  it('blocks contradictory historical Connector claims and execution model snapshots', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=legacy-work');
    const work = { id: 'legacy-work', projectId: project.id, title: 'Legacy Work', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const run = { id: 'legacy-run', projectId: project.id, workId: work.id, prompt: 'Continue', kind: 'implementation' as const, model: 'gpt-6-luna', reasoning: 'medium', status: 'running' as const, generation: 0, connectorId: runtime.connectorId, targetConnectorId: 'connector-different', createdAt: '', updatedAt: '', execution: { provider: 'openai' as const, method: 'codex-host' as const, connectorId: runtime.connectorId, model: 'gpt-6.1-sol', skills: [], tools: [] } } as Snapshot['runs'][number];
    const current = { ...snapshot(owner), works: [work], runs: [run] };
    await mount(current);
    expect(host.textContent).toContain('Recorded Connector or model identities disagree'); expect(host.textContent).not.toContain('continues on its recorded Connector');
  });

  it.each([
    [{ totalFiles: 1, truncated: false }, 'Showing 1 of 1 changed file', 'Aggregate preview is complete'],
    [{ totalFiles: 4, truncated: true }, 'Showing 1 of 4 changed files', 'Aggregate preview is truncated'],
    [{ truncated: true }, 'Showing 1 changed file · total unknown', 'Aggregate preview is truncated'],
    [{ truncated: false }, 'Showing 1 changed file · total unknown', 'Aggregate preview is complete'],
    [{}, 'Showing 1 changed file · total unknown', 'Aggregate preview status is unknown'],
    [{ totalFiles: 0, truncated: false }, 'Showing 1 changed file · total unknown', 'Aggregate preview is complete'],
    [{ totalFiles: 1.5, truncated: 'true' }, 'Showing 1 changed file · total unknown', 'Aggregate preview status is unknown'],
  ])('renders authoritative shown/total count and truncation honestly', async (metadata, label, truncated) => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const work = { id: 'work-1', projectId: project.id, title: 'Diff proof', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const artifact = { id: 'diff-1', projectId: project.id, workId: work.id, runId: 'run-1', kind: 'diff' as const, revision: 'diff-revision', createdAt: '2026-10-06T10:00:00.000Z', data: { ...metadata, baseRevision: 'base-sha', additions: 1, deletions: 1, files: [{ path: 'src/example.ts', status: 'modified', binary: false, additions: 1, deletions: 1, hunks: [{ header: '@@ -2 +2 @@', lines: [{ type: 'remove', oldLine: 2, text: 'old' }, { type: 'add', newLine: 2, text: 'new' }] }] }] } };
    const current = { ...snapshot(), works: [work], artifacts: [artifact] } as Snapshot;
    vi.spyOn(workbenchApi, 'artifact').mockResolvedValue(artifact);
    vi.spyOn(workbenchApi,'diffFile').mockRejectedValue(new Error('Diff reads must remain lazy'));
    await mount(current);
    await flush();
    expect(host.textContent).toContain(label);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(truncated);
    const file=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/example.ts'))!;
    expect(file.open).toBe(false);
    expect(workbenchApi.diffFile).not.toHaveBeenCalled();
  });

  it('loads only an expanded file page and follows its bound cursor',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const work={id:'work-1',projectId:project.id,title:'Lazy diff',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const revision='a'.repeat(64),artifact={id:'diff-lazy',projectId:project.id,workId:work.id,runId:'run-lazy',kind:'diff' as const,revision,createdAt:'2026-10-06',data:{baseRevision:'b'.repeat(40),totalFiles:2,truncated:true,files:[{path:'src/one.ts',status:'modified',binary:false,additions:2,deletions:0,chunkCount:2,textBytes:500000},{path:'src/two.ts',status:'added',binary:false,additions:1,deletions:0,chunkCount:1,textBytes:40}]}};
    const read=vi.spyOn(workbenchApi,'diffFile').mockResolvedValueOnce({path:'src/one.ts',binary:false,complete:false,chunkIndex:0,chunkCount:2,contentBase64:btoa('first page'),nextCursor:'opaque-next'}).mockResolvedValueOnce({path:'src/one.ts',binary:false,complete:true,chunkIndex:1,chunkCount:2,contentBase64:btoa('second page'),nextCursor:null});
    await mount({...snapshot(),works:[work],artifacts:[artifact]} as Snapshot);await flush();
    expect(read).not.toHaveBeenCalled();
    const file=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/one.ts'))!;
    await flush(()=>{file.open=true;});await flush();
    expect(read).toHaveBeenCalledTimes(1);expect(read.mock.calls[0]?.slice(0,4)).toEqual([artifact.id,'src/one.ts',revision,undefined]);expect(host.textContent).toContain('first page');
    const next=[...file.querySelectorAll('button')].find(button=>button.textContent==='Next page')!;await flush(()=>next.click());await flush();
    expect(read).toHaveBeenCalledTimes(2);expect(read.mock.calls[1]?.[3]).toBe('opaque-next');expect(host.textContent).toContain('second page');
    const other=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/two.ts'))!;expect(other.open).toBe(false);
  });

  it('renders unified diff additions/removals with old and new line numbers',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const work={id:'work-1',projectId:project.id,title:'Line diff',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};const artifact={id:'diff-lines',projectId:project.id,workId:work.id,runId:'run-lines',kind:'diff' as const,revision:'e'.repeat(64),createdAt:'2026-10-06',data:{baseRevision:'b'.repeat(40),candidateRevision:'c'.repeat(40),files:[{path:'src/lines.ts',status:'modified',binary:false,additions:1,deletions:1,chunkCount:1,textBytes:64}]}};
    const patch='diff --git a/src/lines.ts b/src/lines.ts\n@@ -4,2 +4,2 @@\n before\n-old value\n+new value\n after\n';vi.spyOn(workbenchApi,'diffFile').mockResolvedValue({path:'src/lines.ts',binary:false,complete:true,verified:true,integrity:'verified',chunkIndex:0,chunkCount:1,contentBase64:btoa(patch),nextCursor:null});await mount({...snapshot(),works:[work],artifacts:[artifact]} as Snapshot);await flush();
    const file=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/lines.ts'))!;expect(file.open).toBe(false);await flush(()=>{file.open=true;});await flush();expect(host.textContent).toContain('old value');expect(host.textContent).toContain('new value');expect([...file.querySelectorAll('[role="row"]')].find(row=>row.textContent?.includes('-old value'))?.textContent).toContain('5');expect([...file.querySelectorAll('[role="row"]')].find(row=>row.textContent?.includes('+new value'))?.textContent).toContain('5');expect(host.textContent).toContain('Whole-file SHA-256 verified');
  });

  it('discards a diff page resolved after the file is collapsed',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');const work={id:'work-1',projectId:project.id,title:'Stale page',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};const artifact={id:'diff-stale',projectId:project.id,workId:work.id,runId:'run-stale',kind:'diff' as const,revision:'f'.repeat(64),createdAt:'2026-10-06',data:{baseRevision:'b'.repeat(40),files:[{path:'src/stale.ts',status:'modified',binary:false,additions:1,deletions:0,chunkCount:1,textBytes:12}]}};const pending=deferred<Awaited<ReturnType<typeof workbenchApi.diffFile>>>();const read=vi.spyOn(workbenchApi,'diffFile').mockImplementation(()=>pending.promise);await mount({...snapshot(),works:[work],artifacts:[artifact]} as Snapshot);await flush();const file=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/stale.ts'))!;await flush(()=>{file.open=true;});expect(read).toHaveBeenCalledTimes(1);const signal=read.mock.calls[0]?.[4];expect(signal?.aborted).toBe(false);await flush(()=>{file.open=false;});expect(signal?.aborted).toBe(true);pending.resolve({path:'src/stale.ts',binary:false,complete:true,chunkIndex:0,chunkCount:1,contentBase64:btoa('SECRET stale page'),nextCursor:null});await flush();expect(host.textContent).not.toContain('SECRET stale page');
  });

  it('shows unsupported UTF-8 bytes as retained base64 instead of crashing or dropping the page',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');const work={id:'work-1',projectId:project.id,title:'Unsupported encoding',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};const artifact={id:'diff-encoding',projectId:project.id,workId:work.id,runId:'run-encoding',kind:'diff' as const,revision:'1'.repeat(64),createdAt:'2026-10-06',data:{baseRevision:'b'.repeat(40),files:[{path:'src/raw.bin',status:'modified',binary:false,encodingUnsupported:true,additions:null,deletions:null,chunkCount:1,textBytes:2}]}};vi.spyOn(workbenchApi,'diffFile').mockResolvedValue({path:'src/raw.bin',binary:false,encodingUnsupported:true,complete:false,integrity:'pending',chunkIndex:0,chunkCount:1,contentBase64:btoa(String.fromCharCode(0xff,0x00)),nextCursor:null});await mount({...snapshot(),works:[work],artifacts:[artifact]} as Snapshot);const file=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/raw.bin'))!;await flush(()=>{file.open=true;});await flush();expect(host.textContent).toContain('Unsupported UTF-8 encoding');expect(host.querySelector('[aria-label="Unsupported encoding raw page"]')?.textContent).toContain('base64:');
  });

  it('aborts and discards a diff page when its Work view unmounts',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');const work={id:'work-1',projectId:project.id,title:'Unmount page',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};const artifact={id:'diff-unmount',projectId:project.id,workId:work.id,runId:'run-unmount',kind:'diff' as const,revision:'2'.repeat(64),createdAt:'2026-10-06',data:{baseRevision:'b'.repeat(40),files:[{path:'src/unmount.ts',status:'modified',binary:false,additions:1,deletions:0,chunkCount:1,textBytes:20}]}};const pending=deferred<Awaited<ReturnType<typeof workbenchApi.diffFile>>>();const read=vi.spyOn(workbenchApi,'diffFile').mockImplementation(()=>pending.promise);await mount({...snapshot(),works:[work],artifacts:[artifact]} as Snapshot);const file=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/unmount.ts'))!;await flush(()=>{file.open=true;});const signal=read.mock.calls[0]?.[4];expect(signal?.aborted).toBe(false);await flush(()=>root.unmount());expect(signal?.aborted).toBe(true);pending.resolve({path:'src/unmount.ts',binary:false,complete:true,chunkIndex:0,chunkCount:1,contentBase64:btoa('UNMOUNTED SECRET'),nextCursor:null});await flush();expect(host.textContent).not.toContain('UNMOUNTED SECRET');
  });

  it('keeps QA evidence bound to the latest diff revision', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work = { id: 'work-1', projectId: project.id, title: 'QA binding', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const diff = { id: 'diff-current', projectId: project.id, workId: work.id, runId: 'run-1', kind: 'diff' as const, revision: 'revision-current', createdAt: '2026-10-06T10:00:00.000Z', data: { candidateRevision: 'commit-current', files: [], totalFiles: 0, truncated: false } };
    const staleQa = { id: 'qa-stale', projectId: project.id, workId: work.id, runId: 'review-stale', kind: 'qa' as const, revision: 'revision-old', createdAt: '2026-10-06T12:00:00.000Z', data: { verification: 'current', checks: [] } };
    const currentQa = { id: 'qa-current', projectId: project.id, workId: work.id, runId: 'run-1', kind: 'qa' as const, revision: 'revision-current', createdAt: '2026-10-06T09:00:00.000Z', data: { verification: 'unknown', checks: [] } };
    vi.spyOn(workbenchApi, 'artifact').mockImplementation(async id => id === diff.id ? diff : currentQa);
    const candidateRun = { id: 'run-1', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Build', model: 'gpt-6-luna', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '', qaPolicySnapshot: { id: 'policy-1', version: '2026-10-06T09:00:00.000Z', projectId: project.id, repositoryUrl: 'https://github.com/blossomsai/menoteam', configuredBy: owner.id, coverage: 'project/v1' as const, requirements: [] } } as Snapshot['runs'][number];
    await mount({ ...snapshot(), works: [work], runs: [candidateRun], artifacts: [diff, staleQa, currentQa] } as Snapshot);
    await flush();
    expect(workbenchApi.artifact).toHaveBeenCalledWith(currentQa.id);
    expect(workbenchApi.artifact).not.toHaveBeenCalledWith(staleQa.id);
    expect(host.textContent).toContain('Unknown');
    expect(host.textContent).toContain('Required checks are missing for this candidate.');
    expect(host.textContent).toContain('Typed review');
    expect(host.textContent).toContain('No review is recorded.');
    expect(host.textContent).toContain('Missing');
  });

  it('does not present typed review QA with a candidate fingerprint mismatch as current', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work = { id: 'work-1', projectId: project.id, title: 'QA fingerprint binding', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const diff = { id: 'diff-current', projectId: project.id, workId: work.id, runId: 'candidate-new', kind: 'diff' as const, revision: 'revision-current', createdAt: '2026-10-06T10:00:00.000Z', data: { candidateRevision: 'commit-current', files: [], totalFiles: 0, truncated: false } };
    const binding = { candidateRunId: 'candidate-new', commitSha: 'commit-current', candidateFingerprint: 'a'.repeat(64), diffArtifactId: diff.id, diffRevision: diff.revision, qaArtifactIds: ['qa-mismatch'] };
    const reviewRun = { id: 'review-run', projectId: project.id, workId: work.id, prompt: 'Review', kind: 'review' as const, model: 'gpt-6.1-sol', reasoning: 'medium' as const, status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '', reviewBinding: binding } as Snapshot['runs'][number];
    const mismatchedQa = { id: 'qa-mismatch', projectId: project.id, workId: work.id, runId: reviewRun.id, kind: 'qa' as const, revision: diff.revision, createdAt: '2026-10-06T11:00:00.000Z', data: { verification: 'current', typedReview: { ...binding, candidateFingerprint: 'b'.repeat(64), reviewerRunId: reviewRun.id, disposition: 'approved' } } };
    const diffMetadata = { id: diff.id, projectId: diff.projectId, workId: diff.workId, runId: diff.runId, kind: diff.kind, revision: diff.revision, createdAt: diff.createdAt };
    const qaMetadata = { id: mismatchedQa.id, projectId: mismatchedQa.projectId, workId: mismatchedQa.workId, runId: mismatchedQa.runId, kind: mismatchedQa.kind, revision: mismatchedQa.revision, createdAt: mismatchedQa.createdAt };
    expect(diffMetadata).not.toHaveProperty('data'); expect(qaMetadata).not.toHaveProperty('data');
    const artifactSpy = vi.spyOn(workbenchApi, 'artifact').mockImplementation(async id => id === diff.id ? diff : mismatchedQa);
    const candidateRun = { id: 'candidate-new', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Build', model: 'gpt-6-luna', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '' } as Snapshot['runs'][number];
    await mount({ ...snapshot(), works: [work], runs: [candidateRun, reviewRun], artifacts: [diffMetadata, qaMetadata] } as Snapshot);
    await flush();
    expect(artifactSpy).toHaveBeenCalledWith(mismatchedQa.id);
    expect(host.textContent).toContain('does not match the latest candidate');
    expect(host.textContent).not.toContain('Current evidence');
    expect(host.textContent).not.toContain('approved');
  });

  it('marks complete fixed QA coverage as meeting the recorded requirements', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work = { id: 'work-1', projectId: project.id, title: 'Required QA', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const diff = { id: 'diff-required', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'diff' as const, revision: 'revision-required', createdAt: new Date().toISOString(), data: { candidateRevision: 'commit-required', files: [], totalFiles: 0, truncated: false } };
    const fingerprint = 'c'.repeat(64);
    const { policy, data } = localQaFixture(project.id, fingerprint);
    const qa = { id: 'qa-required', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'qa' as const, revision: diff.revision, createdAt: new Date().toISOString(), data };
    const candidateRun = { id: 'candidate-run', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Build', model: 'gpt-6-luna', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '', qaPolicySnapshot: policy } as Snapshot['runs'][number];
    vi.spyOn(workbenchApi, 'artifact').mockImplementation(async id => id === diff.id ? diff : qa);
    await mount({ ...snapshot(), works: [work], runs: [candidateRun], artifacts: [diff, qa] } as Snapshot);
    await flush();
    const required = host.querySelector('[aria-label="Required checks"]')!;
    expect(required.textContent).toContain('Current evidence');
    expect(required.textContent).toContain('requirements met');
  });

  it('keeps current QA evidence from implying that omitted policy requirements passed', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work = { id: 'work-1', projectId: project.id, title: 'Incomplete QA', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const diff = { id: 'diff-incomplete', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'diff' as const, revision: 'revision-incomplete', createdAt: new Date().toISOString(), data: { candidateRevision: 'commit-incomplete', files: [], totalFiles: 0, truncated: false } };
    const fingerprint = 'd'.repeat(64);
    const { policy, data } = localQaFixture(project.id, fingerprint, 1);
    const qa = { id: 'qa-incomplete', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'qa' as const, revision: diff.revision, createdAt: new Date().toISOString(), data };
    const candidateRun = { id: 'candidate-run', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Build', model: 'gpt-6-luna', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '', qaPolicySnapshot: policy } as Snapshot['runs'][number];
    vi.spyOn(workbenchApi, 'artifact').mockImplementation(async id => id === diff.id ? diff : qa);
    await mount({ ...snapshot(), works: [work], runs: [candidateRun], artifacts: [diff, qa] } as Snapshot);
    await flush();
    const required = host.querySelector('[aria-label="Required checks"]')!;
    expect(required.textContent).toContain('Current evidence');
    expect(required.textContent).toContain('required checks are incomplete');
    expect(required.textContent).not.toContain('requirements met');
  });

  it('keeps required QA status unknown when the evidence request fails', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work = { id: 'work-1', projectId: project.id, title: 'Unavailable QA', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const diff = { id: 'diff-unavailable', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'diff' as const, revision: 'revision-unavailable', createdAt: new Date().toISOString(), data: { candidateRevision: 'commit-unavailable', files: [], totalFiles: 0, truncated: false } };
    const { policy } = localQaFixture(project.id, 'e'.repeat(64));
    const qa = { id: 'qa-unavailable', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'qa' as const, revision: diff.revision, createdAt: new Date().toISOString() };
    const candidateRun = { id: 'candidate-run', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Build', model: 'gpt-6-luna', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '', qaPolicySnapshot: policy } as Snapshot['runs'][number];
    vi.spyOn(workbenchApi, 'artifact').mockImplementation(async id => { if (id === diff.id) return diff; throw new Error('temporarily unavailable'); });
    await mount({ ...snapshot(), works: [work], runs: [candidateRun], artifacts: [diff, qa] as Snapshot['artifacts'] } as Snapshot);
    await flush();
    const required = host.querySelector('[aria-label="Required checks"]')!;
    expect(required.textContent).toContain('Unknown');
    expect(required.textContent).toContain('could not be loaded or verified');
    expect(required.textContent).not.toContain('Required checks are missing');
  });

  it('fetches and displays matching typed review from metadata-only snapshot artifacts', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work = { id: 'work-1', projectId: project.id, title: 'QA metadata fetch', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const diff = { id: 'diff-current', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'diff' as const, revision: 'revision-current', createdAt: '2026-10-06T10:00:00.000Z', data: { candidateRevision: 'commit-current', files: [], totalFiles: 0, truncated: false } };
    const binding = { candidateRunId: 'candidate-run', commitSha: 'commit-current', candidateFingerprint: 'a'.repeat(64), diffArtifactId: diff.id, diffRevision: diff.revision, qaArtifactIds: ['qa-matched'] };
    const reviewRun = { id: 'review-run', projectId: project.id, workId: work.id, prompt: 'Review', kind: 'review' as const, model: 'gpt-6.1-sol', reasoning: 'medium' as const, status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '', reviewBinding: binding } as Snapshot['runs'][number];
    const qa = { id: 'qa-matched', projectId: project.id, workId: work.id, runId: reviewRun.id, kind: 'qa' as const, revision: diff.revision, createdAt: '2026-10-06T11:00:00.000Z', data: { verification: 'current', typedReview: { ...binding, disposition: 'changes_requested', findings: [{ id: 'finding', blocking: true, summary: 'Keep evidence bound' }], reviewerRunId: reviewRun.id } } };
    const diffMetadata = { id: diff.id, projectId: diff.projectId, workId: diff.workId, runId: diff.runId, kind: diff.kind, revision: diff.revision, createdAt: diff.createdAt };
    const qaMetadata = { id: qa.id, projectId: qa.projectId, workId: qa.workId, runId: qa.runId, kind: qa.kind, revision: qa.revision, createdAt: qa.createdAt };
    expect(diffMetadata).not.toHaveProperty('data'); expect(qaMetadata).not.toHaveProperty('data');
    const artifactSpy = vi.spyOn(workbenchApi, 'artifact').mockImplementation(async id => id === diff.id ? diff : qa);
    const candidateRun = { id: 'candidate-run', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Build', model: 'gpt-6-luna', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '' } as Snapshot['runs'][number];
    await mount({ ...snapshot(), works: [work], runs: [candidateRun, reviewRun], artifacts: [diffMetadata, qaMetadata] } as Snapshot);
    await flush();
    expect(artifactSpy).toHaveBeenCalledWith(qa.id);
    expect(host.textContent).toContain('Typed review');
    expect(host.textContent).toContain('Keep evidence bound');
    expect(host.textContent).toContain('Current evidence');
  });

  it('keeps freshness separate from failed command results', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work = { id: 'work-1', projectId: project.id, title: 'Failed current checks', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const diff = { id: 'diff-current', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'diff' as const, revision: 'revision-current', createdAt: '2026-10-06T10:00:00.000Z', data: { candidateRevision: 'commit-current', files: [], totalFiles: 0, truncated: false } };
    const fingerprint = 'a'.repeat(64);
    const commandQa = { id: 'qa-command', projectId: project.id, workId: work.id, runId: 'candidate-run', kind: 'qa' as const, revision: diff.revision, createdAt: '2026-10-06T11:00:00.000Z', data: { verification: 'current', stale: false, candidateFingerprint: fingerprint, checks: [{ name: 'Focused check', command: 'pnpm test', exitCode: 1, testedRevision: fingerprint, output: 'assertion failed' }] } };
    const candidateRun = { id: 'candidate-run', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Build', model: 'gpt-6-luna', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '' } as Snapshot['runs'][number];
    vi.spyOn(workbenchApi, 'artifact').mockImplementation(async id => id === diff.id ? diff : commandQa);
    await mount({ ...snapshot(), works: [work], runs: [candidateRun], artifacts: [diff, commandQa] } as Snapshot);
    await flush();
    expect(host.textContent).toContain('Command checks');
    expect(host.textContent).toContain('Current evidence');
    expect(host.textContent).toContain('0 passed · 1 failed or unknown');
    expect(host.querySelector('[aria-label="Command checks"]')?.textContent).not.toContain('Passed');
  });

});


it.each(['matching','fingerprint mismatch','binding fingerprint mismatch','revision mismatch','invalid policy'] as const)('projects real-shaped JSONB required QA and typed result alongside newer supplemental QA: %s',async kind=>{
  window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
  const work={id:'work-1',projectId:project.id,title:'Bound evidence',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
  const candidateId='run_cff79eee-a231-4b5a-a7e4-2473c65bae99',reviewId='run_9e5ebb54-762f-4ccc-ac0e-5d29eef1bbb8',fingerprint='9'.repeat(64),commit='3'.repeat(40),revision='c'.repeat(64);
  const policy=qaPolicyFixture(project.id,'https://github.com/blossomsai/menoteam');policy.coverage='menoteam-full/v3';policy.providerResource={...policy.resource!,id:'provider-resource',database:'provider_fixture_test'};
  const jsonb=(value:unknown)=>JSON.parse(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.length-b.length||(a<b?-1:a>b?1:0))):item));
  const diff={id:'diff-bound',projectId:project.id,workId:work.id,runId:candidateId,kind:'diff' as const,revision,createdAt:'2026-10-12T02:29:00.000Z',data:{candidateRevision:commit,files:[],totalFiles:0,truncated:false}};
  const required={id:`artifact:${candidateId}:required-qa:${candidateId}:1`,projectId:project.id,workId:work.id,runId:candidateId,kind:'qa' as const,revision,createdAt:diff.createdAt,data:jsonb(requiredQaFixture(fingerprint,policy))};
  const binding={candidateRunId:candidateId,commitSha:commit,candidateFingerprint:kind==='binding fingerprint mismatch'?'b'.repeat(64):fingerprint,diffArtifactId:diff.id,diffRevision:revision,qaArtifactIds:[required.id]};
  const generic={id:'review-supplemental',projectId:project.id,workId:work.id,runId:reviewId,kind:'qa' as const,revision,createdAt:'2026-10-12T02:35:00.000Z',data:{verification:'unknown',checks:[]}};
  const typed={id:'review-typed',projectId:project.id,workId:work.id,runId:reviewId,kind:'qa' as const,revision,createdAt:'2026-10-12T02:34:00.000Z',data:{typedReview:{...binding,reviewerRunId:reviewId,disposition:'approved',findings:[],evidenceArtifactIds:[required.id],...(kind==='fingerprint mismatch'?{candidateFingerprint:'b'.repeat(64)}:{}),...(kind==='revision mismatch'?{diffRevision:'old-revision'}:{})}}};
  const candidate={id:candidateId,projectId:project.id,workId:work.id,kind:'implementation',status:'completed',model:'gpt-6.1-sol',reasoning:'medium',createdAt:diff.createdAt,updatedAt:diff.createdAt,generation:1,qaPolicySnapshot:jsonb({...policy,...(kind==='invalid policy'?{unexpected:true}:{})})} as Snapshot['runs'][number];
  const review={id:reviewId,projectId:project.id,workId:work.id,kind:'review',status:'completed',model:'gpt-6.1-sol',reasoning:'medium',createdAt:typed.createdAt,updatedAt:generic.createdAt,generation:1,reviewBinding:jsonb(binding)} as Snapshot['runs'][number];
  const records=[diff,required,generic,typed];
  vi.spyOn(workbenchApi,'artifact').mockImplementation(async id=>records.find(item=>item.id===id)!);
  await mount({...snapshot(),works:[work],runs:[candidate,review],artifacts:records.map(({data,...metadata})=>metadata)} as Snapshot);await flush();
  const requiredSection=host.querySelector('[aria-label="Required checks"]')!;
  if(kind==='invalid policy')expect(requiredSection.textContent).not.toContain('requirements met');
  else expect.soft(requiredSection.textContent).toContain('4 required checks recorded · requirements met');
  const reviewSection=[...host.querySelectorAll('h3')].find(item=>item.textContent==='Typed review')!.closest('section')!;
  if(kind.endsWith('mismatch')){expect(reviewSection.textContent).toContain('Stale');expect(reviewSection.textContent).not.toContain('approved');}
  else {expect(reviewSection.textContent).toContain('Current evidence');expect(reviewSection.textContent).toContain('approved');}
});


it('puts execution history after the actual diff and keeps it collapsed without dropping errors',async()=>{
  window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
  const work={id:'work-1',projectId:project.id,title:'History',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
  const artifact={id:'diff-history',projectId:project.id,workId:work.id,runId:'run-history',kind:'diff' as const,revision:'revision',createdAt:'2026-10-12',data:{files:[{path:'src/example.ts',status:'modified',binary:false,additions:1,deletions:0,hunks:[]}],totalFiles:1,truncated:false}};
  const run={id:'run-history',projectId:project.id,workId:work.id,kind:'implementation',status:'failed',error:'Actual execution failed',model:'gpt-6-luna',reasoning:'medium',generation:1,createdAt:'2026-10-12',updatedAt:'2026-10-12'} as Snapshot['runs'][number];
  vi.spyOn(workbenchApi,'artifact').mockResolvedValue(artifact);
  await mount({...snapshot(),works:[work],runs:[run],artifacts:[artifact]} as Snapshot);await flush();
  const history=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent==='Execution history · 1 runs')!;
  expect(history.open).toBe(false);
  const file=[...host.querySelectorAll('summary')].find(item=>item.textContent?.includes('src/example.ts'))!;
  expect(file.compareDocumentPosition(history)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await flush(()=>{history.open=true;});
  expect(history.textContent).toContain('Implementation run');expect(history.textContent).toContain('Actual execution failed');expect(history.textContent).toContain('failed');
});

describe('lazy diff review regressions',()=>{
  function current(file:Record<string,unknown>={}){
    const work={id:'work-1',projectId:project.id,title:'Diff regression',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const artifact={id:'diff-regression',projectId:project.id,workId:work.id,runId:'run-regression',kind:'diff' as const,revision:'a'.repeat(64),createdAt:'2026-10-06',data:{baseRevision:'b'.repeat(40),candidateRevision:'c'.repeat(40),files:[{path:'src/regression.ts',status:'modified',binary:false,additions:2,deletions:1,chunkCount:2,textBytes:500_000,...file}]}};
    return {...snapshot(),works:[work],artifacts:[artifact]} as Snapshot;
  }
  function fileDetails(){return [...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/regression.ts'))!;}
  async function expand(){await flush(()=>{fileDetails().open=true;});await flush();}
  function page(content:string,index:number,nextCursor:string|null,extra:Record<string,unknown>={}){return {path:'src/regression.ts',binary:false,complete:index===1,chunkIndex:index,chunkCount:2,contentBase64:content,nextCursor,...extra};}

  it('keeps the bound cursor and verification state when invalid UTF-8 pages continue as raw base64',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const first=btoa(String.fromCharCode(0xff,0x61)),second=btoa('valid tail bytes');
    const read=vi.spyOn(workbenchApi,'diffFile').mockResolvedValueOnce(page(first,0,'bound-raw-next',{integrity:'pending',incomplete:true})).mockResolvedValueOnce(page(second,1,null,{integrity:'verified',verified:true}));
    await mount(current());expect(read).not.toHaveBeenCalled();await expand();
    expect(fileDetails().textContent).toContain(`base64:${first}`);expect(host.textContent).toContain('whole-file SHA-256 is pending');expect(button('Next page').disabled).toBe(false);
    await flush(()=>button('Next page').click());expect(read.mock.calls[1]?.slice(0,4)).toEqual(['diff-regression','src/regression.ts','a'.repeat(64),'bound-raw-next']);
    expect(fileDetails().textContent).toContain(`base64:${second}`);expect(host.textContent).toContain('Whole-file SHA-256 verified');expect(host.textContent).toContain('Page 2 of 2');expect(button('Next page').disabled).toBe(true);
  });

  it('renders +++ and --- hunk content with correct colors and numbers across pages',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    vi.spyOn(workbenchApi,'diffFile').mockResolvedValueOnce(page(btoa('--- a/file\n+++ b/file\n@@ -7,2 +9,2 @@\n---removed\n+'),0,'hunk-next')).mockResolvedValueOnce(page(btoa('++added\n context\n'),1,null));
    await mount(current());await expand();const removed=[...fileDetails().querySelectorAll('[role="row"]')].find(row=>row.textContent?.includes('---removed'))!;
    expect(removed.className).toContain('bg-red-100');expect(removed.children[0]?.textContent).toBe('7');await flush(()=>button('Next page').click());
    const added=[...fileDetails().querySelectorAll('[role="row"]')].find(row=>row.textContent?.includes('++added'))!;expect(added.className).toContain('bg-emerald-100');expect(added.children[1]?.textContent).toBe('9');expect(added.getAttribute('aria-label')).toContain('Continuation');
    const context=[...fileDetails().querySelectorAll('[role="row"]')].find(row=>row.textContent?.includes(' context'))!;expect(context.children[0]?.textContent).toBe('8');expect(context.children[1]?.textContent).toBe('10');
  });

  it('caps the long-line DOM while the raw-page download preserves every source byte',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');const source='@@ -0,0 +1,2 @@\n+'+'x'.repeat(200_000);
    let saved:NodeBlob|undefined;vi.stubGlobal('Blob',NodeBlob);vi.stubGlobal('URL',class extends URL {static createObjectURL=vi.fn((blob:NodeBlob)=>{saved=blob;return 'blob:diff-page';});static revokeObjectURL=vi.fn();});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>undefined);
    vi.spyOn(workbenchApi,'diffFile').mockResolvedValueOnce(page(btoa(source),0,'long-next')).mockResolvedValueOnce(page(btoa('\n+after\n'),1,null));await mount(current());await expand();
    const rows=[...fileDetails().querySelectorAll('[role="row"]')];expect(rows.length).toBeLessThanOrEqual(1024);expect(rows.every(row=>(row.children[2]?.textContent?.length??0)<=4096)).toBe(true);expect(rows.reduce((sum,row)=>sum+(row.children[2]?.textContent?.length??0),0)).toBeLessThanOrEqual(64*1024);expect(host.textContent).toContain('Page display is limited');
    await flush(()=>button('Download raw page').click());expect(Buffer.from(await saved!.arrayBuffer()).equals(Buffer.from(source))).toBe(true);await flush(()=>button('Next page').click());const after=[...fileDetails().querySelectorAll('[role="row"]')].find(row=>row.textContent?.includes('+after'))!;expect(after.children[1]?.textContent).toBe('2');expect(host.textContent).not.toContain('x'.repeat(100));
  });

  it('renders existing historical hunks as a partial preview without fetching or claiming full-file verification',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');const read=vi.spyOn(workbenchApi,'diffFile').mockRejectedValue(new Error('Historical previews must not fetch missing chunks'));
    await mount(current({chunkCount:undefined,textBytes:undefined,hunks:[{header:'@@ -3 +5 @@',lines:[{type:'remove',oldLine:3,text:'historical old'},{type:'add',newLine:5,text:'historical new'}]}]}));expect(fileDetails().open).toBe(false);expect(read).not.toHaveBeenCalled();await expand();
    expect(read).not.toHaveBeenCalled();expect(host.textContent).toContain('Historical partial preview');expect(host.textContent).toContain('full-file integrity is unverified');expect(host.textContent).toContain('historical old');expect(host.textContent).toContain('historical new');expect(host.textContent).not.toContain('Whole-file SHA-256 verified');
    const rows=[...fileDetails().querySelectorAll('[role="row"]')];expect(rows.find(row=>row.textContent?.includes('-historical old'))?.children[0]?.textContent).toBe('3');expect(rows.find(row=>row.textContent?.includes('+historical new'))?.children[1]?.textContent).toBe('5');
  });
  it('reads all text beyond both limits inside the app without another server fetch',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const source='@@ -0,0 +1,1801 @@\n'+Array.from({length:1800},(_,i)=>`+line ${i} 雪\n`).join('')+'+'+'x'.repeat(4094)+'🙂'+'雪🙂'.repeat(22000)+'\n';
    const read=vi.spyOn(workbenchApi,'diffFile').mockResolvedValue(page(Buffer.from(source).toString('base64'),0,null,{complete:true,chunkCount:1,integrity:'verified'}));await mount(current({chunkCount:1,textBytes:Buffer.byteLength(source)}));expect(read).not.toHaveBeenCalled();await expand();
    let joined='',portions=0;do{const rows=[...fileDetails().querySelectorAll('[role="row"]')];expect(rows.length).toBeLessThanOrEqual(1024);expect(rows.reduce((n,row)=>n+(row.children[2]?.textContent?.length??0),0)).toBeLessThanOrEqual(64*1024);joined+=rows.map(row=>(row.children[2]?.textContent??'')+(row.getAttribute('data-line-end')==='true'?'\n':'')).join('');portions++;if(button('More of this page').disabled)break;await flush(()=>button('More of this page').click());expect(read).toHaveBeenCalledTimes(1);expect(portions).toBeLessThan(20);}while(true);
    expect(portions).toBeGreaterThan(2);expect(joined).toBe(source);expect(host.textContent).toContain('Whole-file SHA-256 verified');await flush(()=>button('Previous portion').click());expect(read).toHaveBeenCalledTimes(1);expect(button('More of this page').disabled).toBe(false);
  });

  it('reads every unsupported raw byte in bounded in-app base64 portions without another server fetch',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');const bytes=Buffer.alloc(120_000,0xff),encoded=bytes.toString('base64');const read=vi.spyOn(workbenchApi,'diffFile').mockResolvedValue(page(encoded,0,null,{complete:true,chunkCount:1,encodingUnsupported:true,integrity:'verified'}));await mount(current({chunkCount:1,textBytes:bytes.length,encodingUnsupported:true}));await expand();let all='',portions=0;
    do{const raw=host.querySelector('[aria-label="Unsupported encoding raw page"]')!.textContent!.slice('base64:'.length);expect(raw.length).toBeLessThanOrEqual(64*1024);all+=raw;portions++;if(button('More of this page').disabled)break;await flush(()=>button('More of this page').click());expect(read).toHaveBeenCalledTimes(1);}while(true);
    expect(portions).toBeGreaterThan(1);expect(all).toBe(encoded);expect(Buffer.from(all,'base64').equals(bytes)).toBe(true);expect(host.textContent).toContain('Unsupported UTF-8 encoding');expect(host.textContent).toContain('Whole-file SHA-256 verified');
  });

});
