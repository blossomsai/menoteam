import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDiff, diffRevision, git, spoolDiffFile } from '../src/connector/git.js';

const runId='run_23633c51-423f-45e3-95b5-5dff8dd56c5b';
const requiredId=`artifact:${runId}:required-qa:${runId}:1`;
// Longest current format: artifact prefix + generated run ID + typed-review prefix + 200-char request ID.
const typedId=`artifact:${runId}:typed-review:${'q'.repeat(200)}`;
const cookie='menoteam_session=fixture-session';
async function fixture(role='owner',projectAccess=true){
  const member={id:'user-fixture',email:'fixture@example.invalid',name:'Fixture',role};
  const records=new Map([requiredId,typedId].map(id=>[id,{id,projectId:'project-fixture',runId,kind:'qa',revision:'f'.repeat(64),data:{checks:[]}}]));
  // Real production HTTP/router/authorization handlers; only the persistence adapter is in memory.
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?');
    if(query.includes('FROM wb_sessions'))return values[0]===digest('fixture-session')?[member]:[];
    if(query.includes('FROM wb_memberships'))return projectAccess?[{role:'member'}]:[];
    if(query.includes('FROM wb_records')){
      const [id,kind]=values;
      if(kind==='artifact')return records.has(String(id))?[{data:records.get(String(id))}]:[];
      if(kind==='project'&&id==='project-fixture')return [{data:{id:'project-fixture'}}];
    }
    throw new Error('Unexpected in-memory query');
  }) as unknown as Sql;
  return createWorkbenchApp({sql});
}

it('reads generated required-QA and maximum typed-review IDs, raw and encoded, through the production route',async()=>{
  const app=await fixture();
  try{
    expect(requiredId).toHaveLength(104);expect(typedId).toHaveLength(263);
    for(const id of [requiredId,typedId])for(const segment of [id,encodeURIComponent(id)]){
      const response=await app.inject({method:'GET',url:`/api/workbench/artifacts/${segment}`,headers:{cookie}});
      expect(response.statusCode).toBe(200);expect(response.json().id).toBe(id);
    }
  }finally{await app.close();}
});

it('keeps a bounded router parameter limit for raw and encoded oversized artifact IDs',async()=>{
  const app=await fixture();
  try{
    const id=`artifact:${':'.repeat(312)}`;expect(id).toHaveLength(321);
    for(const segment of [id,encodeURIComponent(id)]){
      const response=await app.inject({method:'GET',url:`/api/workbench/artifacts/${segment}`,headers:{cookie}});
      expect(response.statusCode).toBe(414);
    }
  }finally{await app.close();}
});

it('does not turn long artifact IDs into a session, project or reviewer-bridge authorization bypass',async()=>{
  const app=await fixture('member',false);
  try{
    const url=`/api/workbench/artifacts/${encodeURIComponent(requiredId)}`;
    expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
    // A reviewer bearer alone still has no human-session artifact-read authority.
    expect((await app.inject({method:'GET',url,headers:{authorization:'Bearer reviewer-bridge-fixture'}})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url,headers:{cookie}})).statusCode).toBe(403);
  }finally{await app.close();}
});

it('reads bounded diff pages with exact parent/path/cursor binding and reports missing chunks incomplete',async()=>{
  const revision='a'.repeat(64),baseRevision='b'.repeat(40),candidateRevision='c'.repeat(40),filePath='src/雪 file.ts',parts=[Buffer.from('first page\n'),Buffer.from('second page\n')],fileSha256=createHash('sha256').update(Buffer.concat(parts)).digest('hex');
  const parent={id:'diff-fixture',projectId:'project-fixture',workId:'work-fixture',runId:'run-fixture',kind:'diff',revision,data:{baseRevision,candidateRevision,files:[{path:filePath,oldPath:'src/old name.ts',status:'renamed',binary:false,additions:1,deletions:1,textBytes:Buffer.concat(parts).length,chunkCount:2,fileSha256}]}};
  const chunks=parts.map((bytes,chunkIndex)=>({id:`chunk-${chunkIndex}`,projectId:parent.projectId,workId:parent.workId,runId:parent.runId,kind:'diff_file_chunk',revision,data:{parentArtifactId:parent.id,projectId:parent.projectId,workId:parent.workId,runId:parent.runId,candidateRevision,baseRevision,diffRevision:revision,path:filePath,oldPath:'src/old name.ts',chunkIndex,chunkCount:2,fileSha256,fileByteLength:Buffer.concat(parts).length,chunkSha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')}}));
  let missingLast=false,memberRole='owner';
  const sql=((strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?');
    if(query.includes('pg_advisory_xact_lock'))return [];
    if(query.includes('FROM wb_sessions'))return values[0]===digest('fixture-session')?[{id:'user-fixture',email:'fixture@example.invalid',name:'Fixture',role:memberRole}]:[];
    if(query.includes('FROM wb_memberships'))return memberRole==='owner'?[{role:'owner'}]:[];
    if(query.includes('FROM wb_records')&&query.includes('WHERE id=? AND kind=?')){
      const [recordId,kind]=values;const item=kind==='artifact'?(recordId===parent.id?parent:chunks.find(chunk=>chunk.id===recordId)):kind==='project'&&recordId==='project-fixture'?{id:'project-fixture'}:undefined;
      return item?[{data:item}]:[];
    }
    if(query.includes("chunkIndex'=?")){
      const index=Number(values.at(-1));const chunk=index===1&&missingLast?undefined:chunks[index];return chunk?[{data:chunk}]:[];
    }
    if(query.includes('count(DISTINCT')){
      const records=missingLast?chunks.slice(0,1):chunks;return [{count:records.length,unique_count:records.length,byte_count:records.reduce((sum,item)=>sum+Buffer.from(item.data.contentBase64,'base64').length,0),first_index:records.length?0:null,last_index:records.length?records.length-1:null}];
    }
    throw new Error(`Unexpected in-memory query: ${query}`);
  }) as unknown as Sql;
  Object.assign(sql,{begin:async<T>(fn:(tx:Sql)=>Promise<T>)=>fn(sql),json:(value:unknown)=>value});
  const app=await createWorkbenchApp({sql});
  try{
    const url=`/api/workbench/artifacts/${parent.id}/diff-file`,headers={cookie};
    const first=await app.inject({method:'GET',url,headers,query:{path:filePath,revision}});expect(first.statusCode).toBe(200);expect(first.json().complete).toBe(false);expect(Buffer.from(first.json().contentBase64,'base64').toString()).toBe('first page\n');
    const cursor=first.json().nextCursor as string;const second=await app.inject({method:'GET',url,headers,query:{path:filePath,revision,cursor}});expect(second.statusCode).toBe(200);expect(second.json().complete).toBe(true);expect(Buffer.from(second.json().contentBase64,'base64').toString()).toBe('second page\n');
    expect((await app.inject({method:'GET',url,headers,query:{path:'src/other.ts',revision}})).statusCode).toBe(404);
    expect((await app.inject({method:'GET',url,headers,query:{path:filePath,revision:'d'.repeat(64)}})).statusCode).toBe(409);
    const wrongPathCursor=Buffer.from(JSON.stringify([parent.id,revision,'src/other.ts',1])).toString('base64url');expect((await app.inject({method:'GET',url,headers,query:{path:filePath,revision,cursor:wrongPathCursor}})).statusCode).toBe(409);
    const invalidCursor=Buffer.from(JSON.stringify([parent.id,revision,filePath,3])).toString('base64url');expect((await app.inject({method:'GET',url,headers,query:{path:filePath,revision,cursor:invalidCursor}})).statusCode).toBe(409);
    missingLast=true;const partial=await app.inject({method:'GET',url,headers,query:{path:filePath,revision}});expect(partial.statusCode).toBe(200);expect(partial.json().incomplete).toBe(true);expect(partial.json().complete).toBe(false);
    memberRole='member';expect((await app.inject({method:'GET',url,headers,query:{path:filePath,revision}})).statusCode).toBe(403);
    expect((await app.inject({method:'GET',url,query:{path:filePath,revision}})).statusCode).toBe(401);
  }finally{await app.close();}
});

it('resumes an interrupted >1 MiB diff upload through HTTP storage and reads byte-identical verified pages',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-diff-http-'));const repo=path.join(temp,'repo'),spool=path.join(temp,'spool');await mkdir(repo);await mkdir(spool);const filePath='src/雪\tline\n file.ts',fileAbs=path.join(repo,filePath);await mkdir(path.dirname(fileAbs),{recursive:true});
  const projectId='project-fixture',workId='work-fixture',runId='run-fixture',connectorId='connector-fixture',connectorToken='connector-fixture-token',sessionToken='fixture-session';
  const records=new Map<string,any>();let app:Awaited<ReturnType<typeof createWorkbenchApp>>|undefined;
  const sql=((strings:TemplateStringsArray,...values:unknown[])=>{const query=strings.join('?');
    if(query.includes('FROM wb_connectors WHERE digest'))return values[0]===digest(connectorToken)?[{id:connectorId,project_ids:[projectId]}]:[];
    if(query.includes('FROM wb_connectors WHERE'))return [{id:connectorId,project_ids:[projectId]}];
    if(query.includes('FROM wb_users WHERE id'))return [{role:'owner'}];
    if(query.includes('FROM wb_sessions'))return values[0]===digest(sessionToken)?[{id:'user-fixture',email:'fixture@example.invalid',name:'Fixture',role:'owner'}]:[];
    if(query.includes('FROM wb_memberships'))return [{role:'owner'}];
    if(query.includes('pg_advisory_xact_lock')||query.startsWith('UPDATE wb_connectors'))return [];
    if(query.startsWith('INSERT INTO wb_records')){const [id,kind,pid,data]=values;records.set(String(id),{id,kind,projectId:pid,runId:kind==='artifact'?data.runId:undefined,workId:kind==='artifact'?data.workId:undefined,revision:kind==='artifact'?data.revision:undefined,data});return [{id}];}
    if(query.includes('FROM wb_records')&&query.includes('WHERE id=? AND kind=?')){const item=records.get(String(values[0]));return item&&item.kind===values[1]?[{data:item.data}]:[];}
    if(query.includes("data->'data' AS data")){return [...records.values()].filter(item=>item.kind==='artifact'&&item.data.kind==='diff_file_chunk'&&item.data.data.parentArtifactId===values[1]&&item.data.data.path===values[2]).map(item=>({data:item.data.data}));}
    if(query.includes("chunkIndex'=?")){const index=Number(values.at(-1));const item=[...records.values()].find(item=>item.kind==='artifact'&&item.data.kind==='diff_file_chunk'&&item.data.data.parentArtifactId===values[1]&&item.data.data.path===values[2]&&item.data.data.chunkIndex===index);return item?[{data:item.data}]:[];}
    if(query.includes('count(DISTINCT')){const parts=[...records.values()].filter(item=>item.kind==='artifact'&&item.data.kind==='diff_file_chunk'&&item.data.data.parentArtifactId===values[1]&&item.data.data.path===values[2]&&item.data.data.diffRevision===values[3]&&item.data.data.candidateRevision===values[4]&&item.data.data.baseRevision===values[5]&&item.data.data.fileSha256===values[6]&&String(item.data.data.chunkCount)===String(values[7]));const indexes=parts.map(item=>item.data.data.chunkIndex);return [{count:parts.length,unique_count:new Set(indexes).size,byte_count:parts.reduce((sum,item)=>sum+Buffer.from(item.data.data.contentBase64,'base64').length,0),first_index:parts.length?Math.min(...indexes):null,last_index:parts.length?Math.max(...indexes):null}];}
    throw new Error(`Unexpected integration SQL: ${query}`);
  }) as unknown as Sql;Object.assign(sql,{begin:async<T>(fn:(tx:Sql)=>Promise<T>)=>fn(sql),json:(value:unknown)=>value});
  try{
    await git(repo,'init','-q');await git(repo,'config','user.name','Fixture');await git(repo,'config','user.email','fixture@example.invalid');await writeFile(fileAbs,'base\n');await git(repo,'add','-A');await git(repo,'commit','-qm','base');const base=(await git(repo,'rev-parse','HEAD')).trim();
    const expected=Buffer.from(('quote " slash \\ tab\t 雪🙂\n').repeat(65_000));await writeFile(fileAbs,expected);await git(repo,'add','-A');await git(repo,'commit','-qm','candidate');const diff=await createDiff(repo,base);const revision=diffRevision(diff),file=diff.files.find(item=>item.path===filePath)!;const chunks=await spoolDiffFile(repo,base,diff.candidateRevision,file,spool);expect(chunks.byteLength).toBeGreaterThan(1_000_000);expect(chunks.encodingUnsupported).toBeUndefined();
    const diffId=`artifact:${runId}:diff:${runId}:1`,parent={id:diffId,projectId,workId,runId,kind:'diff',revision,data:{...diff,files:diff.files.map(item=>item.path===filePath?{...item,textBytes:chunks.byteLength,chunkCount:chunks.chunks,fileSha256:chunks.sha256}:item)}};records.set(diffId,{id:diffId,kind:'artifact',data:parent});
    const run={id:runId,projectId,workId,kind:'implementation',status:'running',generation:1,connectorId,requestedBy:'user-fixture',leaseUntil:new Date(Date.now()+60_000).toISOString()};records.set(runId,{id:runId,kind:'run',data:run});records.set(projectId,{id:projectId,kind:'project',data:{id:projectId}});
    app=await createWorkbenchApp({sql});const identity=createHash('sha256').update(filePath).digest('hex');
    const spooled:Buffer[]=[];for(let index=0;index<chunks.chunks;index++){
      const bytes=await readFile(path.join(spool,identity,String(index)));spooled.push(bytes);const data={parentArtifactId:diffId,projectId,workId,runId,candidateRevision:diff.candidateRevision,baseRevision:base,diffRevision:revision,path:filePath,chunkIndex:index,chunkCount:chunks.chunks,fileSha256:chunks.sha256,fileByteLength:chunks.byteLength,chunkSha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')};const requestId=`diff-file:${diff.candidateRevision}:${identity}:${index}`;const payload={generation:1,kind:'diff_file_chunk',revision,requestId,data};expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1_000_000);
      const post=(value=payload)=>app!.inject({method:'POST',url:`/api/workbench/connector/runs/${runId}/artifacts`,headers:{authorization:`Bearer ${connectorToken}`},payload:value});const first=await post();expect(first.statusCode,first.body).toBe(200);if(index===0){expect((await post()).statusCode).toBe(200);const altered={...data,contentBase64:Buffer.from('different').toString('base64'),chunkSha256:createHash('sha256').update('different').digest('hex')};expect((await post({...payload,data:altered})).statusCode).toBe(409);for(const [change,status] of [[{projectId:'wrong-project'},403],[{workId:'wrong-work'},403],[{runId:'wrong-run'},403],[{candidateRevision:'d'.repeat(40)},409],[{baseRevision:'e'.repeat(40)},409],[{diffRevision:'f'.repeat(64)},403],[{path:'wrong/path.ts'},409],[{fileSha256:'0'.repeat(64)},409],[{chunkIndex:chunks.chunks},403],[{chunkSha256:'0'.repeat(64)},400]] as const)expect((await post({...payload,data:{...data,...change}})).statusCode).toBe(status);}
    }
    const saved=[...records.values()].filter(item=>item.kind==='artifact'&&item.data.kind==='diff_file_chunk');expect(saved).toHaveLength(chunks.chunks);
    const assembled:Buffer[]=[];let cursor:string|undefined;for(let index=0;index<chunks.chunks;index++){const query=new URLSearchParams({path:filePath,revision,...(cursor?{cursor}:{})});const response=await app.inject({method:'GET',url:`/api/workbench/artifacts/${encodeURIComponent(diffId)}/diff-file?${query}`,headers:{cookie}});expect(response.statusCode).toBe(200);const page=response.json();expect(page.chunkIndex).toBe(index);expect(page.incomplete).toBe(index!==chunks.chunks-1);expect(page.integrity).toBe(index===chunks.chunks-1?'verified':'pending');expect(page.complete).toBe(index===chunks.chunks-1);assembled.push(Buffer.from(page.contentBase64,'base64'));cursor=page.nextCursor??undefined;}
    const reconstructed=Buffer.concat(assembled);expect(reconstructed.equals(Buffer.concat(spooled))).toBe(true);expect(createHash('sha256').update(reconstructed).digest('hex')).toBe(chunks.sha256);expect(reconstructed.length).toBe(chunks.byteLength);
  }finally{await app?.close();await rm(temp,{recursive:true,force:true});}
});
