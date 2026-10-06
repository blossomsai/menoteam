import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';

describe('CI report gate requires each PostgreSQL suite independently',()=>{
  it('rejects a green aggregate when the Provider suite is absent, empty, skipped or failed',async()=>{
    const directory=await mkdtemp(path.join(os.tmpdir(),'menoteam-ci-gate-'));
    const report={success:true,numTotalTests:3,numPassedTests:3,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numTodoTests:0,testResults:['postgres-repository','workbench-postgres','workbench-provider-postgres'].map(name=>({name:`/fixture/tests/${name}.test.ts`,status:'passed',assertionResults:[{status:'passed'}]}))};
    const run=async(value:typeof report)=>{const file=path.join(directory,'report.json');await writeFile(file,JSON.stringify(value));return promisify(execFile)(process.execPath,['scripts/assert-ci-test-results.mjs',file],{timeout:10_000});};
    try{
      expect((await run(report)).stdout).toContain('all three PostgreSQL suites');
      for(const kind of ['absent','empty','skipped','failed']){
        const changed=structuredClone(report);
        if(kind==='absent')changed.testResults.pop();
        else if(kind==='empty')changed.testResults[2]!.assertionResults=[];
        else changed.testResults[2]!.assertionResults[0]!.status=kind==='skipped'?'pending':'failed';
        await expect(run(changed)).rejects.toMatchObject({code:1,stderr:expect.stringContaining('workbench-provider-postgres.test.ts')});
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});
