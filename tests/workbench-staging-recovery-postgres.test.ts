import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { Run } from '../src/workbench/types.js';
import { recoveryFixture } from './helpers/staging-recovery-fixture.js';

const url=process.env.WORK_MAP_TEST_DATABASE_URL;
describe.skipIf(!url)('isolated PostgreSQL offline staging recovery API',()=>{
  let sql:ReturnType<typeof postgres>;
  beforeAll(async()=>{
    const u=new URL(url!);
    if(!['127.0.0.1','localhost'].includes(u.hostname)||!decodeURIComponent(u.pathname).endsWith('_test'))throw Error('Recovery tests require isolated loopback *_test resources');
    sql=postgres(url!);
    // The authorized resource is already on schema009. Never migrate/revert a resource here.
    expect((await sql`SELECT to_regclass('wb_records_snapshot_run_evidence_idx') AS name`)[0]!.name).toBeTruthy();
  });
  afterAll(async()=>{await sql?.end();});
  const fixture=()=>recoveryFixture(sql);
  it('transfers once, repeats a lost ACK, and reaches health success on the SAME frozen source without touching OLD history',async()=>{
    const f=await fixture();try{
      const before=await f.readOld(),artifactsBefore=await f.store.runArtifacts(f.projectId,f.old.id);
      // Historical healthy identity must never become recovery expectedCurrent.
      await f.store.put('run',{...f.old,id:`historical_${randomUUID()}`,status:'completed',operation:{...f.old.operation!,phase:'health_passed',stagingReceipt:{...f.offline,operationId:'historical',phase:'health_passed',deploymentId:'deploy_historical'}}});
      const first=await f.recover();f.check(first);const persisted=JSON.parse(first.body); // inject buffers the complete persisted response; discard this ACK before retry
      const saved=f.check(await f.recover()),fresh=saved.run as Run;
      expect(fresh.id).not.toBe(f.old.id);expect(fresh.operation).toMatchObject({recoveryFromRunId:f.old.id,recoveryFromGeneration:1,commitSha:f.offline.commitSha,sourceMergeRunId:f.source.id,expectedCurrentDeploymentId:null,buildReceipt:f.old.operation!.buildReceipt});
      expect(persisted.operationId).toBe(fresh.id);expect((await f.reservation()).runId).toBe(fresh.id);
      const claim=f.check(await f.connector('/claim',{capabilities:f.caps})).run as Run;expect(claim.id).toBe(fresh.id);
      f.check(await f.connector(`/runs/${fresh.id}/staging-authorize`,{generation:claim.generation,effect:'discovery'}));
      const {verifiedAt:_at,verifiedGeneration:_gen,...receipt}=fresh.operation!.buildReceipt!;
      f.check(await f.connector(`/runs/${fresh.id}/staging-build-receipt`,{generation:claim.generation,receipt}));
      for(const effect of ['provenance','transport'])f.check(await f.connector(`/runs/${fresh.id}/staging-authorize`,{generation:claim.generation,effect}));
      f.check(await f.connector(`/runs/${f.old.id}/staging-authorize`,{generation:1,effect:'status'}));
      f.check(await f.connector(`/runs/${f.old.id}/staging-progress`,{generation:1,receipt:f.offline}));
      f.check(await f.connector(`/runs/${f.old.id}/staging-progress`,{generation:1,receipt:{...f.offline,phase:'health_passed',deploymentId:'deploy_stale',activeCommitSha:f.offline.commitSha,activeImageDigest:f.offline.imageDigest}}),409);
      expect((await f.reservation()).runId).toBe(fresh.id);expect(await f.readOld()).toEqual(before);expect(await f.store.runArtifacts(f.projectId,f.old.id)).toEqual(artifactsBefore);
      const health={...f.offline,operationId:fresh.id,phase:'health_passed',deploymentId:`deploy_${fresh.id.slice(4)}`,activeCommitSha:f.offline.commitSha,activeImageDigest:f.offline.imageDigest};
      f.check(await f.connector(`/runs/${fresh.id}/staging-progress`,{generation:claim.generation,receipt:health}));expect(await f.reservation()).toBeUndefined();
      expect(f.check(await f.recover()).run.operation.phase).toBe('health_passed');
    }finally{await f.close();}
  });
  it.each([true,false])('concurrent recovery has one fresh operation (same request=%s)',async same=>{
    const f=await fixture();try{
      const responses=await Promise.all([f.recover('one'),f.recover(same?'one':'two')]);
      expect(responses.map(r=>r.statusCode).sort()).toEqual(same?[200,200]:[200,409]);
      const rows=await f.sql`SELECT data FROM wb_records WHERE project_id=${f.projectId} AND kind='run' AND data->'operation'->>'recoveryFromRunId'=${f.old.id}`;
      expect(rows).toHaveLength(1);expect((await f.reservation()).runId).toBe(rows[0]!.data.id);
      if(same)expect(responses[0]!.json().operationId).toBe(responses[1]!.json().operationId);
    }finally{await f.close();}
  });
  it.each(['generation','target','project','actor','unknown','pending','unstopped','missing receipt','moved reservation','source revoked','source scope','provenance','policy revoked','qa revoked','review revoked'])('rejects %s unchanged',async state=>{
    const f=await fixture();try{
      const old=(await f.readOld())!,delta:Record<string,unknown>={};let routeWork=f.workId,cookie:string|undefined,foreignProject:string|undefined,foreignWork:string|undefined;
      if(state==='generation')delta.generation=2;
      if(state==='target')delta.targetId='other';
      if(state==='project'||state==='source scope'){
        foreignProject=`foreign_${randomUUID()}`;foreignWork=`work_${randomUUID()}`;
        f.ownedForeignRecordIds.push(foreignProject,foreignWork);
        await f.store.put('project',{id:foreignProject});await f.store.put('work',{id:foreignWork,projectId:foreignProject});
        if(state==='project')routeWork=foreignWork;
      }
      if(state==='actor')await f.sql`UPDATE wb_users SET role='member' WHERE id=${f.owner}`;
      if(state==='unknown')old.operation!.stagingReceipt!.phase='unknown';
      if(state==='pending')old.status='running';
      if(state==='unstopped')old.stoppedAt=undefined;
      if(state==='provenance')old.operation!.candidateFingerprint='0'.repeat(64);
      if(['unknown','pending','unstopped','provenance'].includes(state))await f.store.put('run',old);
      if(state==='missing receipt')await f.sql`DELETE FROM wb_records WHERE id=${`artifact:${old.id}:staging:1:target_offline`}`;
      if(state==='moved reservation')await f.sql`UPDATE wb_requests SET result=${f.sql.json({runId:'other'})} WHERE scope=${f.scope}`;
      if(state==='source revoked'||state==='source scope'){
        const source={...f.source,status:state==='source revoked'?'failed':'completed',projectId:state==='source scope'?foreignProject!:f.projectId,workId:state==='source scope'?foreignWork!:f.source.workId};
        const moved=await f.sql`UPDATE wb_records SET project_id=${source.projectId},data=${f.sql.json(source)} WHERE id=${f.source.id} AND kind='run' AND project_id=${f.projectId} RETURNING id`;
        expect(moved.map(row=>row.id)).toEqual([f.source.id]);
      }
      if(state==='policy revoked')await f.sql`UPDATE wb_records SET data=jsonb_set(data,'{data,enabled}','false') WHERE id=${f.deliveryId}`;
      if(state==='qa revoked')await f.sql`UPDATE wb_records SET data=jsonb_set(data,'{data,enabled}','false') WHERE id=${f.qp.id}`;
      if(state==='review revoked')await f.sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"failed"') WHERE id=${f.op.reviewRunId!}`;
      const before=await f.sql`SELECT id,data FROM wb_records WHERE project_id=${f.projectId} ORDER BY id`,reserved=await f.reservation();
      const sourceBefore=await f.sql`SELECT project_id,data FROM wb_records WHERE id=${f.source.id}`;
      const r=await f.recover('bad',delta,routeWork,cookie);expect([401,403,404,409]).toContain(r.statusCode);
      expect(await f.sql`SELECT id,data FROM wb_records WHERE project_id=${f.projectId} ORDER BY id`).toEqual(before);expect(await f.reservation()).toEqual(reserved);
      expect(await f.sql`SELECT project_id,data FROM wb_records WHERE id=${f.source.id}`).toEqual(sourceBefore);
    }finally{await f.close();}
  });
  it.each(['policy','source','qa','review','capability'])('rechecks revoked %s on ACK retry and before fresh effects',async state=>{
    const f=await fixture();try{
      const fresh=f.check(await f.recover()).run as Run;
      const claim=f.check(await f.connector('/claim',{capabilities:f.caps})).run as Run;
      if(state==='policy')await f.sql`UPDATE wb_records SET data=jsonb_set(data,'{data,enabled}','false') WHERE id=${f.deliveryId}`;
      if(state==='source')await f.sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"failed"') WHERE id=${f.source.id}`;
      if(state==='qa')await f.sql`UPDATE wb_records SET data=jsonb_set(data,'{data,enabled}','false') WHERE id=${f.qp.id}`;
      if(state==='review')await f.sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"failed"') WHERE id=${f.op.reviewRunId!}`;
      if(state==='capability')await f.sql`UPDATE wb_connectors SET capabilities='{}' WHERE id=${f.connectorId}`;
      expect([403,409]).toContain((await f.recover()).statusCode);
      expect([403,409]).toContain((await f.connector(`/runs/${fresh.id}/staging-authorize`,{generation:claim.generation,effect:'provenance'})).statusCode);
      expect((await f.reservation()).runId).toBe(fresh.id);
      expect((await f.store.get<Run>('run',fresh.id))!.operation!.effectIntentGeneration).toBeUndefined();
    }finally{await f.close();}
  });
});
