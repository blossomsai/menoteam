import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as processInspection from '../src/connector/codex.js';
import { stateKey, writeSecureJson } from '../src/connector/state.js';
import { ConnectorRunner } from '../src/connector/runner.js';
import type { CodexAppServer } from '../src/connector/codex.js';
import type { WorkbenchConnectorClient } from '../src/connector/client.js';
import { draftFixture } from './helpers/draft-pr-fixture.js';
const wait=async(check:()=>Promise<boolean>)=>{const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out waiting for crash fixture');};
const native={start:async()=>[],stop:async()=>{}} as unknown as CodexAppServer;

describe('durable Draft PR Connector recovery',()=>{
  // Fault only process inspection; durable state and Runner recovery remain real.
  for (const fault of ['missing child identity', 'unverifiable child identity', 'executor EPERM', 'reused executor PID'] as const) {
    it(`retains the Git-stage reservation across restart with ${fault}`, async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), 'menoteam-delivery-negative-'));
      const executorPid = 2147000000;
      const childIdentity = { pid: 2147000001, processGroupId: 2147000001, startedAt: 'saved-before-crash', command: 'git push fixed-ref' };
      const originalKill = process.kill.bind(process);
      const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid !== executorPid || signal !== 0) return originalKill(pid, signal);
        if (fault === 'reused executor PID') return true; // The old PID now belongs to an unrelated live process.
        throw Object.assign(new Error('Controlled executor inspection fault'), { code: fault === 'executor EPERM' ? 'EPERM' : 'ESRCH' });
      });
      const waitGroup = vi.spyOn(processInspection, 'waitProcessGroup').mockResolvedValue(false);
      const verifyGroup = vi.spyOn(processInspection, 'terminateVerifiedGitProcessGroup').mockResolvedValue(false);
      try {
        const f = await draftFixture(temp);
        f.config.pollIntervalMs = 10;
        const spoolPath = path.join(f.config.dataDir, 'spool', `${stateKey(f.claim.run.id, '1')}.json`);
        await writeSecureJson(spoolPath, {
          runId: f.claim.run.id, generation: 1, events: [], artifacts: [],
          deliveryExecutor: { pid: executorPid, executionId: 'pre-crash-executor', stage: 'git' },
          ...(fault === 'missing child identity' ? {} : { deliveryProcessIdentity: childIdentity }),
          deliveryProgress: { phase: 'published', remoteHeadSha: f.commitSha },
        });
        const saved = await readFile(spoolPath, 'utf8');
        const effect = vi.fn(() => { throw new Error('Recovery must not execute delivery effects'); });
        const generation = 1;
        // No stopped proof is sent to the server. This fixture models its existing reservation;
        // actual PG stopped-proof/retry authorization is separate operator validation.
        const reservation = { runId: f.claim.run.id, generation, stopped: false };
        const stopped = vi.fn(async () => { reservation.stopped = true; reservation.generation++; });
        let totalClaims = 0;
        let retryClaims = 0;
        for (let restart = 0; restart < 2; restart++) {
          let runner: ConnectorRunner;
          const client = {
            readRun: async () => ({ ...f.claim.run, status: 'interrupted' }),
            stopped,
            claim: async () => {
              totalClaims++;
              if (reservation.stopped && retryClaims === 0) {
                retryClaims++;
                return { ...f.claim, run: { ...f.claim.run, generation: reservation.generation } };
              }
              await runner.stop(); return undefined;
            },
            authorizeDeliveryEffect: effect, renew: effect, deliveryProgress: effect, complete: effect,
          } as unknown as WorkbenchConnectorClient;
          runner = new ConnectorRunner(f.config, {
            native: () => native, client: () => client,
            delivery: { transport: effect, fetcher: effect as unknown as typeof fetch },
          });
          await runner.run();
          expect(await readFile(spoolPath, 'utf8')).toBe(saved);
          expect(await readdir(path.join(f.config.dataDir, 'spool'))).toEqual([path.basename(spoolPath)]);
          expect(await readdir(path.join(f.config.dataDir, 'unsent-evidence')).catch(() => [])).toEqual([]);
          expect(stopped).not.toHaveBeenCalled();
          expect(effect).not.toHaveBeenCalled();
          expect(reservation).toEqual({ runId: f.claim.run.id, generation: 1, stopped: false });
        }
        expect(totalClaims).toBe(2);
        expect(retryClaims).toBe(0);
        expect(probe).toHaveBeenCalledWith(executorPid, 0);
        if (fault === 'unverifiable child identity') {
          expect(waitGroup).toHaveBeenCalledWith(childIdentity.processGroupId, 1);
          expect(verifyGroup).toHaveBeenCalledWith(childIdentity);
        } else {
          // Missing child proof and executor ambiguity must stop before touching the old group.
          expect(waitGroup).not.toHaveBeenCalled();
          expect(verifyGroup).not.toHaveBeenCalled();
        }
      } finally {
        probe.mockRestore(); waitGroup.mockRestore(); verifyGroup.mockRestore();
        await rm(temp, { recursive: true, force: true });
      }
    });
  }

  it('releases the persisted Git-stage reservation only after executor absence and verified child stop', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'menoteam-delivery-verified-'));
    const prior = process.env.MENOTEAM_GITHUB_TOKEN;
    process.env.MENOTEAM_GITHUB_TOKEN = 'fixture-token';
    const executorPid = 2147000000;
    const childIdentity = { pid: 2147000001, processGroupId: 2147000001, startedAt: 'saved-before-crash', command: 'git push fixed-ref' };
    const originalKill = process.kill.bind(process);
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== executorPid || signal !== 0) return originalKill(pid, signal);
      throw Object.assign(new Error('Controlled executor absence'), { code: 'ESRCH' });
    });
    const waitGroup = vi.spyOn(processInspection, 'waitProcessGroup').mockResolvedValue(false);
    let verified = false;
    const verifyGroup = vi.spyOn(processInspection, 'terminateVerifiedGitProcessGroup').mockImplementation(async identity => {
      expect(identity).toEqual(childIdentity);
      return verified;
    });
    try {
      const f = await draftFixture(temp);
      f.config.pollIntervalMs = 10;
      // Exact remote SHA/PR already exist; successful recovery must only reconcile.
      await f.transport(f.checkout, {}, 'push', `--force-with-lease=refs/heads/${f.claim.run.operation!.remoteBranch}:`, `${f.claim.project.repositoryUrl}.git`, `${f.commitSha}:refs/heads/${f.claim.run.operation!.remoteBranch}`);
      const spoolPath = path.join(f.config.dataDir, 'spool', `${stateKey(f.claim.run.id, '1')}.json`);
      await writeSecureJson(spoolPath, {
        runId: f.claim.run.id, generation: 1, events: [], artifacts: [],
        deliveryExecutor: { pid: executorPid, executionId: 'pre-crash-executor', stage: 'git' },
        deliveryProcessIdentity: childIdentity,
      });
      const saved = await readFile(spoolPath, 'utf8');
      let runner: ConnectorRunner;
      let acknowledgments = 0;
      let generation = 1;
      let reserved = true;
      let claimed = false;
      let completed = 0;
      const calls: string[] = [];
      const client = {
        readRun: async () => ({ ...f.claim.run, status: 'interrupted', generation: 1 }),
        stopped: async (id: string, g: number) => {
          expect(verified).toBe(true); expect(id).toBe(f.claim.run.id); expect(g).toBe(1);
          calls.push('stopped'); acknowledgments++; reserved = false; generation = 2;
        },
        claim: async () => {
          if (!reserved && !claimed) { claimed = true; return { ...f.claim, run: { ...f.claim.run, generation } }; }
          await runner.stop(); return undefined;
        },
        renew: async () => {},
        authorizeDeliveryEffect: async (_id: string, g: number) => {
          expect(acknowledgments).toBe(1); expect(g).toBe(2); calls.push('authorize');
          return { repositoryUrl: f.claim.project.repositoryUrl };
        },
        deliveryProgress: async () => {},
        complete: async () => { completed++; },
      } as unknown as WorkbenchConnectorClient;
      const effects: string[] = [];
      const transport = async (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => {
        expect(acknowledgments).toBe(1); effects.push(args[0]!); return f.transport(cwd, env, ...args);
      };
      // Simulate an ambiguous group on first restart, then independently verified termination.
      const fetcher = (async (_url: string, init?: RequestInit) => {
        expect(acknowledgments).toBe(1); effects.push(init?.method ?? 'GET');
        return new Response(JSON.stringify([{ number: 91, html_url: 'https://github.com/example/project/pull/91',
          head: { sha: f.commitSha }, base: { ref: 'main' }, body: `<!-- menoteam-operation:${f.claim.run.id} -->`, draft: true }]));
      }) as typeof fetch;
      runner = new ConnectorRunner(f.config, { native: () => native, client: () => client, delivery: { transport, fetcher } });
      await runner.run();
      expect(await readFile(spoolPath, 'utf8')).toBe(saved);
      expect(acknowledgments).toBe(0); expect(generation).toBe(1); expect(reserved).toBe(true); expect(effects).toEqual([]);
      verified = true;
      runner = new ConnectorRunner(f.config, { native: () => native, client: () => client, delivery: { transport, fetcher } });
      await runner.run();
      expect(acknowledgments).toBe(1); expect(completed).toBe(1); expect(generation).toBe(2);
      expect(calls[0]).toBe('stopped'); expect(calls).toContain('authorize');
      expect(effects.filter(effect => effect === 'POST')).toEqual([]);
      expect(effects.filter(effect => effect === 'push')).toEqual([]);
      expect(await readdir(path.join(f.config.dataDir, 'spool'))).toEqual([]);
    } finally {
      probe.mockRestore(); waitGroup.mockRestore(); verifyGroup.mockRestore();
      if (prior === undefined) delete process.env.MENOTEAM_GITHUB_TOKEN; else process.env.MENOTEAM_GITHUB_TOKEN = prior;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('replays the durable completion outbox after response loss without a second PR or publication',async()=>{
    const temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-delivery-outbox-'));const prior=process.env.MENOTEAM_GITHUB_TOKEN;process.env.MENOTEAM_GITHUB_TOKEN='fixture-token';
    try{
      const f=await draftFixture(temp);let runner:ConnectorRunner;let claimed=false;let completed=0;let posts=0;let pushes=0;let phaseRequests=0;
      const client={claim:async()=>{if(!claimed){claimed=true;return f.claim;}if(completed>=2)await runner.stop();return undefined;},readRun:async()=>f.claim.run,renew:async()=>{},authorizeDeliveryEffect:async()=>({repositoryUrl:f.claim.project.repositoryUrl}),deliveryProgress:async()=>{phaseRequests++;},complete:async()=>{completed++;if(completed===1){await runner.stop();throw new Error('completion response lost');}}} as unknown as WorkbenchConnectorClient;
      const transport=async(cwd:string,env:NodeJS.ProcessEnv,...args:string[])=>{if(args[0]==='push')pushes++;return f.transport(cwd,env,...args);};
      const fetcher=(async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){posts++;return new Response(JSON.stringify({number:83,html_url:'https://github.com/example/project/pull/83',head:{sha:f.commitSha},draft:true}));}return new Response('[]');}) as typeof fetch;
      runner=new ConnectorRunner(f.config,{native:()=>native,client:()=>client,delivery:{transport,fetcher}});await runner.run();
      const pending=await readdir(path.join(f.config.dataDir,'spool'));expect(pending).toHaveLength(1);expect(JSON.parse(await readFile(path.join(f.config.dataDir,'spool',pending[0]!),'utf8')).completion).toEqual({});
      runner=new ConnectorRunner(f.config,{native:()=>native,client:()=>client,delivery:{transport,fetcher}});await runner.run();
      expect(completed).toBe(2);expect(posts).toBe(1);expect(pushes).toBe(1);expect(phaseRequests).toBe(2);expect(await readdir(path.join(f.config.dataDir,'spool'))).toEqual([]);
    }finally{if(prior===undefined)delete process.env.MENOTEAM_GITHUB_TOKEN;else process.env.MENOTEAM_GITHUB_TOKEN=prior;await rm(temp,{recursive:true,force:true});}
  },15000);

  for(const stage of ['phase','http'] as const)it(`proves executor stopped after ${stage} crash, then reconciles without overlap`,async()=>{
    const temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-delivery-recovery-'));const prior=process.env.MENOTEAM_GITHUB_TOKEN;process.env.MENOTEAM_GITHUB_TOKEN='fixture-token';
    let child:ReturnType<typeof spawn>|undefined;
    try{
      const f=await draftFixture(temp);const marker=path.join(temp,'crash-ready');const prFile=path.join(temp,'pr.json');const posts=path.join(temp,'posts');
      const script=path.join(temp,'crash.ts');const runnerPath=path.resolve('src/connector/runner.ts');
      await writeFile(script,`
import { ConnectorRunner } from ${JSON.stringify(runnerPath)};
import { readFile,writeFile,appendFile } from 'node:fs/promises';
import { execFile as execCb } from 'node:child_process';import { promisify } from 'node:util';
const git=promisify(execCb);const cfg=${JSON.stringify(f.config)};const claim=${JSON.stringify(f.claim)};let claimed=false;
const hang=async()=>{await writeFile(${JSON.stringify(marker)},'ready');return new Promise(()=>{});};
const client={claim:async()=>{if(claimed)return undefined;claimed=true;return claim;},renew:async()=>{},authorizeDeliveryEffect:async()=>({repositoryUrl:claim.project.repositoryUrl}),readRun:async()=>claim.run,deliveryProgress:async()=>{if(${JSON.stringify(stage)}==='phase')await hang();},complete:async()=>{throw Error('Unexpected completion');}};
const transport=async(cwd,env,...args)=>(await git('git',args.map(a=>a===claim.project.repositoryUrl+'.git'?${JSON.stringify(f.bare)}:a),{cwd,encoding:'utf8'})).stdout;
const fetcher=async(url,init)=>{if(init?.method==='POST'){await appendFile(${JSON.stringify(posts)},'POST\\n');const input=JSON.parse(init.body);const pr={number:71,html_url:'https://github.com/example/project/pull/71',head:{sha:claim.run.operation.commitSha},base:{ref:input.base},body:input.body,draft:true};await writeFile(${JSON.stringify(prFile)},JSON.stringify(pr));await hang();}return new Response('[]');};
new ConnectorRunner(cfg,{native:()=>({start:async()=>[],stop:async()=>{}}),client:()=>client,delivery:{transport,fetcher}}).run();
`);
      child=spawn(process.execPath,['--import','tsx',script],{cwd:process.cwd(),env:process.env,stdio:'pipe'});let stderr='';child.stderr?.on('data',b=>{stderr+=b;});
      await wait(async()=>{if(child?.exitCode!==null)throw new Error(stderr);return readFile(marker).then(()=>true,()=>false);});
      const files=await readdir(path.join(f.config.dataDir,'spool'));const spool=JSON.parse(await readFile(path.join(f.config.dataDir,'spool',files[0]!), 'utf8'));
      expect(spool.deliveryExecutor.pid).toBe(child.pid);expect(spool.deliveryProcessIdentity).toBeUndefined();expect(spool.completion).toBeUndefined();
      let runner:ConnectorRunner;let acks=0;let authorized=0;let claims=0;let completed=0;let prResult:any;let remote={...f.claim.run,status:'interrupted' as const};
      const client={readRun:async()=>remote,stopped:async()=>{acks++;},claim:async()=>{await runner.stop();return undefined;}} as unknown as WorkbenchConnectorClient;
      // A second Connector cannot release a reservation while the old HTTP/phase executor is alive.
      runner=new ConnectorRunner(f.config,{native:()=>native,client:()=>client});await runner.run();expect(acks).toBe(0);expect(await readdir(path.join(f.config.dataDir,'spool'))).toHaveLength(1);
      const exited=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;
      let retry=false;const retryClaim={...f.claim,run:{...f.claim.run,generation:2}};
      const restarted={readRun:async()=>remote,stopped:async(_id:string,g:number)=>{expect(g).toBe(1);acks++;retry=true;},claim:async()=>{claims++;if(retry){retry=false;return retryClaim;}if(completed)await runner.stop();return undefined;},renew:async()=>{},authorizeDeliveryEffect:async(_id:string,g:number)=>{expect(g).toBe(2);expect(acks).toBe(1);authorized++;return {repositoryUrl:f.claim.project.repositoryUrl};},deliveryProgress:async(_id:string,_g:number,phase:any)=>{if(phase.phase==='pr_created')prResult=phase;},complete:async()=>{completed++;}} as unknown as WorkbenchConnectorClient;
      const fetcher=(async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){await appendFile(posts,'POST\n');const input=JSON.parse(String(init.body));const pr={number:71,html_url:'https://github.com/example/project/pull/71',head:{sha:f.commitSha},base:{ref:input.base},body:input.body,draft:true};await writeFile(prFile,JSON.stringify(pr));return new Response(JSON.stringify(pr));}return new Response(JSON.stringify(await readFile(prFile,'utf8').then(s=>[JSON.parse(s)],()=>[])));}) as typeof fetch;
      runner=new ConnectorRunner(f.config,{native:()=>native,client:()=>restarted,delivery:{transport:f.transport,fetcher}});await runner.run();
      expect(acks).toBe(1);expect(completed).toBe(1);expect(prResult).toMatchObject({phase:'pr_created',pullRequestNumber:71,headSha:f.commitSha});expect(authorized).toBeGreaterThan(0);expect(claims).toBeGreaterThan(1);expect((await readFile(posts,'utf8')).trim().split('\n')).toHaveLength(1);expect(JSON.parse(await readFile(prFile,'utf8')).number).toBe(71);expect(await readdir(path.join(f.config.dataDir,'spool'))).toEqual([]);
      if(stage==='phase')expect(await readdir(path.join(f.config.dataDir,'unsent-evidence'))).toHaveLength(1);
    }finally{child?.kill('SIGKILL');if(prior===undefined)delete process.env.MENOTEAM_GITHUB_TOKEN;else process.env.MENOTEAM_GITHUB_TOKEN=prior;await rm(temp,{recursive:true,force:true});}
  },20000);
});
