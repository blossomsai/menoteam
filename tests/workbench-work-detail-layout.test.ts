// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { navigate } from '../src/workbench/web/navigation';
import { workbenchApi, type Snapshot } from '../src/workbench/web/api';

const member = { id: 'member-layout', email: 'member@example.test', name: 'Morgan', role: 'member' as const };
const project = { id: 'project-layout', name: 'Project', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: '' };
const work = { id: 'work-layout', projectId: project.id, title: 'A readable Work title', overview: 'Work summary', status: 'in_progress' as const, revision: 4, profileId: '', sources: [], createdAt: '', updatedAt: '' };
const message = { id: 'stable-message', projectId: project.id, workId: work.id, speaker: 'Agent', role: 'agent' as const, text: 'Existing conversation stays mounted.', createdAt: '2026-10-19T02:00:00.000Z' };

let root: Root;
let host: HTMLDivElement;
let current: Snapshot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected live fetch in mounted UI test'))));
  sessionStorage.clear();
  sessionStorage.setItem(`menoteam-workbench:draft:${member.id}:${project.id}:${work.id}`, 'Draft survives layout');
  window.history.replaceState(null, '', `/workbench/?view=work-detail&project=${project.id}&work=${work.id}`);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  current = { member, projects: [project], works: [work], messages: [message], runs: [], artifacts: [], settings: [], runtimeProviders: [], providerConnections: [] };
  vi.spyOn(workbenchApi, 'me').mockResolvedValue(member);
  vi.spyOn(workbenchApi, 'snapshot').mockResolvedValue(current);
  vi.spyOn(workbenchApi, 'workEvidence').mockImplementation(async id=>({work:current.works.find(item=>item.id===id)!,messages:current.messages.filter(item=>item.workId===id),runs:current.runs.filter(item=>item.workId===id),artifacts:current.artifacts.filter(item=>item.workId===id)}));
  vi.spyOn(workbenchApi, 'projectMessages').mockResolvedValue({ messages: [message], nextBefore: null });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('mounted Work detail layout', () => {
  it('keeps stable desktop split and bounded stacked panes on mobile with token borders', async () => {
    await act(async () => root.render(createElement(App)));

    const layout = host.querySelector<HTMLElement>('[data-testid="work-detail-layout"]')!;
    expect(layout.className).toContain('xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]');
    expect(layout.className).toContain('min-w-0');
    const leftPane = host.querySelector('nav[aria-label="Work details"]')!.parentElement!;
    const rightPane = host.querySelector<HTMLElement>(`section[aria-label="${work.title} conversation"]`)!;
    expect(leftPane.className).toContain('max-h-[70dvh]');
    expect(leftPane.className).toContain('overflow-y-auto');
    expect(leftPane.className).toContain('border-border');
    expect(rightPane.className).toContain('overflow-hidden');
    expect(rightPane.className).toContain('xl:border-l');
    expect(rightPane.className).toContain('border-border');
    expect([...host.querySelectorAll('nav[aria-label="Work details"] a')].map(link => link.textContent)).toEqual(['overview', 'changes', 'QA']);
    const headings = [...host.querySelectorAll('h1')];
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(work.title);
    expect(host.querySelector('[aria-label="Breadcrumb"]')?.textContent).not.toContain(work.title);
  });

  it('preserves the keyed Work conversation, scoped draft, message identity and usable composer', async () => {
    await act(async () => root.render(createElement(App)));

    expect(host.textContent).toContain(message.text);
    expect(host.querySelector('[aria-label="Work details"]')).not.toBeNull();
    const composer = host.querySelector<HTMLInputElement>(`input[aria-label="Message Agent"]`)!;
    const existingMessage = [...host.querySelectorAll('article')].find(article => article.textContent?.includes(message.text));
    expect(existingMessage).toBeDefined();
    expect(composer.value).toBe('Draft survives layout');
    expect(composer.className).toContain('min-w-0');
    expect(composer.className).toContain('w-full');
    expect(host.querySelector('[aria-label="Send message"]')).not.toBeNull();
    expect(sessionStorage.getItem(`menoteam-workbench:draft:${member.id}:${project.id}:${work.id}`)).toBe('Draft survives layout');

    const laterMessage = { ...message, id: 'later-message', text: 'A later polled message.', createdAt: '2026-10-19T02:00:02.000Z' };
    vi.mocked(workbenchApi.snapshot).mockResolvedValue({ ...current, messages: [message, laterMessage] });
    vi.mocked(workbenchApi.projectMessages).mockResolvedValue({ messages: [message, laterMessage], nextBefore: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(host.textContent).toContain(laterMessage.text);
    expect([...host.querySelectorAll('article')].find(article => article.textContent?.includes(message.text))).toBe(existingMessage);
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="Message Agent"]`)).toBe(composer);
    expect(composer.value).toBe('Draft survives layout');
  });
});

it('switches tabs ten times with zero document/me/initial-history requests and preserves actual DOM, drafts and offset', async () => {
  await act(async () => root.render(createElement(App)));
  const documentRequests = vi.spyOn(window, 'fetch');
  const composer = host.querySelector<HTMLInputElement>('[aria-label="Message Agent"]')!;
  const messageNode = host.querySelector('article')!;
  const scroller = messageNode.parentElement!;
  scroller.scrollTop = 123;
  const edit = [...host.querySelectorAll('button')].find(b => b.textContent === 'Edit')!;
  await act(async () => edit.click());
  const input = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Unsaved overview');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (let i = 0; i < 10; i++) {
    const tab = ['changes', 'qa', 'overview'][i % 3];
    await act(async () => host.querySelector<HTMLAnchorElement>(`[aria-label="Work details"] a[href$="tab=${tab}"]`)!.click());
    expect(host.querySelector('[aria-label="Message Agent"]')).toBe(composer);
    expect(host.querySelector('article')).toBe(messageNode);
    expect(scroller.scrollTop).toBe(123);
  }
  await act(async () => navigate(`/workbench/?view=work-detail&project=${project.id}&work=${work.id}`));
  expect(host.querySelector('textarea')?.value).toBe('Unsaved overview');
  expect(workbenchApi.me).toHaveBeenCalledTimes(1);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(1);
  expect(documentRequests).not.toHaveBeenCalled();
  // Separately account for the unchanged normal two-second timers.
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(workbenchApi.snapshot).toHaveBeenCalledTimes(2);
  expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(2);
});

it('keeps search replace-only and renders URL filters on popstate, Back and Forward', async () => {
  window.history.replaceState(null, '', `/workbench/?view=work&project=${project.id}`);
  await act(async () => root.render(createElement(App)));
  const length = window.history.length;
  const search = host.querySelector<HTMLInputElement>('#work-search')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'missing');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(window.history.length).toBe(length);
  expect(new URL(window.location.href).searchParams.get('q')).toBe('missing');
  expect(host.textContent).toContain('No matching Work');
  await act(async () => navigate(`/workbench/?view=work&project=${project.id}&status=Done&q=title`));
  expect(host.querySelector<HTMLInputElement>('#work-search')?.value).toBe('title');
  await act(async () => { window.history.back(); await Promise.resolve(); });
  expect(host.querySelector<HTMLInputElement>('#work-search')?.value).toBe('missing');
  expect(new URL(window.location.href).searchParams.get('status')).toBeNull();
  await act(async () => { window.history.forward(); await Promise.resolve(); });
  expect(host.querySelector<HTMLInputElement>('#work-search')?.value).toBe('title');
  await act(async () => {
    window.history.replaceState(null, '', `/workbench/?view=work&project=${project.id}&status=Done&q=title`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(host.querySelector<HTMLInputElement>('#work-search')?.value).toBe('title');
  expect(host.querySelector('[aria-current="page"][href*="status=Done"]')).not.toBeNull();
});

it.each([
  { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 },
  { target: '_blank' }, { download: 'file' }, { href: 'https://example.com/workbench/' }, { href: '/elsewhere' },
  { href: '#run-existing' }, { href: `/workbench/?view=work-detail&project=${project.id}&work=${work.id}#run-existing` },
])('leaves native anchor behavior intact: %j', async variant => {
  await act(async () => root.render(createElement(App)));
  const anchor = document.createElement('a');
  anchor.href = 'href' in variant ? variant.href! : '/workbench/?view=work';
  if ('target' in variant) anchor.target = variant.target!;
  if ('download' in variant) anchor.download = variant.download!;
  host.append(anchor);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...variant });
  // Prevent native navigation after checking the workbench's document listener.
  let prevented = true;
  const observe = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
  window.addEventListener('click', observe, { once: true });
  await act(async () => anchor.dispatchEvent(event));
  expect(prevented).toBe(false);
});

it('keeps changed-query fragment links on the normal internal navigation path', async () => {
  await act(async () => root.render(createElement(App)));
  const composer = host.querySelector<HTMLInputElement>('[aria-label="Message Agent"]')!;
  const anchor = document.createElement('a');
  const target = `/workbench/?view=work-detail&project=${project.id}&work=${work.id}&tab=qa#evidence`;
  anchor.href = target;
  host.append(anchor);
  const pushState = vi.spyOn(window.history, 'pushState');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => anchor.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(pushState).toHaveBeenCalledExactlyOnceWith(null, '', target);
  expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(target);
  expect(host.querySelector('[aria-label="Message Agent"]')).toBe(composer);
  expect(composer.value).toBe('Draft survives layout');
});

it('shows latest implementation/handoff model separately from later review and frozen profile', async () => {
  const implementation = { id: 'impl', projectId: project.id, workId: work.id, kind: 'implementation' as const, model: 'gpt-6-luna', reasoning: 'medium' as const, status: 'completed' as const, generation: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', execution: { provider: 'openai' as const, method: 'codex-host' as const, model: 'gpt-6-luna', profile: { id: 'profile', name: 'Luna profile', data: { model: 'gpt-6-luna' } } } };
  const review = { ...implementation, id: 'review', kind: 'review' as const, model: 'gpt-6.1-sol', createdAt: '2026-01-03' };
  current = { ...current, runs: [implementation, review] };
  vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
  await act(async () => root.render(createElement(App)));
  const selection = () => [...host.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent === 'Execution selection')!;
  const value = (label: string) => [...selection().querySelectorAll('dt')].find(dt => dt.textContent === label)?.nextElementSibling?.textContent;
  expect(value('Model')).toBe('gpt-6-luna');
  const handoff = { ...implementation, id: 'handoff', model: 'gpt-6.1-sol', handoffFromRunId: 'impl', execution: { ...implementation.execution, model: 'gpt-6.1-sol' }, createdAt: '2026-01-02' };
  current={...current,runs:[implementation,handoff,review]};
  vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(value('Effective model')).toBe('gpt-6.1-sol');
  expect(value('Profile model')).toBe('gpt-6-luna · unchanged');
});

it('fences old Members errors even after leaving and returning to the same route', async () => {
  let rejectOld!: (error: Error) => void;
  let calls = 0;
  vi.spyOn(workbenchApi, 'projectMembers').mockImplementation(() => ++calls === 1 ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve({ members: [member] }));
  window.history.replaceState(null, '', `/workbench/?view=members&project=${project.id}`);
  await act(async () => root.render(createElement(App)));
  await act(async () => navigate(`/workbench/?view=work&project=${project.id}`));
  await act(async () => navigate(`/workbench/?view=members&project=${project.id}`));
  await act(async () => rejectOld(new Error('old page must not bleed')));
  expect(host.textContent).not.toContain('old page must not bleed');
});

it('isolates Work and settings local state across scope changes and ignores late Work saves', async () => {
  const other = { ...work, id: 'other', title: 'Other Work', overview: 'Other overview' };
  current = { ...current, works: [work, other] };
  vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
  let rejectSave!: (error: Error) => void;
  vi.spyOn(workbenchApi, 'updateWork').mockImplementation(() => new Promise((_r, reject) => { rejectSave = reject; }));
  await act(async () => root.render(createElement(App)));
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Edit')!.click());
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Save')!.click());
  await act(async () => navigate(`/workbench/?view=work-detail&project=${project.id}&work=other`));
  await act(async () => rejectSave(new Error('old save error')));
  expect(host.textContent).toContain('Other overview');
  expect(host.textContent).not.toContain('old save error');
  expect(host.querySelector('textarea')).toBeNull();
});

it('replaces consumed initial draft history so Back cannot revive the URL payload', async () => {
  // A controlled initial entry, followed by ordinary same-origin navigation.
  window.history.replaceState(null, '', `/workbench/?view=master&project=${project.id}&draft=One%20draft`);
  await act(async () => root.render(createElement(App)));
  expect(new URL(window.location.href).searchParams.has('draft')).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[aria-label="Message Master"]')?.value).toBe('One draft');
  await act(async () => navigate(`/workbench/?view=work&project=${project.id}`));
  await act(async () => { window.history.back(); await Promise.resolve(); });
  expect(new URL(window.location.href).searchParams.has('draft')).toBe(false);
  expect(new URL(window.location.href).searchParams.get('view')).toBe('master');
});

it('replaces consumed initial invite history so Back cannot revive its token', async () => {
  vi.spyOn(workbenchApi, 'joinInvite').mockResolvedValue({ accepted: true });
  window.history.replaceState(null, '', '/workbench/?invite=one-use-token');
  await act(async () => root.render(createElement(App)));
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(workbenchApi.joinInvite).toHaveBeenCalledWith('one-use-token');
  expect(new URL(window.location.href).searchParams.has('invite')).toBe(false);
  await act(async () => navigate(`/workbench/?view=work&project=${project.id}`));
  await act(async () => { window.history.back(); await Promise.resolve(); });
  expect(new URL(window.location.href).searchParams.has('invite')).toBe(false);
  expect(new URL(window.location.href).searchParams.get('view')).toBeNull();
  expect(host.textContent).not.toContain('Join Menoteam');
});

it('keys Settings by project/view and fences a prior project mutation error', async () => {
  const owner = { ...member, role: 'owner' as const };
  const other = { ...project, id: 'other-project', name: 'Other project' };
  current = { ...current, member: owner, projects: [project, other] };
  vi.mocked(workbenchApi.me).mockResolvedValue(owner);
  vi.mocked(workbenchApi.snapshot).mockResolvedValue(current);
  let rejectSave!: (error: Error) => void;
  vi.spyOn(workbenchApi, 'saveSetting').mockImplementation(() => new Promise((_r, reject) => { rejectSave = reject; }));
  window.history.replaceState(null, '', `/workbench/?view=skills&project=${project.id}`);
  await act(async () => root.render(createElement(App)));
  await act(async () => {
    for (const [selector, value] of [['#skill-name', 'Private project draft'], ['#skill-content', 'Instructions']]) {
      const node = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector!)!;
      const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await act(async () => host.querySelector('#skill-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(workbenchApi.saveSetting).toHaveBeenCalledTimes(1);
  await act(async () => navigate('/workbench/?view=skills&project=other-project'));
  expect(host.querySelector<HTMLInputElement>('#skill-name')?.value).toBe('');
  await act(async () => rejectSave(new Error('prior project mutation')));
  expect(host.textContent).not.toContain('prior project mutation');
  await act(async () => navigate('/workbench/?view=agent-profiles'));
  expect(host.querySelector<HTMLInputElement>('#profile-name')?.value).toBe('');
});
