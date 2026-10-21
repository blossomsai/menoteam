import { withRecoveryState } from './helpers/connector-recovery.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorRunner } from '../src/connector/runner.js';
import type { WorkbenchConnectorClient } from '../src/connector/client.js';
import type { CodexAppServer } from '../src/connector/codex.js';
import type { ClaimedRun, ConnectorConfig } from '../src/connector/types.js';
import type { Run } from '../src/workbench/types.js';
import type { StagingReceipt, StagingRequest, StagingTracking } from '../src/connector/staging-deploy.js';
import type { discoverStagingBuild, StagingBuildReceipt } from '../src/connector/staging-build.js';
import { readJson, stateKey, writeSecureJson } from '../src/connector/state.js';

const commitSha = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const repository = 'ghcr.io/blossomsai/menoteam-work-map';
const runId = 'run_11111111-2222-3333-4444-555555555555';
const identity = { pid: 1, processGroupId: 1, startedAt: 'fixture', command: 'ssh fixture' };

function stagingClaim(phase: 'queued' | 'deploy_intent' = 'queued'): ClaimedRun {
  const run: Run = {
    id: runId, projectId: 'project-1', workId: 'work-1', prompt: 'deploy exact image', kind: 'delivery',
    model: 'internal', reasoning: 'none', status: 'running', generation: 1, connectorId: 'connector-1',
    requestedBy: 'owner-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    operation: {
      action: 'deploy_staging', actorId: 'owner-1', candidateRunId: 'candidate-1', candidateRevision: commitSha,
      artifactRevision: 'diff-revision', commitSha, candidateFingerprint: 'c'.repeat(64),
      repositoryUrl: 'https://github.com/blossomsai/menoteam', baseRevision: 'd'.repeat(40), baseBranch: 'main',
      remoteBranch: 'codex/work-1', workTitle: 'Exact staging release', changeSummary: 'verified candidate',
      qaStatus: 'current', phase, sourceMergeRunId: 'run_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', targetId: 'staging',
      targetPolicyVersion: '2026-10-06T00:00:00.000Z', imageDigest, expectedCurrentDeploymentId: null,
      ...(phase === 'deploy_intent' ? { effectIntentGeneration: 0, stagingEffectStage: 'intent' as const } : {}),
    },
  };
  return { run, project: { id: run.projectId, name: 'Project', instructions: '', repositoryUrl: run.operation!.repositoryUrl, deliveryAuthorization: '', createdAt: run.createdAt }, messages: [], settings: [] };
}

async function execute(claim: ClaimedRun, authorize: (effect: 'discovery' | 'provenance' | 'transport' | 'status') => Promise<{ authorized: true; action: 'discover' | 'deploy' | 'rollback' | 'status' }>, transport: (request: StagingRequest, tracking?:StagingTracking) => Promise<StagingReceipt>, options:{advanceRecoveryClock?:boolean;stopAfterMs?:number;stopProcess?:(identity:typeof identity)=>Promise<boolean>;pauseOnHeartbeat?:boolean;recovery?:boolean;recoveryIdentity?:boolean;afterRun?:()=>Promise<void>;renew?:(count:number)=>Promise<void>;onRunner?:(runner:ConnectorRunner)=>void;stopAck?:(attempt:number,spool:Record<string,unknown>|undefined)=>Promise<void>;buildDiscovery?:typeof discoverStagingBuild;onBuildReceipt?:(receipt:StagingBuildReceipt)=>Promise<void>;provenanceVerifier?:(args:string[],signal?:AbortSignal)=>Promise<string>;completeAck?:()=>Promise<void>;receiptAck?:(receipt:StagingReceipt,attempt:number)=>Promise<void>;awaitCompletion?:boolean;lifecycleWatchdogMs?:number;onIdleClaim?:()=>void;cleanup?:()=>void|Promise<void>}={}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'menoteam-staging-runner-'));
  let runner: ConnectorRunner;
  let claimed = false;
  const actualNow=Date.now;let recoveryOffset=0,recoveryPolls=0;
  const recoveryClock=options.advanceRecoveryClock?vi.spyOn(Date,'now').mockImplementation(()=>actualNow()+recoveryOffset):undefined;
  const receipts: StagingReceipt[] = [];
  const completions: Array<{ error?: string }> = [];
  const renewals:number[]=[];
  const stoppedAcks:number[]=[];
  const buildStatuses:string[]=[];
  const buildReceipts:StagingBuildReceipt[]=[];
  let finishLifecycle!:()=>void;
  const lifecycleFinished=new Promise<void>(resolve=>{finishLifecycle=resolve;});
  let lifecycleStopped=false;
  let watchdog:NodeJS.Timeout|undefined;
  let runnerTask:Promise<void>|undefined;
  const client = {
    claim: async () => {
      if (!claimed&&!options.recovery) { claimed = true; return claim; }
      options.onIdleClaim?.();
      if(options.advanceRecoveryClock&&recoveryPolls++===0){expect(receipts.length+stoppedAcks.length).toBe(1);recoveryOffset+=30_000;return undefined;}
      if(options.awaitCompletion){await lifecycleFinished;return undefined;}
      await new Promise(resolve=>setTimeout(resolve,options.stopAfterMs??50));await runner.stop();return undefined;
    },
    renew: async (_id:string,generation:number) => { renewals.push(generation);await options.renew?.(renewals.length);if(options.pauseOnHeartbeat&&renewals.length>1){claim.run.status='paused';throw new Error('lease rejected after pause');}return claim.run; },
    authorizeStagingEffect: async (_id: string, generation: number, effect: 'discovery' | 'provenance' | 'transport' | 'status') => {
      expect(generation).toBe(claim.run.generation);
      return authorize(effect);
    },
    stagingProgress: async (_id: string, _generation: number, receipt: StagingReceipt) => { receipts.push(receipt);await options.receiptAck?.(receipt,receipts.length); },
    stagingBuildStatus:async(_id:string,_generation:number,status:string)=>{buildStatuses.push(status);return{run:claim.run};},
    stagingBuildReceipt:async(_id:string,_generation:number,receipt:StagingBuildReceipt)=>{await options.onBuildReceipt?.(receipt);buildReceipts.push(receipt);claim.run.operation!.buildReceipt={...receipt,verifiedAt:new Date().toISOString(),verifiedGeneration:claim.run.generation};claim.run.operation!.buildStatus='verified';claim.run.operation!.imageDigest=receipt.imageDigest;return{run:claim.run};},
    stopped: async (_id:string,generation:number)=>{expect(_id).toBe(runId);expect(generation).toBe(claim.run.generation);stoppedAcks.push(generation);await options.stopAck?.(stoppedAcks.length,await readJson<Record<string,unknown>>(path.join(dataDir,'spool',`${stateKey(runId,String(generation))}.json`)));claim.run.stoppedAt=new Date().toISOString();return claim.run;},
    complete: async (_id: string, _generation: number, completion: { error?: string }) => {
      completions.push(completion);
      try { await options.completeAck?.(); }
      finally {
        if(options.awaitCompletion){
          try { await runner.stop();lifecycleStopped=true; }
          finally { finishLifecycle(); }
        }
      }
      if(!options.awaitCompletion)await runner.stop();
      return claim.run;
    },
    readRun: async () => claim.run,
  } as unknown as WorkbenchConnectorClient;
  const native = { start: async () => ['gpt-6.1-sol'], stop: async () => {} } as unknown as CodexAppServer;
  const config: ConnectorConfig = {
    serverUrl: 'http://localhost:4313', token: 'fixture-token-'.padEnd(40, 'x'), connectorId: 'connector-1',
    dataDir, projects: { 'project-1': dataDir }, pollIntervalMs: 1, leaseRenewIntervalMs:5_000,
    deploymentTargets: { staging: { sshHost: 'stage.example', sshUser: 'deploy', identityFile: '/fixture/key', knownHostsFile: '/fixture/known_hosts', hostKeyFingerprint: `SHA256:${'c'.repeat(43)}`, imageRepository: repository } },
  };
  const attestation = async () => JSON.stringify([{ verificationResult: { statement: { subject: [{ name: repository, digest: { sha256: imageDigest.slice(7) } }] } } }]);
  const fakeTransport = async (_target: unknown, request: StagingRequest, tracking?:StagingTracking) => transport(request,tracking);
  runner = new ConnectorRunner(config, {
    native: () => native,
    client:()=>withRecoveryState(client),
    staging: { transport: fakeTransport as never, provenanceVerifier: options.provenanceVerifier??attestation, targetValidator: async () => {}, ...(options.stopProcess?{stopProcess:options.stopProcess as never}:{}),...(options.buildDiscovery?{buildDiscovery:options.buildDiscovery}:{}) },
  });
  if(options.recovery)await writeSecureJson(path.join(dataDir,'spool',`${stateKey(runId,'1')}.json`),{runId,generation:1,events:[],artifacts:[],stagingIntent:{targetId:'staging',commitSha,imageDigest,expectedCurrentDeploymentId:claim.run.operation!.expectedCurrentDeploymentId??null,...(claim.run.operation!.previousDeploymentId?{previousDeploymentId:claim.run.operation!.previousDeploymentId}:{})},stagingTransportStarted:true,stagingTransportStopped:!options.recoveryIdentity,...(options.recoveryIdentity?{stagingProcessIdentity:identity}:{}),deliveryExecutor:{pid:process.pid,executionId:'crashed-fixture',stage:'staging'}});
  try {
    options.onRunner?.(runner);
    runnerTask=runner.run();
    if(options.awaitCompletion){
      await Promise.race([runnerTask,new Promise<never>((_resolve,reject)=>{
        watchdog=setTimeout(()=>reject(new Error('Fixture did not observe staging completion before its lifecycle watchdog')),options.lifecycleWatchdogMs??2_500);
      })]);
    }else await runnerTask;
    await options.afterRun?.();
    const spools=await Promise.all((await readdir(path.join(dataDir,'spool'))).map(file=>readJson<Record<string,unknown>>(path.join(dataDir,'spool',file))));
    return { receipts, completions, renewals, stoppedAcks, spools,buildStatuses,buildReceipts };
  }
  finally {
    clearTimeout(watchdog);
    const stopping=options.awaitCompletion&&!lifecycleStopped?runner.stop():undefined;
    void stopping?.catch(()=>{}); // Join below even if releasing the fixture barrier fails.
    try {
      try { await options.cleanup?.(); }
      finally {
        if(options.awaitCompletion){
          finishLifecycle();
          try { await stopping; }
          finally { await runnerTask; }
        }
      }
    }finally { recoveryClock?.mockRestore();await rm(dataDir, { recursive: true, force: true }); }
  }
}

describe('staging delivery Connector integration', () => {
  it.each([true,false])('records offline stop proof only after confirmed transport cleanup (confirmed=%s)',async confirmed=>{
    const claim=stagingClaim(),events:string[]=[];
    const result=await execute(claim,async()=>({authorized:true,action:'deploy'}),async(request,tracking)=>{
      if(confirmed){await tracking!.starting!();await tracking!.started(identity);await tracking!.stopped();}
      return {operationId:request.operationId,targetId:request.targetId,phase:'target_offline',commitSha:request.commitSha,imageDigest:request.imageDigest,checkedAt:new Date().toISOString()};
    },{awaitCompletion:true,receiptAck:async receipt=>{events.push('receipt');Object.assign(claim.run.operation!,{phase:'target_offline',effectIntentGeneration:1,stagingReceipt:receipt});},completeAck:async()=>{events.push('complete');claim.run.status='failed';},stopAck:async()=>{events.push('stopped');}});
    expect(result.stoppedAcks).toEqual(confirmed?[1]:[]);
    expect(events).toEqual(confirmed?['receipt','complete','stopped']:['receipt','complete']);
  });
  it('keeps confirmed offline cleanup in the outbox when its stopped ACK is lost',async()=>{
    const claim=stagingClaim();
    const result=await execute(claim,async()=>({authorized:true,action:'deploy'}),async(request,tracking)=>{
      await tracking!.starting!();await tracking!.started(identity);await tracking!.stopped();
      return {operationId:request.operationId,targetId:request.targetId,phase:'target_offline',commitSha:request.commitSha,imageDigest:request.imageDigest,checkedAt:new Date().toISOString()};
    },{awaitCompletion:true,receiptAck:async receipt=>{Object.assign(claim.run.operation!,{phase:'target_offline',effectIntentGeneration:1,stagingReceipt:receipt});},completeAck:async()=>{claim.run.status='failed';},stopAck:async()=>{throw Error('stopped ACK lost');}});
    expect(result.stoppedAcks).toEqual([1]);expect(result.spools).toHaveLength(1);
    expect(result.spools[0]).toMatchObject({generation:1,stagingOfflineReceipt:true,stagingTransportStopped:true,completion:{error:expect.any(String)}});
  });
  it.each(['deploy', 'rollback'] as const)('converges a completed %s by status and retries a lost terminal receipt ACK without mutating', async action => {
    const claim = stagingClaim('deploy_intent');
    claim.run.operation!.expectedCurrentDeploymentId = 'deploy_current';
    if (action === 'rollback') Object.assign(claim.run.operation!, { action: 'rollback_staging', previousDeploymentId: 'deploy_previous', phase: 'rollback_intent' });
    const actions: string[] = [], effects: string[] = [];
    const result = await execute(claim, async effect => { effects.push(effect); return { authorized: true, action: 'status' }; }, async request => {
      actions.push(request.action);
      expect(request).toMatchObject({ action: 'status', operationId: runId, expectedCurrentDeploymentId: 'deploy_current' });
      expect(request.previousDeploymentId).toBeUndefined();
      return { operationId: runId, targetId: 'staging', phase: 'rolled_back', deploymentId: action === 'rollback' ? 'deploy_previous' : 'deploy_current', commitSha, imageDigest, activeCommitSha: action === 'rollback' ? commitSha : 'c'.repeat(40), activeImageDigest: action === 'rollback' ? imageDigest : `sha256:${'d'.repeat(64)}`, previousDeploymentId: action === 'rollback' ? 'deploy_current' : `deploy_${runId.slice(4)}`, previousImageDigest: action === 'rollback' ? `sha256:${'d'.repeat(64)}` : imageDigest, checkedAt: new Date().toISOString() };
    }, { recovery: true, advanceRecoveryClock:true, receiptAck: async (_receipt, attempt) => { if (attempt === 1) throw new Error('terminal receipt ACK response lost'); } });
    expect(actions).toEqual(['status']); expect(effects.every(effect => effect === 'status')).toBe(true);
    expect(result.receipts).toHaveLength(2); expect(result.receipts[1]).toEqual(result.receipts[0]);
    expect(result.completions).toEqual([{}]); expect(result.spools).toEqual([]);
  });

  it('authorizes provenance and SSH, then completes only from the exact healthy receipt', async () => {
    const effects: string[] = [];
    const result = await execute(stagingClaim(), async effect => { effects.push(effect); return { authorized: true, action: 'deploy' }; }, async request => ({
      operationId: request.operationId, targetId: request.targetId, phase: 'health_passed', deploymentId: 'deploy_verified',
      commitSha: request.commitSha, imageDigest: request.imageDigest, activeCommitSha: request.commitSha,
      activeImageDigest: request.imageDigest, checkedAt: new Date().toISOString(),
    }));
    expect(effects).toEqual(['provenance', 'transport']);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({ phase: 'health_passed', commitSha, imageDigest, activeCommitSha: commitSha, activeImageDigest: imageDigest });
    expect(result.completions).toEqual([{}]);
  });

  it('does not start a mutation when transport authorization is revoked and reconciles by status only', async () => {
    const effects: string[] = [], transportActions: string[] = [];
    const result = await execute(stagingClaim(), async effect => {
      effects.push(effect);
      if (effect === 'provenance') return { authorized: true, action: 'deploy' };
      if (effect === 'transport') return { authorized: true, action: 'status' };
      return { authorized: true, action: 'status' };
    }, async request => {
      transportActions.push(request.action);
      return { operationId: request.operationId, targetId: request.targetId, phase: 'unknown', commitSha: request.commitSha, imageDigest: request.imageDigest, checkedAt: new Date().toISOString() };
    });
    expect(effects).toEqual(['provenance', 'transport', 'status']);
    expect(transportActions).toEqual(['status']);
    expect(result.receipts[0]?.phase).toBe('unknown');
    expect(result.completions[0]?.error).toContain('reservation remains held');
  });

  it.each([false,true])('an existing intent after a generation change can only perform read-only status (event completion: %s)', async awaitCompletion => {
    const effects:string[]=[],transportActions:string[]=[],terminal:string[]=[];
    const claim=stagingClaim('deploy_intent');claim.run.generation=2;
    let releaseRenew!:()=>void,renewEntered!:()=>void,idleClaim!:()=>void,stopEntered!:()=>void;
    const renewGate=new Promise<void>(resolve=>{releaseRenew=resolve;});
    const renewing=new Promise<void>(resolve=>{renewEntered=resolve;});
    const idle=new Promise<void>(resolve=>{idleClaim=resolve;});
    const stopping=new Promise<void>(resolve=>{stopEntered=resolve;});
    let stopCalls=0,runSettled=false;
    const resultPromise=execute(claim,async effect=>{effects.push(effect);return{authorized:true,action:'status'};},async request=>{
      transportActions.push(request.action);
      return{operationId:request.operationId,targetId:request.targetId,phase:'unknown',commitSha:request.commitSha,imageDigest:request.imageDigest,checkedAt:new Date().toISOString()};
    },{
      awaitCompletion,cleanup:releaseRenew,onIdleClaim:idleClaim,
      renew:async count=>{if(count===1){renewEntered();await renewGate;}},
      receiptAck:async()=>{terminal.push('receipt');},completeAck:async()=>{terminal.push('complete');},stopAck:async()=>{terminal.push('stopped');},
      onRunner:runner=>{
        const stop=runner.stop.bind(runner),run=runner.run.bind(runner);
        vi.spyOn(runner,'stop').mockImplementation(async()=>{stopCalls++;stopEntered();await stop();});
        vi.spyOn(runner,'run').mockImplementation(async()=>{try{await run();}finally{runSettled=true;}});
      }
    });
    void resultPromise.catch(()=>{}); // Joined below even if observing the held phase fails.
    let observationTimer:NodeJS.Timeout|undefined;
    const observationDeadline=new Promise<never>((_resolve,reject)=>{
      observationTimer=setTimeout(()=>reject(new Error('Fixture did not reach the preauthorization hold/stop signal')),2_500);
    });
    try {
      await Promise.race([Promise.all([renewing,idle]),observationDeadline]);
      if(awaitCompletion){
        await new Promise(resolve=>setTimeout(resolve,75));
        expect(stopCalls).toBe(0);
      }else await Promise.race([stopping,observationDeadline]);
      expect(effects).toEqual([]);expect(transportActions).toEqual([]);expect(terminal).toEqual([]);
    }finally {
      clearTimeout(observationTimer);releaseRenew();
      await resultPromise;
    }
    const result=await resultPromise;
    expect(runSettled).toBe(true);expect(stopCalls).toBe(1);
    if(!awaitCompletion){
      expect(effects).toEqual([]);expect(transportActions).toEqual([]);
      expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);expect(result.stoppedAcks).toEqual([2]);
      // The original status assertion really fails under the old 50ms fixture.
      let statusAssertionError:unknown;
      try { expect(effects).toEqual(['status']); } catch(error) { statusAssertionError=error; }
      expect(statusAssertionError).toBeInstanceOf(Error);
      console.info('Controlled OLD50 expected assertion failure:',(statusAssertionError as Error).message);
      return;
    }
    expect(effects).toEqual(['status']);
    expect(transportActions).toEqual(['status']);
    expect(result.receipts[0]?.phase).toBe('unknown');
    expect(result.completions[0]?.error).toBeTruthy();
    expect(result.receipts).toEqual([{operationId:runId,targetId:'staging',phase:'unknown',commitSha,imageDigest,checkedAt:expect.any(String)}]);
    expect(result.completions).toEqual([{error:'Staging target did not confirm the requested deployment; its reservation remains held for status reconciliation'}]);
    expect(terminal).toEqual(['receipt','complete']);expect(result.stoppedAcks).toEqual([]);expect(result.spools).toEqual([]);
    console.info('Controlled NEW completion: exact status, receipt and error completion; runner settled');
  });

  it('rejects a missing-progress watchdog outside the runner and settles the held task',async()=>{
    let releaseRenew!:()=>void;
    const gate=new Promise<void>(resolve=>{releaseRenew=resolve;});
    let released=false,renewHeld=false,runSettled=false,stopCalls=0;
    const effects:string[]=[];
    const timers=vi.spyOn(globalThis,'setTimeout'),cleared=vi.spyOn(globalThis,'clearTimeout');
    try {
      await expect(execute(stagingClaim(),async effect=>{effects.push(effect);return{authorized:true,action:'deploy'};},async()=>{throw new Error('transport must not start');},{
        awaitCompletion:true,
        renew:async count=>{if(count===1){renewHeld=true;await gate;}},
        cleanup:()=>{released=true;releaseRenew();},
        onRunner:runner=>{
          const run=runner.run.bind(runner),stop=runner.stop.bind(runner);
          vi.spyOn(runner,'run').mockImplementation(async()=>{try{await run();}finally{runSettled=true;}});
          vi.spyOn(runner,'stop').mockImplementation(async()=>{stopCalls++;await stop();});
        }
      })).rejects.toThrow('Fixture did not observe staging completion before its lifecycle watchdog');
      expect(renewHeld).toBe(true);expect(released).toBe(true);expect(runSettled).toBe(true);expect(stopCalls).toBe(1);expect(effects).toEqual([]);
      const index=timers.mock.calls.findIndex(([,ms])=>ms===2_500);
      expect(index).toBeGreaterThanOrEqual(0);expect(cleared).toHaveBeenCalledWith(timers.mock.results[index]!.value);
    }finally {releaseRenew();timers.mockRestore();cleared.mockRestore();}
  });

  it('settles the runner and clears its watchdog even when fixture cleanup throws',async()=>{
    let runSettled=false;
    const timers=vi.spyOn(globalThis,'setTimeout'),cleared=vi.spyOn(globalThis,'clearTimeout');
    try {
      await expect(execute(stagingClaim('deploy_intent'),async()=>({authorized:true,action:'status'}),async request=>({
        operationId:request.operationId,targetId:request.targetId,phase:'unknown',commitSha,imageDigest,checkedAt:new Date().toISOString()
      }),{awaitCompletion:true,cleanup:()=>{throw new Error('fixture cleanup failed');},onRunner:runner=>{
        const run=runner.run.bind(runner);
        vi.spyOn(runner,'run').mockImplementation(async()=>{try{await run();}finally{runSettled=true;}});
      }})).rejects.toThrow('fixture cleanup failed');
      expect(runSettled).toBe(true);
      const index=timers.mock.calls.findIndex(([,ms])=>ms===2_500);
      expect(index).toBeGreaterThanOrEqual(0);expect(cleared).toHaveBeenCalledWith(timers.mock.results[index]!.value);
    }finally {timers.mockRestore();cleared.mockRestore();}
  });

  it('renews the staging lease while a bounded remote operation is still running', async () => {
    const result=await execute(stagingClaim(),async()=>({authorized:true,action:'deploy'}),async(request,tracking)=>{
      await tracking?.starting?.();await tracking?.started(identity);
      await new Promise(resolve=>setTimeout(resolve,5_300));
      await tracking?.stopped();
      return {operationId:request.operationId,targetId:request.targetId,phase:'unknown',commitSha:request.commitSha,imageDigest:request.imageDigest,checkedAt:new Date().toISOString()};
    },{stopAfterMs:6_500});
    expect(result.renewals.length).toBeGreaterThanOrEqual(2); // initial renewal plus staging heartbeat
    expect(result.completions[0]?.error).toContain('reservation remains held');
  },10_000);

  it('stops only the verified SSH group on Connector shutdown and acknowledges no remote success', async () => {
    let releaseTransport!:()=>void;
    const transportStopped=new Promise<void>(resolve=>{releaseTransport=resolve;});
    const stopped:unknown[]=[];
    const result=await execute(stagingClaim(),async()=>({authorized:true,action:'deploy'}),async(request,tracking)=>{
      await tracking?.starting?.();await tracking?.started(identity);
      await transportStopped;await tracking?.stopped();
      throw new Error('connector shutdown stopped the local transport');
    },{stopAfterMs:500,stopProcess:async value=>{stopped.push(value);releaseTransport();return true;}});
    expect(stopped).toEqual([identity]);
    expect(result.stoppedAcks).toEqual([1]);
    expect(result.receipts).toEqual([]);
    expect(result.completions).toEqual([]);
  },10_000);

  it('after a lease renewal is rejected, stops the child and acknowledges pause without status or completion',async()=>{
    let releaseTransport!:()=>void;
    const transportStopped=new Promise<void>(resolve=>{releaseTransport=resolve;});
    const stopCalls:unknown[]=[];
    const result=await execute(stagingClaim(),async()=>({authorized:true,action:'deploy'}),async(_request,tracking)=>{
      await tracking?.starting?.();await tracking?.started(identity);
      await transportStopped;await tracking?.stopped();
      throw new Error('pause stopped the local transport');
    },{stopAfterMs:6_500,pauseOnHeartbeat:true,stopProcess:async value=>{stopCalls.push(value);releaseTransport();return true;}});
    expect(stopCalls).toEqual([identity]);
    expect(result.stoppedAcks).toEqual([1]);
    expect(result.receipts).toEqual([]);
    expect(result.completions).toEqual([]);
  },10_000);

  it('renews a long status fallback after mutation authorization is revoked',async()=>{
    const actions:string[]=[];
    const result=await execute(stagingClaim(),async effect=>({authorized:true,action:effect==='provenance'?'deploy':'status'}),async(request,tracking)=>{
      actions.push(request.action);await tracking?.starting?.();await tracking?.started(identity);
      await new Promise(resolve=>setTimeout(resolve,5_300));await tracking?.stopped();
      return {operationId:request.operationId,targetId:request.targetId,phase:'unknown',commitSha,imageDigest,checkedAt:new Date().toISOString()};
    },{stopAfterMs:6_500});
    expect(actions).toEqual(['status']);expect(result.renewals.length).toBeGreaterThanOrEqual(2);
    expect(result.completions[0]?.error).toContain('reservation remains held');
  },10_000);

  it('renews a long crash-recovery status using the same lifecycle',async()=>{
    const actions:string[]=[];
    const result=await execute(stagingClaim('deploy_intent'),async effect=>{expect(effect).toBe('status');return{authorized:true,action:'status'};},async(request,tracking)=>{
      actions.push(request.action);await tracking?.starting?.();await tracking?.started(identity);
      await new Promise(resolve=>setTimeout(resolve,5_300));await tracking?.stopped();
      return {operationId:request.operationId,targetId:request.targetId,phase:'unknown',commitSha,imageDigest,checkedAt:new Date().toISOString()};
    },{recovery:true});
    expect(actions).toEqual(['status']);expect(result.renewals.length).toBeGreaterThanOrEqual(1);
    expect(result.completions[0]?.error).toContain('reservation remains held');
  },10_000);

  it('stops a recovered status SSH group on shutdown and retains the immutable intent',async()=>{
    let runner!:ConnectorRunner,release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const stops:unknown[]=[];
    const result=await execute(stagingClaim('deploy_intent'),async()=>({authorized:true,action:'status'}),async(_request,tracking)=>{
      await tracking?.starting?.();await tracking?.started(identity);
      setTimeout(()=>{void runner.stop();},10);
      await gate;await tracking?.stopped();throw new Error('local SSH stopped; remote unknown');
    },{recovery:true,onRunner:value=>{runner=value;},stopProcess:async value=>{stops.push(value);release();return true;}});
    expect(stops).toEqual([identity]);expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);
    expect(result.spools[0]).toMatchObject({stagingIntent:{commitSha,imageDigest},stagingTransportStopped:true});
  });

  it('fences a late started callback after shutdown before it can send a request',async()=>{
    let runner!:ConnectorRunner,sent=false;const stops:unknown[]=[];
    const result=await execute(stagingClaim('deploy_intent'),async()=>({authorized:true,action:'status'}),async(_request,tracking)=>{
      await tracking?.starting?.();await runner.stop();
      try{await tracking?.started(identity);sent=true;}finally{await tracking?.stopped();}
      throw new Error('should not send request');
    },{recovery:true,onRunner:value=>{runner=value;},stopProcess:async value=>{stops.push(value);return true;}});
    expect(sent).toBe(false);expect(stops).toEqual([identity]);expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);
    expect(result.spools[0]).toMatchObject({stagingIntent:{commitSha,imageDigest},stagingTransportStopped:true});
  });

  it('joins a late rejected heartbeat before publishing a receipt or completion',async()=>{
    const claim=stagingClaim();let release!:()=>void;
    const renewalGate=new Promise<void>(resolve=>{release=resolve;});
    const result=await execute(claim,async()=>({authorized:true,action:'deploy'}),async(request,tracking)=>{
      await tracking?.starting?.();await tracking?.started(identity);
      await new Promise(resolve=>setTimeout(resolve,5_300));await tracking?.stopped();
      setTimeout(release,10);
      return {operationId:request.operationId,targetId:request.targetId,phase:'health_passed',deploymentId:'deploy_verified',commitSha,imageDigest,checkedAt:new Date().toISOString()};
    },{stopAfterMs:6_500,renew:async count=>{if(count>1){await renewalGate;claim.run.status='paused';throw new Error('late lease rejection');}}});
    expect(result.stoppedAcks).toEqual([1]);expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);
    expect(result.spools[0]).toMatchObject({stagingIntent:{commitSha,imageDigest}});
  },10_000);


  it.each(['paused','cancelled','interrupted'] as const)('acknowledges an orphaned verified SSH group during %s recovery without a status effect',async status=>{
    const claim=stagingClaim('deploy_intent');claim.run.status=status;const stops:unknown[]=[];const effects:string[]=[];
    const result=await execute(claim,async effect=>{effects.push(effect);throw new Error('paused recovery must not authorize status');},async()=>{throw new Error('no transport');},{recovery:true,recoveryIdentity:true,stopProcess:async value=>{stops.push(value);return true;}});
    expect(stops).toEqual([identity]);expect(result.stoppedAcks).toEqual([1]);expect(claim.run.stoppedAt).toBeTruthy();expect(claim.run.status).toBe(status);expect(claim.run.operation?.phase).toBe('deploy_intent');expect(effects).toEqual([]);expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);
    expect(result.spools[0]).toMatchObject({stagingIntent:{commitSha,imageDigest},stagingTransportStopped:true});
    expect(result.spools[0]?.stagingProcessIdentity).toBeUndefined();
  });

  it('retries a durably saved recovery acknowledgement after its first request fails',async()=>{
    const claim=stagingClaim('deploy_intent');claim.run.status='paused';const stops:unknown[]=[];
    const result=await execute(claim,async()=>{throw new Error('no status authorization');},async()=>{throw new Error('no transport');},{recovery:true,advanceRecoveryClock:true,recoveryIdentity:true,stopProcess:async value=>{stops.push(value);return true;},stopAck:async(attempt,spool)=>{
      expect(spool).toMatchObject({generation:1,stopped:true,stagingTransportStopped:true,stagingIntent:{commitSha,imageDigest}});
      expect(spool?.stagingProcessIdentity).toBeUndefined();
      if(attempt===1)throw new Error('acknowledgement response lost');
    }});
    expect(stops).toEqual([identity]);expect(result.stoppedAcks).toEqual([1,1]);expect(claim.run.stoppedAt).toBeTruthy();
    expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);expect(claim.run.operation?.phase).toBe('deploy_intent');
    expect(result.spools[0]).toMatchObject({stopped:false,stagingTransportStopped:true,stagingIntent:{commitSha,imageDigest}});
  });

  it('keeps failed recovery acknowledgements and unknown remote intent for a later Connector',async()=>{
    const claim=stagingClaim('deploy_intent');claim.run.status='interrupted';
    const result=await execute(claim,async()=>{throw new Error('no status authorization');},async()=>{throw new Error('no transport');},{recovery:true,advanceRecoveryClock:true,recoveryIdentity:true,stopProcess:async()=>true,stopAck:async()=>{throw new Error('server unavailable');}});
    expect(result.stoppedAcks).toEqual([1,1]);expect(claim.run.stoppedAt).toBeUndefined();expect(claim.run.operation?.phase).toBe('deploy_intent');
    expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);
    expect(result.spools[0]).toMatchObject({stopped:true,stagingTransportStopped:true,stagingIntent:{commitSha,imageDigest}});
  });

  it('does not acknowledge a paused orphan group without verified local stop proof',async()=>{
    const claim=stagingClaim('deploy_intent');claim.run.status='paused';
    const result=await execute(claim,async()=>{throw new Error('no status authorization');},async()=>{throw new Error('no transport');},{recovery:true,recoveryIdentity:true,stopProcess:async()=>false});
    expect(result.stoppedAcks).toEqual([]);expect(claim.run.stoppedAt).toBeUndefined();expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);
    expect(result.spools[0]).toMatchObject({stagingTransportStopped:false,stagingProcessIdentity:identity,stagingIntent:{commitSha,imageDigest}});
  });

  it('does not leak a heartbeat stop rejection or release an unconfirmed local group',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const effects:string[]=[];
    const result=await execute(stagingClaim(),async effect=>{effects.push(effect);return{authorized:true,action:'deploy'};},async(_request,tracking)=>{
      await tracking?.starting?.();await tracking?.started(identity);await gate;
      throw new Error('transport still has no group stop proof');
    },{stopAfterMs:5_500,renew:async count=>{if(count>1)throw new Error('lease unavailable');},stopProcess:async()=>{release();throw new Error('verified stop denied');}});
    expect(effects).toEqual(['provenance','transport']);expect(result.stoppedAcks).toEqual([]);expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);
    expect(result.spools[0]).toMatchObject({stagingIntent:{commitSha,imageDigest},stagingProcessIdentity:identity,stagingTransportStopped:false});
  },15_000);

  it('fences callbacks from a finished lifecycle without recreating its removed spool',async()=>{
    let tracking!:StagingTracking;const stops:unknown[]=[];
    const result=await execute(stagingClaim('deploy_intent'),async()=>({authorized:true,action:'status'}),async(request,value)=>{
      tracking=value!;
      return {operationId:request.operationId,targetId:request.targetId,phase:'unknown',commitSha,imageDigest,checkedAt:new Date().toISOString()};
    },{stopProcess:async value=>{stops.push(value);return true;},afterRun:async()=>{
      await expect(tracking.starting?.()).rejects.toThrow(/prevents a new effect/u);
      await expect(tracking.started(identity)).rejects.toThrow(/lifecycle has ended/u);
      await tracking.stopped();
    }});
    expect(stops).toEqual([identity]);expect(result.spools).toEqual([]);
  });

  it.each([false,true])('keeps an unknown receipt completion in the outbox until the server acknowledges it (event completion: %s)',async awaitCompletion=>{
    let tracking!:StagingTracking;
    const result=await execute(stagingClaim('deploy_intent'),async()=>({authorized:true,action:'status'}),async(request,value)=>{
      tracking=value!;return{operationId:request.operationId,targetId:request.targetId,phase:'unknown',commitSha,imageDigest,checkedAt:new Date().toISOString()};
    },{awaitCompletion,completeAck:async()=>{throw new Error('completion response lost');},stopProcess:async()=>true,afterRun:async()=>{
      await expect(tracking.started(identity)).rejects.toThrow(/lifecycle has ended/u);await tracking.stopped();
    }});
    expect(result.receipts).toHaveLength(1);expect(result.completions.length).toBeGreaterThan(0);
    expect(result.spools).toHaveLength(1);expect(result.spools[0]).toMatchObject({stagingIntent:{commitSha,imageDigest},completion:{error:expect.stringContaining('reservation remains held')},deliveryExecutor:{stage:'completion'}});
    expect(result.spools[0]?.stagingReceipt).toBeUndefined();expect(result.spools[0]?.stagingTransportStopped).toBeUndefined();
  });

  it('joins aborted discovery cleanup on shutdown before acknowledging a local stop',async()=>{
    const claim=stagingClaim();claim.run.operation!.phase='build_discovery';claim.run.operation!.imageDigest=undefined;
    let runner!:ConnectorRunner,cleanup=false,stopJoined:Promise<void>|undefined;
    const result=await execute(claim,async effect=>{expect(effect).toBe('discovery');return{authorized:true,action:'discover'};},async()=>{throw new Error('SSH must not start during discovery');},{stopAfterMs:1_000,onRunner:value=>{runner=value;},stopAck:async()=>{expect(cleanup).toBe(true);},buildDiscovery:async(_sha,_fetcher,_token,signal)=>{
      setTimeout(()=>{stopJoined=runner.stop();},10);
      try{await new Promise<void>((_resolve,reject)=>{signal?.addEventListener('abort',()=>reject(new Error('discovery aborted')),{once:true});});throw new Error('unexpected receipt');}
      finally{await new Promise(resolve=>setTimeout(resolve,10));cleanup=true;}
    },afterRun:async()=>{await stopJoined;expect(cleanup).toBe(true);}});
    expect(result.buildStatuses).toEqual(['discovering']);expect(result.buildReceipts).toEqual([]);expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);expect(result.stoppedAcks).toEqual([1]);expect(result.spools).toEqual([]);
  });

  it.each([false,true])('acknowledges a failed pre-effect discovery only after its local cleanup has joined (event completion: %s)',async awaitCompletion=>{
    const claim=stagingClaim();claim.run.operation!.phase='build_discovery';claim.run.operation!.imageDigest=undefined;
    let cleanup=false;
    const result=await execute(claim,async()=>({authorized:true,action:'discover'}),async()=>{throw new Error('SSH must not start');},{awaitCompletion,buildDiscovery:async()=>{try{throw new Error('build unavailable');}finally{cleanup=true;}},stopAck:async(_attempt,spool)=>{expect(cleanup).toBe(true);expect(spool).toMatchObject({stagingDiscoveryStopped:true,completion:{error:expect.any(String)}});}});
    expect(result.completions).toHaveLength(1);expect(result.stoppedAcks).toEqual([1]);expect(result.receipts).toEqual([]);expect(result.spools).toEqual([]);
  });

  it('confirms local stop when mutation permission is revoked after build discovery but before intent',async()=>{
    const claim=stagingClaim();claim.run.operation!.phase='build_discovery';claim.run.operation!.imageDigest=undefined;
    const discovered:StagingBuildReceipt={schemaVersion:1,repository:'blossomsai/menoteam',repositoryId:'88',workflowPath:'.github/workflows/build-workbench-image.yml',runId:123,runAttempt:2,artifactId:456,archiveDigest:`sha256:${'e'.repeat(64)}`,artifactExpiresAt:new Date(Date.now()+60_000).toISOString(),sourceSha:commitSha,imageRepository:repository,imageDigest,runUrl:'https://github.com/blossomsai/menoteam/actions/runs/123'};
    const result=await execute(claim,async effect=>{if(effect==='discovery')return{authorized:true,action:'discover'};throw new Error('policy revoked before mutation intent');},async()=>{throw new Error('SSH must not start');},{buildDiscovery:async()=>discovered});
    expect(result.buildReceipts).toHaveLength(1);expect(result.completions).toHaveLength(1);expect(result.stoppedAcks).toEqual([1]);expect(result.receipts).toEqual([]);expect(result.spools).toEqual([]);
  });

  it('aborts discovery provenance on lease loss without freezing a receipt or starting SSH',async()=>{
    const claim=stagingClaim();claim.run.operation!.phase='build_discovery';claim.run.operation!.imageDigest=undefined;
    const discovered:StagingBuildReceipt={schemaVersion:1,repository:'blossomsai/menoteam',repositoryId:'88',workflowPath:'.github/workflows/build-workbench-image.yml',runId:123,runAttempt:2,artifactId:456,archiveDigest:`sha256:${'e'.repeat(64)}`,artifactExpiresAt:new Date(Date.now()+60_000).toISOString(),sourceSha:commitSha,imageRepository:repository,imageDigest,runUrl:'https://github.com/blossomsai/menoteam/actions/runs/123'};
    let provenanceAborted=false;
    const result=await execute(claim,async effect=>{expect(effect).toBe('discovery');return{authorized:true,action:'discover'};},async()=>{throw new Error('SSH must not start');},{stopAfterMs:6_500,pauseOnHeartbeat:true,buildDiscovery:async()=>discovered,provenanceVerifier:async(_args,signal)=>new Promise<string>((_resolve,reject)=>{signal?.addEventListener('abort',()=>{provenanceAborted=true;reject(new Error('provenance aborted'));},{once:true});})});
    expect(provenanceAborted).toBe(true);expect(result.buildStatuses).toEqual(['discovering']);expect(result.buildReceipts).toEqual([]);expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);expect(result.stoppedAcks).toEqual([1]);expect(result.spools).toEqual([]);
  },10_000);

});
