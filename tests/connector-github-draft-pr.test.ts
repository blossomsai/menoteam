import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createDiff, diffRevision, fingerprint, persistWorktreeMap } from '../src/connector/git.js';
import { createDraftPullRequest } from '../src/connector/github-draft-pr.js';
import type { ClaimedRun, ConnectorConfig } from '../src/connector/types.js';

const execFile=promisify(execFileCb);let temp='';let priorToken:string|undefined;
const git=async(cwd:string,...args:string[])=>await execFile('git',args,{cwd,encoding:'utf8'});
const repository='https://github.com/example/project';

async function fixture(){
  temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-draft-pr-'));const root=path.join(temp,'repo');const bare=path.join(temp,'remote.git');const dataDir=path.join(temp,'connector-data');const checkout=path.join(dataDir,'worktrees','project','work');
  await mkdir(root,{recursive:true});await mkdir(dataDir,{recursive:true});
  await git(root,'init','-b','main');await git(root,'config','user.name','Local Test');await git(root,'config','user.email','local@example.test');
  await writeFile(path.join(root,'README.md'),'base\n');await git(root,'add','.');await git(root,'commit','-m','base');const base=(await git(root,'rev-parse','HEAD')).stdout.trim();
  await mkdir(bare);await git(bare,'init','--bare');await git(root,'remote','add','origin',`${repository}.git`);await git(root,'config',`url.file://${bare}.insteadOf`,`${repository}.git`);
  await git(root,'worktree','add','--detach',checkout,base);await writeFile(path.join(checkout,'feature.txt'),'draft me\n');await git(checkout,'add','.');await git(checkout,'-c','user.name=Local Test','-c','user.email=local@example.test','commit','-m','candidate');
  const commitSha=(await git(checkout,'rev-parse','HEAD')).stdout.trim();const diff=await createDiff(checkout,base);const candidateRevision=diffRevision(diff);const candidateFingerprint=await fingerprint(checkout);await persistWorktreeMap(dataDir,'work',{path:checkout,revision:commitSha,baseRevision:base,artifactRevision:candidateRevision});
  const run:ClaimedRun['run']={id:'delivery-1',projectId:'project',workId:'work',prompt:'',kind:'delivery',model:'internal',reasoning:'none',status:'running',generation:1,connectorId:'connector',requestedBy:'actor',createdAt:'',updatedAt:'',operation:{action:'create_draft_pr',actorId:'actor',candidateRunId:'candidate-1',candidateRevision,artifactRevision:candidateRevision,commitSha,candidateFingerprint,baseRevision:base,baseBranch:'main',remoteBranch:`codex/menoteam/work/${commitSha.slice(0,12)}`,workTitle:'Example Work',changeSummary:'feature.txt',qaStatus:'1 passed, 1 failed',phase:'queued'}};
  const claim:ClaimedRun={run,project:{id:'project',name:'Project',instructions:'',repositoryUrl:repository,deliveryAuthorization:'',createdAt:''},messages:[],settings:[]};
  const config:ConnectorConfig={serverUrl:'http://localhost:4313',token:'x'.repeat(32),connectorId:'connector',dataDir,projects:{project:root}};
  return {root,bare,checkout,base,commitSha,claim,config};
}

beforeEach(()=>{priorToken=process.env.MENOTEAM_GITHUB_TOKEN;process.env.MENOTEAM_GITHUB_TOKEN='local-test-token';});
afterEach(async()=>{if(priorToken===undefined)delete process.env.MENOTEAM_GITHUB_TOKEN;else process.env.MENOTEAM_GITHUB_TOKEN=priorToken;if(temp)await rm(temp,{recursive:true,force:true});});

describe('fixed Draft PR publication adapter',()=>{
  it('publishes only the saved SHA locally and reconciles retry to the same mock PR',async()=>{
    const f=await fixture();const baseHead=(await git(f.root,'rev-parse','HEAD')).stdout.trim();let createCount=0;let pr:{number:number;html_url:string;head:{sha:string};base:{ref:string};body:string;draft:boolean}|undefined;
    const mock=async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){createCount++;const input=JSON.parse(String(init.body));pr={number:17,html_url:'https://github.com/example/project/pull/17',head:{sha:f.commitSha},base:{ref:input.base},body:input.body,draft:true};return new Response(JSON.stringify(pr),{status:201});}return new Response(JSON.stringify(pr?[pr]:[]),{status:200});};
    const first=await createDraftPullRequest(f.config,f.claim,mock as typeof fetch);
    const second=await createDraftPullRequest(f.config,f.claim,mock as typeof fetch);
    expect(first).toEqual({number:17,url:'https://github.com/example/project/pull/17',headSha:f.commitSha});expect(second).toEqual(first);expect(createCount).toBe(1);
    expect((await git(f.bare,'rev-parse',`refs/heads/${f.claim.run.operation!.remoteBranch}`)).stdout.trim()).toBe(f.commitSha);
    expect((await git(f.root,'rev-parse','HEAD')).stdout.trim()).toBe(baseHead);
    expect(pr?.draft).toBe(true);expect(pr?.body).toContain('1 passed, 1 failed');
  });
  it('rejects a changed HEAD before any remote publication or HTTP call',async()=>{
    const f=await fixture();await writeFile(path.join(f.checkout,'drift.txt'),'changed\n');await git(f.checkout,'add','.');await git(f.checkout,'-c','user.name=Local Test','-c','user.email=local@example.test','commit','-m','drift');let httpCalls=0;
    await expect(createDraftPullRequest(f.config,f.claim,(async()=>{httpCalls++;return new Response('[]');}) as typeof fetch)).rejects.toThrow('Candidate HEAD changed');expect(httpCalls).toBe(0);
    const branches=(await git(f.bare,'for-each-ref','--format=%(refname)','refs/heads')).stdout.trim();expect(branches).toBe('');
  });
  it('reconciles a create response lost after the mock PR already exists',async()=>{
    const f=await fixture();let createCount=0;let pr:{number:number;html_url:string;head:{sha:string};base:{ref:string};body:string;draft:boolean}|undefined;
    const mock=async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){createCount++;const input=JSON.parse(String(init.body));pr={number:29,html_url:'https://github.com/example/project/pull/29',head:{sha:f.commitSha},base:{ref:input.base},body:input.body,draft:true};throw new Error('mocked lost response after creation');}return new Response(JSON.stringify(pr?[pr]:[]),{status:200});};
    await expect(createDraftPullRequest(f.config,f.claim,mock as typeof fetch)).rejects.toThrow('mocked lost response');
    expect(await createDraftPullRequest(f.config,f.claim,mock as typeof fetch)).toEqual({number:29,url:'https://github.com/example/project/pull/29',headSha:f.commitSha});expect(createCount).toBe(1);
  });
  it('rejects dirty, altered fingerprint, and a mismatched remote before pushing',async()=>{
    const dirty=await fixture();await writeFile(path.join(dirty.checkout,'untracked.txt'),'dirty');
    await expect(createDraftPullRequest(dirty.config,dirty.claim)).rejects.toThrow('Candidate checkout is not clean');
    const altered=await fixture();altered.claim.run.operation!.candidateFingerprint='f'.repeat(64);
    await expect(createDraftPullRequest(altered.config,altered.claim)).rejects.toThrow('Candidate fingerprint changed');
    const wrongRemote=await fixture();await git(wrongRemote.checkout,'config','remote.origin.url','https://github.com/example/other.git');
    await expect(createDraftPullRequest(wrongRemote.config,wrongRemote.claim)).rejects.toThrow('Candidate push URL does not match');
    const wrongPushUrl=await fixture();await git(wrongPushUrl.checkout,'config','remote.origin.pushurl','https://github.com/example/other.git');
    await expect(createDraftPullRequest(wrongPushUrl.config,wrongPushUrl.claim)).rejects.toThrow('Candidate push URL does not match');
  });
  it('rejects a fixed branch that already points at another SHA',async()=>{
    const f=await fixture();await writeFile(path.join(f.root,'other.txt'),'other\n');await git(f.root,'add','.');await git(f.root,'commit','-m','other');const other=(await git(f.root,'rev-parse','HEAD')).stdout.trim();const branch=f.claim.run.operation!.remoteBranch;
    await git(f.root,'push','origin',`${other}:refs/heads/${branch}`);
    await expect(createDraftPullRequest(f.config,f.claim)).rejects.toThrow('Fixed publication branch already points to a different commit');
  });
});
