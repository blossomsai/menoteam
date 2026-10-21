import type { Sql } from 'postgres';
import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkbenchApp } from '../../src/workbench/app.js';
import { WorkbenchStore } from '../../src/workbench/store.js';
import { digest } from '../../src/workbench/auth.js';
import type { Run, Artifact } from '../../src/workbench/types.js';
import { mergeClaim } from './merge-pr-fixture.js';
import { qaPolicyFixture, requiredQaFixture } from './local-qa-fixture.js';
export async function recoveryFixture(sql:Sql){
    const projectId=`recovery_${randomUUID()}`,workId=`work_${randomUUID()}`,owner=`owner_${randomUUID()}`,connectorId=`connector_${randomUUID()}`;
    const session=randomUUID(),token=randomUUID(),repositoryUrl='https://github.com/org/offline-recovery',stamp=new Date().toISOString();
    const store=new WorkbenchStore(sql),app=await createWorkbenchApp({sql});
    const caps={git:true,githubWrite:true,runKinds:['delivery'],deliveryActions:['deploy_staging'],deploymentTargets:['staging']};
    const qp=qaPolicyFixture(projectId,repositoryUrl,`qa_${randomUUID()}`);qp.configuredBy=owner;
    const deliveryId=`policy_${randomUUID()}`,source=mergeClaim().run;
    Object.assign(source,{id:`source_${randomUUID()}`,projectId,workId,requestedBy:owner,status:'completed',connectorId,targetConnectorId:connectorId,targetRunId:`candidate_${randomUUID()}`,targetRevision:'diff-r1',createdAt:stamp,updatedAt:stamp});
    Object.assign(source.operation!,{actorId:owner,originalActorId:owner,phase:'merged',reviewRunId:`review_${randomUUID()}`,candidateRunId:source.targetRunId,repositoryUrl,qaPolicySnapshot:qp,policySnapshot:{id:deliveryId,version:qp.version,requiredChecks:['Menoteam CI']},external:{...source.operation!.external,mergeSha:'c'.repeat(40)}});
    const op=source.operation!,qaId=`qa_${randomUUID()}`,diffId=`diff_${randomUUID()}`;
    const old:Run={...source,id:`run_${randomUUID()}`,status:'running',generation:1,leaseUntil:new Date(Date.now()+60_000).toISOString(),operation:{...op,action:'deploy_staging',phase:'deploy_intent',effectIntentGeneration:1,stagingEffectStage:'transport_intent',commitSha:op.external!.mergeSha!,sourceMergeRunId:source.id,targetId:'staging',targetPolicyVersion:qp.version,imageDigest:`sha256:${'d'.repeat(64)}`,expectedCurrentDeploymentId:'deploy_historical',buildStatus:'verified',buildReceipt:{schemaVersion:1,repository:'blossomsai/menoteam',repositoryId:'123',workflowPath:'.github/workflows/build-workbench-image.yml',runId:10,runAttempt:1,artifactId:11,archiveDigest:`sha256:${'e'.repeat(64)}`,artifactExpiresAt:new Date(Date.now()+86_400_000).toISOString(),sourceSha:op.external!.mergeSha!,imageRepository:'ghcr.io/blossomsai/menoteam-work-map',imageDigest:`sha256:${'d'.repeat(64)}`,runUrl:'https://github.com/blossomsai/menoteam/actions/runs/10',verifiedAt:stamp,verifiedGeneration:1}}};
    const put=(kind:string,data:{id:string;projectId?:string})=>store.put(kind,data);
    const ownedForeignRecordIds:string[]=[];
    const close=async()=>{
      await app.close();
      // Remove only this test's identities, never shared/foreign fixtures.
      await sql`DELETE FROM wb_requests WHERE scope=${`staging-target:${projectId}:staging`} OR scope=${`staging-recovery-request:${projectId}:${owner}:staging`} OR scope=${`staging-recovery:${old.id}:1`}`;
      await sql`DELETE FROM wb_records WHERE project_id=${projectId}`;
      // Source may have moved scopes; these exact IDs were allocated only by this fixture.
      await sql`DELETE FROM wb_records WHERE id=${source.id} OR id=ANY(${ownedForeignRecordIds})`;
      await sql`DELETE FROM wb_sessions WHERE user_id=${owner}`;await sql`DELETE FROM wb_memberships WHERE user_id=${owner}`;
      await sql`DELETE FROM wb_connectors WHERE id=${connectorId}`;await sql`DELETE FROM wb_users WHERE id=${owner}`;
    };
    try {
    await sql`INSERT INTO wb_users(id,email,name,password_hash,role) VALUES (${owner},${`${owner}@example.test`},'Recovery fixture','unused','owner')`;
    await sql`INSERT INTO wb_sessions(digest,user_id,expires_at) VALUES (${digest(session)},${owner},now()+interval '1 hour')`;
    await sql`INSERT INTO wb_connectors(id,digest,project_ids,capabilities,last_seen) VALUES (${connectorId},${digest(token)},${sql.json([projectId])},${sql.json(caps)},now())`;
    await put('project',{id:projectId,name:'Recovery fixture',repositoryUrl,instructions:'',deliveryAuthorization:'',createdAt:stamp} as never);
    await put('work',{id:workId,projectId,title:'Offline recovery',status:'in_progress',revision:1,sources:[],profileId:'',createdAt:stamp,updatedAt:stamp} as never);
    await put('setting',{id:deliveryId,projectId,kind:'connection',updatedAt:qp.version,data:{provider:'github',purpose:'delivery',url:repositoryUrl,baseBranch:'main',configuredBy:owner,enabled:true,allowDraftPr:true,allowMergePr:true,mergeMethod:'merge',requiredChecks:['Menoteam CI'],allowStagingDeploy:true,stagingTargets:['staging']}} as never);
    await put('setting',{id:qp.id,projectId,kind:'connection',updatedAt:qp.version,data:{provider:'qa',purpose:'qa',url:repositoryUrl,configuredBy:owner,enabled:true,coverage:qp.coverage,requirements:qp.requirements,resource:qp.resource}} as never);
    await put('run',source);await put('run',old);
    await put('artifact',{id:`artifact:${old.id}:staging-build:1`,projectId,workId,runId:old.id,kind:'delivery',revision:old.operation!.candidateRevision,data:{phase:'build_verified',receipt:old.operation!.buildReceipt},createdAt:stamp} as Artifact);
    await put('run',{...source,id:op.candidateRunId,kind:'implementation',operation:undefined,qaPolicySnapshot:qp});
    await put('run',{...source,id:op.reviewRunId!,kind:'review',operation:undefined,reviewBinding:{candidateRunId:op.candidateRunId,commitSha:op.commitSha,candidateFingerprint:op.candidateFingerprint,diffArtifactId:diffId,diffRevision:op.artifactRevision,qaArtifactIds:[qaId]}});
    const artifact=(id:string,runId:string,kind:Artifact['kind'],data:unknown)=>put('artifact',{id,projectId,workId,runId,kind,revision:op.artifactRevision,data,createdAt:stamp} as Artifact);
    await artifact(diffId,op.candidateRunId,'diff',{candidateRevision:op.commitSha,baseRevision:op.baseRevision});
    await artifact(qaId,op.candidateRunId,'qa',requiredQaFixture(op.candidateFingerprint,qp));
    await artifact(`typed_${randomUUID()}`,op.reviewRunId!,'qa',{typedReview:{disposition:'approved',findings:[],evidenceArtifactIds:[qaId]}});
    const scope=`staging-target:${projectId}:staging`;
    await sql`INSERT INTO wb_requests(scope,request_id,result) VALUES (${scope},'reservation',${sql.json({runId:old.id,action:'deploy_staging',targetId:'staging'})})`;
    const connector=(suffix:string,payload:unknown)=>app.inject({method:'POST',url:`/api/workbench/connector${suffix}`,headers:{authorization:`Bearer ${token}`},payload:payload as never});
    const check=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json();};
    const offline={operationId:old.id,targetId:'staging',phase:'target_offline' as const,commitSha:old.operation!.commitSha,imageDigest:old.operation!.imageDigest!,checkedAt:stamp};
    check(await connector(`/runs/${old.id}/staging-progress`,{generation:1,receipt:offline}));
    check(await connector(`/runs/${old.id}/complete`,{generation:1,error:'Health failed; target offline'}));
    check(await connector(`/runs/${old.id}/stopped`,{generation:1}));
    const recover=(requestId='recover',delta:Record<string,unknown>={},routeWork=workId,cookie=session)=>app.inject({method:'POST',url:`/api/workbench/works/${routeWork}/staging/recover`,headers:{cookie:`menoteam_session=${cookie}`},payload:{oldRunId:old.id,generation:1,targetId:'staging',requestId,...delta}});
    const readOld=()=>store.get<Run>('run',old.id);
    const reservation=async()=>(await sql`SELECT result FROM wb_requests WHERE scope=${scope} AND request_id='reservation'`)[0]?.result;
    return {sql,store,app,projectId,workId,owner,old,source,op,scope,caps,connectorId,deliveryId,qp,qaId,check,connector,recover,readOld,reservation,offline,ownedForeignRecordIds,close};
    }catch(error){await close();throw error;}
  }
