import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../../local/web/src/components/ui/badge';
import { Button } from '../../local/web/src/components/ui/button';
import { Input } from '../../local/web/src/components/ui/input';
import { Label } from '../../local/web/src/components/ui/label';
import { Textarea } from '../../local/web/src/components/ui/textarea';
import type { Artifact, Member, Message, Project, Run, Setting, Work } from '../types';
import { ApiError, workbenchApi, type Snapshot } from './api';
import { canManageProject, filterWorks, readRoute, selectProject, selectWork, type Route, type View } from './routes';
import { cancelInstructionsDraft, completeInstructionsSave, editInstructionsDraft, hasRemoteInstructionsUpdate, keepInstructionsDraft, startInstructionsDraft, useLatestInstructions } from './instructions-draft';
import { createSnapshotRequestHandler } from './snapshot-request';

function href(view: View, projectId = '', workId = '') {
  const url = new URL('/workbench/', window.location.origin);
  if (view !== 'all') url.searchParams.set('view', view);
  if (projectId) url.searchParams.set('project', projectId);
  if (workId) url.searchParams.set('work', workId);
  return `${url.pathname}${url.search}`;
}

const messageOrder = (a: Message, b: Message) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function App() {
  const route = readRoute(window.location.href);
  const inviteToken = new URL(window.location.href).searchParams.get('invite');
  const [member, setMember] = useState<Member | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sessionState, setSessionState] = useState<'loading' | 'authenticating' | 'anonymous' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const sessionGenerationRef = useRef(0);
  const snapshotRequestsEnabledRef = useRef(true);

  const invalidateSession = useCallback((state: 'loading' | 'authenticating' | 'anonymous') => {
    const generation = ++sessionGenerationRef.current;
    snapshotRequestsEnabledRef.current = false;
    setSnapshot(null); setMember(null); setError(''); setSessionState(state);
    return generation;
  }, []);

  const requestSnapshot = useCallback(createSnapshotRequestHandler(
    () => workbenchApi.snapshot(),
    () => sessionGenerationRef.current,
    (next: Snapshot) => {
      setSnapshot(next);
      setMember(next.member);
      setError('');
      setSessionState('ready');
    },
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) invalidateSession('anonymous');
      else setError(errorMessage(cause));
    },
    () => snapshotRequestsEnabledRef.current,
  ), [invalidateSession]);

  const checkSession = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    setError(''); setSessionState('loading');
    try {
      const current = await workbenchApi.me();
      if (generation !== sessionGenerationRef.current) return;
      setMember(current);
      snapshotRequestsEnabledRef.current = true;
      setSessionState('ready');
    } catch (cause) {
      if (generation !== sessionGenerationRef.current) return;
      if (cause instanceof ApiError && cause.status === 401) invalidateSession('anonymous');
      else { setError(errorMessage(cause)); setSessionState('error'); }
      return;
    }
    await requestSnapshot().catch(() => undefined);
  }, [invalidateSession, requestSnapshot]);

  const sessionGeneration = sessionGenerationRef.current;
  const refresh = useCallback(async () => {
    if (sessionGeneration !== sessionGenerationRef.current) return;
    await requestSnapshot();
  }, [requestSnapshot, sessionGeneration]);

  useEffect(() => {
    void checkSession();
    return () => { ++sessionGenerationRef.current; snapshotRequestsEnabledRef.current = false; };
  }, [checkSession]);

  useEffect(() => {
    if (sessionState !== 'ready') return;
    const sessionGeneration = sessionGenerationRef.current;
    let active = false;
    const timer = window.setInterval(() => {
      if (active || sessionGeneration !== sessionGenerationRef.current) return;
      active = true;
      void requestSnapshot().catch(() => undefined).finally(() => { active = false; });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [sessionState, requestSnapshot, sessionGeneration]);

  const authenticate = async (generation: number, email: string, password: string) => {
    try {
      await workbenchApi.login(email, password);
    } catch (cause) {
      if (generation !== sessionGenerationRef.current) return;
      setError(errorMessage(cause)); setSessionState('anonymous');
      return;
    }
    if (generation !== sessionGenerationRef.current) return;
    snapshotRequestsEnabledRef.current = true;
    setSessionState('ready');
    await requestSnapshot().catch(() => undefined);
  };
  const onLogin = async (email: string, password: string) => {
    await authenticate(invalidateSession('authenticating'), email, password);
  };
  const onAcceptInvite = async (token: string, name: string, password: string) => {
    const generation = invalidateSession('loading');
    let accepted: { email: string };
    try {
      accepted = await workbenchApi.acceptInvite({ token, name, password });
    } catch (cause) {
      if (generation !== sessionGenerationRef.current) return;
      setError(errorMessage(cause)); setSessionState('anonymous');
      return;
    }
    if (generation !== sessionGenerationRef.current) return;
    // The token is consumed even if the subsequent login fails. Retry through Login.
    window.history.replaceState(null, '', '/workbench/');
    setSessionState('authenticating');
    await authenticate(generation, accepted.email, password);
  };

  if (inviteToken) return <InviteAccept key={inviteToken} token={inviteToken} onSubmit={onAcceptInvite} error={error} />;
  if (sessionState === 'loading' || sessionState === 'authenticating') return <CenteredState title="Loading Menoteam" detail="Checking your workspace session…" />;
  if (sessionState === 'anonymous') return <Login onSubmit={onLogin} error={error} />;
  if (sessionState === 'error' && !snapshot) return <CenteredState title="Menoteam is unavailable" detail={error} action={<Button variant="outline" onClick={() => void checkSession()}>Try again</Button>} />;
  if (!member || !snapshot) return error ? <CenteredState title="Workspace is unavailable" detail={<span role="alert">{error}</span>} action={<Button variant="outline" onClick={() => void refresh().catch(() => undefined)}>Retry</Button>} /> : <CenteredState title="Loading workspace" detail="Preparing your projects…" />;

  return <WorkbenchShell key={member.id} member={member} snapshot={snapshot} route={route} error={error} refresh={refresh} onLogout={async () => {
    const generation = invalidateSession('loading');
    try { await workbenchApi.logout(); }
    catch (cause) { if (generation === sessionGenerationRef.current) setError(errorMessage(cause)); }
    if (generation === sessionGenerationRef.current) setSessionState('anonymous');
  }} />;
}

function WorkbenchShell({ member, snapshot, route, error, refresh, onLogout }: { member: Member; snapshot: Snapshot; route: Route; error: string; refresh: () => Promise<void>; onLogout: () => Promise<void> }) {
  const project = selectProject(snapshot.projects, route.projectId);
  const currentWork = selectWork(snapshot.works, route.workId, project?.id);
  const selectedView = route.view;
  const [mobileNav, setMobileNav] = useState(false);
  const [localError, setLocalError] = useState('');
  const report = error || localError;
  const workForProject = project ? snapshot.works.filter(item => item.projectId === project.id) : [];

  const canCreateProjects = member.role === 'owner' || member.role === 'admin';
  const content = selectedView === 'connect' ? canCreateProjects ? <ConnectProject refresh={refresh} setError={setLocalError} /> : <EmptyState title="Workspace administrator access required" detail="Only workspace administrators can create projects." />
    : !snapshot.projects.length && !['agent-profiles', 'model-providers'].includes(selectedView)
      ? <EmptyState title="No projects yet" detail={canCreateProjects ? 'Create a project to start a shared Master conversation and organize work.' : 'You have not been added to a project yet.'} action={canCreateProjects ? <a className="inline-flex" href={href('connect')}><Button>Create a project</Button></a> : undefined} />
      : !project && !['all', 'agent-profiles', 'model-providers'].includes(selectedView)
        ? <EmptyState title="Project not found" detail="This project may have been removed or you may not have access." />
        : selectedView === 'all' ? <AllProjects snapshot={snapshot} member={member} setError={setLocalError} refresh={refresh} />
          : selectedView === 'master' && project ? <ConversationPage title="Master" messages={snapshot.messages.filter(message => message.projectId === project.id && !message.workId)} project={project} snapshot={snapshot} refresh={refresh} setError={setLocalError} initialDraft={new URL(window.location.href).searchParams.get('draft') ?? ''} />
            : selectedView === 'work' && project ? <WorkList project={project} works={workForProject} />
              : selectedView === 'work-detail' && project ? currentWork ? <WorkDetail work={currentWork} project={project} snapshot={snapshot} refresh={refresh} setError={setLocalError} /> : <EmptyState title="Work not found" detail="Choose a Work from the project list." action={<a href={href('work', project.id)}>Open Work</a>} />
                : selectedView === 'instructions' && project ? <Instructions key={project.id} project={project} member={member} refresh={refresh} setError={setLocalError} />
                  : selectedView === 'members' && project ? <Members project={project} snapshot={snapshot} refresh={refresh} setError={setLocalError} />
                    : selectedView === 'skills' || selectedView === 'connections' || selectedView === 'agent-profiles' || selectedView === 'model-providers' ? ['agent-profiles', 'model-providers'].includes(selectedView) && member.role === 'member' ? <EmptyState title="Workspace administrator access required" detail="Workspace-wide Agent profiles and runtime status are visible to workspace administrators." /> : <SettingsPage view={selectedView} project={project} member={member} snapshot={snapshot} refresh={refresh} setError={setLocalError} />
                      : <EmptyState title="Choose a Work" detail="Work details include the current overview, changes, QA, and the ongoing participant conversation." />;

  return <div className="flex min-h-screen bg-background text-foreground">
    <aside className={`${mobileNav ? 'flex' : 'hidden'} fixed inset-y-0 left-0 z-40 w-64 flex-col border-r bg-muted/50 p-3 md:static md:flex md:w-60`}>
      <a href={href('all')} className="mb-5 flex items-center gap-2 rounded-md px-2 py-2 text-base font-semibold text-foreground no-underline"><span className="grid size-7 place-items-center rounded-md bg-zinc-800 text-xs font-semibold text-white">M</span>menoteam</a>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="Main navigation">
        <NavLink active={selectedView === 'all'} href={href('all')}>All projects</NavLink>
        {snapshot.projects.map(item => <section className="mt-2" key={item.id}>
          <a className={`flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium no-underline hover:bg-accent ${project?.id === item.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`} href={href('master', item.id)}><span className="grid size-6 shrink-0 place-items-center rounded-md bg-white text-xs font-semibold text-accent-foreground">{item.name.slice(0, 1).toUpperCase()}</span><span className="truncate">{item.name}</span></a>
          <div className="ml-4 mt-1 grid gap-0.5 border-l pl-3">
            <NavLink active={project?.id === item.id && selectedView === 'master'} href={href('master', item.id)}>Master</NavLink>
            <NavLink active={project?.id === item.id && ['work', 'work-detail'].includes(selectedView)} href={href('work', item.id)}>Work</NavLink>
            <NavLink active={project?.id === item.id && ['instructions', 'skills', 'members', 'connections'].includes(selectedView)} href={href('instructions', item.id)}>Project settings</NavLink>
          </div>
        </section>)}
        <div className="mt-auto grid gap-1 border-t pt-3">
          {canCreateProjects && <NavLink active={selectedView === 'connect'} href={href('connect')}>＋ Add project</NavLink>}
          {member.role !== 'member' && <NavLink active={['agent-profiles', 'model-providers'].includes(selectedView)} href={href('agent-profiles')}>Workspace settings</NavLink>}
        </div>
      </nav>
      <button type="button" className="mt-3 flex items-center gap-2 border-t px-2 pt-3 text-left" onClick={() => void onLogout()}><span className="grid size-8 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">{member.name.slice(0, 1).toUpperCase()}</span><span className="grid min-w-0 flex-1"><strong className="truncate text-sm">{member.name}</strong><small className="text-muted-foreground">{member.role}</small></span><span aria-hidden="true">↪</span></button>
    </aside>
    {mobileNav && <button className="fixed inset-0 z-30 bg-black/20 md:hidden" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur md:px-7">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open navigation" onClick={() => setMobileNav(!mobileNav)}>☰</Button>
        <Breadcrumb route={route} project={project} work={currentWork} />
      </header>
      {report && <div role="alert" className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-5 py-2.5 text-sm text-destructive"><span>{report}</span><Button variant="ghost" size="sm" onClick={() => { setLocalError(''); void refresh().catch(() => undefined); }}>Retry</Button></div>}
      <div className="min-w-0 flex-1 p-4 md:p-8">{content}</div>
    </main>
  </div>;
}

function NavLink({ href: target, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return <a aria-current={active ? 'page' : undefined} className={`rounded-md px-2.5 py-2 text-sm no-underline ${active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`} href={target}>{children}</a>;
}

function Breadcrumb({ route, project, work }: { route: Route; project?: Project; work?: Work }) {
  const isWorkspaceView = route.view === 'all' || route.view === 'connect';
  const current = route.view === 'all' ? 'All projects' : route.view === 'connect' ? 'Connect project' : route.view === 'master' ? 'Master' : route.view === 'work' ? 'Work' : route.view === 'work-detail' ? work?.title ?? 'Work detail' : route.view === 'instructions' ? 'Instructions' : route.view === 'skills' ? 'Skills' : route.view === 'members' ? 'Members' : route.view === 'connections' ? 'Connections' : route.view === 'model-providers' ? 'Model providers' : 'Agent profiles';
  return <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"><a className="shrink-0 text-muted-foreground no-underline hover:text-foreground" href={href(isWorkspaceView ? 'all' : 'master', isWorkspaceView ? '' : project?.id)}>{isWorkspaceView ? 'Workspace' : project?.name ?? 'Project'}</a><span aria-hidden="true">›</span>{route.view === 'work-detail' ? <><a className="shrink-0 text-muted-foreground no-underline hover:text-foreground" href={href('work', project?.id)}>Work</a><span aria-hidden="true">›</span><strong className="truncate text-foreground">{current}</strong></> : ['instructions', 'skills', 'members', 'connections'].includes(route.view) ? <><a className="text-muted-foreground no-underline hover:text-foreground" href={href('instructions', project?.id)}>Project settings</a><span aria-hidden="true">›</span><strong className="truncate text-foreground">{current}</strong></> : <strong className="truncate text-foreground">{current}</strong>}</nav>;
}

function Login({ onSubmit, error }: { onSubmit: (email: string, password: string) => Promise<void>; error: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  return <main className="grid min-h-screen place-items-center bg-muted/50 p-4"><form className="grid w-full max-w-sm gap-5 rounded-xl border bg-background p-6 shadow-sm" onSubmit={async event => { event.preventDefault(); setBusy(true); await onSubmit(email, password); setBusy(false); }}>
    <header><div className="mb-3 grid size-9 place-items-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">M</div><h1 className="text-xl font-semibold">Sign in to Menoteam</h1><p className="mt-1 text-sm text-muted-foreground">Use your invited workspace account.</p></header>
    <div className="grid gap-2"><Label htmlFor="login-email">Email</Label><Input id="login-email" autoComplete="username" type="email" required value={email} onChange={event => setEmail(event.target.value)} /></div>
    <div className="grid gap-2"><Label htmlFor="login-password">Password</Label><Input id="login-password" autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} /></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
  </form></main>;
}

function InviteAccept({ token, onSubmit, error }: { token: string; onSubmit: (token: string, name: string, password: string) => Promise<void>; error: string }) {
  const [name, setName] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  return <main className="grid min-h-screen place-items-center bg-muted/50 p-4"><form className="grid w-full max-w-sm gap-5 rounded-xl border bg-background p-6 shadow-sm" onSubmit={async event => { event.preventDefault(); setBusy(true); try { await onSubmit(token, name, password); } finally { setBusy(false); } }}>
    <header><h1 className="text-xl font-semibold">Join Menoteam</h1><p className="mt-1 text-sm text-muted-foreground">Set up your account to accept this invitation.</p></header>
    <div className="grid gap-2"><Label htmlFor="invite-name">Name</Label><Input id="invite-name" autoComplete="name" required value={name} onChange={event => setName(event.target.value)} /></div>
    <div className="grid gap-2"><Label htmlFor="invite-password">Password</Label><Input id="invite-password" autoComplete="new-password" type="password" minLength={12} required value={password} onChange={event => setPassword(event.target.value)} /></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button disabled={busy}>{busy ? 'Joining…' : 'Accept invitation'}</Button>
  </form></main>;
}

function CenteredState({ title, detail, action }: { title: string; detail: React.ReactNode; action?: React.ReactNode }) { return <main className="grid min-h-screen place-items-center p-6"><div className="grid max-w-md justify-items-center gap-3 text-center"><span className="grid size-9 place-items-center rounded-lg bg-accent font-semibold text-accent-foreground">M</span><h1 className="text-lg font-semibold">{title}</h1><p className="text-sm text-muted-foreground">{detail}</p>{action}</div></main>; }
function EmptyState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) { return <section className="grid min-h-64 content-center justify-items-center gap-3 rounded-xl border border-dashed p-8 text-center"><h1 className="text-lg font-semibold">{title}</h1><p className="max-w-md text-sm text-muted-foreground">{detail}</p>{action}</section>; }

function AllProjects({ snapshot, member, setError, refresh }: { snapshot: Snapshot; member: Member; setError: (value: string) => void; refresh: () => Promise<void> }) {
  if (!snapshot.projects.length) return <EmptyState title="No projects yet" detail={member.role === 'member' ? 'You have not been added to a project yet.' : 'Create a project to start collaborating.'} action={member.role === 'member' ? undefined : <a href={href('connect')}><Button>Create a project</Button></a>} />;
  return <div className="grid gap-6 xl:grid-cols-2">{snapshot.projects.map(project => <ProjectCard key={project.id} project={project} snapshot={snapshot} setError={setError} refresh={refresh} />)}</div>;
}

function ProjectCard({ project, snapshot, setError, refresh }: { project: Project; snapshot: Snapshot; setError: (value: string) => void; refresh: () => Promise<void> }) {
  const { messages, loadOlder, hasOlder, loadingOlder } = useMessageHistory(project.id);
  const visibleMessages = messages.length ? messages : snapshot.messages.filter(message => message.projectId === project.id && !message.workId).sort(messageOrder);
  return <section className="flex h-[min(70vh,46rem)] min-h-[26rem] min-w-0 flex-col rounded-xl border bg-background p-4 md:p-5">
    <header className="mb-3 flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent font-semibold text-accent-foreground">{project.name.slice(0, 1).toUpperCase()}</span><div className="min-w-0"><h2 className="truncate font-semibold">{project.name}</h2><a className="text-xs text-muted-foreground no-underline hover:underline" href={href('master', project.id)}>Open Master</a></div></div><Badge variant="outline">Project</Badge></header>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1" aria-label={`${project.name} conversation`} aria-live="polite">
      {hasOlder && <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</Button>}
      {visibleMessages.length ? visibleMessages.map(message => <MessageRow key={message.id} message={message} userName={snapshot.member.name} />) : <p className="py-8 text-center text-sm text-muted-foreground">No messages yet. Start with the project Master.</p>}
    </div>
    <MessageComposer memberId={snapshot.member.id} project={project} refresh={refresh} setError={setError} />
  </section>;
}

function ConversationPage({ title, messages, project, snapshot, work, refresh, setError, initialDraft = '' }: { title: string; messages: Message[]; project: Project; snapshot: Snapshot; work?: Work; refresh: () => Promise<void>; setError: (value: string) => void; initialDraft?: string }) {
  const workRuns = snapshot.runs.filter(run => run.projectId === project.id && run.workId === work?.id && ['queued', 'running', 'paused', 'failed', 'interrupted'].includes(run.status));
  const canManageProject = useProjectAdmin(project.id, snapshot.member, snapshot.projectRoles?.[project.id]);
  const history = useMessageHistory(project.id, work?.id);
  const displayedMessages = history.messages.length ? history.messages : messages;
  return <div className={`${work ? 'flex min-h-0 flex-1 flex-col' : 'flex h-[calc(100dvh-7.5rem)] flex-col'}`}>
    {title && <div className="mb-5 flex items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{work ? 'Conversation with the responsible Agent, Master, and subagents.' : `Project conversation · ${project.name}`}</p></div>{work && <Badge variant="outline">{work.status.replace('_', ' ')}</Badge>}</div>}
    {workRuns.map(run => <RunNotice key={run.id} run={run} canManageProject={canManageProject} refresh={refresh} setError={setError} />)}
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-4" aria-live="polite">{history.hasOlder && <Button variant="ghost" size="sm" disabled={history.loadingOlder} onClick={() => void history.loadOlder()}>{history.loadingOlder ? 'Loading…' : 'Load earlier messages'}</Button>}{displayedMessages.length ? [...displayedMessages].sort(messageOrder).map(message => <MessageRow key={message.id} message={message} multiParticipant={!!work} userName={snapshot.member.name} />) : <p className="py-16 text-center text-sm text-muted-foreground">No messages yet. Send a message to begin.</p>}</div>
    <MessageComposer memberId={snapshot.member.id} project={project} work={work} refresh={refresh} setError={setError} initialDraft={initialDraft} />
  </div>;
}

function useMessageHistory(projectId: string, workId?: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const query = workId ? { workId } : {};
  const merge = useCallback((incoming: Message[]) => setMessages(current => {
    const byId = new Map(current.map(message => [message.id, message]));
    incoming.forEach(message => byId.set(message.id, message));
    const all = [...byId.values()].sort(messageOrder);
    messagesRef.current = all;
    return all;
  }), []);
  useEffect(() => {
    let active = true;
    messagesRef.current = []; setMessages([]); setNextBefore(null);
    void workbenchApi.projectMessages(projectId, query).then(result => { if (active) { merge(result.messages); setNextBefore(result.nextBefore); } }).catch(() => undefined);
    const timer = window.setInterval(() => {
      if (!active) return;
      const last = messagesRef.current.at(-1)?.createdAt;
      const after = last ? new Date(new Date(last).getTime() - 2_000).toISOString() : undefined;
      void workbenchApi.projectMessages(projectId, { ...query, ...(after ? { after } : {}) }).then(result => { if (active && result.messages.length) merge(result.messages); }).catch(() => undefined);
    }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, workId, merge]);
  const loadOlder = useCallback(async () => {
    if (!nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    try { const result = await workbenchApi.projectMessages(projectId, { ...query, before: nextBefore }); merge(result.messages); setNextBefore(result.nextBefore); }
    finally { setLoadingOlder(false); }
  }, [loadingOlder, merge, nextBefore, projectId, workId]);
  return { messages, loadOlder, hasOlder: Boolean(nextBefore), loadingOlder };
}

function MessageRow({ message, multiParticipant = false, userName = 'You' }: { message: Message; multiParticipant?: boolean; userName?: string }) {
  const user = message.role === 'user';
  return <article className={`group flex items-end gap-3 ${user ? 'justify-end' : 'justify-start'}`}>
    {multiParticipant && !user && <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">{message.speaker.slice(0, 1).toUpperCase()}</span>}
    <div className={`max-w-[82%] ${user ? 'text-right' : ''}`}>
      {multiParticipant && !user && <p className="mb-1 text-xs font-medium text-muted-foreground">{message.speaker}</p>}
      <p className={`m-0 whitespace-pre-wrap break-words text-sm leading-relaxed ${user ? 'rounded-2xl rounded-br-sm bg-muted px-4 py-2.5' : ''}`}>{message.text}</p>
      <time className={`mt-1 block h-4 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${user ? 'text-left' : 'text-right'}`} dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
    </div>
    {multiParticipant && user && <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold">{userName.slice(0, 1).toUpperCase()}</span>}
  </article>;
}

function MessageComposer({ memberId, project, work, refresh, setError, initialDraft = '' }: { memberId: string; project: Project; work?: Work; refresh: () => Promise<void>; setError: (value: string) => void; initialDraft?: string }) {
  const draftKey = `menoteam-workbench:draft:${memberId}:${project.id}:${work?.id ?? 'master'}`;
  const [text, setText] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? initialDraft; } catch { return initialDraft; } }); const [busy, setBusy] = useState(false);
  useEffect(() => { try { sessionStorage.setItem(draftKey, text); } catch { /* Keep the draft in memory when storage is unavailable. */ } }, [draftKey, text]);
  useEffect(() => { if (!initialDraft) return; const url = new URL(window.location.href); url.searchParams.delete('draft'); window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`); }, []);
  return <form className="mt-4 flex items-center gap-2 rounded-full border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40" onSubmit={async event => {
    event.preventDefault(); const value = text.trim(); if (!value || busy) return;
    setBusy(true); setError('');
    try { await workbenchApi.sendMessage(project.id, { text: value, ...(work ? { workId: work.id } : {}), requestId: crypto.randomUUID() }); setText(''); await refresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Attachments not available yet" disabled>＋</Button>
    <Input autoFocus={new URL(window.location.href).searchParams.has('draft')} aria-label={`Message ${work ? work.profileId || 'Agent' : 'Master'}`} className="h-10 border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder={`Message ${work ? 'Agent' : 'Master'}…`} value={text} onChange={event => setText(event.target.value)} />
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Voice input not available yet" disabled>🎙</Button>
    <Button className="size-9 rounded-full" disabled={busy || !text.trim()} aria-label="Send message">↑</Button>
  </form>;
}

function RunNotice({ run, canManageProject, refresh, setError }: { run: Run; canManageProject: boolean; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const queuedOrRunning = run.status === 'queued' || run.status === 'running';
  const pausedWaitingForStop = run.status === 'paused' && !run.stoppedAt;
  const interruptedWaitingForStop = run.status === 'interrupted' && !run.stoppedAt;
  return <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm"><span><strong className="capitalize">{run.status}</strong>{run.status === 'interrupted' ? interruptedWaitingForStop ? ' · Waiting for the Connector to verify the old process has stopped' : ' · The Connector confirmed the old process stopped' : run.error ? ` · ${run.error}` : pausedWaitingForStop ? ' · Waiting for the Connector to confirm it has stopped before resuming' : ` · ${run.kind} run`}</span>{queuedOrRunning && <div className="flex gap-2"><Button variant="outline" size="sm" onClick={async () => { try { await workbenchApi.pauseRun(run.id); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Pause</Button><Button variant="ghost" size="sm" onClick={async () => { try { await workbenchApi.cancelRun(run.id); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Cancel</Button></div>}{run.status === 'paused' && run.stoppedAt && <Button variant="outline" size="sm" onClick={async () => { try { await workbenchApi.resumeRun(run.id); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Resume</Button>}{run.status === 'interrupted' && run.stoppedAt && canManageProject && <Button variant="outline" size="sm" onClick={async () => { try { await workbenchApi.reconcileRun(run.id); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Resume</Button>}</div>;
}

function WorkList({ project, works }: { project: Project; works: Work[] }) {
  const url = new URL(window.location.href); const selectedStatus = url.searchParams.get('status') ?? 'All';
  const [query, setQuery] = useState(url.searchParams.get('q') ?? '');
  const visibleWorks = filterWorks(works, selectedStatus, query);
  const updateQuery = (value: string) => {
    setQuery(value);
    const next = new URL(window.location.href);
    if (value) next.searchParams.set('q', value); else next.searchParams.delete('q');
    window.history.replaceState(null, '', `${next.pathname}${next.search}${next.hash}`);
  };
  const newWorkHref = `${href('master', project.id)}&draft=${encodeURIComponent('Help me plan a new work: ')}`;
  const workListHref = (status: string) => {
    const next = new URL(href('work', project.id), window.location.origin);
    if (status !== 'All') next.searchParams.set('status', status);
    if (query) next.searchParams.set('q', query);
    return `${next.pathname}${next.search}`;
  };
  return <><header className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">Work</h1><p className="mt-1 text-sm text-muted-foreground">{project.name}</p></div><a href={newWorkHref}><Button>＋ New work</Button></a></header>
    <nav className="mb-4 flex gap-5 border-b" aria-label="Filter work">{['All', 'In progress', 'Paused', 'Done'].map(status => <a key={status} aria-current={selectedStatus === status ? 'page' : undefined} className={`border-b-2 px-1 py-3 text-sm no-underline ${selectedStatus === status ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground'}`} href={workListHref(status)}>{status}</a>)}</nav>
    <div className="mb-5 max-w-xl"><Label htmlFor="work-search">Search Work</Label><Input id="work-search" type="search" value={query} onChange={event => updateQuery(event.target.value)} placeholder="Search titles and overviews" /></div>
    {visibleWorks.length ? <div className="overflow-hidden rounded-xl border bg-background">{visibleWorks.map(work => <a key={work.id} className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b px-4 py-3 text-foreground no-underline last:border-b-0 hover:bg-muted/40" href={href('work-detail', project.id, work.id)}><span className="min-w-0"><strong className="block truncate text-sm">{work.title}</strong><span className="mt-1 block line-clamp-2 text-sm text-muted-foreground">{work.overview}</span></span><Badge variant="outline" className="capitalize">{work.status.replace('_', ' ')}</Badge></a>)}</div> : query.trim() ? <EmptyState title="No matching Work" detail={`No Work matches “${query.trim()}” in ${selectedStatus}. Clear the search to see this status again.`} action={<Button variant="outline" onClick={() => updateQuery('')}>Clear search</Button>} /> : <EmptyState title={selectedStatus === 'All' ? 'No Work yet' : `No ${selectedStatus.toLowerCase()} Work`} detail="Start a conversation with Master to define a new Work." action={<a href={newWorkHref}><Button>Start with Master</Button></a>} />}
  </>;
}

function WorkDetail({ work, project, snapshot, refresh, setError }: { work: Work; project: Project; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const url = new URL(window.location.href); const tab = url.searchParams.get('tab') === 'changes' || url.searchParams.get('tab') === 'qa' ? url.searchParams.get('tab') as 'changes' | 'qa' : 'overview';
  const messages = snapshot.messages.filter(message => message.workId === work.id);
  return <div className="grid min-h-[calc(100dvh-8.5rem)] gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(360px,0.9fr)]">
    <section className="min-w-0"><h1 className="mb-5 text-2xl font-semibold tracking-tight">{work.title}</h1><nav className="mb-5 flex gap-5 border-b" aria-label="Work details">{(['overview', 'changes', 'qa'] as const).map(item => <a key={item} className={`border-b-2 px-1 py-3 text-sm capitalize no-underline ${tab === item ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground'}`} href={`${href('work-detail', project.id, work.id)}&tab=${item}`}>{item === 'qa' ? 'QA' : item}</a>)}</nav>
      <WorkArtifacts tab={tab} work={work} project={project} artifacts={snapshot.artifacts.filter(item => item.workId === work.id)} runs={snapshot.runs.filter(item => item.workId === work.id)} refresh={refresh} setError={setError} />
    </section>
    <section className="flex min-h-[32rem] min-w-0 flex-col border-t pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0" aria-label={`${work.title} conversation`}><div className="mb-3"><h2 className="font-semibold">Conversation</h2><p className="text-xs text-muted-foreground">Master, responsible Agent, subagents, and you</p></div><ConversationPage title="" messages={messages} project={project} snapshot={snapshot} work={work} refresh={refresh} setError={setError} /></section>
  </div>;
}

function WorkArtifacts({ tab, work, project, artifacts, runs, refresh, setError }: { tab: 'overview' | 'changes' | 'qa'; work: Work; project: Project; artifacts: Artifact[]; runs: Run[]; refresh:()=>Promise<void>; setError:(value:string)=>void }) {
  const latestDiff = [...artifacts.filter(artifact => artifact.kind === 'diff')].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const selected = artifacts.filter(artifact => artifact.kind === (tab === 'changes' ? 'diff' : 'qa') && (tab !== 'qa' || !latestDiff || artifact.revision === latestDiff.revision));
  const latest = [...selected].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [artifactState, setArtifactState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());const [deliveryBusy,setDeliveryBusy]=useState(false);
  useEffect(() => {
    if (tab === 'overview' || !latest) { setArtifact(null); setArtifactState('idle'); return; }
    let active = true; setArtifactState('loading'); setArtifact(null);
    void workbenchApi.artifact(latest.id).then(result => { if (active) { setArtifact(result); setArtifactState('idle'); } }).catch(() => { if (active) setArtifactState('error'); });
    return () => { active = false; };
  }, [latest?.id, tab]);
  const relatedRuns = runs.filter(run => tab === 'changes' ? run.kind === 'implementation' : run.kind === 'review');
  const deliveries=[...artifacts.filter(item=>item.kind==='delivery')].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  if (tab === 'overview') return <div className="space-y-6"><section><h2 className="mb-2 font-semibold">Current overview</h2><p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{work.overview || 'No overview has been recorded yet.'}</p></section>{deliveries.length>0&&<section className="space-y-2"><h2 className="font-semibold">Delivery</h2>{deliveries.map(item=><FullArtifactCard key={item.id} artifact={item}/>)}</section>}<section><h2 className="mb-2 font-semibold">Related</h2>{work.sources.length ? <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{work.sources.map(source => <li key={source}>{source}</li>)}</ul> : <p className="text-sm text-muted-foreground">No related sources.</p>}</section></div>;
  return <section className="space-y-4"><header><h2 className="font-semibold">{tab === 'changes' ? 'Changes' : 'QA'}</h2><p className="mt-1 text-sm text-muted-foreground">{tab === 'changes' ? 'Recorded file changes from this Work.' : 'Checks and verification evidence for this Work.'}</p></header>
    {tab==='changes'&&latestDiff&&(()=>{const candidate=runs.find(run=>run.id===latestDiff.runId&&run.kind==='implementation'&&run.status==='completed');const existing=runs.find(run=>run.kind==='delivery'&&run.targetRunId===candidate?.id);const retryable=existing&&['failed','interrupted','cancelled'].includes(existing.status);return <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><strong className="text-sm">Draft pull request</strong><p className="text-xs text-muted-foreground">{existing?`Delivery ${existing.status}${existing.operation?.phase?` · ${existing.operation.phase}`:''}`:project.repositoryUrl?'Create a reviewable draft from this exact candidate.':'Connect a repository to enable delivery.'}</p></div>{candidate&&<Button disabled={deliveryBusy||(!retryable&&!!existing)||!project.repositoryUrl} onClick={async()=>{setDeliveryBusy(true);setError('');try{await workbenchApi.requestDraftPr(work.id,{candidateRunId:candidate.id,candidateRevision:latestDiff.revision,action:'create_draft_pr',requestId});setRequestId(crypto.randomUUID());await refresh();}catch(error){setError(errorMessage(error));}finally{setDeliveryBusy(false);}}}>{deliveryBusy?'Queueing…':retryable?'Retry Draft PR':existing?'Queued':'Create Draft PR'}</Button>}</section>;})()}
    {deliveries.map(item=><FullArtifactCard key={item.id} artifact={item}/>)}
    {!selected.length && !relatedRuns.length && deliveries.length===0 ? <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{tab === 'changes' ? 'No change evidence has been recorded yet.' : 'No QA evidence has been recorded yet.'}</div> : <>
      {relatedRuns.map(run => <div key={run.id} className="rounded-lg border p-3"><div className="flex items-center justify-between gap-2"><strong className="text-sm">{run.kind === 'review' ? 'Review run' : 'Implementation run'}</strong><Badge variant="outline" className="capitalize">{run.status}</Badge></div>{run.error && <p className="mt-2 text-sm text-destructive">{run.error}</p>}<p className="mt-2 text-xs text-muted-foreground">Updated {new Date(run.updatedAt).toLocaleString()}</p></div>)}
      {selected.length > 0 && artifactState === 'loading' && <p role="status" className="rounded-lg border p-4 text-sm text-muted-foreground">Loading latest evidence…</p>}
      {artifactState === 'error' && <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">Could not load the latest evidence.</p>}
      {tab === 'qa' && !latest && artifacts.some(item => item.kind === 'qa') && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">The recorded QA evidence belongs to an earlier change set. Run QA again for the latest changes.</p>}
      {artifact && <ArtifactCard key={artifact.id} artifact={artifact} />}
    </>}
  </section>;
}

function FullArtifactCard({artifact}:{artifact:Artifact}){const [full,setFull]=useState<Artifact|null>(null);useEffect(()=>{let active=true;void workbenchApi.artifact(artifact.id).then(value=>{if(active)setFull(value);}).catch(()=>undefined);return()=>{active=false;};},[artifact.id]);return full?<ArtifactCard artifact={full}/>:<p className="rounded-lg border p-3 text-sm text-muted-foreground">Loading delivery evidence…</p>;}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const data = isRecord(artifact.data) ? artifact.data : {};
  if(artifact.kind==='delivery'){const url=typeof data.pullRequestUrl==='string'?data.pullRequestUrl:'';const phase=typeof data.phase==='string'?data.phase:'queued';return <section className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-sm">Draft PR delivery</strong><p className="mt-1 text-xs text-muted-foreground">{phase==='pr_created'&&url?<a href={url} target="_blank" rel="noreferrer">{url}</a>:`${phase} · ${String(data.operationId??artifact.runId)}`}</p></div><Badge variant={phase==='pr_created'?'secondary':'outline'}>{phase.replace('_',' ')}</Badge></div>{typeof data.commitSha==='string'&&<p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">Candidate · {data.commitSha}</p>}</section>;}
  if (artifact.kind === 'diff') {
    const files = Array.isArray(data.files) ? data.files.filter(isDiffFile) : [];
    return <section className="space-y-3 rounded-lg border p-3"><header className="flex flex-wrap items-center justify-between gap-3"><div><strong>{files.length} changed files</strong><p className="text-xs text-muted-foreground">Base {String(data.baseRevision ?? 'unknown')}</p></div><span className="font-mono text-sm"><span className="text-emerald-700">+{Number(data.additions) || 0}</span> <span className="text-red-700">−{Number(data.deletions) || 0}</span></span></header>{data.truncated === true && <p role="status" className="text-xs text-amber-800">This diff was truncated; some changes are not shown.</p>}{files.map(file => <details key={`${file.path}:${file.status}`} className="overflow-hidden rounded-md border"><summary className="flex cursor-pointer flex-wrap items-center gap-3 bg-muted/30 px-3 py-2 font-mono text-sm"><span aria-hidden="true">▸</span><span className="min-w-0 flex-1 break-all">{file.path}</span><span className="text-emerald-700">+{file.additions ?? '—'}</span><span className="text-red-700">−{file.deletions ?? '—'}</span><Badge variant="outline">{file.status}</Badge></summary>{file.binary ? <p className="p-3 text-sm text-muted-foreground">Binary file change</p> : <div className="max-h-[32rem] overflow-auto font-mono text-xs">{file.hunks.map((hunk, index) => <div key={index}><div className="bg-blue-50 px-3 py-1 text-blue-900">{hunk.header}</div>{hunk.lines.map((line, lineIndex) => <div key={lineIndex} className={`grid grid-cols-[3rem_3rem_1fr] whitespace-pre ${line.type === 'add' ? 'bg-emerald-50 text-emerald-900' : line.type === 'remove' ? 'bg-red-50 text-red-900' : ''}`}><span className="select-none text-right opacity-60">{line.oldLine ?? ''}</span><span className="select-none text-right opacity-60">{line.newLine ?? ''}</span><span className="px-2">{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}{line.text}</span></div>)}</div>)}</div>}</details>)}</section>;
  }
  if (artifact.kind === 'qa') {
    const checks = Array.isArray(data.checks) ? data.checks.filter(isRecord) : [];
    const verification = data.verification === 'stale' || data.stale === true ? 'Stale' : data.verification === 'current' ? 'Current' : 'Unverified';
    const review = typeof data.review === 'string' ? data.review : '';
    return <section className="space-y-3 rounded-lg border p-3"><header className="flex flex-wrap items-start justify-between gap-2"><div><strong>Verification</strong><p className="text-xs text-muted-foreground">{checks.length ? `${checks.length} recorded checks` : 'No checks were recorded'}</p>{typeof data.candidateFingerprint === 'string' && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Candidate · {data.candidateFingerprint}</p>}</div><Badge variant={verification === 'Current' ? 'secondary' : verification === 'Stale' ? 'destructive' : 'outline'}>{verification} evidence</Badge></header>{verification !== 'Current' && checks.length > 0 && <p className="text-sm text-muted-foreground">A passing command only records its exit status. These results do not verify the current change set.</p>}{review && <section className="rounded-md bg-muted/50 p-3"><h3 className="text-sm font-medium">Independent review</h3><p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{review}</p></section>}{checks.length ? checks.map((check, index) => { const passed = check.exitCode === 0; const output = typeof check.output === 'string' ? check.output : ''; const testedRevision = typeof check.testedRevision === 'string' ? check.testedRevision : ''; return <details key={`${String(check.name)}:${index}`} className="rounded-md border"><summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm"><span>{String(check.name ?? check.command ?? 'Check')}</span><Badge variant={check.exitCode === null ? 'outline' : passed ? 'secondary' : 'destructive'}>{check.exitCode === null ? 'Unknown' : passed ? 'Command passed' : `Command failed · ${String(check.exitCode)}`}</Badge></summary><div className="space-y-2 border-t p-3 text-xs"><p className="font-mono text-muted-foreground">{String(check.command ?? 'Command unavailable')}</p>{testedRevision && <p className="break-all text-muted-foreground">Tested fingerprint · {testedRevision}</p>}{output && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{output}</pre>}</div></details>; }) : <p className="text-sm text-muted-foreground">QA has not been run for this Work.</p>}</section>;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isDiffFile(value: unknown): value is { path: string; status: string; binary: boolean; additions: number | null; deletions: number | null; hunks: Array<{ header: string; lines: Array<{ type: string; oldLine?: number; newLine?: number; text: string }> }> } {
  if (!isRecord(value) || typeof value.path !== 'string' || !['added', 'modified', 'deleted', 'renamed'].includes(String(value.status)) || typeof value.binary !== 'boolean' || !Array.isArray(value.hunks)) return false;
  const validCount = (count: unknown) => count === null || typeof count === 'number';
  return validCount(value.additions) && validCount(value.deletions) && value.hunks.every(hunk => isRecord(hunk) && typeof hunk.header === 'string' && Array.isArray(hunk.lines) && hunk.lines.every(line => isRecord(line) && ['context', 'add', 'remove'].includes(String(line.type)) && typeof line.text === 'string' && (line.oldLine === undefined || typeof line.oldLine === 'number') && (line.newLine === undefined || typeof line.newLine === 'number')));
}

function ConnectProject({ refresh, setError }: { refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [name, setName] = useState(''); const [repositoryUrl, setRepositoryUrl] = useState(''); const [busy, setBusy] = useState(false);
  return <form className="mx-auto grid max-w-xl gap-5" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const project = await workbenchApi.createProject({ name, ...(repositoryUrl.trim() ? { repositoryUrl } : {}) }); await refresh(); window.location.assign(href('master', project.id)); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><header><h1 className="text-2xl font-semibold">Connect project</h1><p className="mt-1 text-sm text-muted-foreground">Create a project space and link its repository.</p></header><div className="grid gap-2"><Label htmlFor="project-name">Project name</Label><Input id="project-name" required value={name} onChange={event => setName(event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="repository-url">GitHub repository URL</Label><Input id="repository-url" type="url" placeholder="https://github.com/org/repository" value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} /></div><div><Button disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</Button></div></form>;
}

function useProjectAdmin(projectId: string, member: Member, projectRole?: Member['role']) {
  const [projectAdmin, setProjectAdmin] = useState(member.role === 'owner');
  useEffect(() => {
    if (!projectId) { setProjectAdmin(false); return; }
    if (projectRole) { setProjectAdmin(projectRole === 'owner' || projectRole === 'admin'); return; }
    if (member.role === 'owner') { setProjectAdmin(true); return; }
    let active = true; setProjectAdmin(false);
    void workbenchApi.projectMembers(projectId).then(result => { if (active) setProjectAdmin(canManageProject(member, result.members)); }).catch(() => { if (active) setProjectAdmin(false); });
    return () => { active = false; };
  }, [member.id, member.role, projectId, projectRole]);
  return projectAdmin;
}

function Instructions({ project, member, refresh, setError }: { project: Project; member: Member; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const canEdit = useProjectAdmin(project.id, member, undefined);
  const [draftState, setDraftState] = useState(() => startInstructionsDraft(project.instructions)); const { draft, base: baseInstructions } = draftState; const [busy, setBusy] = useState(false); const [editing, setEditing] = useState(false);
  const draftRef = useRef(draft);
  const hasRemoteUpdate = editing && hasRemoteInstructionsUpdate(draftState, project.instructions);
  const suggestions = [
    ['Project context', 'Describe who this project serves and what matters most to them.'],
    ['Working style', 'Prefer small, focused changes. Follow the existing project conventions.'],
    ['Quality expectations', 'Verify the affected behavior before marking work complete. Explain anything that remains unverified.'],
    ['When to ask', 'Ask before publishing externally or deploying to production.'],
    ['Communication', 'Share concise updates when direction changes or a decision is needed.'],
    ['Research sources', 'Prefer primary sources and link evidence for important claims.'],
    ['Writing style', 'Use clear, direct language and explain unfamiliar terms.'],
    ['Design preferences', 'Keep interfaces clear and accessible; follow the current product design.'],
    ['Dependencies', 'Prefer existing tools unless a new dependency solves a clear need.'],
    ['Uncertainty', 'Call out assumptions and explain what remains unverified.'],
    ['Sensitive information', 'Keep credentials and private data out of messages, logs, and source control.'],
    ['Definition of done', 'Summarize what changed and how it was checked before closing the work.'],
  ];
  const save = async () => { const submittedDraft = draft; setBusy(true); setError(''); try { await workbenchApi.updateProject(project.id, { instructions: submittedDraft, expectedInstructions: baseInstructions }); await refresh(); const completion = completeInstructionsSave({ draft: draftRef.current, base: baseInstructions }, submittedDraft); setDraftState(completion.state); if (completion.closeEditor) setEditing(false); } catch (cause) { if (cause instanceof ApiError && cause.status === 409) await refresh().catch(() => undefined); setError(errorMessage(cause)); } finally { setBusy(false); } };
  return <section className="w-full"><ProjectSettingsNav project={project} active="instructions"/><header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Instructions</h1><p className="mt-1 text-sm text-muted-foreground">Project context that Master and Agents can use.</p></div>{editing ? <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => { const next = cancelInstructionsDraft(project.instructions); draftRef.current = next.draft; setDraftState(next); setEditing(false); }}>Cancel</Button><Button disabled={busy || draft === baseInstructions} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button></div> : canEdit && <Button variant="outline" onClick={() => { const next = startInstructionsDraft(project.instructions); draftRef.current = next.draft; setDraftState(next); setEditing(true); }}>Edit</Button>}</header>{hasRemoteUpdate && <div role="status" className="mb-4 grid gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm"><p><strong>Instructions changed elsewhere.</strong> Your draft is preserved. The latest saved version is shown below.</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-sans">{project.instructions || 'No project instructions yet.'}</pre><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { const next = useLatestInstructions(project.instructions); draftRef.current = next.draft; setDraftState(next); }}>Use latest version</Button><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { const next = keepInstructionsDraft({ draft: draftRef.current, base: baseInstructions }, project.instructions); draftRef.current = next.draft; setDraftState(next); }}>Keep editing my draft</Button></div></div>}{editing && canEdit ? <><Textarea className="min-h-[40vh] resize-y" value={draft} onChange={event => { draftRef.current = event.target.value; setDraftState(current => editInstructionsDraft(current, event.target.value)); }} placeholder="Add project context, working preferences, or quality expectations…" /><div className="mt-4 flex flex-wrap items-center gap-2"><span className="mr-1 text-sm text-muted-foreground">Optional starting points</span>{suggestions.map(([label, text]) => <Button key={label} type="button" variant="outline" size="sm" onClick={() => { const nextDraft = `${draftRef.current}${draftRef.current && !draftRef.current.endsWith('\n') ? '\n\n' : ''}${text}`; draftRef.current = nextDraft; setDraftState(current => editInstructionsDraft(current, nextDraft)); }}>{label} ＋</Button>)}</div></> : <p className="min-h-32 whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 text-sm leading-relaxed">{project.instructions || 'No project instructions yet.'}</p>}</section>;
}

function Members({ project, snapshot, refresh, setError }: { project: Project; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [email, setEmail] = useState(''); const [role, setRole] = useState<Member['role']>('member'); const [busy, setBusy] = useState(false); const [inviteUrl, setInviteUrl] = useState('');
  const [members, setMembers] = useState<Member[]>([]); const [invites, setInvites] = useState<Array<{ id: string; email: string; role: Member['role']; expiresAt: string }>>([]);
  const canManage = useProjectAdmin(project.id, snapshot.member);
  const load = useCallback(async () => { const memberResult = await workbenchApi.projectMembers(project.id); setMembers(memberResult.members); if (canManage) { const inviteResult = await workbenchApi.projectInvites(project.id); setInvites(inviteResult.invites); } else setInvites([]); }, [canManage, project.id]);
  useEffect(() => { void load().catch(cause => setError(errorMessage(cause))); }, [load, setError]);
  return <section className="w-full"><ProjectSettingsNav project={project} active="members"/><header className="mb-5"><h1 className="text-2xl font-semibold">Members</h1><p className="mt-1 text-sm text-muted-foreground">Invite people to this private project.</p></header>{canManage && <form className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border p-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const result = await workbenchApi.invite({ email, projectId: project.id, role }); const url = new URL('/workbench/', window.location.origin); url.searchParams.set('invite', result.token); setInviteUrl(url.toString()); setEmail(''); await load(); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid min-w-56 flex-1 gap-2"><Label htmlFor="invite-email">Email</Label><Input id="invite-email" type="email" required value={email} onChange={event => setEmail(event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="invite-role">Role</Label><select id="invite-role" className="h-9 rounded-md border bg-background px-3 text-sm" value={role} onChange={event => setRole(event.target.value as Member['role'])}><option value="member">Member</option><option value="admin">Admin</option></select></div><Button disabled={busy}>{busy ? 'Inviting…' : 'Invite member'}</Button></form>}{inviteUrl && <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3 text-sm"><span className="min-w-0 flex-1 break-all">Invitation link · {inviteUrl}</span><Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Copy link</Button></div>}
    <h2 className="mb-2 font-semibold">Project members</h2><ul className="mb-7 divide-y rounded-lg border">{members.map(record => <li key={record.id} className="flex items-center justify-between gap-3 p-3 text-sm"><span>{record.name} · {record.email}</span><span className="flex items-center gap-3 text-muted-foreground">{record.role}{canManage && record.id !== snapshot.member.id && record.role !== 'owner' && <Button variant="ghost" size="sm" onClick={async () => { try { await workbenchApi.removeProjectMember(project.id, record.id); await load(); } catch (cause) { setError(errorMessage(cause)); } }}>Remove</Button>}</span></li>)}</ul>
    {canManage && <><h2 className="mb-2 font-semibold">Pending invitations</h2><ul className="divide-y rounded-lg border">{invites.map(invite => <li key={invite.id} className="flex items-center justify-between gap-3 p-3 text-sm"><span>{invite.email} · {invite.role}</span><span className="flex items-center gap-3 text-muted-foreground">Expires {new Date(invite.expiresAt).toLocaleDateString()}<Button variant="ghost" size="sm" onClick={async () => { try { await workbenchApi.revokeInvite(invite.id); await load(); } catch (cause) { setError(errorMessage(cause)); } }}>Revoke</Button></span></li>)}</ul></>}</section>;
}

function SettingsPage({ view, project, member, snapshot, refresh, setError }: { view: View; project?: Project; member: Member; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const projectTabs: [View, string][] = [['instructions', 'Instructions'], ['skills', 'Skills'], ['members', 'Members'], ['connections', 'Connections']];
  const workspaceTabs: [View, string][] = [['agent-profiles', 'Agent profiles'], ['model-providers', 'Model providers']];
  const workspace = view === 'agent-profiles' || view === 'model-providers';
  const projectAdmin = useProjectAdmin(project?.id ?? '', member);
  const canManage = workspace ? member.role === 'owner' || member.role === 'admin' : projectAdmin;
  const items = snapshot.settings.filter(item => workspace ? view === 'agent-profiles' && item.kind === 'profile' : item.projectId === project?.id && (view === 'skills' ? item.kind === 'skill' : item.kind === 'connection'));
  const [name, setName] = useState(''); const [content, setContent] = useState(''); const [model, setModel] = useState<'gpt-6-luna' | 'gpt-6.1-sol'>('gpt-6-luna'); const [reasoning, setReasoning] = useState<'low' | 'medium' | 'high' | 'xhigh'>('medium'); const [skillIds, setSkillIds] = useState<string[]>([]); const [connectionProvider, setConnectionProvider] = useState<'github' | 'slack'>('github'); const [connectionUrl, setConnectionUrl] = useState(''); const [connectionPurpose,setConnectionPurpose]=useState<'source'|'delivery'>('source');const [baseBranch,setBaseBranch]=useState('main'); const [busy, setBusy] = useState(false);
  const tabList = workspace ? workspaceTabs : projectTabs;
  const title = tabList.find(([id]) => id === view)?.[1] ?? 'Settings';
  return <section className="w-full">{!workspace && project ? <ProjectSettingsNav project={project} active={view}/>: <nav className="mb-6 flex gap-1 overflow-x-auto border-b" aria-label="Workspace settings">{tabList.map(([id, label]) => <a key={id} className={`shrink-0 border-b-2 px-3 py-3 text-sm no-underline ${view === id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} href={href(id)}>{label}</a>)}</nav>}<header className="mb-5"><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{workspace ? 'Reusable workspace configuration.' : 'Project configuration.'}</p></header>
    {view === 'skills' && canManage && <form className="mb-7 grid gap-3 rounded-lg border p-4 md:grid-cols-2" onSubmit={async event => { event.preventDefault(); if (!name.trim() || !content.trim() || !project) return; setBusy(true); setError(''); try { await workbenchApi.saveSetting({ kind: 'skill', projectId: project.id, name: name.trim(), data: { content: content.trim() } }); setName(''); setContent(''); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid gap-2"><Label htmlFor="skill-name">Skill name</Label><Input id="skill-name" required value={name} onChange={e => setName(e.target.value)} /></div><div className="grid gap-2 md:col-span-2"><Label htmlFor="skill-content">Skill instructions</Label><Textarea id="skill-content" required value={content} onChange={e => setContent(e.target.value)} placeholder="Write the reusable instructions this skill provides." /></div><div className="md:col-span-2"><Button disabled={busy || !name.trim() || !content.trim()}>{busy ? 'Saving…' : 'Create skill'}</Button></div></form>}
    {view === 'skills' && canManage && project && <GithubSkillImport project={project} refresh={refresh} setError={setError} />}
    {view === 'agent-profiles' && canManage && <form className="mb-7 grid gap-4 rounded-lg border p-4 md:grid-cols-2" onSubmit={async event => { event.preventDefault(); if (!name.trim()) return; setBusy(true); setError(''); try { await workbenchApi.saveSetting({ kind: 'profile', name: name.trim(), data: { model, reasoning, skillIds } }); setName(''); setSkillIds([]); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid gap-2"><Label htmlFor="profile-name">Profile name</Label><Input id="profile-name" required value={name} onChange={e => setName(e.target.value)} /></div><div className="grid gap-2"><Label htmlFor="profile-model">Model</Label><select id="profile-model" className="h-9 rounded-md border bg-background px-3 text-sm" value={model} onChange={e => setModel(e.target.value as typeof model)}><option value="gpt-6-luna">GPT 6 Luna</option><option value="gpt-6.1-sol">GPT 6.1 Sol</option></select></div><div className="grid gap-2"><Label htmlFor="profile-reasoning">Reasoning</Label><select id="profile-reasoning" className="h-9 rounded-md border bg-background px-3 text-sm" value={reasoning} onChange={e => setReasoning(e.target.value as typeof reasoning)}>{['low', 'medium', 'high', 'xhigh'].map(value => <option key={value}>{value}</option>)}</select></div><ProfileSkillsEditor idPrefix="new-profile" allSettings={snapshot.settings} skillIds={skillIds} setSkillIds={setSkillIds} refresh={refresh} setError={setError} /><div className="md:col-span-2"><Button disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Add profile'}</Button></div></form>}
    {view === 'model-providers' && <section className="mb-7"><h2 className="mb-2 font-semibold">Local Codex runtimes</h2><p className="mb-4 text-sm text-muted-foreground">The account is managed by the local Connector. Availability and completed-turn verification are shown separately. Additional provider and account connections are not supported yet.</p>{snapshot.runtimeProviders.length ? <div className="divide-y rounded-lg border">{snapshot.runtimeProviders.map(provider => <article key={provider.connectorId} className="flex flex-wrap items-start justify-between gap-4 p-4"><div className="min-w-0"><h3 className="font-medium">OpenAI · Codex host</h3><p className="mt-1 text-xs text-muted-foreground">{provider.models.length ? provider.models.join(' · ') : 'No model capabilities reported'}</p><p className="mt-2 text-sm text-muted-foreground">{provider.verifiedAt ? `Completed agent turn verified ${new Date(provider.verifiedAt).toLocaleString()}` : 'Connector is enrolled; no completed agent turn has been verified yet.'}</p></div><div className="flex shrink-0 flex-col items-end gap-2"><Badge variant={provider.available ? 'secondary' : 'outline'}>{provider.available ? 'Available' : 'Offline'}</Badge><span className="text-xs text-muted-foreground">{provider.available ? `Seen ${new Date(provider.lastSeen).toLocaleTimeString()}` : 'Not seen recently'}</span></div></article>)}</div> : <EmptyState title="No local runtimes enrolled" detail="Connectors register their capabilities here. Provider sign-in happens on the Connector host." />}</section>}
    {view === 'connections' && canManage && project && <><FeedbackIntakeSettings project={project} refresh={refresh} setError={setError} /><form className="mb-7 flex flex-wrap items-end gap-3 rounded-lg border p-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await workbenchApi.saveSetting({ kind: 'connection', projectId: project.id, name: connectionProvider === 'github' ? 'GitHub source' : 'Slack source', data: { provider: connectionProvider, url: connectionUrl, enabled: true } }); setConnectionUrl(''); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid gap-2"><Label htmlFor="connection-provider">Source</Label><select id="connection-provider" className="h-9 rounded-md border bg-background px-3 text-sm" value={connectionProvider} onChange={e => setConnectionProvider(e.target.value as typeof connectionProvider)}><option value="github">GitHub</option><option value="slack">Slack</option></select></div><div className="grid min-w-64 flex-1 gap-2"><Label htmlFor="connection-url">Repository or channel URL</Label><Input id="connection-url" type="url" required value={connectionUrl} onChange={e => setConnectionUrl(e.target.value)} /></div><Button disabled={busy || !connectionUrl.trim()}>{busy ? 'Saving…' : 'Add source reference'}</Button><p className="w-full text-xs text-muted-foreground">This saves a source reference; it does not authenticate GitHub or Slack. Slack events require server configuration.</p></form></>}
    {view === 'connections' && canManage && project && <DeliveryConnectionSettings project={project} refresh={refresh} setError={setError} />}
    {items.length ? <div className="divide-y rounded-lg border">{items.map(item => <SettingRow key={item.id} item={item} allSettings={snapshot.settings} canEdit={canManage} refresh={refresh} setError={setError} />)}</div> : view !== 'model-providers' && <EmptyState title={`No ${title.toLowerCase()} yet`} detail={view === 'skills' ? 'Add reusable project instructions or import a GitHub SKILL.md below.' : view === 'agent-profiles' ? 'Create reusable profiles for the team’s Agents.' : 'No project connections are recorded.'} />}
  </section>;
}

function GithubSkillImport({ project, refresh, setError }: { project: Project; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [url, setUrl] = useState(''); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  return <form className="mb-7 flex flex-wrap items-end gap-3 rounded-lg border p-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await workbenchApi.importGithubSkill(project.id, url, name.trim() || undefined); setUrl(''); setName(''); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid min-w-64 flex-1 gap-2"><Label htmlFor="github-skill-url">GitHub SKILL.md URL</Label><Input id="github-skill-url" required type="url" placeholder="https://github.com/org/repo/blob/main/SKILL.md" value={url} onChange={event => setUrl(event.target.value)} /></div><div className="grid min-w-40 gap-2"><Label htmlFor="github-skill-name">Display name (optional)</Label><Input id="github-skill-name" value={name} onChange={event => setName(event.target.value)} /></div><Button disabled={busy || !url.trim()}>{busy ? 'Importing…' : 'Import from GitHub'}</Button><p className="w-full text-xs text-muted-foreground">Imports the SKILL.md from the GitHub URL you provide as project instructions. The file is not run during import. Marketplace installs are not available yet.</p></form>;
}

function DeliveryConnectionSettings({ project, refresh, setError }: { project: Project; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [baseBranch, setBaseBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  return <form className="mb-7 flex flex-wrap items-end gap-3 rounded-lg border p-4" onSubmit={async event => {
    event.preventDefault();
    if (!project.repositoryUrl || !baseBranch.trim()) return;
    setBusy(true); setError('');
    try {
      await workbenchApi.saveSetting({ kind: 'connection', projectId: project.id, name: 'GitHub Draft PR', data: { provider: 'github', url: project.repositoryUrl, enabled: true, purpose: 'delivery', baseBranch: baseBranch.trim(), allowDraftPr: true } });
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }}>
    <div className="min-w-48 flex-1"><h2 className="font-medium">Draft PR delivery</h2><p className="mt-1 text-sm text-muted-foreground">Allow an authorized Connector to publish a draft from a completed candidate. Credentials stay on that Connector.</p></div>
    <div className="grid gap-2"><Label htmlFor="delivery-base-branch">Base branch</Label><Input id="delivery-base-branch" required value={baseBranch} onChange={event => setBaseBranch(event.target.value)} /></div>
    <Button disabled={busy || !project.repositoryUrl || !baseBranch.trim()}>{busy ? 'Saving…' : 'Enable draft PRs'}</Button>
    {!project.repositoryUrl && <p className="w-full text-sm text-muted-foreground">Add a repository to this project before enabling delivery.</p>}
  </form>;
}

function FeedbackIntakeSettings({ project, refresh, setError }: { project: Project; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [enabled, setEnabled] = useState(project.feedbackIntake?.enabled ?? false);
  const [allowExecution, setAllowExecution] = useState(project.feedbackIntake?.allowExecution ?? false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEnabled(project.feedbackIntake?.enabled ?? false); setAllowExecution(project.feedbackIntake?.allowExecution ?? false); }, [project.id, project.feedbackIntake?.enabled, project.feedbackIntake?.allowExecution]);
  const dirty = enabled !== Boolean(project.feedbackIntake?.enabled) || allowExecution !== Boolean(project.feedbackIntake?.allowExecution);
  return <form className="mb-7 grid gap-4 rounded-lg border p-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await workbenchApi.updateProject(project.id, { feedbackIntake: { enabled, allowExecution: enabled && allowExecution } }); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div><h2 className="font-semibold">External feedback</h2><p className="mt-1 text-sm text-muted-foreground">Choose whether configured source events can be triaged by Master.</p></div><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span><strong>Enable source feedback intake</strong><span className="block text-muted-foreground">Master can read the external report, link related Work, and ask for clarification.</span></span></label>{enabled && <label className="flex items-start gap-3 border-l-2 pl-4 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={allowExecution} onChange={event => setAllowExecution(event.target.checked)} /><span><strong>Allow execution delegation</strong><span className="block text-muted-foreground">When enabled, incoming feedback may start bounded implementation work. Off by default.</span></span></label>}<div><Button disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save feedback settings'}</Button></div></form>;
}

function ProfileSkillsEditor({ allSettings, skillIds, setSkillIds, refresh, setError, idPrefix }: { allSettings: Setting[]; skillIds: string[]; setSkillIds: React.Dispatch<React.SetStateAction<string[]>>; refresh: () => Promise<void>; setError: (value: string) => void; idPrefix: string }) {
  const [adding, setAdding] = useState(false); const [skillName, setSkillName] = useState(''); const [skillContent, setSkillContent] = useState(''); const [saving, setSaving] = useState(false);
  const globalSkills = allSettings.filter(setting => setting.kind === 'skill' && !setting.projectId);
  const scopedSkills = skillIds.map(id => ({ id, setting: allSettings.find(setting => setting.id === id) })).filter(({ setting }) => !setting || setting.kind !== 'skill' || Boolean(setting.projectId));
  async function createReusableSkill() { if (!skillName.trim() || !skillContent.trim()) return; setSaving(true); setError(''); try { const created = await workbenchApi.saveSetting({ kind: 'skill', name: skillName.trim(), data: { content: skillContent.trim() } }); setSkillIds(ids => ids.includes(created.id) ? ids : [...ids, created.id]); setSkillName(''); setSkillContent(''); setAdding(false); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); } }
  return <div className="grid gap-2 md:col-span-2"><Label htmlFor={`${idPrefix}-skills`}>Reusable skills</Label>{globalSkills.length > 0 ? <select id={`${idPrefix}-skills`} multiple className="min-h-20 rounded-md border bg-background px-2 py-1 text-sm" value={skillIds.filter(id => globalSkills.some(skill => skill.id === id))} onChange={event => { const selected = Array.from(event.target.selectedOptions, option => option.value); setSkillIds([...scopedSkills.map(({ id }) => id), ...selected]); }} aria-describedby={`${idPrefix}-skills-hint`}>{globalSkills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select> : <p id={`${idPrefix}-skills-hint`} className="text-sm text-muted-foreground">No reusable skills yet. Skills created within a project stay project-only and cannot be selected by workspace profiles.</p>}{globalSkills.length > 0 && <p id={`${idPrefix}-skills-hint`} className="text-xs text-muted-foreground">These skills are shared across projects.</p>}{scopedSkills.length > 0 && <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p className="text-amber-900 dark:text-amber-200">This profile has skills that are project-only or unavailable in this workspace. They cannot be used by workspace profiles. Remove them explicitly before saving.</p>{scopedSkills.map(({ id, setting }) => <div key={id} className="flex items-center justify-between gap-3"><span>{setting?.name ?? 'Unavailable skill'}</span><Button type="button" size="sm" variant="outline" onClick={() => setSkillIds(ids => ids.filter(skillId => skillId !== id))}>Remove from profile</Button></div>)}</div>}{adding ? <div className="grid gap-3 rounded-md border bg-muted/20 p-3"><div className="grid gap-2"><Label htmlFor={`${idPrefix}-new-skill-name`}>Skill name</Label><Input id={`${idPrefix}-new-skill-name`} value={skillName} onChange={event => setSkillName(event.target.value)} placeholder="e.g. Accessibility review" /></div><div className="grid gap-2"><Label htmlFor={`${idPrefix}-new-skill-content`}>Skill instructions</Label><Textarea id={`${idPrefix}-new-skill-content`} value={skillContent} onChange={event => setSkillContent(event.target.value)} placeholder="What reusable guidance should this skill provide?" /></div><div className="flex gap-2"><Button type="button" disabled={saving || !skillName.trim() || !skillContent.trim()} onClick={() => void createReusableSkill()}>{saving ? 'Saving…' : 'Create reusable skill'}</Button><Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div></div> : <div><Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>Add or create skill</Button></div>}</div>;
}

function SettingRow({ item, allSettings, canEdit, refresh, setError }: { item: Setting; allSettings: Setting[]; canEdit: boolean; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [editing, setEditing] = useState(false); const [name, setName] = useState(item.name); const [content, setContent] = useState(String(item.data.content ?? '')); const [model, setModel] = useState(String(item.data.model ?? 'gpt-6-luna')); const [reasoning, setReasoning] = useState(String(item.data.reasoning ?? 'medium')); const [skillIds, setSkillIds] = useState(Array.isArray(item.data.skillIds) ? item.data.skillIds.filter((id): id is string => typeof id === 'string') : []); const [connectionProvider, setConnectionProvider] = useState(String(item.data.provider ?? 'github')); const [connectionUrl, setConnectionUrl] = useState(String(item.data.url ?? '')); const [connectionBaseBranch, setConnectionBaseBranch] = useState(String(item.data.baseBranch ?? 'main'));
  const detail = item.kind === 'skill' ? String(item.data.content ?? '') : item.kind === 'profile' ? `${String(item.data.model ?? '')} · ${String(item.data.reasoning ?? '')} reasoning` : item.kind === 'provider' ? `${String(item.data.provider ?? 'Provider')} · ${String(item.data.method ?? 'metadata only')}` : `${String(item.data.provider ?? 'Connection')} · ${String(item.data.url ?? '')}${item.data.purpose === 'delivery' ? ` · Draft PR to ${String(item.data.baseBranch ?? 'unknown')}` : ''}`;
  return <details className="p-4"><summary className="flex items-center justify-between gap-4 text-sm font-medium"><span>{item.name}</span><Badge variant="outline">{item.kind}</Badge></summary>{editing ? <div className="mt-3 grid gap-3"><div className="grid gap-2"><Label htmlFor={`setting-name-${item.id}`}>Name</Label><Input id={`setting-name-${item.id}`} value={name} onChange={event => setName(event.target.value)} /></div>{item.kind === 'skill' && <div className="grid gap-2"><Label htmlFor={`setting-content-${item.id}`}>Instructions</Label><Textarea id={`setting-content-${item.id}`} value={content} onChange={event => setContent(event.target.value)} /></div>}{item.kind === 'profile' && <div className="grid gap-3"><div className="flex flex-wrap gap-3"><div className="grid gap-2"><Label htmlFor={`setting-model-${item.id}`}>Model</Label><select id={`setting-model-${item.id}`} className="h-9 rounded-md border bg-background px-3 text-sm" value={model} onChange={event => setModel(event.target.value)}><option value="gpt-6-luna">GPT 6 Luna</option><option value="gpt-6.1-sol">GPT 6.1 Sol</option></select></div><div className="grid gap-2"><Label htmlFor={`setting-reasoning-${item.id}`}>Reasoning</Label><select id={`setting-reasoning-${item.id}`} className="h-9 rounded-md border bg-background px-3 text-sm" value={reasoning} onChange={event => setReasoning(event.target.value)}>{['low', 'medium', 'high', 'xhigh'].map(value => <option key={value}>{value}</option>)}</select></div></div><ProfileSkillsEditor idPrefix={`setting-${item.id}`} allSettings={allSettings} skillIds={skillIds} setSkillIds={setSkillIds} refresh={refresh} setError={setError} /></div>}{item.kind === 'connection' && <div className="flex flex-wrap gap-3"><div className="grid gap-2"><Label htmlFor={`connection-provider-${item.id}`}>Source</Label><select id={`connection-provider-${item.id}`} className="h-9 rounded-md border bg-background px-3 text-sm" value={connectionProvider} onChange={event => setConnectionProvider(event.target.value)}><option value="github">GitHub</option><option value="slack">Slack</option></select></div><div className="grid min-w-64 flex-1 gap-2"><Label htmlFor={`connection-url-${item.id}`}>Repository or channel URL</Label><Input id={`connection-url-${item.id}`} type="url" value={connectionUrl} onChange={event => setConnectionUrl(event.target.value)} /></div>{item.data.purpose === 'delivery' && <div className="grid gap-2"><Label htmlFor={`connection-base-${item.id}`}>Base branch</Label><Input id={`connection-base-${item.id}`} value={connectionBaseBranch} onChange={event => setConnectionBaseBranch(event.target.value)} /></div>}</div>}<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => { setName(item.name); setContent(String(item.data.content ?? '')); setModel(String(item.data.model ?? 'gpt-6-luna')); setReasoning(String(item.data.reasoning ?? 'medium')); setSkillIds(Array.isArray(item.data.skillIds) ? item.data.skillIds.filter((id): id is string => typeof id === 'string') : []); setConnectionProvider(String(item.data.provider ?? 'github')); setConnectionUrl(String(item.data.url ?? '')); setConnectionBaseBranch(String(item.data.baseBranch ?? 'main')); setEditing(false); }}>Cancel</Button><Button size="sm" disabled={item.kind === 'profile' && skillIds.some(id => { const skill = allSettings.find(setting => setting.id === id); return !skill || skill.kind !== 'skill' || Boolean(skill.projectId); })} onClick={async () => { try { const data = item.kind === 'skill' ? { ...item.data, content } : item.kind === 'profile' ? { model, reasoning, skillIds } : item.kind === 'connection' ? { ...item.data, provider: connectionProvider, url: connectionUrl, enabled: item.data.enabled !== false, ...(item.data.purpose === 'delivery' ? { baseBranch: connectionBaseBranch } : {}) } : item.data; await workbenchApi.updateSetting(item.id, { name, data, expectedUpdatedAt: item.updatedAt }); setEditing(false); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Save</Button></div></div> : <><p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{detail || 'No details recorded.'}</p>{canEdit && ['skill', 'profile', 'connection'].includes(item.kind) && <Button className="mt-3" variant="outline" size="sm" onClick={() => { setConnectionBaseBranch(String(item.data.baseBranch ?? 'main')); setEditing(true); }}>Edit</Button>}</>}</details>;
}

function ProjectSettingsNav({ project, active }: { project: Project; active: View }) {
  const tabs: Array<[View, string]> = [['instructions', 'Instructions'], ['skills', 'Skills'], ['members', 'Members'], ['connections', 'Connections']];
  return <nav className="mb-6 flex gap-1 overflow-x-auto border-b" aria-label="Project settings">{tabs.map(([view, label]) => <a key={view} aria-current={view === active ? 'page' : undefined} className={`shrink-0 border-b-2 px-3 py-3 text-sm no-underline ${active === view ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} href={href(view, project.id)}>{label}</a>)}</nav>;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Try again.'; }

export default App;
