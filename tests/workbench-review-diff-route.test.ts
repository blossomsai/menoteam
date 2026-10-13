import { expect,it } from 'vitest';
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';

it('authorizes current reviewer pages using bounded Work metadata without scanning project chunk payloads',async()=>{
  const projectId='project-fixture',workId='work-fixture',candidateId='candidate-fixture',reviewerId='reviewer-fixture',connectorId='connector-fixture',connectorToken='fixture-token',revision='a'.repeat(64),sha='b'.repeat(40),base='c'.repeat(40),filePath='src/bound.ts';
  const bytes=Buffer.from('@@ -0,0 +1 @@\n+bound page\n'),fileSha256=createHash('sha256').update(bytes).digest('hex');
  const parent={id:'diff-fixture',kind:'diff',projectId,workId,runId:candidateId,revision,data:{baseRevision:base,candidateRevision:sha,files:[{path:filePath,binary:false,chunkCount:1,textBytes:bytes.length,fileSha256}]}};
  const chunk={id:'bound-chunk',kind:'diff_file_chunk',projectId,workId,runId:candidateId,revision,data:{parentArtifactId:parent.id,projectId,workId,runId:candidateId,diffRevision:revision,candidateRevision:sha,baseRevision:base,path:filePath,chunkIndex:0,chunkCount:1,fileByteLength:bytes.length,fileSha256,chunkSha256:fileSha256,contentBase64:bytes.toString('base64')}};
  const candidate={id:candidateId,kind:'implementation',projectId,workId,status:'completed'};
  const reviewer={id:reviewerId,kind:'review',projectId,workId,targetRunId:candidateId,connectorId,model:'gpt-6.1-sol',requestedBy:'user-fixture',status:'running',generation:1,leaseUntil:new Date(Date.now()+90_000).toISOString(),reviewBinding:{candidateRunId:candidateId,commitSha:sha,candidateFingerprint:'d'.repeat(64),diffArtifactId:parent.id,diffRevision:revision,qaArtifactIds:[]}};
  const records=new Map<string,{kind:string;data:any}>([[projectId,{kind:'project',data:{id:projectId,repositoryUrl:''}}],[workId,{kind:'work',data:{id:workId,projectId,profileId:''}}],[candidateId,{kind:'run',data:candidate}],[reviewerId,{kind:'run',data:reviewer}],[parent.id,{kind:'artifact',data:parent}],[chunk.id,{kind:'artifact',data:chunk}]]);
  for(let index=0;index<5000;index++)records.set(`other-chunk-${index}`,{kind:'artifact',data:{...chunk,id:`other-chunk-${index}`,data:{...chunk.data,path:`src/other-${index}`,contentBase64:'eA=='}}});
  const requests=new Map<string,unknown>(),queries:string[]=[],loadedChunks:string[]=[];let latest=parent;
  let transactionDepth=0,onBatch:(()=>void)|undefined;
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?');queries.push(query);
    if(query.includes('pg_advisory_xact_lock'))return [];
    if(query.includes('FROM wb_bridge_tokens'))return [];
    if(query.includes('FROM wb_connectors'))return query.includes('digest')&&values[0]!==digest(connectorToken)?[]:[{id:connectorId,project_ids:[projectId],last_seen:new Date().toISOString(),capabilities:{models:['gpt-6.1-sol'],codexAppServer:true,localWorktrees:true}}];
    if(query.includes('FROM wb_users'))return [{id:'user-fixture',email:'fixture@example.invalid',name:'Fixture',role:'owner'}];
    if(query.includes('FROM wb_requests'))return requests.has(String(values[1]))?[{result:requests.get(String(values[1]))}]:[];
    if(query.includes('INSERT INTO wb_requests')){requests.set(String(values[1]),values[2]);return [];}
    if(query.includes('WHERE id=? AND kind=?')){const row=records.get(String(values[0]));return row?.kind===values[1]?[{data:row.data}]:[];}
    if(query.includes("jsonb_build_object('candidateRevision'")){
      expect(query).toContain('LIMIT 1');expect(query).toContain("jsonb_build_object('candidateRevision'");expect(values).toEqual([projectId,workId]);
      return [{data:{...latest,data:{candidateRevision:latest.data.candidateRevision}}}];
    }
    if(query.includes("chunkIndex'=?")){
      const matching=[...records.values()].find(row=>row.kind==='artifact'&&row.data.kind==='diff_file_chunk'&&row.data.projectId===values[0]&&row.data.data.parentArtifactId===values[1]&&row.data.data.path===values[2]&&String(row.data.data.chunkIndex)===values[3]);
      if(matching){loadedChunks.push(matching.data.id);return [{data:matching.data}];}return [];
    }
    if(query.includes('LIMIT 4')){expect(transactionDepth).toBe(0);expect(query).toContain('ORDER BY');if(onBatch)onBatch();return [{data:chunk}];}
    if(query.includes('LIMIT 200')){
      expect(query).toContain("data->>'kind'<>'diff_file_chunk'");return [{data:parent}];
    }
    if(query.includes('LIMIT 101')||values[0]==='setting')return [];
    throw new Error(`Unbounded or unexpected reviewer SQL: ${query}`);
  }) as unknown as Sql;Object.assign(sql,{begin:async<T>(fn:(tx:Sql)=>Promise<T>)=>{transactionDepth++;try{return await fn(sql);}finally{transactionDepth--;}},json:(value:unknown)=>value});
  const app=await createWorkbenchApp({sql});
  const tool=(action:string,input:Record<string,unknown>,requestId:string)=>app.inject({method:'POST',url:`/api/workbench/connector/runs/${reviewerId}/tools`,headers:{authorization:`Bearer ${connectorToken}`},payload:{generation:1,action,input,requestId}});
  try{
    const work=await tool('read_work',{workId},'read-work');expect(work.statusCode,work.body).toBe(200);expect(work.json().reviewAssignment.currentRequiredQaValidation.candidateCurrent).toBe(true);expect(loadedChunks).toHaveLength(0);
    const input={diffArtifactId:parent.id,revision,path:filePath};const page=await tool('read_diff_file',input,'same-page-request');expect(page.statusCode,page.body).toBe(200);expect(page.json().integrity).toBe('verified');expect(Buffer.from(page.json().contentBase64,'base64').equals(bytes)).toBe(true);expect(loadedChunks).toEqual(['bound-chunk']);
    expect((await tool('read_diff_file',{...input,path:'src/other-not-present'},'wrong-path')).statusCode).toBe(404);expect((await tool('read_diff_file',{...input,revision:'e'.repeat(64)},'wrong-assignment')).statusCode).toBe(403);
    onBatch=()=>{reviewer.generation++;};expect((await tool('read_diff_file',input,'revoked-during-read')).statusCode).toBe(409);reviewer.generation--;onBatch=undefined;
    latest={...parent,id:'diff-newer',revision:'f'.repeat(64)};expect((await tool('read_diff_file',input,'same-page-request')).statusCode).toBe(409);expect(loadedChunks).toEqual(['bound-chunk','bound-chunk']);
    expect(queries.some(query=>query.includes('WHERE kind=? AND project_id=? ORDER BY updated_at,id')&&query.includes('wb_records'))).toBe(false);
  }finally{await app.close();}
});
