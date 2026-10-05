import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createDiff, diffRevision, fingerprint, git, gitWithEnv, readWorktreeMap } from './git.js';
import type { ConnectorConfig } from './types.js';
import type { ClaimedRun } from './types.js';

type DeliveryRun = ClaimedRun['run'] & { operation: NonNullable<ClaimedRun['run']['operation']> };
export interface DraftPullRequest { number:number; url:string; headSha:string; }

const repoIdentity=(value:string)=>{
  const match=/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(value);
  if(!match)throw new Error('Configured GitHub repository URL is invalid');
  return {owner:match[1]!,repo:match[2]!};
};

/** Publishes only an immutable saved candidate; all remote effects are explicit and retry-reconciled. */
export async function createDraftPullRequest(config:ConnectorConfig,claim:ClaimedRun,fetcher:typeof fetch=fetch,onPhase?:(value:{phase:'published'|'pr_created';remoteHeadSha?:string;pullRequestNumber?:number;pullRequestUrl?:string;headSha?:string})=>Promise<void>,beforeEffect?:()=>Promise<void>):Promise<DraftPullRequest>{
  const run=claim.run as DeliveryRun;const op=run.operation;
  if(run.kind!=='delivery'||!op||op.action!=='create_draft_pr')throw new Error('Draft PR operation is unavailable');
  const token=process.env.MENOTEAM_GITHUB_TOKEN;if(!token)throw new Error('GitHub write capability is unavailable');
  const root=config.projects[run.projectId];if(!root)throw new Error('Project repository is not registered on this Connector');
  const map=await readWorktreeMap(config.dataDir,run.workId!);
  if(!map||!map.path||map.artifactRevision!==op.artifactRevision)throw new Error('Registered candidate checkout or artifact revision changed');
  const cwd=await realpath(map.path);const worktreeRoot=await realpath(path.join(config.dataDir,'worktrees'));
  if(!cwd.startsWith(`${worktreeRoot}${path.sep}`))throw new Error('Candidate checkout escaped the registered Work worktrees');
  const entries=(await git(root,'worktree','list','--porcelain')).split('\n').filter(line=>line.startsWith('worktree ')).map(line=>line.slice(9));
  const registered=entries.some(entry=>entry===cwd||path.resolve(entry)===cwd);
  if(!registered)throw new Error('Candidate checkout is no longer a registered Work worktree');
  if((await git(cwd,'status','--porcelain=v1','--untracked-files=all')).trim())throw new Error('Candidate checkout is not clean');
  const head=(await git(cwd,'rev-parse','HEAD')).trim();
  if(head!==op.commitSha)throw new Error('Candidate HEAD changed');
  if(await fingerprint(cwd)!==op.candidateFingerprint)throw new Error('Candidate fingerprint changed');
  const actualDiff=await createDiff(cwd,op.baseRevision);
  if(diffRevision(actualDiff)!==op.candidateRevision||actualDiff.candidateRevision!==op.commitSha)throw new Error('Candidate diff identity changed');
  const normalizeUrl=(value:string)=>value.replace(/\.git$/u,'').replace(/\/$/u,'');
  const remote=(await git(cwd,'config','--get','remote.origin.url')).trim();
  const pushUrls=(await git(cwd,'config','--get-all','remote.origin.pushurl').catch(()=>'' )).trim().split('\n').filter(Boolean);
  if(normalizeUrl(remote)!==normalizeUrl(claim.project.repositoryUrl)||pushUrls.length>1||(pushUrls.length===1&&normalizeUrl(pushUrls[0]!)!==normalizeUrl(claim.project.repositoryUrl)))throw new Error('Candidate push URL does not match the configured project repository');
  const expectedBranch=`codex/menoteam/${run.workId}/${op.commitSha.slice(0,12)}`;
  if(op.remoteBranch!==expectedBranch||!/^[A-Za-z0-9._/-]+$/u.test(expectedBranch))throw new Error('Fixed publication branch does not match candidate identity');
  const ref=`refs/heads/${expectedBranch}`;
  const gitAuth={GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
  let remoteHead=(await gitWithEnv(cwd,gitAuth,'ls-remote','--heads','origin',ref)).trim().split(/\s+/u)[0]??'';
  if(remoteHead&&remoteHead!==op.commitSha)throw new Error('Fixed publication branch already points to a different commit');
  if(!remoteHead){await beforeEffect?.();await gitWithEnv(cwd,gitAuth,'push','origin',`${op.commitSha}:${ref}`);remoteHead=(await gitWithEnv(cwd,gitAuth,'ls-remote','--heads','origin',ref)).trim().split(/\s+/u)[0]??'';}
  if(remoteHead!==op.commitSha)throw new Error('Published branch could not be reconciled to the exact candidate SHA');
  await onPhase?.({phase:'published',remoteHeadSha:remoteHead});
  const {owner,repo}=repoIdentity(claim.project.repositoryUrl);
  const api=`https://api.github.com/repos/${owner}/${repo}`;
  const headers={accept:'application/vnd.github+json','content-type':'application/json','user-agent':'menoteam-workbench','x-github-api-version':'2022-11-28',authorization:`Bearer ${token}`};
  const request=async(url:string,init?:RequestInit)=>{const response=await fetcher(url,{...init,headers,redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(`GitHub request failed (${response.status})`);return response;};
  const marker=`<!-- menoteam-operation:${run.id} -->`;
  const find=async()=>{const url=new URL(`${api}/pulls`);url.searchParams.set('state','all');url.searchParams.set('head',`${owner}:${expectedBranch}`);url.searchParams.set('base',op.baseBranch);const rows=await (await request(url.toString())).json() as Array<{number:number;html_url:string;head:{sha:string};base:{ref:string};body:string|null;draft:boolean}>;return rows.find(pr=>(pr.body??'').includes(marker));};
  const existing=await find();
  if(existing){if(!existing.draft||existing.head.sha!==op.commitSha||existing.base.ref!==op.baseBranch)throw new Error('Existing operation PR no longer matches the draft candidate');const result={number:existing.number,url:existing.html_url,headSha:existing.head.sha};await onPhase?.({phase:'pr_created',pullRequestNumber:result.number,pullRequestUrl:result.url,headSha:result.headSha});return result;}
  const body=`## Change\n${op.workTitle}\n\n${op.changeSummary}\n\n## Verification\nQA status: ${op.qaStatus}\nCandidate SHA: ${op.commitSha}\nBase: ${op.baseBranch}\n\n${marker}`;
  await beforeEffect?.();
  const created=await (await request(`${api}/pulls`,{method:'POST',body:JSON.stringify({title:`[Draft] ${op.workTitle}`.slice(0,240),head:expectedBranch,base:op.baseBranch,body,draft:true})})).json() as {number:number;html_url:string;head:{sha:string};draft:boolean};
  if(!created.draft||created.head.sha!==op.commitSha)throw new Error('GitHub returned a PR that does not match the draft candidate');
  await onPhase?.({phase:'pr_created',pullRequestNumber:created.number,pullRequestUrl:created.html_url,headSha:created.head.sha});
  return {number:created.number,url:created.html_url,headSha:created.head.sha};
}
