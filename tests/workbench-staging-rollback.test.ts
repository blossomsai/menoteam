import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';
import type { Run } from '../src/workbench/types.js';
import { runStagingOperation, type StagingReceipt, type StagingRequest } from '../src/connector/staging-deploy.js';
import { qaPolicyFixture } from './helpers/local-qa-fixture.js';

const repositoryUrl='https://github.com/blossomsai/menoteam';
const target={sshHost:'fixture.invalid',sshUser:'fixture',identityFile:'/fixture/key',knownHostsFile:'/fixture/hosts',hostKeyFingerprint:'fixture',imageRepository:'ghcr.io/blossomsai/menoteam-work-map'};

async function fixture(sameWork=false){
  const stamp=(offset:number)=>new Date(Date.now()-offset).toISOString();
  const source=(name:string,sha:string,workId:string):Run=>{
    const candidateSha=(name==='a'?'1':'2').repeat(40),revision=createHash('sha256').update('c'.repeat(40)).update('\0').update(candidateSha).digest('hex');
    return {id:`source_${name}`,projectId:'project',workId,kind:'delivery',prompt:'',requestedBy:`owner-${name}`,model:'internal',reasoning:'none',status:'completed',generation:1,connectorId:'connector',targetConnectorId:'connector',targetRunId:`candidate_${name}`,targetRevision:revision,createdAt:stamp(180_000),updatedAt:stamp(180_000),
      operation:{action:'merge_pr',phase:'merged',actorId:`owner-${name}`,candidateRunId:`candidate_${name}`,candidateRevision:revision,artifactRevision:revision,candidateFingerprint:sha.repeat(64),commitSha:candidateSha,repositoryUrl,baseRevision:'c'.repeat(40),baseBranch:'main',remoteBranch:`codex/${name}`,workTitle:`Work ${name}`,changeSummary:`Change ${name}`,qaStatus:'current',reviewRunId:`review_${name}`,qaPolicySnapshot:qaPolicyFixture('project',repositoryUrl,`qa-${name}`),external:{mergeSha:sha.repeat(40)}}};
  };
  const sourceA=source('a','a','work_a'),sourceB=source('b','b',sameWork?'work_a':'work_b');
  const verified=(s:Run,offset:number,previous?:Run):Run=>{
    const id=`run_${randomUUID()}`,checkedAt=stamp(offset),commitSha=s.operation!.external!.mergeSha!,imageDigest=`sha256:${s===sourceA?'d'.repeat(64):'e'.repeat(64)}`;
    return {...s,id,createdAt:checkedAt,updatedAt:checkedAt,operation:{...s.operation!,action:'deploy_staging',phase:'health_passed',commitSha,sourceMergeRunId:s.id,targetId:'staging',targetPolicyVersion:'current-policy',imageDigest,buildStatus:'verified',buildReceipt:{schemaVersion:1,repository:'blossomsai/menoteam',repositoryId:'123',workflowPath:'.github/workflows/build-workbench-image.yml',runId:s===sourceA?10:20,runAttempt:1,artifactId:s===sourceA?11:21,archiveDigest:`sha256:${'f'.repeat(64)}`,artifactExpiresAt:stamp(-86_400_000),sourceSha:commitSha,imageRepository:'ghcr.io/blossomsai/menoteam-work-map',imageDigest,runUrl:`https://github.com/blossomsai/menoteam/actions/runs/${s===sourceA?10:20}`,verifiedAt:checkedAt,verifiedGeneration:1},stagingReceipt:{operationId:id,targetId:'staging',phase:'health_passed',deploymentId:s===sourceA?'deploy_a':'deploy_b',commitSha,imageDigest,activeCommitSha:commitSha,activeImageDigest:imageDigest,checkedAt,...(previous?{previousDeploymentId:previous.operation!.stagingReceipt!.deploymentId,previousImageDigest:previous.operation!.imageDigest}:{})}}};
  };
  const a=verified(sourceA,120_000),b=verified(sourceB,60_000,a);
  const records=new Map<string,{kind:string;data:any}>();
  const put=(kind:string,data:any)=>records.set(data.id,{kind,data:structuredClone(data)});
  put('project',{id:'project',repositoryUrl});
  for(const id of new Set([sourceA.workId!,sourceB.workId!]))put('work',{id,projectId:'project',title:id,status:'done',revision:1,profileId:'',sources:[]});
  for(const run of [sourceA,sourceB,a,b])put('run',run);
  put('setting',{id:'policy',kind:'connection',projectId:'project',updatedAt:'current-policy',data:{provider:'github',purpose:'delivery',url:repositoryUrl,configuredBy:'owner-b',allowStagingDeploy:true,stagingTargets:['staging']}});
  const users=new Map(['a','b'].map(name=>[`owner-${name}`,{id:`owner-${name}`,role:'owner',email:`${name}@fixture.invalid`,name}]));
  const capabilities={git:true,githubWrite:true,deliveryActions:['deploy_staging','rollback_staging'],deploymentTargets:['staging'],runKinds:['delivery']};
  const endpoint={id:'connector',project_ids:['project'],capabilities,last_seen:new Date().toISOString()};
  const requests=new Map<string,any>();
  const key=(scope:unknown,id:unknown)=>`${scope}:${id}`;
  // Only persistence is substituted: use production HTTP/auth/claim/effect/receipt handlers.
  const adapter=Object.assign(async(strings:TemplateStringsArray,...values:any[])=>{
    const query=strings.join('?');
    if(query.includes('pg_advisory_xact_lock'))return [];
    if(query.includes('FROM wb_sessions'))return values[0]===digest('session')?[users.get('owner-b')]:[];
    if(query.includes('FROM wb_users'))return users.has(values[0])?[users.get(values[0])]:[];
    if(query.includes('FROM wb_memberships'))return [{role:'owner'}];
    if(query.includes('FROM wb_connectors'))return query.includes('digest=')&&values[0]!==digest('connector-token')?[]:[endpoint];
    if(query.startsWith('UPDATE wb_connectors')){endpoint.capabilities=values[0];return [];}
    if(query.includes('FROM wb_records')){
      if(query.includes('WHERE id=')){const row=records.get(values[0]);return row?.kind===values[1]?[{data:structuredClone(row.data)}]:[];}
      return [...records.values()].filter(row=>row.kind===values[0]&&(!query.includes('project_id=')||row.data.projectId===values[1])).map(row=>({data:structuredClone(row.data)}));
    }
    if(query.startsWith('INSERT INTO wb_records')){put(values[1],values[3]);return [{id:values[0]}];}
    if(query.includes('SELECT result FROM wb_requests')){const id=query.includes("request_id='canonical'")?'canonical':query.includes("request_id='reservation'")?'reservation':values[1];const result=requests.get(key(values[0],id));return result?[{result:structuredClone(result)}]:[];}
    if(query.startsWith('INSERT INTO wb_requests')){
      requests.set(key(values[0],'reservation'),structuredClone(values[1]));requests.set(key(values[2],values[3]),structuredClone(values[4]));requests.set(key(values[5],'canonical'),structuredClone(values[6]));return [];
    }
    if(query.startsWith('DELETE FROM wb_requests')){const reservation=requests.get(key(values[0],'reservation'));if(reservation)expect(reservation.runId).toBe(values[1]);requests.delete(key(values[0],'reservation'));return [];}
    throw new Error(`Unexpected rollback fixture query: ${query}`);
  },{json:(value:unknown)=>value,begin:async<T>(fn:(tx:Sql)=>Promise<T>):Promise<T>=>fn(adapter as unknown as Sql)});
  const app=await createWorkbenchApp({sql:adapter as unknown as Sql});
  const rollback=()=>app.inject({method:'POST',url:`/api/workbench/works/${sourceB.workId}/staging/rollback`,headers:{cookie:'menoteam_session=session'},payload:{deploymentRunId:b.id,targetId:'staging',requestId:'rollback-a'}});
  const connector=(path:string,payload:unknown)=>app.inject({method:'POST',url:`/api/workbench/connector${path}`,headers:{authorization:'Bearer connector-token'},payload:payload as never});
  const queue=async()=>{const response=await rollback();expect(response.statusCode,response.body).toBe(200);return response.json().run as Run;};
  const claim=async()=>{const response=await connector('/claim',{capabilities});expect(response.statusCode,response.body).toBe(200);return response.json().run as Run;};
  return {app,records,requests,sourceA,sourceB,a,b,users,endpoint,rollback,connector,queue,claim};
}

it.each([false,true])('rolls A back after B with A provenance and B request/CAS through real API handlers (same Work=%s)',async sameWork=>{
  const f=await fixture(sameWork);
  try{
    const queued=await f.queue(),s=f.sourceA.operation!,a=f.a.operation!;
    expect(queued).toMatchObject({projectId:'project',workId:f.sourceB.workId,requestedBy:'owner-b',targetRunId:f.sourceA.targetRunId,targetRevision:f.sourceA.targetRevision,operation:{action:'rollback_staging',actorId:'owner-b',targetPolicyVersion:'current-policy',expectedCurrentDeploymentId:'deploy_b',sourceMergeRunId:f.sourceA.id,commitSha:a.commitSha,imageDigest:a.imageDigest,candidateRunId:s.candidateRunId,candidateRevision:s.candidateRevision,candidateFingerprint:s.candidateFingerprint,reviewRunId:s.reviewRunId,qaPolicySnapshot:s.qaPolicySnapshot,buildReceipt:a.buildReceipt}});
    expect(queued.operation!.external).toBeUndefined();expect(queued.operation!.effectIntentGeneration).toBeUndefined();
    const claimed=await f.claim();expect(claimed.id).toBe(queued.id);
    const op=claimed.operation!,request:StagingRequest={action:'rollback',operationId:claimed.id,targetId:'staging',commitSha:op.commitSha,imageDigest:op.imageDigest!,previousDeploymentId:op.previousDeploymentId,expectedCurrentDeploymentId:op.expectedCurrentDeploymentId!};
    const order:string[]=[];
    const authorize=async(effect:'provenance'|'transport')=>{order.push(effect);const response=await f.connector(`/runs/${claimed.id}/staging-authorize`,{generation:claimed.generation,effect});expect(response.statusCode,response.body).toBe(200);expect(response.json().action).toBe('rollback');};
    const receipt=await runStagingOperation('staging',target,request,undefined,async(_target,input)=>{order.push('mock-transport');expect(input).toEqual(request);return {operationId:input.operationId,targetId:input.targetId,commitSha:input.commitSha,imageDigest:input.imageDigest,phase:'unknown',checkedAt:new Date().toISOString()};},async args=>{order.push('attestation');expect(args).toContain(a.commitSha);expect(args).toContain(`oci://${target.imageRepository}@${a.imageDigest}`);return JSON.stringify([{verificationResult:{statement:{subject:[{name:target.imageRepository,digest:{sha256:a.imageDigest!.slice(7)}}]}}}]);},authorize,async()=>{});
    expect(order).toEqual(['attestation','provenance','transport','mock-transport']);
    const progress=(receipt:StagingReceipt)=>f.connector(`/runs/${claimed.id}/staging-progress`,{generation:claimed.generation,receipt});
    // Strict receipt schema accepts only the helper receipt fields.
    const unknown={operationId:receipt.operationId,targetId:receipt.targetId,commitSha:receipt.commitSha,imageDigest:receipt.imageDigest,phase:receipt.phase,checkedAt:receipt.checkedAt};
    expect((await progress(unknown)).statusCode).toBe(200);
    expect((await f.queue()).id).toBe(queued.id);
    const policy=f.records.get('policy')!.data;policy.data.enabled=false;f.users.delete('owner-b');
    const status=await f.connector(`/runs/${claimed.id}/staging-authorize`,{generation:claimed.generation,effect:'status'});expect(status.statusCode,status.body).toBe(200);expect(status.json().action).toBe('status');
    const terminal:StagingReceipt={...unknown,phase:'rolled_back',deploymentId:'deploy_a',previousDeploymentId:'deploy_b',activeCommitSha:a.commitSha,activeImageDigest:a.imageDigest};
    expect((await progress({...terminal,deploymentId:'deploy_wrong'})).statusCode).toBe(409);
    const saved=await progress(terminal);expect(saved.statusCode,saved.body).toBe(200);expect(saved.json().run.operation).toMatchObject({phase:'rolled_back',sourceMergeRunId:f.sourceA.id,buildReceipt:a.buildReceipt,candidateFingerprint:s.candidateFingerprint});
    const repeated=await progress(terminal);expect(repeated.statusCode,repeated.body).toBe(200);expect(repeated.json().artifact).toEqual(saved.json().artifact);
    expect(f.requests.has('staging-target:project:staging:reservation')).toBe(false);
  }finally{await f.app.close();}
});

it.each(['project','target','source project','source Work','receipt target','receipt operation','unverified','future','candidate','build digest'])('rejects invalid previous %s through the rollback API',async field=>{
  const f=await fixture();
  try{
    const a=f.records.get(f.a.id)!.data as Run,s=f.records.get(f.sourceA.id)!.data as Run;
    if(field==='project')a.projectId='foreign';
    if(field==='target')a.operation!.targetId='other';
    if(field==='source project')s.projectId='foreign';
    if(field==='source Work')s.workId=f.sourceB.workId;
    if(field==='receipt target')a.operation!.stagingReceipt!.targetId='other';
    if(field==='receipt operation')a.operation!.stagingReceipt!.operationId=f.b.id;
    if(field==='unverified')a.operation!.phase='deploy_unknown';
    if(field==='future')a.createdAt=new Date(Date.now()+60_000).toISOString();
    if(field==='candidate')a.operation!.candidateFingerprint='0'.repeat(64);
    if(field==='build digest')a.operation!.buildReceipt!.imageDigest=f.b.operation!.imageDigest!;
    const response=await f.rollback();expect(response.statusCode,response.body).toBe(409);expect(f.requests.size).toBe(0);
  }finally{await f.app.close();}
});

it.each(['project','target','source project','source Work','source run','previous source run','deployment ID','receipt operation','candidate','build receipt','target revision','CAS','current CAS'])('rejects queued rollback %s tampering before mutation intent',async field=>{
  const f=await fixture();
  try{
    const queued=await f.queue(),a=f.records.get(f.a.id)!.data as Run,s=f.records.get(f.sourceA.id)!.data as Run,run=f.records.get(queued.id)!.data as Run;
    if(field==='project')a.projectId='foreign';
    if(field==='target')a.operation!.targetId='other';
    if(field==='source project')s.projectId='foreign';
    if(field==='source Work')s.workId=f.sourceB.workId;
    if(field==='source run')run.operation!.sourceMergeRunId=f.sourceB.id;
    if(field==='previous source run')a.operation!.sourceMergeRunId=f.sourceB.id;
    if(field==='deployment ID')a.operation!.stagingReceipt!.deploymentId='deploy_wrong';
    if(field==='receipt operation')a.operation!.stagingReceipt!.operationId=f.b.id;
    if(field==='candidate')run.operation!.candidateFingerprint=f.sourceB.operation!.candidateFingerprint;
    if(field==='build receipt')run.operation!.buildReceipt!.artifactId=999;
    if(field==='target revision')run.targetRevision=f.sourceB.targetRevision;
    if(field==='CAS')run.operation!.expectedCurrentDeploymentId='deploy_wrong';
    if(field==='current CAS')f.records.get(f.b.id)!.data.operation.stagingReceipt.deploymentId='deploy_new';
    const claimed=await f.claim();
    const response=await f.connector(`/runs/${claimed.id}/staging-authorize`,{generation:claimed.generation,effect:'provenance'});
    expect(response.statusCode,response.body).toBe(409);expect(f.records.get(queued.id)!.data.operation.effectIntentGeneration).toBeUndefined();expect(f.requests.has('staging-target:project:staging:reservation')).toBe(true);
  }finally{await f.app.close();}
});

it.each(['target','source','deployment'])('rechecks previous %s after provenance authorization and before transport',async field=>{
  const f=await fixture();
  try{
    await f.queue();const claimed=await f.claim();
    const authorize=(effect:string)=>f.connector(`/runs/${claimed.id}/staging-authorize`,{generation:claimed.generation,effect});
    const provenance=await authorize('provenance');expect(provenance.statusCode,provenance.body).toBe(200);
    const previous=f.records.get(f.a.id)!.data as Run;
    if(field==='target')previous.operation!.targetId='other';
    if(field==='source')previous.operation!.sourceMergeRunId=f.sourceB.id;
    if(field==='deployment')previous.operation!.stagingReceipt!.deploymentId='deploy_wrong';
    const transport=await authorize('transport');expect(transport.statusCode,transport.body).toBe(409);
    expect(f.records.get(claimed.id)!.data.operation.stagingEffectStage).toBe('intent');
  }finally{await f.app.close();}
});
