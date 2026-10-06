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
  const state={denied:false,authCalls:0,revokeAtAuth:0,truncated:false,symlink:false,publicRepo:false,rawStatus:200,rawFailurePath:'',rawTimeout:false,rawCorrupt:false,failWrite:0,writes:0,activeRaw:0,maxRaw:0};
  const requests:string[]=[];
  const rawAuthorization:string[]=[]; const apiAuthorization:string[]=[];
  const rawRedirects:string[]=[];
  let records:Setting[]=[];
  const store=new WorkbenchStore(null as unknown as Sql);
  vi.spyOn(store,'list').mockImplementation(async()=>structuredClone(records));
  vi.spyOn(store,'put').mockImplementation(async(_kind,data)=>{ if(++state.writes===state.failWrite) throw new Error('Injected write failure'); records.push(structuredClone(data) as Setting); });
  vi.spyOn(store,'transaction').mockImplementation(async(_scope,fn)=>{ const before=structuredClone(records); try{return await fn(null as unknown as Sql);}catch(e){records=before;throw e;} });
  const app=Fastify();
  await registerSourceRoutes(app,store,{
    authorize:async()=>{state.authCalls++;if(state.denied||state.authCalls===state.revokeAtAuth)throw Object.assign(new Error('Denied'),{statusCode:403});},
    githubToken:'fixture-token', fetcher:async (input,init)=>{
      const url=new URL(String(input)); requests.push(url.href); const catalog=url.pathname.includes('/catalog/');
      const authorization=new Headers(init?.headers).get('authorization'); if(url.hostname==='raw.githubusercontent.com'){rawAuthorization.push(authorization??'');rawRedirects.push(String(init?.redirect));}else apiAuthorization.push(authorization??'');
      if(url.pathname.startsWith('/repos/') && !/\/(commits|git)\//u.test(url.pathname))return Response.json({private:!state.publicRepo});
      if(url.pathname.includes('/commits/'))return Response.json({sha:catalog?catalogCommit:commit});
      if(url.pathname.includes('/git/trees/'))return Response.json({truncated:state.truncated,tree:[...files].filter(([p])=>catalog?p==='marketplace.json':p!=='marketplace.json').map(([p,b])=>({path:p,type:'blob',mode:state.symlink&&p.endsWith('scripts/check')?'120000':p.endsWith('scripts/check')?'100755':'100644',sha:gitBlobHash(b),size:b.length}))});
      if(url.pathname.includes('/git/blobs/')){const b=[...files.values()].find(b=>gitBlobHash(b)===url.pathname.split('/').at(-1));if(b)return Response.json({encoding:'base64',content:b.toString('base64'),size:b.length});}
      if(url.hostname==='raw.githubusercontent.com'){
        const path=decodeURIComponent(url.pathname.split('/').slice(4).join('/'));state.activeRaw++;state.maxRaw=Math.max(state.maxRaw,state.activeRaw);
        await new Promise(resolve=>setTimeout(resolve,state.rawFailurePath===path?0:10));
        if(init?.signal?.aborted){state.activeRaw--;throw Object.assign(new Error('aborted'),{name:'AbortError'});}
        if(state.rawTimeout&&(!state.rawFailurePath||state.rawFailurePath===path)){state.activeRaw--;throw Object.assign(new Error('timed out'),{name:'TimeoutError'});}
        const original=files.get(path);const body=original&&state.rawCorrupt&&path.startsWith('skills/one/')?Buffer.from(original):original;if(body&&body!==original)body[0]=(body[0]??0)^1;
        const response=state.rawStatus!==200&&(!state.rawFailurePath||state.rawFailurePath===path)?new Response(null,{status:state.rawStatus}):new Response(body??null);state.activeRaw--;return response;
      }
      return new Response(null,{status:404});
    },
  });
  const payload={scope:'project',projectId:'p',catalogUrl:'https://github.com/example/catalog/blob/fixed/marketplace.json',pluginName:'fixture',previewCommit:commit,previewCatalogCommit:catalogCommit,selectedPaths:['skills/one/SKILL.md','skills/two/SKILL.md']};
  return {app,state,files,payload,requests,rawAuthorization,rawRedirects,apiAuthorization,records:()=>records};
}
function add71FileSkill(files: Map<string, Buffer>) {
  const markdownBytes=files.get('skills/one/SKILL.md')!.byteLength;
  for(let index=0;index<69;index++)files.set(`skills/one/references/${index}.md`,Buffer.alloc(2924,65));
  files.set('skills/one/references/69.md',Buffer.alloc(204_725-markdownBytes-69*2924,65));
}
it('imports exact full regular-file bundles through production preview/import and direct GitHub routes',async()=>{
  const f=await fixture();try{
    const preview=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture',selectedPaths:['skills/two/SKILL.md']}});
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
    expect(f.rawAuthorization).toEqual([]);expect(f.apiAuthorization.every(value=>value==='Bearer fixture-token')).toBe(true);
  }finally{await f.app.close();}
});
it('rejects whole multiselection on incomplete/unsafe files, permission denial and second-write failure',async()=>{
  const f=await fixture();try{
    for(const flag of ['truncated','symlink','denied'] as const){f.state[flag]=true;const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:f.payload});expect(response.statusCode).toBe(flag==='denied'?403:400);expect(response.json().installed).toBeUndefined();expect(f.records()).toEqual([]);f.state[flag]=false;}
    f.state.failWrite=2;
    const failed=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:f.payload});expect(failed.statusCode).toBe(500);expect(f.records()).toEqual([]);
  }finally{await f.app.close();}
});

it('lists metadata without skill reads and hydrates only the selected public 71-file skill from pinned raw bytes',async()=>{
  const f=await fixture();
  try {
    add71FileSkill(f.files);
    f.state.publicRepo=true;
    const metadata=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture'}});
    expect(metadata.statusCode).toBe(200); expect(metadata.json().skills).toHaveLength(2);
    expect(metadata.json().skills[0]).not.toHaveProperty('bundleSha256');
    expect(f.requests.some(url=>url.includes('/git/blobs/'))).toBe(false);
    expect(f.requests.some(url=>url.startsWith('https://raw.githubusercontent.com/')&&new URL(url).pathname.includes('/skills/'))).toBe(false);
    const invalidPaths=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture',selectedPaths:['skills/missing/SKILL.md']}});
    expect(invalidPaths.statusCode).toBe(400);expect(f.requests.some(url=>url.startsWith('https://raw.githubusercontent.com/')&&new URL(url).pathname.includes('/skills/'))).toBe(false);
    const duplicatePaths=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture',selectedPaths:['skills/one/SKILL.md','skills/one/SKILL.md']}});
    expect(duplicatePaths.statusCode).toBe(400);expect(f.requests.some(url=>url.startsWith('https://raw.githubusercontent.com/')&&new URL(url).pathname.includes('/skills/'))).toBe(false);
    const original=f.app;
    // The fixture fetcher returns raw bytes; enforce and observe its bounded concurrency through the request list.
    const rawRequestsBeforeHydration=f.requests.filter(url=>url.startsWith('https://raw.githubusercontent.com/')).length;
    const hydrated=await original.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture',selectedPaths:['skills/one/SKILL.md']}});
    expect(hydrated.statusCode).toBe(200); expect(hydrated.json().skills[0].bundleFiles).toHaveLength(71);
    expect(hydrated.json().skills[0].bundleFiles.reduce((total:number,file:{bytes:number})=>total+file.bytes,0)).toBe(204_725);
    expect(f.requests.filter(url=>url.startsWith('https://raw.githubusercontent.com/'))).toHaveLength(rawRequestsBeforeHydration+73); // catalog, plugin manifest, then 71 selected files
    expect(f.state.maxRaw).toBeLessThanOrEqual(4);
    expect(f.rawRedirects.every(value=>value==='error')).toBe(true);
    expect(f.records()).toEqual([]);
    const imported=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:{...f.payload,selectedPaths:['skills/one/SKILL.md']}});
    expect(imported.statusCode).toBe(200); expect(f.records()).toHaveLength(1);
    expect(f.requests.filter(url=>url.startsWith('https://raw.githubusercontent.com/') && url.includes('/skills/one/'))).toHaveLength(142);
    expect(f.requests.some(url=>url.startsWith('https://raw.githubusercontent.com/') && url.includes('/skills/two/'))).toBe(false);
  } finally { await f.app.close(); }
});

it('reports public raw 403 and never forwards the configured token to raw hosts',async()=>{
  const f=await fixture();
  try {
    add71FileSkill(f.files);
    f.state.publicRepo=true;
    f.state.rawStatus=403;
    f.state.rawFailurePath='skills/one/SKILL.md';
    const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture',selectedPaths:['skills/one/SKILL.md']}});
    expect(response.statusCode).toBe(502); expect(response.json().message).toContain('403');
    expect(f.requests.some(url=>url.startsWith('https://raw.githubusercontent.com/')&&url.endsWith('/skills/one/SKILL.md'))).toBe(true);
    expect(f.rawAuthorization.every(value=>value==='')); expect(f.apiAuthorization.every(value=>value==='Bearer fixture-token')).toBe(true);
    expect(f.requests.filter(url=>url.startsWith('https://raw.githubusercontent.com/')&&new URL(url).pathname.includes('/skills/one/'))).toHaveLength(4);
    f.state.rawStatus=200; f.state.rawTimeout=true;
    const timeout=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture',selectedPaths:['skills/one/SKILL.md']}});
    expect(timeout.statusCode).toBe(502); expect(timeout.json().message).toMatch(/timed out/u); expect(f.records()).toEqual([]); expect(f.state.activeRaw).toBe(0);
    f.state.rawTimeout=false; f.state.rawStatus=403;
    const failedImport=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:{...f.payload,selectedPaths:['skills/one/SKILL.md']}});
    expect(failedImport.statusCode).toBe(502); expect(f.records()).toEqual([]);
  } finally { await f.app.close(); }
});

it('rechecks authorization inside the transaction after selected hydration and writes nothing after revocation',async()=>{
  const f=await fixture();
  try {
    f.state.revokeAtAuth=2;
    const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:{...f.payload,selectedPaths:['skills/one/SKILL.md']}});
    expect(response.statusCode).toBe(403); expect(f.records()).toEqual([]);
  } finally { await f.app.close(); }
});

it('rejects public raw bytes that do not match the immutable Git tree hash',async()=>{
  const f=await fixture();
  try {
    f.state.publicRepo=true; f.state.rawCorrupt=true;
    const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'fixture',selectedPaths:['skills/one/SKILL.md']}});
    expect(response.statusCode).toBe(400); expect(response.json().message).toMatch(/Git blob.*immutable tree/u); expect(f.records()).toEqual([]);
  } finally { await f.app.close(); }
});

async function codexLocalFixture(options: { path?: string; dual?: boolean; identityConflict?: boolean; components?: boolean; airtableProducts?: unknown; installation?: unknown; authentication?: unknown; unknownPolicyField?: boolean } = {}) {
  const commit='5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f';
  const compat={apps:'./.app.json',author:{name:'Airtable'},description:'Airtable plugin description',interface:{category:'Productivity',displayName:'Airtable'},name:options.identityConflict?'other':'airtable',version:'6.0.1',...(options.components?{hooks:{SessionStart:[]},mcpServers:{airtable:{url:'https://mcp.airtable.com/mcp'}},agents:'./agents/',commands:'./commands/'}:{})};
  const airtablePolicy:Record<string,unknown>={installation:options.installation??'AVAILABLE',authentication:options.authentication??'ON_INSTALL'};
  if('airtableProducts' in options)airtablePolicy.products=options.airtableProducts;
  if(options.unknownPolicyField)airtablePolicy.audience='CODEX';
  const files=new Map<string,Buffer>([
    ['.agents/plugins/marketplace.json',Buffer.from(JSON.stringify({name:'openai-curated',interface:{displayName:'Codex official'},plugins:[{name:'airtable',source:{source:'local',path:options.path??'./plugins/airtable'},policy:airtablePolicy,category:'Productivity'},{name:'game-studio',source:{source:'local',path:'./plugins/game-studio'},policy:{installation:'AVAILABLE',authentication:'ON_USE',products:['CODEX']},category:'Test fixture: observed CODEX and ON_USE values'}]}))],
    ['plugins/airtable/.codex-plugin/plugin.json',Buffer.from(JSON.stringify(compat))],
    ['plugins/airtable/.app.json',Buffer.from(JSON.stringify({apps:{airtable:{id:'registered-app'}}}))],
    ['plugins/airtable/.mcp.json',Buffer.from(JSON.stringify({mcpServers:{airtable:{url:'https://mcp.airtable.com/mcp'}}}))],
    ['plugins/airtable/skills/airtable-cli/SKILL.md',Buffer.from('---\nname: airtable-cli\ndescription: Lists and manages Airtable records.\n---\nInstructions only.')],
    ['plugins/airtable/skills/airtable-filters/SKILL.md',Buffer.from('---\nname: airtable-filters\ndescription: Filters Airtable records.\n---\nInstructions only.')],
    ['plugins/airtable/skills/airtable-overview/SKILL.md',Buffer.from('---\nname: airtable-overview\ndescription: Explains Airtable structure.\n---\nInstructions only.')],
  ]);
  if(options.dual) files.set('plugins/airtable/plugin.json',Buffer.from(JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'airtable',version:'0.2.0',description:'Portable canonical identity',extensions:{'com.openai':{interface:{displayName:'Inline OpenAI overlay'}}}})));
  const state={denied:false,truncated:false,symlink:false,commitMismatch:false,catalogMoved:false,failWrite:0,writes:0};
  let records:Setting[]=[];
  const store=new WorkbenchStore(null as unknown as Sql);
  vi.spyOn(store,'list').mockImplementation(async()=>structuredClone(records));
  vi.spyOn(store,'put').mockImplementation(async(_kind,data)=>{if(++state.writes===state.failWrite)throw new Error('Injected write failure');records.push(structuredClone(data) as Setting);});
  vi.spyOn(store,'transaction').mockImplementation(async(_scope,fn)=>{const before=structuredClone(records);try{return await fn(null as unknown as Sql);}catch(error){records=before;throw error;}});
  const requests:string[]=[];
  const app=Fastify();
  await registerSourceRoutes(app,store,{
    authorize:async()=>{if(state.denied)throw Object.assign(new Error('Denied'),{statusCode:403});},
    fetcher:async input=>{
      const url=new URL(String(input));requests.push(url.href);
      if(url.pathname.startsWith('/repos/') && !/\/(commits|git)\//u.test(url.pathname))return Response.json({private:true});
      if(url.pathname.endsWith('/commits/main'))return Response.json({sha:state.catalogMoved?'c'.repeat(40):commit});
      if(url.pathname.includes('/commits/'))return Response.json({sha:state.commitMismatch?'c'.repeat(40):commit});
      if(url.pathname.includes('/git/trees/'))return Response.json({truncated:state.truncated,tree:[...files].map(([path,bytes])=>({path,type:'blob',mode:'100644',sha:gitBlobHash(bytes),size:bytes.length}))});
      if(url.pathname.includes('/git/blobs/')){const bytes=[...files.values()].find(bytes=>gitBlobHash(bytes)===url.pathname.split('/').at(-1));if(bytes)return Response.json({encoding:'base64',content:bytes.toString('base64'),size:bytes.length});}
      return new Response(null,{status:404});
    },
  });
  const catalogUrl=`https://github.com/openai/plugins/blob/${commit}/.agents/plugins/marketplace.json`;
  const payload={scope:'project' as const,projectId:'p',catalogUrl,pluginName:'airtable',previewCommit:commit,previewCatalogCommit:commit,selectedPaths:['plugins/airtable/skills/airtable-cli/SKILL.md','plugins/airtable/skills/airtable-filters/SKILL.md','plugins/airtable/skills/airtable-overview/SKILL.md']};
  return {app,state,files,payload,requests,records:()=>records};
}

it('resolves the official same-repository local catalog entry at its immutable catalog commit and imports only complete skills',async()=>{
  const f=await codexLocalFixture();try{
    const preview=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'airtable'}});
    expect(preview.statusCode).toBe(200);
    expect(preview.json().catalog.commit).toBe('5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f');
    expect(preview.json().plugin).toMatchObject({name:'airtable',commit:f.payload.previewCommit,version:'6.0.1'});
    expect(preview.json().skills.map((skill:{path:string})=>skill.path)).toEqual(f.payload.selectedPaths);
    expect(f.requests.filter(url=>new URL(url).pathname==='/repos/openai/plugins')).toHaveLength(1);
    expect(preview.json().unsupported).toEqual(expect.arrayContaining(['.codex-plugin/plugin.json:apps','plugins/airtable/.app.json','plugins/airtable/.mcp.json']));
    expect(f.requests.every(url=>{const path=new URL(url).pathname;return path==='/repos/openai/plugins'||path.startsWith('/repos/openai/plugins/');})).toBe(true);
    expect(f.requests.some(url=>url.includes('/commits/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f'))).toBe(true);
    expect(f.requests.filter(url=>url.includes('/git/trees/')).every(url=>url.includes(`/git/trees/${f.payload.previewCatalogCommit}?recursive=1`))).toBe(true);
    const result=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:f.payload});
    expect(result.statusCode).toBe(200);expect(result.json().installed).toHaveLength(3);expect(f.records()).toHaveLength(3);
    for(const skill of result.json().installed){
      verifyBundle(skill.data.bundle);
      expect(skill.data.resolvedSha).toBe(f.payload.previewCommit);
      expect(skill.data.catalogResolvedSha).toBe(f.payload.previewCatalogCommit);
      expect(skill.data.sourcePath).toMatch(/^plugins\/airtable\/skills\/[^/]+\/SKILL\.md$/u);
      expect(skill.data.provenance).toContain(`openai/plugins@${f.payload.previewCommit}:`);
      expect(skill.data.unsupportedPluginComponents).toEqual(expect.arrayContaining(['plugins/airtable/.app.json','plugins/airtable/.mcp.json']));
      expect(skill.data.provider).toBeUndefined();
    }
    expect(f.requests.every(url=>{const path=new URL(url).pathname;return path==='/repos/openai/plugins'||path.startsWith('/repos/openai/plugins/');})).toBe(true);
  }finally{await f.app.close();}
});

it('parses ON_USE and verified CODEX metadata elsewhere in the full catalog while Airtable omits products',async()=>{
  const f=await codexLocalFixture();try{
    const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'airtable'}});
    expect(response.statusCode).toBe(200);expect(response.json().plugin.name).toBe('airtable');expect(f.records()).toEqual([]);
  }finally{await f.app.close();}
});

it('continues accepting legacy ON_FIRST_USE authentication policy',async()=>{
  const f=await codexLocalFixture({authentication:'ON_FIRST_USE'});try{
    const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'airtable'}});
    expect(response.statusCode).toBe(200);expect(response.json().plugin.name).toBe('airtable');expect(f.records()).toEqual([]);
  }finally{await f.app.close();}
});

it('returns contextual 400s for malformed products and legacy policy fields before import persistence',async()=>{
  const invalidPolicies=[
    {options:{airtableProducts:['CHATGPT']},field:'policy.products'},
    {options:{airtableProducts:'CODEX'},field:'policy.products'},
    {options:{airtableProducts:[42]},field:'policy.products'},
    {options:{airtableProducts:['CODEX'],unknownPolicyField:true},field:'policy.audience'},
    {options:{installation:'SOMETIMES'},field:'policy.installation'},
    {options:{installation:42},field:'policy.installation'},
    {options:{authentication:'ON_SUBMIT'},field:'policy.authentication'},
    {options:{authentication:42},field:'policy.authentication'},
  ];
  for(const {options,field} of invalidPolicies){
    const f=await codexLocalFixture(options);try{
      const request={scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'airtable'};
      const preview=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:request});
      expect(preview.statusCode).toBe(400);expect(preview.json().message).toContain('airtable');expect(preview.json().message).toContain(field);expect(f.records()).toEqual([]);
      const imported=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:{...request,selectedPaths:f.payload.selectedPaths,previewCommit:f.payload.previewCommit,previewCatalogCommit:f.payload.previewCatalogCommit}});
      expect(imported.statusCode).toBe(400);expect(imported.json().message).toContain('airtable');expect(imported.json().message).toContain(field);expect(f.records()).toEqual([]);
    }finally{await f.app.close();}
  }
});

it('uses the inline OpenAI overlay without merging a Codex fallback and keeps portable identity canonical',async()=>{
  const f=await codexLocalFixture({dual:true});try{
    const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'airtable'}});
    expect(response.statusCode).toBe(200);
    expect(response.json().plugin.version).toBe('0.2.0');
    expect(response.json().unsupported).toContain('.codex-plugin/plugin.json ignored: replaced by plugin.json extensions.com.openai');
    expect(response.json().unsupported).not.toContain('.codex-plugin/plugin.json:apps');
    expect(response.json().unsupported).not.toContain('.codex-plugin/plugin.json:hooks');
  }finally{await f.app.close();}
});

it('labels apps, MCP, hooks, agents and commands as uninstalled compatibility components',async()=>{
  const f=await codexLocalFixture({components:true});try{
    const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'airtable'}});
    expect(response.statusCode).toBe(200);
    expect(response.json().unsupported).toEqual(expect.arrayContaining(['.codex-plugin/plugin.json:apps','.codex-plugin/plugin.json:mcpServers','.codex-plugin/plugin.json:hooks','.codex-plugin/plugin.json:agents','.codex-plugin/plugin.json:commands']));
  }finally{await f.app.close();}
});

it('rejects local path escape and conflicting dual-manifest identity before import',async()=>{
  const traversal=await codexLocalFixture({path:'./plugins/../outside'});try{
    const response=await traversal.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:traversal.payload.scope,projectId:'p',catalogUrl:traversal.payload.catalogUrl,pluginName:'airtable'}});
    expect(response.statusCode).toBe(400);expect(traversal.records()).toEqual([]);
  }finally{await traversal.app.close();}
  const conflict=await codexLocalFixture({dual:true,identityConflict:true});try{
    const payload={scope:conflict.payload.scope,projectId:'p',catalogUrl:conflict.payload.catalogUrl,pluginName:'airtable'};
    const preview=await conflict.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload});
    expect(preview.statusCode).toBe(400);expect(preview.json().message).toMatch(/manifests have conflicting identities/u);expect(conflict.records()).toEqual([]);
    const imported=await conflict.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:{...payload,selectedPaths:conflict.payload.selectedPaths,previewCommit:conflict.payload.previewCommit,previewCatalogCommit:conflict.payload.previewCatalogCommit}});
    expect(imported.statusCode).toBe(400);expect(imported.json().message).toMatch(/manifests have conflicting identities/u);expect(conflict.records()).toEqual([]);
  }finally{await conflict.app.close();}
  const catalogMismatch=await codexLocalFixture({identityConflict:true});try{
    const response=await catalogMismatch.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:catalogMismatch.payload.scope,projectId:'p',catalogUrl:catalogMismatch.payload.catalogUrl,pluginName:'airtable'}});
    expect(response.statusCode).toBe(400);expect(response.json().message).toMatch(/manifest identity does not match the catalog/u);expect(catalogMismatch.records()).toEqual([]);
  }finally{await catalogMismatch.app.close();}
  const f=await codexLocalFixture();try{
    f.state.commitMismatch=true;
    const response=await f.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:{scope:f.payload.scope,projectId:'p',catalogUrl:f.payload.catalogUrl,pluginName:'airtable'}});
    expect(response.statusCode).toBe(502);expect(response.json().message).toMatch(/immutable commit SHA/u);
  }finally{await f.app.close();}
  const changed=await codexLocalFixture();try{
    const request={scope:changed.payload.scope,projectId:'p',catalogUrl:changed.payload.catalogUrl.replace(/\/blob\/[a-f0-9]{40}\//u,'/blob/main/'),pluginName:'airtable'};
    const preview=await changed.app.inject({method:'POST',url:'/api/workbench/skills/catalog/preview',payload:request});
    expect(preview.statusCode).toBe(200);
    changed.state.catalogMoved=true;
    const response=await changed.app.inject({method:'POST',url:'/api/workbench/skills/catalog/import',payload:{...request,selectedPaths:changed.payload.selectedPaths,previewCommit:preview.json().plugin.commit,previewCatalogCommit:preview.json().catalog.commit}});
    expect(response.statusCode).toBe(409);expect(response.json().message).toMatch(/changed after preview/u);expect(changed.records()).toEqual([]);
  }finally{await changed.app.close();}
});
