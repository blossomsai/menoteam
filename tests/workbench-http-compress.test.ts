import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type { Sql } from 'postgres';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { registerWorkbenchAssets } from '../src/workbench/assets.js';

const decode = (encoding: string, bytes: Buffer) => encoding === 'br' ? brotliDecompressSync(bytes) : gunzipSync(bytes);

it('negotiates compressed Workbench JSON and static assets without changing their representation or cache contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-http-compress-'));
  const sql = (async () => []) as unknown as Sql;
  const snapshot = { runs: Array.from({ length: 100 }, (_, index) => ({ id: `run-${index}`, text: 'repeated snapshot content '.repeat(30) })) };
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, '.vite'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<html><body>'.concat('Workbench content '.repeat(100), '</body></html>'));
  await writeFile(join(root, 'assets', 'app-Ab_C-12z.js'), 'globalThis.workbench = "'.concat('asset-content '.repeat(500), '";'));
  await writeFile(join(root, 'assets', 'app-Ab_C-12z.css'), 'body { color: #123456; }\n'.repeat(100));
  await writeFile(join(root, '.vite', 'manifest.json'), JSON.stringify({ main: { file: 'assets/app-Ab_C-12z.js', css: ['assets/app-Ab_C-12z.css'] } }));
  const app = await createWorkbenchApp({ sql, registerAssets: instance => registerWorkbenchAssets(instance, root) });
  app.get('/api/workbench/compression-fixture', async (_request, reply) => reply.header('Vary', 'Origin').send(snapshot));
  app.get('/api/workbench/compression-small', async () => ({ ok: true }));
  app.post('/api/workbench/compression-request-body', async request => request.body);
  app.get('/api/workbench/compression-uncompressible', async (_request, reply) => reply.type('image/png').send(Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 73 + 19) % 256))));
  app.get('/api/workbench/compression-forbidden', async (_request, reply) => reply.code(403).send({ error: 'denied' }));
  app.get('/api/workbench/compression-limited', async (_request, reply) => reply.code(429).send({ error: 'limited' }));
  app.get('/api/workbench/compression-preencoded', async (_request, reply) => {
    const bytes = gzipSync(Buffer.from('already encoded bytes'));
    return reply.type('application/json').header('Content-Encoding', 'gzip').send(bytes);
  });
  app.get('/api/workbench/compression-events', async (_request, reply) => reply.type('text/event-stream').send('data: unchanged\n\n'));
  app.get('/api/workbench/compression-stream', async (_request, reply) => {
    reply.type('text/plain');
    return Readable.from(['first streamed chunk '.repeat(3000), 'second streamed chunk']);
  });
  try {
    const identity = await app.inject({ url: '/api/workbench/compression-fixture' });
    expect(identity.statusCode).toBe(200);
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.headers['cache-control']).toBe('no-store');
    expect(identity.json()).toEqual(snapshot);

    for (const encoding of ['gzip', 'br']) {
      const compressed = await app.inject({ url: '/api/workbench/compression-fixture', headers: { 'accept-encoding': encoding } });
      expect(compressed.statusCode).toBe(200);
      expect(compressed.headers['content-encoding']).toBe(encoding);
      expect(compressed.headers.vary).toMatch(/(?:^|,)\s*origin\s*,\s*accept-encoding\s*$/iu);
      expect(compressed.headers['cache-control']).toBe('no-store');
      const decoded = decode(encoding, compressed.rawPayload);
      expect(decoded.length).toBeGreaterThan(1024);
      expect(compressed.rawPayload.length).toBeLessThan(decoded.length);
      expect(JSON.parse(decoded.toString('utf8'))).toEqual(snapshot);
    }
    const weighted = await app.inject({ url: '/api/workbench/compression-fixture', headers: { 'accept-encoding': 'gzip;q=0.4, br;q=0.8' } });
    expect(weighted.headers['content-encoding']).toBe('br');
    expect(JSON.parse(brotliDecompressSync(weighted.rawPayload).toString('utf8'))).toEqual(snapshot);

    for (const headers of [
      { 'accept-encoding': 'gzip;q=0, br;q=0, identity;q=1' },
      { 'accept-encoding': 'gzip;q=0, br;q=0' },
      {}
    ]) {
      const response = await app.inject({ url: '/api/workbench/compression-fixture', headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.json()).toEqual(snapshot);
    }
    const small = await app.inject({ url: '/api/workbench/compression-small', headers: { 'accept-encoding': 'gzip, br' } });
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(small.json()).toEqual({ ok: true });
    const uncompressible = await app.inject({ url: '/api/workbench/compression-uncompressible', headers: { 'accept-encoding': 'gzip, br' } });
    expect(uncompressible.headers['content-encoding']).toBeUndefined();
    expect(uncompressible.rawPayload.length).toBe(2048);
    const encodedRequest = await app.inject({ method: 'POST', url: '/api/workbench/compression-request-body', headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' }, payload: gzipSync(Buffer.from('{"unchanged":true}')) });
    expect(encodedRequest.statusCode).toBe(400);

    for (const [url, status] of [['/api/workbench/me', 401], ['/api/workbench/compression-forbidden', 403], ['/api/workbench/compression-limited', 429]] as const) {
      const response = await app.inject({ url, headers: { 'accept-encoding': 'gzip' } });
      expect(response.statusCode).toBe(status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.json()).toHaveProperty('error');
    }

    const preencodedBytes = gzipSync(Buffer.from('already encoded bytes'));
    const preencoded = await app.inject({ url: '/api/workbench/compression-preencoded', headers: { 'accept-encoding': 'gzip' } });
    expect(preencoded.headers['content-encoding']).toBe('gzip');
    expect(preencoded.rawPayload.equals(preencodedBytes)).toBe(true);
    const eventStream = await app.inject({ url: '/api/workbench/compression-events', headers: { 'accept-encoding': 'gzip' } });
    expect(eventStream.headers['content-encoding']).toBeUndefined();
    expect(eventStream.body).toBe('data: unchanged\n\n');
    const streamed = await app.inject({ url: '/api/workbench/compression-stream', headers: { 'accept-encoding': 'gzip' } });
    expect(streamed.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(streamed.rawPayload).toString('utf8')).toBe('first streamed chunk '.repeat(3000) + 'second streamed chunk');

    for (const suffix of ['js', 'css']) {
      const url = `/workbench/assets/app-Ab_C-12z.${suffix}`;
      const identityAsset = await app.inject(url);
      const compressedAsset = await app.inject({ url, headers: { 'accept-encoding': 'br' } });
      expect(identityAsset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(compressedAsset.headers['content-encoding']).toBe('br');
      expect(compressedAsset.headers['cache-control']).toBe(identityAsset.headers['cache-control']);
      expect(compressedAsset.headers.etag).toMatch(/^W\//u);
      expect(brotliDecompressSync(compressedAsset.rawPayload).equals(identityAsset.rawPayload)).toBe(true);
      expect(compressedAsset.headers.vary).toMatch(/accept-encoding/iu);
      const identityConditional = await app.inject({ url, headers: { 'if-none-match': identityAsset.headers.etag! } });
      expect(identityConditional.statusCode).toBe(304);
      expect(identityConditional.body).toBe('');
      expect(identityConditional.headers['content-encoding']).toBeUndefined();
      const conditional = await app.inject({ url, headers: { 'accept-encoding': 'br', 'if-none-match': compressedAsset.headers.etag! } });
      expect(conditional.statusCode).toBe(304);
      expect(conditional.body).toBe('');
      expect(conditional.headers['content-encoding']).toBeUndefined();
      expect(conditional.headers.vary).toMatch(/accept-encoding/iu);
    }

    const html = await app.inject({ url: '/workbench/', headers: { 'accept-encoding': 'gzip' } });
    expect(html.headers['content-encoding']).toBe('gzip');
    expect(html.headers['cache-control']).toBe('no-cache');
    expect(gunzipSync(html.rawPayload).toString('utf8')).toContain('Workbench');
    const html304 = await app.inject({ url: '/workbench/', headers: { 'accept-encoding': 'gzip', 'if-none-match': html.headers.etag! } });
    expect(html304.statusCode).toBe(304);
    expect(html304.body).toBe('');
    expect(html304.headers['content-encoding']).toBeUndefined();
    expect((await app.inject({ url: '/workbench/assets/missing-a1b2c3d4.js', headers: { 'accept-encoding': 'gzip' } })).statusCode).toBe(404);

    const head = await app.inject({ method: 'HEAD', url: '/api/workbench/compression-fixture', headers: { 'accept-encoding': 'gzip' } });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
