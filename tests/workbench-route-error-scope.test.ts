// @vitest-environment happy-dom
import { act, createElement, startTransition, StrictMode, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { navigate } from '../src/workbench/web/navigation';
import { workbenchApi, type Snapshot } from '../src/workbench/web/api';

const suspended = vi.hoisted(() => ({ renders: 0, promise: new Promise<never>(() => {}) }));
// Only the speculative B page suspends. The actual App/Shell and committed A
// create-project request/error path remain mounted and unmocked.
vi.mock('../src/workbench/web/ProviderConnections', () => ({ ProviderConnections() {
  suspended.renders++;
  throw suspended.promise;
} }));
const member = { id: 'owner', name: 'Owner', email: 'owner@example.test', role: 'owner' as const };
const snapshot: Snapshot = { member, projects: [], works: [], runs: [], messages: [], artifacts: [], settings: [], runtimeProviders: [] };
let host: HTMLDivElement, root: Root;
const pending: Array<{ reject: (error: Error) => void }> = [];
async function flush(action: () => void = () => {}) { await act(async () => { action(); }); }
const tree = (strict = false) => createElement(Suspense, { fallback: 'Suspended B fallback' }, strict ? createElement(StrictMode, null, createElement(App)) : createElement(App));
async function submit() {
  const input = host.querySelector<HTMLInputElement>('#project-name')!;
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Project draft');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush(() => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  suspended.renders = 0; pending.length = 0;
  vi.spyOn(workbenchApi, 'me').mockResolvedValue(member);
  vi.spyOn(workbenchApi, 'snapshot').mockResolvedValue(snapshot);
  vi.spyOn(workbenchApi, 'createProject').mockImplementation(() => new Promise((_resolve, reject) => { pending.push({ reject }); }));
  window.history.replaceState(null, '', '/workbench/?view=connect');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await flush(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('accepts an error from committed A after a rendered, suspended B is discarded', async () => {
  await flush(() => root.render(tree()));
  await submit();
  const committedForm = host.querySelector('form')!;
  // Deliberately drive a parent concurrent render without a URL-store notification:
  // this gives React a speculative Shell B that can be abandoned before commit.
  window.history.replaceState(null, '', '/workbench/?view=model-providers');
  await flush(() => startTransition(() => root.render(tree())));
  expect(suspended.renders).toBeGreaterThan(0);
  expect(host.querySelector('form')).toBe(committedForm);
  expect(host.textContent).not.toContain('Suspended B fallback');
  window.history.replaceState(null, '', '/workbench/?view=connect');
  await flush(() => flushSync(() => root.render(tree())));
  expect(host.querySelector('form')).toBe(committedForm);
  await flush(() => pending[0]!.reject(new Error('Committed A error')));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Committed A error');
});

it.each([false, true])('rejects A1 errors after committed A→B→A3, accepts current A3 (StrictMode=%s)', async strict => {
  await flush(() => root.render(tree(strict)));
  await submit();
  await flush(() => navigate('/workbench/'));
  await flush(() => navigate('/workbench/?view=connect'));
  await submit();
  expect(pending).toHaveLength(2);
  await flush(() => pending[0]!.reject(new Error('Old A1 error')));
  expect(host.textContent).not.toContain('Old A1 error');
  await flush(() => pending[1]!.reject(new Error('Current A3 error')));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Current A3 error');
});

it('accepts current errors after initial StrictMode layout/effect replay', async () => {
  await flush(() => root.render(tree(true)));
  await submit();
  await flush(() => pending[0]!.reject(new Error('Current replayed scope error')));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Current replayed scope error');
});
