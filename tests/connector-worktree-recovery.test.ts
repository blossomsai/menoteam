import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDiff, diffRevision, ensureWorktree, fingerprint, git } from '../src/connector/git.js';
import { recoverWorktree, type WorktreeRecoveryReceipt } from '../src/connector/recover-worktree.js';
import type { ConnectorConfig } from '../src/connector/types.js';

const failure=vi.hoisted(()=>({renamePath:''}));
vi.mock('node:fs/promises',async original=>{
  const actual=await original<typeof import('node:fs/promises')>();
  return {...actual,rename:async(from:string,to:string)=>{
    if(from===failure.renamePath){failure.renamePath='';throw new Error('Fixture rename failure after registration backup');}
    return actual.rename(from,to);
  }};
});

let temp='';
afterEach(async()=>{vi.restoreAllMocks();failure.renamePath='';if(temp)await rm(temp,{recursive:true,force:true});temp='';});
async function setup(){
  temp=await realpath(await mkdtemp(path.join(os.tmpdir(),'menoteam-offline-work-recovery-')));
  const root=path.join(temp,'repo'),dataDir=path.join(temp,'data');await mkdir(root);await mkdir(dataDir);
  await git(root,'init','-q');await git(root,'config','user.name','Fixture');await git(root,'config','user.email','fixture@example.invalid');
  await writeFile(path.join(root,'task.txt'),'base\n');await git(root,'add','task.txt');await git(root,'commit','-qm','base');
  const baseSha=(await git(root,'rev-parse','HEAD')).trim();
  await writeFile(path.join(root,'task.txt'),'candidate\n');await git(root,'add','task.txt');await git(root,'commit','-qm','candidate');
  const candidateSha=(await git(root,'rev-parse','HEAD')).trim();
  const config:ConnectorConfig={serverUrl:'http://127.0.0.1:1',connectorId:'fixture-connector',token:'x'.repeat(48),dataDir,projects:{project:root}};
  const tree=await ensureWorktree(config,'project','work');
  const diff=await createDiff(tree.path,baseSha),candidateFingerprint=await fingerprint(tree.path);
  // Owned detached fixture exits naturally: its exact PID/group is absent, not inferred from a missing spool.
  const child=spawn(process.execPath,['-e','process.exit(0)'],{detached:true,stdio:'ignore'});await once(child,'exit');
  const receipt:WorktreeRecoveryReceipt={projectId:'project',workId:'work',candidateSha,baseSha,artifactRevision:diffRevision(diff),candidateFingerprint,
    idleProof:{connectorId:config.connectorId,observedAt:new Date().toISOString(),globalActiveRunCount:0,futureLeaseCount:0,runId:'run-fixture',generation:1,status:'completed',knownProcesses:[{pid:child.pid!,processGroupId:child.pid!}],osScan:{observedAt:new Date().toISOString(),success:true,acceptanceCwd:tree.path,threadId:'fixture-thread',cwdMatches:0,threadMatches:0}}};
  const map=path.join(dataDir,'worktree-map','work.json');await rm(map);
  return {config,receipt,tree,root,map};
}
async function eraseCheckout(target:string){for(const name of await readdir(target))await rm(path.join(target,name),{recursive:true,force:true});}

it('restores an empty registered slot at exact candidate/base, preserves metadata, and retries idempotently',async()=>{
  const {config,receipt,tree,root,map}=await setup();await eraseCheckout(tree.path);
  await writeFile(path.join(root,'uncommitted.txt'),'keep root dirty\n');
  const result=await recoverWorktree(config,receipt);
  expect(result).toEqual({path:tree.path,revision:receipt.candidateSha,baseRevision:receipt.baseSha,artifactRevision:receipt.artifactRevision});
  expect(JSON.parse(await readFile(map,'utf8'))).toEqual(result);
  expect(await readFile(path.join(tree.path,'task.txt'),'utf8')).toBe('candidate\n');
  expect(await readFile(path.join(root,'uncommitted.txt'),'utf8')).toBe('keep root dirty\n');
  const backup=path.join(config.dataDir,'worktree-recovery','work');
  expect(await readFile(path.join(backup,'registration','HEAD'),'utf8')).toContain(receipt.candidateSha);
  expect((await lstat(path.join(backup,'intent.json'))).mode&0o077).toBe(0);
  expect(await recoverWorktree(config,receipt)).toEqual(result);
},15000);

it('can map an already exact clean registered candidate without resetting it',async()=>{
  const {config,receipt,tree,map}=await setup();
  await recoverWorktree(config,receipt);
  expect(JSON.parse(await readFile(map,'utf8')).baseRevision).toBe(receipt.baseSha);
  expect((await git(tree.path,'status','--porcelain')).trim()).toBe('');
});

it('preserves failed fingerprint evidence without a valid map, permits only the same retry binding',async()=>{
  const {config,receipt,tree,map}=await setup();await eraseCheckout(tree.path);
  const wrong={...receipt,candidateFingerprint:'0'.repeat(64)};
  await expect(recoverWorktree(config,wrong)).rejects.toThrow('fingerprint mismatch');
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(path.join(tree.path,'task.txt'),'utf8')).toBe('candidate\n');
  expect(await readFile(path.join(config.dataDir,'worktree-recovery','work','registration','HEAD'),'utf8')).toContain(receipt.candidateSha);
  await expect(recoverWorktree(config,receipt)).rejects.toThrow('retry evidence changed');
  await expect(recoverWorktree(config,wrong)).rejects.toThrow('fingerprint mismatch');
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});
});

it('rejects a live owned group, missing stop acknowledgement, stale observation and Connector mismatch before mutation',async()=>{
  const {config,receipt,tree,map}=await setup();await eraseCheckout(tree.path);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await once(child,'spawn');
  try{
    await expect(recoverWorktree(config,{...receipt,idleProof:{...receipt.idleProof,knownProcesses:[{pid:child.pid!,processGroupId:child.pid!}]}})).rejects.toThrow('still present');
  }finally{process.kill(-child.pid!,'SIGKILL');await once(child,'exit');}
  await expect(recoverWorktree(config,{...receipt,idleProof:{...receipt.idleProof,status:'interrupted'}})).rejects.toThrow('stop acknowledgement');
  await expect(recoverWorktree(config,{...receipt,idleProof:{...receipt.idleProof,observedAt:'2020-01-01T00:00:00.000Z'}})).rejects.toThrow('not fresh');
  await expect(recoverWorktree(config,{...receipt,idleProof:{...receipt.idleProof,connectorId:'other'}})).rejects.toThrow('identity mismatch');
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});expect(await readdir(tree.path)).toEqual([]);
});

it('refuses dirty or unknown contents, symlink targets, foreign maps and different/locked registration',async()=>{
  const {config,receipt,tree,map,root}=await setup();
  await writeFile(path.join(tree.path,'task.txt'),'dirty\n');await expect(recoverWorktree(config,receipt)).rejects.toThrow('dirty');
  await eraseCheckout(tree.path);await writeFile(path.join(tree.path,'unknown'),'keep');await expect(recoverWorktree(config,receipt)).rejects.toThrow('Git identity is missing');
  expect(await readFile(path.join(tree.path,'unknown'),'utf8')).toBe('keep');
  await rm(tree.path,{recursive:true});await symlink(root,tree.path);await expect(recoverWorktree(config,receipt)).rejects.toThrow('not canonical');await rm(tree.path);await mkdir(tree.path);
  await writeFile(path.join(config.dataDir,'worktree-map','other.json'),JSON.stringify({path:tree.path}));await expect(recoverWorktree(config,receipt)).rejects.toThrow('another Work');await rm(path.join(config.dataDir,'worktree-map','other.json'));
  await git(root,'worktree','lock',tree.path);await expect(recoverWorktree(config,receipt)).rejects.toThrow('locked');await git(root,'worktree','unlock',tree.path);
  await expect(recoverWorktree(config,{...receipt,candidateSha:receipt.baseSha})).rejects.toThrow('different identity');
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});
});

it('requires exact refs, safe identifiers and canonical configured repositories',async()=>{
  const {config,receipt,root,map}=await setup();
  await expect(recoverWorktree(config,{...receipt,candidateSha:'HEAD'})).rejects.toThrow();
  await expect(recoverWorktree(config,{...receipt,workId:'../escape'})).rejects.toThrow();
  const link=path.join(temp,'repo-link');await symlink(root,link);
  await expect(recoverWorktree({...config,projects:{project:link}},receipt)).rejects.toThrow('canonical');
  await expect(recoverWorktree(config,{...receipt,baseSha:receipt.candidateSha,candidateSha:receipt.baseSha})).rejects.toThrow();
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});
});


it('reuses a complete original registration backup after an actual boundary failure',async()=>{
  const {config,receipt,tree,map}=await setup();await eraseCheckout(tree.path);
  failure.renamePath=tree.path;
  await expect(recoverWorktree(config,receipt)).rejects.toThrow('Fixture rename failure');
  const backup=path.join(config.dataDir,'worktree-recovery','work','registration');
  const original=await readFile(path.join(backup,'HEAD'),'utf8');
  expect(original).toContain(receipt.candidateSha);expect(await readdir(tree.path)).toEqual([]);
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});
  await recoverWorktree(config,receipt);
  expect(await readFile(path.join(backup,'HEAD'),'utf8')).toBe(original);
  expect(JSON.parse(await readFile(map,'utf8')).artifactRevision).toBe(receipt.artifactRevision);
});

it('rejects altered registration backups without overwriting or deleting them',async()=>{
  const {config,receipt,tree,map}=await setup();await eraseCheckout(tree.path);
  failure.renamePath=tree.path;await expect(recoverWorktree(config,receipt)).rejects.toThrow('Fixture rename failure');
  const head=path.join(config.dataDir,'worktree-recovery','work','registration','HEAD');await writeFile(head,'unknown backup contents');
  await expect(recoverWorktree(config,receipt)).rejects.toThrow('backup differs');
  expect(await readFile(head,'utf8')).toBe('unknown backup contents');
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});expect(await readdir(tree.path)).toEqual([]);
});

it('rejects symlinked registration ancestors before reading or copying outside metadata',async()=>{
  const {config,receipt,tree,root,map}=await setup();await eraseCheckout(tree.path);
  const adminRoot=path.join(root,'.git','worktrees'),outside=path.join(temp,'outside-registration');
  await rename(adminRoot,outside);await symlink(outside,adminRoot);
  await expect(recoverWorktree(config,receipt)).rejects.toThrow('ancestor is not canonical');
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});expect(await readdir(tree.path)).toEqual([]);
  expect(await readdir(outside)).toHaveLength(1);
});

it('accepts only equivalent complete maps independent of JSON property ordering',async()=>{
  const {config,receipt,tree,map}=await setup();const result=await recoverWorktree(config,receipt);
  await writeFile(map,JSON.stringify({artifactRevision:result.artifactRevision,baseRevision:result.baseRevision,revision:result.revision,path:result.path}));
  expect(await recoverWorktree(config,receipt)).toEqual(result);
  await writeFile(map,JSON.stringify({...result,unexpected:'no'}));
  await expect(recoverWorktree(config,receipt)).rejects.toThrow('mapping conflicts');
  expect((await git(tree.path,'status','--porcelain')).trim()).toBe('');
});


it('rejects non-idle DB or unsuccessful, nonzero, missing and stale OS observations without mutation',async()=>{
  const {config,receipt,tree,map}=await setup();await eraseCheckout(tree.path);
  const proof=receipt.idleProof;
  await expect(recoverWorktree(config,{...receipt,idleProof:{...proof,osScan:{...proof.osScan,acceptanceCwd:config.dataDir}}})).rejects.toThrow('exact Work target');
  for(const changes of [{globalActiveRunCount:1},{futureLeaseCount:1},{knownProcesses:[]},
    {osScan:{...proof.osScan,success:false}}, {osScan:{...proof.osScan,cwdMatches:1}},
    {osScan:{...proof.osScan,threadMatches:1}}, {osScan:undefined}]){
    await expect(recoverWorktree(config,{...receipt,idleProof:{...proof,...changes}} as WorktreeRecoveryReceipt)).rejects.toThrow();
  }
  for(const observedAt of ['2020-01-01T00:00:00.000Z',new Date(Date.now()+60_000).toISOString()])
    await expect(recoverWorktree(config,{...receipt,idleProof:{...proof,osScan:{...proof.osScan,observedAt}}})).rejects.toThrow('not fresh');
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});expect(await readdir(tree.path)).toEqual([]);
});

it('rejects permission-unknown known PIDs and rechecks references before writing a valid map',async()=>{
  const {config,receipt,map}=await setup(),saved=receipt.idleProof.knownProcesses[0]!;
  const actual=process.kill.bind(process);
  const check=vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
    if(pid===saved.pid&&signal===0)throw Object.assign(new Error('Unknown permission'),{code:'EPERM'});
    return actual(pid,signal);
  });
  await expect(recoverWorktree(config,receipt)).rejects.toMatchObject({code:'EPERM'});
  await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});
  let calls=0;
  check.mockImplementation((pid,signal)=>{
    if(pid===saved.pid&&signal===0){if(++calls===2)throw Object.assign(new Error('Unknown second observation'),{code:'EPERM'});throw Object.assign(new Error('Absent'),{code:'ESRCH'});}
    return actual(pid,signal);
  });
  await expect(recoverWorktree(config,receipt)).rejects.toMatchObject({code:'EPERM'});
  expect(calls).toBe(2);await expect(readFile(map)).rejects.toMatchObject({code:'ENOENT'});
});
