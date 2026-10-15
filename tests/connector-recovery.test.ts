import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ConnectorRunner } from '../src/connector/runner.js';
import { ConnectorHttpError, WorkbenchConnectorClient } from '../src/connector/client.js';
import { terminateProcessGroup, waitProcessGroup, type CodexAppServer } from '../src/connector/codex.js';
import { stateKey, writeSecureJson } from '../src/connector/state.js';
import type { ClaimedRun, ConnectorConfig } from '../src/connector/types.js';

function claim(id='revoked-run'):ClaimedRun {
  return {run:{id,projectId:'project',connectorId:'connector',requestedBy:'member',kind:'master',prompt:'Private request',model:'gpt-6.1-sol',reasoning:'medium',generation:1,status:'running',createdAt:'now',updatedAt:'now',execution:{provider:'openai',method:'codex-host',connectorId:'connector',skills:[],tools:[]}},project:{id:'project',name:'Fixture',instructions:'Private instructions',repositoryUrl:'',deliveryAuthorization:'',createdAt:'now'},messages:[],settings:[]};
}
function control(id='revoked-run',generation=1) {
  return {id,generation,status:'running' as const,preEffectStaging:false,stagingRetired:false,merged:false};
}
async function bounded<T>(task:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  return Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Bounded recovery fixture timed out')),5000);})]).finally(()=>clearTimeout(timer));
}

it('revocation stops the actual owned group; lost stopped ACK is replayed after restart without full reads',async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'menoteam-revoked-recovery-'));
  const config:ConnectorConfig={serverUrl:'http://127.0.0.1:3200',token:'fixture',connectorId:'connector',dataDir,projects:{},pollIntervalMs:1,leaseRenewIntervalMs:5};
  let child:ChildProcess|undefined,pid=0,revoked=false,claimed=false,runner:ConnectorRunner|undefined;
  let rejectTurn:(error:Error)=>void=()=>{};
  let signalAck:()=>void=()=>{};const ackAttempt=new Promise<void>(resolve=>{signalAck=resolve;});
  let signalPreRevokeRenew:()=>void=()=>{};const preRevokeRenew=new Promise<void>(resolve=>{signalPreRevokeRenew=resolve;});
  const renewalRevocationStates:boolean[]=[];
  let execution:Promise<void>|undefined;
  const native={start:async()=>{if(claimed&&!child){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','codex','app-server'],{detached:true,stdio:'ignore'});pid=child.pid!;}return ['gpt-6.1-sol'];},
    // The fixture native adapter records its spawned PID; stop proof below is the actual OS group absence.
    processIdentity:async()=>({pid,processGroupId:pid,startedAt:'fixture-owned-spawn',command:child!.spawnargs.join(' ')}),
    run:async()=>{await preRevokeRenew;revoked=true;return new Promise((_resolve,reject)=>{rejectTurn=reject;});},
    stop:async()=>{if(child){expect(await terminateProcessGroup(pid,100)).toBe(true);rejectTurn(Error('Actual group stopped'));}}
  } as unknown as CodexAppServer;
  const readRun=vi.fn(async()=>{if(revoked)throw new ConnectorHttpError(403,'Run authorization revoked');return claim().run;});
  const first={readRun,createBridgeToken:async()=>({token:'fixture'.padEnd(32,'x'),expiresAt:'later'}),
    claim:async()=>{if(!claimed){claimed=true;return claim();}await ackAttempt;await runner!.stop();return undefined;},
    stopped:async()=>{expect(await waitProcessGroup(pid,1)).toBe(true);signalAck();throw new ConnectorHttpError(503,'Stopped request lost');},
    complete:vi.fn(),renew:vi.fn(async()=>{renewalRevocationStates.push(revoked);signalPreRevokeRenew();})
  } as unknown as WorkbenchConnectorClient;
  const spoolPath=path.join(dataDir,'spool',`${stateKey('revoked-run','1')}.json`);
  try{
    runner=new ConnectorRunner(config,{native:()=>native,client:()=>first});execution=runner.run();await bounded(execution);
    const saved=JSON.parse(await readFile(spoolPath,'utf8'));expect(saved.stopped).toBe(true);expect(saved.processIdentity.pid).toBe(pid);expect(saved.generation).toBe(1);
    expect(first.complete).not.toHaveBeenCalled();expect(first.renew).toHaveBeenCalled();expect(renewalRevocationStates).not.toContain(true);
    let acknowledgements=0;
    const fetcher=vi.fn(async(url:URL|RequestInfo,init?:RequestInit)=>{
      const route=String(url);const body=JSON.parse(String(init?.body||'{}'));
      if(route.endsWith('/recovery-state')){expect(body).toEqual({generation:1});return Response.json(control());}
      if(route.endsWith('/stopped')){expect(body.generation).toBe(1);expect(await waitProcessGroup(pid,1)).toBe(true);acknowledgements++;return Response.json({...control(),status:'interrupted'});}
      if(route.endsWith('/claim')){await runner!.stop();return new Response(null,{status:204});}
      throw Error('Restart must not read context, renew or execute');
    });
    runner=new ConnectorRunner(config,{native:()=>({start:async()=>['gpt-6.1-sol'],stop:async()=>{}} as unknown as CodexAppServer),client:()=>new WorkbenchConnectorClient(config,fetcher as typeof fetch)});
    execution=runner.run();await bounded(execution);expect(acknowledgements).toBe(1);expect(await readdir(path.join(dataDir,'spool'))).toEqual([]);
  }finally{signalAck();signalPreRevokeRenew();await runner?.stop();await bounded(execution??Promise.resolve()).catch(()=>{});if(pid)await terminateProcessGroup(pid,100);await rm(dataDir,{recursive:true,force:true});}
},12000);

it.each(['read-failure','old-generation','unknown-native'])('retains %s spool and permits an independent authorized run',async fault=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'menoteam-isolated-recovery-'));
  const config:ConnectorConfig={serverUrl:'http://127.0.0.1:3200',token:'fixture',connectorId:'connector',dataDir,projects:{},pollIntervalMs:1};
  const spool={runId:'blocked-run',generation:1,events:[],artifacts:[],...(fault==='unknown-native'?{}:{stopped:true}),qaInFlight:fault==='read-failure',...(fault==='read-failure'?{qaExecution:{directory:path.join(dataDir,'qa'),nonce:'original',phase:'stopped'}}:{})};
  const file=path.join(dataDir,'spool',`${stateKey('blocked-run','1')}.json`);
  let runner:ConnectorRunner|undefined,execution:Promise<void>|undefined,claimed=false,completed=false;
  const stopped=vi.fn(),kill=vi.spyOn(process,'kill');
  const client={recoveryState:async()=>{if(fault==='read-failure')throw new ConnectorHttpError(403,'Original Connector denied');return control('blocked-run',fault==='old-generation'?2:1);},
    claim:async()=>{if(!claimed){claimed=true;return claim('independent-run');}if(completed)await runner!.stop();return undefined;},
    readRun:async()=>claim('independent-run').run,createBridgeToken:async()=>({token:'fixture'.padEnd(32,'x'),expiresAt:'later'}),complete:async()=>{completed=true;},stopped
  } as unknown as WorkbenchConnectorClient;
  const native={start:async()=>['gpt-6.1-sol'],processIdentity:async()=>({pid:123,processGroupId:123,startedAt:'fixture',command:'codex app-server'}),stop:async()=>{},run:async()=>({threadId:'independent-thread',text:'done',checks:[]})} as unknown as CodexAppServer;
  try{
    await writeSecureJson(file,spool);const saved=await readFile(file,'utf8');
    runner=new ConnectorRunner(config,{native:()=>native,client:()=>client});execution=runner.run();await bounded(execution);
    expect(completed).toBe(true);expect(stopped).not.toHaveBeenCalled();expect(kill).not.toHaveBeenCalled();expect(await readFile(file,'utf8')).toBe(saved);
  }finally{kill.mockRestore();await runner?.stop();await bounded(execution??Promise.resolve()).catch(()=>{});await rm(dataDir,{recursive:true,force:true});}
},10000);
