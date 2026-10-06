// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

  it('creates Project B Work with explicit connection B while workspace default stays on A', async () => {
    const projectB = { ...project, id: 'project-b', name: 'Project B' };
    const connectionA = { ...providerSetting, id: 'provider-a', name: 'A Codex', data: { ...providerSetting.data, connectorId: 'connector-a', default: true } };
    const connectionB = { ...providerSetting, id: 'provider-b', name: 'B Codex', data: { ...providerSetting.data, connectorId: 'connector-b', default: false } };
    const current = snapshot(owner, [connectionA, connectionB], [
      { ...runtime, connectorId: 'connector-a', projectIds: [project.id], models: ['gpt-6-luna'] },
      { ...runtime, connectorId: 'connector-b', projectIds: [projectB.id], models: ['gpt-6-luna'] },
    ]);
    current.projects = [project, projectB];
    current.providerConnections = [
      { id: 'provider-a', name: 'A Codex', connectorId: 'connector-a', enabled: true, default: true, status: 'available', models: ['gpt-6-luna'], projectIds: [project.id], localWorktrees: true },
      { id: 'provider-b', name: 'B Codex', connectorId: 'connector-b', enabled: true, default: false, status: 'available', models: ['gpt-6-luna'], projectIds: [projectB.id], localWorktrees: true },
    ];
    window.history.replaceState(null, '', `/workbench/?view=master&project=${projectB.id}&draft=Help%20me%20plan%20a%20new%20work%3A`);
    await mount(current);
    vi.spyOn(workbenchApi, 'sendMessage').mockResolvedValue({ message: {} as never, run: {} as never });
    const create = vi.spyOn(workbenchApi, 'createWork').mockResolvedValue({ id: 'new-work', projectId: projectB.id, title: 'Explicit B', overview: 'B work', status: 'queued', revision: 1, profileId: '', connectionId: 'provider-b', sources: [], createdAt: '', updatedAt: '' });
    vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
    await type('#new-work-title', 'Explicit B'); await type('#new-work-overview', 'B work'); await choose('#new-work-provider', 'provider-b');
    await flush(() => button('Create Work').click());
    expect(create).toHaveBeenCalledWith(projectB.id, { title: 'Explicit B', overview: 'B work', connectionId: 'provider-b' });
    expect(connectionA.data.default).toBe(true); expect(connectionB.data.default).toBe(false);
    expect(workbenchApi.sendMessage).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Work created with its selected provider connection.'); expect(host.textContent).toContain('Open Explicit B');
  });

  it('does not expose cross-project or unavailable connections and keeps creation disabled without an eligible grant', async () => {
    const projectB = { ...project, id: 'project-b', name: 'Project B' };
    const aOnly = { id: 'provider-a', name: 'A Codex', connectorId: 'connector-a', enabled: true, default: true, status: 'available', models: ['gpt-6-luna'], projectIds: [project.id], localWorktrees: true };
    const offline = { id: 'provider-b', name: 'B Offline', connectorId: 'connector-b', enabled: true, default: false, status: 'offline', models: ['gpt-6-luna'], projectIds: [projectB.id], localWorktrees: true };
    const current = snapshot(member, []); current.projects = [project, projectB]; current.providerConnections = [aOnly, offline];
    window.history.replaceState(null, '', `/workbench/?view=master&project=${projectB.id}&draft=Help%20me%20plan%20a%20new%20work%3A`);
    await mount(current);
    expect([...host.querySelectorAll<HTMLSelectElement>('#new-work-provider option')].map(option => option.value)).toEqual(['']);
    expect(button('Create Work').disabled).toBe(true);
    expect(host.textContent).toContain('No available connection is authorized for this project');
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

  it('shows revoked Worktree capability and does not offer an incompatible default action', async () => {
    const incompatibleRuntime = { ...runtime, localWorktrees: false };
    const current = snapshot(owner, [providerSetting], [incompatibleRuntime]);
    current.providerConnections = [{ id: providerSetting.id, name: providerSetting.name, connectorId: runtime.connectorId, enabled: true, default: true, status: 'capability_unavailable', models: runtime.models, projectIds: ['project'], localWorktrees: false, reason: 'Local Worktree capability unavailable' }];
    await mount(current);
    expect(host.textContent).toContain('Capability unavailable'); expect(host.textContent).toContain('Local Worktree capability unavailable');
    expect(host.textContent).not.toContain('Make default');
    expect([...host.querySelectorAll<HTMLSelectElement>('#provider-connector option')].map(option => option.value)).toEqual(['']);
  });


  it('surfaces an explicit project grant denial from the create API without substituting default or sending the draft', async () => {
    const projectB = { ...project, id: 'project-b', name: 'Project B' };
    const current = snapshot(owner, []); current.projects = [project, projectB]; current.providerConnections = [{ id: 'provider-b', name: 'B Codex', connectorId: 'connector-b', enabled: true, default: false, status: 'available', models: ['gpt-6-luna'], projectIds: [projectB.id], localWorktrees: true }];
    window.history.replaceState(null, '', `/workbench/?view=master&project=${projectB.id}&draft=Help%20me%20plan%20a%20new%20work%3A`);
    await mount(current);
    const create = vi.spyOn(workbenchApi, 'createWork').mockRejectedValue(new Error('Project connection grant was revoked'));
    vi.spyOn(workbenchApi, 'sendMessage').mockResolvedValue({ message: {} as never, run: {} as never });
    await type('#new-work-title', 'Denied B'); await choose('#new-work-provider', 'provider-b'); await flush(() => button('Create Work').click());
    expect(create).toHaveBeenCalledWith(projectB.id, { title: 'Denied B', overview: '', connectionId: 'provider-b' });
    expect(host.textContent).toContain('Project connection grant was revoked'); expect(host.textContent).not.toContain('Work created with its selected provider connection.');
    expect(workbenchApi.sendMessage).not.toHaveBeenCalled();
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
    [{ totalFiles: 1, truncated: false }, 'Showing 1 of 1 changed file', 'This diff is untruncated'],
    [{ totalFiles: 4, truncated: true }, 'Showing 1 of 4 changed files', 'This diff was truncated'],
    [{ truncated: true }, 'Showing 1 changed file · total unknown', 'This diff was truncated'],
    [{ truncated: false }, 'Showing 1 changed file · total unknown', 'This diff is untruncated'],
    [{}, 'Showing 1 changed file · total unknown', 'Truncation status is unknown'],
    [{ totalFiles: 0, truncated: false }, 'Showing 1 changed file · total unknown', 'This diff is untruncated'],
    [{ totalFiles: 1.5, truncated: 'true' }, 'Showing 1 changed file · total unknown', 'Truncation status is unknown'],
  ])('renders authoritative shown/total count and truncation honestly', async (metadata, label, truncated) => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const work = { id: 'work-1', projectId: project.id, title: 'Diff proof', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const artifact = { id: 'diff-1', projectId: project.id, workId: work.id, runId: 'run-1', kind: 'diff' as const, revision: 'diff-revision', createdAt: '2026-10-06T10:00:00.000Z', data: { ...metadata, baseRevision: 'base-sha', additions: 1, deletions: 1, files: [{ path: 'src/example.ts', status: 'modified', binary: false, additions: 1, deletions: 1, hunks: [{ header: '@@ -2 +2 @@', lines: [{ type: 'remove', oldLine: 2, text: 'old' }, { type: 'add', newLine: 2, text: 'new' }] }] }] } };
    const current = { ...snapshot(), works: [work], artifacts: [artifact] } as Snapshot;
    vi.spyOn(workbenchApi, 'artifact').mockResolvedValue(artifact);
    await mount(current);
    await flush();
    expect(host.textContent).toContain(label);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(truncated);
    expect(host.textContent).toContain('old'); expect(host.textContent).toContain('new');
    expect(host.querySelector('.bg-red-50')).not.toBeNull(); expect(host.querySelector('.bg-emerald-50')).not.toBeNull();
    expect(host.querySelector('.bg-red-50')?.children[0]?.textContent).toBe('2');
    expect(host.querySelector('.bg-emerald-50')?.children[1]?.textContent).toBe('2');
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
