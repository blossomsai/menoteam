// @vitest-environment happy-dom
import { qaPolicyFixture, requiredQaFixture } from './helpers/local-qa-fixture';
import { createElement, act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { ApiError, canAutoPoll, resetRateLimitCooldown, workbenchApi, type Snapshot } from '../src/workbench/web/api';

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
async function mount(current: Snapshot, strictMode = false) {
  vi.spyOn(workbenchApi, 'me').mockResolvedValue(current.member);
  vi.spyOn(workbenchApi, 'snapshot').mockResolvedValue(current);
  vi.spyOn(workbenchApi, 'projectMessages').mockResolvedValue({ messages: [], nextBefore: null });
  vi.spyOn(workbenchApi, 'projectMembers').mockResolvedValue({ members: [current.member] });
  await flush(() => root.render(strictMode ? createElement(StrictMode, null, createElement(App)) : createElement(App)));
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
  resetRateLimitCooldown();
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected live fetch in mounted UI test'))));
  sessionStorage.clear();
  window.history.replaceState(null, '', '/workbench/?view=model-providers');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

it('shows the blocked Slack reply cause for a completed Master turn without exposing another conversation', async () => {
  const current = snapshot();
  const cause = 'Native turn completed without a reliable synchronous provider final';
  const completed = { id: 'slack-master', projectId: project.id, kind: 'master' as const, prompt: '', model: 'gpt-6.1-sol', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '', slackReply: { state: 'blocked' as const, cause } };
  current.runs = [completed, {...completed, id: 'other-project', projectId: 'other-project', slackReply: {state: 'blocked', cause: 'Private other project cause'}}, {...completed, id: 'other-work', workId: 'other-work', slackReply: {state: 'blocked', cause: 'Private other work cause'}}];
  window.history.replaceState(null, '', '/workbench/?view=master&project=project');
  await mount(current);

  const notice = [...host.querySelectorAll('[role="status"]')].find(element => element.textContent?.includes('Slack reply blocked'));
  expect(notice?.textContent).toContain(`Slack reply blocked · ${cause}`);
  expect(notice?.querySelector('strong')?.textContent).toBe('completed');
  expect(notice?.querySelector('button')).toBeNull();
  expect(host.textContent).not.toContain('Private other project cause');
  expect(host.textContent).not.toContain('Private other work cause');
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

it('prefers the frozen implementation profile name after the saved profile is renamed', async () => {
  const profileId = 'setting_263d-profile';
  const work = { id: 'work', projectId: project.id, title: 'Current Work', overview: '', status: 'in_progress' as const, revision: 1, profileId, connectionId: 'provider-1', sources: [], createdAt: '', updatedAt: '' };
  const current = snapshot(owner, [{ ...profileSetting, id: profileId, name: 'Renamed Builder' }]);
  current.works = [work];
  const run = { id: 'implementation', projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: '', model: 'gpt-6.1-sol', reasoning: 'medium', status: 'completed' as const, generation: 1, createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:01:00.000Z', execution: { provider: 'openai' as const, method: 'codex-host' as const, profileId, profile: { id: profileId, name: 'Original Builder', data: profileSetting.data }, skills: [], tools: [] } };
  current.runs = [run];
  window.history.replaceState(null, '', `/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
  await mount(current);

  const composer = host.querySelector<HTMLInputElement>('input[placeholder="Message Original Builder…"]');
  expect(composer?.getAttribute('aria-label')).toBe('Message Original Builder');
  expect(composer?.outerHTML).not.toContain(profileId);
  expect(current.runs[0]?.execution?.profileId).toBe(profileId);
  expect(current.works[0]?.profileId).toBe(profileId);
});

it('uses the frozen profile name when its setting is no longer available', async () => {
  const profileId = 'setting_removed-profile';
  const work = { id: 'work', projectId: project.id, title: 'Current Work', overview: '', status: 'in_progress' as const, revision: 1, profileId, connectionId: 'provider-1', sources: [], createdAt: '', updatedAt: '' };
  const current = snapshot();
  current.works = [work];
  current.runs = [{ id: 'implementation', projectId: project.id, workId: work.id, kind: 'implementation', prompt: '', model: 'gpt-6.1-sol', reasoning: 'medium', status: 'completed', generation: 1, createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:01:00.000Z', execution: { provider: 'openai', method: 'codex-host', profileId, profile: { id: profileId, name: 'Original Builder', data: profileSetting.data }, skills: [], tools: [] } } as Snapshot['runs'][number]];
  window.history.replaceState(null, '', `/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
  await mount(current);

  const composer = host.querySelector<HTMLInputElement>('input[placeholder="Message Original Builder…"]');
  expect(composer?.getAttribute('aria-label')).toBe('Message Original Builder');
  expect(composer?.outerHTML).not.toContain(profileId);
  expect(current.runs[0]?.execution?.profileId).toBe(profileId);
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

describe('mounted Work overview editor', () => {
  function overviewSnapshot(overview='old',revision=7) {
    const current=snapshot();
    current.works=[{id:'overview-work',projectId:project.id,title:'Overview Work',overview,status:'in_progress',revision,profileId:'',sources:[],createdAt:'',updatedAt:''}];
    window.history.replaceState(null,'',`/workbench/?view=work-detail&project=${project.id}&work=overview-work`);
    return current;
  }

  it('saves exact text and frozen revision, while Cancel makes no mutation', async () => {
    const current=overviewSnapshot('first');
    const update=vi.spyOn(workbenchApi,'updateWork').mockImplementation(async (_id,input)=>({...current.works[0]!,overview:input.overview??'',revision:8}));
    await mount(current);
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','line one\n\nline two');
    await flush(()=>button('Cancel').click());
    expect(update).not.toHaveBeenCalled();
    expect(host.textContent).toContain('first');
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','line one\n\nline two');
    await flush(()=>button('Save').click());
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('overview-work',{revision:7,overview:'line one\n\nline two'});
    expect(host.textContent).toContain('line one');
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','');
    await flush(()=>button('Save').click());
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]).toEqual(['overview-work',{revision:8,overview:''}]);
  });

  it('blocks duplicate pending saves', async () => {
    const current=overviewSnapshot();
    const pending=deferred<Awaited<ReturnType<typeof workbenchApi.updateWork>>>();
    const update=vi.spyOn(workbenchApi,'updateWork').mockReturnValue(pending.promise);
    await mount(current);
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','my draft');
    await flush(()=>button('Save').click());
    expect(update).toHaveBeenCalledTimes(1);
    expect(button('Saving…').disabled).toBe(true);
    expect(host.querySelector('textarea')?.disabled).toBe(true);
    pending.resolve({...current.works[0]!,overview:'my draft',revision:8});
    await flush();
    expect(host.textContent).toContain('my draft');
  });

  it('retains a 409 draft until explicitly using latest and retrying with its revision', async () => {
    const current=overviewSnapshot();
    await mount(current);
    const latest={...current,works:[{...current.works[0]!,overview:'other writer',revision:8}]};
    vi.spyOn(workbenchApi,'snapshot').mockResolvedValue(latest);
    const update=vi.spyOn(workbenchApi,'updateWork').mockRejectedValueOnce(new ApiError('Conflict',409)).mockResolvedValueOnce({...latest.works[0]!,overview:'my draft',revision:9});
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','my draft');
    await flush(()=>button('Save').click());
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Work changed elsewhere');
    expect(host.textContent).toContain('other writer');
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('my draft');
    await flush(()=>button('Use latest').click());
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('other writer');
    await type('textarea#work-overview-overview-work','my draft');
    await flush(()=>button('Save').click());
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]).toEqual(['overview-work',{revision:8,overview:'my draft'}]);
  });

  it('shows the latest polled revision without replacing a dirty draft', async () => {
    const current=overviewSnapshot();
    await mount(current);
    const latest={...current,works:[{...current.works[0]!,overview:'poll update',revision:8}]};
    vi.spyOn(workbenchApi,'snapshot').mockResolvedValue(latest);
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','my draft');
    await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});
    expect(host.textContent).toContain('Work changed elsewhere');
    expect(host.textContent).toContain('poll update');
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('my draft');
    expect(button('Save').disabled).toBe(true);
  });

  it('keeps the editor draft after a failed request', async () => {
    const current=overviewSnapshot();
    await mount(current);
    vi.spyOn(workbenchApi,'updateWork').mockRejectedValue(new Error('Network unavailable'));
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','retained draft');
    await flush(()=>button('Save').click());
    await flush();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('retained draft');
    expect(host.textContent).toContain('Network unavailable');
    expect(button('Save').disabled).toBe(false);
  });

  it('ignores a late save response after switching Work scope', async () => {
    const current=overviewSnapshot();
    current.works.push({...current.works[0]!,id:'next-work',title:'Next Work',overview:'next overview'});
    const pending=deferred<Awaited<ReturnType<typeof workbenchApi.updateWork>>>();
    vi.spyOn(workbenchApi,'updateWork').mockReturnValue(pending.promise);
    await mount(current);
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','old private draft');
    await flush(()=>button('Save').click());
    window.history.replaceState(null,'',`/workbench/?view=work-detail&project=${project.id}&work=next-work`);
    await flush(()=>root.render(createElement(App)));
    pending.resolve({...current.works[0]!,overview:'old private draft',revision:8});
    await flush();
    expect(host.textContent).toContain('next overview');
    expect(host.textContent).not.toContain('old private draft');
  });

  it('handles PATCH success under StrictMode and preserves conversation state', async () => {
    const current=overviewSnapshot();
    current.messages=[{id:'existing-message',projectId:project.id,workId:'overview-work',speaker:'Agent',role:'agent',text:'Existing conversation message',createdAt:''}];
    sessionStorage.setItem('menoteam-workbench:draft:owner:project:overview-work','composer draft');
    const send=vi.spyOn(workbenchApi,'sendMessage');
    const pending=deferred<Awaited<ReturnType<typeof workbenchApi.updateWork>>>();
    vi.spyOn(workbenchApi,'updateWork').mockReturnValue(pending.promise);
    await mount(current,true);
    const assertConversation=()=>{
      expect(host.textContent).toContain('Existing conversation message');
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Message Agent"]')?.value).toBe('composer draft');
    };
    await flush(()=>button('Edit').click());
    assertConversation();
    await type('textarea#work-overview-overview-work','saved overview');
    await flush(()=>button('Save').click());
    expect(button('Saving…').disabled).toBe(true);
    assertConversation();
    pending.resolve({...current.works[0]!,overview:'saved overview',revision:8});
    await flush();
    expect(button('Edit')).toBeTruthy();
    expect(host.textContent).toContain('saved overview');
    assertConversation();
    expect(send).not.toHaveBeenCalled();
  });

  it('releases failed PATCH under StrictMode, retains draft and permits explicit retry', async () => {
    const current=overviewSnapshot();
    current.messages=[{id:'existing-message',projectId:project.id,workId:'overview-work',speaker:'Agent',role:'agent',text:'Existing conversation message',createdAt:''}];
    sessionStorage.setItem('menoteam-workbench:draft:owner:project:overview-work','composer draft');
    const send=vi.spyOn(workbenchApi,'sendMessage');
    const update=vi.spyOn(workbenchApi,'updateWork')
      .mockRejectedValueOnce(new Error('PATCH failed'))
      .mockResolvedValueOnce({...current.works[0]!,overview:'retry draft',revision:8});
    await mount(current,true);
    const assertConversation=()=>{
      expect(host.textContent).toContain('Existing conversation message');
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Message Agent"]')?.value).toBe('composer draft');
    };
    await flush(()=>button('Edit').click());
    await type('textarea#work-overview-overview-work','retry draft');
    assertConversation();
    await flush(()=>button('Save').click());
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('retry draft');
    expect(host.textContent).toContain('PATCH failed');
    expect(button('Save').disabled).toBe(false);
    assertConversation();
    await flush(()=>button('Save').click());
    await flush();
    expect(update).toHaveBeenCalledTimes(2);
    expect(button('Edit')).toBeTruthy();
    expect(host.textContent).toContain('retry draft');
    assertConversation();
    expect(send).not.toHaveBeenCalled();
  });
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
afterEach(async () => { await flush(() => root.unmount()); host.remove(); resetRateLimitCooldown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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

  it.each([
    ['paused', undefined, 'End', 'paused'],
    ['interrupted', undefined, 'End', 'interrupted'],
    ['cancelled', undefined, undefined, 'Cancelling'],
    ['cancelled', '2026-10-14T09:00:00.000Z', undefined, 'Cancelled'],
  ] as const)('shows Work cancellation state for %s', async (status, stoppedAt, action, label) => {
    const work = { id: 'cancel-work', projectId: project.id, title: 'Cancel Work', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const run = { id: `cancel-${status}`, projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: 'Continue', model: 'gpt-6.1-sol', reasoning: 'medium', status, generation: 1, createdAt: '', updatedAt: '', ...(stoppedAt ? { stoppedAt } : {}) } as Snapshot['runs'][number];
    const current = snapshot(); current.works = [work]; current.runs = [run];
    window.history.replaceState(null, '', `/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
    const cancel = vi.spyOn(workbenchApi, 'cancelRun').mockResolvedValue(run);
    await mount(current);
    expect(host.textContent).toContain(label);
    if (status === 'cancelled' && !stoppedAt) expect(host.textContent).toContain('Waiting for the Connector');
    if (status === 'cancelled' && stoppedAt) expect([...host.querySelectorAll('[role="status"]')].some(node => node.textContent?.includes('Cancelled'))).toBe(true);
    if (action) {
      await flush(() => button(action).click());
      expect(cancel).toHaveBeenCalledWith(run.id);
    }
  });

  it('does not offer cancel or end for an effectful interrupted delivery', async () => {
    const work = { id: 'delivery-cancel-work', projectId: project.id, title: 'Published delivery', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
    const delivery = { id: 'effectful-interrupted-delivery', projectId: project.id, workId: work.id, targetRunId: 'candidate', kind: 'delivery' as const, prompt: '', model: 'internal', reasoning: 'none', status: 'interrupted' as const, generation: 2, createdAt: '', updatedAt: '', operation: { action: 'create_draft_pr', actorId: owner.id, candidateRunId: 'candidate', candidateRevision: 'candidate-revision', artifactRevision: 'candidate-revision', commitSha: 'a'.repeat(40), candidateFingerprint: 'b'.repeat(64), repositoryUrl: 'https://github.com/blossomsai/menoteam', baseRevision: 'c'.repeat(40), baseBranch: 'main', remoteBranch: 'codex/candidate', workTitle: work.title, changeSummary: 'published', qaStatus: 'current', phase: 'pr_created', effectIntentGeneration: 2, external: { pullRequestNumber: 42, pullRequestUrl: 'https://github.com/blossomsai/menoteam/pull/42' } } } as Snapshot['runs'][number];
    const current = snapshot(); current.works = [work]; current.runs = [delivery];
    window.history.replaceState(null, '', `/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
    const cancel = vi.spyOn(workbenchApi, 'cancelRun');
    await mount(current);
    expect(host.textContent).toContain('interrupted');
    expect(delivery.operation?.phase).toBe('pr_created');
    expect([...host.querySelectorAll('button')].map(item => item.textContent?.trim())).not.toContain('End');
    expect([...host.querySelectorAll('button')].map(item => item.textContent?.trim())).not.toContain('Cancel');
    expect(cancel).not.toHaveBeenCalled();
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

  it('leads Changes with file paths and LOC, while keeping every delivery receipt closed by default',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const work={id:'work-1',projectId:project.id,title:'Changes hierarchy',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const candidate={id:'candidate-run',projectId:project.id,workId:work.id,kind:'implementation' as const,prompt:'',model:'gpt-6-luna',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06'};
    const delivery={id:'delivery-run',projectId:project.id,workId:work.id,targetRunId:candidate.id,kind:'delivery' as const,prompt:'',model:'gpt-6-luna',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06',operation:{action:'create_draft_pr' as const,phase:'pr_created' as const,external:{pullRequestNumber:42,pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/42'}}} as Snapshot['runs'][number];
    const diff={id:'diff-hierarchy',projectId:project.id,workId:work.id,runId:candidate.id,kind:'diff' as const,revision:'diff-revision',createdAt:'2026-10-06',data:{baseRevision:'base-sha',additions:5,deletions:2,totalFiles:2,truncated:false,files:[{path:'src/first.ts',status:'modified',binary:false,additions:3,deletions:1,hunks:[]},{path:'tests/second.test.ts',status:'modified',binary:false,additions:2,deletions:1,hunks:[]}]}};
    const firstReceipt={id:'receipt-pr',projectId:project.id,workId:work.id,runId:delivery.id,kind:'delivery' as const,revision:'receipt-revision-pr',createdAt:'2026-10-06T10:00:00.000Z',data:{action:'create_draft_pr',phase:'pr_created',pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/42',commitSha:'candidate-sha'}};
    const secondReceipt={...firstReceipt,id:'receipt-merge',revision:'receipt-revision-merge',createdAt:'2026-10-06T11:00:00.000Z',data:{action:'merge_pr',phase:'merge_intent',commitSha:'candidate-sha',operationId:'merge-operation-exact'}};
    const current=snapshot();current.works=[work];current.runs=[candidate,delivery];current.artifacts=[diff,firstReceipt,secondReceipt];
    vi.spyOn(workbenchApi,'artifact').mockImplementation(async id=>id==='receipt-pr'?firstReceipt as never:secondReceipt as never);
    await mount(current);await flush();
    const changes=[...host.querySelectorAll('section')].find(section=>section.querySelector('h2')?.textContent==='Changes')!;
    expect(changes.textContent).toContain('Showing 2 of 2 changed files');expect(changes.textContent).toContain('+5');expect(changes.textContent).toContain('−2');
    const fileRows=[...changes.querySelectorAll('details')].filter(item=>item.querySelector('summary')?.textContent?.includes('src/first.ts')||item.querySelector('summary')?.textContent?.includes('tests/second.test.ts'));
    expect(fileRows).toHaveLength(2);expect(fileRows.every(item=>!item.open)).toBe(true);
    expect(fileRows.map(item=>item.querySelector('summary')?.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('src/first.ts'),expect.stringContaining('tests/second.test.ts')]));
    const history=[...changes.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.startsWith('Delivery history'))!;
    expect(history.open).toBe(false);expect(history.querySelector('summary')?.textContent).toContain('2 receipts');
    const relatedPr=changes.querySelector<HTMLAnchorElement>('a[href="https://github.com/blossomsai/menoteam/pull/42"]');
    expect(relatedPr?.textContent).toBe('Related pull request');
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    await flush(()=>{history.open=true;});await flush();
    expect(history.textContent).toContain('pr created');expect(history.textContent).toContain('merge intent');expect(history.textContent).toContain('merge-operation-exact');
  });

  it('keeps the mounted Work conversation and unsent composer through a tab change and snapshot update',async()=>{
    const work={id:'conversation-work',projectId:project.id,title:'Conversation identity',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const current=snapshot();current.works=[work];current.messages=[{id:'message-stable',projectId:project.id,workId:work.id,speaker:'Agent',role:'agent',text:'Stable message node',createdAt:''}];
    window.history.replaceState(null,'',`/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
    const send=vi.spyOn(workbenchApi,'sendMessage'),create=vi.spyOn(workbenchApi,'createWork');
    await mount(current);
    const composer=host.querySelector<HTMLInputElement>('input[aria-label="Message Agent"]')!;
    await typeInput(composer,'unsent draft survives');
    const message=[...host.querySelectorAll('article')].find(item=>item.textContent?.includes('Stable message node'))!;
    const next=freshClone(current);next.runs=[{id:'implementation-update',projectId:project.id,workId:work.id,kind:'implementation',prompt:'',model:'gpt-6-luna',reasoning:'medium',status:'completed',generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06'},{id:'delivery-update',projectId:project.id,workId:work.id,targetRunId:'implementation-update',kind:'delivery',prompt:'',model:'internal',reasoning:'none',status:'failed',generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06',operation:{action:'create_draft_pr',actorId:owner.id,candidateRunId:'implementation-update',candidateRevision:'revision',artifactRevision:'revision',commitSha:'sha',candidateFingerprint:'fingerprint',repositoryUrl:'',baseRevision:'base',baseBranch:'main',remoteBranch:'branch',workTitle:work.title,changeSummary:'',qaStatus:'unknown',phase:'published'}}];
    next.artifacts=[{id:'change-update',projectId:project.id,workId:work.id,runId:'implementation-update',kind:'diff',revision:'revision',createdAt:'2026-10-06',data:{baseRevision:'base',candidateRevision:'revision',files:[],totalFiles:0,truncated:false}}];
    vi.mocked(workbenchApi.snapshot).mockResolvedValue(next);
    window.history.replaceState(null,'',`/workbench/?view=work-detail&project=${project.id}&work=${work.id}&tab=changes`);
    await flush(()=>root.render(createElement(App)));
    await advanceSnapshotPoll();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Message Agent"]')).toBe(composer);
    expect(composer.value).toBe('unsent draft survives');
    expect([...host.querySelectorAll('article')].find(item=>item.textContent?.includes('Stable message node'))).toBe(message);
    expect(host.querySelector<HTMLAnchorElement>('nav[aria-label="Work details"] a[href$="tab=changes"]')?.className).toContain('font-medium');
    expect([...host.querySelectorAll('h2')].some(item=>item.textContent==='Conversation')).toBe(true);
    expect(host.querySelector('[aria-label="Current delivery status"] [role="alert"]')?.textContent).toContain('Latest delivery · failed · Published');
    expect(send).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
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
    expect(workbenchApi.artifact.mock.calls.map(([id])=>id)).toContain(currentQa.id);
    expect(workbenchApi.artifact.mock.calls.map(([id])=>id)).not.toContain(staleQa.id);
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
    expect(artifactSpy.mock.calls.map(([id])=>id)).toContain(mismatchedQa.id);
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
    expect(artifactSpy.mock.calls.map(([id])=>id)).toContain(qa.id);
    expect(host.textContent).toContain('Typed review');
    expect(host.textContent).toContain('Keep evidence bound');
    expect(host.textContent).toContain('Current evidence');
  });

  it('keeps a failed diff unknown and lets the user retry only failed evidence after cooldown', async () => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const fixture=reviewOverviewFixture({qaRevision:'diff-revision',commitSha:'c'.repeat(40)});
    const diff=fixture.snapshot.artifacts.find(item=>item.kind==='diff')!;
    const requested:string[]=[];
    let firstDiff=true;
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const path=String(input),id=decodeURIComponent(path.split('/artifacts/')[1]??'').split('/')[0]!;requested.push(id);
      if(id===diff.id&&firstDiff){firstDiff=false;return new Response(JSON.stringify({message:'limited'}),{status:429});}
      return Response.json(id===diff.id?diff:fixture.qa);
    }));
    await mount(fixture.snapshot);await flush();
    expect(host.textContent).toContain('Some evidence could not be loaded');
    expect(host.textContent).toContain('Those results remain unknown');
    const retry=button('Retry failed evidence');
    await flush(()=>retry.click());
    expect(requested.filter(id=>id===diff.id)).toHaveLength(1);
    expect(host.textContent).toContain('Please wait for the server cooldown');
    await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});
    await flush();
    const refreshed=button('Retry failed evidence');
    await flush(()=>{refreshed.click();refreshed.click();});
    await flush();
    expect(requested.filter(id=>id===diff.id)).toHaveLength(2);
    expect(requested.filter(id=>id===fixture.metadata.id)).toHaveLength(1);
    expect(host.textContent).toContain('Current evidence');
    expect(host.textContent).toContain('approved');
    expect(host.textContent).not.toContain('Some evidence could not be loaded');
  });

  it.each(['work', 'revision', 'typed commit', 'typed diff revision', 'typed fingerprint', 'transport failure'] as const)('keeps a failed typed review retry Unknown for %s while preserving loaded evidence', async failure => {
    window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const fixture=reviewOverviewFixture({qaRevision:'diff-revision'});
    const diff=fixture.snapshot.artifacts.find(item=>item.kind==='diff')!;
    const fingerprint='a'.repeat(64);
    const commandMetadata={id:'qa-command',projectId:project.id,workId:fixture.work.id,runId:'candidate-run',kind:'qa' as const,revision:'diff-revision',createdAt:'2026-10-06T10:30:00.000Z'};
    const command={...commandMetadata,data:{verification:'current',stale:false,candidateFingerprint:fingerprint,checks:[{name:'typecheck',exitCode:0,testedRevision:fingerprint}]}};
    fixture.snapshot.artifacts.push(commandMetadata);
    const requested:string[]=[];let qaAttempts=0;
    vi.spyOn(document,'hidden','get').mockReturnValue(true);
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const path=String(input),id=decodeURIComponent(path.split('/artifacts/')[1]??'').split('/')[0]!;requested.push(id);
      if(id===fixture.metadata.id){qaAttempts++;if(qaAttempts===1)return new Response(JSON.stringify({message:'limited'}),{status:429});if(failure==='transport failure')return new Response(JSON.stringify({message:'still unavailable'}),{status:500});
        if(failure==='work')return Response.json({...fixture.qa,workId:'wrong-work'});
        if(failure==='revision')return Response.json({...fixture.qa,revision:'wrong-revision'});
        const typed={...fixture.qa.data.typedReview,...(failure==='typed commit'?{commitSha:'wrong-commit'}:{}),...(failure==='typed diff revision'?{diffRevision:'wrong-diff-revision'}:{}),...(failure==='typed fingerprint'?{candidateFingerprint:'b'.repeat(64)}:{})};
        return Response.json({...fixture.qa,data:{...fixture.qa.data,typedReview:typed}});
      }
      return Response.json(id===diff.id?diff:command);
    }));
    await mount(fixture.snapshot);await flush();
    expect(host.textContent).toContain('Current evidence');
    expect(host.textContent).toContain('Some evidence could not be loaded');
    await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});
    await flush();
    await flush(()=>button('Retry failed evidence').click());await flush();
    expect(host.textContent).toContain('Unknown');
    expect(host.textContent).toContain('Some evidence could not be loaded');
    expect(button('Retry failed evidence').disabled).toBe(false);
    expect(requested.filter(id=>id===diff.id)).toHaveLength(1);
    expect(requested.filter(id=>id===commandMetadata.id)).toHaveLength(1);
    expect(requested.filter(id=>id===fixture.metadata.id)).toHaveLength(2);
  });

  it.each([
    ['review','missing'],['review','null'],['review','string'],
    ['required','missing'],['required','unknown'],['command','missing'],['command','unknown'],
  ] as const)('keeps %s retry failed for %s role data until correct evidence returns',async(role,invalid)=>{
    const fixture=reviewOverviewFixture({qaRevision:'diff-revision',commitSha:'c'.repeat(40)});
    const diff=fixture.snapshot.artifacts.find(item=>item.kind==='diff')!;
    const fingerprint='a'.repeat(64),required=localQaFixture(project.id,fingerprint);
    const id=role==='review'?fixture.qa.id:`artifact:candidate-run:${role==='required'?'required-qa':'qa'}:candidate-run:1`;
    const qa=role==='review'?fixture.qa:{...fixture.qa,id,runId:'candidate-run',data:role==='required'?required.data:{verification:'current',stale:false,candidateFingerprint:fingerprint,checks:[{name:'command',exitCode:0,testedRevision:fingerprint}]}};
    if(role!=='review'){
      fixture.snapshot.runs=fixture.snapshot.runs.filter(run=>run.kind==='implementation');
      if(role==='required')fixture.snapshot.runs[0]!.qaPolicySnapshot=required.policy;
      const {data,...metadata}=qa;fixture.snapshot.artifacts=[diff,metadata];
    }
    let attempts=0;const requested:string[]=[];
    vi.spyOn(document,'hidden','get').mockReturnValue(true);
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const artifactId=decodeURIComponent(String(input).split('/artifacts/')[1]!);requested.push(artifactId);
      if(artifactId===diff.id)return Response.json(diff);
      attempts++;if(attempts===1)return new Response('{}',{status:429});
      if(attempts===2){
        const data=invalid==='missing'?{}:invalid==='null'?{typedReview:null}:invalid==='string'?{typedReview:'approved'}:{...qa.data,verification:'unknown'};
        return Response.json({...qa,data});
      }
      return Response.json(qa);
    }));
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    await mount(fixture.snapshot);await flush();
    await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});
    await flush(()=>button('Retry failed evidence').click());await flush();
    expect(host.textContent).toContain('Some evidence could not be loaded');
    const section=role==='review'?[...host.querySelectorAll('section')].find(item=>item.querySelector('h3')?.textContent==='Typed review'):host.querySelector(`[aria-label="${role==='required'?'Required':'Command'} checks"]`);
    expect(section?.textContent).toContain('Unknown');
    await flush(()=>button('Retry failed evidence').click());await flush();
    expect(host.textContent).not.toContain('Some evidence could not be loaded');
    expect(host.textContent).toContain('Current evidence');
    expect(requested.filter(value=>value===diff.id)).toHaveLength(1);
    expect(attempts).toBe(3);
  });

  it.each(['b'.repeat(40),'not-a-sha'])('binds a no-review diff retry to the snapshot SHA instead of %s',async(wrongSha)=>{
    const sha='c'.repeat(40),fixture=reviewOverviewFixture({commitSha:sha});
    const diff=fixture.snapshot.artifacts.find(item=>item.kind==='diff')!;
    fixture.snapshot.runs=fixture.snapshot.runs.filter(run=>run.kind==='implementation');fixture.snapshot.artifacts=[diff];
    let attempts=0;vi.spyOn(document,'hidden','get').mockReturnValue(true);
    vi.stubGlobal('fetch',vi.fn(async()=>{attempts++;return attempts===1?new Response('{}',{status:429}):Response.json(attempts===2?{...diff,data:{...diff.data,candidateRevision:wrongSha}}:diff);}));
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    await mount(fixture.snapshot);await flush();await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});
    await flush(()=>button('Retry failed evidence').click());await flush();
    expect(host.textContent).toContain('Some evidence could not be loaded');
    expect(host.textContent).not.toContain(`Current candidate · candidate-run · ${wrongSha}`);
    await flush(()=>button('Retry failed evidence').click());await flush();
    expect(host.textContent).not.toContain('Some evidence could not be loaded');expect(host.textContent).toContain(sha);expect(attempts).toBe(3);
  });

  it('recovers two initially failed IDs separately and retries only the remaining failure',async()=>{
    const fixture=reviewOverviewFixture({qaRevision:'diff-revision',commitSha:'c'.repeat(40)}),fingerprint='a'.repeat(64);
    const diff=fixture.snapshot.artifacts.find(item=>item.kind==='diff')!;
    const command={...fixture.qa,id:'artifact:candidate-run:qa:candidate-run:1',runId:'candidate-run',data:{verification:'current',stale:false,candidateFingerprint:fingerprint,checks:[{name:'command',exitCode:0,testedRevision:fingerprint}]}};
    const {data,...commandMetadata}=command;fixture.snapshot.artifacts.push(commandMetadata);
    const counts=new Map<string,number>();vi.spyOn(document,'hidden','get').mockReturnValue(true);
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const id=decodeURIComponent(String(input).split('/artifacts/')[1]!),count=(counts.get(id)??0)+1;counts.set(id,count);
      if(id===diff.id)return Response.json(diff);
      if(count===1)return new Response('{}',{status:429});
      if(id===command.id)return Response.json(command);
      return Response.json(count===2?{...fixture.qa,data:{}}:fixture.qa);
    }));
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    await mount(fixture.snapshot);await flush();await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});
    await flush(()=>button('Retry failed evidence').click());await flush();
    expect(host.querySelector('[aria-label="Command checks"]')?.textContent).toContain('Current evidence');
    expect([...host.querySelectorAll('section')].find(item=>item.querySelector('h3')?.textContent==='Typed review')?.textContent).toContain('Unknown');
    expect(host.textContent).toContain('Some evidence could not be loaded');expect(button('Retry failed evidence').disabled).toBe(false);
    expect(counts.get(command.id)).toBe(2);expect(counts.get(fixture.qa.id)).toBe(2);
    await flush(()=>button('Retry failed evidence').click());await flush();
    expect(counts.get(command.id)).toBe(2);expect(counts.get(fixture.qa.id)).toBe(3);expect(counts.get(diff.id)).toBe(1);
    expect(host.textContent).not.toContain('Some evidence could not be loaded');expect(host.textContent).toContain('approved');
  });

  it.each([
    { transition:'Work switch', late:'429' },{ transition:'Work switch', late:'success' },
    { transition:'same-member logout/login', late:'429' },{ transition:'same-member logout/login', late:'success' },
    { transition:'unmount', late:'429' },{ transition:'unmount', late:'success' },
  ] as const)('fences a pending QA evidence retry after $transition and late $late',async({transition,late})=>{
    const first=reviewOverviewFixture({qaRevision:'diff-revision'});
    const second=reviewOverviewFixture({workId:'work-2',qaId:'review-qa-2',qaRevision:'second-diff-revision',commitSha:'second-candidate-commit',diffRevision:'second-diff-revision'});
    let current=first.snapshot;
    if(transition==='Work switch'){
      current={...first.snapshot,works:[first.work,second.work],runs:[...first.snapshot.runs,...second.snapshot.runs],artifacts:[...first.snapshot.artifacts,...second.snapshot.artifacts]};
    }
    const artifacts=new Map<string,unknown>([...first.snapshot.artifacts.map(item=>[item.id,item] as [string,unknown]),...second.snapshot.artifacts.map(item=>[item.id,item] as [string,unknown]),[first.qa.id,first.qa],[second.qa.id,{...second.qa,data:{...second.qa.data,typedReview:{...second.qa.data.typedReview,disposition:'changes_requested'}}}]]);
    let qaCalls=0,snapshotCalls=0;const requested:string[]=[];let finishRetry!: (response:Response)=>void;let retrySignal:AbortSignal|undefined;
    const retryResponse=new Promise<Response>(resolve=>{finishRetry=resolve;});
    vi.spyOn(document,'hidden','get').mockReturnValue(true);
    vi.spyOn(workbenchApi,'sendMessage');
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const path=String(input),id=decodeURIComponent(path.split('/artifacts/')[1]??'').split('/')[0]!;
      requested.push(id);
      if(path.endsWith('/snapshot')){
        snapshotCalls++;
        return snapshotCalls===1?new Response(JSON.stringify({message:'current scope limited'}),{status:429,headers:{'Retry-After':'30'}}):Response.json(current);
      }
      if(id===first.metadata.id){qaCalls++;if(qaCalls===1)return new Response(JSON.stringify({message:'limited'}),{status:429});if(qaCalls===2){retrySignal=init?.signal??undefined;return retryResponse;}}
      const artifact=artifacts.get(id);if(artifact)return Response.json(artifact);
      throw new Error(`Unexpected evidence request ${id}`);
    }));
    window.history.replaceState(null,'',`/workbench/?view=work-detail&project=${project.id}&work=${first.work.id}&tab=qa`);
    await mount(current);await flush();
    expect(host.textContent).toContain('Some evidence could not be loaded');
    await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});await flush();
    await flush(()=>button('Retry failed evidence').click());
    expect(qaCalls).toBe(2);expect(retrySignal?.aborted).toBe(false);

    if(transition==='Work switch'){
      window.history.replaceState(null,'',`/workbench/?view=work-detail&project=${project.id}&work=${second.work.id}&tab=qa`);
      vi.mocked(workbenchApi.snapshot).mockRestore();
      vi.spyOn(document,'hidden','get').mockReturnValue(false);
      await advanceSnapshotPoll();
      expect(host.textContent).toContain('second-candidate-commit');
      expect(canAutoPoll()).toBe(false);
    }else if(transition==='same-member logout/login'){
      artifacts.set(first.qa.id,{...first.qa,data:{...first.qa.data,typedReview:{...first.qa.data.typedReview,disposition:'changes_requested'}}});
      vi.spyOn(workbenchApi,'logout').mockResolvedValue();
      vi.spyOn(workbenchApi,'login').mockResolvedValue({authenticated:true});
      await flush(()=>host.querySelector('aside > button')!.click());
      await type('#login-email',owner.email);await type('#login-password','mock password');
      await flush(()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
      expect(host.textContent).toContain('candidate-commit');
    }else{
      await flush(()=>root.unmount());
    }
    expect(retrySignal?.aborted).toBe(true);
    const typedState=()=>[...host.querySelectorAll('section')].find(item=>item.querySelector('h3')?.textContent==='Typed review')?.textContent;
    const settledState=typedState();
    if(transition!=='unmount'){
      expect(settledState).toContain('Current evidence');expect(settledState).toContain('changes_requested');
      expect(host.textContent).not.toContain('Some evidence could not be loaded');
      expect(host.textContent).not.toContain('Loading candidate evidence');
      expect([...host.querySelectorAll('button')].some(item=>item.textContent==='Retry failed evidence')).toBe(false);
    }
    finishRetry(late==='429'?new Response(JSON.stringify({message:'late limited'}),{status:429,headers:{'Retry-After':'120'}}):Response.json(first.qa));
    await flush();
    if(transition==='Work switch'){
      expect(canAutoPoll()).toBe(false);
      await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});await flush();
      expect(snapshotCalls).toBe(2);
      expect(canAutoPoll()).toBe(true);
    }else expect(canAutoPoll()).toBe(true);
    expect(vi.mocked(workbenchApi.sendMessage)).not.toHaveBeenCalled();
    expect(qaCalls).toBe(transition==='same-member logout/login'?3:2);
    expect(requested.filter(id=>id===first.snapshot.artifacts.find(item=>item.kind==='diff')!.id)).toHaveLength(transition==='same-member logout/login'?2:1);
    if(transition!=='unmount'){
      expect(typedState()).toBe(settledState);
      expect(host.textContent).not.toContain('Some evidence could not be loaded');
      expect(host.textContent).not.toContain('Loading candidate evidence');
      expect([...host.querySelectorAll('button')].some(item=>item.textContent==='Retry failed evidence')).toBe(false);
    }
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

describe('delivery action and narrow breadcrumb UI',()=>{
  it.each([
    ['queued','queued','Queued',true,undefined],
    ['running','running','In progress',true,undefined],
    ['paused','queued','Paused',true,'2026-10-14T09:00:00.000Z'],
    ['paused','running','Paused',true,undefined],
    ['failed','failed','Retry Draft PR',false,undefined],
    ['interrupted','interrupted','Retry Draft PR',false,undefined],
    ['cancelled','cancelled','Retry Draft PR',false,undefined],
    ['completed','pr_created','Draft PR created',true,undefined],
    ['completed','unknown','Delivery status unavailable',true,undefined],
  ] as const)('shows truthful draft delivery state for %s runs',async(status,phase,label,disabled,stoppedAt)=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const work={id:'work-1',projectId:project.id,title:'Delivery status',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const candidate={id:'candidate-run',projectId:project.id,workId:work.id,kind:'implementation' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium',status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06'};
    const delivery={id:'delivery-run',projectId:project.id,workId:work.id,targetRunId:candidate.id,kind:'delivery' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium',status,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06',...(stoppedAt?{stoppedAt}:{}),operation:{action:'create_draft_pr',phase,pullRequestUrl:phase==='pr_created'?'https://github.com/blossomsai/menoteam/pull/4':undefined}} as Snapshot['runs'][number];
    const diff={id:'delivery-diff',projectId:project.id,workId:work.id,runId:candidate.id,kind:'diff' as const,revision:'delivery-revision',createdAt:'2026-10-06',data:{candidateRevision:'candidate-sha',baseRevision:'base-sha',files:[],totalFiles:0,truncated:false}};
    const current=snapshot();current.projects[0]={...project,repositoryUrl:'https://github.com/blossomsai/menoteam'};current.works=[work];current.runs=[candidate,delivery];current.artifacts=[diff];
    vi.spyOn(workbenchApi,'artifact').mockResolvedValue(diff);
    const request=vi.spyOn(workbenchApi,'requestDraftPr');
    await mount(current);await flush();
    const history=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.startsWith('Delivery history'))!;
    expect(history.open).toBe(false);
    const currentStatus=host.querySelector('[aria-label="Current delivery status"]');
    const readablePhase=phase==='pr_created'?'Draft PR created':phase==='unknown'?'Unknown':phase.replaceAll('_',' ').replace(/\b\w/gu,letter=>letter.toUpperCase());
    expect(currentStatus?.textContent).toContain(`Latest delivery · ${status} · ${readablePhase}`);
    if(status==='failed')expect(currentStatus?.querySelector('[role="alert"]')?.textContent).toContain('Latest delivery · failed');
    else expect(currentStatus?.querySelector('[role="alert"]')).toBeNull();
    await flush(()=>{history.open=true;});
    const action=button(label);expect(action.disabled).toBe(disabled);
    expect(action.closest('section')?.textContent).toContain(`Delivery ${status} · ${phase}`);
    if(status==='paused'){
      expect(delivery.stoppedAt).toBe(stoppedAt);
      expect(action.textContent).toBe('Paused');
      await flush(()=>action.click());expect(request).not.toHaveBeenCalled();
    }
  });

  it('keeps long project and Work breadcrumb content inside shrinkable navigation with full accessible names',async()=>{
    const projectName='The extremely long integration project name that must not force a mobile viewport wider';
    const workTitle='A long Work title that should truncate while remaining fully available to assistive technology';
    const longProject={...project,name:projectName};
    const work={id:'work-1',projectId:project.id,title:workTitle,overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const current=snapshot();current.projects[0]=longProject;current.works=[work];
    window.history.replaceState(null,'',`/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
    await mount(current);
    const header=host.querySelector('header')!,nav=host.querySelector('nav[aria-label="Breadcrumb"]')!;
    expect(header.className).toContain('min-w-0');expect(nav.className).toContain('min-w-0');expect(nav.className).toContain('flex-1');
    const links=[...nav.querySelectorAll('a')];
    expect(links.map(link=>link.textContent)).toEqual([projectName,'Work']);
    expect(links[0]?.getAttribute('href')).toContain(`project=${project.id}`);
    expect(links[0]?.getAttribute('aria-label')).toBe(projectName);expect(links[0]?.title).toBe(projectName);
    expect(links[0]?.className).toContain('truncate');expect(links[0]?.className).toContain('basis-[38%]');expect(links[0]?.className).toContain('shrink-0');expect(links[0]?.className).toContain('sm:basis-auto');
    const workLink=links[1]!;expect(workLink.textContent).toBe('Work');expect(workLink.getAttribute('href')).toContain(`view=work&project=${project.id}`);
    const currentLabel=nav.querySelector('strong')!;expect(currentLabel.textContent).toBe('Work detail');expect(currentLabel.getAttribute('aria-label')).toBe(workTitle);expect(currentLabel.title).toBe(workTitle);expect(currentLabel.className).toContain('min-w-16');expect(currentLabel.className).toContain('flex-1');expect(currentLabel.className).toContain('truncate');
    expect(host.querySelectorAll('h1')).toHaveLength(1);expect(host.querySelector('h1')?.textContent).toBe(workTitle);
  });
});

function reviewOverviewFixture(options:{member?:typeof owner;workId?:string;qaId?:string;qaRevision?:string;candidateRunId?:string;commitSha?:string;diffRevision?:string}={}){
  const currentMember=options.member??owner,workId=options.workId??'work-1',qaId=options.qaId??'review-qa',qaRevision=options.qaRevision??'qa-revision',candidateRunId=options.candidateRunId??'candidate-run',commitSha=options.commitSha??'candidate-commit',diffRevision=options.diffRevision??'diff-revision';
  const work={id:workId,projectId:project.id,title:`Overview ${workId}`,overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
  const diff={id:`diff-${workId}`,projectId:project.id,workId,runId:candidateRunId,kind:'diff' as const,revision:diffRevision,createdAt:'2026-10-06T10:00:00.000Z',data:{candidateRevision:commitSha,files:[],totalFiles:0,truncated:false}};
  const fingerprint='a'.repeat(64),reviewRunId=`review-run-${workId}`;
  const binding={candidateRunId,commitSha,candidateFingerprint:fingerprint,diffArtifactId:diff.id,diffRevision,qaArtifactIds:[qaId]};
  const candidate={id:candidateRunId,projectId:project.id,workId,kind:'implementation' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06'} as Snapshot['runs'][number];
  const review={id:reviewRunId,projectId:project.id,workId,kind:'review' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06',reviewBinding:binding} as Snapshot['runs'][number];
  const delivery={id:`delivery-${workId}`,projectId:project.id,workId,targetRunId:candidateRunId,kind:'delivery' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06',operation:{action:'create_draft_pr',phase:'pr_created',candidateRunId,commitSha,candidateFingerprint:'a'.repeat(64),artifactRevision:diffRevision}} as Snapshot['runs'][number];
  const metadata={id:qaId,projectId:project.id,workId,runId:reviewRunId,kind:'qa' as const,revision:qaRevision,createdAt:'2026-10-06T11:00:00.000Z'};
  const qa={...metadata,data:{verification:'current',typedReview:{...binding,reviewerRunId:reviewRunId,disposition:'approved',findings:[]}}};
  const current=snapshot(currentMember);current.works=[work];current.runs=[candidate,review,delivery];current.artifacts=[diff,metadata];
  return {snapshot:current,qa,work,metadata};
}
function freshClone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
async function advanceSnapshotPoll(){await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});await flush();}

describe('overview typed-review polling identity',()=>{
  const openOverview=(workId='work-1')=>window.history.replaceState(null,'',`/workbench/?view=work-detail&project=project&work=${workId}`);
  const reviewButton=()=>[...host.querySelectorAll('strong')].find(item=>item.textContent==='Merge reviewed pull request')?.closest('section')??null;

  it('does not refetch completed reviewer evidence when each two-second snapshot clones the same identities',async()=>{
    openOverview();const fixture=reviewOverviewFixture();
    const evidence=vi.spyOn(workbenchApi,'artifact').mockResolvedValue(fixture.qa as never);
    await mount(fixture.snapshot);await flush();expect(evidence).toHaveBeenCalledTimes(1);
    const snapshotRequest=vi.mocked(workbenchApi.snapshot);snapshotRequest.mockClear().mockImplementation(async()=>freshClone(fixture.snapshot));
    await advanceSnapshotPoll();await advanceSnapshotPoll();
    expect(snapshotRequest).toHaveBeenCalledTimes(2);expect(evidence).toHaveBeenCalledTimes(1);expect(reviewButton()).not.toBeNull();
  });

  it('refreshes evidence when candidate binding and eligible artifact identity/revision change',async()=>{
    openOverview();const first=reviewOverviewFixture();let current=first.snapshot;
    const second=reviewOverviewFixture({qaId:'review-qa-new',qaRevision:'qa-revision-new',candidateRunId:'candidate-run-new',commitSha:'candidate-commit-new',diffRevision:'diff-revision-new'});
    const pending=deferred<Awaited<ReturnType<typeof workbenchApi.artifact>>>();
    const evidence=vi.spyOn(workbenchApi,'artifact').mockImplementation(async id=>id==='review-qa'?first.qa as never:pending.promise);
    await mount(first.snapshot);await flush();expect(evidence).toHaveBeenCalledTimes(1);expect(reviewButton()).not.toBeNull();
    current=second.snapshot;const snapshotRequest=vi.mocked(workbenchApi.snapshot);snapshotRequest.mockImplementation(async()=>freshClone(current));
    await advanceSnapshotPoll();expect(evidence).toHaveBeenCalledTimes(2);expect(evidence.mock.calls[1]?.[0]).toBe('review-qa-new');expect(reviewButton()).toBeNull();
    pending.resolve(second.qa as never);await flush();expect(reviewButton()).not.toBeNull();
  });

  it('separates session scopes and ignores a late approval from the previous session',async()=>{
    openOverview();const fixture=reviewOverviewFixture();const oldResult=deferred<Awaited<ReturnType<typeof workbenchApi.artifact>>>();const newResult=deferred<Awaited<ReturnType<typeof workbenchApi.artifact>>>();
    const evidence=vi.spyOn(workbenchApi,'artifact').mockImplementation(()=>evidence.mock.calls.length===1?oldResult.promise:newResult.promise);
    await mount(fixture.snapshot);await flush();expect(evidence).toHaveBeenCalledTimes(1);
    const changedSession=freshClone(fixture.snapshot);changedSession.member=member;let current=changedSession;
    vi.mocked(workbenchApi.snapshot).mockImplementation(async()=>freshClone(current));
    await advanceSnapshotPoll();expect(evidence).toHaveBeenCalledTimes(2);expect(reviewButton()).toBeNull();
    oldResult.resolve(fixture.qa as never);await flush();expect(reviewButton()).toBeNull();
    newResult.resolve(fixture.qa as never);await flush();expect(reviewButton()).not.toBeNull();
  });

  it('cancels prior Work evidence reads when the selected Work changes',async()=>{
    openOverview('work-1');const first=reviewOverviewFixture();const second=reviewOverviewFixture({workId:'work-2',qaId:'review-qa-work-2'});
    const oldResult=deferred<Awaited<ReturnType<typeof workbenchApi.artifact>>>();const newResult=deferred<Awaited<ReturnType<typeof workbenchApi.artifact>>>();
    const evidence=vi.spyOn(workbenchApi,'artifact').mockImplementation(id=>id==='review-qa'?oldResult.promise:newResult.promise);
    await mount(first.snapshot);await flush();expect(evidence).toHaveBeenCalledTimes(1);
    const next=freshClone(first.snapshot);next.works=[first.work,second.work];next.runs=[...next.runs,...second.snapshot.runs];next.artifacts=[...next.artifacts,...second.snapshot.artifacts];
    vi.mocked(workbenchApi.snapshot).mockImplementation(async()=>freshClone(next));
    window.history.replaceState(null,'',`/workbench/?view=work-detail&project=project&work=work-2`);
    await advanceSnapshotPoll();expect(evidence).toHaveBeenCalledTimes(2);expect(evidence.mock.calls[1]?.[0]).toBe('review-qa-work-2');expect(reviewButton()).toBeNull();
    oldResult.resolve(first.qa as never);await flush();expect(reviewButton()).toBeNull();
    newResult.resolve(second.qa as never);await flush();expect(reviewButton()).not.toBeNull();
  });

  it('keeps Overview receipts closed while retaining exact receipt details and the bound merge action',async()=>{
    openOverview();const fixture=reviewOverviewFixture();
    const receipt={id:'delivery-receipt-overview',projectId:project.id,workId:fixture.work.id,runId:'delivery-work-1',kind:'delivery' as const,revision:'delivery-receipt-revision',createdAt:'2026-10-06T12:00:00.000Z',data:{action:'create_draft_pr',phase:'pr_created',pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/42',commitSha:'exact-candidate-sha'}};
    fixture.snapshot.artifacts.push(receipt);
    vi.spyOn(workbenchApi,'artifact').mockImplementation(async id=>id==='review-qa'?fixture.qa as never:receipt as never);
    await mount(fixture.snapshot);await flush();
    const history=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.startsWith('Delivery history'))!;
    expect(history.open).toBe(false);expect(history.querySelector('summary')?.textContent).toContain('1 receipts');
    expect(host.querySelector('[aria-label="Current delivery status"]')?.textContent).toContain('Latest delivery · completed · Draft PR created');
    const overview=host.querySelector('h2');const disclosure=history.querySelector('summary');
    expect(overview?.textContent).toBe('Current overview');expect(overview!.compareDocumentPosition(disclosure!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await flush(()=>{history.open=true;});await flush();
    expect(history.textContent).toContain('pr created');expect(history.textContent).toContain('exact-candidate-sha');expect(history.textContent).toContain('https://github.com/blossomsai/menoteam/pull/42');
    expect(button('Queue merge').disabled).toBe(false);
  });

  it.each([{reverse:false,tab:'changes'},{reverse:true,tab:'changes'},{reverse:false,tab:'overview'},{reverse:true,tab:'overview'}] as const)('shows the newest candidate lifecycle in $tab regardless of run array order (reversed=$reverse)',async({reverse,tab})=>{
    window.history.replaceState(null,'',`/workbench/?view=work-detail&project=project&work=work-1${tab==='changes'?'&tab=changes':''}`);
    const work={id:'work-1',projectId:project.id,title:'Delivery order',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const candidate={id:'candidate-current',projectId:project.id,workId:work.id,kind:'implementation' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium',status:'completed' as const,generation:1,createdAt:'2026-10-06T09:00:00.000Z',updatedAt:'2026-10-06T09:00:00.000Z'};
    const otherCandidate={...candidate,id:'candidate-other'};
    const priorPr={id:'delivery-pr',projectId:project.id,workId:work.id,targetRunId:candidate.id,kind:'delivery' as const,prompt:'',model:'internal',reasoning:'none',status:'completed' as const,generation:0,createdAt:'2026-10-06T10:00:00.000Z',updatedAt:'2026-10-06T10:00:00.000Z',operation:{action:'create_draft_pr',phase:'pr_created',candidateRunId:candidate.id,external:{pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/41'}}};
    const merge={...priorPr,id:'delivery-merge',status:'completed' as const,createdAt:'2026-10-06T12:00:00.000Z',updatedAt:'2026-10-06T12:05:00.000Z',operation:{action:'merge_pr',phase:'merged',candidateRunId:candidate.id,external:{pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/41',mergeSha:'merge-sha'}}};
    const otherPr={...priorPr,id:'delivery-other-pr',targetRunId:otherCandidate.id,createdAt:'2026-10-06T13:00:00.000Z',updatedAt:'2026-10-06T13:00:00.000Z',operation:{...priorPr.operation,candidateRunId:otherCandidate.id,external:{pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/99'}}};
    const diff={id:'delivery-diff',projectId:project.id,workId:work.id,runId:candidate.id,kind:'diff' as const,revision:'delivery-revision',createdAt:'2026-10-06T09:00:00.000Z',data:{candidateRevision:'candidate-sha',baseRevision:'base-sha',files:[],totalFiles:0,truncated:false}};
    const lifecycle:Snapshot['runs']=[priorPr,merge,otherPr];const current=snapshot();current.projects[0]={...project,repositoryUrl:'https://github.com/blossomsai/menoteam'};current.works=[work];current.runs=[candidate,otherCandidate,...(reverse?[...lifecycle].reverse():lifecycle)];current.artifacts=[diff];
    vi.spyOn(workbenchApi,'artifact').mockResolvedValue(diff);await mount(current);await flush();
    const summary=host.querySelector('[aria-label="Current delivery status"]')!;
    expect(summary.textContent).toContain('Latest delivery · completed · Merged');expect(summary.textContent).not.toContain('generation');expect(summary.textContent).toContain('10/6/2026');
    expect(summary.querySelector('a')?.getAttribute('href')).toBe('https://github.com/blossomsai/menoteam/pull/41');
    expect(summary.textContent).not.toContain('Draft PR created');expect(summary.textContent).not.toContain('/pull/99');
    if(tab==='changes'){const history=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.startsWith('Delivery history'))!;expect(history.open).toBe(false);}
  });

  it.each([
    ['failed','merge_intent','failed · Merge in progress'],
    ['completed','unknown','completed · Unknown'],
  ] as const)('does not replace a newest failure or Unknown phase with an older PR success (%s/%s)',async(status,phase,expected)=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const work={id:'work-1',projectId:project.id,title:'Current delivery state',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const candidate={id:'candidate-state',projectId:project.id,workId:work.id,kind:'implementation' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium',status:'completed' as const,generation:1,createdAt:'2026-10-06T09:00:00.000Z',updatedAt:'2026-10-06T09:00:00.000Z'};
    const earlier={id:'delivery-old-pr',projectId:project.id,workId:work.id,targetRunId:candidate.id,kind:'delivery' as const,prompt:'',model:'internal',reasoning:'none',status:'completed' as const,generation:0,createdAt:'2026-10-06T10:00:00.000Z',updatedAt:'2026-10-06T10:00:00.000Z',operation:{action:'create_draft_pr',phase:'pr_created',candidateRunId:candidate.id,external:{pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/41'}}};
    const latest={...earlier,id:'delivery-current',status,generation:2,createdAt:'2026-10-06T11:00:00.000Z',updatedAt:'2026-10-06T12:00:00.000Z',operation:{...earlier.operation,action:'merge_pr',phase,candidateRunId:candidate.id,external:{pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/41'}}} as Snapshot['runs'][number];
    const diff={id:'delivery-diff',projectId:project.id,workId:work.id,runId:candidate.id,kind:'diff' as const,revision:'delivery-revision',createdAt:'2026-10-06T09:00:00.000Z',data:{candidateRevision:'candidate-sha',baseRevision:'base-sha',files:[],totalFiles:0,truncated:false}};
    const current=snapshot();current.projects[0]={...project,repositoryUrl:'https://github.com/blossomsai/menoteam'};current.works=[work];current.runs=[candidate,earlier,latest];current.artifacts=[diff];vi.spyOn(workbenchApi,'artifact').mockResolvedValue(diff);await mount(current);await flush();
    const summary=host.querySelector('[aria-label="Current delivery status"]')!;expect(summary.textContent).toContain(`Latest delivery · ${expected}`);expect(summary.textContent).not.toContain('Draft PR created');
    if(status==='failed')expect(summary.querySelector('[role="alert"]')?.textContent).toContain('Latest delivery · failed');else expect(summary.querySelector('[role="alert"]')).toBeNull();
    expect(summary.querySelector('a')?.getAttribute('href')).toBe('https://github.com/blossomsai/menoteam/pull/41');
  });

  it('keeps Draft PR action gating and request binding on its original first matching run',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=changes');
    const work={id:'work-1',projectId:project.id,title:'Action binding',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const candidate={id:'candidate-action',projectId:project.id,workId:work.id,kind:'implementation' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium',status:'completed' as const,generation:1,createdAt:'2026-10-06T09:00:00.000Z',updatedAt:'2026-10-06T09:00:00.000Z'};
    const failed={id:'delivery-first-failed',projectId:project.id,workId:work.id,targetRunId:candidate.id,kind:'delivery' as const,prompt:'',model:'internal',reasoning:'none',status:'failed' as const,generation:1,createdAt:'2026-10-06T10:00:00.000Z',updatedAt:'2026-10-06T10:00:00.000Z',operation:{action:'create_draft_pr',phase:'queued',candidateRunId:candidate.id}};
    const merged={...failed,id:'delivery-later-merge',status:'completed' as const,createdAt:'2026-10-06T11:00:00.000Z',updatedAt:'2026-10-06T11:00:00.000Z',operation:{action:'merge_pr',phase:'merged',candidateRunId:candidate.id,external:{pullRequestUrl:'https://github.com/blossomsai/menoteam/pull/41'}}};
    const diff={id:'delivery-diff',projectId:project.id,workId:work.id,runId:candidate.id,kind:'diff' as const,revision:'exact-diff-revision',createdAt:'2026-10-06T09:00:00.000Z',data:{candidateRevision:'exact-candidate-sha',baseRevision:'base-sha',files:[],totalFiles:0,truncated:false}};
    const current=snapshot();current.projects[0]={...project,repositoryUrl:'https://github.com/blossomsai/menoteam'};current.works=[work];current.runs=[candidate,failed,merged];current.artifacts=[diff];vi.spyOn(workbenchApi,'artifact').mockResolvedValue(diff);const request=vi.spyOn(workbenchApi,'requestDraftPr').mockResolvedValue(undefined as never);await mount(current);await flush();
    expect(host.querySelector('[aria-label="Current delivery status"]')?.textContent).toContain('Latest delivery · completed · Merged');
    const history=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.startsWith('Delivery history'))!;await flush(()=>{history.open=true;});
    const action=button('Retry Draft PR');expect(action.disabled).toBe(false);await flush(()=>action.click());
    expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0]?.[0]).toBe(work.id);expect(request.mock.calls[0]?.[1]).toMatchObject({candidateRunId:candidate.id,candidateRevision:'exact-diff-revision',action:'create_draft_pr'});expect(typeof request.mock.calls[0]?.[1].requestId).toBe('string');
  });
});

describe('long evidence text wrapping',()=>{
  it('wraps the complete Overview fingerprint without clipping or changing its text',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1');
    const fixture=reviewOverviewFixture();const fingerprint='f'.repeat(64);const overview=`Candidate fingerprint ${fingerprint}`;
    fixture.work.overview=overview;
    await mount(fixture.snapshot);
    const section=[...host.querySelectorAll('section')].find(item=>item.querySelector('h2')?.textContent==='Current overview')!;
    const paragraph=section.querySelector('p')!;
    expect(paragraph.textContent).toBe(overview);expect(paragraph.textContent).toContain(fingerprint);
    expect(section.className).toContain('min-w-0');expect(paragraph.className).toContain('min-w-0');expect(paragraph.className).toContain('wrap-anywhere');
    expect(paragraph.className).not.toMatch(/line-clamp|truncate/u);
  });

  it('wraps complete QA reviewer IDs, hashes, and finding text while preserving the evidence strings',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work={id:'work-1',projectId:project.id,title:'Long QA evidence',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const candidateId=`candidate-${'a'.repeat(64)}`,reviewRunId=`reviewer-${'b'.repeat(64)}`,commitSha='c'.repeat(64),candidateFingerprint='d'.repeat(64),diffRevision='e'.repeat(64),diffArtifactId=`artifact-diff-${'f'.repeat(64)}`,qaId=`artifact-review-${'9'.repeat(64)}`;
    const binding={candidateRunId:candidateId,commitSha,candidateFingerprint,diffArtifactId,diffRevision,qaArtifactIds:[qaId]};
    const diff={id:diffArtifactId,projectId:project.id,workId:work.id,runId:candidateId,kind:'diff' as const,revision:diffRevision,createdAt:'2026-10-06',data:{candidateRevision:commitSha,files:[],totalFiles:0,truncated:false}};
    const candidate={id:candidateId,projectId:project.id,workId:work.id,kind:'implementation' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06'} as Snapshot['runs'][number];
    const reviewRun={id:reviewRunId,projectId:project.id,workId:work.id,kind:'review' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06',reviewBinding:binding} as Snapshot['runs'][number];
    const finding=`Artifact ${qaId} binds candidate ${candidateId}, commit ${commitSha}, diff ${diffArtifactId}, and SHA-256 ${candidateFingerprint}; preserve this full-reference-code-${'0123456789abcdef'.repeat(4)} text.`;
    const qa={id:qaId,projectId:project.id,workId:work.id,runId:reviewRunId,kind:'qa' as const,revision:diffRevision,createdAt:'2026-10-06',data:{typedReview:{...binding,reviewerRunId:reviewRunId,disposition:'approved',findings:[{id:'long-finding',blocking:true,summary:finding}]}}};
    const qaMetadata={id:qa.id,projectId:qa.projectId,workId:qa.workId,runId:qa.runId,kind:qa.kind,revision:qa.revision,createdAt:qa.createdAt};
    const current=snapshot();current.works=[work];current.runs=[candidate,reviewRun];current.artifacts=[{id:diff.id,projectId:diff.projectId,workId:diff.workId,runId:diff.runId,kind:diff.kind,revision:diff.revision,createdAt:diff.createdAt},qaMetadata];
    vi.spyOn(workbenchApi,'artifact').mockImplementation(async id=>id===diff.id?diff:qa);
    await mount(current);await flush();
    const panel=[...host.querySelectorAll('section')].find(item=>item.querySelector('h3')?.textContent==='Typed review')!;
    expect(panel.textContent).toContain(reviewRunId);expect(panel.textContent).toContain(commitSha);expect(panel.textContent).toContain(candidateFingerprint);expect(panel.textContent).toContain(finding);
    expect(panel.className).toContain('min-w-0');
    const evidence=[...panel.querySelectorAll('p')].find(item=>item.textContent===`Blocking · ${finding}`)!;
    expect(evidence.textContent).toBe(`Blocking · ${finding}`);expect(evidence.className).toContain('min-w-0');expect(evidence.className).toContain('wrap-anywhere');
    expect(evidence.className).not.toMatch(/line-clamp|truncate/u);
    expect([...host.querySelectorAll('section.min-w-0.space-y-4')].some(item=>item.querySelector('h2')?.textContent==='QA')).toBe(true);
  });

  it('wraps full QA ArtifactCard findings, review text, command labels and JSON in expanded Evidence details',async()=>{
    window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work-1&tab=qa');
    const work={id:'work-1',projectId:project.id,title:'Expanded QA artifact',overview:'',status:'in_progress' as const,revision:1,profileId:'',sources:[],createdAt:'',updatedAt:''};
    const candidateId=`candidate-${'a'.repeat(64)}`,commitSha='b'.repeat(64),fingerprint='c'.repeat(64),revision='d'.repeat(64),qaId=`artifact-qa-${'e'.repeat(64)}`;
    const diff={id:'diff-expanded-qa',projectId:project.id,workId:work.id,runId:candidateId,kind:'diff' as const,revision,createdAt:'2026-10-06',data:{candidateRevision:commitSha,files:[],totalFiles:0,truncated:false}};
    const candidate={id:candidateId,projectId:project.id,workId:work.id,kind:'implementation' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'2026-10-06',updatedAt:'2026-10-06'} as Snapshot['runs'][number];
    const fixture=localQaFixture(project.id,fingerprint);
    const commandName=`required-check-${'f'.repeat(64)}-${qaId}`;
    const command=JSON.stringify({executable:'repo-bin',bin:`test-${'0'.repeat(64)}`,args:['run',qaId,candidateId]});
    const output=JSON.stringify({artifactId:qaId,candidateFingerprint:fingerprint,diagnostic:`${'9'.repeat(64)}${qaId}`});
    const finding=`Artifact ${qaId} binds candidate ${candidateId}, commit ${commitSha}, fingerprint ${fingerprint}, and ${'0123456789abcdef'.repeat(4)}.`;
    const review=`Independent review ${qaId}: preserve candidate ${candidateId} and fingerprint ${fingerprint}.\nThe complete review reference remains visible.`;
    const qa={id:qaId,projectId:project.id,workId:work.id,runId:candidateId,kind:'qa' as const,revision,createdAt:'2026-10-06',data:{...fixture.data,candidateFingerprint:fingerprint,review,typedReview:{disposition:'approved',commitSha,findings:[{id:'expanded-finding',blocking:true,summary:finding}]},checks:[{name:commandName,command,exitCode:0,testedRevision:fingerprint,output}]} };
    const metadata=[diff,qa].map(({data,...item})=>item);
    vi.spyOn(workbenchApi,'artifact').mockImplementation(async id=>id===diff.id?diff:qa);
    await mount({...snapshot(),works:[work],runs:[candidate],artifacts:metadata as Snapshot['artifacts']} as Snapshot);await flush();
    const evidence=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent==='Evidence details')!;
    await flush(()=>{evidence.open=true;});
    const card=[...evidence.querySelectorAll('section')].find(item=>item.querySelector('strong')?.textContent==='Verification')!;
    const typed=[...card.querySelectorAll('section')].find(item=>item.querySelector('h3')?.textContent==='Typed review')!;
    const findingNode=[...typed.querySelectorAll('p')].find(item=>item.textContent===`Blocking · ${finding}`);
    expect(typed.textContent).toContain(finding);
    expect(findingNode,typed.innerHTML).toBeTruthy();
    expect(findingNode.textContent).toBe(`Blocking · ${finding}`);expect(findingNode.className).toContain('min-w-0');expect(findingNode.className).toContain('wrap-anywhere');
    expect(card.className).toContain('min-w-0');expect([...card.querySelectorAll('p')].some(item=>item.textContent===`Candidate · ${fingerprint}`)).toBe(true);
    const reviewNode=[...card.querySelectorAll('p')].find(item=>item.textContent===review)!;
    expect(reviewNode.textContent).toBe(review);expect(reviewNode.className).toContain('min-w-0');expect(reviewNode.className).toContain('wrap-anywhere');expect(reviewNode.className).toContain('whitespace-pre-wrap');
    const check=[...card.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes(commandName))!;
    const summary=check.querySelector('summary')!,label=summary.querySelector('span')!;
    expect(label.textContent).toBe(commandName);expect(summary.className).toContain('min-w-0');expect(label.className).toContain('min-w-0');expect(label.className).toContain('wrap-anywhere');
    await flush(()=>{check.open=true;});
    const commandNode=[...check.querySelectorAll('p')].find(item=>item.textContent===command)!;
    expect(commandNode.textContent).toBe(command);expect(commandNode.className).toContain('min-w-0');expect(commandNode.className).toContain('wrap-anywhere');
    const outputNode=check.querySelector('pre')!;
    expect(outputNode.textContent).toBe(output);expect(outputNode.className).toContain('overflow-auto');expect(outputNode.className).toContain('whitespace-pre-wrap');
    expect(card.textContent).toContain(qaId);expect(card.textContent).toContain(candidateId);expect(card.textContent).toContain(commitSha);expect(card.textContent).toContain(fingerprint);
  });
});
