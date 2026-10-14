import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { discoverStagingBuild, verifyFrozenStagingBuild, StagingBuildDiscoveryError, type StagingBuildReceipt } from '../src/connector/staging-build.js';

const sha = 'a'.repeat(40);
const run = (runAttempt: number, conclusion: string | null, runNumber = 7) => ({
  id: 123, run_attempt: runAttempt, run_number: runNumber, status: conclusion ? 'completed' : 'in_progress', conclusion,
  event: 'workflow_dispatch', head_branch: 'main', head_sha: sha, path: '.github/workflows/build-workbench-image.yml',
  html_url: 'https://github.com/blossomsai/menoteam/actions/runs/123',
  repository: { id: 88, full_name: 'blossomsai/menoteam' }, head_repository: { id: 88, full_name: 'blossomsai/menoteam' },
});
const artifact = (attempt: number, id: number) => ({
  id, name: `workbench-image-receipt-attempt-${attempt}`, size_in_bytes: 1024, expired: false,
  expires_at: new Date(Date.now() + 60_000).toISOString(), digest: `sha256:${'b'.repeat(64)}`,
  workflow_run: { id: 123, repository_id: 88, head_repository_id: 88, head_sha: sha },
});
const receipt = {schemaVersion:1 as const,repository:'blossomsai/menoteam' as const,repositoryId:'88',workflowPath:'.github/workflows/build-workbench-image.yml' as const,runId:123,runAttempt:2,sourceSha:sha,imageRepository:'ghcr.io/blossomsai/menoteam-work-map' as const,imageDigest:`sha256:${'c'.repeat(64)}`};

function lookup(runs: unknown[], artifacts: unknown[], urls: string[], archive?:Buffer, attempt:unknown=run(2,'success')) {
  return async (input: string | URL | Request) => {
    const url = String(input);urls.push(url);
    if (url.includes('/workflows/')) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
    if (url.includes('/attempts/')) return new Response(JSON.stringify(attempt), { status: 200 });
    if (url.endsWith('/artifacts?per_page=100')) return new Response(JSON.stringify({ artifacts }), { status: 200 });
    if(archive&&url.endsWith('/artifacts/456/zip'))return new Response(new Uint8Array(archive),{status:200});
    throw new Error('Unexpected artifact download');
  };
}

async function zipped(contents=JSON.stringify(receipt),kind:'file'|'symlink'|'nested'='file'){
  const directory=await mkdtemp(path.join(os.tmpdir(),'menoteam-build-zip-test-'));
  try{
    const filename=kind==='nested'?'other.json':'workbench-image-receipt.json';
    if(kind==='symlink')await symlink(contents,path.join(directory,filename));
    else await writeFile(path.join(directory,filename),contents);
    await promisify(execFileCb)('zip',['-q','-y','receipt.zip',filename],{cwd:directory,env:{PATH:'/usr/bin:/bin'}});
    const archive=await readFile(path.join(directory,'receipt.zip'));
    const metadata={...artifact(2,456),size_in_bytes:archive.length,digest:`sha256:${createHash('sha256').update(archive).digest('hex')}`};
    return {archive,metadata};
  }finally{await rm(directory,{recursive:true,force:true});}
}

describe('fixed staging build discovery', () => {
  it('does not rescue a failed latest attempt with an earlier successful attempt', async () => {
    const urls: string[] = [];
    await expect(discoverStagingBuild(sha, lookup([run(1, 'success'), run(2, 'failure')], [artifact(1, 456)], urls) as typeof fetch, 'token'))
      .rejects.toMatchObject({ status: 'failed' } satisfies Partial<StagingBuildDiscoveryError>);
    expect(urls.some(url => url.includes('/artifacts?'))).toBe(false);
  });

  it('ignores a prior attempt artifact when the current successful attempt has no receipt', async () => {
    const urls: string[] = [];
    await expect(discoverStagingBuild(sha, lookup([run(2, 'success')], [artifact(1, 456)], urls) as typeof fetch, 'token'))
      .rejects.toMatchObject({ status: 'receipt_missing' } satisfies Partial<StagingBuildDiscoveryError>);
    expect(urls).toHaveLength(2);
  });

  it('rejects duplicate receipt artifacts for the current attempt', async () => {
    const urls: string[] = [];
    await expect(discoverStagingBuild(sha, lookup([run(2, 'success')], [artifact(2, 456), artifact(2, 457)], urls) as typeof fetch, 'token'))
      .rejects.toMatchObject({ status: 'receipt_missing' } satisfies Partial<StagingBuildDiscoveryError>);
    expect(urls).toHaveLength(2);
  });

  it.each([
    {...run(1,'success'),head_repository:{id:99,full_name:'fork/menoteam'}},
    {...run(1,'success'),path:'.github/workflows/foreign.yml'},
    {...run(1,'success'),head_sha:'d'.repeat(40)},
  ])('filters out a run from a different workflow, source, or repository', async foreign => {
    const urls: string[] = [];
    await expect(discoverStagingBuild(sha, lookup([foreign], [], urls) as typeof fetch, 'token'))
      .rejects.toMatchObject({ status: 'unavailable' } satisfies Partial<StagingBuildDiscoveryError>);
    expect(urls).toHaveLength(1);
  });

  it('reads a bounded native ZIP and freezes the attempt, artifact, archive, and image identities',async()=>{
    const {archive,metadata}=await zipped();const urls:string[]=[];
    const frozen=await discoverStagingBuild(sha,lookup([run(2,'success')],[metadata],urls,archive) as typeof fetch,'token');
    expect(frozen).toEqual({...receipt,artifactId:456,archiveDigest:metadata.digest,artifactExpiresAt:metadata.expires_at,runUrl:run(2,'success').html_url});
    urls.length=0;
    await verifyFrozenStagingBuild(frozen,lookup([run(3,'failure')],[metadata],urls,archive) as typeof fetch,'token');
    expect(urls).toEqual(['https://api.github.com/repos/blossomsai/menoteam/actions/runs/123/attempts/2','https://api.github.com/repos/blossomsai/menoteam/actions/runs/123/artifacts?per_page=100','https://api.github.com/repos/blossomsai/menoteam/actions/artifacts/456/zip']);
  });

  it.each(['symlink','nested'] as const)('rejects a %s receipt archive without extracting filesystem paths',async kind=>{
    const {archive,metadata}=await zipped(JSON.stringify(receipt),kind);
    await expect(discoverStagingBuild(sha,lookup([run(2,'success')],[metadata],[],archive) as typeof fetch,'token')).rejects.toMatchObject({status:'receipt_missing'});
  });

  it.each([JSON.stringify({...receipt,sourceSha:'d'.repeat(40)}),'{broken', 'x'.repeat(5000)])('rejects a wrong-source, malformed, or decompression-oversized receipt',async contents=>{
    const {archive,metadata}=await zipped(contents);
    await expect(discoverStagingBuild(sha,lookup([run(2,'success')],[metadata],[],archive) as typeof fetch,'token')).rejects.toMatchObject({status:'receipt_missing'});
  });

  it('rejects an expired artifact before download and an archive digest replacement',async()=>{
    const {archive,metadata}=await zipped();const urls:string[]=[];
    await expect(discoverStagingBuild(sha,lookup([run(2,'success')],[{...metadata,expired:true}],urls,archive) as typeof fetch,'token')).rejects.toMatchObject({status:'receipt_expired'});
    expect(urls).toHaveLength(2);
    await expect(discoverStagingBuild(sha,lookup([run(2,'success')],[{...metadata,digest:`sha256:${'b'.repeat(64)}`}],[],archive) as typeof fetch,'token')).rejects.toMatchObject({status:'receipt_missing'});
  });

  it('rejects a changed frozen attempt or artifact without selecting a newer run',async()=>{
    const {archive,metadata}=await zipped();
    const frozen:StagingBuildReceipt={...receipt,artifactId:456,archiveDigest:metadata.digest,artifactExpiresAt:metadata.expires_at,runUrl:run(2,'success').html_url};const urls:string[]=[];
    await expect(verifyFrozenStagingBuild(frozen,lookup([], [metadata],urls,archive,run(3,'success')) as typeof fetch,'token')).rejects.toMatchObject({status:'receipt_missing'});
    expect(urls).toHaveLength(1);
    await expect(verifyFrozenStagingBuild(frozen,lookup([], [{...metadata,digest:`sha256:${'b'.repeat(64)}`}],[],archive) as typeof fetch,'token')).rejects.toMatchObject({status:'receipt_expired'});
  });

  it('aborts the in-flight HTTP lookup before artifact extraction',async()=>{
    const controller=new AbortController();let started!:()=>void;const gate=new Promise<void>(resolve=>{started=resolve;});
    const fetcher=async(_input:unknown,init?:RequestInit)=>{started();return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('lookup aborted')),{once:true});});};
    const pending=discoverStagingBuild(sha,fetcher as typeof fetch,'token',controller.signal);await gate;controller.abort();
    await expect(pending).rejects.toMatchObject({status:'unavailable'});
  });
});
