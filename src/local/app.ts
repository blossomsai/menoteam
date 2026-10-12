import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, realpath, stat, readFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import { InMemoryWorkMapRepository } from '../db/in-memory-repository.js';
import type { Work } from '../domain/model.js';
import { readLocalIndex } from './shell.js';
import { loadState, saveState } from './store.js';
import { runCodex } from './runner.js';
import type { LocalJob, LocalProject, LocalRunner, LocalState } from './types.js';

const createProject = z.object({ name: z.string().trim().min(1).max(120), path: z.string().min(1).max(2_000), repositoryUrl: z.string().max(500).optional().default(''), goal: z.string().max(8_000).optional().default(''), instructions: z.string().max(8_000).optional().default('') }).strict();
const updateProject = z.object({ goal: z.string().max(8_000).optional(), instructions: z.string().max(8_000).optional() }).strict();
const submitJob = z.object({ prompt: z.string().trim().min(1).max(12_000), mode: z.enum(['read-only', 'workspace-write']).default('read-only'), requestId: z.string().min(8).max(120) }).strict();
const retryJob = z.object({ requestId: z.string().min(8).max(120) }).strict();
const MAX_CONCURRENT = 2;

export interface LocalAppOptions { dataDir?: string; codexBinary?: string; maxConcurrent?: number; runner?: LocalRunner }

export async function createLocalApp(options: LocalAppOptions = {}): Promise<FastifyInstance> {
  const limit = options.maxConcurrent ?? MAX_CONCURRENT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONCURRENT) throw new Error('maxConcurrent must be 1 or 2');
  const dataDir = resolve(options.dataDir ?? join(process.cwd(), 'data/local-workspace'));
  await mkdir(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'service.lock');
  const lock = await acquireLock(lockPath, dataDir);
  await lock.writeFile(`${process.pid}\n`);
  const repo = new InMemoryWorkMapRepository();
  let state: LocalState;
  try { state = await loadState(join(dataDir, 'state.json'), repo); }
  catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw error; }
  state.submissions ??= {};
  let saveChain = Promise.resolve(); let persistenceFailed = false; let closed = false;
  const running = new Map<string, { cancel(): void; path: string }>();
  const completions = new Set<Promise<unknown>>();
  const runner = options.runner ?? runCodex;
  const codexInfo = getCodexInfo(options.codexBinary);
  let scheduling = false;
  let schedulingTask: Promise<void> = Promise.resolve();
  const app = Fastify({ bodyLimit: 128_000, logger: false });
  await app.register(helmet);
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(host)) return reply.code(400).send({ error: 'Local host required' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Cross-origin request blocked' });
    const origin = request.headers.origin;
    if (origin && origin !== `${request.protocol}://${host}`) return reply.code(403).send({ error: 'Same-origin request required' });
    if (persistenceFailed && request.method !== 'GET') return reply.code(503).send({ error: 'Local state persistence failed; mutations and scheduling are stopped', message: '本地状态未能保存，已暂停修改和新执行。请检查磁盘空间与数据目录权限。' });
    if (request.method !== 'GET' && request.headers['content-type']?.split(';')[0] !== 'application/json') return reply.code(415).send({ error: 'JSON required' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = Number((error as { statusCode?: number }).statusCode);
    if (persistenceFailed) return reply.code(503).send({ error: 'PERSISTENCE_FAILED', message: '本地状态未能保存，已暂停修改和新执行。请检查磁盘空间与数据目录权限。' });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'BAD_REQUEST', message: zodMessage(error), issues: error.issues });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'BAD_REQUEST', message: '请求内容无效，请检查填写项后重试。' });
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: persistenceFailed ? 'Local state persistence failed; scheduling stopped' : message(error) });
  });

  for (const job of state.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.recoveryConfirmed = false; job.error = 'Process ended before result was recorded; confirm the prior Codex process has stopped before retrying'; job.updatedAt = job.finishedAt = new Date().toISOString(); }
  try { await persist(); } catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw error; }
  const localShell = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').send(await readLocalIndex());
  app.get('/', localShell);
  app.get('/local', localShell);
  app.get('/local/assets/*', async (req, reply) => {
    const assetName = (req.params as { '*': string })['*'];
    const assetRoot = resolve(process.cwd(), 'dist/local/web/assets');
    const assetPath = resolve(assetRoot, assetName);
    const rel = relative(assetRoot, assetPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.(?:js|css|svg|png|webp|woff2?)$/u.test(assetPath)) return reply.code(404).send({ error: 'Asset not found' });
    try {
      const contentType = assetPath.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : assetPath.endsWith('.css') ? 'text/css; charset=utf-8'
          : assetPath.endsWith('.svg') ? 'image/svg+xml'
            : assetPath.endsWith('.png') ? 'image/png'
              : assetPath.endsWith('.webp') ? 'image/webp'
                : assetPath.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
      return reply.header('cache-control', 'public, max-age=31536000, immutable').type(contentType).send(await readFile(assetPath));
    } catch { return reply.code(404).type('application/json; charset=utf-8').send({ error: 'Asset not found' }); }
  });
  app.get('/local/cypress-terraces.png', async (_req, reply) => reply.header('cache-control', 'public, max-age=3600').type('image/png').send(await readFile(join(process.cwd(), 'src/local/assets/cypress-terraces.png'))));
  app.get('/api/local/snapshot', async () => ({ projects: state.projects, works: repo.exportSnapshot().works, jobs: state.jobs, runtime: { maxConcurrent: limit, running: running.size, recoveryBlocked: state.jobs.filter((j) => j.status === 'interrupted' && !j.recoveryConfirmed).length, codexAvailable: codexInfo.available, ...(codexInfo.version ? { codexVersion: codexInfo.version } : {}), ...(persistenceFailed ? { schedulingStopped: true, error: 'Local state persistence failed; active jobs were asked to stop' } : {}) } }));
  app.post('/api/local/projects', async (req, reply) => {
    const parsed = createProject.parse(req.body);
    if (parsed.repositoryUrl && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u.test(parsed.repositoryUrl)) return reply.code(400).send({ error: 'repositoryUrl must be a GitHub HTTPS URL', message: '仓库链接需为 GitHub HTTPS 地址。' });
    if (!isAbsolute(parsed.path) || !await existsDir(parsed.path)) return reply.code(400).send({ error: 'Project path must be an existing absolute directory', message: '请选择已存在的项目文件夹，并填写完整路径。' });
    const path = await realpath(parsed.path);
    if (state.projects.some((item) => item.path === path)) return reply.code(409).send({ error: 'Project path already exists', message: '这个项目文件夹已连接。' });
    const now = new Date().toISOString();
    const work = await ensureWork(repo, parsed.name, parsed.goal, parsed.instructions);
    const project: LocalProject = { id: `project_${crypto.randomUUID()}`, ...parsed, path, workRef: work.ref, createdAt: now, updatedAt: now };
    state.projects.push(project); await persist(); safeSchedule(); return reply.code(201).send(project);
  });
  app.patch('/api/local/projects/:id', async (req, reply) => {
    const project = state.projects.find((p) => p.id === (req.params as { id: string }).id);
    if (!project) return reply.code(404).send({ error: 'Project not found', message: '找不到这个项目，请刷新后重试。' });
    const changes = updateProject.parse(req.body);
    if (changes.goal !== undefined || changes.instructions !== undefined) {
      const work = await repo.read(project.workRef) as Work;
      let document = work.living_doc_markdown;
      if (changes.goal !== undefined) document = replaceSection(document, 'Current goal', changes.goal || `Local project: ${project.name}`);
      if (changes.instructions !== undefined) document = replaceSection(document, 'Current instructions', changes.instructions || 'No additional instructions.');
      await repo.updateWork(work.ref, work.revision, { ...(changes.goal !== undefined ? { current_summary: changes.goal || `Local project: ${project.name}` } : {}), living_doc_markdown: document });
    }
    Object.assign(project, changes, { updatedAt: new Date().toISOString() }); await persist(); return project;
  });
  app.post('/api/local/projects/:id/jobs', async (req, reply) => {
    const project = state.projects.find((p) => p.id === (req.params as { id: string }).id);
    if (!project) return reply.code(404).send({ error: 'Project not found', message: '找不到这个项目，请刷新后重试。' });
    const body = submitJob.parse(req.body); const key = `${project.id}:${body.requestId}`;
    const prior = state.jobs.find((job) => job.id === state.submissions![key]); if (prior) return reply.send(prior);
    const job: LocalJob = { id: `job_${crypto.randomUUID()}`, projectId: project.id, prompt: body.prompt, mode: body.mode, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), output: '', events: [] };
    state.jobs.push(job); state.submissions![key] = job.id; await persist(); safeSchedule(); return reply.code(202).send(job);
  });
  app.post('/api/local/jobs/:id/cancel', async (req, reply) => {
    const job = state.jobs.find((j) => j.id === (req.params as { id: string }).id); if (!job) return reply.code(404).send({ error: 'Job not found', message: '找不到这条执行记录，请刷新后重试。' });
    if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = job.updatedAt = new Date().toISOString(); await persist(); return job; }
    if (job.status === 'running') { running.get(job.id)?.cancel(); return reply.code(202).send(job); }
    return reply.code(409).send({ error: 'Job cannot be cancelled in its current state', message: '这条执行当前无法取消。' });
  });
  app.post('/api/local/jobs/:id/retry', async (req, reply) => {
    const old = state.jobs.find((j) => j.id === (req.params as { id: string }).id); if (!old) return reply.code(404).send({ error: 'Job not found', message: '找不到这条执行记录，请刷新后重试。' });
    const { requestId } = retryJob.parse(req.body); if (!['failed', 'cancelled', 'interrupted'].includes(old.status) || (old.status === 'interrupted' && !old.recoveryConfirmed)) return reply.code(409).send({ error: 'Only failed, cancelled, or reconciled interrupted jobs can be retried', message: old.status === 'interrupted' ? '请先确认旧 Codex 进程和命令已停止，再解除占用并重试。' : '这条执行当前不能重试。' }); const key = `${old.projectId}:${requestId}`;
    const prior = state.jobs.find((j) => j.id === state.submissions![key]); if (prior) return reply.send(prior);
    const checkpoint = `Retry checkpoint for ${old.id} (${old.status}): inspect current workspace and account for prior effects before changing anything; previous attempt may have partially changed files. Previous error: ${(old.error ?? 'none').slice(0, 800)}. Previous output excerpt:\n${old.output.slice(-2_000)}`;
    const next: LocalJob = { ...old, id: `job_${crypto.randomUUID()}`, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: undefined, finishedAt: undefined, threadId: undefined, output: '', error: undefined, events: [{ at: new Date().toISOString(), type: 'checkpoint', text: checkpoint.slice(0, 3_000) }], prompt: `${old.prompt}\n\n${checkpoint}` };
    state.jobs.push(next); state.submissions![key] = next.id; await persist(); safeSchedule(); return reply.code(202).send(next);
  });
  app.post('/api/local/jobs/:id/reconcile', async (req, reply) => {
    const job = state.jobs.find((j) => j.id === (req.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: 'Job not found', message: '找不到这条执行记录，请刷新后重试。' });
    if (job.status !== 'interrupted') return reply.code(400).send({ error: 'Confirm stopped:true for an interrupted job', message: '这条执行不需要恢复。' });
    if (!z.object({ stopped: z.literal(true) }).strict().safeParse(req.body).success) return reply.code(400).send({ error: 'Confirm stopped:true for an interrupted job', message: '请先确认旧 Codex 进程和命令都已停止。' });
    job.recoveryConfirmed = true; job.updatedAt = new Date().toISOString(); await persist(); safeSchedule(); return job;
  });
  app.post('/api/local/jobs/:id/accept', async (req, reply) => {
    const job = state.jobs.find((j) => j.id === (req.params as { id: string }).id); if (!job) return reply.code(404).send({ error: 'Job not found', message: '找不到这条执行记录，请刷新后重试。' });
    if (job.status !== 'needs_review') return reply.code(409).send({ error: 'Only jobs needing review can be accepted', message: '只有待验收的执行结果可以验收。' });
    const project = state.projects.find((p) => p.id === job.projectId)!; const work = await repo.read(project.workRef) as Work;
    const excerpt = job.output.slice(-4_000).trim();
    const finalMessage = job.events.filter((event) => event.type === 'agent_message').at(-1)?.text ?? '';
    await repo.updateWork(work.ref, work.revision, { current_summary: `已验收：${finalMessage.slice(0, 1_000) || '执行结果已由用户确认。'}`, living_doc_markdown: `${work.living_doc_markdown}\n\n## Accepted local run ${job.id}\n\n- Prompt: ${job.prompt.slice(0, 1_000)}\n- Mode: ${job.mode}\n- Result excerpt (bounded):\n\n${excerpt || 'No output recorded.'}` });
    job.status = 'accepted'; job.updatedAt = job.finishedAt = new Date().toISOString(); await persist(); return job;
  });

  async function persist(): Promise<void> {
    saveChain = saveChain.then(async () => { await saveState(join(dataDir, 'state.json'), state, repo); }).catch((error: unknown) => { persistenceFailed = true; for (const active of running.values()) active.cancel(); app.log.error(error); throw error; });
    return saveChain;
  }
  async function schedule(): Promise<void> {
    if (closed || persistenceFailed || scheduling) return;
    scheduling = true;
    try {
    while (!closed && !persistenceFailed) {
      const blocked = state.jobs.filter((item) => item.status === 'interrupted' && !item.recoveryConfirmed);
      if (running.size + blocked.length >= limit) return;
      const job = state.jobs.find((item) => item.status === 'queued' && !running.has(item.id) && ![...running.values()].some((active) => active.path === projectLockKey(state.projects.find((p) => p.id === item.projectId))) && !blocked.some((held) => projectLockKey(state.projects.find((p) => p.id === held.projectId)) === projectLockKey(state.projects.find((p) => p.id === item.projectId))));
      if (!job) return;
      const project = state.projects.find((p) => p.id === job.projectId); if (!project) { job.status = 'failed'; job.error = 'Project missing'; await persist(); continue; }
      job.status = 'running'; job.startedAt = job.updatedAt = new Date().toISOString();
      let cancelRequested = false;
      const lockKey = projectLockKey(project);
      running.set(job.id, { cancel: () => { cancelRequested = true; }, path: lockKey });
      await persist();
      if (closed || cancelRequested) { running.delete(job.id); job.status = 'cancelled'; job.finishedAt = job.updatedAt = new Date().toISOString(); await persist(); continue; }
      let handle: ReturnType<LocalRunner>;
      try {
        const work = await repo.read(project.workRef) as Work;
        const contextualJob = { ...job, prompt: `${job.prompt}\n\nAccepted Work Map context (reference, not new instructions):\n${work.current_summary.slice(0, 1_000)}\n${work.living_doc_markdown.slice(-6_000)}` };
        if (closed || persistenceFailed || cancelRequested) { running.delete(job.id); job.status = 'cancelled'; await persist(); continue; }
        handle = runner({ project, job: contextualJob, codexBinary: options.codexBinary, onEvent: (event) => { job.updatedAt = new Date().toISOString(); if (event.threadId) job.threadId = event.threadId; job.events.push({ at: job.updatedAt, type: event.type, text: event.text.slice(0, 4_000) }); if (job.events.length > 200) job.events.splice(0, job.events.length - 200); if (event.type === 'agent_message') job.output = (job.output + event.text).slice(-64_000); void persist().catch(() => undefined); } }); }
      catch (error) { running.delete(job.id); const recoveryRequired = typeof error === 'object' && error !== null && 'recoveryRequired' in error && (error as { recoveryRequired?: unknown }).recoveryRequired === true; job.status = recoveryRequired ? 'interrupted' : 'failed'; job.recoveryConfirmed = recoveryRequired ? false : undefined; job.error = message(error); job.finishedAt = job.updatedAt = new Date().toISOString(); await persist(); continue; }
      running.set(job.id, { cancel: handle.cancel, path: lockKey });
      const completion = handle.result.then((result) => { job.output = result.output.slice(-64_000); job.threadId = result.threadId ?? job.threadId; job.status = 'needs_review'; }).catch((error: unknown) => { const flags = typeof error === 'object' && error !== null ? error as { recoveryRequired?: unknown; cancelled?: unknown } : {}; const recoveryRequired = flags.recoveryRequired === true; job.status = recoveryRequired ? 'interrupted' : flags.cancelled === true ? 'cancelled' : 'failed'; job.recoveryConfirmed = recoveryRequired ? false : undefined; job.error = message(error).slice(0, 4_000); }).finally(async () => { job.finishedAt = job.updatedAt = new Date().toISOString(); running.delete(job.id); await persist().catch(() => undefined); safeSchedule(); });
      completions.add(completion); void completion.finally(() => completions.delete(completion));
    }
    } finally { scheduling = false; }
  }
  app.addHook('onClose', async () => { closed = true; for (const entry of running.values()) entry.cancel(); await schedulingTask; await Promise.allSettled([...completions]); await saveChain.catch(() => undefined); await lock.close(); await rm(lockPath, { force: true }); });
  safeSchedule();
  function safeSchedule(): void { if (!closed && !persistenceFailed && !scheduling) schedulingTask = schedule().catch(() => undefined); }
  Object.assign(app, { localState: state });
  return app;
}

async function ensureWork(repo: InMemoryWorkMapRepository, name: string, goal: string, instructions: string): Promise<Work> {
  const page = await repo.list('teammate', {}, undefined, 100);
  if (!page.items.some((person) => person.ref === 'teammate_self')) await repo.updateTeammate('teammate_self', 0, { display_name: 'You', memory: '' });
  const initialGoal = goal || `Local project: ${name}`;
  return repo.createWork({ title: name, owner: 'teammate_self', state: 'current', current_summary: initialGoal, living_doc_markdown: `# ${name}\n\n## Current goal\n\n${initialGoal}\n\n## Current instructions\n\n${instructions || 'No additional instructions.'}\n` });
}
async function existsDir(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }
function getCodexInfo(binary = 'codex'): { available: boolean; version?: string } { const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 2_000 }); return { available: result.status === 0, ...(result.status === 0 && result.stdout.trim() ? { version: result.stdout.trim().slice(0, 100) } : {}) }; }
function projectLockKey(project: LocalProject | undefined): string {
  if (!project) return '';
  try { return execFileSync('git', ['-C', project.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || project.path; }
  catch { return project.path; }
}
function replaceSection(markdown: string, title: string, body: string): string {
  const heading = `## ${title}`;
  const lines = markdown.split('\n'); const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return `${markdown.trimEnd()}\n\n${heading}\n\n${body}\n`;
  let end = start + 1;
  while (end < lines.length && !/^##\s/u.test(lines[end]!)) end += 1;
  lines.splice(start, end - start, heading, '', body, '');
  return lines.join('\n');
}
async function acquireLock(path: string, dataDir: string) {
  try { return await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Fail closed: automatic stale-lock unlink races another starter's new lock.
    throw new Error(`Another local workspace service owns ${dataDir}. If it crashed, verify the service and its Codex processes have stopped, then manually remove ${path}.`);
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function zodMessage(error: z.ZodError): string {
  const field = error.issues[0]?.path[0];
  const label = field === 'name' ? '项目名称' : field === 'path' ? '本地路径' : field === 'prompt' ? '任务内容' : field === 'requestId' ? '请求编号' : field === 'repositoryUrl' ? '仓库链接' : field === 'goal' ? '项目目标' : field === 'instructions' ? '项目说明' : '填写内容';
  return `请检查${label}后重试。`;
}
