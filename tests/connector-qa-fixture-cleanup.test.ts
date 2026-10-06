import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {QaProcessFixture} from './helpers/qa-process-fixture.js';
import {QA_FIXTURE_CLEANUP_RESERVE_MS,QA_FIXTURE_CLEANUP_SETTLE_MS} from './helpers/qa-fixture-budget.js';
import {qaPolicyFixture} from './helpers/local-qa-fixture.js';
import {acquireQaResource,claimQaResource} from '../src/connector/qa-process.js';
import * as processes from '../src/connector/codex.js';
// Contract checks only. Real fixture failure-injection tests remain in connector-qa-process.test.ts.
const cleanupDeadline=()=>Date.now()+QA_FIXTURE_CLEANUP_RESERVE_MS-QA_FIXTURE_CLEANUP_SETTLE_MS;
describe('fixture teardown ownership contract (mocked identities, no processes or database)',()=>{
  it('retains evidence/ownership on unknown descendant stop and releases only after all proofs',async()=>{
    const directory=await mkdtemp(path.join(os.tmpdir(),'qa-cleanup-contract-')),fixture=new QaProcessFixture(directory),execution=fixture.state(),policy=qaPolicyFixture();
    policy.resource!.database=`cleanup_${randomUUID().replaceAll('-','')}_test`;
    const current={pid:process.pid,processGroupId:process.pid,startedAt:'test-parent',command:'contract-fixture'},child={pid:424242,processGroupId:424242,startedAt:'test-child',command:'node qa-child.js'};
    const read=vi.spyOn(processes,'readProcessIdentity').mockResolvedValue(current),wait=vi.spyOn(processes,'waitProcessGroup').mockResolvedValue(true),kill=vi.spyOn(process,'kill').mockReturnValue(true);
    try{
      await acquireQaResource(execution,policy);await claimQaResource(execution);
      execution.identity=child;execution.phase='running';fixture.observed.push({...child,pid:424243});
      const ownerFile=path.join(execution.resourceLock!.directory,'owner.json');
      await expect(fixture.cleanup(cleanupDeadline())).rejects.toThrow('stop proof unknown');expect(JSON.parse(await readFile(ownerFile,'utf8')).owner).toBe(execution.nonce);
      expect(()=>fixture.state()).toThrow(); // A timed-out action cannot launch a late fixture parent.
      kill.mockImplementation(()=>{throw Object.assign(Error('gone'),{code:'ESRCH'});});
      await fixture.cleanup(cleanupDeadline());await expect(readFile(ownerFile)).rejects.toMatchObject({code:'ENOENT'});expect(wait).toHaveBeenCalled();
    }finally{
      // All process observations in this contract are mocks; retain until the mocked stop proof succeeds.
      kill.mockImplementation(()=>{throw Object.assign(Error('gone'),{code:'ESRCH'});});await fixture.cleanup(cleanupDeadline());kill.mockRestore();read.mockRestore();wait.mockRestore();await rm(directory,{recursive:true,force:true});
    }
  });
});
