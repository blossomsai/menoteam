// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { workbenchApi, type Snapshot } from '../src/workbench/web/api';
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
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
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
    // Even a later, stale history page cannot overwrite the snapshot's copy.
    vi.mocked(workbenchApi.projectMessages).mockResolvedValueOnce({ messages: [message('existing'), message('oldest', { createdAt: '2019-01-01T00:00:00.000Z' })], nextBefore: null });
    await flush(() => older().click());
    expect(workbenchApi.projectMessages).toHaveBeenLastCalledWith(project.id, { before: 'page-3' });
    expect(host.textContent).toContain('snapshot wins');
    expect(host.textContent).toContain('oldest');
    expect(host.textContent).toContain('ancient');
    expect(host.querySelectorAll('article')).toHaveLength(4);
    expect(older()).toBeUndefined();
  });
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
