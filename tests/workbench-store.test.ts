import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { WorkbenchStore } from '../src/workbench/store.js';

it('filters child diff chunks before metadata and read_run artifact limits so QA stays visible',async()=>{
  const projectId='project-fixture',runId='run-fixture';
  const records=[...Array.from({length:205},(_,index)=>({id:`chunk-${index}`,projectId,runId,kind:'diff_file_chunk',createdAt:`${String(index).padStart(3,'0')}`,data:{chunkIndex:index}})),{id:'qa-evidence',projectId,runId,kind:'qa',createdAt:'999',data:{checks:[{name:'required',exitCode:0}]}}];
  const queries:string[]=[];
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?');queries.push(query);
    if(query.includes('LIMIT 200'))return records.filter(item=>(values[0] as string[]).includes(item.projectId)&&item.kind!=='diff_file_chunk').slice(-200).reverse().map(data=>({data}));
    if(query.includes('LIMIT 100'))return records.filter(item=>item.projectId===values[0]&&item.runId===values[1]&&(!query.includes("data->>'kind'<>'diff_file_chunk'")||item.kind!=='diff_file_chunk')).slice().sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,100).map(data=>({data}));
    throw new Error(`Unexpected SQL in focused store test: ${query}`);
  }) as unknown as Sql;
  const store=new WorkbenchStore(sql);
  const metadata=await store.artifactMetadata([projectId]);
  const runArtifacts=await store.runArtifacts(projectId,runId);
  expect(metadata.map(item=>item.id)).toContain('qa-evidence');
  expect(metadata.some(item=>item.kind==='diff_file_chunk')).toBe(false);
  expect(runArtifacts.map(item=>item.id)).toContain('qa-evidence');
  expect(runArtifacts.some(item=>item.kind==='diff_file_chunk')).toBe(false);
  for(const query of queries){expect(query.indexOf("data->>'kind'<>'diff_file_chunk'")).toBeGreaterThanOrEqual(0);expect(query.indexOf("data->>'kind'<>'diff_file_chunk'")).toBeLessThan(query.lastIndexOf('LIMIT'));}
});

it('bounds latest Work diff and assigned candidate QA reads without loading thousands of child payloads',async()=>{
  const projectId='p',workId='w',runId='candidate';
  const artifacts=[...Array.from({length:5000},(_,index)=>({id:`chunk-${index}`,projectId,workId,runId,kind:'diff_file_chunk',data:{contentBase64:'x'.repeat(64)}})),{id:'old-diff',projectId,workId,runId,kind:'diff',revision:'old',data:{candidateRevision:'old-sha',patch:'old patch',files:[]}},{id:'latest-diff',projectId,workId,runId,kind:'diff',revision:'latest',data:{candidateRevision:'latest-sha',patch:'large patch',files:[]}},{id:'assigned-qa',projectId,workId,runId,kind:'qa',data:{checks:[]}},{id:'other-qa',projectId,workId:'other',runId,kind:'qa',data:{checks:[]}}];
  const queries:string[]=[];let loadedChunks=0;
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?');queries.push(query);
    if(query.includes("data->>'kind'='diff'")){
      expect(query).toContain('LIMIT 1');expect(query).toContain("jsonb_build_object('candidateRevision'");
      const latest=artifacts.filter(item=>item.projectId===values[0]&&item.workId===values[1]&&item.kind==='diff').at(-1)!;
      return [{data:{...latest,data:{candidateRevision:(latest.data as {candidateRevision:string}).candidateRevision}}}];
    }
    if(query.includes("data->>'kind'='qa'")){
      expect(query).toContain('LIMIT 100');return artifacts.filter(item=>item.projectId===values[0]&&item.workId===values[1]&&item.runId===values[2]&&item.kind==='qa'&&(values[3] as string[]).includes(item.id)).map(data=>({data}));
    }
    loadedChunks++;throw new Error('Unbounded artifact query is forbidden in this regression');
  }) as unknown as Sql;
  const store=new WorkbenchStore(sql),latest=await store.latestWorkDiff(projectId,workId);
  expect(latest).toMatchObject({id:'latest-diff',data:{candidateRevision:'latest-sha'}});expect(latest?.data).not.toHaveProperty('patch');expect(latest?.data).not.toHaveProperty('files');
  expect((await store.assignedQaArtifacts(projectId,workId,runId,['assigned-qa','other-qa','chunk-1'])).map(item=>item.id)).toEqual(['assigned-qa']);expect(loadedChunks).toBe(0);
  for(const query of queries)expect(query.indexOf("data->>'kind'=")).toBeLessThan(query.lastIndexOf('LIMIT'));
});


it('excludes internal diff payloads in scoped and global artifact lists while preserving legacy and other records',async()=>{
  const rows=[{id:'chunk',projectId:'p',kind:'artifact',data:{id:'chunk',kind:'diff_file_chunk',contentBase64:'large'}},{id:'diff',projectId:'p',kind:'artifact',data:{id:'diff',kind:'diff'}},{id:'qa',projectId:'q',kind:'artifact',data:{id:'qa',kind:'qa'}},{id:'legacy',projectId:'p',kind:'artifact',data:{id:'legacy'}},{id:'run',projectId:'p',kind:'run',data:{id:'run',kind:'diff_file_chunk'}}];
  let loadedChunks=0;
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?'),scoped=query.includes('project_id=');
    expect(query).toContain("OR data->>'kind' IS DISTINCT FROM 'diff_file_chunk'");
    expect(query).toContain('ORDER BY updated_at,id');
    const kind=values[0],project=scoped?values[1]:undefined;
    return rows.filter(row=>row.kind===kind&&(project===undefined||row.projectId===project)&&(kind!=='artifact'||row.data.kind!=='diff_file_chunk')).map(row=>{if(row.id==='chunk')loadedChunks++;return {data:row.data};});
  }) as unknown as Sql;
  const store=new WorkbenchStore(sql);
  expect((await store.list<{id:string}>('artifact','p')).map(row=>row.id)).toEqual(['diff','legacy']);
  expect((await store.list<{id:string}>('artifact')).map(row=>row.id)).toEqual(['diff','qa','legacy']);
  expect((await store.list<{id:string}>('run','p')).map(row=>row.id)).toEqual(['run']);
  expect((await store.list<{id:string}>('run')).map(row=>row.id)).toEqual(['run']);
  expect(loadedChunks).toBe(0);
});
