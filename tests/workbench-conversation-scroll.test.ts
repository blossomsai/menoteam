// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationScroll } from '../src/workbench/web/conversation-scroll';
import type { Message } from '../src/workbench/types';
const message = (id: string): Message => ({ id, projectId: 'project', role: 'agent', speaker: 'Codex', text: id, createdAt: id });
let host: HTMLDivElement, root: Root;
let state: 'loading' | 'loaded' | 'error', messages: Message[], height: number;
let resolveOlder: () => void;
let older: () => Promise<void>;
function Pane() {
  const [loading, setLoading] = useState(false);
  const scroll = useConversationScroll(messages, state, loading, async () => { setLoading(true); await older(); setLoading(false); });
  return createElement('div', { ref: scroll.ref, onScroll: scroll.onScroll, 'data-pane': '' },
    createElement('button', { onClick: scroll.loadOlder }, 'Earlier'),
    ...messages.map(m => createElement('article', { key: m.id, 'data-message-id': m.id }, m.text)));
}
async function render() { await act(async () => root.render(createElement(Pane))); }
function pane() { return host.querySelector<HTMLElement>('[data-pane]')!; }
async function scroll(top: number) { await act(async () => { pane().scrollTop = top; pane().dispatchEvent(new Event('scroll')); }); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  state = 'loading'; messages = [message('b'), message('c')]; height = 1000;
  older = () => new Promise<void>(r => { resolveOlder = r; });
  // Explicit simulated geometry: tests exercise mounted viewport logic, not browser layout.
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('waits for successful initial history, initializes once and follows incoming only near the bottom', async () => {
  await render(); expect(pane().scrollTop).toBe(0);
  state = 'error'; await render(); expect(pane().scrollTop).toBe(0);
  state = 'loading'; await render(); expect(pane().scrollTop).toBe(0);
  state = 'loaded'; await render(); expect(pane().scrollTop).toBe(1000);
  await scroll(100); height = 1200; messages = [...messages, message('d')]; await render();
  expect(pane().scrollTop).toBe(100);
  // Same data and tab/snapshot rerenders must not jump.
  messages = [...messages]; await render(); expect(pane().scrollTop).toBe(100);
  await scroll(980); height = 1400; messages = [...messages, message('e')]; await render();
  expect(pane().scrollTop).toBe(1400);
});
it('restores the visible message and its offset after prepending older history', async () => {
  state = 'loaded'; await render(); await scroll(100);
  let anchorTop = 20;
  vi.spyOn(pane(), 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
  const anchor = host.querySelector<HTMLElement>('[data-message-id="b"]')!;
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({ top: anchorTop, bottom: anchorTop + 100 }) as DOMRect);
  await act(async () => host.querySelector('button')!.click());
  expect(pane().scrollTop).toBe(100);
  await act(async () => { messages = [message('a'), ...messages]; height = 1300; anchorTop = 320; resolveOlder(); });
  expect(host.querySelector('[data-message-id="b"]')).toBe(anchor);
  expect(pane().scrollTop).toBe(400);
});
it('a different mounted scope starts at its own latest and a late older load cannot scroll it', async () => {
  state = 'loaded'; await render(); await scroll(123);
  await act(async () => host.querySelector('button')!.click());
  await act(async () => root.unmount());
  root = createRoot(host); state = 'loading'; height = 500; messages = [message('other')];
  await render(); expect(pane().scrollTop).toBe(0);
  await act(async () => resolveOlder()); expect(pane().scrollTop).toBe(0);
  state = 'loaded'; await render(); expect(pane().scrollTop).toBe(500);
});
