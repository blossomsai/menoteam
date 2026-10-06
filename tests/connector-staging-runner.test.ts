import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectorRunner } from '../src/connector/runner.js';
import type { WorkbenchConnectorClient } from '../src/connector/client.js';
import type { CodexAppServer } from '../src/connector/codex.js';
import type { ClaimedRun, ConnectorConfig } from '../src/connector/types.js';
import type { Run } from '../src/workbench/types.js';
import type { StagingReceipt, StagingRequest, StagingTracking } from '../src/connector/staging-deploy.js';
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

async function execute(claim: ClaimedRun, authorize: (effect: 'provenance' | 'transport' | 'status') => Promise<{ authorized: true; action: 'deploy' | 'rollback' | 'status' }>, transport: (request: StagingRequest, tracking?:StagingTracking) => Promise<StagingReceipt>, options:{stopAfterMs?:number;stopProcess?:(identity:typeof identity)=>Promise<boolean>;pauseOnHeartbeat?:boolean;recovery?:boolean;recoveryIdentity?:boolean;afterRun?:()=>Promise<void>;renew?:(count:number)=>Promise<void>;onRunner?:(runner:ConnectorRunner)=>void}={}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'menoteam-staging-runner-'));
  let runner: ConnectorRunner;
  let claimed = false;
  const receipts: StagingReceipt[] = [];
  const completions: Array<{ error?: string }> = [];
  const renewals:number[]=[];
  const stoppedAcks:number[]=[];
  const client = {
    claim: async () => { if (!claimed&&!options.recovery) { claimed = true; return claim; } await new Promise(resolve=>setTimeout(resolve,options.stopAfterMs??50));await runner.stop(); return undefined; },
    renew: async (_id:string,generation:number) => { renewals.push(generation);await options.renew?.(renewals.length);if(options.pauseOnHeartbeat&&renewals.length>1){claim.run.status='paused';throw new Error('lease rejected after pause');}return claim.run; },
    authorizeStagingEffect: async (_id: string, generation: number, effect: 'provenance' | 'transport' | 'status') => {
      expect(generation).toBe(claim.run.generation);
      return authorize(effect);
    },
    stagingProgress: async (_id: string, _generation: number, receipt: StagingReceipt) => { receipts.push(receipt); },
    stopped: async (_id:string,generation:number)=>{stoppedAcks.push(generation);return claim.run;},
    complete: async (_id: string, _generation: number, completion: { error?: string }) => { completions.push(completion); await runner.stop(); return claim.run; },
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
    client: () => client,
    staging: { transport: fakeTransport as never, provenanceVerifier: attestation, targetValidator: async () => {}, ...(options.stopProcess?{stopProcess:options.stopProcess as never}:{}) },
  });
  if(options.recovery)await writeSecureJson(path.join(dataDir,'spool',`${stateKey(runId,'1')}.json`),{runId,generation:1,events:[],artifacts:[],stagingIntent:{targetId:'staging',commitSha,imageDigest,expectedCurrentDeploymentId:null},stagingTransportStarted:true,stagingTransportStopped:!options.recoveryIdentity,...(options.recoveryIdentity?{stagingProcessIdentity:identity}:{}),deliveryExecutor:{pid:process.pid,executionId:'crashed-fixture',stage:'staging'}});
  options.onRunner?.(runner);
  try {
    await runner.run();await options.afterRun?.();
    const spools=await Promise.all((await readdir(path.join(dataDir,'spool'))).map(file=>readJson<Record<string,unknown>>(path.join(dataDir,'spool',file))));
    return { receipts, completions, renewals, stoppedAcks, spools };
  }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

describe('staging delivery Connector integration', () => {
  it('authorizes before provenance and SSH, then completes only from the exact healthy receipt', async () => {
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

  it('an existing intent after a generation change can only perform read-only status', async () => {
    const effects: string[] = [], transportActions: string[] = [];
    const claim = stagingClaim('deploy_intent'); claim.run.generation = 2;
    const result = await execute(claim, async effect => { effects.push(effect); return { authorized: true, action: 'status' }; }, async request => {
      transportActions.push(request.action);
      return { operationId: request.operationId, targetId: request.targetId, phase: 'unknown', commitSha: request.commitSha, imageDigest: request.imageDigest, checkedAt: new Date().toISOString() };
    });
    expect(effects).toEqual(['status']);
    expect(transportActions).toEqual(['status']);
    expect(result.receipts[0]?.phase).toBe('unknown');
    expect(result.completions[0]?.error).toBeTruthy();
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


  it('stops an orphaned verified SSH group during paused recovery without a status effect',async()=>{
    const claim=stagingClaim('deploy_intent');claim.run.status='paused';const stops:unknown[]=[];const effects:string[]=[];
    const result=await execute(claim,async effect=>{effects.push(effect);throw new Error('paused recovery must not authorize status');},async()=>{throw new Error('no transport');},{recovery:true,recoveryIdentity:true,stopProcess:async value=>{stops.push(value);return true;}});
    expect(stops).toEqual([identity]);expect(effects).toEqual([]);expect(result.receipts).toEqual([]);expect(result.completions).toEqual([]);
    expect(result.spools[0]).toMatchObject({stagingIntent:{commitSha,imageDigest},stagingTransportStopped:true});
    expect(result.spools[0]?.stagingProcessIdentity).toBeUndefined();
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

});
