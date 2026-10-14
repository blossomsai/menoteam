import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createDiff, diffRevision, fingerprint, persistWorktreeMap } from '../../src/connector/git.js';
import type { ClaimedRun, ConnectorConfig } from '../../src/connector/types.js';
const execFile=promisify(execFileCb);
const git=async(cwd:string,...args:string[])=>await execFile('git',args,{cwd,encoding:'utf8'});
const repository='https://github.com/example/project';
export async function draftFixture(temp:string){
  const root=path.join(temp,'repo');const bare=path.join(temp,'remote.git');const dataDir=path.join(temp,'connector-data');const checkout=path.join(dataDir,'worktrees','project','work');
  await mkdir(root,{recursive:true});await mkdir(dataDir,{recursive:true});
  await git(root,'init','-b','main');await git(root,'config','user.name','Local Test');await git(root,'config','user.email','local@example.test');
  await writeFile(path.join(root,'README.md'),'base\n');await git(root,'add','.');await git(root,'commit','-m','base');const base=(await git(root,'rev-parse','HEAD')).stdout.trim();
  await mkdir(bare);await git(bare,'init','--bare');await git(root,'remote','add','origin',`${repository}.git`);
  await git(root,'worktree','add','--detach',checkout,base);await writeFile(path.join(checkout,'feature.txt'),'draft me\n');await git(checkout,'add','.');await git(checkout,'-c','user.name=Local Test','-c','user.email=local@example.test','commit','-m','candidate');
  const commitSha=(await git(checkout,'rev-parse','HEAD')).stdout.trim();const diff=await createDiff(checkout,base);const candidateRevision=diffRevision(diff);const candidateFingerprint=await fingerprint(checkout);await persistWorktreeMap(dataDir,'work',{path:checkout,revision:commitSha,baseRevision:base,artifactRevision:candidateRevision});
  const run:ClaimedRun['run']={id:'delivery-1',projectId:'project',workId:'work',prompt:'',kind:'delivery',model:'internal',reasoning:'none',status:'running',generation:1,connectorId:'connector',requestedBy:'actor',createdAt:'',updatedAt:'',operation:{action:'create_draft_pr',actorId:'actor',candidateRunId:'candidate-1',candidateRevision,artifactRevision:candidateRevision,commitSha,candidateFingerprint,repositoryUrl:repository,baseRevision:base,baseBranch:'main',remoteBranch:`codex/menoteam/work/${commitSha.slice(0,12)}`,workTitle:'Example Work',changeSummary:'feature.txt',qaStatus:'1 passed, 1 failed',phase:'queued'}};
  const claim:ClaimedRun={run,project:{id:'project',name:'Project',instructions:'',repositoryUrl:repository,deliveryAuthorization:'',createdAt:''},messages:[],settings:[]};
  const config:ConnectorConfig={serverUrl:'http://localhost:4313',token:'x'.repeat(32),connectorId:'connector',dataDir,projects:{project:root}};
  const transport=async(_cwd:string,_env:NodeJS.ProcessEnv,...args:string[])=>{
    if(args[0]==='ls-remote'){const ref=args.at(-1)!;const sha=(await git(bare,'rev-parse','--verify',ref).catch(()=>({stdout:''}))).stdout.trim();return sha?`${sha}\t${ref}\n`:'';}
    if(args[0]==='push'){await git(checkout,...args.map(arg=>arg===`${repository}.git`?bare:arg));return '';}
    throw new Error(`Unexpected local transport command: ${args[0]}`);
  };
  return {root,bare,checkout,base,commitSha,claim,config,transport};
}
