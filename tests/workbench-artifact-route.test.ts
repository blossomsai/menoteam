import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';

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
