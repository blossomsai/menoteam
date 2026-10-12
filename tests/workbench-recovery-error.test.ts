import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';
import type { Run } from '../src/workbench/types.js';

const oldError='Connector confirmed unexpected process stop; reconciliation required';
const cookie='menoteam_session=fixture-session';
const authorization='Bearer fixture-connector';
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
async function fixture(overrides:Partial<Run>={}){
  const member={id:'owner',email:'fixture@example.invalid',name:'Fixture',role:'owner'};
  const run:Run={id:'run-fixture',projectId:'project-fixture',requestedBy:member.id,connectorId:'connector-fixture',kind:'master',prompt:'Recover',model:'gpt-6.1-sol',reasoning:'medium',status:'interrupted',generation:1,stoppedAt:new Date().toISOString(),error:oldError,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...overrides};
  const records=new Map<string,any>([['run:run-fixture',run],['project:project-fixture',{id:'project-fixture',name:'Fixture',instructions:''}]]);
  const endpoint={id:'connector-fixture',project_ids:['project-fixture'],last_seen:new Date().toISOString(),capabilities:{codexAppServer:true,localWorktrees:true,models:['gpt-6.1-sol']}};
  // Exercise production routes and guards; only persistence is an isolated in-memory adapter.
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?');
    if(query.includes('pg_advisory_xact_lock'))return [];
    if(query.includes('FROM wb_sessions'))return values[0]===digest('fixture-session')?[member]:[];
    if(query.includes('FROM wb_users'))return values[0]===member.id?[member]:[];
    if(query.includes('FROM wb_connectors'))return values[0]===endpoint.id||values[0]===digest('fixture-connector')?[copy(endpoint)]:[];
    if(query.startsWith('UPDATE wb_connectors')){endpoint.capabilities=copy(values[0] as typeof endpoint.capabilities);endpoint.last_seen=new Date().toISOString();return [];}
    if(query.startsWith('INSERT INTO wb_records')){records.set(`${values[1]}:${values[0]}`,copy(values[3]));return [{id:values[0]}];}
    if(query.includes('FROM wb_records WHERE id=')){const data=records.get(`${values[1]}:${values[0]}`);return data?[{data:copy(data)}]:[];}
    if(query.includes('FROM wb_records WHERE kind='))return [...records.entries()].filter(([key,data])=>key.startsWith(`${values[0]}:`)&&(values[1]===undefined||data.projectId===values[1])).map(([,data])=>({data:copy(data)}));
    throw new Error('Unexpected isolated persistence query');
  }) as unknown as Sql;
  sql.json=(value=>copy(value)) as typeof sql.json;
  sql.begin=(async fn=>{
    const before=copy([...records]);
    try{return await (fn as Function)(sql);}catch(error){records.clear();for(const [key,data] of before)records.set(key,data);throw error;}
  }) as typeof sql.begin;
  const app=await createWorkbenchApp({sql});
  const human=(action:'reconcile'|'resume',signedIn=true)=>app.inject({method:'POST',url:`/api/workbench/runs/${run.id}/${action}`,headers:signedIn?{cookie}:{},payload:action==='reconcile'?{stopped:true}:{}});
  const claim=()=>app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization},payload:{capabilities:endpoint.capabilities}});
  return {app,human,claim,saved:()=>copy(records.get('run:run-fixture')) as Run};
}

it.each(['interrupted','paused'] as const)('clears the old error only after successful %s recovery and claim, preserving a subsequent real failure',async status=>{
  const f=await fixture({status});
  try{
    const queued=await f.human(status==='interrupted'?'reconcile':'resume');
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toMatchObject({status:'queued',generation:1});
    expect(queued.json().error).toBeUndefined();expect(queued.json().stoppedAt).toBeUndefined();
    expect(f.saved().error).toBeUndefined();
    const claimed=await f.claim();expect(claimed.statusCode).toBe(200);
    expect(claimed.json().run).toMatchObject({status:'running',generation:2});
    expect(claimed.json().run.error).toBeUndefined();expect(f.saved().error).toBeUndefined();
    const failed=await f.app.inject({method:'POST',url:'/api/workbench/connector/runs/run-fixture/complete',headers:{authorization},payload:{generation:2,error:'New native failure'}});
    expect(failed.statusCode).toBe(200);expect(failed.json()).toMatchObject({status:'failed',error:'New native failure'});
    expect((await f.claim()).statusCode).toBe(204);expect(f.saved()).toMatchObject({status:'failed',error:'New native failure'});
  }finally{await f.app.close();}
});

it('clears a historical queued error when the Connector successfully claims the next generation',async()=>{
  const f=await fixture({status:'queued',stoppedAt:undefined});
  try{const claimed=await f.claim();expect(claimed.statusCode).toBe(200);expect(claimed.json().run).toMatchObject({status:'running',generation:2});expect(claimed.json().run.error).toBeUndefined();expect(f.saved().error).toBeUndefined();}finally{await f.app.close();}
});

it('preserves errors when recovery lacks authentication or confirmed stop proof',async()=>{
  const f=await fixture({stoppedAt:undefined});
  try{
    expect((await f.human('reconcile',false)).statusCode).toBe(401);
    expect(f.saved()).toMatchObject({status:'interrupted',error:oldError});
    expect((await f.human('reconcile')).statusCode).toBe(409);
    expect(f.saved()).toMatchObject({status:'interrupted',error:oldError});
  }finally{await f.app.close();}
});

it('preserves recovery errors and records genuine selection failures instead of clearing them',async()=>{
  const interrupted=await fixture({model:'unavailable-model'});
  const queued=await fixture({status:'queued',stoppedAt:undefined,model:'unavailable-model'});
  try{
    expect((await interrupted.human('reconcile')).statusCode).toBe(409);
    expect(interrupted.saved()).toMatchObject({status:'interrupted',error:oldError});
    expect((await queued.claim()).statusCode).toBe(204);
    expect(queued.saved()).toMatchObject({status:'failed',error:'Selected Connector model is unavailable'});
  }finally{await interrupted.app.close();await queued.app.close();}
});
