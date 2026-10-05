import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LocalJob, LocalProject, LocalState } from '../../types';
import type { Work } from '../../../domain/model';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';

type Snapshot = LocalState & {
  works?: Work[];
  runtime?: {
    maxConcurrent?: number;
    running?: number;
    recoveryBlocked?: number;
    codexAvailable?: boolean;
    codexVersion?: string;
    error?: string;
    schedulingStopped?: boolean;
  };
};
type Mode = LocalJob['mode'];
type Draft = { prompt: string; mode: Mode };
type Action = 'accept' | 'cancel' | 'retry' | 'reconcile';

const statusText: Record<LocalJob['status'], string> = {
  queued: '排队中', running: '执行中', needs_review: '待验收', accepted: '已接受',
  failed: '失败', cancelled: '已取消', interrupted: '已中断',
};
const date = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
};
const firstLine = (text: string, limit = 84): string => {
  const line = text.split(/\r?\n/u, 1)[0]?.trim() || '新任务';
  return [...line].length > limit ? `${[...line].slice(0, limit).join('')}…` : line;
};
function resultFor(job: LocalJob): { text: string; possiblyTruncated: boolean } {
  const event = [...job.events].reverse().find((item) => item.type === 'agent_message');
  if (!event) return { text: '', possiblyTruncated: false };
  if (event.text.length < 4_000) return { text: event.text, possiblyTruncated: false };
  const index = job.output.lastIndexOf(event.text);
  if (index >= 0) return { text: job.output.slice(index), possiblyTruncated: false };
  return { text: event.text, possiblyTruncated: true };
}
function sortedProjectJobs(jobs: LocalJob[], projectId: string): LocalJob[] {
  const order: Record<LocalJob['status'], number> = { needs_review: 0, running: 1, queued: 2, failed: 3, interrupted: 4, cancelled: 5, accepted: 6 };
  return jobs.filter((job) => job.projectId === projectId).sort((a, b) => order[a.status] - order[b.status] || b.createdAt.localeCompare(a.createdAt));
}
function projectState(jobs: LocalJob[], projectId: string): string {
  const own = jobs.filter((job) => job.projectId === projectId);
  if (own.some((job) => job.status === 'needs_review')) return '待验收';
  if (own.some((job) => job.status === 'running')) return '执行中';
  if (own.some((job) => job.status === 'queued')) return '排队中';
  if (own.some((job) => job.status === 'interrupted' && !job.recoveryConfirmed)) return '待恢复';
  const latest = [...own].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest?.status === 'failed') return '失败';
  if (latest?.status === 'interrupted') return '已中断';
  return '';
}
async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
  if (!response.ok) throw new Error(data.message ?? data.error ?? `请求失败（${response.status}）`);
  return data as T;
}

function ResultDetails({ job, result }: { job: LocalJob; result: ReturnType<typeof resultFor> }) {
  const [open, setOpen] = useState(job.status === 'needs_review');
  return <details className="col-span-2 text-xs text-muted-foreground" open={open} onToggle={(event) => {
    const nextOpen = event.currentTarget.open;
    setOpen((current) => current === nextOpen ? current : nextOpen);
  }}>
    <summary className="min-h-8 cursor-pointer py-1">结果</summary>
    {result.text ? <div className="max-w-[74ch] whitespace-pre-wrap break-words py-1 text-[13px] leading-7 text-foreground">{result.text}</div> : <p className="py-1">还没有最终答复。可以查看运行日志了解进度。</p>}
    {result.possiblyTruncated && <p className="py-1">这条结果可能超过已保存的单条消息长度；运行日志保留其余可用输出。</p>}
  </details>;
}

function JobItem({ job, onAction, busy }: { job: LocalJob; onAction: (action: Action, job: LocalJob) => void; busy: string }) {
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const result = resultFor(job);
  const accepted = job.status === 'accepted';
  const logs = job.events.filter((event) => event.type !== 'agent_message');
  const rawLog = result.text && job.output.endsWith(result.text) ? job.output.slice(0, -result.text.length).trimEnd() : job.output;
  const interrupted = job.status === 'interrupted' && !job.recoveryConfirmed;
  const retryable = ['failed', 'cancelled'].includes(job.status) || (job.status === 'interrupted' && job.recoveryConfirmed);
  const active = job.status === 'queued' || job.status === 'running';
  const act = (action: Action) => () => onAction(action, job);

  return <article className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-t border-border py-3 first:border-0 ${accepted ? 'py-2' : ''}`}>
    <div className="min-w-0">
      <h3 className="line-clamp-2 break-words text-[13px] font-semibold leading-5">{firstLine(job.prompt)}</h3>
      <details className="mt-1 text-xs text-muted-foreground">
        <summary className="min-h-8 cursor-pointer py-1">完整任务</summary>
        <pre className="max-h-[420px] max-w-[78ch] overflow-auto rounded-sm border border-border bg-muted p-3 text-[13px] leading-relaxed">{job.prompt}</pre>
      </details>
    </div>
    <Badge className={`h-fit whitespace-nowrap rounded-sm ${job.status === 'accepted' ? 'bg-[#dfe9df] text-[#28513f]' : job.status === 'failed' || job.status === 'interrupted' ? 'bg-[#f1e1dc] text-[#71332d]' : job.status === 'running' || job.status === 'queued' ? 'bg-[#e9e4d5] text-[#654c20]' : ''}`}>
      {statusText[job.status]}
    </Badge>

    {(job.status === 'needs_review' || accepted) && <ResultDetails key={`${job.id}:${job.status}`} job={job} result={result} />}

    {!accepted && <div className="col-span-2 flex min-h-8 flex-wrap items-center gap-2">
      {job.status === 'needs_review' && <Button className="min-h-11 rounded-sm" onClick={act('accept')} disabled={busy === `${job.id}:accept`}>接受结果</Button>}
      {retryable && <Button className="min-h-11 rounded-sm" variant="outline" onClick={act('retry')} disabled={busy === `${job.id}:retry`}>重试</Button>}
      {active && <Button className="min-h-11 rounded-sm" variant="outline" onClick={act('cancel')} disabled={busy === `${job.id}:cancel`}>取消</Button>}
      {job.status !== 'needs_review' && <span className="text-xs text-muted-foreground">{date(job.updatedAt)}</span>}
    </div>}

    {interrupted && <details className="col-span-2 rounded-sm border border-border bg-[#e7e5db] p-3 text-sm" open={interrupted}>
      <summary className="min-h-8 cursor-pointer font-medium">恢复前确认</summary>
      <p className="my-2 leading-relaxed">请先确认旧 Codex 执行和它启动的命令都已停止，再解除占用。</p>
      <label className="flex min-h-11 items-center gap-2 py-1">
        <input className="size-4 accent-[#28513f]" type="checkbox" checked={recoveryConfirmed} onChange={(event) => setRecoveryConfirmed(event.currentTarget.checked)} />
        我已确认它们已停止
      </label>
      <Button data-reconcile disabled={!recoveryConfirmed || busy === `${job.id}:reconcile`} className="min-h-11 rounded-sm" variant="outline" onClick={act('reconcile')}>解除占用</Button>
    </details>}

    <details className="col-span-2 text-xs text-muted-foreground">
      <summary className="min-h-8 cursor-pointer py-1">运行日志</summary>
      {rawLog ? <pre className="max-h-[420px] max-w-[78ch] overflow-auto rounded-sm border border-border bg-muted p-3 text-[13px] leading-relaxed">{rawLog}</pre> : <p className="py-2">暂无其他运行输出。</p>}
      {job.error && <p className="py-2 text-destructive">{job.error}</p>}
      {job.threadId && <p className="break-all py-2">Thread：{job.threadId}</p>}
      {logs.length > 0 && <ul className="max-h-56 list-disc space-y-1 overflow-auto py-2 pl-5">{logs.map((event, index) => <li key={`${event.at}-${event.type}-${index}`}>{date(event.at)} · {event.type} · {event.text}</li>)}</ul>}
    </details>
  </article>;
}

function ProjectSettings({ project, onSave }: { project: LocalProject; onSave: (project: LocalProject, changes: { goal: string; instructions: string }) => Promise<void> }) {
  const [goal, setGoal] = useState(project.goal);
  const [instructions, setInstructions] = useState(project.instructions);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('');
    try { await onSave(project, { goal, instructions }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
    finally { setSaving(false); }
  }
  return <PopoverContent align="end" sideOffset={7} className="z-20 w-[min(420px,calc(100vw-24px))] max-h-[min(78vh,680px)] overflow-auto rounded-sm border-border bg-card p-4 text-foreground shadow-lg">
    <div className="mb-3 break-words text-xs leading-relaxed text-muted-foreground"><strong className="text-foreground">本地文件夹</strong><br />{project.path}</div>
    {project.repositoryUrl && <div className="mb-3 break-all text-xs leading-relaxed text-muted-foreground"><strong className="text-foreground">Repository</strong><br />{project.repositoryUrl}</div>}
    <form className="grid gap-3" onSubmit={submit}>
      <Label className="grid gap-1.5 text-xs font-semibold">项目目标<Textarea value={goal} rows={3} placeholder="项目当前要达成什么" onChange={(event) => setGoal(event.target.value)} /></Label>
      <Label className="grid gap-1.5 text-xs font-semibold">项目说明<Textarea value={instructions} rows={3} placeholder="长期约定或执行边界" onChange={(event) => setInstructions(event.target.value)} /></Label>
      <div className="flex min-h-11 flex-wrap items-center gap-2"><Button className="min-h-11 rounded-sm" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>{error && <span className="text-xs text-destructive" role="alert">{error}</span>}</div>
    </form>
  </PopoverContent>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [submittingJob, setSubmittingJob] = useState(false);
  const submissionInFlight = useRef(false);
  const [selectedId, setSelectedId] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectMore, setConnectMore] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [jobError, setJobError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [connectFields, setConnectFields] = useState({ name: '', path: '', repositoryUrl: '', goal: '', instructions: '' });

  const refresh = useCallback(async () => {
    try {
      const next = await request<Snapshot>('/api/local/snapshot');
      setSnapshot(next); setLoadError(''); setInitialLoading(false);
    } catch (cause) {
      setLoadError(cause instanceof Error ? `本地服务连接失败：${cause.message}` : '本地服务连接失败。');
      setInitialLoading(false);
    }
  }, []);
  const active = Boolean(snapshot?.jobs.some((job) => job.status === 'queued' || job.status === 'running'));
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(poll, active ? 3_000 : 10_000);
    };
    void poll();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [refresh, active]);

  const project = snapshot?.projects.find((item) => item.id === selectedId) ?? snapshot?.projects[0];
  const selected = project?.id ?? '';
  const jobs = snapshot && selected ? sortedProjectJobs(snapshot.jobs, selected) : [];
  const draft = drafts[selected] ?? { prompt: '', mode: 'read-only' as const };
  const runtime = snapshot?.runtime;
  const codexAvailable = runtime?.codexAvailable !== false;
  const submitBlocked = Boolean(runtime?.schedulingStopped) || !codexAvailable;
  const works = snapshot?.works ?? snapshot?.workMap.works ?? [];
  const workByRef = new Map(works.map((work) => [work.ref, work]));
  const projectWork = workByRef.get(project?.workRef ?? '');
  const related = (() => {
    if (!projectWork) return [] as Work[];
    const refs = new Set([projectWork.ref]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const work of works) if (work.parent && refs.has(work.parent) && !refs.has(work.ref)) { refs.add(work.ref); changed = true; }
    }
    return works.filter((work) => refs.has(work.ref));
  })();
  const workSummary = projectWork?.current_summary.trim();
  const hideGeneratedSummary = projectWork && workSummary === `Local project: ${projectWork.title}`;

  async function saveGoal(target: LocalProject, changes: { goal: string; instructions: string }) {
    await request(`/api/local/projects/${encodeURIComponent(target.id)}`, 'PATCH', changes);
    await refresh();
  }
  async function mutate(action: Action, job: LocalJob) {
    setActionError(''); setBusy(`${job.id}:${action}`);
    try {
      const url = `/api/local/jobs/${encodeURIComponent(job.id)}/${action}`;
      const body = action === 'retry' ? { requestId: crypto.randomUUID() } : action === 'reconcile' ? { stopped: true } : {};
      await request(url, 'POST', body); await refresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { setBusy(''); }
  }
  async function submitConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setConnecting(true); setConnectError('');
    try {
      const added = await request<LocalProject>('/api/local/projects', 'POST', connectFields);
      setConnectFields({ name: '', path: '', repositoryUrl: '', goal: '', instructions: '' }); setConnectMore(false); setConnectOpen(false);
      await refresh(); setSelectedId(added.id);
    } catch (cause) { setConnectError(cause instanceof Error ? cause.message : '连接失败，请检查项目名称和文件夹。'); }
    finally { setConnecting(false); }
  }
  async function submitJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!project || initialLoading || submittingJob || submissionInFlight.current || submitBlocked || !draft.prompt.trim()) return;
    submissionInFlight.current = true; setJobError(''); setSubmittingJob(true);
    try {
      await request(`/api/local/projects/${encodeURIComponent(project.id)}/jobs`, 'POST', { prompt: draft.prompt, mode: draft.mode, requestId: crypto.randomUUID() });
      setDrafts((current) => ({ ...current, [project.id]: { prompt: '', mode: 'read-only' } }));
      await refresh();
    } catch (cause) { setJobError(cause instanceof Error ? cause.message : '无法开始任务，请重试。'); }
    finally { submissionInFlight.current = false; setSubmittingJob(false); }
  }

  return <div className="app-enter grid min-h-screen grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)]">
    <aside className="sticky top-0 hidden h-screen flex-col border-r border-border bg-[#e3e7df] px-3 py-4 md:flex">
      <div className="px-2 text-lg font-bold tracking-tight text-[#203b30]">meno<span className="font-normal">team</span></div>
      <div className="mb-2 mt-7 px-2 text-xs font-semibold text-muted-foreground">项目</div>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="本地项目">
        {!snapshot && <p className="px-2 py-2 text-sm text-muted-foreground">读取中…</p>}
        {snapshot?.projects.length === 0 && <p className="px-2 py-2 text-sm text-muted-foreground">暂无项目</p>}
        {snapshot?.projects.map((item) => {
          const state = projectState(snapshot.jobs, item.id);
          return <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} aria-current={item.id === selected ? 'true' : undefined} className={`flex min-h-11 flex-col justify-center rounded-sm border px-2.5 py-1.5 text-left text-sm transition-colors ${item.id === selected ? 'border-[#c4cdc2] bg-[#edf0e9] font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:bg-[#e8ebe4] hover:text-foreground'}`}>
            <span className="w-full truncate">{item.name}</span>{state && <span className="mt-0.5 text-[11px] font-normal text-muted-foreground">{state}</span>}
          </button>;
        })}
      </nav>
      <Button className="mt-3 min-h-11 rounded-sm" variant="outline" onClick={() => setConnectOpen(true)}>连接项目</Button>
      <div className="mt-4 border-t border-border px-2 pt-3 text-xs leading-relaxed text-muted-foreground" role="status">
        <span className={`mr-2 inline-block size-2 rounded-full ${codexAvailable && !runtime?.schedulingStopped ? 'bg-[#34724d]' : 'bg-[#78867b]'}`} />
        {runtime?.schedulingStopped ? `本地 Codex · 执行已暂停：${runtime.error || '本地状态需要处理'}` : `本地 Codex · ${codexAvailable ? '可用' : '不可用'}`}
        {!!runtime?.recoveryBlocked && <div className="mt-1">{runtime.recoveryBlocked} 个执行占用待确认</div>}
      </div>
    </aside>

    <main className="mx-auto min-w-0 w-full max-w-[1480px] px-[15px] pb-12 pt-[18px] sm:px-5 md:px-[clamp(24px,3.4vw,48px)] md:pt-7">
      <header className="-mx-[15px] flex items-start justify-between gap-2 border-b border-border bg-[#e3e7df] px-[15px] py-4 sm:-mx-5 sm:px-5 md:-mx-[clamp(24px,3.4vw,48px)] md:gap-4 md:px-[clamp(24px,3.4vw,48px)]">
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-[21px] font-semibold tracking-[-.015em] text-[#203b30] md:text-2xl">{project?.name ?? (snapshot ? '选择项目' : '正在读取项目…')}</h1>
          {project?.goal && <p className="mt-1 line-clamp-3 max-w-[72ch] whitespace-pre-wrap text-[13px] leading-relaxed text-[#43584c]">{project.goal}</p>}
        </div>
        <div className="flex shrink-0 items-start gap-1.5 sm:gap-2">
          <Button className="min-h-11 rounded-sm md:hidden" variant="outline" onClick={() => setConnectOpen(true)}>连接项目</Button>
          {project && <Popover>
            <PopoverTrigger asChild><Button className="min-h-11 rounded-sm" variant="outline">设置</Button></PopoverTrigger>
            <ProjectSettings key={project.id} project={project} onSave={saveGoal} />
          </Popover>}
        </div>
      </header>

      {loadError && <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert">{loadError}<Button className="min-h-11 rounded-sm" variant="outline" onClick={() => void refresh()}>重试</Button></div>}

      <div className="my-4 md:hidden">
        <Label className="grid gap-1.5 text-xs font-semibold" htmlFor="project-select">项目
          <select id="project-select" className="min-h-11 w-full rounded-sm border border-input bg-card px-3 text-sm text-foreground" value={selected} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">选择项目</option>{snapshot?.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Label>
      </div>

      <form className={`my-4 grid gap-3 border-y border-border bg-[#e6e9e2] px-3 py-4 sm:px-4 ${connectOpen ? '' : 'hidden'}`} aria-label="连接项目" onSubmit={submitConnect}>
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">连接项目</h2><Button className="min-h-11 rounded-sm" type="button" variant="ghost" onClick={() => setConnectOpen(false)}>取消</Button></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label className="grid gap-1.5 text-xs font-semibold">项目名称<Input required maxLength={100} value={connectFields.name} onChange={(event) => setConnectFields((current) => ({ ...current, name: event.target.value }))} placeholder="项目名称" /></Label>
          <Label className="grid gap-1.5 text-xs font-semibold">本地文件夹<Input required value={connectFields.path} onChange={(event) => setConnectFields((current) => ({ ...current, path: event.target.value }))} placeholder="/Users/you/project" /></Label>
        </div>
        <details open={connectMore} onToggle={(event) => setConnectMore(event.currentTarget.open)}>
          <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground">更多选项</summary>
          <div className="grid gap-3 pt-2 sm:grid-cols-2">
            <Label className="grid gap-1.5 text-xs font-semibold">Repository URL<Input type="url" value={connectFields.repositoryUrl} onChange={(event) => setConnectFields((current) => ({ ...current, repositoryUrl: event.target.value }))} placeholder="仅记录，不会 clone" /></Label>
            <Label className="grid gap-1.5 text-xs font-semibold sm:col-span-2">项目目标<Textarea value={connectFields.goal} onChange={(event) => setConnectFields((current) => ({ ...current, goal: event.target.value }))} placeholder="当前目标" /></Label>
            <Label className="grid gap-1.5 text-xs font-semibold sm:col-span-2">项目说明<Textarea value={connectFields.instructions} onChange={(event) => setConnectFields((current) => ({ ...current, instructions: event.target.value }))} placeholder="长期约定" /></Label>
          </div>
        </details>
        <div className="flex min-h-11 flex-wrap items-center gap-2"><Button className="min-h-11 rounded-sm" type="submit" disabled={connecting}>{connecting ? '连接中…' : '连接'}</Button>{connectError && <span className="text-sm text-destructive" role="alert">{connectError}</span>}</div>
      </form>

      <div className="grid min-w-0 grid-cols-1 gap-1 pt-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,.8fr)] lg:gap-10 lg:pt-5">
        <div className="min-w-0">
          <section className="mb-7">
            <h2 className="mb-2.5 text-base font-semibold tracking-wide text-[#29453a]">新任务</h2>
            <form className="grid gap-3" onSubmit={submitJob}>
              <Label className="sr-only" htmlFor="job-prompt">任务内容</Label>
              <Textarea id="job-prompt" required rows={3} value={draft.prompt} onChange={(event) => setDrafts((current) => ({ ...current, [selected]: { ...draft, prompt: event.target.value } }))} placeholder="要调查或完成什么？" disabled={!project || initialLoading || submittingJob || submitBlocked} className="min-h-[88px] rounded-sm border-input bg-card text-sm leading-relaxed" />
              <fieldset className="border-0 p-0">
                <legend className="sr-only">文件权限</legend>
                <div className="flex flex-wrap gap-1.5">
                  {(['read-only', 'workspace-write'] as const).map((mode) => <label key={mode} className="flex min-h-11 flex-1 basis-[110px] cursor-pointer items-center gap-2 border border-border bg-[#e8ebe4] px-3 py-2 text-sm text-[#30483b]">
                    <input className="size-4 accent-[#28513f]" type="radio" name={`mode-${selected}`} value={mode} checked={draft.mode === mode} disabled={!project || initialLoading || submittingJob || submitBlocked} onChange={() => setDrafts((current) => ({ ...current, [selected]: { ...draft, mode } }))} />
                    <span>{mode === 'read-only' ? '只读' : '允许改文件'}</span>
                  </label>)}
                </div>
              </fieldset>
              <div className="flex min-h-11 flex-wrap items-center gap-2"><Button className="min-h-11 rounded-sm" type="submit" disabled={!project || initialLoading || submittingJob || submitBlocked || !draft.prompt.trim()}>{submittingJob ? '提交中…' : '开始'}</Button>
                {jobError && <span className="text-xs text-destructive" role="alert">{jobError}</span>}
                {(!project || submitBlocked) && <span className="text-xs text-muted-foreground" role="status">{!project ? '先连接项目。' : runtime?.schedulingStopped ? `执行已暂停：${runtime.error || '请先处理本地状态。'}` : '本机 Codex 不可用，暂时无法开始任务。'}</span>}
              </div>
            </form>
          </section>

          <section className="mb-7">
            <div className="mb-2.5 flex min-h-8 flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold tracking-wide text-[#29453a]">任务</h2>{actionError && <span className="text-xs text-destructive" role="alert">{actionError}</span>}</div>
            <div className="grid min-w-0">{!snapshot ? <div className="border-t border-border py-3 text-sm text-muted-foreground">{initialLoading ? '正在读取任务…' : loadError ? '暂时无法读取任务。' : '暂无任务。'}</div> : !project ? <div className="border-t border-border py-3 text-sm text-muted-foreground">暂无任务。</div> : jobs.length ? jobs.map((job) => <JobItem key={job.id} job={job} busy={busy} onAction={(action, target) => void mutate(action, target)} />) : <div className="border-t border-border py-3 text-sm text-muted-foreground">暂无任务。</div>}</div>
          </section>
        </div>

        <aside className="min-w-0">
          <section className="mb-4">
            <h2 className="mb-2.5 text-base font-semibold tracking-wide text-[#29453a]">Work Map</h2>
            <div className="border border-[#d0d6cd] bg-[#e5e9e1] px-3.5 py-3.5">
              {!snapshot ? <p className="py-2 text-sm text-muted-foreground">正在读取…</p> : !projectWork ? <p className="py-2 text-sm text-muted-foreground">暂无关联 Work</p> : <>
                <div className="border-b border-[#c9d0c6] py-2 first:border-0"><p className="text-xs text-[#40574a]">{projectWork.state === 'completed' ? '项目已完成' : '项目进行中'}</p>
                  {workSummary && workSummary !== project?.goal.trim() && !hideGeneratedSummary && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-[#40574a]">{workSummary}</p>}
                  {projectWork.living_doc_markdown && <details className="mt-1 text-xs text-[#43594c]"><summary className="min-h-8 cursor-pointer py-1">项目记录</summary><pre className="max-h-[420px] overflow-auto border border-border bg-muted p-3 text-[13px] leading-relaxed">{projectWork.living_doc_markdown}</pre></details>}
                </div>
                {related.filter((work) => work.ref !== projectWork.ref).map((work) => <div className="border-t border-[#c9d0c6] py-2" key={work.ref}><h3 className="text-[13px] font-semibold">{work.title}</h3><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-[#40574a]">{work.state === 'completed' ? '已完成' : '进行中'}{work.current_summary ? ` · ${work.current_summary}` : ''}</p></div>)}
              </>}
            </div>
          </section>
          <figure className="ml-auto mt-3 w-full max-w-[300px] border border-[#c4cbc1] bg-[#dfe3dc] p-1 shadow-[5px_7px_18px_#263d3314]">
            <img className="block aspect-[.72] w-full object-cover object-center max-lg:h-[170px] max-lg:aspect-auto max-lg:object-[center_42%]" src="/local/cypress-terraces.png" alt="" aria-hidden="true" loading="lazy" decoding="async" />
          </figure>
        </aside>
      </div>
    </main>
  </div>;
}

export { App };
