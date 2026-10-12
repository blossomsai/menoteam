import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { waitProcessGroup } from './codex.js';
import { createDiff, diffRevision, fingerprint, gitWithEnv, persistWorktreeMap, type GitOptions, type Worktree } from './git.js';
import { writeSecureJson } from './state.js';
import type { ConnectorConfig } from './types.js';

const id = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const processReference = z.object({pid:z.number().int().min(2),processGroupId:z.number().int().min(2)}).strict();
export const worktreeRecoveryReceipt = z.object({
  projectId:id,workId:id,candidateSha:sha,baseSha:sha,artifactRevision:hash,candidateFingerprint:hash,
  // Operator observations, not signed authorization or a replacement for server stop acknowledgement.
  idleProof:z.object({
    connectorId:id,observedAt:z.string().datetime(),globalActiveRunCount:z.literal(0),futureLeaseCount:z.literal(0),
    runId:id,generation:z.number().int().min(1),status:z.enum(['completed','failed','paused','cancelled','interrupted']),stoppedAt:z.string().datetime().optional(),
    // Known references are not a complete historical child inventory. Failed scans cannot be recorded as zero.
    knownProcesses:z.array(processReference).min(1),
    osScan:z.object({observedAt:z.string().datetime(),success:z.literal(true),acceptanceCwd:z.string().startsWith('/'),threadId:id,cwdMatches:z.literal(0),threadMatches:z.literal(0)}).strict()
  }).strict()
}).strict();
export type WorktreeRecoveryReceipt = z.infer<typeof worktreeRecoveryReceipt>;

async function metadata(file:string){try{return await lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
async function assertGone(processes:Array<z.infer<typeof processReference>>){
  for(const saved of processes){
    // No signals beyond existence checks. Live/recycled/permission-unknown PID or surviving group blocks restoration.
    try{process.kill(saved.pid,0);throw new Error('Recorded process is still present');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    if(!await waitProcessGroup(saved.processGroupId,1))throw new Error('Recorded process group stop is unconfirmed');
  }
}
async function registrationHash(directory:string):Promise<string>{
  const root=await lstat(directory);if(!root.isDirectory()||root.isSymbolicLink()||await realpath(directory)!==directory)throw new Error('Git registration metadata is not canonical');
  const digest=createHash('sha256');
  const visit=async(dir:string)=>{
    for(const name of (await readdir(dir)).sort()){
      const file=path.join(dir,name),info=await lstat(file),relative=path.relative(directory,file);
      if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw new Error('Recovery metadata contains an unknown file kind');
      digest.update(`${relative}\0${info.isDirectory()?'dir':'file'}\0`);
      if(info.isDirectory())await visit(file);else digest.update(await readFile(file));
    }
  };
  await visit(directory);return digest.digest('hex');
}

/** Offline operator-only repair. Caller must independently establish server idle/stop facts and exclude live runners. */
export async function recoverWorktree(config:ConnectorConfig,input:WorktreeRecoveryReceipt,options:GitOptions={}):Promise<Worktree>{
  const receipt=worktreeRecoveryReceipt.parse(input),proof=receipt.idleProof;
  if(proof.connectorId!==config.connectorId)throw new Error('Recovery Connector identity mismatch');
  for(const observedAt of [proof.observedAt,proof.osScan.observedAt]){
    const age=Date.now()-Date.parse(observedAt);
    if(age<0||age>300_000)throw new Error('Recovery idle or OS scan observation is not fresh');
  }
  if(proof.status!=='completed'&&!proof.stoppedAt)throw new Error('Server stop acknowledgement is required');
  await assertGone(proof.knownProcesses);
  const configured=config.projects[receipt.projectId];if(!configured)throw new Error('Recovery project is not configured');
  const root=await realpath(configured),dataDir=await realpath(config.dataDir);
  if(root!==path.resolve(configured)||dataDir!==path.resolve(config.dataDir)||dataDir===root||dataDir.startsWith(`${root}${path.sep}`))throw new Error('Recovery paths must be canonical and separate');
  const target=path.join(dataDir,'worktrees',receipt.projectId,receipt.workId);
  if(proof.osScan.acceptanceCwd!==target||path.resolve(proof.osScan.acceptanceCwd)!==target)throw new Error('Recovery OS scan does not match the exact Work target');
  const run=(cwd:string,args:string[])=>gitWithEnv(cwd,{},args,undefined,undefined,options.timeoutMs??30_000,options.signal);
  if((await run(root,['rev-parse','--show-toplevel'])).trim()!==root)throw new Error('Configured repository is not its root');
  for(const ref of [receipt.baseSha,receipt.candidateSha])if((await run(root,['rev-parse','--verify',`${ref}^{commit}`])).trim()!==ref)throw new Error('Recovery requires exact commit IDs');
  await run(root,['merge-base','--is-ancestor',receipt.baseSha,receipt.candidateSha]);
  const expected:Worktree={path:target,revision:receipt.candidateSha,baseRevision:receipt.baseSha,artifactRevision:receipt.artifactRevision};
  for(const ancestor of [path.join(dataDir,'worktrees'),path.dirname(target),target]){
    const info=await metadata(ancestor);if(info&&(info.isSymbolicLink()||!info.isDirectory()||await realpath(ancestor)!==ancestor))throw new Error('Recovery target path is not canonical');
  }
  const mapDir=path.join(dataDir,'worktree-map'),mapFile=path.join(mapDir,`${receipt.workId}.json`);
  const mapInfo=await metadata(mapDir);if(mapInfo&&(mapInfo.isSymbolicLink()||!mapInfo.isDirectory()))throw new Error('Recovery map directory is invalid');
  let prior:Worktree|undefined;
  if(mapInfo)for(const name of await readdir(mapDir)){
    const file=path.join(mapDir,name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('Recovery map contains unknown files');
    const value=JSON.parse(await readFile(file,'utf8')) as Worktree;
    if(file===mapFile){prior=value;if(Object.keys(value).length!==4||Object.entries(expected).some(([key,value])=>(prior as unknown as Record<string,unknown>)[key]!==value))throw new Error('Existing Work mapping conflicts with recovery evidence');}
    else if(value.path===target)throw new Error('Recovery target belongs to another Work mapping');
  }
  const records=(await run(root,['worktree','list','--porcelain'])).trim().split(/\n\n/u).map(block=>block.split('\n'));
  const registered=records.find(lines=>lines[0]===`worktree ${target}`);
  if(registered&&(registered.some(line=>line.startsWith('locked'))||!registered.includes(`HEAD ${receipt.candidateSha}`)||!registered.includes('detached')))throw new Error('Target registration is locked or has a different identity');
  const verify=async()=>{
    if((await run(target,['rev-parse','HEAD'])).trim()!==receipt.candidateSha||(await run(target,['status','--porcelain=v1','--untracked-files=all'])).trim())throw new Error('Recovery checkout is changed or dirty');
    if(await fingerprint(target,options)!==receipt.candidateFingerprint||diffRevision(await createDiff(target,receipt.baseSha,options))!==receipt.artifactRevision)throw new Error('Recovery diff or fingerprint mismatch');
  };
  const binding={connectorId:config.connectorId,projectId:receipt.projectId,workId:receipt.workId,...expected,candidateFingerprint:receipt.candidateFingerprint};
  const bindingHash=createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  const recoveryRoot=path.join(dataDir,'worktree-recovery'),directory=path.join(recoveryRoot,receipt.workId);
  for(const file of [recoveryRoot,directory]){const info=await metadata(file);if(info&&(info.isSymbolicLink()||!info.isDirectory()||await realpath(file)!==file))throw new Error('Recovery backup path is not canonical');}
  const intentFile=path.join(directory,'intent.json'),intent=await metadata(intentFile);
  if(intent&&(intent.isSymbolicLink()||!intent.isFile()||JSON.parse(await readFile(intentFile,'utf8')).bindingHash!==bindingHash))throw new Error('Recovery retry evidence changed');
  const targetInfo=await metadata(target),empty=!targetInfo||(await readdir(target)).length===0;
  if(!empty){
    if(!registered)throw new Error('Unknown files at recovery target');
    const gitInfo=await metadata(path.join(target,'.git'));if(!gitInfo?.isFile()||gitInfo.isSymbolicLink())throw new Error('Recovery checkout Git identity is missing');
    const gitDirText=(await readFile(path.join(target,'.git'),'utf8')).trim();
    if(!gitDirText.startsWith('gitdir: '))throw new Error('Recovery checkout Git identity is invalid');
    const common=await realpath((await run(root,['rev-parse','--path-format=absolute','--git-common-dir'])).trim());
    const admin=await realpath(path.resolve(target,gitDirText.slice(8)));
    const backlink=path.join(admin,'gitdir'),backlinkInfo=await lstat(backlink);
    if(!backlinkInfo.isFile()||backlinkInfo.isSymbolicLink()||path.dirname(admin)!==path.join(common,'worktrees')||(await readFile(backlink,'utf8')).trim()!==path.join(target,'.git'))throw new Error('Recovery checkout references another registration');
    await verify();
    await assertGone(proof.knownProcesses);
    if(!prior)await persistWorktreeMap(dataDir,receipt.workId,expected);
    return expected;
  }
  if(prior)throw new Error('Existing valid map points to missing checkout');
  // A small persistent intent/backup preserves exact metadata; it does not authenticate the caller or fence a runner.
  await mkdir(recoveryRoot,{recursive:true,mode:0o700});
  const lock=path.join(recoveryRoot,`${receipt.workId}.lock`);
  await mkdir(lock,{mode:0o700});
  try{
    await mkdir(directory,{mode:0o700,recursive:true});
    if(!intent)await writeSecureJson(intentFile,{bindingHash,binding});
    if(registered){
      const common=await realpath((await run(root,['rev-parse','--path-format=absolute','--git-common-dir'])).trim());
      const adminRoot=path.join(common,'worktrees');
      const adminRootInfo=await lstat(adminRoot);if(!adminRootInfo.isDirectory()||adminRootInfo.isSymbolicLink()||await realpath(adminRoot)!==adminRoot)throw new Error('Git registration ancestor is not canonical');
      let admin:string|undefined;
      for(const name of await readdir(adminRoot)){
        const directory=path.join(adminRoot,name),info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory()||await realpath(directory)!==directory)throw new Error('Git registration metadata is not canonical');
        const gitdir=path.join(directory,'gitdir'),gitdirInfo=await lstat(gitdir);if(!gitdirInfo.isFile()||gitdirInfo.isSymbolicLink())throw new Error('Git registration backlink is invalid');
        if((await readFile(gitdir,'utf8')).trim()===path.join(target,'.git')){if(admin)throw new Error('Ambiguous target registration');admin=directory;}
      }
      if(!admin)throw new Error('Target registration metadata missing');
      const originalHash=await registrationHash(admin),backup=path.join(directory,'registration');
      if(await metadata(backup)){if(await registrationHash(backup)!==originalHash)throw new Error('Prior registration backup differs; inspection required');}
      else{
        const pending=`${backup}.${randomUUID()}.partial`;
        await cp(admin,pending,{recursive:true,errorOnExist:true,force:false});
        if(await registrationHash(pending)!==originalHash||await registrationHash(admin)!==originalHash)throw new Error('Registration backup is incomplete or changed');
        await rename(pending,backup);
      }
      if(targetInfo)await rename(target,path.join(directory,'empty-target'));
      // Git removes only this verified absent slot. No force, broad prune or dirty deletion.
      await run(root,['worktree','remove',target]);
    }else if(targetInfo)await rename(target,path.join(directory,'empty-target'));
    await mkdir(path.dirname(target),{recursive:true,mode:0o700});
    await run(root,['worktree','add','--detach',target,receipt.candidateSha]);
    await verify();
    await assertGone(proof.knownProcesses);
    options.signal?.throwIfAborted();
    await persistWorktreeMap(dataDir,receipt.workId,expected);
    return expected;
  }finally{await rmdir(lock);}
}
