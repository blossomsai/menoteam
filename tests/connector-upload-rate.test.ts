import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {ConnectorRunner} from '../src/connector/runner.js';
import {ConnectorHttpError,type WorkbenchConnectorClient} from '../src/connector/client.js';
import type {CodexAppServer} from '../src/connector/codex.js';
import type {ClaimedRun,ConnectorConfig} from '../src/connector/types.js';
import {stateKey} from '../src/connector/state.js';

it('uploads 400 durable chunks across three quota windows while the actual monitor renews its 90-second lease',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'menoteam-upload-rate-')),uploadDir=path.join(dataDir,'chunks'),filePath='source.ts',dir=path.join(uploadDir,createHash('sha256').update(filePath).digest('hex'));
 await mkdir(dir,{recursive:true});for(let n=0;n<400;n++)await writeFile(path.join(dir,String(n)),Buffer.from([n%256]));
 const cfg:ConnectorConfig={serverUrl:'http://127.0.0.1:3200',token:'fixture',connectorId:'one',dataDir,projects:{},leaseRenewIntervalMs:5000};
 const claim:ClaimedRun={run:{id:'upload-run',projectId:'p',connectorId:'one',requestedBy:'owner',kind:'master',prompt:'Fixture',model:'gpt-6.1-sol',reasoning:'medium',status:'running',generation:1,createdAt:'now',updatedAt:'now',execution:{provider:'openai',method:'codex-host',skills:[],tools:[]}},project:{id:'p',name:'Fixture',instructions:'',repositoryUrl:'',deliveryAuthorization:'',createdAt:'now'},messages:[],settings:[]};
 let entered=false,rejectTurn:((e:Error)=>void)|undefined,stopped=false;
 const native={start:async()=>['gpt-6.1-sol'],processIdentity:async()=>({pid:123,processGroupId:123,startedAt:'fixture',command:'codex app-server'}),run:async()=>{entered=true;return new Promise((_resolve,reject)=>{rejectTurn=reject;});},stop:async()=>{if(entered&&!stopped){stopped=true;rejectTurn!(new Error('Fixture stop'));}}} as unknown as CodexAppServer;
 const accepted=new Map<string,string>(),attempts:string[]=[],windows=new Map<number,number>();let lease=90000,renewed=0,completed=0,rateLimits=0;
 const client={createBridgeToken:async()=>({token:'fixture',expiresAt:'later'}),readRun:async()=>claim.run,renew:async()=>{renewed++;lease=Date.now()+90000;return claim.run;},stopped:async()=>({}),complete:async()=>{completed++;return claim.run;},addArtifact:async(_id:string,_gen:number,artifact:unknown)=>{
   expect(Date.now()).toBeLessThan(lease);const a=artifact as {requestId:string;data:{chunkIndex:number;contentBase64:string}};attempts.push(a.requestId);const window=Math.floor(Date.now()/60000),count=windows.get(window)??0;
   if(count>=180){rateLimits++;throw new ConnectorHttpError(429,'quota',[],'POST','connector.runs.artifacts',Math.ceil(((window+1)*60000-Date.now())/1000));}
   windows.set(window,count+1);const bytes=JSON.stringify(a);expect(accepted.has(a.requestId)).toBe(false);accepted.set(a.requestId,bytes);return {id:a.requestId};
 }} as unknown as WorkbenchConnectorClient;
 const runner=new ConnectorRunner(cfg,{native:()=>native,client:()=>client}),probe=runner as unknown as {client:WorkbenchConnectorClient;save:(s:unknown)=>Promise<void>;flushEvidence:(s:unknown,signal:AbortSignal)=>Promise<void>};probe.client=client;
 const realTimeout=setTimeout;const log=vi.spyOn(console,'error').mockImplementation(()=>{});vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});vi.setSystemTime(0);
 const execution=runner.execute(claim).catch(()=>undefined);
 try{
  await vi.waitFor(()=>expect(entered).toBe(true));
  const spool={runId:'upload-run',generation:1,events:[],artifacts:[],completion:{threadId:'thread'},diffFileUpload:{directory:uploadDir,parentArtifactId:'parent',revision:'d'.repeat(64),baseRevision:'b'.repeat(40),candidateRevision:'c'.repeat(40),projectId:'p',workId:'w',files:[{path:filePath,sha256:createHash('sha256').update(Buffer.from(Array.from({length:400},(_,n)=>n%256))).digest('hex'),byteLength:400,chunks:400}],fileIndex:0,chunkIndex:0}};
  await probe.save(spool);let done=false;const upload=probe.flushEvidence(spool,new AbortController().signal).then(()=>{done=true;});
  for(let window=0;window<4&&!done;window++){
   const before=rateLimits;
   for(let spin=0;spin<2500&&!done&&rateLimits===before;spin++)await new Promise(resolve=>realTimeout(resolve,1));
   expect(done||rateLimits>before).toBe(true);
   if(!done){const saved=JSON.parse(await readFile(path.join(dataDir,'spool',`${stateKey('upload-run','1')}.json`),'utf8'));expect(saved.diffFileUpload.chunkIndex).toBe(accepted.size);expect(saved.completion).toEqual({threadId:'thread'});}
   if(!done)await vi.advanceTimersByTimeAsync(60000);
  }

  await upload;expect(accepted.size).toBe(400);expect(completed).toBe(1);expect(rateLimits).toBeGreaterThanOrEqual(2);expect(windows.size).toBeGreaterThanOrEqual(3);expect(renewed).toBeGreaterThan(20);
  const restored=Buffer.concat([...accepted.values()].map(value=>JSON.parse(value)).sort((a,b)=>a.data.chunkIndex-b.data.chunkIndex).map(a=>Buffer.from(a.data.contentBase64,'base64')));expect(restored.equals(Buffer.from(Array.from({length:400},(_,n)=>n%256)))).toBe(true);
  const retries=attempts.filter((id,index)=>attempts.indexOf(id)!==index);expect(retries).toHaveLength(rateLimits);expect(spool.diffFileUpload).toBeUndefined();
  expect(await readFile(path.join(dataDir,'spool',`${stateKey('upload-run','1')}.json`),'utf8').catch(()=>undefined)).toBeUndefined();
 }finally{await runner.stop();await execution;vi.useRealTimers();log.mockRestore();await rm(dataDir,{recursive:true,force:true});}
},10000);

it.each([403,409])('does not retry durable evidence on authorization/generation error %s',async status=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'menoteam-upload-denied-')),error=new ConnectorHttpError(status,'fixture'),addArtifact=vi.fn(async()=>{throw error;});
 const runner=new ConnectorRunner({dataDir,serverUrl:'http://127.0.0.1:3200',token:'fixture',connectorId:'one',projects:{}}) as unknown as {client:WorkbenchConnectorClient;save:(s:unknown)=>Promise<void>;flushEvidence:(s:unknown,signal:AbortSignal)=>Promise<void>};runner.client={addArtifact} as unknown as WorkbenchConnectorClient;
 const spool={runId:'run',generation:1,events:[],artifacts:[{kind:'diff',requestId:'stable',revision:'revision',data:{}}],completion:{threadId:'thread'}};
 try{await runner.save(spool);const file=path.join(dataDir,'spool',`${stateKey('run','1')}.json`),before=await readFile(file,'utf8');await expect(runner.flushEvidence(spool,new AbortController().signal)).rejects.toBe(error);expect(addArtifact).toHaveBeenCalledTimes(1);expect(await readFile(file,'utf8')).toBe(before);}finally{await rm(dataDir,{recursive:true,force:true});}
});
it('preserves the same outbox and stops cancellation during evidence backoff',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'menoteam-upload-cancel-')),addArtifact=vi.fn(async()=>{throw new ConnectorHttpError(429,'quota',[],'POST','connector.runs.artifacts',60);});
 const runner=new ConnectorRunner({dataDir,serverUrl:'http://127.0.0.1:3200',token:'fixture',connectorId:'one',projects:{}}) as unknown as {client:WorkbenchConnectorClient;save:(s:unknown)=>Promise<void>;flushEvidence:(s:unknown,signal:AbortSignal)=>Promise<void>};runner.client={addArtifact} as unknown as WorkbenchConnectorClient;
 const spool={runId:'run',generation:1,events:[],artifacts:[{kind:'diff',requestId:'stable',revision:'revision',data:{}}],completion:{threadId:'thread'}},controller=new AbortController(),cancel=new Error('Fixture cancel');
 try{await runner.save(spool);const file=path.join(dataDir,'spool',`${stateKey('run','1')}.json`),before=await readFile(file,'utf8');vi.useFakeTimers();const upload=runner.flushEvidence(spool,controller.signal);const rejected=expect(upload).rejects.toBe(cancel);await vi.waitFor(()=>expect(addArtifact).toHaveBeenCalledTimes(1));controller.abort(cancel);await vi.advanceTimersByTimeAsync(1000);await rejected;expect(addArtifact).toHaveBeenCalledTimes(1);expect(await readFile(file,'utf8')).toBe(before);}finally{vi.useRealTimers();await rm(dataDir,{recursive:true,force:true});}
});
