// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import App from '../src/workbench/web/App';
import { ApiError, workbenchApi, type Snapshot } from '../src/workbench/web/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const member = { id: 'owner', email: 'owner@example.test', name: 'Owner', role: 'owner' as const };
function snapshot(instructions: string, name = 'Project'): Snapshot {
  return { member, projects: [{ id: 'project', name, instructions, repositoryUrl: '', deliveryAuthorization: '', createdAt: '2026-10-06' }], works: [], messages: [], runs: [], artifacts: [], settings: [], runtimeProviders: [] };
}
function healthyStagingRun(id = 'stage-run', workId = 'work'): Snapshot['runs'][number] {
  return { id, projectId: 'project', workId, prompt: '', requestedBy: 'owner', kind: 'delivery', model: 'internal', reasoning: 'none', status: 'completed', generation: 1, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', operation: { action: 'deploy_staging', actorId: 'owner', candidateRunId: 'candidate', candidateRevision: 'revision', artifactRevision: 'revision', commitSha: 'a'.repeat(40), candidateFingerprint: 'b'.repeat(64), repositoryUrl: 'https://github.com/org/repo', baseRevision: 'c'.repeat(40), baseBranch: 'main', remoteBranch: 'codex/test', workTitle: 'Review delivery', changeSummary: 'staging change', qaStatus: 'current', phase: 'health_passed', targetId: 'stage-safe', imageDigest: `sha256:${'d'.repeat(64)}`, stagingReceipt: { operationId: id, targetId: 'stage-safe', phase: 'health_passed', deploymentId: 'deploy-2', commitSha: 'a'.repeat(40), imageDigest: `sha256:${'d'.repeat(64)}`, activeCommitSha: 'a'.repeat(40), activeImageDigest: `sha256:${'d'.repeat(64)}`, previousDeploymentId: 'deploy-1', previousImageDigest: `sha256:${'e'.repeat(64)}`, checkedAt: '2026-10-07T00:00:00.000Z' } } } as Snapshot['runs'][number];
}
function mergedRun(id: string, workId: string, commitSha: string, createdAt: string): Snapshot['runs'][number] {
  return { id, projectId: 'project', workId, prompt: '', requestedBy: 'owner', kind: 'delivery', model: 'internal', reasoning: 'none', status: 'completed', generation: 1, createdAt, updatedAt: createdAt, operation: { action: 'merge_pr', phase: 'merged', commitSha, external: { mergeSha: commitSha } } } as Snapshot['runs'][number];
}
function stoppedBuildRun(overrides: Partial<Snapshot['runs'][number]> = {}): Snapshot['runs'][number] {
  return { id: 'stopped-build', projectId: 'project', workId: 'work', prompt: '', requestedBy: 'owner', kind: 'delivery', model: 'internal', reasoning: 'none', status: 'failed', generation: 3, stoppedAt: '2026-10-07T00:02:00.000Z', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:02:00.000Z', operation: { ...stagingSnapshot().runs[0]!.operation!, action: 'deploy_staging', phase: 'build_discovery', targetId: 'stage-safe', sourceMergeRunId: 'merge-current', buildStatus: 'failed' } , ...overrides } as Snapshot['runs'][number];
}
function stagingSnapshot(): Snapshot {
  const value=snapshot('A'); value.member={...member,role:'admin'}; value.projects[0]!.repositoryUrl='https://github.com/org/repo'; value.projectRoles={project:'admin'};
  value.works=[{id:'work',projectId:'project',title:'Staging candidate',overview:'',status:'in_progress',revision:1,profileId:'',connectionId:'provider',sources:[],createdAt:'2026-10-07T00:00:00.000Z',updatedAt:'2026-10-07T00:00:00.000Z'}];
  value.runtimeProviders=[{provider:'openai',method:'codex-host',connectorId:'staging-connector',available:true,projectIds:['project'],deploymentTargets:['stage-safe'],deliveryActions:['deploy_staging','rollback_staging'],models:[],lastSeen:'2026-10-07T00:00:00.000Z'}];
  value.settings=[{id:'delivery',kind:'connection',projectId:'project',name:'GitHub delivery',data:{provider:'github',purpose:'delivery',url:'https://github.com/org/repo',enabled:true,allowStagingDeploy:true,stagingTargets:['stage-safe']},updatedAt:'2026-10-07T00:00:00.000Z'}];
  value.runs=[mergedRun('merge-current','work','a'.repeat(40),'2026-10-07T00:00:00.000Z')];
  return value;
}
let root: Root;
let host: HTMLDivElement;
let responses: Array<Promise<Snapshot>>;
let snapshotSpy: MockInstance<typeof workbenchApi.snapshot>;
async function flush(action: () => void = () => undefined) { await act(async () => { action(); }); }
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}: ${host.textContent}`);
  return found;
}
async function click(text: string) { await flush(() => button(text).click()); }
async function type(value: string, selector = 'textarea') {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await flush(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function draft() { return host.querySelector('textarea')?.value; }
async function poll() { await flush(() => vi.advanceTimersByTime(2_000)); }
async function mount() { await flush(() => root.render(createElement(App))); }
async function logout() {
  const control = host.querySelector<HTMLButtonElement>('aside > button')!;
  await flush(() => control.click());
}

it('delivery settings render only the supported merge method and save merge by default', async()=>{
  window.history.replaceState(null,'','/workbench/?view=connections&project=project');
  const value=snapshot('A');value.projects[0]!.repositoryUrl='https://github.com/org/repo';
  responses=[Promise.resolve(value)];
  const save=vi.spyOn(workbenchApi,'saveSetting').mockResolvedValue({id:'delivery',kind:'connection',projectId:'project',name:'GitHub delivery',data:{},updatedAt:''});
  await mount();
  const form=host.querySelector<HTMLInputElement>('#delivery-base-branch')!.closest('form')!;
  await flush(()=>form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const method=host.querySelector<HTMLSelectElement>('#delivery-merge-method')!;
  expect(method.disabled).toBe(true);expect(method.value).toBe('merge');
  expect([...method.options].map(option=>option.value)).toEqual(['merge']);
  await type('Menoteam CI','#delivery-required-checks');responses.push(Promise.resolve(value));
  await flush(()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({allowMergePr:true,mergeMethod:'merge',requiredChecks:['Menoteam CI']})}));
});

it('offers only fresh unambiguous project-granted staging targets and saves the selected policy',async()=>{
  window.history.replaceState(null,'','/workbench/?view=connections&project=project');
  const value=snapshot('A');value.projects[0]!.repositoryUrl='https://github.com/org/repo';
  value.runtimeProviders=[
    {provider:'openai',method:'codex-host',connectorId:'granted',available:true,projectIds:['project'],deploymentTargets:['stage-safe','stage-ambiguous'],deliveryActions:['deploy_staging','rollback_staging'],models:[],lastSeen:'2026-10-07T00:00:00.000Z'},
    {provider:'openai',method:'codex-host',connectorId:'duplicate',available:true,projectIds:['project'],deploymentTargets:['stage-ambiguous'],deliveryActions:['deploy_staging'],models:[],lastSeen:'2026-10-07T00:00:00.000Z'},
    {provider:'openai',method:'codex-host',connectorId:'outside',available:true,projectIds:['other-project'],deploymentTargets:['stage-secret'],deliveryActions:['deploy_staging'],models:[],lastSeen:'2026-10-07T00:00:00.000Z'},
    {provider:'openai',method:'codex-host',connectorId:'stale',available:false,projectIds:['project'],deploymentTargets:['stage-old'],deliveryActions:['deploy_staging'],models:[],lastSeen:'2020-01-01T00:00:00.000Z'},
  ];
  value.settings=[{id:'existing-delivery',kind:'connection',projectId:'project',name:'GitHub delivery',data:{provider:'github',url:'https://github.com/org/repo',purpose:'delivery',enabled:true,allowDraftPr:true,allowMergePr:false,allowStagingDeploy:false,stagingTargets:[]},updatedAt:'2026-10-07T00:00:00.000Z'}];
  responses=[Promise.resolve(value)];
  const update=vi.spyOn(workbenchApi,'updateSetting').mockResolvedValue(value.settings[0]!);
  await mount();
  expect(host.textContent).toContain('stage-safe');
  expect(host.textContent).not.toContain('stage-ambiguous');expect(host.textContent).not.toContain('stage-secret');expect(host.textContent).not.toContain('stage-old');
  await flush(()=>host.querySelector<HTMLInputElement>('#staging-target-stage-safe')!.click());
  await flush(()=>host.querySelector<HTMLInputElement>('#allow-staging')!.click());
  const form=host.querySelector<HTMLInputElement>('#delivery-base-branch')!.closest('form')!;
  responses.push(Promise.resolve(value));
  await flush(()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(update).toHaveBeenCalledWith('existing-delivery',expect.objectContaining({expectedUpdatedAt:'2026-10-07T00:00:00.000Z',data:expect.objectContaining({allowStagingDeploy:true,stagingTargets:['stage-safe']})}));
});

it('preserves a dirty settings draft and blocks saving against a newer same-setting version', async () => {
  window.history.replaceState(null, '', '/workbench/?view=connections&project=project');
  const initial = snapshot('A'); initial.projects[0]!.repositoryUrl = 'https://github.com/org/repo';
  initial.settings = [{ id: 'delivery', kind: 'connection', projectId: 'project', name: 'GitHub delivery', data: { provider: 'github', url: 'https://github.com/org/repo', purpose: 'delivery', baseBranch: 'main' }, updatedAt: 'v1' }];
  responses = [Promise.resolve(initial)];
  const update = vi.spyOn(workbenchApi, 'updateSetting');
  await mount();
  await type('feature/unsaved', '#delivery-base-branch');
  const latest = structuredClone(initial); latest.settings[0]!.data.baseBranch = 'release'; latest.settings[0]!.updatedAt = 'v2';
  responses.push(Promise.resolve(latest));
  await flush(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(host.querySelector<HTMLInputElement>('#delivery-base-branch')!.value).toBe('feature/unsaved');
  expect(host.textContent).toContain('Your unsaved changes are still here');
  expect(button('Save delivery settings').disabled).toBe(true);
  const form = host.querySelector<HTMLInputElement>('#delivery-base-branch')!.closest('form')!;
  await flush(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(update).not.toHaveBeenCalled();
  await click('Discard draft and load latest');
  expect(host.querySelector<HTMLInputElement>('#delivery-base-branch')!.value).toBe('release');
  expect(button('Save delivery settings').disabled).toBe(false);
});

it('rebinds delivery settings when switching projects', async () => {
  window.history.replaceState(null, '', '/workbench/?view=connections&project=project');
  const value = snapshot('A'); value.projects[0]!.repositoryUrl = 'https://github.com/org/a';
  value.projects.push({ id: 'project-b', name: 'Project B', instructions: '', repositoryUrl: 'https://github.com/org/b', deliveryAuthorization: '', createdAt: '2026-10-06' });
  value.settings = [
    { id: 'delivery-a', kind: 'connection', projectId: 'project', name: 'GitHub delivery', data: { provider: 'github', url: 'https://github.com/org/a', purpose: 'delivery', baseBranch: 'main' }, updatedAt: 'v1' },
    { id: 'delivery-b', kind: 'connection', projectId: 'project-b', name: 'GitHub delivery', data: { provider: 'github', url: 'https://github.com/org/b', purpose: 'delivery', baseBranch: 'trunk' }, updatedAt: 'v1' },
  ];
  responses = [Promise.resolve(value)];
  await mount();
  await type('unsaved-a', '#delivery-base-branch');
  await flush(() => { window.history.replaceState(null, '', '/workbench/?view=connections&project=project-b'); root.render(createElement(App)); });
  expect(host.querySelector<HTMLInputElement>('#delivery-base-branch')!.value).toBe('trunk');
  expect(host.textContent).not.toContain('unsaved-a');
});

it('shows the merged source for this Work, not a newer merge from another Work', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = snapshot('A'); value.projects[0]!.repositoryUrl = 'https://github.com/org/repo';
  value.works = [{ id: 'work', projectId: 'project', title: 'Current Work', overview: '', status: 'in_progress', revision: 1, profileId: '', connectionId: 'provider', sources: [], createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' }];
  value.runs = [mergedRun('this-merge', 'work', 'a'.repeat(40), '2026-10-07T00:00:00.000Z'), mergedRun('other-merge', 'other-work', 'b'.repeat(40), '2026-10-07T00:01:00.000Z')];
  responses = [Promise.resolve(value)];
  await mount();
  expect(host.textContent).toContain('Merged source · ' + 'a'.repeat(40));
  expect(host.textContent).not.toContain('b'.repeat(40));
});

it('rebases a delivery settings draft on the successful save before refreshing', async () => {
  window.history.replaceState(null, '', '/workbench/?view=connections&project=project');
  const initial = snapshot('A'); initial.projects[0]!.repositoryUrl = 'https://github.com/org/repo';
  const setting = { id: 'delivery', kind: 'connection' as const, projectId: 'project', name: 'GitHub delivery', data: { provider: 'github', url: 'https://github.com/org/repo', purpose: 'delivery', baseBranch: 'main' }, updatedAt: 'v1' };
  initial.settings = [setting]; responses = [Promise.resolve(initial)];
  const saved = { ...setting, data: { ...setting.data, baseBranch: 'feature/first' }, updatedAt: 'v2' };
  const update = vi.spyOn(workbenchApi, 'updateSetting').mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, data: { ...saved.data, baseBranch: 'feature/second' }, updatedAt: 'v3' });
  await mount();
  await type('feature/first', '#delivery-base-branch');
  const form = host.querySelector<HTMLInputElement>('#delivery-base-branch')!.closest('form')!;
  const refreshed = structuredClone(initial); refreshed.settings[0] = saved;
  responses.push(Promise.resolve(refreshed));
  await flush(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(update).toHaveBeenNthCalledWith(1, 'delivery', expect.objectContaining({ expectedUpdatedAt: 'v1' }));
  expect(host.textContent).not.toContain('Your unsaved changes are still here');
  expect(button('Save delivery settings').disabled).toBe(false);
  await type('feature/second', '#delivery-base-branch');
  responses.push(Promise.resolve({ ...refreshed, settings: [{ ...saved, data: { ...saved.data, baseBranch: 'feature/second' }, updatedAt: 'v3' }] }));
  await flush(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(update).toHaveBeenNthCalledWith(2, 'delivery', expect.objectContaining({ expectedUpdatedAt: 'v2' }));
});

it('keeps edits made during save and marks them stale if a newer external version appears', async () => {
  window.history.replaceState(null, '', '/workbench/?view=connections&project=project');
  const initial = snapshot('A'); initial.projects[0]!.repositoryUrl = 'https://github.com/org/repo';
  const setting = { id: 'delivery', kind: 'connection' as const, projectId: 'project', name: 'GitHub delivery', data: { provider: 'github', url: 'https://github.com/org/repo', purpose: 'delivery', baseBranch: 'main' }, updatedAt: 'v1' };
  initial.settings = [setting]; responses = [Promise.resolve(initial)];
  const saved = deferred<typeof setting>(); const update = vi.spyOn(workbenchApi, 'updateSetting').mockReturnValue(saved.promise);
  await mount(); await type('feature/submitted', '#delivery-base-branch');
  const form = host.querySelector<HTMLInputElement>('#delivery-base-branch')!.closest('form')!;
  await flush(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await type('feature/kept-edit', '#delivery-base-branch');
  const external = { ...setting, data: { ...setting.data, baseBranch: 'external-change' }, updatedAt: 'v3' };
  const latest = structuredClone(initial); latest.settings[0] = external; responses.push(Promise.resolve(latest));
  saved.resolve({ ...setting, data: { ...setting.data, baseBranch: 'feature/submitted' }, updatedAt: 'v2' });
  await flush();
  expect(update).toHaveBeenCalledWith('delivery', expect.objectContaining({ expectedUpdatedAt: 'v1' }));
  expect(host.querySelector<HTMLInputElement>('#delivery-base-branch')!.value).toBe('feature/kept-edit');
  expect(host.textContent).toContain('Your unsaved changes are still here');
  expect(button('Save delivery settings').disabled).toBe(true);
});

it('shows a health receipt and offers rollback only when workspace and project roles allow it',async()=>{
  window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work');
  const value=snapshot('A');value.member={...member,role:'admin'};value.projects[0]!.repositoryUrl='https://github.com/org/repo';value.projectRoles={project:'admin'};
  value.works=[{id:'work',projectId:'project',title:'Review delivery',overview:'Check the staging receipt',status:'in_progress',revision:1,profileId:'',connectionId:'provider',sources:[],createdAt:'2026-10-07T00:00:00.000Z',updatedAt:'2026-10-07T00:00:00.000Z'}];
  value.providerConnections=[{id:'provider',name:'Codex',connectorId:'connector',enabled:true,default:true,status:'available',models:[],projectIds:['project']}];
  value.runtimeProviders=[{provider:'openai',method:'codex-host',connectorId:'stage-connector',available:true,projectIds:['project'],deploymentTargets:['stage-safe'],deliveryActions:['rollback_staging'],models:[],lastSeen:'2026-10-07T00:00:00.000Z'}];
  value.settings=[{id:'delivery',kind:'connection',projectId:'project',name:'GitHub delivery',data:{provider:'github',purpose:'delivery',url:'https://github.com/org/repo',allowStagingDeploy:true,stagingTargets:['stage-safe'],configuredBy:'owner'},updatedAt:'2026-10-07T00:00:00.000Z'}];
  value.runs=[healthyStagingRun()];
  responses=[Promise.resolve(value)];
  const rollback=vi.spyOn(workbenchApi,'requestStagingRollback').mockResolvedValue({operationId:'rollback-run',run:value.runs[0]!});
  await mount();
  expect(host.textContent).toContain('Health check passed');expect(host.textContent).toContain('does not confirm the user flow');expect(host.textContent).not.toContain('Verified');
  responses.push(Promise.resolve(value));
  await click('Roll back to previous verified version');
  expect(rollback).toHaveBeenCalledWith('work',{deploymentRunId:'stage-run',targetId:'stage-safe',requestId:expect.any(String)});
});

it('blocks rollback while another Work in the project has an unresolved run on the same target', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = snapshot('A'); value.member = { ...member, role: 'admin' }; value.projectRoles = { project: 'admin' };
  value.projects[0]!.repositoryUrl = 'https://github.com/org/repo';
  value.works = [{ id: 'work', projectId: 'project', title: 'Current Work', overview: '', status: 'in_progress', revision: 1, profileId: '', connectionId: 'provider', sources: [], createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' }];
  value.providerConnections = [{ id: 'provider', name: 'Codex', connectorId: 'connector', enabled: true, default: true, status: 'available', models: [], projectIds: ['project'] }];
  value.runtimeProviders = [{ provider: 'openai', method: 'codex-host', connectorId: 'stage-connector', available: true, projectIds: ['project'], deploymentTargets: ['stage-safe'], deliveryActions: ['rollback_staging'], models: [], lastSeen: '2026-10-07T00:00:00.000Z' }];
  value.settings = [{ id: 'delivery', kind: 'connection', projectId: 'project', name: 'GitHub delivery', data: { provider: 'github', purpose: 'delivery', url: 'https://github.com/org/repo', allowStagingDeploy: true, stagingTargets: ['stage-safe'] }, updatedAt: '2026-10-07T00:00:00.000Z' }];
  const current = healthyStagingRun();
  const other = { ...healthyStagingRun('other-stage-run', 'other-work'), status: 'queued' as const, createdAt: '2026-10-07T00:01:00.000Z', operation: { ...healthyStagingRun('other-stage-run', 'other-work').operation!, phase: 'queued', stagingReceipt: undefined } } as Snapshot['runs'][number];
  value.runs = [current, other];
  responses = [Promise.resolve(value)];
  const rollback = vi.spyOn(workbenchApi, 'requestStagingRollback');
  await mount();
  expect(host.textContent).toContain('Health check passed');
  expect(host.textContent).not.toContain('Roll back to previous verified version');
  expect(rollback).not.toHaveBeenCalled();
});

it('keeps the last healthy deployment rollback available after a later build attempt is released', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = snapshot('A'); value.member = { ...member, role: 'admin' }; value.projectRoles = { project: 'admin' };
  value.projects[0]!.repositoryUrl = 'https://github.com/org/repo';
  value.works = [{ id: 'work', projectId: 'project', title: 'Current Work', overview: '', status: 'in_progress', revision: 1, profileId: '', connectionId: 'provider', sources: [], createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' }];
  value.providerConnections = [{ id: 'provider', name: 'Codex', connectorId: 'connector', enabled: true, default: true, status: 'available', models: [], projectIds: ['project'] }];
  value.runtimeProviders = [{ provider: 'openai', method: 'codex-host', connectorId: 'stage-connector', available: true, projectIds: ['project'], deploymentTargets: ['stage-safe'], deliveryActions: ['rollback_staging'], models: [], lastSeen: '2026-10-07T00:00:00.000Z' }];
  value.settings = [{ id: 'delivery', kind: 'connection', projectId: 'project', name: 'GitHub delivery', data: { provider: 'github', purpose: 'delivery', url: 'https://github.com/org/repo', allowStagingDeploy: true, stagingTargets: ['stage-safe'] }, updatedAt: '2026-10-07T00:00:00.000Z' }];
  const healthy = healthyStagingRun('healthy-a', 'work');
  const retired = stoppedBuildRun({ id: 'released-b', generation: 4, createdAt: '2026-10-07T00:02:00.000Z', operation: { ...stoppedBuildRun().operation!, stagingRetired: { at: '2026-10-07T00:03:00.000Z', by: 'owner', generation: 3 } } });
  value.runs = [healthy, retired]; responses = [Promise.resolve(value)];
  const rollback = vi.spyOn(workbenchApi, 'requestStagingRollback').mockResolvedValue({ operationId: 'rollback', run: healthy });
  await mount();
  expect(host.textContent).toContain('Health check passed');
  expect(host.textContent).toContain('Stopped · Target released');
  expect(host.textContent).toContain('Roll back to previous verified version');
  expect(button('Roll back to previous verified version').disabled).toBe(false);
  expect(rollback).not.toHaveBeenCalled();
});

it('keeps the prior deployment rollback blocked while a later target outcome is unknown', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = snapshot('A'); value.member = { ...member, role: 'admin' }; value.projectRoles = { project: 'admin' };
  value.projects[0]!.repositoryUrl = 'https://github.com/org/repo';
  value.works = [{ id: 'work', projectId: 'project', title: 'Current Work', overview: '', status: 'in_progress', revision: 1, profileId: '', connectionId: 'provider', sources: [], createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' }];
  value.providerConnections = [{ id: 'provider', name: 'Codex', connectorId: 'connector', enabled: true, default: true, status: 'available', models: [], projectIds: ['project'] }];
  value.runtimeProviders = [{ provider: 'openai', method: 'codex-host', connectorId: 'stage-connector', available: true, projectIds: ['project'], deploymentTargets: ['stage-safe'], deliveryActions: ['rollback_staging'], models: [], lastSeen: '2026-10-07T00:00:00.000Z' }];
  value.settings = [{ id: 'delivery', kind: 'connection', projectId: 'project', name: 'GitHub delivery', data: { provider: 'github', purpose: 'delivery', url: 'https://github.com/org/repo', allowStagingDeploy: true, stagingTargets: ['stage-safe'] }, updatedAt: '2026-10-07T00:00:00.000Z' }];
  const healthy = healthyStagingRun('healthy-a', 'work');
  const unknown = { ...healthyStagingRun('unknown-b', 'other-work'), status: 'failed' as const, createdAt: '2026-10-06T23:59:00.000Z', operation: { ...healthyStagingRun('unknown-b', 'other-work').operation!, phase: 'deploy_unknown', stagingReceipt: { ...healthyStagingRun('unknown-b', 'other-work').operation!.stagingReceipt!, phase: 'unknown' } } } as Snapshot['runs'][number];
  value.runs = [healthy, unknown]; responses = [Promise.resolve(value)];
  const rollback = vi.spyOn(workbenchApi, 'requestStagingRollback');
  await mount();
  expect(host.textContent).toContain('Health check passed');
  expect(button('Roll back to previous verified version').disabled).toBe(true);
  expect(rollback).not.toHaveBeenCalled();
});

it.each([
  { workspaceRole: 'member' as const, projectRole: 'admin' as const, allowed: false },
  { workspaceRole: 'admin' as const, projectRole: 'member' as const, allowed: false },
  { workspaceRole: 'owner' as const, projectRole: 'member' as const, allowed: true },
])('matches rollback visibility for workspace $workspaceRole with project $projectRole', async ({ workspaceRole, projectRole, allowed }) => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = snapshot('A'); value.member = { ...member, role: workspaceRole }; value.projectRoles = { project: projectRole };
  value.projects[0]!.repositoryUrl = 'https://github.com/org/repo';
  value.works = [{ id: 'work', projectId: 'project', title: 'Restricted Work', overview: '', status: 'in_progress', revision: 1, profileId: '', connectionId: 'provider', sources: [], createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' }];
  value.providerConnections = [{ id: 'provider', name: 'Codex', connectorId: 'connector', enabled: true, default: true, status: 'available', models: [], projectIds: ['project'] }];
  value.runtimeProviders = [{ provider: 'openai', method: 'codex-host', connectorId: 'stage-connector', available: true, projectIds: ['project'], deploymentTargets: ['stage-safe'], deliveryActions: ['rollback_staging'], models: [], lastSeen: '2026-10-07T00:00:00.000Z' }];
  value.settings = [{ id: 'delivery', kind: 'connection', projectId: 'project', name: 'GitHub delivery', data: { provider: 'github', purpose: 'delivery', url: 'https://github.com/org/repo', allowStagingDeploy: true, stagingTargets: ['stage-safe'] }, updatedAt: '2026-10-07T00:00:00.000Z' }];
  value.runs = [healthyStagingRun()];
  responses = [Promise.resolve(value)];
  const rollback = vi.spyOn(workbenchApi, 'requestStagingRollback');
  await mount();
  expect(host.textContent).toContain('Health check passed');
  expect(host.textContent.includes('Roll back to previous verified version')).toBe(allowed);
  if (!allowed) expect(host.textContent).toContain('An authorized administrator can request a rollback');
  expect(rollback).not.toHaveBeenCalled();
});

it('keeps staging unknown and reserved without presenting rollback as a successful action',async()=>{
  window.history.replaceState(null,'','/workbench/?view=work-detail&project=project&work=work');
  const value=snapshot('A');value.projects[0]!.repositoryUrl='https://github.com/org/repo';value.projectRoles={project:'owner'};
  value.works=[{id:'work',projectId:'project',title:'Unknown staging result',overview:'',status:'in_progress',revision:1,profileId:'',sources:[],createdAt:'2026-10-07T00:00:00.000Z',updatedAt:'2026-10-07T00:00:00.000Z'}];
  value.runs=[{id:'stage-unknown',projectId:'project',workId:'work',prompt:'',kind:'delivery',model:'internal',reasoning:'none',status:'failed',generation:1,createdAt:'2026-10-07T00:00:00.000Z',updatedAt:'2026-10-07T00:00:00.000Z',operation:{action:'deploy_staging',actorId:'owner',candidateRunId:'candidate',candidateRevision:'revision',artifactRevision:'revision',commitSha:'a'.repeat(40),candidateFingerprint:'b'.repeat(64),repositoryUrl:'https://github.com/org/repo',baseRevision:'c'.repeat(40),baseBranch:'main',remoteBranch:'codex/test',workTitle:'Unknown staging result',changeSummary:'staging change',qaStatus:'current',phase:'deploy_unknown',effectIntentGeneration:1,targetId:'stage-safe',imageDigest:`sha256:${'d'.repeat(64)}`,stagingReceipt:{operationId:'stage-unknown',targetId:'stage-safe',phase:'unknown',commitSha:'a'.repeat(40),imageDigest:`sha256:${'d'.repeat(64)}`,checkedAt:'2026-10-07T00:00:00.000Z'}}} as Snapshot['runs'][number]];
  responses=[Promise.resolve(value)];
  const rollback=vi.spyOn(workbenchApi,'requestStagingRollback');
  await mount();
  expect(host.textContent).toContain('Outcome unknown');expect(host.textContent).toContain('target remains reserved');expect(host.textContent).not.toContain('Health check passed');expect(host.querySelector('button')?.textContent).not.toContain('Roll back');expect(rollback).not.toHaveBeenCalled();
});

it('releases only a stopped pre-effect build and keeps the retired run in history', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = stagingSnapshot(); value.member = { ...member, role: 'owner' }; delete value.projectRoles;
  const stopped = stoppedBuildRun(); value.runs.push(stopped);
  const after = structuredClone(value); const retired = after.runs.at(-1)!;
  retired.operation!.stagingRetired = { at: '2026-10-07T00:03:00.000Z', by: 'owner', generation: 3 };
  retired.generation = 4; retired.leaseUntil = undefined;
  responses = [Promise.resolve(value), Promise.resolve(after)];
  const release = vi.spyOn(workbenchApi, 'retireStagingDeployment').mockResolvedValue({ operationId: 'retire-op', run: retired });
  const deploy = vi.spyOn(workbenchApi, 'requestStagingDeployment');
  await mount();
  expect(host.textContent).toContain('Build failed');
  expect(host.textContent).toContain('Release target');
  await flush(() => { const target = host.querySelector<HTMLSelectElement>('#staging-target-work')!; target.value = 'stage-safe'; target.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('Release target');
  expect(release).toHaveBeenCalledWith('stopped-build', 3);
  expect(host.textContent).toContain('Stopped · Target released');
  expect(host.textContent).not.toContain('Health check passed');
  expect(host.querySelector<HTMLOptionElement>('#staging-target-work option[value="stage-safe"]')?.disabled).toBe(false);
  expect(button('Deploy to staging').disabled).toBe(true);
  expect(host.textContent).toContain('Merge a new source before trying again');
  expect(deploy).not.toHaveBeenCalled();
});

it.each(['cancelled', 'interrupted'] as const)('allows release after the Connector stopped a %s build', async status => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = stagingSnapshot(); value.runs.push(stoppedBuildRun({ status })); responses = [Promise.resolve(value)];
  await mount();
  expect(host.textContent).toContain('Release target');
});

it.each([
  { workspaceRole: 'owner' as const, projectRole: undefined, allowed: true },
  { workspaceRole: 'admin' as const, projectRole: 'admin' as const, allowed: true },
  { workspaceRole: 'admin' as const, projectRole: 'member' as const, allowed: false },
  { workspaceRole: 'member' as const, projectRole: 'owner' as const, allowed: false },
])('applies staging release permissions for workspace $workspaceRole and project $projectRole', async ({ workspaceRole, projectRole, allowed }) => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = stagingSnapshot(); value.member = { ...member, role: workspaceRole };
  value.projectRoles = projectRole ? { project: projectRole } : {};
  value.runs.push(stoppedBuildRun()); responses = [Promise.resolve(value)];
  await mount();
  expect(host.textContent.includes('Release target')).toBe(allowed);
});

it('makes a released target available to a different Work without reviving the old merge', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work-b');
  const value = stagingSnapshot();
  value.works.push({ ...value.works[0]!, id: 'work-b', title: 'New source' });
  value.runs.push(mergedRun('merge-b', 'work-b', 'f'.repeat(40), '2026-10-07T00:01:00.000Z'));
  const retired = stoppedBuildRun({ workId: 'work', generation: 4, operation: { ...stoppedBuildRun().operation!, stagingRetired: { at: '2026-10-07T00:03:00.000Z', by: 'owner', generation: 3 } } });
  value.runs.push(retired); responses = [Promise.resolve(value), Promise.resolve(value)];
  const deploy = vi.spyOn(workbenchApi, 'requestStagingDeployment').mockResolvedValue({ operationId: 'new-build', run: retired });
  await mount();
  const option = host.querySelector<HTMLOptionElement>('#staging-target-work-b option[value="stage-safe"]');
  expect(option?.disabled).toBe(false);
  await flush(() => { const target = host.querySelector<HTMLSelectElement>('#staging-target-work-b')!; target.value = 'stage-safe'; target.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('Deploy to staging');
  expect(deploy).toHaveBeenCalledWith('work-b', { sourceMergeRunId: 'merge-b', targetId: 'stage-safe', requestId: expect.any(String) });
});

it.each([
  { label: 'missing stop acknowledgement', status: 'interrupted' as const, stoppedAt: undefined, extra: {} },
  { label: 'remote effect intent', status: 'failed' as const, stoppedAt: '2026-10-07T00:02:00.000Z', extra: { effectIntentGeneration: 0 } },
  { label: 'transport started', status: 'failed' as const, stoppedAt: '2026-10-07T00:02:00.000Z', extra: { stagingEffectStage: 'transport_intent' as const } },
  { label: 'deployment receipt', status: 'failed' as const, stoppedAt: '2026-10-07T00:02:00.000Z', extra: { stagingReceipt: { operationId: 'o', targetId: 'stage-safe', phase: 'unknown' as const, commitSha: 'a'.repeat(40), imageDigest: `sha256:${'d'.repeat(64)}`, checkedAt: '2026-10-07T00:01:00.000Z' } } },
  { label: 'paused build', status: 'paused' as const, stoppedAt: '2026-10-07T00:02:00.000Z', extra: {} },
])('does not release a staging target with $label', async ({ status, stoppedAt, extra }) => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value = stagingSnapshot();
  value.runs.push(stoppedBuildRun({ status, stoppedAt, operation: { ...stoppedBuildRun().operation!, ...extra } }));
  responses = [Promise.resolve(value)];
  const release = vi.spyOn(workbenchApi, 'retireStagingDeployment');
  await mount();
  expect(host.textContent).not.toContain('Release target');
  expect(release).not.toHaveBeenCalled();
  if (!stoppedAt) expect(host.textContent).toContain('Waiting for the Connector to confirm it has stopped');
  expect(host.querySelector<HTMLOptionElement>('#staging-target-work option[value="stage-safe"]')?.disabled).toBe(true);
});

it('starts build discovery for the current merged Work without accepting a digest', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot(); responses=[Promise.resolve(value),Promise.resolve(value)];
  const deploy=vi.spyOn(workbenchApi,'requestStagingDeployment').mockResolvedValue({operationId:'build-operation',run:value.runs[0]!});
  await mount();
  expect(host.textContent).toContain('Merged source');
  const target=host.querySelector<HTMLSelectElement>('#staging-target-work')!;
  await flush(()=>{target.value='stage-safe';target.dispatchEvent(new Event('change',{bubbles:true}));});
  await click('Deploy to staging');
  expect(deploy).toHaveBeenCalledWith('work',{sourceMergeRunId:'merge-current',targetId:'stage-safe',requestId:expect.any(String)});
  expect(host.textContent).not.toContain('imageDigest');
});

it('does not expose staging mutation to a project member', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot();value.member={...member,role:'member'};value.projectRoles={project:'member'};responses=[Promise.resolve(value)];
  const deploy=vi.spyOn(workbenchApi,'requestStagingDeployment');
  await mount();
  expect(host.textContent).toContain('An authorized administrator can deploy this merged source to staging');
  expect(host.textContent).not.toContain('Deploy to staging');
  expect(deploy).not.toHaveBeenCalled();
});

it('does not offer a target reserved by another Work in the same project', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot();
  const active={...healthyStagingRun('other-work-stage','other-work'),status:'running' as const,operation:{...healthyStagingRun('other-work-stage','other-work').operation!,targetId:'stage-safe',phase:'deploy_intent'}} as Snapshot['runs'][number];
  value.runs=[...value.runs,active];responses=[Promise.resolve(value)];
  const deploy=vi.spyOn(workbenchApi,'requestStagingDeployment');
  await mount();
  const option=host.querySelector<HTMLOptionElement>('#staging-target-work option[value="stage-safe"]');
  expect(option?.disabled).toBe(true);
  expect(button('Deploy to staging').disabled).toBe(true);
  expect(deploy).not.toHaveBeenCalled();
});

it('offers retry only for the failed build-discovery operation for this merge', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot();
  const failed={...value.runs[0]!,id:'build-failed',status:'failed' as const,operation:{...value.runs[0]!.operation!,action:'deploy_staging' as const,phase:'build_discovery' as const,targetId:'stage-safe',sourceMergeRunId:'merge-current',buildStatus:'receipt_missing' as const}} as Snapshot['runs'][number];
  value.runs.push(failed);responses=[Promise.resolve(value),Promise.resolve(value)];
  const deploy=vi.spyOn(workbenchApi,'requestStagingDeployment').mockResolvedValue({operationId:'build-retry',run:failed});
  await mount();
  expect(host.textContent).toContain('Build receipt missing');
  await flush(()=>{const target=host.querySelector<HTMLSelectElement>('#staging-target-work')!;target.value='stage-safe';target.dispatchEvent(new Event('change',{bubbles:true}));});
  await click('Retry build');
  expect(deploy).toHaveBeenCalledWith('work',{sourceMergeRunId:'merge-current',targetId:'stage-safe',requestId:expect.any(String)});
});

it('keeps paused build discovery paused and does not expose a retry shortcut', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot();
  const paused={...value.runs[0]!,id:'build-paused',status:'paused' as const,operation:{...value.runs[0]!.operation!,action:'deploy_staging' as const,phase:'build_discovery' as const,targetId:'stage-safe',sourceMergeRunId:'merge-current',buildStatus:'failed' as const}} as Snapshot['runs'][number];
  value.runs.push(paused);responses=[Promise.resolve(value)];
  const deploy=vi.spyOn(workbenchApi,'requestStagingDeployment');
  await mount();
  expect(host.textContent).toContain('Paused');
  expect(button('Deploy to staging').disabled).toBe(true);
  expect(host.textContent).not.toContain('Retry build');
  expect(deploy).not.toHaveBeenCalled();
});

it('does not reuse a failed build reservation for a different merged source', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot();
  const failed={...value.runs[0]!,id:'old-build-failed',status:'failed' as const,operation:{...value.runs[0]!.operation!,action:'deploy_staging' as const,phase:'build_discovery' as const,targetId:'stage-safe',sourceMergeRunId:'merge-current',buildStatus:'failed' as const}} as Snapshot['runs'][number];
  value.runs.push(failed,mergedRun('merge-new','work','f'.repeat(40),'2026-10-07T00:01:00.000Z'));responses=[Promise.resolve(value)];
  const deploy=vi.spyOn(workbenchApi,'requestStagingDeployment');
  await mount();
  expect(host.textContent).toContain('f'.repeat(40));
  expect(host.querySelector<HTMLOptionElement>('#staging-target-work option[value="stage-safe"]')?.disabled).toBe(true);
  expect(host.textContent).not.toContain('Retry build');
  expect(deploy).not.toHaveBeenCalled();
});

it('keeps a target reserved after an uncertain delivery outcome', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot();
  const unknown={...healthyStagingRun('unknown-stage','other-work'),status:'failed' as const,operation:{...healthyStagingRun('unknown-stage','other-work').operation!,phase:'deploy_unknown',targetId:'stage-safe',stagingReceipt:{...healthyStagingRun('unknown-stage','other-work').operation!.stagingReceipt!,phase:'unknown'}}} as Snapshot['runs'][number];
  value.runs.push(unknown);responses=[Promise.resolve(value)];
  const deploy=vi.spyOn(workbenchApi,'requestStagingDeployment');
  await mount();
  expect(host.querySelector<HTMLOptionElement>('#staging-target-work option[value="stage-safe"]')?.disabled).toBe(true);
  expect(button('Deploy to staging').disabled).toBe(true);
  expect(host.textContent).toContain('stage-safe · in use');
  expect(deploy).not.toHaveBeenCalled();
});

it('shows build provenance as build-only status, never deployment success', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot();
  const buildRun={...value.runs[0]!,id:'build-run',status:'running' as const,operation:{...value.runs[0]!.operation!,action:'deploy_staging' as const,phase:'build_discovery' as const,targetId:'stage-safe',sourceMergeRunId:'merge-current',buildStatus:'verified' as const,imageDigest:`sha256:${'d'.repeat(64)}`,buildReceipt:{schemaVersion:1 as const,repository:'blossomsai/menoteam' as const,repositoryId:'repo-id',workflowPath:'.github/workflows/build-workbench-image.yml' as const,runId:101,runAttempt:1,artifactId:202,archiveDigest:'sha256:archive',artifactExpiresAt:'2026-10-08T00:00:00.000Z',sourceSha:'a'.repeat(40),imageRepository:'ghcr.io/blossomsai/menoteam-work-map' as const,imageDigest:`sha256:${'d'.repeat(64)}`,runUrl:'https://github.com/blossomsai/menoteam/actions/runs/101',verifiedAt:'2026-10-07T00:00:00.000Z',verifiedGeneration:1}}} as Snapshot['runs'][number];
  value.runs.push(buildRun);responses=[Promise.resolve(value)];
  await mount();
  expect(host.textContent).toContain('Build verified');
  expect(host.textContent).toContain('Build verification does not mean the application is deployed');
  expect(host.textContent).not.toContain('Health check passed');
  expect(host.textContent).toContain('Build archive digest');
});

it('keeps the verified build receipt visible after deployment begins', async () => {
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  const value=stagingSnapshot();
  const deploying={...value.runs[0]!,id:'deploying-run',status:'running' as const,operation:{...value.runs[0]!.operation!,action:'deploy_staging' as const,phase:'deploy_intent' as const,targetId:'stage-safe',sourceMergeRunId:'merge-current',buildStatus:'verified' as const,imageDigest:`sha256:${'d'.repeat(64)}`,buildReceipt:{schemaVersion:1 as const,repository:'blossomsai/menoteam' as const,repositoryId:'repo-id',workflowPath:'.github/workflows/build-workbench-image.yml' as const,runId:101,runAttempt:1,artifactId:202,archiveDigest:'sha256:archive',artifactExpiresAt:'2026-10-08T00:00:00.000Z',sourceSha:'a'.repeat(40),imageRepository:'ghcr.io/blossomsai/menoteam-work-map' as const,imageDigest:`sha256:${'d'.repeat(64)}`,runUrl:'https://github.com/blossomsai/menoteam/actions/runs/101',verifiedAt:'2026-10-07T00:00:00.000Z',verifiedGeneration:1}}} as Snapshot['runs'][number];
  value.runs.push(deploying);responses=[Promise.resolve(value)];
  await mount();
  expect(host.textContent).toContain('In progress');
  expect(host.textContent).toContain('Build verified for this source');
  expect(host.textContent).toContain('Build archive digest');
  expect(host.textContent).not.toContain('Health check passed');
});

it('sends only the source merge, selected target, and request id to staging', async () => {
  const response={run:stagingSnapshot().runs[0]!,operationId:'operation'};
  const fetchMock=vi.fn(async (_input:RequestInfo|URL,init?:RequestInit)=>new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}}));
  vi.stubGlobal('fetch',fetchMock);
  await workbenchApi.requestStagingDeployment('work',{sourceMergeRunId:'merge-current',targetId:'stage-safe',requestId:'request-1'});
  const init=fetchMock.mock.calls[0]?.[1] as RequestInit|undefined;
  expect(JSON.parse(String(init?.body))).toEqual({sourceMergeRunId:'merge-current',targetId:'stage-safe',requestId:'request-1'});
  expect(JSON.stringify(init?.body)).not.toContain('imageDigest');
});

it('sends the current run generation to the staging retirement endpoint', async () => {
  const response = { run: stoppedBuildRun(), operationId: 'retire-op' };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  await workbenchApi.retireStagingDeployment('run/with slash', 7);
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workbench/runs/run%2Fwith%20slash/staging/retire');
  expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ generation: 7 });
});
async function login() {
  await type(member.email, '#login-email');
  await type('password', '#login-password');
  await flush(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/workbench/?view=instructions&project=project');
  responses = [Promise.resolve(snapshot('A'))];
  snapshotSpy = vi.spyOn(workbenchApi, 'snapshot').mockImplementation(() => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected snapshot request');
    return response;
  });
  vi.spyOn(workbenchApi, 'me').mockResolvedValue(member);
  vi.spyOn(workbenchApi, 'login').mockResolvedValue({ authenticated: true });
  vi.spyOn(workbenchApi, 'logout').mockResolvedValue();
  vi.spyOn(workbenchApi, 'projectMessages').mockResolvedValue({ messages: [], nextBefore: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await flush(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('mounted App Instructions and session races', () => {
  it.each(['Use latest version', 'Keep editing my draft', 'Cancel'])('preserves typing after save and ignores a late stale poll before %s', async resolution => {
    const oldPoll = deferred<Snapshot>(); const refresh = deferred<Snapshot>(); const save = deferred<Snapshot['projects'][number]>();
    const update = vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(save.promise);
    await mount(); await click('Edit'); await type('B');
    responses.push(oldPoll.promise); await poll();
    await click('Save'); expect(update).toHaveBeenCalledWith('project', { instructions: 'B', expectedInstructions: 'A' });
    await type('C'); expect(draft()).toBe('C');
    responses.push(refresh.promise); await flush(() => save.resolve(snapshot('B').projects[0]!));
    await flush(() => refresh.resolve(snapshot('B')));
    expect(draft()).toBe('C'); expect(button('Save').disabled).toBe(false);
    await flush(() => oldPoll.resolve(snapshot('A')));
    expect(draft()).toBe('C'); expect(host.textContent).not.toContain('Instructions changed elsewhere.');
    // Another confirmed remote update exposes all three real resolution controls.
    responses.push(Promise.resolve(snapshot('D'))); await poll();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('D');
    await click(resolution);
    if (resolution === 'Cancel') {
      expect(draft()).toBeUndefined(); await click('Edit'); expect(draft()).toBe('D');
    } else if (resolution === 'Use latest version') {
      expect(draft()).toBe('D'); expect(button('Save').disabled).toBe(true);
    } else {
      expect(draft()).toBe('C'); expect(button('Save').disabled).toBe(false);
      vi.mocked(workbenchApi.updateProject).mockResolvedValue(snapshot('C').projects[0]!);
      responses.push(Promise.resolve(snapshot('C'))); await click('Save');
      expect(update).toHaveBeenLastCalledWith('project', { instructions: 'C', expectedInstructions: 'D' });
      expect(draft()).toBeUndefined();
    }
  });

  it('accepts a pending save refresh after a newer poll fails', async () => {
    const refresh = deferred<Snapshot>(); const failedPoll = deferred<Snapshot>(); const save = deferred<Snapshot['projects'][number]>();
    vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(save.promise);
    await mount(); await click('Edit'); await type('B'); await click('Save'); await type('C');
    responses.push(refresh.promise); await flush(() => save.resolve(snapshot('B').projects[0]!));
    responses.push(failedPoll.promise); await poll(); await flush(() => failedPoll.reject(new Error('poll unavailable')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('poll unavailable');
    await flush(() => refresh.resolve(snapshot('B')));
    expect(draft()).toBe('C'); expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('Instructions changed elsewhere.');
    await click('Cancel'); await click('Edit'); expect(draft()).toBe('B');
  });

  it('gates a queued poll and save refresh during logout, and isolates login from old responses', async () => {
    const oldPoll = deferred<Snapshot>(); const save = deferred<Snapshot['projects'][number]>(); const exiting = deferred<void>(); const entering = deferred<{ authenticated: true }>();
    vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(save.promise);
    vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); await click('Edit'); await type('B'); responses.push(oldPoll.promise); await poll(); await click('Save');
    await logout(); expect(host.textContent).toContain('Loading Menoteam');
    await poll(); await flush(() => save.resolve(snapshot('B').projects[0]!));
    expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await flush(() => exiting.resolve()); expect(host.textContent).toContain('Sign in to Menoteam');
    await login(); await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await flush(() => oldPoll.resolve(snapshot('OLD', 'Old session')));
    expect(host.textContent).toContain('Loading Menoteam'); expect(host.textContent).not.toContain('Old session');
    responses.push(Promise.resolve(snapshot('NEW', 'New session'))); await flush(() => entering.resolve({ authenticated: true }));
    expect(host.textContent).toContain('New session'); await click('Edit'); expect(draft()).toBe('NEW');
  });

  it('blocks an already queued ready timer callback synchronously at logout', async () => {
    const timers = vi.spyOn(window, 'setInterval'); const exiting = deferred<void>();
    vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    await mount();
    const queuedTick = timers.mock.calls.find(call => call[1] === 2_000)![0] as () => void;
    const logoutControl = host.querySelector<HTMLButtonElement>('aside > button')!;
    await flush(() => { logoutControl.click(); queuedTick(); });
    expect(snapshotSpy).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('Loading Menoteam');
    await flush(queuedTick); expect(snapshotSpy).toHaveBeenCalledTimes(1);
    await flush(() => exiting.resolve()); await flush(queuedTick);
    expect(snapshotSpy).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('Sign in to Menoteam');
    const entering = deferred<{ authenticated: true }>(); vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await login(); await flush(queuedTick); expect(snapshotSpy).toHaveBeenCalledTimes(1);
    responses.push(Promise.resolve(snapshot('NEW'))); await flush(() => entering.resolve({ authenticated: true }));
    await flush(queuedTick); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await click('Edit'); expect(draft()).toBe('NEW');
  });

  it('does not restore Instructions when an old response arrives while logout is pending', async () => {
    const oldPoll = deferred<Snapshot>(); const exiting = deferred<void>();
    vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    await mount(); responses.push(oldPoll.promise); await poll(); await logout();
    await flush(() => oldPoll.resolve(snapshot('OLD', 'Old session')));
    expect(host.textContent).toContain('Loading Menoteam'); expect(host.querySelector('aside')).toBeNull();
    await flush(() => exiting.resolve()); expect(host.textContent).toContain('Sign in to Menoteam');
  });

  it('does not launch an old save refresh after a new login has enabled requests', async () => {
    const save = deferred<Snapshot['projects'][number]>(); vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(save.promise);
    await mount(); await click('Edit'); await type('B'); await click('Save'); await logout();
    responses.push(Promise.resolve(snapshot('NEW'))); await login(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await flush(() => save.resolve(snapshot('B').projects[0]!)); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await click('Edit'); expect(draft()).toBe('NEW');
  });

  it('ignores a prelogout response arriving after the new login snapshot', async () => {
    const oldPoll = deferred<Snapshot>(); await mount(); responses.push(oldPoll.promise); await poll(); await logout();
    responses.push(Promise.resolve(snapshot('NEW'))); await login(); await click('Edit');
    await flush(() => oldPoll.resolve(snapshot('OLD'))); expect(draft()).toBe('NEW'); expect(host.textContent).not.toContain('Instructions changed elsewhere.');
  });

  it('expires the request generation on a 401 so a pending save refresh cannot restore the shell', async () => {
    const refresh = deferred<Snapshot>(); const unauthorized = deferred<Snapshot>();
    vi.spyOn(workbenchApi, 'updateProject').mockResolvedValue(snapshot('B').projects[0]!);
    await mount(); await click('Edit'); await type('B'); responses.push(refresh.promise); await click('Save');
    responses.push(unauthorized.promise); await poll(); await flush(() => unauthorized.reject(new ApiError('Session expired', 401)));
    expect(host.textContent).toContain('Sign in to Menoteam');
    await flush(() => refresh.resolve(snapshot('B'))); await poll();
    expect(host.textContent).toContain('Sign in to Menoteam'); expect(snapshotSpy).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('resumes polling after an authenticated invite account switch (snapshot retry: %s)', async retrySnapshot => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const timers = vi.spyOn(window, 'setInterval');
    const oldPoll = deferred<Snapshot>(); const entering = deferred<{ authenticated: true }>(); const newSnapshot = deferred<Snapshot>();
    const invited = { ...member, id: 'invited-owner', email: 'invited@example.test', name: 'Invited owner' };
    const invitedSnapshot = (instructions: string): Snapshot => ({ ...snapshot(instructions, 'Invited project'), member: invited });
    const accept = vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: invited.email });
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); expect(host.textContent).toContain('Join Menoteam');
    const oldTick = timers.mock.calls.find(call => call[1] === 2_000)![0] as () => void;
    responses.push(oldPoll.promise); await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await type(invited.name, '#invite-name'); await type('new-account-password', '#invite-password');
    await click('Accept invitation');
    expect(accept).toHaveBeenCalledWith({ token: 'valid-invite', name: invited.name, password: 'new-account-password' });
    expect(workbenchApi.login).toHaveBeenCalledWith(invited.email, 'new-account-password');
    await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    responses.push(newSnapshot.promise); await flush(() => entering.resolve({ authenticated: true }));
    expect(window.location.search).toBe(''); expect(snapshotSpy).toHaveBeenCalledTimes(3);
    // Open Instructions while B's first snapshot is in flight, as a direct project route.
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project');
    if (retrySnapshot) {
      await flush(() => newSnapshot.reject(new Error('snapshot network unavailable')));
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('snapshot network unavailable');
      responses.push(Promise.resolve(invitedSnapshot('B'))); await poll();
    } else {
      await flush(() => newSnapshot.resolve(invitedSnapshot('B')));
    }
    const acceptedRequests = retrySnapshot ? 4 : 3;
    expect(host.textContent).toContain('Invited owner'); await click('Edit'); await type('My unsaved B draft');
    await flush(oldTick); expect(snapshotSpy).toHaveBeenCalledTimes(acceptedRequests);
    await flush(() => oldPoll.resolve(snapshot('Late A', 'Old account project')));
    await flush(oldTick); expect(snapshotSpy).toHaveBeenCalledTimes(acceptedRequests);
    expect(host.textContent).not.toContain('Old account project'); expect(draft()).toBe('My unsaved B draft');
    expect(host.querySelector('[role="status"]')).toBeNull();
    responses.push(Promise.resolve(invitedSnapshot('Remote B revision'))); await poll();
    expect(snapshotSpy).toHaveBeenCalledTimes(acceptedRequests + 1);
    expect(draft()).toBe('My unsaved B draft');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Remote B revision');
    expect(host.textContent).toContain('Invited owner');
  });

  it.each(['poll', 'Retry'])('hides the prior account before recovering an invited account snapshot through %s', async recovery => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const accountA = { ...member, id: 'account-a', name: 'Private Account A' };
    const accountB = { ...member, id: 'account-b', name: 'Account B', email: 'account-b@example.test' };
    const privateA = { ...snapshot('Private A instructions', 'Private A project'), member: accountA };
    const publicB = { ...snapshot('B instructions', 'Account B project'), member: accountB };
    responses = [Promise.resolve(privateA)]; vi.mocked(workbenchApi.me).mockResolvedValue(accountA);
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: accountB.email });
    const timers = vi.spyOn(window, 'setInterval'); const oldPoll = deferred<Snapshot>();
    const entering = deferred<{ authenticated: true }>(); const firstB = deferred<Snapshot>(); const recoveredB = deferred<Snapshot>();
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); const oldTick = timers.mock.calls.find(call => call[1] === 2_000)![0] as () => void;
    responses.push(oldPoll.promise); await poll();
    await type(accountB.name, '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
    responses.push(firstB.promise); await flush(() => entering.resolve({ authenticated: true }));
    expect(workbenchApi.login).toHaveBeenCalledWith(accountB.email, 'new-account-password');
    const expectPrivateAAbsent = () => {
      expect(host.textContent).not.toContain(accountA.name); expect(host.textContent).not.toContain('Private A project');
      expect(host.textContent).not.toContain('Private A instructions'); expect(host.querySelector('aside')).toBeNull();
    };
    expectPrivateAAbsent(); expect(window.location.search).toBe('');
    await flush(() => firstB.reject(new Error('B snapshot unavailable')));
    expectPrivateAAbsent(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('B snapshot unavailable');
    expect(button('Retry').disabled).toBe(false);
    await flush(() => oldPoll.resolve(privateA)); await flush(oldTick);
    expect(snapshotSpy).toHaveBeenCalledTimes(3); expectPrivateAAbsent();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('B snapshot unavailable');
    const repeatedFailure = deferred<Snapshot>(); responses.push(repeatedFailure.promise); await click('Retry');
    await flush(() => repeatedFailure.reject(new Error('B snapshot still unavailable')));
    expectPrivateAAbsent(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('B snapshot still unavailable');
    responses.push(recoveredB.promise);
    if (recovery === 'poll') await poll(); else await click('Retry');
    expect(snapshotSpy).toHaveBeenCalledTimes(5); expectPrivateAAbsent();
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project');
    await flush(() => recoveredB.resolve(publicB));
    expect(host.textContent).toContain(accountB.name); expect(host.textContent).toContain('Account B project');
    expect(host.textContent).not.toContain('Private A'); expect(host.querySelector('[role="alert"]')).toBeNull();
    await click('Edit'); expect(draft()).toBe('B instructions');
  });

  it('accepts a new-account poll while the first invited snapshot is still pending', async () => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'account-b@example.test' });
    const firstB = deferred<Snapshot>(); await mount();
    await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password');
    responses.push(firstB.promise); await click('Accept invitation');
    const accountB = { ...member, id: 'account-b', name: 'Account B' };
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project');
    responses.push(Promise.resolve({ ...snapshot('Newer B'), member: accountB })); await poll();
    expect(host.textContent).toContain('Account B'); await click('Edit'); expect(draft()).toBe('Newer B');
    await flush(() => firstB.resolve({ ...snapshot('Older B'), member: accountB }));
    expect(draft()).toBe('Newer B'); expect(host.querySelector('[role="status"]')).toBeNull();
    await click('Cancel'); await click('Edit'); expect(draft()).toBe('Newer B');
  });

  it('keeps polling gated when login for an accepted invite fails', async () => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const timers = vi.spyOn(window, 'setInterval'); const entering = deferred<{ authenticated: true }>(); const oldPoll = deferred<Snapshot>();
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'invited@example.test' });
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); const oldTick = timers.mock.calls.find(call => call[1] === 2_000)![0] as () => void;
    responses.push(oldPoll.promise); await poll();
    await type('Invited owner', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
    await flush(() => entering.reject(new Error('login network unavailable')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('login network unavailable');
    await flush(oldTick); await poll(); await flush(() => oldPoll.resolve(snapshot('Late A')));
    expect(snapshotSpy).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('Sign in to Menoteam');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('login network unavailable');
  });

  it('permits Retry after successful login when its snapshot refresh fails', async () => {
    vi.mocked(workbenchApi.me).mockRejectedValue(new ApiError('Anonymous', 401));
    const failedRefresh = deferred<Snapshot>();
    await mount(); responses = [failedRefresh.promise]; await login();
    await flush(() => failedRefresh.reject(new Error('snapshot unavailable')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('snapshot unavailable');
    responses.push(Promise.resolve(snapshot('NEW'))); await click('Retry'); await click('Edit'); expect(draft()).toBe('NEW');
  });

  it.each(['success', '401', 'network'])('invalidates at pending invite acceptance before a late old poll %s', async outcome => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const accepting = deferred<{ accepted: true; email: string }>(); const oldPoll = deferred<Snapshot>();
    vi.spyOn(workbenchApi, 'acceptInvite').mockReturnValue(accepting.promise);
    await mount(); responses.push(oldPoll.promise); await poll();
    await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
    // Navigate away from the invite overlay to inspect the actual underlying App state.
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project'); await mount();
    expect(host.textContent).toContain('Loading Menoteam'); expect(host.querySelector('aside')).toBeNull();
    await flush(() => outcome === 'success' ? oldPoll.resolve(snapshot('Private A', 'Private A project')) : oldPoll.reject(outcome === '401' ? new ApiError('Old A expired', 401) : new Error('Old A network error')));
    await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Private A'); expect(host.textContent).not.toContain('Old A');
    expect(host.textContent).toContain('Loading Menoteam');
    responses.push(Promise.resolve({ ...snapshot('B instructions', 'B project'), member: { ...member, id: 'b', name: 'Account B' } }));
    await flush(() => accepting.resolve({ accepted: true, email: 'b@example.test' }));
    expect(host.textContent).toContain('Account B');
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project'); await mount();
    await click('Edit'); expect(draft()).toBe('B instructions');
  });

  it.each(['accept', 'login', 'logout'].flatMap(stage => ['401', 'network'].map(outcome => ({ stage, outcome }))))('clears pending $stage and permits recovery after $outcome failure', async ({ stage, outcome }) => {
    const failure = outcome === '401' ? new ApiError(`${stage} failed`, 401) : new Error(`${stage} failed`);
    if (stage !== 'logout') window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const accepting = deferred<{ accepted: true; email: string }>(); const entering = deferred<{ authenticated: true }>(); const exiting = deferred<void>();
    const accept = vi.spyOn(workbenchApi, 'acceptInvite').mockReturnValue(stage === 'accept' ? accepting.promise : Promise.resolve({ accepted: true, email: 'b@example.test' }));
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise); vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    await mount();
    if (stage === 'logout') await logout(); else { await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation'); }
    if (stage !== 'accept') expect(host.textContent).toContain('Loading Menoteam');
    expect(host.querySelector('aside')).toBeNull(); await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(1);
    await flush(() => stage === 'accept' ? accepting.reject(failure) : stage === 'login' ? entering.reject(failure) : exiting.reject(failure));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(`${stage} failed`); expect(host.querySelector('aside')).toBeNull();
    await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(1);
    responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } }));
    vi.mocked(workbenchApi.login).mockResolvedValue({ authenticated: true });
    if (stage === 'accept') { accept.mockResolvedValue({ accepted: true, email: 'b@example.test' }); await click('Accept invitation'); }
    else { expect(host.textContent).toContain('Sign in to Menoteam'); await login(); }
    expect(accept).toHaveBeenCalledTimes(stage === 'accept' ? 2 : stage === 'login' ? 1 : 0);
    expect(host.textContent).toContain('Account B'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['me', 'snapshot'].flatMap(stage => ['pending', 'ready'].flatMap(timing => ['success', '401', 'network'].map(outcome => ({ stage, timing, outcome })))))('ignores delayed initial $stage $outcome during new session $timing', async ({ stage, timing, outcome }) => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const initialMe = deferred<typeof member>(); const initialSnapshot = deferred<Snapshot>(); const accepting = deferred<{ accepted: true; email: string }>();
    if (stage === 'me') { vi.mocked(workbenchApi.me).mockReturnValue(initialMe.promise); responses = []; } else responses = [initialSnapshot.promise];
    vi.spyOn(workbenchApi, 'acceptInvite').mockReturnValue(accepting.promise);
    await mount(); await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
    const newAccount = { ...snapshot('B instructions', 'B project'), member: { ...member, id: 'b', name: 'Account B' } };
    if (timing === 'ready') { responses.push(Promise.resolve(newAccount)); await flush(() => accepting.resolve({ accepted: true, email: 'b@example.test' })); }
    await flush(() => {
      if (outcome !== 'success') (stage === 'me' ? initialMe : initialSnapshot).reject(outcome === '401' ? new ApiError('Old initial expired', 401) : new Error('Old initial unavailable'));
      else if (stage === 'me') initialMe.resolve(member); else initialSnapshot.resolve(snapshot('Private A', 'Private A project'));
    });
    expect(snapshotSpy).toHaveBeenCalledTimes((stage === 'snapshot' ? 1 : 0) + (timing === 'ready' ? 1 : 0));
    expect(host.textContent).not.toContain('Old initial'); expect(host.textContent).not.toContain('Private A');
    if (timing === 'pending') { responses.push(Promise.resolve(newAccount)); await flush(() => accepting.resolve({ accepted: true, email: 'b@example.test' })); }
    expect(host.textContent).toContain('Account B'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['401', 'network'])('recovers initial me failure %s through actual Try again', async outcome => {
    vi.mocked(workbenchApi.me).mockRejectedValueOnce(new Error('me unavailable'));
    await mount(); expect(host.textContent).toContain('me unavailable');
    const retryMe = deferred<typeof member>(); vi.mocked(workbenchApi.me).mockReturnValueOnce(retryMe.promise);
    await click('Try again'); expect(host.textContent).toContain('Loading Menoteam');
    await flush(() => retryMe.reject(outcome === '401' ? new ApiError('Session expired', 401) : new Error('me still unavailable')));
    if (outcome === '401') { expect(host.textContent).toContain('Sign in to Menoteam'); await login(); }
    else { expect(host.textContent).toContain('me still unavailable'); vi.mocked(workbenchApi.me).mockResolvedValue(member); await click('Try again'); }
    await click('Edit'); expect(draft()).toBe('A');
  });

  it('recovers repeated initial snapshot errors without another identity check', async () => {
    responses = [Promise.reject(new Error('initial snapshot unavailable'))]; await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('initial snapshot unavailable');
    responses.push(Promise.reject(new Error('snapshot retry unavailable'))); await click('Retry');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('snapshot retry unavailable');
    responses.push(Promise.resolve(snapshot('Recovered'))); await poll();
    expect(workbenchApi.me).toHaveBeenCalledTimes(1); await click('Edit'); expect(draft()).toBe('Recovered');
  });

  it('preserves a dirty Instructions draft across recoverable same-session snapshot errors', async () => {
    await mount(); await click('Edit'); await type('My dirty draft');
    responses.push(Promise.reject(new Error('poll unavailable'))); await poll();
    expect(draft()).toBe('My dirty draft'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('poll unavailable');
    responses.push(Promise.reject(new Error('retry unavailable'))); await click('Retry'); expect(draft()).toBe('My dirty draft');
    responses.push(Promise.resolve(snapshot('Remote revision'))); await poll();
    expect(draft()).toBe('My dirty draft'); expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Remote revision');
  });


  it.each(['accept', 'login', 'logout'].flatMap(stage => ['success', '401', 'network'].map(outcome => ({ stage, outcome }))))('ignores stale $stage $outcome completion after a newer invitation session', async ({ stage, outcome }) => {
    const oldAccept = deferred<{ accepted: true; email: string }>(); const oldLogin = deferred<{ authenticated: true }>(); const oldLogout = deferred<void>();
    const accept = vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'b@example.test' });
    if (stage === 'accept') accept.mockReturnValueOnce(oldAccept.promise);
    if (stage === 'login') vi.mocked(workbenchApi.login).mockReturnValueOnce(oldLogin.promise);
    if (stage === 'logout') vi.mocked(workbenchApi.logout).mockReturnValueOnce(oldLogout.promise);
    if (stage !== 'logout') window.history.replaceState(null, '', '/workbench/?invite=old-invite');
    await mount();
    if (stage === 'logout') await logout(); else { await type('Old invited account', '#invite-name'); await type('old-account-password', '#invite-password'); await click('Accept invitation'); }
    window.history.replaceState(null, '', '/workbench/?invite=new-invite'); await mount();
    await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password');
    responses.push(Promise.resolve({ ...snapshot('B instructions', 'B project'), member: { ...member, id: 'b', name: 'Account B' } }));
    await click('Accept invitation'); expect(host.textContent).toContain('Account B');
    const logins = vi.mocked(workbenchApi.login).mock.calls.length;
    await flush(() => {
      if (outcome !== 'success') (stage === 'accept' ? oldAccept : stage === 'login' ? oldLogin : oldLogout).reject(outcome === '401' ? new ApiError('Old operation expired', 401) : new Error('Old operation unavailable'));
      else if (stage === 'accept') oldAccept.resolve({ accepted: true, email: 'old@example.test' });
      else if (stage === 'login') oldLogin.resolve({ authenticated: true }); else oldLogout.resolve();
    });
    expect(host.textContent).toContain('Account B'); expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(snapshotSpy).toHaveBeenCalledTimes(2); expect(workbenchApi.login).toHaveBeenCalledTimes(logins);
  });

  it.each(['login pending', 'logout pending', 'new session'].flatMap(phase => ['success', '401', 'network'].map(outcome => ({ phase, outcome }))))('ignores old snapshot $outcome during $phase', async ({ phase, outcome }) => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const oldPoll = deferred<Snapshot>(); const entering = deferred<{ authenticated: true }>(); const exiting = deferred<void>();
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'b@example.test' });
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise); vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    await mount(); responses.push(oldPoll.promise); await poll();
    if (phase === 'logout pending') {
      window.history.replaceState(null, '', '/workbench/?view=instructions&project=project'); await mount(); await logout();
    } else {
      await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
      if (phase === 'new session') { responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } })); await flush(() => entering.resolve({ authenticated: true })); }
    }
    await flush(() => outcome === 'success' ? oldPoll.resolve(snapshot('Private A', 'Private A project')) : oldPoll.reject(outcome === '401' ? new ApiError('Old session expired', 401) : new Error('Old session unavailable')));
    expect(host.textContent).not.toContain('Private A'); expect(host.textContent).not.toContain('Old session');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(phase === 'new session' ? 'Account B' : 'Loading Menoteam');
  });

  it.each(['401', 'network'])('isolates a pending Retry %s catch from a replacement session', async outcome => {
    responses = [Promise.reject(new Error('initial snapshot unavailable'))]; await mount();
    const retry = deferred<Snapshot>(); responses.push(retry.promise); await click('Retry');
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite'); await mount();
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'b@example.test' });
    await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password');
    responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } })); await click('Accept invitation');
    await flush(() => retry.reject(outcome === '401' ? new ApiError('Old retry expired', 401) : new Error('Old retry unavailable')));
    expect(host.textContent).toContain('Account B'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });


  it.each(['login', 'snapshot'].flatMap(stage => ['401', 'network'].map(outcome => ({ stage, outcome }))))('recovers ordinary sign-in $stage $outcome failures without prior workspace data', async ({ stage, outcome }) => {
    vi.mocked(workbenchApi.me).mockRejectedValue(new ApiError('Anonymous', 401)); responses = [];
    const entering = deferred<{ authenticated: true }>(); const firstSnapshot = deferred<Snapshot>();
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); await login(); expect(host.textContent).toContain('Loading Menoteam'); expect(host.querySelector('aside')).toBeNull();
    const failure = outcome === '401' ? new ApiError('New account expired', 401) : new Error('New account unavailable');
    if (stage === 'login') await flush(() => entering.reject(failure));
    else { responses.push(firstSnapshot.promise); await flush(() => entering.resolve({ authenticated: true })); await flush(() => firstSnapshot.reject(failure)); }
    expect(host.querySelector('aside')).toBeNull();
    responses.push(Promise.resolve(snapshot('Recovered'))); vi.mocked(workbenchApi.login).mockResolvedValue({ authenticated: true });
    if (stage === 'snapshot' && outcome === 'network') await click('Retry'); else { expect(host.textContent).toContain('Sign in to Menoteam'); await login(); }
    await click('Edit'); expect(draft()).toBe('Recovered'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['success', '401', 'network'])('does not surface a detached Instructions save %s after a replacement session', async outcome => {
    const oldSave = deferred<Snapshot['projects'][number]>(); vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(oldSave.promise);
    await mount(); await click('Edit'); await type('Private dirty A'); await click('Save'); await logout();
    responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } })); await login();
    await click('Edit'); await type('B dirty draft');
    await flush(() => outcome === 'success' ? oldSave.resolve(snapshot('Private saved A').projects[0]!) : oldSave.reject(outcome === '401' ? new ApiError('Old save expired', 401) : new Error('Old save unavailable')));
    expect(snapshotSpy).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('Account B');
    expect(draft()).toBe('B dirty draft'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('resets the editor when a confirmed snapshot changes member identity', async () => {
    await mount(); await click('Edit'); await type('Private dirty A');
    responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } })); await poll();
    expect(host.textContent).toContain('Account B'); expect(draft()).toBeUndefined();
    await click('Edit'); expect(draft()).toBe('B instructions'); expect(host.querySelector('[role="status"]')).toBeNull();
  });

});
