import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectorConfig, DiffArtifactData, DiffFile, DiffLine } from './types.js';

const DIFF_LIMIT = 280_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface GitDiagnostic {
  command: string; code: string; elapsedMs: number; timeoutMs: number; stdoutBytes: number; stderrBytes: number; pid?: number;
}
export class GitCommandError extends Error {
  readonly code?: string;
  constructor(error:Error,readonly git:GitDiagnostic){super(error.message,{cause:error});this.code=(error as NodeJS.ErrnoException).code;}
}
function gitCommandCategory(args:string[]):string{
  const command=args.find(arg=>['rev-parse','worktree','status','add','commit','diff','ls-files','config','push','ls-remote','fetch'].includes(arg));
  if(command==='rev-parse')return args.includes('--show-toplevel')?'repository-root':args.includes('--verify')?'base-revision':'head-revision';
  if(command==='worktree')return args.includes('add')?'worktree-add':'worktree-list';
  if(command==='diff')return args.includes('--binary')?'diff-preview':args.includes('--name-status')?'diff-names':args.includes('--numstat')?'diff-stats':'diff';
  return command??'other';
}

export interface GitOptions {
  signal?: AbortSignal; timeoutMs?: number;
  processTracking?: { intent:(id:string)=>Promise<void>; started:(id:string,pid:number)=>Promise<void>; stopped:(id:string)=>Promise<void> };
}
const activeGit = new WeakMap<AbortSignal, Set<Promise<unknown>>>();

/** Wait for this run's owned Git groups, including cancellation cleanup. */
export async function waitForGit(signal: AbortSignal): Promise<void> {
  await Promise.all([...(activeGit.get(signal) ?? [])].map(task=>task.catch(error=>{
    if((error as NodeJS.ErrnoException).code==='EUNCONFIRMEDPROCESS')throw error;
  })));
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWithEnv(cwd, {}, args);
}
async function waitGitProcessGroup(pid:number,timeoutMs:number):Promise<boolean>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){try{process.kill(-pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;}await new Promise(resolve=>setTimeout(resolve,40));}
  try{process.kill(-pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
}
export async function gitWithEnv(cwd:string,env:NodeJS.ProcessEnv,args:string[],onProcessStart?:(pid:number)=>Promise<void>,onProcessStop?:()=>Promise<void>,timeoutMs=30_000,signal?:AbortSignal):Promise<string>{
  return (await executeGit(cwd,env,args,{timeoutMs,signal},onProcessStart,onProcessStop)).output;
}
function runGit(cwd:string,args:string[],options:GitOptions):Promise<string>{
  return executeGit(cwd,{},args,options).then(result=>result.output);
}
function executeGit(cwd:string,env:NodeJS.ProcessEnv,args:string[],options:GitOptions,onProcessStart?:(pid:number)=>Promise<void>,onProcessStop?:()=>Promise<void>,truncate=false):Promise<{output:string;truncated:boolean}>{
  const {signal,timeoutMs=30_000}=options;
  signal?.throwIfAborted();
  if(process.platform==='win32')throw new Error('Bounded Connector Git requires process-group signals');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('Git deadline must be finite and positive');
  const id=randomUUID();
  const task=(async()=>{
    await options.processTracking?.intent(id);
    if(signal?.aborted){await options.processTracking?.stopped(id);signal.throwIfAborted();}
    return new Promise<{output:string;truncated:boolean}>((resolve,reject)=>{
    const startedAt=Date.now();
    const child=spawn('git',args,{cwd,detached:true,stdio:['ignore','pipe','pipe'],shell:false,env:{...process.env,...env}});
    const stdout:Buffer[]=[];let bytes=0;let captured=0;let stderrBytes=0;let stderr='';let timedOut=false;let oversized=false;let aborted=false;let startError:Error|undefined;let processError:Error|undefined;let startTask:Promise<void>|undefined;let settled=false;let stopTimer:NodeJS.Timeout|undefined;
    const killGroup=()=>{if(child.pid){try{process.kill(-child.pid,'SIGKILL');return;}catch{/* fall back to the direct child */}}child.kill('SIGKILL');};
    const unconfirmed=()=>Object.assign(new Error('Git process group could not be confirmed stopped'),{code:'EUNCONFIRMEDPROCESS'});
    const settle=(error?:Error,result?:{output:string;truncated:boolean})=>{
      if(settled)return;settled=true;clearTimeout(timer);if(stopTimer)clearTimeout(stopTimer);signal?.removeEventListener('abort',abort);
      if(error){
        const code=(error as NodeJS.ErrnoException).code;
        const safeCode=['ABORT_ERR','ETIMEDOUT','ENOBUFS','EUNCONFIRMEDPROCESS','ENOENT','EACCES','EPERM'].includes(code??'')?code!:/^\d+$/u.test(code??'')?'GIT_EXIT':'LIFECYCLE_ERROR';
        reject(new GitCommandError(error,{command:gitCommandCategory(args),code:safeCode,elapsedMs:Date.now()-startedAt,timeoutMs,stdoutBytes:bytes,stderrBytes,...(child.pid?{pid:child.pid}:{})}));
      }else resolve(result!);
    };
    const terminate=()=>{
      killGroup();
      // SIGKILL may itself be delayed by the OS; retain reservation rather than wait forever or claim stop.
      stopTimer??=setTimeout(()=>settle(unconfirmed()),2300);
    };
    const abort=()=>{aborted=true;terminate();};
    const timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',(chunk:Buffer)=>{
      bytes+=chunk.length;
      if(!truncate&&bytes>MAX_BUFFER){oversized=true;terminate();return;}
      const keep=truncate?chunk.subarray(0,Math.max(0,DIFF_LIMIT-captured)):chunk;
      if(keep.length){stdout.push(keep);captured+=keep.length;}
    });
    child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderr.length<4096)stderr+=chunk.toString('utf8').slice(0,4096-stderr.length);});
    if(onProcessStart||options.processTracking)child.once('spawn',()=>{startTask=Promise.resolve().then(async()=>{await options.processTracking?.started(id,child.pid!);await onProcessStart?.(child.pid!);}).catch(error=>{startError=error instanceof Error?error:new Error('Could not record Git transport process');terminate();});});
    child.once('error',error=>{processError=error;terminate();});
    child.once('close',(code,exitSignal)=>{clearTimeout(timer);void (async()=>{
      if(settled)return;
      if(startTask)await startTask;
      if(child.pid&&!await waitGitProcessGroup(child.pid,100)){
        killGroup();
        if(!await waitGitProcessGroup(child.pid,2000))throw unconfirmed();
      }
      await options.processTracking?.stopped(id);
      await onProcessStop?.();
      if(startError)throw startError;
      if(processError)throw processError;
      if(aborted||timedOut||oversized){const error=new Error(aborted?'Git command cancelled':'Git command exceeded its time or output limit') as NodeJS.ErrnoException;error.code=aborted?'ABORT_ERR':timedOut?'ETIMEDOUT':'ENOBUFS';throw error;}
      if(code!==0){const error=new Error(`Git command failed (${code??exitSignal??'unknown'}): ${stderr.trim().slice(0,500)}`) as NodeJS.ErrnoException;error.code=String(code??exitSignal??'UNKNOWN');throw error;}
      return {output:Buffer.concat(stdout).toString('utf8'),truncated:truncate&&bytes>DIFF_LIMIT};
    })().then(result=>{if(result)settle(undefined,result);},error=>settle(error));});
    });
  })();
  if(signal){
    let tasks=activeGit.get(signal);if(!tasks){tasks=new Set();activeGit.set(signal,tasks);}tasks.add(task);
    const remove=()=>tasks.delete(task);void task.then(remove,error=>{if((error as NodeJS.ErrnoException).code!=='EUNCONFIRMEDPROCESS')remove();});
  }
  return task;
}

export interface Worktree { path: string; revision: string; baseRevision: string; artifactRevision?: string; }

/** Worktrees are based only on committed refs. Existing dirty checkout files are never copied implicitly. */
export async function ensureWorktree(config: ConnectorConfig, projectId: string, workId: string, baseRef = 'HEAD', options: GitOptions = {}): Promise<Worktree> {
  options.signal?.throwIfAborted();
  const configured = config.projects[projectId];
  if (!configured) throw new Error(`No local repository is configured for project ${projectId}`);
  const root = await realpath(configured);
  const dataDir = path.resolve(config.dataDir);
  if (dataDir === root || dataDir.startsWith(`${root}${path.sep}`)) throw new Error('Connector data directory must be outside project repositories');
  const commonDir = (await runGit(root, ['rev-parse', '--show-toplevel'], options)).trim();
  if (await realpath(commonDir) !== root) throw new Error('Configured repository path must be its canonical worktree root');
  const target = path.join(dataDir, 'worktrees', projectId, workId);
  const stateFile = path.join(dataDir, 'worktree-map', `${encodeURIComponent(workId)}.json`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const existing = await realpath(target);
    const registered = (await runGit(root, ['worktree', 'list', '--porcelain'], options)).split(/\n/u).some(line => line === `worktree ${existing}`);
    if (!registered || !existing.startsWith(`${path.join(dataDir, 'worktrees')}${path.sep}`)) throw new Error('Existing worktree mapping is not a registered connector worktree');
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as Worktree;
    if (saved.path !== existing || !/^[a-f0-9]{40,64}$/u.test(saved.baseRevision)) throw new Error('Saved Work mapping does not match the registered local worktree');
    return { ...saved, revision: (await runGit(existing, ['rev-parse', 'HEAD'], options)).trim() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const revision = (await runGit(root, ['rev-parse', '--verify', `${baseRef}^{commit}`], options)).trim();
  // Checking out a large repository gets more time than metadata commands, while remaining bounded.
  await runGit(root, ['worktree', 'add', '--detach', target, revision], { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  const actual = await realpath(target);
  const result = { path: actual, revision, baseRevision: revision };
  options.signal?.throwIfAborted();
  await persistWorktreeMap(dataDir, workId, result);
  return result;
}

export async function fingerprint(cwd: string, options: GitOptions = {}): Promise<string> {
  const root = path.resolve(cwd);
  const files = [...new Set((await runGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], options)).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    options.signal?.throwIfAborted();
    const absolute = path.resolve(cwd, file);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Indexed path escaped the worktree');
    let metadata;
    try { metadata = await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let contentHash: string;
    if (metadata.isSymbolicLink()) contentHash = createHash('sha256').update(`symlink:${await readlink(absolute)}`).digest('hex');
    else if (metadata.isFile()) {
      const fileHash = createHash('sha256');
      for await (const chunk of createReadStream(absolute, { signal: options.signal })) fileHash.update(chunk as Buffer);
      contentHash = fileHash.digest('hex');
    } else contentHash = 'unsupported-file-kind';
    hash.update(`${file}\0${metadata.mode & 0o111}\0${metadata.isSymbolicLink() ? 'link' : metadata.isFile() ? 'file' : 'other'}\0${contentHash}\0`);
  }
  return hash.digest('hex');
}

export async function checkpoint(cwd: string, message: string, options: GitOptions = {}): Promise<string> {
  const before = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], options);
  if (!before.trim()) return (await runGit(cwd, ['rev-parse', 'HEAD'], options)).trim();
  await runGit(cwd, ['add', '-A', '--'], options);
  await runGit(cwd, ['-c','user.name=Menoteam Connector','-c','user.email=connector@localhost','commit','-m',message.slice(0,160)], options);
  return (await runGit(cwd, ['rev-parse', 'HEAD'], options)).trim();
}

export async function createDiff(cwd: string, baseRevision: string, options: GitOptions = {}): Promise<DiffArtifactData> {
  if (!/^[a-f0-9]{40,64}$/u.test(baseRevision)) throw new Error('Diff base revision is invalid');
  const candidateRevision = (await runGit(cwd, ['rev-parse', 'HEAD'], options)).trim();
  const names = await runGit(cwd, ['diff', '--name-status', '-z', '--find-renames', `${baseRevision}..HEAD`, '--'], options);
  const paths: Array<{ path: string; oldPath?: string; status: DiffFile['status'] }> = [];
  const nameParts = names.split('\0');
  for (let i = 0; i < nameParts.length;) {
    const code = nameParts[i++]; if (!code) continue;
    const first = nameParts[i++];
    const second = code.startsWith('R') || code.startsWith('C') ? nameParts[i++] : undefined;
    const state = code?.startsWith('R') ? 'renamed' : code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    paths.push(state === 'renamed' ? { path: second!, oldPath: first!, status: state } : { path: first!, status: state });
  }
  const bounded = await boundedDiff(cwd, ['diff', '--find-renames', '--binary', '--no-ext-diff', '-U0', `${baseRevision}..${candidateRevision}`, '--'], options);
  const patch = bounded.patch;
  const patchStats = await runGit(cwd, ['diff', '--numstat', '-z', '--no-renames', `${baseRevision}..${candidateRevision}`, '--'], options);
  let totalAdditions = 0; let totalDeletions = 0;
  for (const row of patchStats.split('\0')) {
    const first = row.indexOf('\t'); if (first < 0) continue;
    const second = row.indexOf('\t', first + 1); if (second < 0) continue;
    totalAdditions += Number(row.slice(0, first)) || 0; totalDeletions += Number(row.slice(first + 1, second)) || 0;
  }
  const files: DiffFile[] = [];
  const sections = patch.split(/(?=^diff --git )/mu).filter(section => section.startsWith('diff --git '));
  for (let index = 0; index < Math.min(sections.length, paths.length); index++) {
    const { path: displayPath, oldPath, status: state } = paths[index]!;
    const filePatch = sections[index]!;
    const binary = filePatch.includes('Binary files ') || filePatch.includes('GIT binary patch');
    const hunks: DiffFile['hunks'] = [];
    let current: DiffFile['hunks'][number] | undefined;
    let oldLine = 0; let newLine = 0;
    for (const line of filePatch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(line);
      if (hunk) { current = { header: line, lines: [] }; hunks.push(current); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
      if (!current || line.startsWith('\\ No newline')) continue;
      const type = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : line.startsWith(' ') ? 'context' : undefined;
      if (!type) continue;
      const item: DiffLine = { type, text: line.slice(1) };
      if (type !== 'add') item.oldLine = oldLine++;
      if (type !== 'remove') item.newLine = newLine++;
      current.lines.push(item);
    }
    const add = filePatch.match(/^\+(?!\+).*$/gmu)?.length ?? 0;
    const del = filePatch.match(/^-(?!--).*$/gmu)?.length ?? 0;
    files.push({ path: displayPath, ...(oldPath ? { oldPath } : {}), status: state, binary, additions: binary ? null : add, deletions: binary ? null : del, hunks });
  }
  return { source: 'git', baseRevision, candidateRevision, files, additions: totalAdditions, deletions: totalDeletions, totalFiles: paths.length, patch, truncated: bounded.truncated || files.length < paths.length };
}

export async function persistWorktreeMap(dataDir: string, workId: string, worktree: Worktree): Promise<void> {
  const dir = path.join(dataDir, 'worktree-map'); await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${encodeURIComponent(workId)}.json`); const temp = `${file}.${process.pid}.tmp`;
  let prior: Partial<Worktree> = {};
  try { prior = JSON.parse(await readFile(file, 'utf8')) as Partial<Worktree>; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(temp, JSON.stringify({ ...prior, ...worktree, baseRevision: prior.baseRevision ?? worktree.baseRevision }), { mode: 0o600 }); await rename(temp, file);
}

export async function readWorktreeMap(dataDir: string, workId: string): Promise<Worktree | undefined> {
  const file = path.join(dataDir, 'worktree-map', `${encodeURIComponent(workId)}.json`);
  try { return JSON.parse(await readFile(file, 'utf8')) as Worktree; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function diffRevision(diff: DiffArtifactData): string {
  return createHash('sha256').update(diff.baseRevision).update('\0').update(diff.candidateRevision).digest('hex');
}

async function boundedDiff(cwd: string, args: string[], options: GitOptions): Promise<{ patch: string; truncated: boolean }> {
  const result=await executeGit(cwd,{},args,options,undefined,undefined,true);
  return {patch:result.output,truncated:result.truncated};
}
