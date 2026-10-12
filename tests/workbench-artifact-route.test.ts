import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';
import { createHash } from 'node:crypto';

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
