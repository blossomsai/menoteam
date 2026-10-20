// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Markdown } from '../src/workbench/web/Markdown';

it('renders established Markdown/GFM and rejects unsafe URLs and executable raw HTML in the real DOM', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Markdown, { children: '**bold** *emphasis* `inline`\n\n```ts\nconst long = "' + 'x'.repeat(500) + '"\n```\n\n| A | B |\n| - | - |\n| one | two |\n\n[safe](https://example.com/path) [js](javascript:alert%281%29) [data](data:text/html;base64,PHNjcmlwdD4=)\n\n<script>window.pwned=true</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">raw</a>' })));
    expect(host.querySelector('strong')?.textContent).toBe('bold');
    expect(host.querySelector('em')?.textContent).toBe('emphasis');
    expect(host.querySelector('pre code')?.textContent).toContain('const long');
    expect(host.querySelectorAll('td')).toHaveLength(2);
    expect(host.querySelector('a[href="https://example.com/path"]')).not.toBeNull();
    expect(host.querySelector('[href^="javascript:"], [href^="data:"], script, img, [onerror]')).toBeNull();
    expect([...host.querySelectorAll('a')].find(a => a.textContent === 'raw')).toBeUndefined();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
