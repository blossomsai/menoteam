import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLocalApp } from '../src/local/app.js';
import type { LocalRunner } from '../src/local/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'menoteam-local-')); roots.push(root);
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const runner: LocalRunner = ({ onEvent }) => ({ result: Promise.resolve({ output: 'Inspected files; no changes made.', threadId: 'thread-local' }).then((result) => { onEvent({ type: 'agent_message', text: result.output, threadId: result.threadId }); return result; }), cancel() {} });
  const app = await createLocalApp({ dataDir: join(root, 'state'), runner });
  const headers = { host: 'localhost:4311', origin: 'http://localhost:4311', 'content-type': 'application/json' };
  return { app, root, projectPath, headers };
}

describe('local workspace', () => {
  it('persists projects/jobs, makes submission idempotent, and acceptance updates the linked Work', async () => {
    const { app, root, projectPath, headers } = await fixture();
    const created = await app.inject({ method: 'POST', url: '/api/local/projects', headers, payload: { name: 'Prototype', path: projectPath, goal: 'Test the local flow' } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project.workRef).toMatch(/^work_/u);
    const payload = { prompt: 'Inspect this project', requestId: 'request-001' };
    const first = await app.inject({ method: 'POST', url: `/api/local/projects/${project.id}/jobs`, headers, payload });
    const duplicate = await app.inject({ method: 'POST', url: `/api/local/projects/${project.id}/jobs`, headers, payload });
    expect(first.json().id).toBe(duplicate.json().id);
    await waitFor(async () => (await app.inject({ url: '/api/local/snapshot', headers })).json().jobs[0].status === 'needs_review');
    const jobId = first.json().id as string;
    const accepted = await app.inject({ method: 'POST', url: `/api/local/jobs/${jobId}/accept`, headers, payload: {} });
    expect(accepted.json().status).toBe('accepted');
    await app.close();

    const reopened = await createLocalApp({ dataDir: join(root, 'state'), runner: asyncRunner });
    const snapshot = (await reopened.inject({ url: '/api/local/snapshot', headers })).json();
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.jobs[0].status).toBe('accepted');
    expect(snapshot.works.find((work: { ref: string }) => work.ref === project.workRef).living_doc_markdown).toContain('Accepted local run');
    await reopened.close();
  });

  it('rejects cross-origin and relative project mutations', async () => {
    const { app, projectPath, headers } = await fixture();
    const cross = await app.inject({ method: 'POST', url: '/api/local/projects', headers: { ...headers, origin: 'https://evil.example' }, payload: { name: 'No', path: projectPath } });
    expect(cross.statusCode).toBe(403);
    const relative = await app.inject({ method: 'POST', url: '/api/local/projects', headers, payload: { name: 'No', path: 'relative/path' } });
    expect(relative.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a second service using the same data directory', async () => {
    const { app, root } = await fixture();
    await expect(createLocalApp({ dataDir: join(root, 'state'), runner: asyncRunner })).rejects.toThrow('Another local workspace service');
    await app.close();
  });

  it('serializes jobs for one canonical project directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'menoteam-local-')); roots.push(root);
    const projectPath = join(root, 'project'); await mkdir(projectPath); const dataDir = join(root, 'state');
    let started = 0; const finishes: Array<() => void> = [];
    const runner: LocalRunner = () => { started += 1; let finish!: () => void; const result = new Promise<{ output: string }>((resolve) => { finish = () => resolve({ output: 'done' }); }); finishes.push(finish); return { result, cancel() {} }; };
    const app = await createLocalApp({ dataDir, runner }); const headers = { host: 'localhost:4311', origin: 'http://localhost:4311', 'content-type': 'application/json' };
    const project = (await app.inject({ method: 'POST', url: '/api/local/projects', headers, payload: { name: 'Serial', path: projectPath } })).json();
    for (let n = 0; n < 3; n += 1) await app.inject({ method: 'POST', url: `/api/local/projects/${project.id}/jobs`, headers, payload: { prompt: `Job ${n}`, requestId: `request-${n}-serial` } });
    await waitFor(async () => started === 1);
    expect(started).toBe(1);
    finishes[0]!(); await waitFor(async () => started === 2);
    expect(started).toBe(2);
    finishes[1]!(); await waitFor(async () => started === 3);
    finishes[2]!(); await waitFor(async () => (await app.inject({ url: '/api/local/snapshot', headers })).json().jobs.every((job: { status: string }) => job.status === 'needs_review'));
    await app.close();
  });

  it('recovers persisted running jobs as blocked interrupted work until confirmed stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'menoteam-local-')); roots.push(root); const dataDir = join(root, 'state'); await mkdir(dataDir);
    const now = new Date().toISOString();
    await writeFile(join(dataDir, 'state.json'), JSON.stringify({ projects: [], jobs: [{ id: 'job_crash', projectId: 'project_missing', prompt: 'partial job', mode: 'workspace-write', status: 'running', createdAt: now, updatedAt: now, output: '', events: [] }], workMap: { works: [], teammates: [], history: [] } }));
    const app = await createLocalApp({ dataDir, runner: asyncRunner }); const headers = { host: 'localhost:4311', origin: 'http://localhost:4311', 'content-type': 'application/json' };
    const job = (await app.inject({ url: '/api/local/snapshot', headers })).json().jobs[0];
    expect(job.status).toBe('interrupted'); expect(job.recoveryConfirmed).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/local/jobs/job_crash/retry', headers, payload: { requestId: 'retry-crash-001' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/local/jobs/job_crash/reconcile', headers, payload: { stopped: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/local/jobs/job_crash/retry', headers, payload: { requestId: 'retry-crash-001' } })).statusCode).toBe(202);
    await app.close();
  });
  it('reserves at most two slots under concurrent submissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'menoteam-local-')); roots.push(root);
    const finishes: Array<() => void> = [];
    const runner: LocalRunner = () => { let finish!: () => void; const result = new Promise<{ output: string }>((resolve) => { finish = () => resolve({ output: 'done' }); }); finishes.push(finish); return { result, cancel: finish }; };
    const app = await createLocalApp({ dataDir: join(root, 'state'), runner });
    const headers = { host: 'localhost:4311', origin: 'http://localhost:4311', 'content-type': 'application/json' };
    const projects = [];
    for (let n = 0; n < 3; n += 1) { const path = join(root, `project-${n}`); await mkdir(path); projects.push((await app.inject({ method:'POST',url:'/api/local/projects',headers,payload:{ name:`Project ${n}`,path } })).json()); }
    await Promise.all(projects.map((project, n) => app.inject({ method:'POST',url:`/api/local/projects/${project.id}/jobs`,headers,payload:{prompt:'Run',requestId:`parallel-${n}`} })));
    await waitFor(async () => finishes.length === 2);
    expect(finishes).toHaveLength(2);
    expect((await app.inject({ url:'/api/local/snapshot',headers })).json().runtime.running).toBe(2);
    finishes[0]!(); await waitFor(async () => finishes.length === 3);
    await app.close();
  });

  it('serializes projects pointing at subdirectories of the same git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'menoteam-local-')); roots.push(root);
    const path = join(root,'repo'); await mkdir(path); await mkdir(join(path,'sub')); execFileSync('git',['init','--quiet',path]);
    const finishes: Array<() => void> = [];
    const runner: LocalRunner = () => { let finish!: () => void; const result = new Promise<{ output: string }>((resolve) => { finish = () => resolve({ output:'done' }); }); finishes.push(finish); return {result,cancel:finish}; };
    const app = await createLocalApp({dataDir:join(root,'state'),runner}); const headers = { host:'localhost:4311',origin:'http://localhost:4311','content-type':'application/json' };
    for (const [n, projectPath] of [path,join(path,'sub')].entries()) { const project=(await app.inject({method:'POST',url:'/api/local/projects',headers,payload:{name:`Alias ${n}`,path:projectPath}})).json(); await app.inject({method:'POST',url:`/api/local/projects/${project.id}/jobs`,headers,payload:{prompt:'Run',requestId:`alias-run-${n}`}}); }
    await waitFor(async()=>finishes.length===1); expect(finishes).toHaveLength(1);
    finishes[0]!(); await waitFor(async()=>finishes.length===2); await app.close();
  });

  it('preserves goal/instructions and passes accepted evidence into the next run', async () => {
    const {app,root,projectPath,headers}=await fixture();
    const project=(await app.inject({method:'POST',url:'/api/local/projects',headers,payload:{name:'Context',path:projectPath,goal:'Original goal',instructions:'Original instructions'}})).json();
    await app.inject({method:'POST',url:`/api/local/projects/${project.id}/jobs`,headers,payload:{prompt:'Inspect',requestId:'context-run-1'}});
    await waitFor(async()=>(await app.inject({url:'/api/local/snapshot',headers})).json().jobs[0].status==='needs_review');
    const job=(await app.inject({url:'/api/local/snapshot',headers})).json().jobs[0];
    await app.inject({method:'POST',url:`/api/local/jobs/${job.id}/accept`,headers,payload:{}});
    await app.inject({method:'PATCH',url:`/api/local/projects/${project.id}`,headers,payload:{instructions:'Current instructions'}});
    const doc=(await app.inject({url:'/api/local/snapshot',headers})).json().works[0].living_doc_markdown;
    expect(doc).toContain('Original goal'); expect(doc).toContain('Current instructions'); expect(doc).toContain('Accepted local run');
    await app.close();
    let observed=''; const runner:LocalRunner=({project,job})=>{observed=project.instructions+'\n'+job.prompt;return{result:Promise.resolve({output:'done'}),cancel(){}};};
    const restarted=await createLocalApp({dataDir:join(root,'state'),runner});
    await restarted.inject({method:'POST',url:`/api/local/projects/${project.id}/jobs`,headers,payload:{prompt:'Continue',requestId:'context-run-2'}});
    await waitFor(async()=>observed.length>0); expect(observed).toContain('Current instructions'); expect(observed).toContain('Inspected files'); expect(observed).toContain('Original goal');
    await restarted.close();
  });

  it('starts persisted queued jobs on restart and rejects invalid requests and stale locks', async () => {
    const {app,root,projectPath,headers}=await fixture();
    expect((await app.inject({method:'POST',url:'/api/local/projects',headers,payload:{name:3,path:projectPath}})).statusCode).toBe(400);
    const project=(await app.inject({method:'POST',url:'/api/local/projects',headers,payload:{name:'Restart',path:projectPath}})).json(); await app.close();
    const file=join(root,'state','state.json'); const state=JSON.parse(await readFile(file,'utf8'));
    state.jobs.push({id:'job_queued',projectId:project.id,prompt:'Resume queued',mode:'read-only',status:'queued',createdAt:'',updatedAt:'',output:'',events:[]}); await writeFile(file,JSON.stringify(state));
    const restarted=await createLocalApp({dataDir:join(root,'state'),runner:asyncRunner}); await waitFor(async()=>(await restarted.inject({url:'/api/local/snapshot',headers})).json().jobs[0].status==='needs_review'); await restarted.close();
    await expect(createLocalApp({dataDir:join(root,'state'),maxConcurrent:3})).rejects.toThrow('maxConcurrent');
    await writeFile(join(root,'state','service.lock'),'999999999');
    await expect(createLocalApp({dataDir:join(root,'state')})).rejects.toThrow('manually remove');
    expect(await readFile(join(root,'state','service.lock'),'utf8')).toBe('999999999');
  });

  it('fails closed on persistence errors and stops active jobs', async () => {
    const root=await mkdtemp(join(tmpdir(),'menoteam-local-')); roots.push(root); const path=join(root,'project'); await mkdir(path); let cancelled=false; let started=false;
    const runner:LocalRunner=()=>{started=true;let stop!:(error:Error)=>void; const result=new Promise<{output:string}>((_resolve,reject)=>{stop=reject;});return{result,cancel(){cancelled=true;stop(Object.assign(new Error('cancelled'),{cancelled:true}));}};};
    const app=await createLocalApp({dataDir:join(root,'state'),runner}); const headers={host:'localhost:4311',origin:'http://localhost:4311','content-type':'application/json'};
    const project=(await app.inject({method:'POST',url:'/api/local/projects',headers,payload:{name:'Fail stop',path}})).json(); await app.inject({method:'POST',url:`/api/local/projects/${project.id}/jobs`,headers,payload:{prompt:'Run',requestId:'failure-run-1'}});
    await waitFor(async()=>started);
    await rm(join(root,'state','state.json')); await mkdir(join(root,'state','state.json'));
    expect((await app.inject({method:'PATCH',url:`/api/local/projects/${project.id}`,headers,payload:{instructions:'Fails to save'}})).statusCode).toBe(503);
    const snapshot=(await app.inject({url:'/api/local/snapshot',headers})).json(); expect(snapshot.runtime.schedulingStopped).toBe(true); expect(snapshot.runtime.error).toContain('persistence failed'); expect(cancelled).toBe(true);
    expect((await app.inject({method:'POST',url:`/api/local/projects/${project.id}/jobs`,headers,payload:{prompt:'Must not run',requestId:'failure-run-2'}})).statusCode).toBe(503);
    await app.close();
  });

});

describe('local web assets', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.local.config.ts'], { cwd: process.cwd(), stdio: 'pipe' });
  }, 30_000);

  it('serves built entry assets while refusing unknown and escaping paths', async () => {
    const { app, headers } = await fixture();
    for (const url of ['/', '/local']) {
      const page = await app.inject({ url, headers });
      expect(page.statusCode).toBe(200);
      const html = page.body;
      expect(html).toMatch(/src="\/local\/assets\/[^" ]+\.js"/u);
      expect(html).toMatch(/href="\/local\/assets\/[^" ]+\.css"/u);
    }
    const page = (await app.inject({ url: '/local', headers })).body;
    const jsPath = page.match(/src="([^"]+\.js)"/u)?.[1];
    const cssPath = page.match(/href="([^"]+\.css)"/u)?.[1];
    expect(jsPath).toBeTruthy(); expect(cssPath).toBeTruthy();
    expect((await app.inject({ url: jsPath!, headers })).headers['content-type']).toContain('javascript');
    expect((await app.inject({ url: cssPath!, headers })).headers['content-type']).toContain('text/css');
    const missing = await app.inject({ url: '/local/assets/not-generated.js', headers });
    expect(missing.statusCode, missing.body).toBe(404);
    const escape = await app.inject({ url: '/local/assets/%2e%2e/%2e%2e/package.json', headers });
    expect(escape.statusCode).toBe(404);
    expect(escape.body).not.toContain('menoteam-work-map');
    await app.close();
  });
});

const asyncRunner: LocalRunner = () => ({ result: Promise.resolve({ output: '', threadId: 'test' }), cancel() {} });
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for local job state');
}
