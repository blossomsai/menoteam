// @vitest-environment happy-dom
import { act, createElement, StrictMode, Suspense, startTransition, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { navigate } from '../src/workbench/web/navigation';
import { canAutoPoll, resetRateLimitCooldown, workbenchApi, type Snapshot } from '../src/workbench/web/api';
import type { Artifact } from '../src/workbench/types';
import { qaPolicyFixture, requiredQaFixture } from './helpers/local-qa-fixture';

const member = { id: 'owner', name: 'Owner', email: 'owner@example.test', role: 'owner' as const };
const project = { id: 'project', name: 'Project', instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: '' };
const commit = 'a'.repeat(40), fingerprint = 'b'.repeat(64);
function fixture(workId = 'work') {
  const work = { id: workId, projectId: project.id, title: workId, overview: 'Overview', revision: 1, status: 'in_progress' as const, profileId: '', sources: [], createdAt: '', updatedAt: '' };
  const candidateId = `candidate-${workId}`, reviewId = `review-${workId}`, policy = qaPolicyFixture(project.id);
  const diff: Artifact = { id: `diff-${workId}`, projectId: project.id, workId, runId: candidateId, kind: 'diff', revision: 'revision', createdAt: '2026-01-01', data: { candidateRevision: commit, files: [], totalFiles: 0, truncated: false } };
  const required: Artifact = { ...diff, id: `artifact:${candidateId}:required-qa:fixed`, kind: 'qa', data: requiredQaFixture(fingerprint, policy) };
  const command: Artifact = { ...diff, id: `artifact:${candidateId}:qa:commands`, kind: 'qa', data: { verification: 'current', stale: false, candidateFingerprint: fingerprint, checks: [{ name: 'command check', exitCode: 0, testedRevision: fingerprint }] } };
  const binding = { candidateRunId: candidateId, commitSha: commit, candidateFingerprint: fingerprint, diffArtifactId: diff.id, diffRevision: diff.revision, qaArtifactIds: [required.id] };
  const typed: Artifact = { ...diff, id: `artifact:${reviewId}:typed-review:fixed`, runId: reviewId, kind: 'qa', data: { typedReview: { ...binding, reviewerRunId: reviewId, disposition: 'approved', findings: [{ summary: 'Bound review body' }] } } };
  const delivery: Artifact = { ...diff, id: `receipt-${workId}`, runId: `delivery-${workId}`, kind: 'delivery', data: { phase: 'pr_created', pullRequestUrl: 'https://example.test/pr', commitSha: commit } };
  const candidate: Snapshot['runs'][number] = { id: candidateId, projectId: project.id, workId, kind: 'implementation', model: 'gpt-6-luna', reasoning: 'medium', status: 'completed', generation: 1, createdAt: '', updatedAt: '', qaPolicySnapshot: policy };
  const review: Snapshot['runs'][number] = { ...candidate, id: reviewId, kind: 'review', reviewBinding: binding };
  const deliveryRun = { ...candidate, id: delivery.runId, kind: 'delivery', targetRunId: candidateId, operation: { action: 'create_draft_pr', phase: 'pr_created', ...binding } } as Snapshot['runs'][number];
  const bodies = [diff, required, command, typed, delivery];
  const artifacts = bodies.map(body => body.kind === 'diff' ? body : { ...body, data: undefined });
  const snapshot: Snapshot = { member, projects: [project], works: [work], runs: [candidate, review, deliveryRun], artifacts, settings: [], runtimeProviders: [], messages: [{ id: 'message', projectId: project.id, workId, role: 'agent', speaker: 'Codex', text: 'Retained conversation', createdAt: '' }] };
  return { snapshot, bodies, diff, required, command, typed, delivery, work };
}
let host: HTMLDivElement, root: Root, current: Snapshot, bodies: Map<string, Artifact>;
let requests: Array<{ id: string; signal?: AbortSignal | null }>;
let respond: (id: string, count: number) => Response | Promise<Response>;
let evidenceRequests: Array<{ id: string; signal?: AbortSignal | null }>;
let respondEvidence: (id: string, count: number) => Response | Promise<Response>;
const count = (id: string) => requests.filter(request => request.id === id).length;
const evidenceCount = (id: string) => evidenceRequests.filter(request => request.id === id).length;
async function flush(action: () => void = () => {}) { await act(async () => { action(); }); }
async function tab(name: string) { await flush(() => host.querySelector<HTMLAnchorElement>(`[aria-label="Work details"] a[href$="tab=${name}"]`)!.click()); }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
async function mount(f = fixture(), initialTab = 'overview', strict = false) {
  current = f.snapshot; bodies = new Map(f.bodies.map(body => [body.id, body]));
  respond = id => Response.json(bodies.get(id));
  window.history.replaceState(null, '', `/workbench/?view=work-detail&project=project&work=${f.work.id}&tab=${initialTab}`);
  await flush(() => root.render(strict ? createElement(StrictMode, null, createElement(App)) : createElement(App)));
  return f;
}
function retry() { return [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry failed evidence')!; }
function typedStatus() { return [...host.querySelectorAll('section')].find(section => section.querySelector('h3')?.textContent === 'Typed review')?.textContent; }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); resetRateLimitCooldown(); sessionStorage.clear();
  requests = [];
  vi.spyOn(workbenchApi, 'me').mockImplementation(async () => current.member);
  vi.spyOn(workbenchApi, 'snapshot').mockImplementation(async () => structuredClone(current));
  vi.spyOn(workbenchApi, 'workEvidence').mockImplementation(async id => {
    const work=current.works.find(item=>item.id===id)!;
    return { work, messages:current.messages.filter(item=>item.workId===id), runs:current.runs.filter(item=>item.workId===id), artifacts:current.artifacts.filter(item=>item.workId===id) };
  });
  vi.spyOn(workbenchApi, 'projectMessages').mockResolvedValue({ messages: [], nextBefore: null });
  evidenceRequests = [];
  respondEvidence = id => {
    const work = current.works.find(item => item.id === id);
    return work ? Response.json({ work, messages: current.messages.filter(item => item.workId === id && item.projectId === work.projectId), runs: current.runs.filter(item => item.workId === id), artifacts: current.artifacts.filter(item => item.workId === id) }) : new Response('{}', { status: 404 });
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const workMatch = path.match(/^\/api\/workbench\/works\/([^/?]+)$/u);
    if (workMatch) {
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') throw new Error(`Unexpected work evidence method: ${init?.method}`);
      const id = decodeURIComponent(workMatch[1]!);
      evidenceRequests.push({ id, signal: init?.signal });
      return respondEvidence(id, evidenceCount(id));
    }
    if (!path.startsWith('/api/workbench/artifacts/')) throw new Error(`Unexpected fetch: ${path}`);
    const id = decodeURIComponent(path.split('/artifacts/')[1]!);
    requests.push({ id, signal: init?.signal });
    return respond(id, count(id));
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await flush(() => root.unmount()); host.remove(); resetRateLimitCooldown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('reuses all three consumers across ten actual tab clicks: one GET per successful metadata key, with polling separate', async () => {
  const f = await mount();
  expect(host.textContent).toContain('Merge reviewed pull request');
  expect(host.querySelector('a[href="https://example.test/pr"]')).not.toBeNull();
  const composer = host.querySelector<HTMLInputElement>('[aria-label="Message Agent"]')!;
  const message = host.querySelector('[data-message-id="message"]')!;
  const pane = message.parentElement!; pane.scrollTop = 111;
  await flush(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'Edit')!.click());
  const overview = host.querySelector('textarea')!;
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(overview, 'Unsaved overview');
    overview.dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(composer, 'Unsaved message');
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (const name of ['changes', 'qa', 'overview', 'changes', 'overview', 'qa', 'changes', 'qa', 'overview', 'changes']) {
    await tab(name);
    expect(host.querySelector('[aria-label="Message Agent"]')).toBe(composer);
    expect(composer.value).toBe('Unsaved message'); expect(pane.scrollTop).toBe(111);
    expect(host.querySelector('[data-message-id="message"]')).toBe(message);
  }
  await tab('overview'); expect(host.querySelector('textarea')?.value).toBe('Unsaved overview');
  expect(requests).toHaveLength(5);
  for (const body of f.bodies) expect(count(body.id)).toBe(1);
  expect(workbenchApi.me).toHaveBeenCalledTimes(1); expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(1);
  current={...current,runs:current.runs.map(run=>({...run,updatedAt:'poll-only-change'}))};
  await tick();
  expect(workbenchApi.snapshot).toHaveBeenCalledTimes(2); expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(2);
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(5);
});

it('shares a pending body across Overview and QA; aborting the QA consumer does not kill Overview', async () => {
  const f = fixture(); let finish!: (response: Response) => void;
  current = f.snapshot; bodies = new Map(f.bodies.map(body => [body.id, body]));
  respond = id => id === f.typed.id ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(bodies.get(id));
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work');
  await flush(() => root.render(createElement(App)));
  await tab('qa'); await tab('overview');
  expect(count(f.typed.id)).toBe(1); expect(requests.find(request => request.id === f.typed.id)!.signal?.aborted).toBe(false);
  await flush(() => finish(Response.json(f.typed)));
  expect(host.textContent).toContain('Merge reviewed pull request');
  await tab('qa'); expect(typedStatus()).toContain('Current evidence'); expect(count(f.typed.id)).toBe(1);
});

it.each(['revision', 'runId', 'createdAt'] as const)('cold-reads a delivery body when the same id has new %s metadata', async field => {
  const f = await mount();
  const changed = { ...f.delivery, [field]: `new-${field}`, data: { ...(f.delivery.data as object), pullRequestUrl: 'https://example.test/new' } };
  bodies.set(changed.id, changed);
  current = { ...current, artifacts: current.artifacts.map(item => item.id === changed.id ? { ...changed, data: undefined } : item) };
  await tick(); expect(count(changed.id)).toBe(2);
  expect(host.querySelector('a[href="https://example.test/new"]')).not.toBeNull();
});

it('cold-reads changed candidate metadata, retains live Stale binding semantics and refetches invalid evidence on Retry', async () => {
  const f = await mount(undefined, 'qa'); expect(typedStatus()).toContain('Current evidence');
  const nextCommit = 'c'.repeat(40);
  const diff = { ...f.diff, data: { ...(f.diff.data as object), candidateRevision: nextCommit } };
  bodies.set(diff.id, diff);
  current = { ...current, artifacts: current.artifacts.map(item => item.id === diff.id ? diff : item), runs: current.runs.map(run => run.reviewBinding ? { ...run, reviewBinding: { ...run.reviewBinding, commitSha: nextCommit } } : run) };
  await tick(); expect(count(diff.id)).toBe(2); expect(typedStatus()).toContain('Stale');
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(2);
  expect(count(f.typed.id)).toBe(1); expect(retry()).toBeDefined();
  const data = f.typed.data as { typedReview: object };
  bodies.set(f.typed.id, { ...f.typed, data: { typedReview: { ...data.typedReview, commitSha: nextCommit } } });
  await flush(() => { retry().click(); retry().click(); });
  expect(count(f.typed.id)).toBe(2); expect(count(f.required.id)).toBe(1); expect(count(f.command.id)).toBe(1);
  expect(typedStatus()).toContain('Current evidence');
});

it.each(['http', 'envelope', 'malformed', 'semantic'] as const)('does not retain %s failure as successful evidence; failed-only double-click Retry recovers', async failure => {
  const f = fixture(); current = f.snapshot; bodies = new Map(f.bodies.map(body => [body.id, body]));
  let finish!: (response: Response) => void;
  respond = (id, attempt) => {
    if (id !== f.typed.id) return Response.json(bodies.get(id));
    if (attempt === 1) return failure === 'http' ? new Response('{}', { status: 500 })
      : Response.json(failure === 'envelope' ? { ...f.typed, workId: 'wrong' } : failure === 'malformed' ? { ...f.typed, data: null } : { ...f.typed, data: { typedReview: { ...(f.typed.data as { typedReview: object }).typedReview, candidateFingerprint: 'd'.repeat(64) } } });
    return new Promise(resolve => { finish = resolve; });
  };
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work&tab=qa');
  await flush(() => root.render(createElement(App)));
  expect(typedStatus()).not.toContain('Current evidence'); expect(retry()).toBeDefined();
  await flush(() => { retry().click(); retry().click(); });
  expect(count(f.typed.id)).toBe(2);
  expect(count(f.diff.id)).toBe(1); expect(count(f.required.id)).toBe(1); expect(count(f.command.id)).toBe(1);
  await flush(() => finish(Response.json(f.typed)));
  expect(typedStatus()).toContain('Current evidence');
  await tab('overview'); await tab('qa'); expect(count(f.typed.id)).toBe(2);
});

it.each([['Work', 'success'], ['Work', '429'], ['member', 'success'], ['member', '429'], ['unmount', 'success'], ['unmount', '429']] as const)('ends the old scope on %s; late %s cannot leak or extend cooldown', async (transition, late) => {
  const f = fixture(), other = fixture('other');
  current = f.snapshot; bodies = new Map([...f.bodies, ...other.bodies].map(body => [body.id, body]));
  const finishes: Array<(response: Response) => void> = [];
  respond = (id, attempt) => id === f.typed.id && attempt === 1 ? new Promise(resolve => { finishes.push(resolve); }) : Response.json(bodies.get(id));
  window.history.replaceState(null, '', '/workbench/?view=work-detail&project=project&work=work&tab=qa');
  await flush(() => root.render(createElement(App)));
  const signal = requests.find(request => request.id === f.typed.id)!.signal!;
  if (transition === 'Work') {
    current = { ...current, works: [...current.works, other.work], runs: [...current.runs, ...other.snapshot.runs], artifacts: [...current.artifacts, ...other.snapshot.artifacts] };
    await tick(); await flush(() => navigate('/workbench/?view=work-detail&project=project&work=other&tab=qa'));
    expect(typedStatus()).toContain('Current evidence');
  } else if (transition === 'member') {
    current = { ...current, member: { ...member, id: 'other-member' } }; await tick();
    for (const body of f.bodies.filter(body => body.kind !== 'delivery')) expect(count(body.id)).toBe(2);
    expect(typedStatus()).toContain('Current evidence');
  } else {
    await flush(() => root.unmount()); root = createRoot(host);
    await flush(() => root.render(createElement(App)));
    expect(count(f.diff.id)).toBe(2); expect(count(f.typed.id)).toBe(2);
    expect(typedStatus()).toContain('Current evidence');
  }
  expect(signal.aborted).toBe(true);
  const oldBody = { ...f.typed, data: { typedReview: { ...(f.typed.data as { typedReview: object }).typedReview, findings: [{ summary: 'Old scope result must not leak' }] } } };
  await flush(() => finishes[0]!(late === '429' ? new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }) : Response.json(oldBody)));
  expect(host.textContent).not.toContain('Old scope result must not leak');
  expect(canAutoPoll()).toBe(true);
  if (transition !== 'unmount') expect(typedStatus()).toContain('Current evidence');
  if (transition === 'Work') {
    await flush(() => navigate('/workbench/?view=work-detail&project=project&work=work&tab=qa'));
    expect(count(f.typed.id)).toBe(2); expect(typedStatus()).toContain('Current evidence');
  }
});

it('survives StrictMode layout/effect replay and then reuses settled bodies on tabs', async () => {
  const f = await mount(undefined, 'overview', true);
  expect(host.textContent).toContain('Merge reviewed pull request');
  await tab('qa'); expect(typedStatus()).toContain('Current evidence');
  const before = count(f.typed.id); await tab('overview'); await tab('qa');
  expect(count(f.typed.id)).toBe(before);
});

it('loads metadata once per Work, fetches the selected full diff once, and retains it on tab return', async () => {
  const f=fixture();
  const full={...f.diff,data:{...(f.diff.data as object),files:[{path:'src/a.ts',status:'modified',binary:false,additions:1,deletions:0,hunks:'full legacy hunks'}],patch:'large historical patch'}};
  f.snapshot.artifacts=f.snapshot.artifacts.map(item=>item.id===f.diff.id?{...item,data:{candidateRevision:commit,totalFiles:1,files:[{path:'src/a.ts',status:'modified',binary:false,additions:1,deletions:0}]}}:item);
  f.bodies.splice(f.bodies.findIndex(item=>item.id===full.id),1,full);
  await mount(f,'changes');
  expect(host.textContent).toContain('src/a.ts');
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(1);
  expect(count(f.diff.id)).toBe(1);
  await tab('qa');await tab('changes');
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(1);expect(count(f.diff.id)).toBe(1);
  await tab('qa');
  await flush(()=>window.history.back());
  await flush();
  expect(new URL(window.location.href).searchParams.get('tab')).toBe('changes');
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(1);
});

it('restores an old Work from scoped 72 metadata rows when the global 200-row snapshot contains only other Works', async () => {
  const f=fixture();
  const fullDiff={...f.diff,data:{...(f.diff.data as object),files:[{path:'src/old-work.ts',status:'modified',binary:false,additions:1,deletions:0,hunks:[]}]}};
  f.bodies.splice(f.bodies.findIndex(item=>item.id===f.diff.id),1,fullDiff);
  const scopedArtifacts=[...f.snapshot.artifacts.map(item=>item.id===f.diff.id?{...item,data:{candidateRevision:commit,totalFiles:1,files:[{path:'src/old-work.ts',status:'modified',binary:false,additions:1,deletions:0}]}}:item),...Array.from({length:67},(_,index)=>({id:`scoped-source-${index}`,projectId:project.id,workId:f.work.id,runId:`source-run-${index}`,kind:'source' as const,revision:`source-${index}`,createdAt:`2026-01-${String(index+1).padStart(2,'0')}`,data:undefined}))];
  expect(scopedArtifacts).toHaveLength(72);
  f.snapshot.artifacts=Array.from({length:200},(_,index)=>({id:`global-other-${index}`,projectId:project.id,workId:`unrelated-${index}`,runId:`other-run-${index}`,kind:'source' as const,revision:`global-${index}`,createdAt:`2026-02-${String(index+1).padStart(2,'0')}`,data:undefined}));
  vi.mocked(workbenchApi.workEvidence).mockResolvedValueOnce({work:f.work,messages:f.snapshot.messages,runs:f.snapshot.runs,artifacts:scopedArtifacts});
  await mount(f,'changes');
  expect(host.textContent).toContain('src/old-work.ts');
  expect(host.textContent).toContain('Implementation run');
  await tab('qa');
  expect(typedStatus()).toContain('Current evidence');
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(1);
  await tab('changes');
  expect(count(f.diff.id)).toBe(1);
});

it.each([['Work','success'],['Work','error'],['member','success'],['member','error'],['project','success'],['project','error']] as const)('fences scoped metadata from the old %s after a fast switch and late %s', async (scope,late)=>{
  const f=fixture(),other=fixture('next-work');
  const otherProject={...project,id:'next-project',name:'Next project'};
  const nextWork=scope==='project'?{...other.work,projectId:otherProject.id}:other.work;
  f.snapshot.works=[f.work,nextWork];
  if(scope==='project')f.snapshot.projects=[project,otherProject];
  current=f.snapshot;bodies=new Map([...f.bodies,...other.bodies].map(body=>[body.id,body]));
  let finishOld!:(value:Awaited<ReturnType<typeof workbenchApi.workEvidence>>)=>void;
  let failOld!:(error:Error)=>void;let oldRequests=0;
  vi.mocked(workbenchApi.workEvidence).mockImplementation(async id=>{
    if(id===f.work.id&&oldRequests++===0)return new Promise((resolve,reject)=>{finishOld=resolve;failOld=reject;});
    const work=current.works.find(item=>item.id===id)!;
    return {work,messages:current.messages.filter(item=>item.workId===id),runs:current.runs.filter(item=>item.workId===id),artifacts:current.artifacts.filter(item=>item.workId===id)};
  });
  await mount(f,'changes');
  if(scope==='member'){
    current={...current,member:{...member,id:'next-member'}};
    await tick();
  }else{
    await flush(()=>navigate(`/workbench/?view=work-detail&project=${scope==='project'?otherProject.id:project.id}&work=${nextWork.id}&tab=changes`));
  }
  expect(host.querySelector('h1')?.textContent).toBe(scope==='member'?f.work.title:nextWork.title);
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(2);
  const lateArtifact:Artifact={id:'old-late-diff',projectId:project.id,workId:f.work.id,runId:'old-late-run',kind:'diff',revision:'old-late-revision',createdAt:'late',data:{candidateRevision:commit,files:[{path:'OLD-LATE-CONTENT.ts',status:'modified',binary:false,additions:1,deletions:0}]}};
  if(late==='success')await flush(()=>finishOld({work:f.work,messages:[],runs:[],artifacts:[lateArtifact]}));
  else await flush(()=>failOld(new Error('late old Work failure')));
  expect(host.textContent).not.toContain('OLD-LATE-CONTENT.ts');
  expect(host.textContent).not.toContain('Could not load this Work’s evidence.');
  expect(host.querySelector('h1')?.textContent).toBe(scope==='member'?f.work.title:nextWork.title);
});

it('shows scoped metadata failure explicitly and retries instead of rendering false empty evidence', async () => {
  const f=fixture();current=f.snapshot;bodies=new Map(f.bodies.map(body=>[body.id,body]));
  const evidence=vi.mocked(workbenchApi.workEvidence);
  evidence.mockRejectedValueOnce(new Error('offline'));
  await mount(f,'changes');
  expect(host.textContent).toContain('Could not load this Work’s evidence.');
  expect(host.textContent).not.toContain('No change evidence has been recorded yet.');
  await flush(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Retry')!.click());
  expect(host.textContent).toContain('Recorded file changes from this Work.');
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(2);
});

it.each(['Work', 'project', 'member'] as const)('aborts old %s metadata so a late real-API 429 cannot pause the new scope', async scope => {
  const f = fixture(), other = fixture('next-work'), nextProject = { ...project, id: 'next-project', name: 'Next project' };
  const otherWork = scope === 'project' ? { ...other.work, projectId: nextProject.id } : other.work;
  const otherRuns = other.snapshot.runs.map(run => scope === 'project' ? { ...run, projectId: nextProject.id } : run);
  const otherArtifacts = other.snapshot.artifacts.map(artifact => scope === 'project' ? { ...artifact, projectId: nextProject.id } : artifact);
  current = { ...f.snapshot, projects: scope === 'project' ? [project, nextProject] : [project], works: [f.work, otherWork], runs: [...f.snapshot.runs, ...otherRuns], artifacts: [...f.snapshot.artifacts, ...otherArtifacts] };
  const otherBodies = other.bodies.map(body => scope === 'project' ? { ...body, projectId: nextProject.id } : body);
  bodies = new Map([...f.bodies, ...otherBodies].map(body => [body.id, body]));
  let finishOld!: (response: Response) => void;
  respondEvidence = (id, attempt) => id === f.work.id && attempt === 1
    ? new Promise<Response>(resolve => { finishOld = resolve; })
    : (() => { const work = current.works.find(item => item.id === id)!; return Response.json({ work, messages: current.messages.filter(item => item.workId === id && item.projectId === work.projectId), runs: current.runs.filter(item => item.workId === id), artifacts: current.artifacts.filter(item => item.workId === id) }); })();
  vi.mocked(workbenchApi.workEvidence).mockRestore();
  window.history.replaceState(null, '', `/workbench/?view=work-detail&project=project&work=${f.work.id}&tab=qa`);
  await flush(() => root.render(createElement(App)));
  const oldRequest = evidenceRequests.find(request => request.id === f.work.id)!;
  expect(oldRequest.signal?.aborted).toBe(false);

  if (scope === 'member') {
    current = { ...current, member: { ...member, id: 'next-member' } };
    await tick();
  } else {
    await flush(() => navigate(`/workbench/?view=work-detail&project=${scope === 'project' ? nextProject.id : project.id}&work=${otherWork.id}&tab=qa`));
  }
  expect(oldRequest.signal?.aborted).toBe(true);
  expect(host.querySelector('h1')?.textContent).toBe(scope === 'member' ? f.work.title : otherWork.title);
  expect(typedStatus()).toContain('Current evidence');

  await flush(() => finishOld(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })));
  expect(canAutoPoll()).toBe(true);
  expect(host.querySelector('h1')?.textContent).toBe(scope === 'member' ? f.work.title : otherWork.title);
  expect(typedStatus()).toContain('Current evidence');
  expect(host.textContent).not.toContain('limited');
});

it('keeps current-scope metadata 429 cooldown and explicit retry without claiming empty evidence', async () => {
  const f = fixture(); current = f.snapshot; bodies = new Map(f.bodies.map(body => [body.id, body]));
  let metadataRequests = 0;
  respondEvidence = id => {
    metadataRequests++;
    if (metadataRequests === 1) return new Response(JSON.stringify({ message: 'Rate limited' }), { status: 429, headers: { 'Retry-After': '120' } });
    const work = current.works.find(item => item.id === id)!;
    return Response.json({ work, messages: current.messages.filter(item => item.workId === id), runs: current.runs.filter(item => item.workId === id), artifacts: current.artifacts.filter(item => item.workId === id) });
  };
  vi.mocked(workbenchApi.workEvidence).mockRestore();
  window.history.replaceState(null, '', `/workbench/?view=work-detail&project=project&work=${f.work.id}&tab=changes`);
  await flush(() => root.render(createElement(App)));
  expect(evidenceCount(f.work.id)).toBe(1);
  expect(canAutoPoll()).toBe(false);
  expect(host.textContent).toContain('Could not load this Work’s evidence.');
  expect(host.textContent).not.toContain('No change evidence has been recorded yet.');
  const retryButton = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')!;
  expect(retryButton).toBeDefined();

  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(canAutoPoll()).toBe(true);
  await flush(() => retryButton.click());
  expect(evidenceCount(f.work.id)).toBe(2);
  expect(host.textContent).toContain('Recorded file changes from this Work.');
  expect(host.textContent).not.toContain('Could not load this Work’s evidence.');
});

it('keeps the Work evidence state visibly loading until scoped metadata resolves', async () => {
  const f=fixture();let finish!:(value:Awaited<ReturnType<typeof workbenchApi.workEvidence>>)=>void;
  vi.mocked(workbenchApi.workEvidence).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await mount(f,'changes');
  expect(host.textContent).toContain('Loading Work evidence…');
  expect(host.textContent).not.toContain('No change evidence has been recorded yet.');
  await flush(()=>finish({work:f.work,messages:f.snapshot.messages,runs:f.snapshot.runs,artifacts:f.snapshot.artifacts}));
  expect(host.textContent).toContain('Recorded file changes from this Work.');
});

it('does not cache a selected diff 404 or mismatch as success and retries the full artifact', async () => {
  const f=fixture();current=f.snapshot;bodies=new Map(f.bodies.map(body=>[body.id,body]));
  const full={...f.diff,data:{...(f.diff.data as object),files:[{path:'src/a.ts',status:'modified',binary:false,additions:1,deletions:0,hunks:'full hunk'}]}};
  bodies.set(full.id,full);
  let invalid=true;
  respond=(id)=>{
    if(id===f.diff.id&&invalid){invalid=false;return new Response('{}',{status:404});}
    return Response.json(bodies.get(id));
  };
  window.history.replaceState(null,'',`/workbench/?view=work-detail&project=project&work=${f.work.id}&tab=changes`);
  await flush(()=>root.render(createElement(App)));
  expect(host.textContent).toContain('Could not load the latest evidence.');
  expect(host.textContent).not.toContain('No change evidence has been recorded yet.');
  await flush(()=>{const button=[...host.querySelectorAll('button')].find(item=>item.textContent==='Retry')!;button.click();button.click();});
  expect(count(f.diff.id)).toBe(2);
  expect(host.textContent).toContain('src/a.ts');
});

it('preserves an edited overview and its DOM while explicit scoped refresh is pending', async()=>{
  const f=fixture();let finish!:(value:Awaited<ReturnType<typeof workbenchApi.workEvidence>>)=>void;
  const original=vi.mocked(workbenchApi.workEvidence).getMockImplementation()!;let calls=0;
  vi.mocked(workbenchApi.workEvidence).mockImplementation(id=>{if(++calls===2)return new Promise(resolve=>{finish=resolve;});return original(id);});
  const initial=await mount(f,'overview');
  await flush(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Edit')!.click());
  const textarea=host.querySelector('textarea')!;
  await flush(()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Draft stays through refresh');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
  const oldDiff=f.snapshot.artifacts.find(item=>item.kind==='diff')!;
  const changedDiff={...oldDiff,revision:'new-diff-revision',data:{candidateRevision:'c'.repeat(40),baseRevision:'d'.repeat(40),files:[]}};
  current={...current,artifacts:current.artifacts.map(item=>item.id===oldDiff.id?changedDiff:item)};
  await flush(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Refresh evidence')!.click());
  expect(host.textContent).toContain('Refreshing Work evidence');
  expect(host.querySelector('textarea')).toBe(textarea);expect(textarea.value).toBe('Draft stays through refresh');
  expect([...host.querySelectorAll('button')].find(button=>button.textContent==='Save')!.disabled).toBe(true);
  const refreshed=await original(initial.work.id);
  await flush(()=>finish(refreshed));
  expect(host.querySelector('textarea')).toBe(textarea);expect(textarea.value).toBe('Draft stays through refresh');
  expect([...host.querySelectorAll('button')].find(button=>button.textContent==='Save')!.disabled).toBe(false);
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(2);
});

it('refreshes committed Work evidence after a speculative semantic render is discarded',async()=>{
  let renderedSnapshot!:Snapshot;
  vi.mocked(workbenchApi.snapshot).mockImplementation(async()=>{renderedSnapshot=structuredClone(current);return renderedSnapshot;});
  const f=await mount();
  let setBlocked!:(value:boolean)=>void;
  const never=new Promise<never>(()=>{});
  function BlockDuringTransition({blocked}:{blocked:boolean}){if(blocked)throw never;return null;}
  function Harness(){const[blocked,setBlockedState]=useState(false);setBlocked=setBlockedState;return createElement(Suspense,{fallback:createElement('div',null,'suspended')},createElement(App),createElement(BlockDuringTransition,{blocked}));}
  await flush(()=>root.render(createElement(Harness)));
  let semanticBRenders=0;
  const committedWork=renderedSnapshot.works[0]!;
  renderedSnapshot.works[0]=new Proxy({...committedWork,revision:committedWork.revision+1},{get(target,key,receiver){if(key==='revision')semanticBRenders++;return Reflect.get(target,key,receiver);}});
  await flush(()=>startTransition(()=>setBlocked(true)));
  expect(semanticBRenders).toBeGreaterThan(0);
  expect(host.textContent).not.toContain('suspended');
  expect(host.querySelector('[data-testid="work-detail-layout"]')).not.toBeNull();
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(2);
  await flush(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Refresh evidence')!.click());
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(3);
  expect(host.textContent).not.toContain('Refreshing Work evidence');
});

it('fences a pending Changes Retry when a new semantic diff revision becomes latest',async()=>{
  const f=fixture();current=f.snapshot;bodies=new Map(f.bodies.map(body=>[body.id,body]));
  const oldFull={...f.diff,data:{candidateRevision:commit,files:[{path:'src/old-retry.ts',status:'modified',binary:false,additions:1,deletions:0,hunks:[]}]}};
  const nextSha='c'.repeat(40);
  const nextMeta={...f.diff,id:'diff-next',revision:'next-revision',createdAt:'2026-01-02',data:{candidateRevision:nextSha,totalFiles:1,files:[{path:'src/new-latest.ts',status:'modified',binary:false,additions:1,deletions:0}]}};
  const nextFull={...nextMeta,data:{...nextMeta.data,files:[{path:'src/new-latest.ts',status:'modified',binary:false,additions:1,deletions:0,hunks:[]}]}};
  bodies.set(oldFull.id,oldFull);bodies.set(nextFull.id,nextFull);
  let finishOld!:(response:Response)=>void;
  respond=(id,attempt)=>id===f.diff.id?attempt===1?new Response('{}',{status:404}):new Promise(resolve=>{finishOld=resolve;}):Response.json(bodies.get(id));
  window.history.replaceState(null,'',`/workbench/?view=work-detail&project=project&work=${f.work.id}&tab=changes`);
  await flush(()=>root.render(createElement(App)));
  expect(host.textContent).toContain('Could not load the latest evidence.');
  await flush(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Retry')!.click());
  expect(count(f.diff.id)).toBe(2);
  current={...current,artifacts:[...current.artifacts,nextMeta]};
  await tick();
  expect(host.textContent).toContain('src/new-latest.ts');
  await flush(()=>finishOld(Response.json(oldFull)));
  expect(host.textContent).toContain('src/new-latest.ts');
  expect(host.textContent).not.toContain('src/old-retry.ts');
});

it('keeps expanded diff mounted during refresh, blocks draft action, and withholds old QA as Current', async()=>{
  const f=fixture();const repoProject={...project,repositoryUrl:'https://github.com/example/project'};
  f.snapshot.projects=[repoProject];f.snapshot.runs=f.snapshot.runs.filter(run=>run.kind!=='delivery');
  f.snapshot.artifacts=f.snapshot.artifacts.filter(item=>item.kind!=='delivery');
  const fullDiff={...f.diff,data:{...(f.diff.data as object),totalFiles:1,files:[{path:'src/expanded.ts',status:'modified',binary:false,additions:1,deletions:0,hunks:[{header:'@@ -1 +1 @@',lines:[{type:'add',text:'preserved expanded row'}]}]}]}};
  f.bodies.splice(f.bodies.findIndex(item=>item.id===f.diff.id),1,fullDiff);
  f.snapshot.artifacts=f.snapshot.artifacts.map(item=>item.id===f.diff.id?{...item,data:{candidateRevision:commit,totalFiles:1,files:[{path:'src/expanded.ts',status:'modified',binary:false,additions:1,deletions:0}]}}:item);
  let finish!:(value:Awaited<ReturnType<typeof workbenchApi.workEvidence>>)=>void;
  const original=vi.mocked(workbenchApi.workEvidence).getMockImplementation()!;let calls=0;
  vi.mocked(workbenchApi.workEvidence).mockImplementation(id=>{if(++calls===2)return new Promise(resolve=>{finish=resolve;});return original(id);});
  const initial=await mount(f,'changes');
  const fileDetails=[...host.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent?.includes('src/expanded.ts'))!;
  await flush(()=>fileDetails.querySelector('summary')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  expect(fileDetails.open).toBe(true);expect(host.textContent).toContain('preserved expanded row');
  await flush(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Refresh evidence')!.click());
  expect(host.querySelector('details')).toBe(fileDetails);expect(fileDetails.open).toBe(true);
  const draft=[...host.querySelectorAll('button')].find(button=>button.textContent==='Create Draft PR')!;
  expect(draft.disabled).toBe(true);
  await tab('qa');
  expect(host.querySelector('[aria-label="Required checks"]')?.textContent).toContain('Unknown');
  expect(typedStatus()).toContain('Unknown');expect(typedStatus()).not.toContain('Current evidence');
  await flush(()=>finish({work:initial.work,messages:initial.snapshot.messages,runs:initial.snapshot.runs.filter(run=>run.kind!=='delivery'),artifacts:initial.snapshot.artifacts.filter(item=>item.kind!=='delivery')}));
  expect(typedStatus()).toContain('Current evidence');
  expect(workbenchApi.workEvidence).toHaveBeenCalledTimes(2);
});
