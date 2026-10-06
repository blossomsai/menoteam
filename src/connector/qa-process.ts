import { spawn,type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { modelChildEnvironment, readProcessIdentity, terminateProcessGroup, waitProcessGroup, type CodexProcessIdentity } from './codex.js';
import { readJson, stateKey, writeSecureJson } from './state.js';
import type { QaPolicy } from '../workbench/local-qa.js';

export type QaExecution = { directory:string; nonce:string; executor?:CodexProcessIdentity; phase:'starting'|'running'|'stopped'; identity?:CodexProcessIdentity; identityFile?:string; resourceLock?:{directory:string;owner:string};resourceLocks?:{directory:string;owner:string}[];expectedResourceDirectories?:string[] };
export type QaResourceConfig = {url:string};
export class QaResourceContention extends Error {}
const RESOURCE_ROOT=path.join('/tmp','menoteam-qa-resources');
function assertResourceSet(state:QaExecution):void {
  const validDirectory=(value:unknown):value is string=>typeof value==='string'&&path.dirname(value)===RESOURCE_ROOT&&/^[a-f0-9]{64}$/u.test(path.basename(value));
  const expected=state.expectedResourceDirectories;
  const explicit=state.resourceLocks!==undefined;
  if(explicit&&(!Array.isArray(state.resourceLocks)||state.resourceLocks.length===0||state.resourceLock||!Array.isArray(expected)))throw new Error('QA resource ownership set is invalid; no GO or release permitted');
  const locks=explicit?state.resourceLocks!:(state.resourceLock?[state.resourceLock]:[]);
  if(typeof state.nonce!=='string'||!state.nonce||locks.some(lock=>!lock||!validDirectory(lock.directory)||lock.owner!==state.nonce)||new Set(locks.map(lock=>lock.directory)).size!==locks.length)throw new Error('QA resource ownership set is invalid; no GO or release permitted');
  if(expected!==undefined){
    const directories=locks.map(lock=>lock.directory).sort();
    if(!Array.isArray(expected)||expected.some(value=>!validDirectory(value))||new Set(expected).size!==expected.length||JSON.stringify(expected)!==JSON.stringify([...expected].sort())||JSON.stringify(directories)!==JSON.stringify(expected))throw new Error('QA resource ownership set does not match frozen intent; no GO or release permitted');
  }
  // Only old single-resource/no-resource states lack this new persisted expectation.
}
function singleResourceState(state:QaExecution,lock:{directory:string;owner:string}):QaExecution {
  return {...state,resourceLocks:undefined,resourceLock:lock,expectedResourceDirectories:[lock.directory]};
}
export function assertQaResourcePolicy(state:QaExecution,policy?:QaPolicy):void {
  assertResourceSet(state);
  if(!policy){
    if(state.resourceLocks!==undefined||(state.expectedResourceDirectories?.length??0)>0)throw new Error('Frozen QA resource policy unavailable; retain reservations');
    return; // Legacy single-resource recovery and generic unconfigured/no-DB state.
  }
  const expected=[...new Set([policy.resource,policy.providerResource].filter(resource=>!!resource).map(resource=>path.join(RESOURCE_ROOT,stateKey(resource!.hostname==='localhost'?'127.0.0.1':resource!.hostname,String(resource!.port),resource!.database))))].sort();
  const actual=(state.resourceLocks??(state.resourceLock?[state.resourceLock]:[])).map(lock=>lock.directory).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('QA resource ownership does not match frozen policy; no GO or release permitted');
}
export function qaChildEnvironment(resourceUrl?:string,providerUrl?:string):NodeJS.ProcessEnv {
  // Reuse the Codex boundary; never inherit ambient database or Connector credential locations.
  const isolated=modelChildEnvironment();
  const env:NodeJS.ProcessEnv={};
  for(const key of ['PATH','HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TERM','CI','NODE_ENV','SystemRoot'])if(isolated[key]!==undefined)env[key]=isolated[key];
  if(resourceUrl)env.WORK_MAP_TEST_DATABASE_URL=resourceUrl;
  if(providerUrl){env.MENOTEAM_PROVIDER_TEST_DATABASE_URL=providerUrl;env.MENOTEAM_PROVIDER_TEST_SERIAL_AUTHORIZED='1';}
  return env;
}
export function authorizedQaResource(policy:QaPolicy,resources:Record<string,QaResourceConfig>):string|undefined {
  if(!policy.resource)return;
  const r=policy.resource,value=resources[r.id]?.url;
  if(!value)throw new Error('Saved QA resource has no explicit host authorization');
  const url=new URL(value);
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==r.hostname||Number(url.port||5432)!==r.port||decodeURIComponent(url.pathname.slice(1))!==r.database||url.search||url.hash||r.database==='menoteam_workbench_runtime')throw new Error('Host QA resource does not match the frozen disposable authorization');
  return value;
}
function validExecutor(identity:CodexProcessIdentity|undefined):identity is CodexProcessIdentity {
  return !!identity&&Number.isSafeInteger(identity.pid)&&identity.pid>1&&Number.isSafeInteger(identity.processGroupId)&&identity.processGroupId>1&&typeof identity.startedAt==='string'&&!!identity.startedAt&&typeof identity.command==='string'&&!!identity.command;
}
function sameIdentity(a:CodexProcessIdentity|undefined,b:CodexProcessIdentity|undefined):boolean {
  return validExecutor(a)&&validExecutor(b)&&a.pid===b.pid&&a.processGroupId===b.processGroupId&&a.startedAt===b.startedAt&&a.command===b.command;
}
export async function bindQaExecutor(state:QaExecution):Promise<void> {
  const current=await readProcessIdentity(process.pid);
  if(!validExecutor(current)||(state.executor&&!sameIdentity(state.executor,current)))throw new Error('Original QA executor identity unavailable or changed');
  state.executor??=current;
}
/** Recovery never signals the Connector parent. Live, reused, missing and denied identities retain ownership. */
export function qaExecutorStopped(state:QaExecution):boolean {
  if(!validExecutor(state.executor))return false;
  try{process.kill(state.executor.pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
}
export async function assertQaOwnership(state:QaExecution):Promise<void> {
  assertResourceSet(state);
  if(state.resourceLocks){for(const lock of state.resourceLocks)await assertQaOwnership(singleResourceState(state,lock));return;}
  if(!sameIdentity(state.executor,await readProcessIdentity(process.pid)))throw new Error('Original QA executor ownership unavailable');
  if(!state.resourceLock)return;
  const owner=await readJson<{owner:string;executionDirectory:string;executor:CodexProcessIdentity}>(path.join(state.resourceLock.directory,'owner.json'));
  if(state.resourceLock.owner!==state.nonce||owner?.owner!==state.nonce||owner.executionDirectory!==state.directory||!sameIdentity(owner.executor,state.executor))throw new Error('QA resource ownership changed; no GO permitted');
}
export async function acquireQaResource(state:QaExecution,policy:QaPolicy):Promise<void> {
  if(policy.providerResource){
    const locks:NonNullable<QaExecution['resourceLocks']>=[];
    for(const resource of [policy.resource!,policy.providerResource]){const single={...state,resourceLocks:undefined,resourceLock:undefined,expectedResourceDirectories:undefined};await acquireQaResource(single,{...policy,resource,providerResource:undefined});if(single.resourceLock)locks.push(single.resourceLock);}
    state.resourceLock=undefined;state.resourceLocks=[...new Map(locks.map(lock=>[lock.directory,lock])).values()].sort((a,b)=>a.directory.localeCompare(b.directory));state.expectedResourceDirectories=state.resourceLocks.map(lock=>lock.directory);return;
  }
  if(!policy.resource)return;
  const r=policy.resource;
  // Global on this host, not per Work/Connector. Persistent ownership survives parent death.
  const root=RESOURCE_ROOT;
  await mkdir(root,{recursive:true,mode:0o700});
  const meta=await lstat(root);if(!meta.isDirectory()||meta.isSymbolicLink()||(meta.mode&0o077)!==0||meta.uid!==(process.getuid?.()??meta.uid))throw new Error('QA resource lock directory is not private');
  const directory=path.join(root,stateKey(r.hostname==='localhost'?'127.0.0.1':r.hostname,String(r.port),r.database));
  // Persist the intended owner before mkdir. Never steal a lock, including an incomplete lock.
  state.resourceLock={directory,owner:state.nonce};state.expectedResourceDirectories=[directory];
}
/** One small filesystem critical section for this same resource, across Connector processes.
 * A crashed/incomplete guard is deliberately not stolen. It needs operator stop reconciliation. */
async function withResourceGuard<T>(state:QaExecution,action:()=>Promise<T>):Promise<T> {
  assertResourceSet(state);
  if(state.resourceLocks){const locks=state.resourceLocks;const visit=(index:number):Promise<T>=>index===locks.length?action():withResourceGuard(singleResourceState(state,locks[index]!),()=>visit(index+1));return visit(0);}
  if(!state.resourceLock)return action();
  const executor=await readProcessIdentity(process.pid);
  if(!validExecutor(executor))throw new Error('QA guard executor identity unavailable');
  const directory=state.resourceLock.directory+'.guard',nonce=randomUUID();
  try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new QaResourceContention('Disposable QA resource is owned by another execution or unknown guard; no effect permitted');throw error;}
  // If persistence fails before try/finally, retain the unknown guard rather than release without identity.
  await writeSecureJson(path.join(directory,'owner.json'),{nonce,resourceOwner:state.nonce,executor});
  try{return await action();}finally{
    const owner=await readJson<{nonce:string;executor:CodexProcessIdentity}>(path.join(directory,'owner.json'));
    if(owner?.nonce!==nonce||!sameIdentity(owner.executor,await readProcessIdentity(process.pid)))throw new Error('QA resource guard ownership unknown; retain evidence');
    await rm(directory,{recursive:true});
  }
}
/** Hold the guard through the synchronous IPC GO, not just through the preceding ownership read. */
export async function withQaOwnership<T>(state:QaExecution,action:()=>Promise<T>):Promise<T> {
  return withResourceGuard(state,async()=>{await assertQaOwnership(state);return action();});
}
export async function claimQaResource(state:QaExecution,policy?:QaPolicy):Promise<void> {
  assertResourceSet(state);
  assertQaResourcePolicy(state,policy);
  await bindQaExecutor(state);
  if(state.resourceLocks){
    const claimed:typeof state.resourceLocks=[];
    try{for(const lock of state.resourceLocks){await claimSingleQaResource(singleResourceState(state,lock));claimed.push(lock);}}
    catch(error){
      // Only a known contention proves the failed lock was never acquired. I/O/persistence
      // failures keep every intent in the spool, including a possibly incomplete owner.
      if(error instanceof QaResourceContention){
        try{for(const lock of [...claimed].reverse())await releaseQaResource(singleResourceState(state,lock));}
        catch(cause){throw new Error('QA partial acquisition rollback is unconfirmed; retain all resource intents',{cause});}
        state.resourceLocks=undefined;state.expectedResourceDirectories=[];
      }
      throw error;
    }
    return;
  }
  await claimSingleQaResource(state);
}
async function claimSingleQaResource(state:QaExecution):Promise<void>{
  if(!state.resourceLock)return;
  await withResourceGuard(state,async()=>{
    try{await mkdir(state.resourceLock!.directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new QaResourceContention('Disposable QA resource is owned by another execution; no command started');throw error;}
    await writeSecureJson(path.join(state.resourceLock!.directory,'owner.json'),{owner:state.nonce,executionDirectory:state.directory,executor:state.executor});
  });
}
export async function releaseQaResource(state:QaExecution):Promise<void> {
  assertResourceSet(state);
  if(state.resourceLocks){
    // Retain the complete persisted intent until every release is confirmed. A retry can
    // confirm an absent lock only after the same original-parent/child stop proofs.
    for(const lock of [...state.resourceLocks].reverse())await releaseQaResource(singleResourceState(state,lock));
    state.resourceLocks=undefined;state.expectedResourceDirectories=[];return;
  }
  if(!state.resourceLock)return;
  await withResourceGuard(state,async()=>{
    // A stopped command is insufficient: only the original live owner or a proven dead owner can release.
    if(state.executor?.pid===process.pid){if(!sameIdentity(state.executor,await readProcessIdentity(process.pid)))throw new Error('Original QA executor identity changed');}
    else if(!qaExecutorStopped(state))throw new Error('Original QA executor stop proof missing; retain resource ownership');
    if(!await stopQaExecution(state))throw new Error('QA resource cannot be released before child stop proof');
    try{await lstat(state.resourceLock!.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){state.resourceLock=undefined;state.expectedResourceDirectories=[];return;}throw error;}
    const owner=await readJson<{owner:string;executionDirectory:string;executor:CodexProcessIdentity}>(path.join(state.resourceLock!.directory,'owner.json'));
    if(state.resourceLock!.owner!==state.nonce||owner?.owner!==state.resourceLock!.owner||owner.executionDirectory!==state.directory||!sameIdentity(owner.executor,state.executor))throw new Error('QA resource ownership cannot be proven; retain reservation');
    await rm(state.resourceLock!.directory,{recursive:true});state.resourceLock=undefined;state.expectedResourceDirectories=[];
  });
}
export async function stopQaExecution(state:QaExecution):Promise<boolean> {
  const identity=state.identity??await readJson<CodexProcessIdentity>(state.identityFile??path.join(state.directory,'identity.json'));
  if(!identity)return state.phase==='stopped'; // Unknown startup never authorizes release.
  if(!Number.isSafeInteger(identity.pid)||!Number.isSafeInteger(identity.processGroupId)||identity.pid!==identity.processGroupId||identity.pid<=1||typeof identity.startedAt!=='string'||!identity.startedAt||typeof identity.command!=='string'||!identity.command.includes('qa-child.'))return false;
  if(await waitProcessGroup(identity.processGroupId,1))return true;
  const current=await readProcessIdentity(identity.pid);
  if(!current||current.startedAt!==identity.startedAt||current.command!==identity.command||current.processGroupId!==identity.processGroupId)return false;
  try{return await terminateProcessGroup(identity.processGroupId,100);}catch{return false;}
}
export async function runQaCommand(state:QaExecution,executable:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,timeoutMs:number,save:()=>Promise<void>,signal?:AbortSignal,beforeGo:()=>Promise<void>=async()=>{},policy?:QaPolicy):Promise<{exitCode:number|null;output:string}> {
  assertQaResourcePolicy(state,policy);
  signal?.throwIfAborted();await bindQaExecutor(state);await assertQaOwnership(state);
  state.phase='starting';state.identity=undefined;
  // Each command has its own startup intent. Keep resource ownership nonce separate.
  const commandDirectory=path.join(state.directory,randomUUID());await mkdir(commandDirectory,{recursive:true,mode:0o700});
  const identityFile=path.join(commandDirectory,'identity.json');state.identityFile=identityFile;
  await save();
  let child:ChildProcess;
  try {
    const source=import.meta.url.endsWith('.ts');
    const childPath=fileURLToPath(new URL(source?'./qa-child.ts':'./qa-child.js',import.meta.url));
    const launch=source?['--import',createRequire(import.meta.url).resolve('tsx'),childPath,identityFile]:[childPath,identityFile];
    child=spawn(process.execPath,launch,{cwd,env,stdio:['ignore','pipe','pipe','ipc'],detached:true,shell:false});
  }catch(error){state.phase='stopped';await save();throw error;} // No child was spawned in this branch.
  let output='',settled=false,handshake:Promise<void>|undefined;
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  child.stdout!.on('data',chunk=>{output=(output+String(chunk)).slice(-30_000);});child.stderr!.on('data',chunk=>{output=(output+String(chunk)).slice(-30_000);});
  try {
    return await new Promise((resolve,reject)=>{
      const finish=(error?:Error,result?:{exitCode:number|null;output:string})=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result!);};
      const abort=()=>finish(new Error('QA command cancelled'));
      const timer=setTimeout(()=>finish(new Error('QA command timed out')),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      child.once('error',()=>finish(new Error('QA launcher failed')));
      child.once('close',()=>finish(new Error('QA launcher stopped before result')));
      child.on('message',(message:{ready?:boolean;exitCode?:number|null})=>{
        if(settled)return;
        if(message.ready){handshake=(async()=>{
          const identity=await readJson<CodexProcessIdentity>(identityFile);
          if(settled||signal?.aborted)return;
          if(!identity||identity.pid!==child.pid)throw new Error('QA launcher identity missing');
          state.identity=identity;state.phase='running';await save();
          await withQaOwnership(state,async()=>{
            assertQaResourcePolicy(state,policy);
            await beforeGo();await assertQaOwnership(state);
            if(settled||signal?.aborted)return;
            // Recovery cannot release this nonce while our executor PID is alive. If we die here,
            // recovery stops this group (including queued GO) before admitting another owner.
            child.send({executable,args,cwd});
          });
        })().catch(error=>finish(error as Error));}
        else finish(undefined,{exitCode:message.exitCode??null,output});
      });
    });
  } finally {
    // Recover even if the parent crashed between spawn and identity persistence.
    if(!child.pid){state.phase='stopped';await save();}
    state.identity??=await readJson<CodexProcessIdentity>(identityFile);
    const stopped=await stopQaExecution(state);
    if(!stopped){await save();throw new Error('QA process stop is unconfirmed; reservation and resource ownership retained', {cause:new Error(output||'No identity/result from QA launcher')});}
    await closed;await handshake;state.phase='stopped';await save();
  }
}
