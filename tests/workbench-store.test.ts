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
