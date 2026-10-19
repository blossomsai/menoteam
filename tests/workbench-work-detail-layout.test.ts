// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
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
    expect([...host.querySelectorAll('h1')].map(heading => heading.textContent)).not.toContain(work.title);
  });

  it('preserves the keyed Work conversation, scoped draft, message identity and usable composer', async () => {
    await act(async () => root.render(createElement(App)));

    expect(host.textContent).toContain(message.text);
    expect(host.querySelector('[aria-label="Work details"]')).not.toBeNull();
    const composer = host.querySelector<HTMLInputElement>(`input[aria-label="Message Agent"]`)!;
    expect(composer.value).toBe('Draft survives layout');
    expect(composer.className).toContain('min-w-0');
    expect(composer.className).toContain('flex-1');
    expect(host.querySelector('[aria-label="Send message"]')).not.toBeNull();
    expect(current.messages[0]?.id).toBe(message.id);
    expect(sessionStorage.getItem(`menoteam-workbench:draft:${member.id}:${project.id}:${work.id}`)).toBe('Draft survives layout');
  });
});
