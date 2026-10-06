import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectorRunner } from '../src/connector/runner.js';
import type { WorkbenchConnectorClient } from '../src/connector/client.js';
import type { CodexAppServer } from '../src/connector/codex.js';
import type { ClaimedRun, ConnectorConfig } from '../src/connector/types.js';
import type { Run } from '../src/workbench/types.js';
import type { StagingReceipt, StagingRequest, StagingTracking } from '../src/connector/staging-deploy.js';

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

async function execute(claim: ClaimedRun, authorize: (effect: 'provenance' | 'transport' | 'status') => Promise<{ authorized: true; action: 'deploy' | 'rollback' | 'status' }>, transport: (request: StagingRequest, tracking?:StagingTracking) => Promise<StagingReceipt>, options:{stopAfterMs?:number;stopProcess?:(identity:typeof identity)=>Promise<boolean>;pauseOnHeartbeat?:boolean}={}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'menoteam-staging-runner-'));
  let runner: ConnectorRunner;
  let claimed = false;
  const receipts: StagingReceipt[] = [];
  const completions: Array<{ error?: string }> = [];
  const renewals:number[]=[];
  const stoppedAcks:number[]=[];
  const client = {
    claim: async () => { if (!claimed) { claimed = true; return claim; } await new Promise(resolve=>setTimeout(resolve,options.stopAfterMs??50));await runner.stop(); return undefined; },
    renew: async (_id:string,generation:number) => { renewals.push(generation);if(options.pauseOnHeartbeat&&renewals.length>1){claim.run.status='paused';throw new Error('lease rejected after pause');}return claim.run; },
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
  try { await runner.run(); return { receipts, completions, renewals, stoppedAcks }; }
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
});
