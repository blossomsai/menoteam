import { describe,it,expect } from 'vitest';
import { hasRequiredLocalQa as validate, REQUIRED_LOCAL_QA, qaPolicyData, MENOTEAM_QA_REQUIREMENTS, savedQaPolicy } from '../src/workbench/local-qa.js';
import { requiredQaFixture, qaPolicyFixture } from './helpers/local-qa-fixture.js';
const fingerprint='a'.repeat(64);
const policy=qaPolicyFixture();
const hasRequiredLocalQa=(value:unknown,fp:string)=>validate(value,fp,policy);
describe('server required local QA contract shared by request and effect',()=>{
  it('accepts complete fixed-parent coverage independent of GitHub context names',()=>{expect(hasRequiredLocalQa(requiredQaFixture(fingerprint),fingerprint)).toBe(true);});
  it.each(REQUIRED_LOCAL_QA)('blocks missing %s coverage',category=>{const qa=requiredQaFixture(fingerprint);qa.checks=qa.checks.filter(c=>c.category!==category);expect(hasRequiredLocalQa(qa,fingerprint)).toBe(false);});
  it.each(['failed','unknown','static-read','log-read','changed-fingerprint','skipped','wrong-contract','stale','no-capture','future','duplicate'])('rejects %s evidence',kind=>{
    const qa:any=requiredQaFixture(fingerprint);
    if(kind==='failed')qa.checks[0].exitCode=1;
    if(kind==='unknown')qa.checks[0].exitCode=null;
    if(kind==='static-read')qa.checks=[{command:'cat PRODUCT.md',exitCode:0,testedRevision:fingerprint}];
    if(kind==='log-read')qa.checks[0].command='cat /tmp/passing-vitest.json';
    if(kind==='changed-fingerprint')qa.checks[0].testedRevision='b'.repeat(64);
    if(kind==='skipped')qa.checks[3].metrics={total:12,passed:11,failed:0,skipped:1};
    if(kind==='wrong-contract')delete qa.localQaContract;
    if(kind==='stale')qa.stale=true;
    if(kind==='no-capture')delete qa.capturedAt;
    if(kind==='future')qa.capturedAt=new Date(Date.now()+60000).toISOString();
    if(kind==='duplicate')qa.checks[3]=qa.checks[0];
    expect(hasRequiredLocalQa(qa,fingerprint)).toBe(false);
  });
  it('rejects missing or changed policy identity, version, coverage and resource',()=>{const qa=requiredQaFixture(fingerprint);expect(validate(qa,fingerprint)).toBe(false);for(const changed of [{...policy,id:'other'},{...policy,version:new Date().toISOString()},{...policy,resource:{...policy.resource!,database:'other_test'}},{...policy,requirements:policy.requirements.slice(1)}])expect(validate(qa,fingerprint,changed)).toBe(false);});
  it('retains the complete Menoteam adapter and rejects reduced coverage',()=>{const data={provider:'qa',purpose:'qa',enabled:true,url:'https://github.com/blossomsai/menoteam',configuredBy:'owner',coverage:'menoteam-full/v2',requirements:MENOTEAM_QA_REQUIREMENTS,resource:policy.resource};expect(qaPolicyData.safeParse(data).success).toBe(true);expect(qaPolicyData.safeParse({...data,coverage:'project/v1'}).success).toBe(false);expect(qaPolicyData.safeParse({...data,requirements:policy.requirements.slice(1)}).success).toBe(false);expect(policy.requirements[0]!.commands[0]!.args.slice(0,2)).toEqual(['run','--fileParallelism=false']);});
  it('rejects unconfigured or ambiguous saved policy',()=>{expect(savedQaPolicy([],policy.projectId,policy.repositoryUrl)).toBeUndefined();});
  it('accepts explicit non-Menoteam Node test policy but refuses a read command as test runner',()=>{
    const generic={...policy,coverage:'project/v1' as const,resource:undefined,requirements:[{id:'node-tests',category:'tests' as const,commands:[{executable:'node' as const,args:['--test','--test-reporter=tap','test.cjs'],timeoutMs:10_000}],report:'node-test-tap' as const}]};
    const data={provider:'qa',purpose:'qa',url:generic.repositoryUrl,coverage:generic.coverage,requirements:generic.requirements};
    expect(qaPolicyData.safeParse(data).success).toBe(true);expect(validate(requiredQaFixture(fingerprint,generic),fingerprint,generic)).toBe(true);
    expect(qaPolicyData.safeParse({...data,requirements:[{...generic.requirements[0],commands:[{executable:'node',args:['read-log.cjs'],timeoutMs:10_000}]}]}).success).toBe(false);
  });
  it('cannot promote native/model command records into fixed coverage',()=>{const qa:any=requiredQaFixture(fingerprint);qa.checks.forEach((c:any)=>c.source='codex-command');expect(hasRequiredLocalQa(qa,fingerprint)).toBe(false);});
});
