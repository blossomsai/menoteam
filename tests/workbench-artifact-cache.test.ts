// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react';
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
const count = (id: string) => requests.filter(request => request.id === id).length;
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
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
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
  await tick();
  expect(workbenchApi.snapshot).toHaveBeenCalledTimes(2); expect(workbenchApi.projectMessages).toHaveBeenCalledTimes(2);
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
