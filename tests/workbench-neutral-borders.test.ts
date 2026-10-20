// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { Button } from '../src/local/web/src/components/ui/button';
import { ProviderConnections } from '../src/workbench/web/ProviderConnections';
import { ApiError, workbenchApi, type Snapshot } from '../src/workbench/web/api';

let css: string, host: HTMLDivElement, root: Root, style: HTMLStyleElement;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { compile } = createRequire(require.resolve('@tailwindcss/vite'))('@tailwindcss/node');
  const postcss = createRequire(require.resolve('vite'))('postcss');
  const compiler = await compile(await readFile('src/workbench/web/style.css', 'utf8'), { base: process.cwd() + '/src/workbench/web', onDependency: () => {} });
  const ast = postcss.parse(compiler.build(['border', 'border-border', 'border-input', 'border-primary', 'border-destructive', 'text-foreground']));
  // happy-dom does not implement cascade layers. Flatten the generated rules only
  // in this test renderer. This verifies computed token colors, not browser layout.
  ast.walkAtRules('layer', (rule: any) => rule.replaceWith(rule.nodes ?? []));
  ast.walkAtRules('property', (rule: any) => rule.remove());
  css = ast.toString();
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  style = document.createElement('style'); style.textContent = css; document.head.append(style);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  window.history.replaceState(null, '', '/workbench/');
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); style.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const border = (node: Element) => getComputedStyle(node).borderTopColor;
it('computes the auth form border from the neutral token', async () => {
  vi.spyOn(workbenchApi, 'me').mockRejectedValue(new ApiError('Sign in', 401));
  await act(async () => root.render(createElement(App)));
  expect(border(host.querySelector('form')!)).toBe('#e5e5e8');
});
it('computes profile list/form borders while NativeSelect retains border-input', async () => {
  const member = { id: 'owner', role: 'owner' as const, name: 'Owner', email: 'owner@example.test' };
  const snapshot: Snapshot = { member, projects: [], works: [], messages: [], runs: [], artifacts: [], runtimeProviders: [], settings: [{ id: 'profile', kind: 'profile', name: 'Luna', data: { model: 'gpt-6-luna' }, updatedAt: '' }] };
  window.history.replaceState(null, '', '/workbench/?view=agent-profiles');
  vi.spyOn(workbenchApi, 'me').mockResolvedValue(member);
  vi.spyOn(workbenchApi, 'snapshot').mockResolvedValue(snapshot);
  await act(async () => root.render(createElement(App)));
  expect(border(host.querySelector('form')!)).toBe('#e5e5e8');
  expect(border(host.querySelector('details')!.parentElement!)).toBe('#e5e5e8');
  expect(border(host.querySelector('select')!)).toBe('#dedfe2');
});
it('computes ProviderConnections neutral containers without overriding its input border', async () => {
  await act(async () => root.render(createElement(ProviderConnections, { settings: [], runtimes: [], canManage: true, refresh: async () => {}, setError: () => {} })));
  expect(border(host.querySelector('form')!)).toBe('#e5e5e8');
  expect(border(host.querySelector('section > p')!)).toBe('#e5e5e8');
  expect(border(host.querySelector('select')!)).toBe('#dedfe2');
});

it('computes outline border-input while preserving caller primary/destructive overrides and focus hooks', async () => {
  await act(async () => root.render(createElement('div', null,
    createElement(Button, { variant: 'outline' }, 'Outline'),
    createElement(Button, { variant: 'outline', className: 'border-primary' }, 'Primary override'),
    createElement(Button, { variant: 'outline', className: 'border-destructive' }, 'Destructive override'),
  )));
  const [outline, primary, destructive] = [...host.querySelectorAll('button')];
  expect(border(outline!)).toBe('#dedfe2');
  expect(border(primary!)).toBe('#454d40');
  expect(border(destructive!)).toBe('#b95651');
  expect(outline!.classList.contains('focus-visible:border-ring')).toBe(true);
  expect(outline!.classList.contains('aria-invalid:border-destructive')).toBe(true);
});
