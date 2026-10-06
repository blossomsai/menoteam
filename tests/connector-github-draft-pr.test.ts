import { draftFixture } from './helpers/draft-pr-fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createDiff, diffRevision, fingerprint, gitWithEnv, persistWorktreeMap } from '../src/connector/git.js';
import { waitProcessGroup } from '../src/connector/codex.js';
import { createDraftPullRequest } from '../src/connector/github-draft-pr.js';
import type { ClaimedRun, ConnectorConfig } from '../src/connector/types.js';

const execFile=promisify(execFileCb);let temp='';let priorToken:string|undefined;
const git=async(cwd:string,...args:string[])=>await execFile('git',args,{cwd,encoding:'utf8'});
const repository='https://github.com/example/project';

async function fixture(){temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-draft-pr-'));return draftFixture(temp);}
const create=(f:Awaited<ReturnType<typeof fixture>>,fetcher:typeof fetch=fetch,beforeEffect?:()=>Promise<string|void>,onPhase?:Parameters<typeof createDraftPullRequest>[3])=>createDraftPullRequest(f.config,f.claim,fetcher,onPhase,beforeEffect,f.transport);

beforeEach(()=>{priorToken=process.env.MENOTEAM_GITHUB_TOKEN;process.env.MENOTEAM_GITHUB_TOKEN='local-test-token';});
afterEach(async()=>{if(priorToken===undefined)delete process.env.MENOTEAM_GITHUB_TOKEN;else process.env.MENOTEAM_GITHUB_TOKEN=priorToken;if(temp)await rm(temp,{recursive:true,force:true});});

describe('fixed Draft PR publication adapter',()=>{
  it('publishes only the saved SHA locally and reconciles retry to the same mock PR',async()=>{
    const f=await fixture();const baseHead=(await git(f.root,'rev-parse','HEAD')).stdout.trim();let createCount=0;let pr:{number:number;html_url:string;head:{sha:string};base:{ref:string;sha:string};node_id:string;body:string;draft:boolean}|undefined;
    const mock=async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){createCount++;const input=JSON.parse(String(init.body));pr={number:17,html_url:'https://github.com/example/project/pull/17',head:{sha:f.commitSha},base:{ref:input.base,sha:'b'.repeat(40)},node_id:'PR_fixture',body:input.body,draft:true};return new Response(JSON.stringify(pr),{status:201});}return new Response(JSON.stringify(pr?[pr]:[]),{status:200});};
    const first=await create(f,mock as typeof fetch);
    const second=await create(f,mock as typeof fetch);
    expect(first).toMatchObject({number:17,url:'https://github.com/example/project/pull/17',headSha:f.commitSha});expect(second).toEqual(first);expect(createCount).toBe(1);
    expect((await git(f.bare,'rev-parse',`refs/heads/${f.claim.run.operation!.remoteBranch}`)).stdout.trim()).toBe(f.commitSha);
    expect((await git(f.root,'rev-parse','HEAD')).stdout.trim()).toBe(baseHead);
    expect(pr?.draft).toBe(true);expect(pr?.body).toContain('1 passed, 1 failed');
  });
  it('atomically rejects an ancestor branch created after the absent lookup',async()=>{
    const f=await fixture();const ref=`refs/heads/${f.claim.run.operation!.remoteBranch}`;let injected=false;let http=0;
    const transport=async(cwd:string,env:NodeJS.ProcessEnv,...args:string[])=>{
      if(args[0]==='push'){
        expect(args).toContain(`--force-with-lease=${ref}:`);
        await git(f.checkout,'push',f.bare,`${f.base}:${ref}`);injected=true;
      }
      return f.transport(cwd,env,...args);
    };
    await expect(createDraftPullRequest(f.config,f.claim,(async()=>{http++;return new Response('[]');}) as typeof fetch,undefined,undefined,transport)).rejects.toThrow('Atomic publication conflicted');
    expect(injected).toBe(true);expect(http).toBe(0);expect((await git(f.bare,'rev-parse',ref)).stdout.trim()).toBe(f.base);
  });
  it('accepts a concurrent creator only when the ref is the exact candidate SHA',async()=>{
    const f=await fixture();const ref=`refs/heads/${f.claim.run.operation!.remoteBranch}`;
    const transport=async(cwd:string,env:NodeJS.ProcessEnv,...args:string[])=>{if(args[0]==='push')await git(f.checkout,'push',f.bare,`${f.commitSha}:${ref}`);return f.transport(cwd,env,...args);};
    const mock=(async(_url:string,init?:RequestInit)=>new Response(JSON.stringify(init?.method==='POST'?{number:31,html_url:'https://github.com/example/project/pull/31',head:{sha:f.commitSha},base:{ref:'main',sha:'b'.repeat(40)},node_id:'PR_fixture',draft:true}:[]))) as typeof fetch;
    expect((await createDraftPullRequest(f.config,f.claim,mock,undefined,undefined,transport)).headSha).toBe(f.commitSha);
  });
  it('rejects a changed HEAD before any remote publication or HTTP call',async()=>{
    const f=await fixture();await writeFile(path.join(f.checkout,'drift.txt'),'changed\n');await git(f.checkout,'add','.');await git(f.checkout,'-c','user.name=Local Test','-c','user.email=local@example.test','commit','-m','drift');let httpCalls=0;
    await expect(create(f,(async()=>{httpCalls++;return new Response('[]');}) as typeof fetch)).rejects.toThrow('Candidate HEAD changed');expect(httpCalls).toBe(0);
    const branches=(await git(f.bare,'for-each-ref','--format=%(refname)','refs/heads')).stdout.trim();expect(branches).toBe('');
  });
  it('reconciles a create response lost after the mock PR already exists',async()=>{
    const f=await fixture();let createCount=0;let pr:{number:number;html_url:string;head:{sha:string};base:{ref:string;sha:string};node_id:string;body:string;draft:boolean}|undefined;
    const mock=async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){createCount++;const input=JSON.parse(String(init.body));pr={number:29,html_url:'https://github.com/example/project/pull/29',head:{sha:f.commitSha},base:{ref:input.base,sha:'b'.repeat(40)},node_id:'PR_fixture',body:input.body,draft:true};throw new Error('mocked lost response after creation');}return new Response(JSON.stringify(pr?[pr]:[]),{status:200});};
    await expect(create(f,mock as typeof fetch)).rejects.toThrow('mocked lost response');
    expect(await create(f,mock as typeof fetch)).toMatchObject({number:29,url:'https://github.com/example/project/pull/29',headSha:f.commitSha});expect(createCount).toBe(1);
  });
  it('rejects dirty, altered fingerprint, and a mismatched remote before pushing',async()=>{
    const dirty=await fixture();await writeFile(path.join(dirty.checkout,'untracked.txt'),'dirty');
    await expect(create(dirty)).rejects.toThrow('Candidate checkout is not clean');
    const altered=await fixture();altered.claim.run.operation!.candidateFingerprint='f'.repeat(64);
    await expect(create(altered)).rejects.toThrow('Candidate fingerprint changed');
    const wrongRemote=await fixture();await git(wrongRemote.checkout,'config','remote.origin.url','https://github.com/example/other.git');
    await expect(create(wrongRemote)).rejects.toThrow('Candidate push URL does not match');
    const wrongPushUrl=await fixture();await git(wrongPushUrl.checkout,'config','remote.origin.pushurl','https://github.com/example/other.git');
    await expect(create(wrongPushUrl)).rejects.toThrow('Candidate push URL does not match');
  });
  it('rejects a fixed branch that already points at another SHA',async()=>{
    const f=await fixture();await writeFile(path.join(f.root,'other.txt'),'other\n');await git(f.root,'add','.');await git(f.root,'commit','-m','other');const other=(await git(f.root,'rev-parse','HEAD')).stdout.trim();const branch=f.claim.run.operation!.remoteBranch;
    await git(f.root,'push',f.bare,`${other}:refs/heads/${branch}`);
    await expect(create(f)).rejects.toThrow('Fixed publication branch already points to a different commit');
  });
  it('rejects an effective local Git URL rewrite before any local transport or HTTP effect',async()=>{
    const f=await fixture();await git(f.checkout,'config',`url.file://${f.bare}.insteadOf`,`${repository}.git`);let effects=0;
    await expect(create(f,(async()=>{effects++;return new Response('[]');}) as typeof fetch)).rejects.toThrow('Git URL rewrite rules are forbidden');
    expect(effects).toBe(0);expect((await git(f.bare,'for-each-ref','--format=%(refname)','refs/heads')).stdout.trim()).toBe('');
  });
  it('rejects URL rewrites from included and worktree Git config',async()=>{
    const included=await fixture();const configFile=path.join(included.root,'redirect.conf');await writeFile(configFile,`[url "file://${included.bare}"]\n\tinsteadOf = ${repository}.git\n`);await git(included.checkout,'config','include.path',configFile);
    await expect(create(included)).rejects.toThrow('Git URL rewrite rules are forbidden');
    await rm(temp,{recursive:true,force:true});temp='';
    const worktree=await fixture();await git(worktree.checkout,'config','extensions.worktreeConfig','true');await git(worktree.checkout,'config','--worktree',`url.file://${worktree.bare}.insteadOf`,`${repository}.git`);
    await expect(create(worktree)).rejects.toThrow('Git URL rewrite rules are forbidden');
  });
  it('rechecks current repository authorization before every external effect',async()=>{
    const f=await fixture();let checks=0;let httpCalls=0;
    await expect(create(f,(async()=>{httpCalls++;return new Response('[]');}) as typeof fetch,async()=>{checks++;return checks===5?'https://github.com/example/changed':repository;})).rejects.toThrow('Current Draft PR repository authorization changed');
    expect(checks).toBe(5);expect(httpCalls).toBe(1);
  });
  it.skipIf(process.platform==='win32')('kills and waits for the complete Git transport process group on timeout',async()=>{
    const f=await fixture();const hook=path.join(f.bare,'hooks','pre-receive');await writeFile(hook,['#!/bin/sh','sleep 60',''].join(String.fromCharCode(10)));await chmod(hook,0o700);
    let pid=0;let stopped=false;
    await expect(gitWithEnv(f.checkout,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_PARAMETERS:'',GIT_CONFIG_COUNT:'0'},['push',f.bare,f.commitSha+':refs/heads/timeout-test'],async value=>{pid=value;},async()=>{stopped=true;},100)).rejects.toMatchObject({code:'ETIMEDOUT'});
    expect(pid).toBeGreaterThan(1);expect(stopped).toBe(true);expect(await waitProcessGroup(pid,200)).toBe(true);
    expect((await git(f.bare,'for-each-ref','--format=%(refname)','refs/heads')).stdout.trim()).toBe('');
  });
});
