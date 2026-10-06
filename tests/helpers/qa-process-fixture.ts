// Own only these fixture processes. Failure cleanup is part of the assertion, never a broad pkill.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readProcessIdentity, terminateProcessGroup, waitProcessGroup, type CodexProcessIdentity } from '../../src/connector/codex.js';
import { qaChildEnvironment, stopQaExecution, releaseQaResource, type QaExecution } from '../../src/connector/qa-process.js';
import { readJson, writeSecureJson } from '../../src/connector/state.js';
import type { QaPolicy } from '../../src/workbench/local-qa.js';
import { QA_FIXTURE_CLEANUP_SETTLE_MS, QA_FIXTURE_CREATE_RESERVE_MS, QA_FIXTURE_FINALIZE_RESERVE_MS, type QaFixtureBudget } from './qa-fixture-budget.js';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function bounded<T>(promise:Promise<T>,ms:number):Promise<T>{let timer:NodeJS.Timeout;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture deadline exceeded')),ms);})]);}finally{clearTimeout(timer!);}}
function same(a:CodexProcessIdentity|undefined,b:CodexProcessIdentity){return a?.pid===b.pid&&a?.startedAt===b.startedAt&&a?.processGroupId===b.processGroupId&&a?.command===b.command;}
export class QaProcessFixture {
  readonly abort=new AbortController();
  private closing=false;
  readonly executions:{state:QaExecution;file?:string}[]=[];
  readonly parents:{child:ChildProcess;identity?:CodexProcessIdentity;identityFile:string;stateFile:string;closed:Promise<number|null>}[]=[];
  readonly observed:CodexProcessIdentity[]=[];
  private readonly pending:Promise<void>[]=[];
  track<T>(promise:Promise<T>):Promise<T>{this.pending.push(promise.then(()=>{},()=>{}));return promise;}
  constructor(readonly directory:string){}
  active(){if(this.closing)this.abort.signal.throwIfAborted();}
  state():QaExecution {this.active();const state:QaExecution={directory:path.join(this.directory,randomUUID()),nonce:randomUUID(),phase:'stopped'};this.executions.push({state});return state;}
  async until(check:()=>Promise<boolean>,ms=5000){const end=Date.now()+ms;while(Date.now()<end){this.active();if(await check())return;await pause(25);}throw Error('Controlled fixture did not become ready');}
  async observe(pids:number[]){for(const pid of pids){const identity=await readProcessIdentity(pid);if(!identity)throw Error('Fixture descendant identity unavailable');this.observed.push(identity);}}
  async parent(state:QaExecution,policy:QaPolicy,mode?:'lock'|'startup'|'between',command:string[]=[],secondCommand:string[]=[]){
    this.active();if(!this.executions.some(e=>e.state===state))this.executions.push({state});
    const configFile=path.join(this.directory,`${randomUUID()}.json`),stateFile=path.join(this.directory,`${randomUUID()}.state.json`),identityFile=stateFile+'.parent.json';
    this.executions.find(e=>e.state===state)!.file=stateFile;
    await writeSecureJson(configFile,{state,policy,stateFile,cwd:this.directory,command,secondCommand,mode});this.active();
    const child=spawn(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),fileURLToPath(new URL('./qa-parent.ts',import.meta.url)),configFile],{stdio:['pipe','pipe','pipe','ipc'],env:qaChildEnvironment(),shell:false,detached:true});
    const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
    // Register synchronously at spawn, before readiness, assertions or any resource acquisition.
    const entry={child,identity:undefined as CodexProcessIdentity|undefined,identityFile,stateFile,closed};this.parents.push(entry);
    let output='',errors='';child.stdout!.on('data',c=>output+=String(c));child.stderr!.on('data',c=>errors+=String(c));
    const ready=new Promise<void>((resolve,reject)=>{
      child.once('error',reject);child.once('close',()=>reject(Error('Fixture parent closed before identity registration')));
      child.once('message',()=>{void(async()=>{
        const identity=await readJson<CodexProcessIdentity>(identityFile);
        if(!identity||identity.pid!==child.pid||identity.processGroupId!==child.pid||!identity.command.includes('qa-parent.'))throw Error('Fixture parent identity missing');
        entry.identity=identity;this.active();child.send({go:true});resolve();
      })().catch(reject);});
    });
    await bounded(ready,5000);
    return {child,closed,stateFile,entry,get output(){return output;},get errors(){return errors;}};
  }
  async stopParent(entry:QaProcessFixture['parents'][number]){
    if(!entry.child.pid){await bounded(entry.closed,1000);return;}
    if(!await waitProcessGroup(entry.child.pid,1)){
      const identity=entry.identity??await readJson<CodexProcessIdentity>(entry.identityFile);
      if(!identity||identity.pid!==entry.child.pid||identity.processGroupId!==entry.child.pid||!identity.command.includes('qa-parent.')||!same(await readProcessIdentity(identity.pid),identity))throw Error('Fixture parent identity unknown; ownership retained');
      entry.identity=identity;
      if(!await terminateProcessGroup(identity.processGroupId,100))throw Error('Fixture parent group stop unconfirmed');
    }
    await bounded(entry.closed,1000);
  }
  async cleanup(deadline:number){
    this.closing=true;this.abort.abort();const failures:unknown[]=[],stoppedParents=new Set<string>(),stoppedStates:QaExecution[]=[];
    const budget=()=>{if(Date.now()>=deadline)throw Error('Fixture cleanup deadline exceeded; ownership retained');};
    // Stop original executors first: no late spawn/GO is possible when inspecting QA startup records.
    for(const entry of this.parents)try{budget();await this.stopParent(entry);stoppedParents.add(entry.stateFile);}catch(error){failures.push(error);}
    for(const tracked of this.executions)try{
      budget();if(tracked.file&&!stoppedParents.has(tracked.file))throw Error('Fixture original executor stop unknown; retain QA and ownership');
      const state=tracked.file?await readJson<QaExecution>(tracked.file)??tracked.state:tracked.state;
      if(!await stopQaExecution(state))throw Error('Fixture QA group stop unknown; ownership retained');
      stoppedStates.push(state);
    }catch(error){failures.push(error);}
    // Drain fixed-parent promises after abort/stop so late handshake saves cannot recreate removed evidence.
    try{budget();await bounded(Promise.all(this.pending),Math.max(1,deadline-Date.now()));}catch(error){failures.push(error);}
    // Group absence and the registered descendant identities must both precede any lock release.
    for(const identity of this.observed)try{budget();process.kill(identity.pid,0);throw Error('Fixture descendant still exists; evidence retained');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')failures.push(error);}
    if(!failures.length)for(const state of stoppedStates)try{
      budget();for(const lock of state.resourceLocks??(state.resourceLock?[state.resourceLock]:[])){
        const single={...state,resourceLocks:undefined,resourceLock:lock,expectedResourceDirectories:[lock.directory]};
        const guard=lock.directory+'.guard';
        const guardOwner=await readJson<{nonce:string;resourceOwner:string;executor:CodexProcessIdentity}>(path.join(guard,'owner.json'));
        // Only a fully recorded guard from a registered, now-stopped fixture parent may be removed.
        // An incomplete/foreign guard remains blocked by the production release protocol.
        if(guardOwner&&typeof guardOwner.nonce==='string'&&guardOwner.resourceOwner===state.nonce&&this.parents.some(p=>stoppedParents.has(p.stateFile)&&same(p.identity,guardOwner.executor)))await rm(guard,{recursive:true});
        const owner=await readJson<{owner:string}>(path.join(lock.directory,'owner.json'));budget();
        // A contender never acquired this resource; only our exact nonce may be released.
        if(owner?.owner===state.nonce||!owner)await releaseQaResource(single); // Incomplete ownership fails closed.
      }
    }catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,`Fixture stop proof unknown; preserved ${this.directory}`);
  }
}
export async function qaProcessFixture(action:(fixture:QaProcessFixture)=>Promise<void>,budget:QaFixtureBudget,removeDirectory:(directory:string)=>Promise<void>=directory=>rm(directory,{recursive:true,force:true}),createDirectory:()=>Promise<string>=()=>mkdtemp(path.join(os.tmpdir(),'qa-process-proof-'))){
  // Reject an expired/depleted budget before starting directory creation or a parent.
  budget.assertActionStart();
  let creationExpired=false,createdDirectory:string|undefined,lateRemoval:Promise<void>|undefined;
  const cleanupLateDirectory=(directory:string)=>lateRemoval??=budget.trackFinalization(Promise.resolve().then(()=>removeDirectory(directory)));
  const removeLateDirectory=(directory:string)=>{
    const cleanup=cleanupLateDirectory(directory);
    return bounded(cleanup,budget.finalizeMs()).catch(()=>{
      // The tracked removal remains pending (or fail-closed) after its bounded wait expires.
    });
  };
  const creating=budget.trackFinalization(Promise.resolve().then(()=>{
    if(budget.creationMs()<QA_FIXTURE_CREATE_RESERVE_MS)throw Error('QA fixture creation budget exhausted; no directory created');
    return createDirectory();
  }).then(async directory=>{
    createdDirectory=directory;
    if(creationExpired)await removeLateDirectory(directory);
    return directory;
  }),false);
  let directory:string;
  try{directory=await bounded(creating,budget.creationMs());}
  catch(error){
    if(error instanceof Error&&error.message==='Fixture deadline exceeded'){
      creationExpired=true;
      if(createdDirectory){
        await removeLateDirectory(createdDirectory);
      }
      throw new AggregateError([error],`Fixture directory creation deadline exceeded; late creation remains tracked: ${createdDirectory??'pending directory creation'}`);
    }
    throw new AggregateError([error],`Fixture directory creation failed; no action started`);
  }
  const fixture=new QaProcessFixture(directory);
  let failure:unknown,cleanupFailure:unknown,finalizationFailure:unknown,directoryRemovalStarted=false,directoryRemoved=false;
  try{
    // Directory creation consumed its reserved slice; re-check immediately before action/parent spawn.
    budget.assertActionStart(true);
    await bounded(action(fixture),budget.actionMs());
  }catch(error){failure=error;}finally{
    const cleanupMs=budget.cleanupMs(),cleanupDeadline=Math.min(budget.deadline,Date.now()+Math.max(1,cleanupMs-QA_FIXTURE_CLEANUP_SETTLE_MS));
    let cleanupExpired=false;
    // Register before invoking cleanup; its original promise outlives the deadline race.
    const cleanup=budget.trackFinalization(Promise.resolve().then(()=>fixture.cleanup(cleanupDeadline)).then(async()=>{
      // Only a successful stop proof permits late owned-directory removal. Keep the
      // whole operation tracked until removal settles, then require explicit drain.
      if(cleanupExpired)await removeDirectory(fixture.directory);
    }));
    try{await bounded(cleanup,cleanupMs);}catch(error){cleanupExpired=true;budget.requireDrain();cleanupFailure=error;}
    if(!cleanupFailure){
      const finalizeMs=budget.finalizeMs();
      if(finalizeMs<QA_FIXTURE_FINALIZE_RESERVE_MS)finalizationFailure=Error('Fixture directory finalization budget unavailable; evidence preserved');
      else{
        // Keep timed-out rm work attached to the shared budget; no later fixture may start until it settles.
        directoryRemovalStarted=true;
        const finalization=budget.trackFinalization(removeDirectory(fixture.directory));
        try{await bounded(finalization,finalizeMs);directoryRemoved=true;}catch(error){finalizationFailure=error;}
        if(!finalizationFailure)try{budget.finishFixture();}catch(error){finalizationFailure=error;}
      }
    }
  }
  if(cleanupFailure)throw new AggregateError([failure,cleanupFailure].filter(Boolean),`Fixture cleanup failed; preserved ${fixture.directory}`);
  if(finalizationFailure){
    const state=directoryRemoved?'directory removed, but shared budget completion failed':budget.pendingFinalizations()?'directory removal remains pending; another fixture is blocked':directoryRemovalStarted?'directory removal failed; remaining evidence retained where available':'directory retained; removal never started';
    throw new AggregateError([failure,finalizationFailure].filter(Boolean),`Fixture directory finalization failed; ${state}: ${fixture.directory}`);
  }
  if(failure)throw failure;
}
