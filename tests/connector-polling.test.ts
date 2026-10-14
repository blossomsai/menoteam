import { mkdtemp,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect,it,vi } from 'vitest';
import { ConnectorRunner } from '../src/connector/runner.js';
import { ConnectorHttpError,type WorkbenchConnectorClient } from '../src/connector/client.js';
import { stateKey } from '../src/connector/state.js';
import type { ConnectorConfig } from '../src/connector/types.js';

type Probe={client:WorkbenchConnectorClient;save:(spool:unknown)=>Promise<void>;recover:()=>Promise<void>;pollBlockedUntil:number};
async function fixture(staging=false){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'menoteam-polling-'));
 const config:ConnectorConfig={dataDir,serverUrl:'http://127.0.0.1:3200',token:'fixture-token',connectorId:'fixture',projects:{}};
 const runner=new ConnectorRunner(config) as unknown as Probe;
 const spools=['one','two','three'].map(runId=>({runId,generation:1,events:[],artifacts:[],diffFileUpload:{fileIndex:3,chunkIndex:2},...(staging?{stagingReceipt:{phase:'health_passed'}}:{})}));
 for(const spool of spools)await runner.save(spool);
 const files=spools.map(spool=>path.join(dataDir,'spool',`${stateKey(spool.runId,'1')}.json`));
 const before=await Promise.all(files.map(file=>readFile(file,'utf8')));
 return {runner,dataDir,unchanged:async()=>expect(await Promise.all(files.map(file=>readFile(file,'utf8')))).toEqual(before)};
}
it('bounds repeated recovery reads of retained terminal spools without changing pending upload cursors',async()=>{
 const f=await fixture(),now=vi.spyOn(Date,'now').mockReturnValue(1_000),read=vi.fn(async(runId:string)=>({id:runId,generation:1,status:'completed'}));f.runner.client={recoveryState:read} as unknown as WorkbenchConnectorClient;
 try{await f.runner.recover();expect(read).toHaveBeenCalledTimes(3);await f.runner.recover();expect(read).toHaveBeenCalledTimes(3);now.mockReturnValue(30_999);await f.runner.recover();expect(read).toHaveBeenCalledTimes(3);now.mockReturnValue(31_000);await f.runner.recover();expect(read).toHaveBeenCalledTimes(6);await f.unchanged();}finally{now.mockRestore();await rm(f.dataDir,{recursive:true,force:true});}
});
it.each([403,409])('throttles one spool error %s without blocking unrelated authorization or deleting evidence',async status=>{
 const f=await fixture(),now=vi.spyOn(Date,'now').mockReturnValue(1_000),log=vi.spyOn(console,'error').mockImplementation(()=>{}),read=vi.fn(async()=>{throw new ConnectorHttpError(status,'fixture');});f.runner.client={recoveryState:read} as unknown as WorkbenchConnectorClient;
 try{await f.runner.recover();expect(read).toHaveBeenCalledTimes(3);expect(f.runner.pollBlockedUntil).toBe(0);await f.runner.recover();expect(read).toHaveBeenCalledTimes(3);await f.unchanged();}finally{now.mockRestore();log.mockRestore();await rm(f.dataDir,{recursive:true,force:true});}
});
it.each([45,123])('honors Retry-After %s before reading further spools and keeps current evidence unchanged',async seconds=>{
 const f=await fixture(),now=vi.spyOn(Date,'now').mockReturnValue(1_000),log=vi.spyOn(console,'error').mockImplementation(()=>{}),read=vi.fn(async()=>{throw new ConnectorHttpError(429,'fixture',[],'POST','connector.runs.recovery-state',seconds);});f.runner.client={recoveryState:read} as unknown as WorkbenchConnectorClient;
 try{await f.runner.recover();expect(read).toHaveBeenCalledTimes(1);expect(f.runner.pollBlockedUntil).toBe(1_000+seconds*1_000);now.mockReturnValue(seconds*1_000+999);await f.runner.recover();expect(read).toHaveBeenCalledTimes(1);await f.unchanged();now.mockReturnValue(1_000+seconds*1_000);await f.runner.recover();expect(read).toHaveBeenCalledTimes(2);}finally{now.mockRestore();log.mockRestore();await rm(f.dataDir,{recursive:true,force:true});}
});

it('staging receipt flush rate limits stop the same recovery pass and preserve all pending receipts',async()=>{
 const f=await fixture(true),now=vi.spyOn(Date,'now').mockReturnValue(1_000),read=vi.fn(async(runId:string)=>({id:runId,generation:1,status:'running'}));f.runner.client={recoveryState:read} as unknown as WorkbenchConnectorClient;
 const flush=vi.spyOn(f.runner as unknown as {flush:()=>Promise<void>},'flush').mockRejectedValue(new ConnectorHttpError(429,'fixture',[],'POST','connector.runs.staging-progress',120));
 try{await f.runner.recover();expect(read).toHaveBeenCalledTimes(1);expect(flush).toHaveBeenCalledTimes(1);expect(f.runner.pollBlockedUntil).toBe(121_000);await f.runner.recover();expect(read).toHaveBeenCalledTimes(1);await f.unchanged();}finally{now.mockRestore();flush.mockRestore();await rm(f.dataDir,{recursive:true,force:true});}
});

it('keeps the actual active-run renewal timer working during a long main-loop cooldown and stops promptly',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'menoteam-poll-timer-'));
 const config:ConnectorConfig={dataDir,serverUrl:'http://127.0.0.1:3200',token:'fixture',connectorId:'fixture',projects:{},leaseRenewIntervalMs:5,pollIntervalMs:1000};
 const claim={run:{id:'active-run',connectorId:'fixture',projectId:'p',requestedBy:'owner',kind:'master',prompt:'Fixture',model:'gpt-6.1-sol',reasoning:'medium',status:'running',generation:1,createdAt:'now',updatedAt:'now',execution:{provider:'openai',method:'codex-host',skills:[],tools:[]}},project:{id:'p',name:'Fixture',instructions:'',repositoryUrl:'',deliveryAuthorization:'',createdAt:'now'},messages:[],settings:[]} as import('../src/connector/types.js').ClaimedRun;
 let entered=false,rejectTurn:((error:Error)=>void)|undefined,stopped=false;
 const native={start:async()=>['gpt-6.1-sol'],processIdentity:async()=>({pid:123,processGroupId:123,startedAt:'fixture',command:'codex app-server'}),run:async()=>{entered=true;return new Promise((_resolve,reject)=>{rejectTurn=reject;});},stop:async()=>{if(entered&&!stopped){stopped=true;rejectTurn!(new Error('Fixture stopped'));}}} as unknown as import('../src/connector/codex.js').CodexAppServer;
 const reads=vi.fn(async()=>claim.run),renewals=vi.fn(async()=>claim.run),claims=vi.fn(async()=>{if(claims.mock.calls.length===1)return claim;throw new ConnectorHttpError(429,'fixture',[],'POST','connector.claim',120);});
 const client={claim:claims,readRun:reads,renew:renewals,createBridgeToken:async()=>({token:'fixture',expiresAt:'later'}),stopped:async()=>({}),recoveryState:async()=>({id:'active-run',generation:1,status:'interrupted'})} as unknown as WorkbenchConnectorClient;
 const runner=new ConnectorRunner(config,{native:()=>native,client:()=>client}),log=vi.spyOn(console,'error').mockImplementation(()=>{});
 const running=runner.run();
 try{
  await vi.waitFor(()=>{expect(claims).toHaveBeenCalledTimes(2);expect(renewals.mock.calls.length).toBeGreaterThan(0);},{timeout:1000,interval:10});
  const count=renewals.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,20));expect(renewals.mock.calls.length).toBeGreaterThan(count);expect(reads.mock.calls.length).toBeGreaterThan(0);expect(claims).toHaveBeenCalledTimes(2);
  const before=Date.now();await runner.stop();await running;expect(Date.now()-before).toBeLessThan(1500);expect(stopped).toBe(true);
 }finally{await runner.stop();await running;log.mockRestore();await rm(dataDir,{recursive:true,force:true});}
});
