import {describe,it,expect} from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireQaResource,claimQaResource,qaChildEnvironment,runQaCommand,stopQaExecution,releaseQaResource,type QaExecution } from '../src/connector/qa-process.js';
import { waitProcessGroup } from '../src/connector/codex.js';
import { readJson,writeSecureJson,stateKey } from '../src/connector/state.js';
import { qaPolicyFixture } from './helpers/local-qa-fixture.js';
import { qaProcessFixture } from './helpers/qa-process-fixture.js';
import { qaFixtureBudget } from './helpers/qa-fixture-budget.js';
import { ConnectorRunner } from '../src/connector/runner.js';
import type { WorkbenchConnectorClient } from '../src/connector/client.js';
import type { CodexAppServer } from '../src/connector/codex.js';
function resource(){const policy=qaPolicyFixture();policy.resource!.database=`controlled_${randomUUID().replaceAll('-','')}_test`;return policy;}
const descendantScript=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,descendant:child.pid}));setInterval(()=>{},1000);`;
async function recovery(directory:string){let acknowledgements=0,runner:ConnectorRunner;
  const client={readRun:async()=>({id:'qa-run',generation:1,status:'interrupted'}),stopped:async()=>{acknowledgements++;},claim:async()=>{await runner.stop();return undefined;}} as unknown as WorkbenchConnectorClient;
  runner=new ConnectorRunner({serverUrl:'http://fixture.invalid',token:'fixture-only',connectorId:'fixture',dataDir:directory,projects:{},pollIntervalMs:1},{client:()=>client,native:()=>({start:async()=>['gpt-6.1-sol'],stop:async()=>{}} as unknown as CodexAppServer)});
  await runner.run();return acknowledgements;
}
describe('controlled REAL child process and cross-process resource proofs (operator process access required)',()=>{
  it('a second-resource conflict in another process rolls back the first without releasing the conflicting owner',async()=>qaProcessFixture(async f=>{
    const policy=resource();policy.providerResource={...policy.resource!,id:'provider',database:`provider_${randomUUID().replaceAll('-','')}_test`};
    const sorted=[policy.resource!,policy.providerResource].sort((a,b)=>stateKey(a.hostname,String(a.port),a.database).localeCompare(stateKey(b.hostname,String(b.port),b.database)));
    const owner=await f.parent(f.state(),{...policy,resource:sorted[1],providerResource:undefined},'lock');await f.until(async()=>owner.output.includes('owned'));
    const contender=await f.parent(f.state(),policy,'lock');expect(await contender.closed).toBe(1);
    const free=await f.parent(f.state(),{...policy,resource:sorted[0],providerResource:undefined},'lock');await f.until(async()=>free.output.includes('owned'));
    expect(owner.child.exitCode).toBeNull();free.child.stdin!.write('release');expect(await free.closed).toBe(0);
    owner.child.stdin!.write('release');expect(await owner.closed).toBe(0);
  },qaFixtureBudget(40_000)),40_000);
  it('holds both canonical resources across processes and releases both only after parent crash reconciliation',async()=>qaProcessFixture(async f=>{
    const policy=resource();policy.providerResource={...policy.resource!,id:'provider',database:`provider_${randomUUID().replaceAll('-','')}_test`};
    const old=await f.parent(f.state(),policy,'lock');await f.until(async()=>old.output.includes('owned'));
    const saved=(await readJson<QaExecution>(old.stateFile))!;expect(saved.resourceLocks).toHaveLength(2);
    expect(saved.resourceLocks!.map(lock=>lock.directory)).toEqual(saved.resourceLocks!.map(lock=>lock.directory).sort());
    for(const r of [policy.resource!,policy.providerResource]){
      const contender=await f.parent(f.state(),{...policy,resource:r,providerResource:undefined},'lock');expect(await contender.closed).toBe(1);
    }
    await f.stopParent(old.entry);
    const blocked=await f.parent(f.state(),policy,'lock');expect(await blocked.closed).toBe(1);
    await releaseQaResource(saved);
    const next=await f.parent(f.state(),policy,'lock');await f.until(async()=>next.output.includes('owned'));next.child.stdin!.write('release');expect(await next.closed).toBe(0);
  },qaFixtureBudget(40_000)),40_000);
  it('serializes independent Connector processes; parent crash does not free its resource',async()=>qaProcessFixture(async f=>{
    const policy=resource(),one=await f.parent(f.state(),policy,'lock');await f.until(async()=>one.output.includes('owned'));
    const two=await f.parent(f.state(),policy,'lock');expect(await two.closed).toBe(1);expect(two.output).not.toContain('owned');expect(two.errors).toContain('owned by another');
    await f.stopParent(one.entry);
    const three=await f.parent(f.state(),policy,'lock');expect(await three.closed).toBe(1);expect(three.output).not.toContain('owned');
    const saved=(await readJson<QaExecution>(one.stateFile))!;expect(await stopQaExecution(saved)).toBe(true);await releaseQaResource(saved);
    const four=await f.parent(f.state(),policy,'lock');await f.until(async()=>four.output.includes('owned'));four.child.stdin!.write('release');expect(await four.closed).toBe(0);
  },qaFixtureBudget(40_000)),40_000);
  it('recovers parent crash during identity persistence without ever sending repository GO',async()=>qaProcessFixture(async f=>{
    const policy=resource(),marker=path.join(f.directory,'must-not-run');
    const old=await f.parent(f.state(),policy,'startup',['-e',"require('node:fs').writeFileSync(process.argv[1],'unauthorized')",marker]);
    await f.until(async()=>old.output.includes('identity-ready'));await f.stopParent(old.entry);
    const saved=(await readJson<QaExecution>(old.stateFile))!;expect(saved.phase).toBe('starting');expect(saved.identity).toBeUndefined();
    expect(await stopQaExecution(saved)).toBe(true);await releaseQaResource(saved);await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
    const next=await f.parent(f.state(),policy,'lock');await f.until(async()=>next.output.includes('owned'));next.child.stdin!.write('release');expect(await next.closed).toBe(0);
  },qaFixtureBudget(30_000)),30_000);
  it.each(['cancel','timeout'])('stops real command and descendants before %s returns',async mode=>qaProcessFixture(async f=>{
    const execution=f.state(),abort=new AbortController(),marker=path.join(f.directory,'started.json');
    f.abort.signal.addEventListener('abort',()=>abort.abort(),{once:true});
    const result=f.track(runQaCommand(execution,process.execPath,['-e',descendantScript,marker],f.directory,qaChildEnvironment(),mode==='timeout'?3000:10_000,()=>writeSecureJson(path.join(f.directory,'state.json'),execution),abort.signal));
    const assertion=f.track(expect(result).rejects.toThrow(mode==='timeout'?'timed out':'cancelled'));
    await f.until(async()=>{try{await readFile(marker);return true;}catch{return false;}});
    const observed=JSON.parse(await readFile(marker,'utf8')) as {pid:number;descendant:number};await f.observe([observed.pid,observed.descendant]);
    if(mode==='cancel')abort.abort();await assertion;
    expect(execution.phase).toBe('stopped');expect(await waitProcessGroup(execution.identity!.processGroupId,100)).toBe(true);
    for(const pid of [observed.pid,observed.descendant])expect(()=>process.kill(pid,0)).toThrow();
  },qaFixtureBudget(30_000)),30_000);
  it('reconciles real parent crash after GO, kills descendants, then allows the next owner',async()=>qaProcessFixture(async f=>{
    const policy=resource(),marker=path.join(f.directory,'started.json');
    const old=await f.parent(f.state(),policy,undefined,['-e',descendantScript,marker]);
    await f.until(async()=>{try{await readFile(marker);return true;}catch{return false;}});
    const observed=JSON.parse(await readFile(marker,'utf8')) as {pid:number;descendant:number};await f.observe([observed.pid,observed.descendant]);
    await f.stopParent(old.entry);
    const next=await f.parent(f.state(),policy,'lock');expect(await next.closed).toBe(1);
    const saved=(await readJson<QaExecution>(old.stateFile))!;expect(saved.phase).toBe('running');expect(await stopQaExecution(saved)).toBe(true);expect(await waitProcessGroup(saved.identity!.processGroupId,100)).toBe(true);
    await releaseQaResource(saved);
    const resumed=await f.parent(f.state(),policy,'lock');await f.until(async()=>resumed.output.includes('owned'));resumed.child.stdin!.write('release');expect(await resumed.closed).toBe(0);
  },qaFixtureBudget(30_000)),30_000);
  it('a second same-config Connector cannot stop/release a live parent BETWEEN commands; real stop admits next owner',async()=>qaProcessFixture(async f=>{
    const policy=resource(),marker=path.join(f.directory,'second-command');
    const old=await f.parent(f.state(),policy,'between',['-e','process.exit(0)'],['-e',"require('node:fs').writeFileSync(process.argv[1],'overlap')",marker]);
    await f.until(async()=>old.output.includes('between-commands'));
    const saved=(await readJson<QaExecution>(old.stateFile))!;expect(saved.phase).toBe('stopped');
    const spool={runId:'qa-run',generation:1,events:[],artifacts:[],qaInFlight:true,qaExecution:saved};
    const file=path.join(f.directory,'spool',`${stateKey('qa-run','1')}.json`);await writeSecureJson(file,spool);
    expect(await recovery(f.directory)).toBe(0);expect(await readJson(file)).toEqual(spool);
    await expect(releaseQaResource(saved)).rejects.toThrow('executor stop proof');
    const blocked=await f.parent(f.state(),policy,'lock');expect(await blocked.closed).toBe(1);
    await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
    await f.stopParent(old.entry);expect(await recovery(f.directory)).toBe(1);
    await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
    const next=await f.parent(f.state(),policy,'lock');await f.until(async()=>next.output.includes('owned'));next.child.stdin!.write('release');expect(await next.closed).toBe(0);
  },qaFixtureBudget(40_000)),40_000);
  it.each(['revoked','changed-resource'])('blocks real repository GO after %s without losing stop/ownership proof',async mode=>qaProcessFixture(async f=>{
    const execution=f.state(),policy=resource(),marker=path.join(f.directory,'must-not-go');
    await acquireQaResource(execution,policy);await claimQaResource(execution);
    const ownerFile=path.join(execution.resourceLock!.directory,'owner.json'),owner=await readJson(ownerFile);
    try{
      const result=f.track(runQaCommand(execution,process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'bad')",marker],f.directory,qaChildEnvironment(),10_000,()=>writeSecureJson(path.join(f.directory,'state.json'),execution),f.abort.signal,async()=>{
        if(mode==='revoked')throw Error('revoked lease/policy');
        await writeSecureJson(ownerFile,{...(owner as object),owner:'forged replacement'});
      }));
      await expect(result).rejects.toThrow(mode==='revoked'?'revoked':'no GO');
      await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});expect(await stopQaExecution(execution)).toBe(true);
    }finally{await writeSecureJson(ownerFile,owner);} // Restore only this fixture's deliberate nonce corruption.
  },qaFixtureBudget(30_000)),30_000);
  for(const mode of ['readiness','assertion','timeout'])it(`finally stops every owned parent/group/descendant and frees only its lock after injected ${mode} failure`,async()=>{
    // Cleanup/next-owner proofs are not minimum-budget tests: reserve 4s for setup.
    const budget=qaFixtureBudget(40_000,2),policy=resource();let parentPid=0,group=0,observed:number[]=[];
    const failed=qaProcessFixture(async f=>{
      const marker=path.join(f.directory,'started.json'),owner=await f.parent(f.state(),policy,undefined,['-e',descendantScript,marker]);parentPid=owner.child.pid!;
      await f.until(async()=>{try{await readFile(marker);return true;}catch{return false;}});
      const ids=JSON.parse(await readFile(marker,'utf8')) as {pid:number;descendant:number};observed=[ids.pid,ids.descendant];await f.observe(observed);
      group=(await readJson<QaExecution>(owner.stateFile))!.identity!.processGroupId;
      if(mode==='readiness')await f.until(async()=>false,50);
      if(mode==='assertion')expect('injected failure').toBe('expected');
      if(mode==='timeout')await new Promise<void>(()=>{});
    },budget);
    await expect(failed).rejects.toThrow(mode==='readiness'?'did not become ready':mode==='assertion'?'expected':'deadline');
    expect(await waitProcessGroup(group,100)).toBe(true);for(const pid of [parentPid,...observed])expect(()=>process.kill(pid,0)).toThrow();
    await qaProcessFixture(async f=>{const next=await f.parent(f.state(),policy,'lock');await f.until(async()=>next.output.includes('owned'));next.child.stdin!.write('release');expect(await next.closed).toBe(0);},budget);
  },40_000);
});
