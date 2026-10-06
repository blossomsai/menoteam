import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fingerprint } from './git.js';
import { hasRequiredLocalQa, qaMetrics, LOCAL_QA_CONTRACT, type FixedQaCheck, type QaPolicy } from '../workbench/local-qa.js';
import { bindQaExecutor, acquireQaResource, authorizedQaResource, claimQaResource, qaChildEnvironment, releaseQaResource, runQaCommand, stopQaExecution, type QaExecution, type QaResourceConfig } from './qa-process.js';

export async function captureRequiredLocalQa(cwd:string,options:{policy?:QaPolicy;resources:Record<string,QaResourceConfig>;dataDirectory:string;save:(state:QaExecution)=>Promise<void>;authorize?:()=>Promise<void>;state?:QaExecution;signal?:AbortSignal}) {
  const {policy,signal}=options;
  const candidateFingerprint=await fingerprint(cwd);
  const unavailable=()=>({localQaContract:LOCAL_QA_CONTRACT,...(policy?{policy}:{}),checks:[] as FixedQaCheck[],capturedAt:new Date().toISOString(),candidateFingerprint,stale:false,verification:'unknown'});
  if(!policy||process.platform==='win32')return unavailable();
  let resourceUrl:string|undefined;
  try {resourceUrl=authorizedQaResource(policy,options.resources);}catch{return unavailable();}
  const temporary=await mkdtemp(path.join(os.tmpdir(),'menoteam-required-qa-'));
  const state:QaExecution=options.state??{directory:path.join(options.dataDirectory,randomUUID()),nonce:randomUUID(),phase:'stopped'};
  const save=()=>options.save(state);
  const checks:FixedQaCheck[]=[];
  let acquired=false;let failure:unknown;
  try {
    await bindQaExecutor(state);await acquireQaResource(state,policy);await save();
    try{await claimQaResource(state);acquired=true;await save();}catch(error){
      // A contended resource never starts QA or releases someone else's ownership.
      if((error as Error).message.includes('owned by another')){state.resourceLock=undefined;await save();return unavailable();}
      throw error;
    }
    await options.authorize?.();
    for(const requirement of policy.requirements){
      signal?.throwIfAborted();
      const before=await fingerprint(cwd),startedAt=new Date().toISOString(),started=Date.now();
      const reportFile=path.join(temporary,`${requirement.id}.json`);
      let exitCode:number|null=0,output='';
      for(const command of requirement.commands){
        const executable=command.executable==='node'?process.execPath:path.join(cwd,'node_modules','.bin',command.bin!);
        const args=command.args.map(arg=>arg.replaceAll('{reportFile}',reportFile).replaceAll('{outputDir}',temporary));
        await options.authorize?.();signal?.throwIfAborted();
        const result=await runQaCommand(state,executable,args,cwd,qaChildEnvironment(resourceUrl),command.timeoutMs,save,signal,options.authorize);
        output+=result.output;exitCode=result.exitCode;if(exitCode!==0)break;
      }
      const after=await fingerprint(cwd),finishedAt=new Date().toISOString();
      let metrics:FixedQaCheck['metrics'];
      if(requirement.report==='vitest-json')try{
        const data=JSON.parse(await readFile(reportFile,'utf8')) as {numTotalTests:number;numPassedTests:number;numFailedTests:number;numPendingTests:number;success:boolean};
        metrics={total:data.numTotalTests,passed:data.numPassedTests,failed:data.numFailedTests,skipped:data.numPendingTests};
        if(data.success!==true&&exitCode===0)exitCode=1;
      }catch{if(exitCode===0)exitCode=null;}
      if(requirement.report==='node-test-tap'){const count=(name:string)=>Number(new RegExp(`^# ${name} (\\d+)$`,'mu').exec(output)?.[1]??NaN);metrics={total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')+count('todo')+count('cancelled')};}
      if(metrics&&!qaMetrics.safeParse(metrics).success){metrics=undefined;if(exitCode===0)exitCode=null;}
      checks.push({requirementId:requirement.id,category:requirement.category,source:'fixed-connector',name:requirement.id,command:JSON.stringify(requirement.commands),exitCode,output:resourceUrl?output.replaceAll(resourceUrl,'[authorized disposable QA database]').replaceAll(new URL(resourceUrl).password||resourceUrl,'[QA resource secret]').slice(-30_000):output.slice(-30_000),outputChannel:'combined',durationMs:Date.now()-started,startedAt,finishedAt,testedRevision:before===after?before:null,...(metrics?{metrics}:{})});
    }
    const finalFingerprint=await fingerprint(cwd);
    const snapshot={localQaContract:LOCAL_QA_CONTRACT,policy,checks,capturedAt:new Date().toISOString(),candidateFingerprint:finalFingerprint,stale:checks.some(c=>c.testedRevision!==finalFingerprint),verification:'current'};
    if(!hasRequiredLocalQa(snapshot,finalFingerprint,policy))snapshot.verification='unknown';
    return snapshot;
  }catch(error){failure=error;throw error;}finally{
    // Includes abort/timeout/crash: do not clear the spool or resource until actual group stop proof.
    if(!await stopQaExecution(state)){await save();throw new Error('QA stop is unconfirmed; preserve resource and Work reservation',{cause:failure});}
    if(acquired)await releaseQaResource(state);
    state.phase='stopped';await save();await rm(temporary,{recursive:true,force:true});
  }
}
