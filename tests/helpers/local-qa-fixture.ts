import { LOCAL_QA_CONTRACT,MENOTEAM_QA_REQUIREMENTS,type QaPolicy } from '../../src/workbench/local-qa.js';
export function qaPolicyFixture(projectId='fixture-project',repositoryUrl='https://github.com/example/fixture',id='fixture-qa-policy'):QaPolicy {
  return {id,version:'2000-01-01T00:00:00.000Z',projectId,repositoryUrl,configuredBy:'fixture-owner',coverage:'project/v1',requirements:JSON.parse(JSON.stringify(MENOTEAM_QA_REQUIREMENTS)),resource:{id:'disposable-fixture',kind:'postgres',hostname:'127.0.0.1',port:55439,database:'menoteam_workbench_test',disposable:true}};
}
export function requiredQaFixture(fingerprint:string,policy=qaPolicyFixture()) {
  const stamp=new Date().toISOString();
  return {localQaContract:LOCAL_QA_CONTRACT,policy,candidateFingerprint:fingerprint,stale:false,verification:'current',capturedAt:stamp,
    checks:policy.requirements.map(r=>({requirementId:r.id,category:r.category,source:'fixed-connector' as const,name:r.id,command:JSON.stringify(r.commands),exitCode:0,output:'Synthetic contract fixture, not execution proof',outputChannel:'combined' as const,durationMs:0,startedAt:stamp,finishedAt:stamp,testedRevision:fingerprint,...(r.report!=='none'?{metrics:{total:12,passed:12,failed:0,skipped:0}}:{})}))};
}
