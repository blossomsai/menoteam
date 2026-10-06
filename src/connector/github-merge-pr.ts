import type { ClaimedRun } from './types.js';

type MergeProof = { pullRequestNumber: number; pullRequestUrl: string; pullRequestNodeId: string; headSha: string; baseSha: string; mergeSha: string };
type PR = { number: number; node_id: string; html_url: string; state: string; draft: boolean; merged: boolean; head: { sha: string; repo: { full_name: string } }; base: { ref: string; sha: string; repo: { full_name: string } }; mergeable: boolean | null; mergeable_state: string; merge_commit_sha: string | null };
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);

/** Credentials and fixed URLs belong only to this parent executor. Reads reconcile; only gates authorize effects. */
export async function mergePullRequest(claim: ClaimedRun, authorize: () => Promise<void>, fetcher: typeof fetch = fetch, beforeWrite: (phase: 'ready_intent'|'merge_intent')=>Promise<void> = async()=>{}): Promise<MergeProof> {
  const run = claim.run, op = run.operation;
  if (run.kind !== 'delivery' || !op || op.action !== 'merge_pr' || !op.priorDeliveryRunId || !op.reviewRunId || !op.external?.pullRequestNumber || !op.external.pullRequestUrl || !op.external.pullRequestNodeId || op.external.headSha !== op.commitSha || !sha(op.integrationBaseSha) || op.external.baseSha !== op.integrationBaseSha || op.mergeMethod !== 'merge' || !op.policySnapshot?.requiredChecks.length) throw new Error('Merge operation is unavailable');
  const token = process.env.MENOTEAM_GITHUB_TOKEN;
  if (!token) throw new Error('GitHub write capability is unavailable');
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(op.repositoryUrl);
  if (!match) throw new Error('Configured GitHub repository URL is invalid');
  const repo = `${match[1]}/${match[2]}`, api = `https://api.github.com/repos/${repo}`;
  const headers = { accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'menoteam-workbench', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}` };
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(path === '/graphql' ? 'https://api.github.com/graphql' : `${api}${path}`, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (path.includes('/check-runs?') && /rel="next"/u.test(response.headers.get('link') ?? '')) throw new Error('Required CI response is incomplete');
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response.json() as Promise<T>;
  };
  const readPr = async () => {
    const pr = await request<PR>(`/pulls/${op.external!.pullRequestNumber}`);
    if (pr.number !== op.external!.pullRequestNumber || pr.node_id !== op.external!.pullRequestNodeId || pr.html_url !== op.external!.pullRequestUrl || pr.base.ref !== op.baseBranch || pr.head.sha !== op.commitSha || pr.base.repo.full_name !== repo || pr.head.repo.full_name !== repo) throw new Error('Current pull request no longer matches the frozen receipt');
    return pr;
  };
  const receipt = async (pr: PR): Promise<MergeProof> => {
    if (!pr.merged || !sha(pr.merge_commit_sha)) throw new Error('GitHub merge state is ambiguous');
    // Only the documented merge method is supported: exactly two parents, saved integration base then candidate.
    const commit = await request<{ sha: string; parents: Array<{sha:string}> }>(`/git/commits/${pr.merge_commit_sha}`);
    if (commit.sha !== pr.merge_commit_sha || commit.parents.length !== 2 || commit.parents[0]?.sha !== op.integrationBaseSha || commit.parents[1]?.sha !== op.commitSha) throw new Error('Actual merge commit does not prove the frozen base and fixed merge method');
    const branch = await request<{commit:{sha:string}}>(`/branches/${encodeURIComponent(op.baseBranch)}`);
    const ancestry = await request<{status:string; merge_base_commit:{sha:string}}>(`/compare/${pr.merge_commit_sha}...${branch.commit.sha}`);
    if (!['identical','ahead'].includes(ancestry.status) || ancestry.merge_base_commit.sha !== pr.merge_commit_sha) throw new Error('Actual merge commit is not an ancestor of the target branch');
    return { pullRequestNumber: pr.number, pullRequestUrl: pr.html_url, pullRequestNodeId: pr.node_id, headSha: op.commitSha, baseSha: op.integrationBaseSha!, mergeSha: pr.merge_commit_sha };
  };
  const gates = async () => {
    await authorize(); // server reloads actor, membership, connector, lease and immutable policy version
    const pr = await readPr();
    const graph = await request<{errors?:unknown[];data?:{node?:{id:string;isDraft:boolean;headRefOid:string;baseRefOid:string;baseRefName:string;mergeable:string;mergeStateStatus:string}}}>('/graphql',{method:'POST',body:JSON.stringify({query:'query MergeState($id: ID!) { node(id: $id) { ... on PullRequest { id isDraft headRefOid baseRefOid baseRefName mergeable mergeStateStatus } } }',variables:{id:op.external!.pullRequestNodeId}})});
    const state=graph.data?.node;
    if(graph.errors?.length||!state||state.id!==op.external!.pullRequestNodeId||state.headRefOid!==op.commitSha||state.baseRefOid!==op.integrationBaseSha||state.baseRefName!==op.baseBranch||state.isDraft!==pr.draft||state.mergeable!=='MERGEABLE'||(pr.draft?state.mergeStateStatus!=='DRAFT':state.mergeStateStatus!=='CLEAN'))throw new Error('Documented GitHub merge state is missing, changed, blocked or unknown');
    if (pr.state !== 'open' || pr.merged || pr.base.sha !== op.integrationBaseSha) throw new Error('Current integration base changed; refreshed candidate/review/receipt required');
    const protection = await request<{ required_status_checks?: { strict?: boolean; contexts?: string[]; checks?: Array<{context:string;app_id:number|null}> } | null; enforce_admins?: {enabled?:boolean}; required_pull_request_reviews?: { bypass_pull_request_allowances?: {apps?:unknown[];teams?:unknown[];users?:unknown[]} } | null }>(`/branches/${encodeURIComponent(op.baseBranch)}/protection`);
    const rules = protection.required_status_checks, required = op.policySnapshot!.requiredChecks;
    const bypass = protection.required_pull_request_reviews?.bypass_pull_request_allowances;
    if (!rules?.strict || protection.enforce_admins?.enabled !== true || (bypass && (['apps','teams','users'] as const).some(k => !Array.isArray(bypass[k]) || bypass[k]!.length > 0))) throw new Error('Strict required checks or no-bypass branch protection could not be proven');
    if (new Set(required).size !== required.length || rules.checks?.length !== required.length || rules.contexts?.length !== required.length || required.some(name => !rules.contexts?.includes(name) || !rules.checks?.some(c => c.context === name && c.app_id === 15368))) throw new Error('Required checks do not exactly match the trusted Menoteam GitHub Actions app');
    const checks = await request<{total_count:number;check_runs:Array<{name:string;status:string;conclusion:string|null;head_sha:string;app:{id:number}}> }>(`/commits/${op.commitSha}/check-runs?filter=latest&per_page=100`);
    if (!Array.isArray(checks.check_runs) || !Number.isSafeInteger(checks.total_count) || checks.check_runs.length > 100 || checks.total_count !== checks.check_runs.length || required.some(name => { const matches=checks.check_runs.filter(c=>c.name===name); return matches.length===0 || matches.some(c=>c.app?.id!==15368 || c.status!=='completed' || c.conclusion!=='success' || c.head_sha!==op.commitSha); })) throw new Error('Trusted required CI checks are missing, ambiguous, stale, or failed');
    const integration = await request<{status:string;base_commit:{sha:string};merge_base_commit:{sha:string}}>(`/compare/${op.integrationBaseSha}...${op.commitSha}`);
    if(!['identical','ahead'].includes(integration.status)||integration.base_commit.sha!==op.integrationBaseSha||integration.merge_base_commit.sha!==op.integrationBaseSha)throw new Error('Reviewed candidate is not up to date with the exact integration base');
    const branch = await request<{commit:{sha:string}}>(`/branches/${encodeURIComponent(op.baseBranch)}`);
    if (branch.commit.sha !== op.integrationBaseSha) throw new Error('Target branch no longer matches the frozen integration base');
    await authorize();
    return pr;
  };
  // Reads deliberately do not confer write permission. They may record an already in-flight effect after revocation.
  let pr = await readPr();
  if (pr.merged) { if(!['merge_intent','merged'].includes(op.phase))throw new Error('Merged PR has no saved merge intent'); return receipt(pr); }
  if (op.phase === 'merge_intent' || op.phase === 'merged') throw new Error('An earlier GitHub merge is unresolved; will not repeat it');
  if (op.phase === 'ready_intent' && pr.draft) throw new Error('An earlier ready transition is unresolved; will not repeat it');
  pr = await gates();
  if (pr.draft) {
    await beforeWrite('ready_intent');
    pr = await gates();
    try {
      const result = await request<{errors?:unknown[];data?:{markPullRequestReadyForReview?:{pullRequest?:{id:string;isDraft:boolean}}}}>('/graphql', { method:'POST', body:JSON.stringify({ query:'mutation Ready($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }', variables:{id:op.external.pullRequestNodeId} }) });
      if (result.errors?.length) throw Object.assign(new Error('GraphQL ready transition returned errors'),{code:'GRAPHQL_ERRORS'});
      if (result.data?.markPullRequestReadyForReview?.pullRequest?.id !== op.external.pullRequestNodeId || result.data.markPullRequestReadyForReview.pullRequest.isDraft !== false) throw new Error('GraphQL ready transition returned errors or invalid identity');
    } catch (error) {
      if((error as {code?:string}).code==='GRAPHQL_ERRORS')throw error;
      const actual = await readPr().catch(()=>undefined);
      if (!actual || actual.draft || actual.merged) throw new Error('Ready response lost or failed; state remains unresolved', {cause:error});
    }
    pr = await readPr();
    if (pr.draft) throw new Error('GitHub did not mark the pull request ready');
  }
  pr = await gates();
  if (pr.draft) throw new Error('Pull request is still draft');
  await beforeWrite('merge_intent');
  pr = await gates();
  if (pr.draft) throw new Error('Pull request became draft');
  try { await request(`/pulls/${pr.number}/merge`, {method:'PUT',body:JSON.stringify({sha:op.commitSha,merge_method:'merge'})}); }
  catch (error) { const actual=await readPr().catch(()=>undefined); if(!actual?.merged)throw new Error('Merge response lost; actual state remains unresolved',{cause:error}); return receipt(actual); }
  return receipt(await readPr());
}
