import { useLayoutEffect, useRef } from 'react';
import type { Message } from '../types';

// Each mounted conversation owns its viewport; no shared scroll or history cache.
export function useConversationScroll(messages: Message[], initialState: 'loading' | 'loaded' | 'error', loadingOlder: boolean, loadOlder: () => Promise<void>) {
  const ref = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const nearBottom = useRef(true);
  const previous = useRef<Message[]>([]);
  const olderAnchor = useRef<{ id?: string; offset: number; top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || initialState !== 'loaded') return;
    const changed = messages.length !== previous.current.length || messages.some((message, index) => message.id !== previous.current[index]?.id || message.text !== previous.current[index]?.text);
    if (!initialized.current) {
      pane.scrollTop = pane.scrollHeight;
      initialized.current = true;
    } else if (olderAnchor.current) {
      if (loadingOlder) return;
      const anchor = olderAnchor.current;
      const node = [...pane.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === anchor.id);
      pane.scrollTop = node ? pane.scrollTop + node.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.offset : anchor.top + pane.scrollHeight - anchor.height;
      olderAnchor.current = null;
    } else if (changed && nearBottom.current) {
      pane.scrollTop = pane.scrollHeight;
    }
    previous.current = messages;
  });
  const onScroll = () => {
    const pane = ref.current;
    if (pane) nearBottom.current = pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 64;
  };
  const earlier = async () => {
    const pane = ref.current;
    if (!pane || olderAnchor.current) return;
    const top = pane.getBoundingClientRect().top;
    const node = [...pane.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > top);
    olderAnchor.current = { id: node?.dataset.messageId, offset: node ? node.getBoundingClientRect().top - top : 0, top: pane.scrollTop, height: pane.scrollHeight };
    await loadOlder();
  };
  return { ref, onScroll, loadOlder: earlier };
}
