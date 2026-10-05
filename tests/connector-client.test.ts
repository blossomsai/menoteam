import { expect, it, vi } from 'vitest';
import { WorkbenchConnectorClient } from '../src/connector/client.js';

const auth = { serverUrl: 'https://workbench.example.invalid', token: 'local-connector-token-'.padEnd(48, 'x') };

it('validates project-scoped Master tool results without treating them as Run records', async () => {
  const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({ work: { id: 'work-1' }, revision: 1 }), { status: 200 }));
  const client = new WorkbenchConnectorClient(auth, fetcher as typeof fetch);
  await expect(client.tool('run-1', 3, 'create_work', { title: 'Plan' }, 'stable-request-id')).resolves.toEqual({ work: { id: 'work-1' }, revision: 1 });
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
});

it('allows only HTTPS outside literal loopback HTTP', () => {
  expect(() => new WorkbenchConnectorClient({ ...auth, serverUrl: 'http://remote.example' })).toThrow(/HTTPS/u);
  expect(() => new WorkbenchConnectorClient({ ...auth, serverUrl: 'ftp://localhost' })).toThrow(/HTTPS/u);
  expect(() => new WorkbenchConnectorClient({ ...auth, serverUrl: 'http://localhost:3200' })).not.toThrow();
});
