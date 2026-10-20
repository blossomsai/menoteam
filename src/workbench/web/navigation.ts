import { useSyncExternalStore } from 'react';

const changed = 'workbench:url';
export function navigate(target: string, replace = false) {
  window.history[replace ? 'replaceState' : 'pushState'](null, '', target);
  window.dispatchEvent(new Event(changed));
}

function subscribe(notify: () => void) {
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || !anchor.hasAttribute('href') || anchor.hasAttribute('download') || anchor.target && anchor.target !== '_self') return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || !/^\/workbench(?:\/|$)/u.test(url.pathname)) return;
    event.preventDefault();
    navigate(`${url.pathname}${url.search}${url.hash}`);
  };
  window.addEventListener('popstate', notify);
  window.addEventListener(changed, notify);
  document.addEventListener('click', click);
  return () => {
    window.removeEventListener('popstate', notify);
    window.removeEventListener(changed, notify);
    document.removeEventListener('click', click);
  };
}
export function useWorkbenchUrl() {
  return useSyncExternalStore(subscribe, () => window.location.href);
}
