import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {qaChildEnvironment,withQaOwnership,assertQaOwnership,qaExecutorStopped,authorizedQaResource,stopQaExecution,releaseQaResource,acquireQaResource,claimQaResource,type QaExecution} from '../src/connector/qa-process.js';
import {writeSecureJson,stateKey} from '../src/connector/state.js';
import * as stateFiles from '../src/connector/state.js';
import {qaPolicyFixture} from './helpers/local-qa-fixture.js';
import * as processes from '../src/connector/codex.js';
import {ConnectorRunner} from '../src/connector/runner.js';
import type {WorkbenchConnectorClient} from '../src/connector/client.js';
import type {CodexAppServer} from '../src/connector/codex.js';
async function fixture(action:(directory:string)=>Promise<void>){const directory=await mkdtemp(path.join(os.tmpdir(),'qa-resource-proof-'));try{await action(directory);}finally{await rm(directory,{recursive:true,force:true});}}
function state(directory:string):QaExecution{return {directory:path.join(directory,randomUUID()),nonce:randomUUID(),phase:'stopped'};}
function resource(){const policy=qaPolicyFixture();policy.resource!.database=`controlled_${randomUUID().replaceAll('-','')}_test`;return policy;}
const executor={pid:process.pid,processGroupId:process.pid,startedAt:'fixture-executor-start',command:'fixture-original-Connector'};
describe('QA resource authorization and conservative startup recovery',()=>{
  beforeEach(()=>{vi.spyOn(processes,'readProcessIdentity').mockResolvedValue(executor);});
  afterEach(()=>vi.restoreAllMocks());
  it('injects the second database and serial grant only from explicit authorization, never ambient values',()=>{
    vi.stubEnv('MENOTEAM_PROVIDER_TEST_DATABASE_URL','ambient-private');vi.stubEnv('MENOTEAM_PROVIDER_TEST_SERIAL_AUTHORIZED','1');
    try{
      expect(qaChildEnvironment()).not.toHaveProperty('MENOTEAM_PROVIDER_TEST_DATABASE_URL');expect(qaChildEnvironment()).not.toHaveProperty('MENOTEAM_PROVIDER_TEST_SERIAL_AUTHORIZED');
      expect(qaChildEnvironment('explicit-main','explicit-provider')).toMatchObject({WORK_MAP_TEST_DATABASE_URL:'explicit-main',MENOTEAM_PROVIDER_TEST_DATABASE_URL:'explicit-provider',MENOTEAM_PROVIDER_TEST_SERIAL_AUTHORIZED:'1'});
    }finally{vi.unstubAllEnvs();}
  });
  it('retains all durable intents on an incomplete second owner write instead of treating I/O failure as contention',async()=>fixture(async directory=>{
    const policy=resource();policy.providerResource={...policy.resource!,id:'provider',database:`controlled_${randomUUID().replaceAll('-','')}_test`};
    const execution=state(directory);await acquireQaResource(execution,policy);const locks=[...execution.resourceLocks!];
    const original=stateFiles.writeSecureJson,write=vi.spyOn(stateFiles,'writeSecureJson').mockImplementation(async(file,value)=>{if(file===path.join(locks[1]!.directory,'owner.json'))throw Object.assign(Error('fixture I/O'),{code:'EIO'});await original(file,value);});
    try{
      await expect(claimQaResource(execution)).rejects.toThrow('fixture I/O');expect(execution.resourceLocks).toEqual(locks);
      expect(JSON.parse(await readFile(path.join(locks[0]!.directory,'owner.json'),'utf8')).owner).toBe(execution.nonce);
      await expect(releaseQaResource(execution)).rejects.toThrow('ownership cannot be proven');
    }finally{
      write.mockRestore(); // Repair only this test's incomplete private record, then use the production release proof.
      await original(path.join(locks[1]!.directory,'owner.json'),{owner:execution.nonce,executionDirectory:execution.directory,executor:execution.executor});await releaseQaResource(execution);
    }
  }));
  it('rolls back the first canonical lock when the second is contended, without touching the other owner',async()=>fixture(async directory=>{
    const policy=resource();policy.providerResource={...policy.resource!,id:'provider',database:`controlled_${randomUUID().replaceAll('-','')}_test`};
    const execution=state(directory);await acquireQaResource(execution,policy);
    const [first,second]=execution.resourceLocks!;
    const occupied=state(directory);occupied.resourceLock={directory:second!.directory,owner:occupied.nonce};await claimQaResource(occupied);
    try{
      await expect(claimQaResource(execution)).rejects.toThrow('owned by another');expect(execution.resourceLocks).toBeUndefined();
      await expect(readFile(path.join(first!.directory,'owner.json'))).rejects.toMatchObject({code:'ENOENT'});
      expect(JSON.parse(await readFile(path.join(second!.directory,'owner.json'),'utf8')).owner).toBe(occupied.nonce);
    }finally{await releaseQaResource(occupied);}
  }));
  it('checks both owners before GO and retains both reservations when original executor stop is unknown',async()=>fixture(async directory=>{
    const policy=resource();policy.providerResource={...policy.resource!,id:'provider',database:`controlled_${randomUUID().replaceAll('-','')}_test`};
    const execution=state(directory);await acquireQaResource(execution,policy);await claimQaResource(execution);
    const locks=[...execution.resourceLocks!],file=path.join(locks[1]!.directory,'owner.json'),owner=JSON.parse(await readFile(file,'utf8'));
    try{
      await writeSecureJson(file,{...owner,owner:'foreign'});await expect(withQaOwnership(execution,async()=>{throw Error('must not GO');})).rejects.toThrow('no GO');
      await writeSecureJson(file,owner);execution.executor={...executor,pid:424242};vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(Error('denied'),{code:'EPERM'});});
      await expect(releaseQaResource(execution)).rejects.toThrow('executor stop proof');
      for(const lock of locks)expect(JSON.parse(await readFile(path.join(lock.directory,'owner.json'),'utf8')).owner).toBe(execution.nonce);
    }finally{execution.executor=executor;await releaseQaResource(execution);}
  }));
  it('requires exact explicit disposable host authorization, not suffix/ambient configuration',()=>{
    const policy=resource(),r=policy.resource!;
    const valid=`postgres://fixture-only@${r.hostname}:${r.port}/${r.database}`;
    expect(authorizedQaResource(policy,{[r.id]:{url:valid}})).toBe(valid);
    for(const url of ['postgres://fixture@127.0.0.1:55439/menoteam_workbench_runtime',valid.replace('55439','55440'),valid.replace(r.database,'different_test'),valid+'?options=other'])expect(()=>authorizedQaResource(policy,{[r.id]:{url}})).toThrow();
    expect(()=>authorizedQaResource(policy,{})).toThrow();
  });
  it('does not kill or release a startup with missing identity',async()=>fixture(async directory=>{const pending=state(directory);pending.phase='starting';expect(await stopQaExecution(pending)).toBe(false);}));
  it('rejects forged/reused identity without signaling a process',async()=>fixture(async directory=>{const pending=state(directory);pending.phase='running';pending.identity={pid:process.pid,processGroupId:process.pid,startedAt:'forged',command:'untrusted child'};const kill=vi.spyOn(process,'kill');try{expect(await stopQaExecution(pending)).toBe(false);expect(kill).not.toHaveBeenCalled();}finally{kill.mockRestore();}}));
  it.each(['reused','unknown'])('retains resource for %s process identity and never signals it',async mode=>fixture(async directory=>{
    const execution=state(directory),policy=resource();await acquireQaResource(execution,policy);await claimQaResource(execution);
    execution.phase='running';execution.identity={pid:123456,processGroupId:123456,startedAt:'expected-start',command:'node qa-child.js private-intent'};
    const wait=vi.spyOn(processes,'waitProcessGroup').mockResolvedValue(false),read=vi.spyOn(processes,'readProcessIdentity').mockImplementation(async pid=>pid===process.pid?executor:mode==='unknown'?undefined:{...execution.identity!,startedAt:'reused-start'}),terminate=vi.spyOn(processes,'terminateProcessGroup');
    try{expect(await stopQaExecution(execution)).toBe(false);await expect(releaseQaResource(execution)).rejects.toThrow('stop proof');expect(terminate).not.toHaveBeenCalled();expect(JSON.parse(await readFile(path.join(execution.resourceLock!.directory,'owner.json'),'utf8')).owner).toBe(execution.nonce);}finally{wait.mockRestore();read.mockResolvedValue(executor);terminate.mockRestore();execution.identity=undefined;execution.phase='stopped';await releaseQaResource(execution);}
  }));
  it('recovers durable stopped QA, sends one stopped acknowledgement and releases its resource',async()=>fixture(async directory=>{
    const execution=state(directory),policy=resource();await acquireQaResource(execution,policy);await claimQaResource(execution);
    const dead={...executor,pid:424242,processGroupId:424242};execution.executor=dead;
    await writeSecureJson(path.join(execution.resourceLock!.directory,'owner.json'),{owner:execution.nonce,executionDirectory:execution.directory,executor:dead});
    vi.spyOn(process,'kill').mockImplementation((pid)=>{if(pid===dead.pid)throw Object.assign(Error('gone'),{code:'ESRCH'});return true;});
    const spool={runId:'qa-run',generation:1,events:[],artifacts:[],qaInFlight:true,qaExecution:execution};
    const file=path.join(directory,'spool',`${stateKey('qa-run','1')}.json`);await writeSecureJson(file,spool);
    let acknowledgements=0,runner:ConnectorRunner;
    const client={readRun:async()=>({id:'qa-run',generation:1,status:'interrupted'}),stopped:async()=>{acknowledgements++;},claim:async()=>{await runner.stop();return undefined;}} as unknown as WorkbenchConnectorClient;
    runner=new ConnectorRunner({serverUrl:'http://fixture.invalid',token:'fixture-only',connectorId:'fixture',dataDir:directory,projects:{},pollIntervalMs:1},{client:()=>client,native:()=>({start:async()=>['gpt-6.1-sol'],stop:async()=>{}} as unknown as CodexAppServer)});
    await runner.run();expect(acknowledgements).toBe(1);await expect(readFile(file)).rejects.toMatchObject({code:'ENOENT'});
    const next=state(directory);await acquireQaResource(next,policy);await claimQaResource(next);await releaseQaResource(next);
  }));
  it.each(['live','reused','denied','missing'])('recovery never releases resource for %s original executor even between commands',async mode=>fixture(async directory=>{
    const execution=state(directory),policy=resource();await acquireQaResource(execution,policy);await claimQaResource(execution);
    if(mode==='missing')delete execution.executor;
    const kill=vi.spyOn(process,'kill').mockImplementation(()=>{if(mode==='denied')throw Object.assign(Error('denied'),{code:'EPERM'});return true;});
    if(mode==='reused')vi.mocked(processes.readProcessIdentity).mockResolvedValue({...executor,startedAt:'different-start'});
    const spool={runId:'qa-run',generation:1,events:[],artifacts:[],qaInFlight:true,qaExecution:execution},file=path.join(directory,'spool',`${stateKey('qa-run','1')}.json`);
    await writeSecureJson(file,spool);let acknowledgements=0,runner:ConnectorRunner;
    const client={readRun:async()=>({id:'qa-run',generation:1,status:'interrupted'}),stopped:async()=>{acknowledgements++;},claim:async()=>{await runner.stop();return undefined;}} as unknown as WorkbenchConnectorClient;
    runner=new ConnectorRunner({serverUrl:'http://fixture.invalid',token:'fixture-only',connectorId:'fixture',dataDir:directory,projects:{},pollIntervalMs:1},{client:()=>client,native:()=>({start:async()=>['gpt-6.1-sol'],stop:async()=>{}} as unknown as CodexAppServer)});
    try{
      expect(qaExecutorStopped(execution)).toBe(false);await runner.run();expect(acknowledgements).toBe(0);expect(await readFile(file,'utf8')).toContain('qaInFlight');
      expect(JSON.parse(await readFile(path.join(execution.resourceLock!.directory,'owner.json'),'utf8')).owner).toBe(execution.nonce);
    }finally{kill.mockRestore();vi.mocked(processes.readProcessIdentity).mockResolvedValue(executor);execution.executor=executor;await releaseQaResource(execution);}
  }));
  it('checks the exact executor and nonce before GO, retaining the lock on replaced ownership',async()=>fixture(async directory=>{
    const execution=state(directory),policy=resource();await acquireQaResource(execution,policy);await claimQaResource(execution);
    await expect(assertQaOwnership(execution)).resolves.toBeUndefined();
    const ownerFile=path.join(execution.resourceLock!.directory,'owner.json'),owner=JSON.parse(await readFile(ownerFile,'utf8'));
    try{
      await writeSecureJson(ownerFile,{...owner,owner:'replacement'});await expect(assertQaOwnership(execution)).rejects.toThrow('no GO');await expect(releaseQaResource(execution)).rejects.toThrow('ownership');
      await writeSecureJson(ownerFile,{...owner,executor:{...executor,startedAt:'reused'}});await expect(assertQaOwnership(execution)).rejects.toThrow('no GO');
      vi.mocked(processes.readProcessIdentity).mockResolvedValue({...executor,startedAt:'different'});await expect(assertQaOwnership(execution)).rejects.toThrow('executor ownership');
    }finally{vi.mocked(processes.readProcessIdentity).mockResolvedValue(executor);await writeSecureJson(ownerFile,owner);await releaseQaResource(execution);}
  }));

  it('serializes ownership check AND GO with release/claim, and a stale second recoverer cannot delete a new owner',async()=>fixture(async directory=>{
    const policy=resource(),first=state(directory);await acquireQaResource(first,policy);await claimQaResource(first);
    const stale=structuredClone(first),next=state(directory);await acquireQaResource(next,policy);
    let entered!:()=>void,resume!:()=>void;
    const ready=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>resume=resolve);
    const go=withQaOwnership(first,async()=>{entered();await hold;return 'GO';});await ready;
    try{await expect(releaseQaResource(stale)).rejects.toThrow('guard');await expect(claimQaResource(next)).rejects.toThrow('guard');}
    finally{resume();await expect(go).resolves.toBe('GO');}
    await releaseQaResource(first);await claimQaResource(next);
    try{await expect(releaseQaResource(stale)).rejects.toThrow('ownership');expect(JSON.parse(await readFile(path.join(next.resourceLock!.directory,'owner.json'),'utf8')).owner).toBe(next.nonce);}
    finally{await releaseQaResource(next);}
  }));
  it('retains an incomplete guard rather than stealing it or sending GO',async()=>fixture(async directory=>{
    const execution=state(directory),policy=resource();await acquireQaResource(execution,policy);await claimQaResource(execution);
    const guard=execution.resourceLock!.directory+'.guard';await writeSecureJson(path.join(guard,'owner.json'),{nonce:'unknown-startup'});
    try{await expect(withQaOwnership(execution,async()=>{throw Error('must not GO');})).rejects.toThrow('unknown guard');await expect(releaseQaResource(execution)).rejects.toThrow('unknown guard');}
    finally{await rm(guard,{recursive:true});await releaseQaResource(execution);} // Only this test's deliberately injected guard.
  }));
  it('reads and validates remote generation before any recovery stop/release',async()=>fixture(async directory=>{
    const execution=state(directory),policy=resource();await acquireQaResource(execution,policy);await claimQaResource(execution);
    const spool={runId:'qa-run',generation:1,events:[],artifacts:[],qaInFlight:true,qaExecution:execution},file=path.join(directory,'spool',`${stateKey('qa-run','1')}.json`);await writeSecureJson(file,spool);
    const kill=vi.spyOn(process,'kill');let acknowledgements=0,runner:ConnectorRunner;
    const client={readRun:async()=>({id:'qa-run',generation:2,status:'interrupted'}),stopped:async()=>{acknowledgements++;},claim:async()=>{await runner.stop();return undefined;}} as unknown as WorkbenchConnectorClient;
    runner=new ConnectorRunner({serverUrl:'http://fixture.invalid',token:'fixture-only',connectorId:'fixture',dataDir:directory,projects:{},pollIntervalMs:1},{client:()=>client,native:()=>({start:async()=>['gpt-6.1-sol'],stop:async()=>{}} as unknown as CodexAppServer)});
    try{await runner.run();expect(acknowledgements).toBe(0);expect(kill).not.toHaveBeenCalled();expect(JSON.parse(await readFile(file,'utf8'))).toEqual(spool);}
    finally{kill.mockRestore();await releaseQaResource(execution);}
  }));

});
