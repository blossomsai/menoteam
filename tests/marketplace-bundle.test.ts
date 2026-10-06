import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { WorkbenchStore } from '../src/workbench/store.js';
import { registerSourceRoutes } from '../src/workbench/sources.js';
import { gitBlobHash, verifyBundle } from '../src/workbench/skill-bundle.js';
import type { Setting } from '../src/workbench/types.js';

// Real HTTP handlers, fixed Git fixtures, in-memory transaction adapter. No PostgreSQL/socket.
async function fixture() {
  const commit='a'.repeat(40), catalogCommit='b'.repeat(40);
  const files=new Map<string,Buffer>([
    ['marketplace.json',Buffer.from(JSON.stringify({name:'fixture',plugins:[{name:'fixture',category:'Testing',policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},source:{source:'url',url:'https://github.com/example/plugin',ref:'fixed'}}]}))],
    ['plugin.json',Buffer.from(JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'fixture'}))],
    ['skills/one/SKILL.md',Buffer.from('---\nname: one\ndescription: First.\n---\nRun tests and/or lint. Use `response.status`.')],
    ['skills/two/SKILL.md',Buffer.from('---\nname: two\ndescription: Second.\n---\nRead resources.')],
    ['skills/two/references/guide.md',Buffer.from('REFERENCE\r\n')],
    ['skills/two/scripts/check',Buffer.from('#!/bin/sh\nprintf LOCAL_MARKER\n')],
    ['skills/two/assets/icon.bin',Buffer.from([0,255,128,13,10,0])],
  ]);
  const state={denied:false,truncated:false,symlink:false,failWrite:0,writes:0};
  let records:Setting[]=[];
  const store=new WorkbenchStore(null as unknown as Sql);
  vi.spyOn(store,'list').mockImplementation(async()=>structuredClone(records));
  vi.spyOn(store,'put').mockImplementation(async(_kind,data)=>{ if(++state.writes===state.failWrite) throw new Error('Injected write failure'); records.push(structuredClone(data) as Setting); });
  vi.spyOn(store,'transaction').mockImplementation(async(_scope,fn)=>{ const before=structuredClone(records); try{return await fn(null as unknown as Sql);}catch(e){records=before;throw e;} });
  const app=Fastify();
  await registerSourceRoutes(app,store,{
    authorize:async()=>{if(state.denied)throw Object.assign(new Error('Denied'),{statusCode:403});},
    fetcher:async input=>{
      const url=new URL(String(input)); const catalog=url.pathname.includes('/catalog/');
      if(url.pathname.includes('/commits/'))return Response.json({sha:catalog?catalogCommit:commit});
      if(url.pathname.includes('/git/trees/'))return Response.json({truncated:state.truncated,tree:[...files].filter(([p])=>catalog?p==='marketplace.json':p!=='marketplace.json').map(([p,b])=>({path:p,type:'blob',mode:state.symlink&&p.endsWith('scripts/check')?'120000':p.endsWith('scripts/check')?'100755':'100644',sha:gitBlobHash(b),size:b.length}))});
      if(url.pathname.includes('/git/blobs/')){const b=[...files.values()].find(b=>gitBlobHash(b)===url.pathname.split('/').at(-1));if(b)return Response.json({encoding:'base64',content:b.toString('base64'),size:b.length});}
      return new Response(null,{status:404});
    },
  });
  const payload={scope:'project',projectId:'p',catalogUrl:'https://github.com/example/catalog/blob/fixed/marketplace.json',pluginName:'fixture',previewCommit:commit,previewCatalogCommit:catalogCommit,selectedPaths:['skills/one/SKILL.md','skills/two/SKILL.md']};
  return {app,state,files,payload,records:()=>records};
}
it('imports exact full regular-file bundles through production preview/import and direct GitHub routes',async()=>{
  const f=await fixture();try{
    const preview=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture'}});
    expect(preview.statusCode).toBe(200);expect(preview.json().skills[1].bundleFiles).toHaveLength(4);
    const result=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:f.payload});
    expect(result.statusCode).toBe(200);expect(f.records()).toHaveLength(2);
    const skill=result.json().installed[1];verifyBundle(skill.data.bundle);
    expect(skill.data.resolvedSha).toBe('a'.repeat(40));expect(skill.data.sourceContentSha256).toBe(skill.data.bundle.sha256);
    for(const file of skill.data.bundle.files)expect(Buffer.from(file.data,'base64')).toEqual(f.files.get(`skills/two/${file.path}`));
    expect(skill.data.bundle.files.find((file:{path:string})=>file.path==='scripts/check').mode).toBe('100755');
    const direct=await f.app.inject({method:'POST',url:'/api/workbench/projects/p/skills/import',payload:{url:'https://github.com/example/plugin/blob/fixed/skills/two/SKILL.md'}});
    expect(direct.statusCode).toBe(200);expect(direct.json().data.bundle).toEqual(skill.data.bundle);
    expect((await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:f.payload})).statusCode).toBe(409);expect(f.records()).toHaveLength(3);
    const pinnedMismatch=await f.app.inject({method:'POST',url:'/api/workbench/projects/p/skills/import',payload:{url:`https://github.com/example/plugin/blob/${'c'.repeat(40)}/skills/two/SKILL.md`}});
    expect(pinnedMismatch.statusCode).toBe(502);expect(f.records()).toHaveLength(3);
  }finally{await f.app.close();}
});
it('rejects whole multiselection on incomplete/unsafe files, permission denial and second-write failure',async()=>{
  const f=await fixture();try{
    for(const flag of ['truncated','symlink','denied'] as const){f.state[flag]=true;const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:f.payload});expect(response.statusCode).toBe(flag==='denied'?403:400);expect(response.json().installed).toBeUndefined();expect(f.records()).toEqual([]);f.state[flag]=false;}
    f.state.failWrite=2;
    const failed=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:f.payload});expect(failed.statusCode).toBe(500);expect(f.records()).toEqual([]);
  }finally{await f.app.close();}
});
