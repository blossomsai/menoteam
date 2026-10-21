import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { recoveryFixture } from './helpers/staging-recovery-fixture.js';

// API contract coverage with substituted persistence. Concurrency/rollback proof belongs to real PG.
function memorySql(){
  const records=new Map<string,{kind:string;projectId:string;data:any}>(),requests=new Map<string,any>();
  let owner:any,session:string,endpoint:any;
  const key=(scope:unknown,id:unknown)=>`${scope}:${id}`;
  const adapter=Object.assign(async(strings:TemplateStringsArray,...v:any[])=>{
    const q=strings.join('?');
    if(q.includes('pg_advisory_xact_lock'))return [];
    if(q.startsWith('INSERT INTO wb_users')){owner={id:v[0],email:v[1],name:'Recovery',role:'owner'};return [];}
    if(q.startsWith('INSERT INTO wb_sessions')){session=v[0];return [];}
    if(q.startsWith('INSERT INTO wb_connectors')){endpoint={id:v[0],digest:v[1],project_ids:v[2],capabilities:v[3],last_seen:new Date().toISOString()};return [];}
    if(q.includes('FROM wb_users'))return v[0]===owner?.id?[owner]:[];
    if(q.includes('FROM wb_sessions'))return v[0]===session?[owner]:[];
    if(q.includes('FROM wb_memberships'))return [{role:'owner'}];
    if(q.includes('FROM wb_connectors'))return q.includes('digest=')&&v[0]!==endpoint.digest?[]:[endpoint];
    if(q.startsWith('UPDATE wb_connectors')){endpoint.capabilities=v[0];return [];}
    if(q.startsWith('INSERT INTO wb_records')){records.set(v[0],{kind:v[1],projectId:v[2],data:structuredClone(v[3])});return [{id:v[0]}];}
    if(q.includes('FROM wb_records')){
      if(q.includes('WHERE id=')){const row=records.get(v[0]);return row?.kind===v[1]?[{data:structuredClone(row.data)}]:[];}
      return [...records.values()].filter(row=>row.kind===v[0]&&(!q.includes('project_id=')||row.projectId===v[1])).map(row=>({data:structuredClone(row.data)}));
    }
    if(q.includes('SELECT result FROM wb_requests')){
      const id=q.includes("request_id='reservation'")?'reservation':q.includes("request_id='canonical'")?'canonical':v[1];
      const result=requests.get(key(v[0],id));return result?[{result:structuredClone(result)}]:[];
    }
    if(q.startsWith('INSERT INTO wb_requests')){
      if(q.includes("'reservation'")){requests.set(key(v[0],'reservation'),structuredClone(v[1]));return [];}
      requests.set(key(v[0],v[1]),structuredClone(v[2]));requests.set(key(v[3],'canonical'),structuredClone(v[4]));return [];
    }
    if(q.startsWith('UPDATE wb_requests')){expect(requests.get(key(v[1],'reservation')).runId).toBe(v[2]);requests.set(key(v[1],'reservation'),structuredClone(v[0]));return [];}
    if(q.startsWith('DELETE FROM wb_requests')){const k=key(v[0],'reservation');if(requests.get(k)?.runId===v[1])requests.delete(k);return [];}
    throw Error(`Unexpected recovery contract query: ${q}`);
  },{json:(value:unknown)=>value,begin:async<T>(fn:(tx:Sql)=>Promise<T>)=>fn(adapter as unknown as Sql)});
  return {sql:adapter as unknown as Sql,records,requests,actor:()=>owner};
}
it('recovers through authenticated production API handlers, preserving OLD and freezing the SAME build/source',async()=>{
  const m=memorySql(),f=await recoveryFixture(m.sql);
  try{
    const old=await f.readOld(),first=f.check(await f.recover()).run;
    expect(first.id).not.toBe(f.old.id);expect(first.operation).toMatchObject({recoveryFromRunId:f.old.id,recoveryFromGeneration:1,expectedCurrentDeploymentId:null,sourceMergeRunId:f.source.id,buildReceipt:f.old.operation!.buildReceipt});
    expect(f.check(await f.recover()).run.id).toBe(first.id);
    f.check(await f.recover('second'),409);
    const artifactId=`artifact:${f.old.id}:staging:1:target_offline`,artifact=structuredClone(m.records.get(artifactId));
    f.check(await f.connector(`/runs/${f.old.id}/staging-progress`,{generation:1,receipt:f.offline}));
    f.check(await f.connector(`/runs/${f.old.id}/staging-progress`,{generation:1,receipt:{...f.offline,phase:'unknown'}}),409);
    expect(await f.readOld()).toEqual(old);expect(m.records.get(artifactId)).toEqual(artifact);expect((await f.reservation()).runId).toBe(first.id);
    const run=m.records.get(first.id)!.data;run.connectorId=f.connectorId;run.generation=1;run.status='running';run.leaseUntil=new Date(Date.now()+60_000).toISOString();
    f.check(await f.connector(`/runs/${first.id}/staging-authorize`,{generation:1,effect:'discovery'}));
    const {verifiedAt:_at,verifiedGeneration:_gen,...receipt}=run.operation.buildReceipt;
    f.check(await f.connector(`/runs/${first.id}/staging-build-receipt`,{generation:1,receipt}));
    for(const effect of ['provenance','transport'])f.check(await f.connector(`/runs/${first.id}/staging-authorize`,{generation:1,effect}));
    f.check(await f.connector(`/runs/${first.id}/staging-progress`,{generation:1,receipt:{...f.offline,operationId:first.id,phase:'health_passed',deploymentId:`deploy_${first.id.slice(4)}`,activeCommitSha:f.offline.commitSha,activeImageDigest:f.offline.imageDigest}}));
    expect(await f.reservation()).toBeUndefined();expect(await f.readOld()).toEqual(old);
    expect(f.check(await f.recover()).run.operation.phase).toBe('health_passed');
  }finally{await f.app.close();}
});
it.each(['pending','unknown','unstopped','generation','target','project','source project','receipt target','active receipt','missing receipt','moved reservation','policy','qa','review','source','provenance','capability','actor'])('rejects %s without transferring or creating an operation',async state=>{
  const m=memorySql(),f=await recoveryFixture(m.sql);
  try{
    const old=m.records.get(f.old.id)!.data,delta:Record<string,unknown>={};let routeWork=f.workId;
    if(state==='pending')old.status='running';
    if(state==='unknown')old.operation.stagingReceipt.phase='unknown';
    if(state==='unstopped')old.stoppedAt=undefined;
    if(state==='generation')delta.generation=2;
    if(state==='target')delta.targetId='foreign';
    if(state==='project'){m.records.set('foreign-project',{kind:'project',projectId:'',data:{id:'foreign-project'}});m.records.set('foreign-work',{kind:'work',projectId:'foreign-project',data:{id:'foreign-work',projectId:'foreign-project'}});routeWork='foreign-work';}
    if(state==='source project')m.records.get(f.source.id)!.data.projectId='foreign';
    if(state==='receipt target')old.operation.stagingReceipt.targetId='foreign';
    if(state==='active receipt')old.operation.stagingReceipt.deploymentId='deploy_active';
    if(state==='actor')m.actor().role='member';
    if(state==='missing receipt')m.records.delete(`artifact:${old.id}:staging:1:target_offline`);
    if(state==='moved reservation')m.requests.set(`${f.scope}:reservation`,{runId:'foreign'});
    if(state==='policy')m.records.get(f.deliveryId)!.data.data.enabled=false;
    if(state==='qa')m.records.get(f.qp.id)!.data.data.enabled=false;
    if(state==='review')m.records.get(f.op.reviewRunId!)!.data.status='failed';
    if(state==='source')m.records.get(f.source.id)!.data.status='failed';
    if(state==='provenance')old.operation.candidateFingerprint='0'.repeat(64);
    if(state==='capability')await m.sql`UPDATE wb_connectors SET capabilities=${m.sql.json({})}`;
    const before=structuredClone([...m.records]),reserved=await f.reservation();
    const response=await f.recover('bad',delta,routeWork);
    expect([401,403,409]).toContain(response.statusCode);expect([...m.records]).toEqual(before);expect(await f.reservation()).toEqual(reserved);
  }finally{await f.app.close();}
});
it.each(['policy','source','qa','review'])('ACK retry fails closed after %s revocation',async state=>{
  const m=memorySql(),f=await recoveryFixture(m.sql);
  try{
    const fresh=f.check(await f.recover()).run;
    if(state==='policy')m.records.get(f.deliveryId)!.data.data.enabled=false;
    if(state==='source')m.records.get(f.source.id)!.data.status='failed';
    if(state==='qa')m.records.get(f.qp.id)!.data.data.enabled=false;
    if(state==='review')m.records.get(f.op.reviewRunId!)!.data.status='failed';
    expect([403,409]).toContain((await f.recover()).statusCode);expect((await f.reservation()).runId).toBe(fresh.id);
    Object.assign(m.records.get(fresh.id)!.data,{connectorId:f.connectorId,generation:1,status:'running',leaseUntil:new Date(Date.now()+60_000).toISOString()});
    expect([403,409]).toContain((await f.connector(`/runs/${fresh.id}/staging-authorize`,{generation:1,effect:'provenance'})).statusCode);
    expect(m.records.get(fresh.id)!.data.operation.effectIntentGeneration).toBeUndefined();
  }finally{await f.app.close();}
});

it('preserves normal pre-transfer status reconciliation across a new generation',async()=>{
  const m=memorySql(),f=await recoveryFixture(m.sql);
  try{
    const old=m.records.get(f.old.id)!.data;old.generation=2;old.status='running';old.stoppedAt=undefined;
    f.check(await f.connector(`/runs/${old.id}/staging-progress`,{generation:2,receipt:f.offline}));
    expect(m.records.get(`artifact:${old.id}:staging:2:target_offline`)!.data.data.receipt).toEqual(f.offline);
    expect((await f.reservation()).runId).toBe(old.id);
  }finally{await f.app.close();}
});
