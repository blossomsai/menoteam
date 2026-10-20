import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Sql } from 'postgres';
import { registerWorkbenchAssets } from '../src/workbench/assets.js';
import { createWorkbenchApp } from '../src/workbench/app.js';

async function writeManifest(root:string, manifest:unknown) {
  await mkdir(join(root,'.vite'),{recursive:true});
  await writeFile(join(root,'.vite','manifest.json'),JSON.stringify(manifest));
}

it('uses current Vite manifest membership for immutable caching and revalidates HTML', async () => {
  const root=await mkdtemp(join(tmpdir(),'workbench-http-cache-'));
  const outside=join(root,'outside.js');
  const app=Fastify();
  try {
    await mkdir(join(root,'assets','nested'),{recursive:true});
    await writeFile(join(root,'index.html'),'<h1>first</h1>');
    await writeFile(join(root,'assets','app-Ab_C-12z.js'),'globalThis.app=1');
    await writeFile(join(root,'assets','nested','chunk-xY_2-aB7.js'),'globalThis.nested=1');
    await writeFile(join(root,'assets','plain.js'),'globalThis.plain=1');
    await writeFile(join(root,'assets','app-settings.js'),'globalThis.settings=1');
    await writeFile(join(root,'assets','app-development.js'),'globalThis.dev=1');
    await writeFile(join(root,'assets','rogue-AbCdEfGh.js'),'globalThis.rogue=1');
    await writeFile(outside,'globalThis.outside=1');
    await symlink(outside,join(root,'assets','escape.js'));
    await registerWorkbenchAssets(app,root);

    const withoutManifest=await app.inject('/workbench/assets/rogue-AbCdEfGh.js');
    expect(withoutManifest.statusCode).toBe(200);
    expect(withoutManifest.headers['cache-control']).toBe('no-cache');
    expect(withoutManifest.headers.etag).toBeUndefined();
    await writeFile(join(root,'assets','rogue-AbCdEfGh.js'),'globalThis.rogue=2');
    expect((await app.inject('/workbench/assets/rogue-AbCdEfGh.js')).body).toBe('globalThis.rogue=2');

    await mkdir(join(root,'.vite'),{recursive:true});
    await writeFile(join(root,'.vite','manifest.json'),'{malformed');
    const malformedManifest=await app.inject('/workbench/assets/app-Ab_C-12z.js');
    expect(malformedManifest.statusCode).toBe(200);
    expect(malformedManifest.headers['cache-control']).toBe('no-cache');
    expect(malformedManifest.headers.etag).toBeUndefined();

    await writeManifest(root,{
      'src/main.tsx':{file:'assets/app-Ab_C-12z.js',isEntry:true,css:['assets/nested/chunk-xY_2-aB7.js']},
      'src/chunk.ts':{file:'assets/nested/chunk-xY_2-aB7.js'}
    });
    const listed=await app.inject('/workbench/assets/app-Ab_C-12z.js');
    expect(listed.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(listed.headers.etag).toBeTruthy();
    expect(listed.headers['content-type']).toContain('javascript');
    expect((await app.inject('/workbench/assets/nested/chunk-xY_2-aB7.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');

    for(const descriptive of ['app-settings.js','app-development.js']) {
      const first=await app.inject(`/workbench/assets/${descriptive}`);
      expect(first.headers['cache-control']).toBe('no-cache');
      expect(first.headers.etag).toBeUndefined();
      await writeFile(join(root,'assets',descriptive),`fresh:${descriptive}`);
      const fresh=await app.inject(`/workbench/assets/${descriptive}`);
      expect(fresh.body).toBe(`fresh:${descriptive}`);
      expect(fresh.headers['cache-control']).toBe('no-cache');
      expect(fresh.headers.etag).toBeUndefined();
    }

    await writeFile(join(root,'assets','app-Ab_C-12z.js'),'replacement bytes for prior immutable path');
    const prior=await app.inject('/workbench/assets/app-Ab_C-12z.js');
    expect(prior.body).toBe('globalThis.app=1');
    expect(prior.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const html=await app.inject('/workbench/');
    expect(html.headers['cache-control']).toBe('no-cache');
    expect(html.headers.etag).toBeTruthy();
    const notModified=await app.inject({url:'/workbench/',headers:{'if-none-match':html.headers.etag!}});
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    expect(notModified.headers.etag).toBe(html.headers.etag);

    await mkdir(join(root,'assets','new'),{recursive:true});
    const newManifest={
      'src/new.ts':{file:'assets/new/chunk-aB_C-1xY.js',isEntry:true},
      'src/main.tsx':{file:'assets/app-Ab_C-12z.js',isEntry:true}
    };
    await writeManifest(root,newManifest);
    await writeFile(join(root,'assets','new','chunk-aB_C-1xY.js'),'globalThis.newChunk=1');
    await writeFile(join(root,'index.html'),'<script src="/workbench/assets/new/chunk-aB_C-1xY.js"></script>');
    const latestHtml=await app.inject({url:'/workbench/',headers:{'if-none-match':html.headers.etag!}});
    expect(latestHtml.statusCode).toBe(200);
    expect(latestHtml.body).toContain('new/chunk-aB_C-1xY.js');
    const latestAsset=await app.inject('/workbench/assets/new/chunk-aB_C-1xY.js');
    expect(latestAsset.statusCode).toBe(200);
    expect(latestAsset.body).toBe('globalThis.newChunk=1');
    expect(latestAsset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    await writeFile(join(root,'assets','plain.js'),'globalThis.plain=2');
    const plain=await app.inject('/workbench/assets/plain.js');
    expect(plain.body).toBe('globalThis.plain=2');
    expect(plain.headers['cache-control']).toBe('no-cache');
    expect((await app.inject('/workbench/assets/%2e%2e/index.html')).statusCode).toBe(404);
    const missing=await app.inject('/workbench/assets/nested/missing-a1b2c3d4.js');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBeUndefined();
    const escaped=await app.inject('/workbench/assets/escape.js');
    expect(escaped.statusCode).toBe(404);
    expect(escaped.headers['cache-control']).toBeUndefined();
  } finally { await app.close(); await rm(root,{recursive:true,force:true}); }
});

it('sets no-store on API 401, 403, and 429 responses', async () => {
  const sql=(async()=>[]) as unknown as Sql;
  const app=await createWorkbenchApp({sql});
  app.get('/api/workbench/test-forbidden',async(_req,reply)=>reply.code(403).send({error:'denied'}));
  app.get('/api/workbench/test-limited',async(_req,reply)=>reply.code(429).send({error:'limited'}));
  try {
    for(const [url,statusCode] of [['/api/workbench/me',401],['/api/workbench/test-forbidden',403],['/api/workbench/test-limited',429]] as const) {
      const response=await app.inject({url,headers:{'if-none-match':'"stale-or-foreign"'}});
      expect(response.statusCode).toBe(statusCode);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  } finally { await app.close(); }
});
