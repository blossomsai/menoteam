// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { canAutoPoll, resetRateLimitCooldown, workbenchApi, type Snapshot } from '../src/workbench/web/api';
import type { Message } from '../src/workbench/types';

const member = { id: 'owner', name: 'Owner', email: 'owner@example.test', role: 'owner' as const };
const project = { id: 'project', name: 'Project', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: '' };
const work = { id: 'work', projectId: project.id, title: 'Work', overview: '', status: 'in_progress' as const, revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' };
const message = (id: string, overrides: Partial<Message> = {}): Message => ({ id, projectId: project.id, role: 'master', speaker: 'Master', text: id, createdAt: '2026-10-15T00:00:10.000Z', ...overrides });
const snapshot = (): Snapshot => ({ member, projects: [project], works: [work], messages: [], runs: [], artifacts: [], settings: [], runtimeProviders: [] });
type Page = Awaited<ReturnType<typeof workbenchApi.projectMessages>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let hidden = false;
let root: Root;
let host: HTMLDivElement;
async function flush(action: () => void = () => undefined) { await act(async () => { action(); }); }
async function tick(count = 1) { for (let i = 0; i < count; i++) await flush(() => { vi.advanceTimersByTime(2_000); }); }
async function render(route = '/workbench/?view=all') {
  window.history.replaceState(null, '', route);
  await flush(() => root.render(createElement(App)));
}
function older() { return [...host.querySelectorAll('button')].find(button => button.textContent === 'Load earlier messages')!; }

beforeEach(() => {
  resetRateLimitCooldown();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live fetch'); }));
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(workbenchApi, 'me').mockResolvedValue(member);
  vi.spyOn(workbenchApi, 'snapshot').mockResolvedValue(snapshot());
  vi.spyOn(workbenchApi, 'projectMessages').mockResolvedValue({ messages: [], nextBefore: null });
  sessionStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await flush(() => root.unmount()); host.remove();
  if (host.dataset.realApiTest !== 'true') expect(fetch).not.toHaveBeenCalled();
  resetRateLimitCooldown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares a real API 429 cooldown between snapshot and focused history pollers', async () => {
  host.dataset.realApiTest = 'true';
  const diff = { id: 'diff-cooldown', projectId: project.id, workId: work.id, runId: 'candidate-cooldown', kind: 'diff' as const, revision: 'revision-cooldown', createdAt: '', data: { candidateRevision: 'candidate-cooldown-sha', files: [], totalFiles: 0, truncated: false } };
  const diffMetadata = { ...diff, data: undefined };
  const candidate = { id: diff.runId, projectId: project.id, workId: work.id, kind: 'implementation' as const, prompt: '', model: 'gpt-6-luna', reasoning: 'medium' as const, status: 'completed' as const, generation: 1, createdAt: '', updatedAt: '' } as Snapshot['runs'][number];
  const reviewBinding={candidateRunId:diff.runId,commitSha:'candidate-cooldown-sha',candidateFingerprint:'a'.repeat(64),diffArtifactId:diff.id,diffRevision:diff.revision,qaArtifactIds:['qa-cooldown']};
  const review={id:'review-cooldown',projectId:project.id,workId:work.id,kind:'review' as const,prompt:'',model:'gpt-6.1-sol',reasoning:'medium' as const,status:'completed' as const,generation:1,createdAt:'',updatedAt:'',reviewBinding} as Snapshot['runs'][number];
  const qa={id:'qa-cooldown',projectId:project.id,workId:work.id,runId:review.id,kind:'qa' as const,revision:diff.revision,createdAt:'',data:{typedReview:{...reviewBinding,reviewerRunId:review.id,disposition:'approved',findings:[]}}};
  const qaMetadata={id:qa.id,projectId:qa.projectId,workId:qa.workId,runId:qa.runId,kind:qa.kind,revision:qa.revision,createdAt:qa.createdAt};
  const workSnapshot = { ...snapshot(), works: [work], messages: [message('snapshot retained', { workId: work.id })], runs: [candidate,review], artifacts: [diffMetadata,qaMetadata] };
  vi.spyOn(workbenchApi, 'me').mockRestore();
  vi.spyOn(workbenchApi, 'snapshot').mockRestore();
  vi.spyOn(workbenchApi, 'projectMessages').mockRestore();
  let snapshotCalls = 0, historyCalls = 0, artifactCalls = 0;
  let sendMessage: ReturnType<typeof vi.spyOn>;
  vi.spyOn(workbenchApi, 'artifact').mockRestore();
  sendMessage = vi.spyOn(workbenchApi, 'sendMessage');
  sessionStorage.setItem('menoteam-workbench:draft:owner:project:work', 'saved composer draft');
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); calls.push(path);
    if (path.endsWith('/me')) return Response.json(member);
    if (path.endsWith('/snapshot')) {
      snapshotCalls++;
      if (snapshotCalls === 2) return new Response(JSON.stringify({ message: 'Rate limited' }), { status: 429, headers: { 'Retry-After': '6' } });
      return Response.json(workSnapshot);
    }
    if (path.includes('/messages')) {
      historyCalls++;
      return Response.json({ messages: [message('retained history', { workId: work.id })], nextBefore: null });
    }
    if (path.includes('/artifacts/')) {
      artifactCalls++;
      return Response.json(path.includes(qa.id)?qa:diff);
    }
    throw new Error(`Unexpected API path ${path}`);
  }));
  await render(`/workbench/?view=work-detail&project=${project.id}&work=${work.id}&tab=qa`);
  await flush();
  expect(snapshotCalls).toBe(1);
  expect(historyCalls).toBe(1);
  expect(artifactCalls).toBe(2);
  expect(host.textContent).toContain('retained history');
  expect(host.textContent).toContain('candidate-cooldown-sha');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Message Agent"]')?.value).toBe('saved composer draft');
  await tick();
  expect(snapshotCalls).toBe(2);
  expect(canAutoPoll()).toBe(false);
  expect(host.textContent).toContain('Rate limited');
  const snapshotCount = snapshotCalls, historyCount = historyCalls;
  await tick(2);
  expect(snapshotCalls).toBe(snapshotCount);
  expect(historyCalls).toBe(historyCount);
  await tick();
  expect(snapshotCalls).toBe(snapshotCount + 1);
  expect(historyCalls).toBe(historyCount + 1);
  expect(canAutoPoll()).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('retained history');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Message Agent"]')?.value).toBe('saved composer draft');
  expect(host.textContent).toContain('candidate-cooldown-sha');
  expect(host.textContent).toContain('Current evidence');
  expect(artifactCalls).toBe(2);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(calls.filter(path => path.includes('/messages')).length).toBe(historyCalls);
});

describe('All projects polling budget', () => {
  it('mounts 15 paginated histories once and only polls snapshot for 62 seconds', async () => {
    const current = snapshot();
    current.projects = Array.from({ length: 15 }, (_, i) => ({ ...project, id: `project-${i}`, name: `Project ${i}` }));
    vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
    await render();
    expect(host.querySelectorAll('[aria-live="polite"]')).toHaveLength(15);
    expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(15);
    for (const item of current.projects) expect(workbenchApi.projectMessages).toHaveBeenCalledWith(item.id, {});
    expect(workbenchApi.snapshot).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 31; i++) {
      await tick();
      expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(15);
      expect(workbenchApi.snapshot).toHaveBeenCalledTimes(1 + i);
    }
  });

  it('merges new snapshot messages and same-ID updates over history while retaining older pages outside the global 500', async () => {
    vi.mocked(workbenchApi.projectMessages).mockResolvedValueOnce({ messages: [message('existing')], nextBefore: 'page-2' });
    await render();
    expect(host.textContent).toContain('existing');
    vi.mocked(workbenchApi.projectMessages).mockResolvedValueOnce({ messages: [message('ancient', { createdAt: '2020-01-01T00:00:00.000Z' })], nextBefore: 'page-3' });
    await flush(() => older().click());
    expect(workbenchApi.projectMessages).toHaveBeenLastCalledWith(project.id, { before: 'page-2' });
    const current = snapshot();
    current.messages = [message('existing', { text: 'snapshot wins' }), message('new snapshot message'),
      message('wrong work', { workId: work.id }), ...Array.from({ length: 497 }, (_, i) => message(`other-${i}`, { projectId: 'other' }))];
    expect(current.messages).toHaveLength(500);
    vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
    await tick();
    expect(host.textContent).toContain('snapshot wins');
    expect(host.textContent).toContain('new snapshot message');
    expect(host.textContent).toContain('ancient');
    expect(host.textContent).not.toContain('wrong work');
    expect(host.textContent).not.toContain('other-0');
    expect(host.querySelectorAll('article')).toHaveLength(3);
    // Other scopes can evict every message for this project from the global snapshot.
    vi.mocked(workbenchApi.snapshot).mockResolvedValue({ ...current, messages: Array.from({ length: 500 }, (_, i) => message(`evicting-${i}`, { projectId: 'other' })) });
    await tick();
    expect(host.textContent).toContain('snapshot wins');
    expect(host.textContent).toContain('new snapshot message');
    expect(host.textContent).toContain('ancient');
    expect(host.textContent).not.toContain('evicting-0');
    expect(host.querySelectorAll('article')).toHaveLength(3);
    expect(older().disabled).toBe(false);
    // Even a later, stale history page cannot overwrite the retained snapshot's copy.
    vi.mocked(workbenchApi.projectMessages).mockResolvedValueOnce({ messages: [message('existing'), message('oldest', { createdAt: '2019-01-01T00:00:00.000Z' })], nextBefore: null });
    await flush(() => older().click());
    expect(workbenchApi.projectMessages).toHaveBeenLastCalledWith(project.id, { before: 'page-3' });
    expect(host.textContent).toContain('snapshot wins');
    expect(host.textContent).toContain('new snapshot message');
    expect(host.textContent).toContain('oldest');
    expect(host.textContent).toContain('ancient');
    expect(host.querySelectorAll('article')).toHaveLength(4);
    expect(older()).toBeUndefined();
  });
});

it('keeps observed messages in their project cards through reorder and clears them on card removal', async () => {
  const otherProject = { ...project, id: 'other', name: 'Other' };
  const current = { ...snapshot(), projects: [project, otherProject], messages: [message('project private'), message('other private', { projectId: 'other' }), message('work private', { workId: work.id })] };
  vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
  await render();
  const card = (name: string) => host.querySelector(`[aria-label="${name} conversation"]`)!;
  expect(card('Project').textContent).toContain('project private');
  expect(card('Project').textContent).not.toContain('other private');
  expect(card('Project').textContent).not.toContain('work private');
  expect(card('Other').textContent).toContain('other private');
  expect(card('Other').textContent).not.toContain('project private');
  vi.mocked(workbenchApi.snapshot).mockResolvedValue({ ...current, projects: [otherProject, project], messages: [] });
  await tick();
  expect(card('Project').textContent).toContain('project private');
  expect(card('Other').textContent).toContain('other private');
  expect(card('Other').textContent).not.toContain('project private');
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(2);
  vi.mocked(workbenchApi.snapshot).mockResolvedValue({ ...current, projects: [otherProject], messages: [] });
  await tick();
  expect(host.textContent).not.toContain('project private');
  vi.mocked(workbenchApi.snapshot).mockResolvedValue({ ...current, messages: [] });
  await tick();
  expect(card('Project').textContent).not.toContain('project private');
  expect(card('Other').textContent).toContain('other private');
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(3);
});

it.each(['same member', 'different member'])('discards retained card messages across logout/login for %s and fences the old snapshot', async identity => {
  vi.spyOn(workbenchApi, 'logout').mockResolvedValue();
  vi.spyOn(workbenchApi, 'login').mockResolvedValue({ authenticated: true });
  vi.mocked(workbenchApi.projectMessages).mockResolvedValueOnce({ messages: [message('session history private')], nextBefore: null });
  vi.mocked(workbenchApi.snapshot).mockResolvedValue({ ...snapshot(), messages: [message('session snapshot private')] });
  await render();
  vi.mocked(workbenchApi.snapshot).mockResolvedValue(snapshot());
  await tick();
  expect(host.textContent).toContain('session history private');
  expect(host.textContent).toContain('session snapshot private');
  const oldSnapshot = deferred<Snapshot>();
  vi.mocked(workbenchApi.snapshot).mockReturnValueOnce(oldSnapshot.promise);
  await tick();
  await flush(() => host.querySelector<HTMLButtonElement>('aside > button')!.click());
  expect(host.textContent).not.toContain('session snapshot private');
  const nextMember = identity === 'same member' ? member : { ...member, id: 'next-member', name: 'Next member' };
  vi.mocked(workbenchApi.snapshot).mockResolvedValue({ ...snapshot(), member: nextMember });
  await flush(() => {
    for (const [selector, value] of [['#login-email', nextMember.email], ['#login-password', 'mock password']]) {
      const input = host.querySelector<HTMLInputElement>(selector!)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await flush(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(workbenchApi.login).toHaveBeenCalledExactlyOnceWith(nextMember.email, 'mock password');
  expect(host.querySelector('[aria-label="Project conversation"]')).not.toBeNull();
  await flush(() => oldSnapshot.resolve({ ...snapshot(), messages: [message('stale session snapshot private')] }));
  expect(host.querySelectorAll('article')).toHaveLength(0);
  expect(host.textContent).not.toContain('session snapshot private');
  expect(host.textContent).not.toContain('session history private');
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(2);
});

it.each(['master', 'work-detail'])('keeps one focused %s poll, guards slow initial/incremental requests and preserves cursor overlap', async view => {
  const pendingInitial = deferred<Page>();
  vi.mocked(workbenchApi.projectMessages).mockReturnValueOnce(pendingInitial.promise);
  const query = view === 'work-detail' ? { workId: work.id } : {};
  const route = `/workbench/?view=${view}&project=${project.id}${view === 'work-detail' ? `&work=${work.id}` : ''}`;
  await render(route);
  await tick(4);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(1);
  await flush(() => pendingInitial.resolve({ messages: [message('initial')], nextBefore: null }));
  const pendingPoll = deferred<Page>();
  vi.mocked(workbenchApi.projectMessages).mockReturnValueOnce(pendingPoll.promise);
  await tick();
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(2);
  expect(workbenchApi.projectMessages).toHaveBeenLastCalledWith(project.id, { ...query, after: '2026-10-15T00:00:08.000Z' });
  await tick(5);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(2);
  await flush(() => pendingPoll.resolve({ messages: [message('live update', { createdAt: '2026-10-15T00:00:20.000Z' })], nextBefore: null }));
  expect(host.textContent).toContain('live update');
  vi.mocked(workbenchApi.projectMessages).mockRejectedValueOnce(new Error('mock transport failure'));
  await tick();
  expect(workbenchApi.projectMessages).toHaveBeenLastCalledWith(project.id, { ...query, after: '2026-10-15T00:00:18.000Z' });
  await tick();
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(4);
});

it('pauses hidden interval requests, allows existing requests to settle, and resumes on the next visible tick', async () => {
  hidden = true;
  const initial = deferred<Page>();
  vi.mocked(workbenchApi.projectMessages).mockReturnValueOnce(initial.promise);
  await render('/workbench/?view=master&project=project');
  expect(workbenchApi.snapshot).toHaveBeenCalledTimes(1);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(1);
  await tick(3);
  expect(workbenchApi.snapshot).toHaveBeenCalledTimes(1);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(1);
  await flush(() => initial.resolve({ messages: [message('initial while hidden')], nextBefore: 'older' }));
  expect(host.textContent).toContain('initial while hidden');
  vi.mocked(workbenchApi.projectMessages).mockResolvedValueOnce({ messages: [message('manual while hidden')], nextBefore: null });
  await flush(() => older().click());
  expect(workbenchApi.projectMessages).toHaveBeenLastCalledWith(project.id, { before: 'older' });
  await tick(3);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(2);
  const pendingSnapshot = deferred<Snapshot>();
  const pendingPoll = deferred<Page>();
  vi.mocked(workbenchApi.snapshot).mockReturnValueOnce(pendingSnapshot.promise);
  vi.mocked(workbenchApi.projectMessages).mockReturnValueOnce(pendingPoll.promise);
  hidden = false;
  await tick(4);
  expect(workbenchApi.snapshot).toHaveBeenCalledTimes(2);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(3);
  hidden = true;
  await flush(() => { pendingSnapshot.resolve(snapshot()); pendingPoll.resolve({ messages: [message('in-flight while hidden')], nextBefore: null }); });
  expect(host.textContent).toContain('in-flight while hidden');
  await tick(4);
  expect(workbenchApi.snapshot).toHaveBeenCalledTimes(2);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(3);
  hidden = false;
  await tick();
  expect(workbenchApi.snapshot).toHaveBeenCalledTimes(3);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(4);
});

it.each(['initial', 'incremental', 'older'])('ignores stale %s history after switching conversation', async kind => {
  const pending = deferred<Page>();
  if (kind === 'initial') vi.mocked(workbenchApi.projectMessages).mockReturnValueOnce(pending.promise);
  else vi.mocked(workbenchApi.projectMessages).mockResolvedValueOnce({ messages: [message('old conversation')], nextBefore: 'old-cursor' });
  await render('/workbench/?view=master&project=project');
  if (kind !== 'initial') {
    vi.mocked(workbenchApi.projectMessages).mockReturnValueOnce(pending.promise);
    if (kind === 'incremental') await tick();
    else await flush(() => older().click());
  }
  vi.mocked(workbenchApi.projectMessages).mockResolvedValueOnce({ messages: [message('current conversation', { workId: work.id })], nextBefore: 'current-cursor' });
  await render('/workbench/?view=work-detail&project=project&work=work');
  await flush(() => pending.resolve({ messages: [message('STALE SECRET')], nextBefore: 'stale-cursor' }));
  expect(host.textContent).not.toContain('STALE SECRET');
  expect(host.textContent).not.toContain('old conversation');
  expect(host.textContent).toContain('current conversation');
  await flush(() => older().click());
  expect(workbenchApi.projectMessages).toHaveBeenLastCalledWith(project.id, { workId: work.id, before: 'current-cursor' });
});
