import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, LogOut, Menu, Mic, Plus, Send } from 'lucide-react';
import { Badge } from '../../local/web/src/components/ui/badge';
import { Button } from '../../local/web/src/components/ui/button';
import { Checkbox } from '../../local/web/src/components/ui/checkbox';
import { Input } from '../../local/web/src/components/ui/input';
import { Label } from '../../local/web/src/components/ui/label';
import { NativeSelect, NativeSelectOption } from '../../local/web/src/components/ui/native-select';
import { Textarea } from '../../local/web/src/components/ui/textarea';
import { ProviderConnections } from './ProviderConnections';
import { DIFF_VISIBLE_CHARS, historicalDiffRows, initialDiffPageState, parseDiffPage, type DiffPageState, type DiffRow } from './diff-page';
import type { Artifact, Member, Message, Project, SnapshotRun, Setting, Work } from '../types';
import { canRecoverStagingRun, isCausalMasterWake } from '../types';
import { hasRequiredLocalQa, qaPolicySnapshot } from '../local-qa';
import { ApiError, canAutoPoll, invalidateRateLimitRequests, resetRateLimitCooldown, workbenchApi, type Snapshot, type WorkEvidence } from './api';
import { canManageProject, filterWorks, readRoute, selectProject, selectWork, type Route, type View } from './routes';
import { cancelInstructionsDraft, completeInstructionsSave, editInstructionsDraft, hasRemoteInstructionsUpdate, keepInstructionsDraft, startInstructionsDraft, useLatestInstructions } from './instructions-draft';
import { createSnapshotRequestHandler } from './snapshot-request';
import { navigate, useWorkbenchUrl } from './navigation';
import { useConversationScroll } from './conversation-scroll';
import { Markdown } from './Markdown';
import { artifactKey, useArtifactReader, type ArtifactReader } from './artifact-reader';
import { blocksRunClaim } from '../run-claim';

function href(view: View, projectId = '', workId = '') {
  const url = new URL('/workbench/', window.location.origin);
  if (view !== 'all') url.searchParams.set('view', view);
  if (projectId) url.searchParams.set('project', projectId);
  if (workId) url.searchParams.set('work', workId);
  return `${url.pathname}${url.search}`;
}

function runNoticeLabel(run: SnapshotRun) {
  const status = run.status === 'cancelled' && !run.stoppedAt ? 'Cancelling' : run.status === 'cancelled' ? 'Cancelled' : run.status.charAt(0).toUpperCase() + run.status.slice(1);
  const createdAt = Date.parse(run.createdAt);
  const createdLabel = Number.isFinite(createdAt) ? new Date(createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : 'time not recorded';
  return `${run.kind === 'master' ? 'Master' : `${run.kind} run`} · ${status} · ${createdLabel} · #${run.id.slice(-8)}`;
}

const messageOrder = (a: Message, b: Message) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function App() {
  const url = useWorkbenchUrl();
  const route = readRoute(url);
  const inviteToken = new URL(url).searchParams.get('invite');
  const [member, setMember] = useState<Member | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sessionState, setSessionState] = useState<'loading' | 'authenticating' | 'anonymous' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const sessionGenerationRef = useRef(0);
  const snapshotRequestsEnabledRef = useRef(true);

  const invalidateSession = useCallback((state: 'loading' | 'authenticating' | 'anonymous') => {
    const generation = ++sessionGenerationRef.current;
    resetRateLimitCooldown();
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
    return () => { ++sessionGenerationRef.current; snapshotRequestsEnabledRef.current = false; invalidateRateLimitRequests(); };
  }, [checkSession]);

  useEffect(() => {
    if (sessionState !== 'ready') return;
    const sessionGeneration = sessionGenerationRef.current;
    let active = false;
    const timer = window.setInterval(() => {
      if (document.hidden || active || !canAutoPoll() || sessionGeneration !== sessionGenerationRef.current) return;
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
    navigate('/workbench/', true);
    setSessionState('authenticating');
    await authenticate(generation, accepted.email, password);
  };
  const onJoinInvite = async (token: string, email?: string, password?: string) => {
    let current = member;
    const generation = invalidateSession(email ? 'authenticating' : 'loading');
    if (!email) setMember(current);
    try {
      if (email) {
        await workbenchApi.login(email, password ?? '');
        if (generation !== sessionGenerationRef.current) return;
        current = await workbenchApi.me();
        if (generation !== sessionGenerationRef.current) return;
        setMember(current);
      }
      await workbenchApi.joinInvite(token);
    } catch (cause) {
      if (generation !== sessionGenerationRef.current) return;
      if (cause instanceof ApiError && cause.status === 401) { invalidateSession('anonymous'); current = null; }
      if (current) snapshotRequestsEnabledRef.current = true;
      setError(errorMessage(cause)); setSessionState(current ? 'ready' : 'anonymous');
      return;
    }
    if (generation !== sessionGenerationRef.current) return;
    navigate('/workbench/', true);
    snapshotRequestsEnabledRef.current = true;
    setSessionState('ready');
    await requestSnapshot().catch(() => undefined);
  };
  const onLogout = async () => {
    const generation = invalidateSession('loading');
    try { await workbenchApi.logout(); }
    catch (cause) { if (generation === sessionGenerationRef.current) setError(errorMessage(cause)); }
    if (generation === sessionGenerationRef.current) setSessionState('anonymous');
  };

  if (inviteToken) return <InviteAccept key={inviteToken} token={inviteToken} member={member} onSubmit={onAcceptInvite} onJoin={onJoinInvite} onSwitchAccount={onLogout} error={error} />;
  if (sessionState === 'loading' || sessionState === 'authenticating') return <CenteredState title="Loading Menoteam" detail="Checking your workspace session…" />;
  if (sessionState === 'anonymous') return <Login onSubmit={onLogin} error={error} />;
  if (sessionState === 'error' && !snapshot) return <CenteredState title="Menoteam is unavailable" detail={error} action={<Button variant="outline" onClick={() => void checkSession()}>Try again</Button>} />;
  if (!member || !snapshot) return error ? <CenteredState title="Workspace is unavailable" detail={<span role="alert">{error}</span>} action={<Button variant="outline" onClick={() => void refresh().catch(() => undefined)}>Retry</Button>} /> : <CenteredState title="Loading workspace" detail="Preparing your projects…" />;

  return <WorkbenchShell key={member.id} member={member} snapshot={snapshot} route={route} error={error} refresh={refresh} onLogout={onLogout} />;
}

function WorkbenchShell({ member, snapshot, route, error, refresh, onLogout }: { member: Member; snapshot: Snapshot; route: Route; error: string; refresh: () => Promise<void>; onLogout: () => Promise<void> }) {
  const project = selectProject(snapshot.projects, route.projectId);
  const currentWork = selectWork(snapshot.works, route.workId, project?.id);
  const selectedView = route.view;
  const [mobileNav, setMobileNav] = useState(false);
  const scope = JSON.stringify([member.id, route.view, route.projectId, route.workId, new URL(window.location.href).searchParams.get('tab')]);
  const pageScope = useMemo(() => ({ key: scope }), [scope]);
  const scopeRef = useRef<typeof pageScope | null>(null);
  const [localError, storeLocalError] = useState({ scope: pageScope, value: '' });
  const setLocalError = useCallback((value: string) => {
    if (scopeRef.current === pageScope) storeLocalError({ scope: pageScope, value });
  }, [pageScope]);
  useLayoutEffect(() => {
    scopeRef.current = pageScope;
    return () => { if (scopeRef.current === pageScope) scopeRef.current = null; };
  }, [pageScope]);
  const report = error || (localError.scope === pageScope ? localError.value : '');
  const workForProject = project ? snapshot.works.filter(item => item.projectId === project.id) : [];

  const canCreateProjects = member.role === 'owner' || member.role === 'admin';
  const content = selectedView === 'connect' ? canCreateProjects ? <ConnectProject refresh={refresh} setError={setLocalError} /> : <EmptyState title="Workspace administrator access required" detail="Only workspace administrators can create projects." />
    : !snapshot.projects.length && !['agent-profiles', 'model-providers', 'workspace-skills'].includes(selectedView)
      ? <EmptyState title="No projects yet" detail={canCreateProjects ? 'Create a project to start a shared Master conversation and organize work.' : 'You have not been added to a project yet.'} action={canCreateProjects ? <Button asChild><a className="inline-flex" href={href('connect')}>Create a project</a></Button> : undefined} />
      : !project && !['all', 'agent-profiles', 'model-providers', 'workspace-skills'].includes(selectedView)
        ? <EmptyState title="Project not found" detail="This project may have been removed or you may not have access." />
        : selectedView === 'all' ? <AllProjects snapshot={snapshot} member={member} setError={setLocalError} refresh={refresh} />
          : selectedView === 'master' && project ? <ConversationPage key={`master-${project.id}`} title="Master" messages={snapshot.messages.filter(message => message.projectId === project.id && !message.workId)} project={project} snapshot={snapshot} refresh={refresh} setError={setLocalError} initialDraft={new URL(window.location.href).searchParams.get('draft') ?? ''} />
              : selectedView === 'work' && project ? <WorkList project={project} works={workForProject} snapshot={snapshot} />
              : selectedView === 'work-detail' && project ? currentWork ? <WorkDetail key={`${member.id}:${project.id}:${currentWork.id}`} work={currentWork} project={project} snapshot={snapshot} refresh={refresh} setError={setLocalError} /> : <EmptyState title="Work not found" detail="Choose a Work from the project list." action={<a href={href('work', project.id)}>Open Work</a>} />
                : selectedView === 'instructions' && project ? <Instructions key={project.id} project={project} member={member} refresh={refresh} setError={setLocalError} />
                  : selectedView === 'members' && project ? <Members key={project.id} project={project} snapshot={snapshot} refresh={refresh} setError={setLocalError} />
                    : selectedView === 'skills' || selectedView === 'workspace-skills' || selectedView === 'connections' || selectedView === 'agent-profiles' || selectedView === 'model-providers' ? ['agent-profiles', 'model-providers', 'workspace-skills'].includes(selectedView) && member.role === 'member' ? <EmptyState title="Workspace administrator access required" detail="Workspace-wide Agent profiles, skills and runtime status are visible to workspace administrators." /> : <SettingsPage key={`${member.id}:${project?.id ?? "workspace"}:${selectedView}`} view={selectedView} project={project} member={member} snapshot={snapshot} refresh={refresh} setError={setLocalError} />
                      : <EmptyState title="Choose a Work" detail="Work details include the current overview, changes, QA, and the ongoing participant conversation." />;

  return <div className="flex min-h-screen bg-background text-foreground">
    <aside className={`${mobileNav ? 'flex' : 'hidden'} fixed inset-y-0 left-0 z-40 w-64 flex-col border-r border-border bg-muted/50 p-3 md:static md:flex md:w-60`}>
      <a href={href('all')} className="mb-5 flex items-center gap-2 rounded-md px-2 py-2 text-base font-semibold text-foreground no-underline"><span className="grid size-7 place-items-center rounded-md bg-zinc-800 text-xs font-semibold text-white">M</span>menoteam</a>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="Main navigation">
        <NavLink active={selectedView === 'all'} href={href('all')}>All projects</NavLink>
        {snapshot.projects.map(item => <section className="mt-2" key={item.id}>
          <a className={`flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium no-underline hover:bg-accent ${project?.id === item.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`} href={href('master', item.id)}><span className="grid size-6 shrink-0 place-items-center rounded-md bg-white text-xs font-semibold text-accent-foreground">{item.name.slice(0, 1).toUpperCase()}</span><span className="truncate">{item.name}</span></a>
          <div className="ml-4 mt-1 grid gap-0.5 border-l border-border pl-3">
            <NavLink active={project?.id === item.id && selectedView === 'master'} href={href('master', item.id)}>Master</NavLink>
            <NavLink active={project?.id === item.id && ['work', 'work-detail'].includes(selectedView)} href={href('work', item.id)}>Work</NavLink>
            <NavLink active={project?.id === item.id && ['instructions', 'skills', 'members', 'connections'].includes(selectedView)} href={href('instructions', item.id)}>Project settings</NavLink>
          </div>
        </section>)}
        <div className="mt-auto grid gap-1 border-t border-border pt-3">
          {canCreateProjects && <NavLink active={selectedView === 'connect'} href={href('connect')}><Plus aria-hidden="true" className="mr-1 inline size-4" />Add project</NavLink>}
          {member.role !== 'member' && <><NavLink active={['agent-profiles', 'model-providers', 'workspace-skills'].includes(selectedView)} href={href('agent-profiles')}>Workspace settings</NavLink><div className="ml-4 grid gap-0.5 border-l border-border pl-3"><NavLink active={selectedView === 'workspace-skills'} href={href('workspace-skills')}>Workspace skills</NavLink></div></>}
        </div>
      </nav>
      <Button type="button" variant="ghost" aria-label="Sign out" className="mt-3 flex h-auto min-h-16 items-center gap-2 border-t border-border px-2 py-3 text-left" onClick={() => void onLogout()}><span className="grid size-8 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">{member.name.slice(0, 1).toUpperCase()}</span><span className="grid min-w-0 flex-1"><strong className="truncate text-sm">{member.name}</strong><small className="text-muted-foreground">{member.role}</small></span><LogOut aria-hidden="true" className="size-4" /></Button>
    </aside>
    {mobileNav && <button className="fixed inset-0 z-30 bg-black/20 md:hidden" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 flex min-h-14 min-w-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur md:px-7">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open navigation" onClick={() => setMobileNav(!mobileNav)}><Menu aria-hidden="true" className="size-4" /></Button>
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
  const isWorkspaceView = route.view === 'all' || route.view === 'connect' || route.view === 'workspace-skills' || route.view === 'agent-profiles' || route.view === 'model-providers';
  const current = route.view === 'all' ? 'All projects' : route.view === 'connect' ? 'Connect project' : route.view === 'master' ? 'Master' : route.view === 'work' ? 'Work' : route.view === 'work-detail' ? 'Work detail' : route.view === 'instructions' ? 'Instructions' : route.view === 'skills' || route.view === 'workspace-skills' ? 'Skills' : route.view === 'members' ? 'Members' : route.view === 'connections' ? 'Connections' : route.view === 'model-providers' ? 'Model providers' : 'Agent profiles';
  const projectName = isWorkspaceView ? 'Workspace' : project?.name ?? 'Project';
  return <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground"><a aria-label={projectName} title={projectName} className="min-w-0 basis-[38%] shrink-0 truncate text-muted-foreground no-underline hover:text-foreground sm:basis-auto sm:shrink sm:max-w-none" href={href(isWorkspaceView ? 'all' : 'master', isWorkspaceView ? '' : project?.id)}>{projectName}</a><ChevronRight aria-hidden="true" className="size-4 shrink-0" />{route.view === 'work-detail' ? <><a className="shrink-0 text-muted-foreground no-underline hover:text-foreground" href={href('work', project?.id)}>Work</a><ChevronRight aria-hidden="true" className="size-4 shrink-0" /><strong aria-label={work?.title ?? current} title={work?.title ?? current} className="min-w-16 flex-1 truncate text-foreground">{current}</strong></> : ['instructions', 'skills', 'members', 'connections'].includes(route.view) ? <><a className="min-w-0 shrink truncate text-muted-foreground no-underline hover:text-foreground" href={href('instructions', project?.id)}>Project settings</a><ChevronRight aria-hidden="true" className="size-4 shrink-0" /><strong title={current} className="min-w-16 flex-1 truncate text-foreground">{current}</strong></> : <strong title={current} className="min-w-16 flex-1 truncate text-foreground">{current}</strong>}</nav>;
}

function Login({ onSubmit, error }: { onSubmit: (email: string, password: string) => Promise<void>; error: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  return <main className="grid min-h-screen place-items-center bg-muted/50 p-4"><form className="grid w-full max-w-sm gap-5 rounded-xl border border-border bg-background p-6 shadow-sm" onSubmit={async event => { event.preventDefault(); setBusy(true); await onSubmit(email, password); setBusy(false); }}>
    <header><div className="mb-3 grid size-9 place-items-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">M</div><h1 className="text-xl font-semibold">Sign in to Menoteam</h1><p className="mt-1 text-sm text-muted-foreground">Use your invited workspace account.</p></header>
    <div className="grid gap-2"><Label htmlFor="login-email">Email</Label><Input id="login-email" autoComplete="username" type="email" required value={email} onChange={event => setEmail(event.target.value)} /></div>
    <div className="grid gap-2"><Label htmlFor="login-password">Password</Label><Input id="login-password" autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} /></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
  </form></main>;
}

function InviteAccept({ token, member, onSubmit, onJoin, onSwitchAccount, error }: { token: string; member: Member | null; onSubmit: (token: string, name: string, password: string) => Promise<void>; onJoin: (token: string, email?: string, password?: string) => Promise<void>; onSwitchAccount: () => Promise<void>; error: string }) {
  const [existing, setExisting] = useState(false);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  return <main className="grid min-h-screen place-items-center bg-muted/50 p-4"><form className="grid w-full max-w-sm gap-5 rounded-xl border border-border bg-background p-6 shadow-sm" onSubmit={async event => { event.preventDefault(); setBusy(true); try { if (member) await onJoin(token); else if (existing) await onJoin(token, email, password); else await onSubmit(token, name, password); } finally { setBusy(false); } }}>
    <header><h1 className="text-xl font-semibold">Join Menoteam</h1><p className="mt-1 text-sm text-muted-foreground">{member ? `Accept this project invitation as ${member.email}.` : existing ? 'Sign in with the account this invitation was sent to.' : 'Set up your account to accept this invitation.'}</p></header>
    {member && <Button type="button" variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { await onSwitchAccount(); } finally { setBusy(false); } }}>Use a different account</Button>}
    {!member && <>
      {existing ? <div className="grid gap-2"><Label htmlFor="invite-email">Email</Label><Input id="invite-email" autoComplete="email" type="email" required value={email} onChange={event => setEmail(event.target.value)} /></div> : <div className="grid gap-2"><Label htmlFor="invite-name">Name</Label><Input id="invite-name" autoComplete="name" required value={name} onChange={event => setName(event.target.value)} /></div>}
      <div className="grid gap-2"><Label htmlFor="invite-password">Password</Label><Input id="invite-password" autoComplete={existing ? 'current-password' : 'new-password'} type="password" minLength={existing ? undefined : 12} required value={password} onChange={event => setPassword(event.target.value)} /></div>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setExisting(!existing); setPassword(''); }}>{existing ? 'Create a new account' : 'Already have an account? Sign in'}</Button>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button disabled={busy}>{busy ? 'Joining…' : existing && !member ? 'Sign in and join' : 'Accept invitation'}</Button>
  </form></main>;
}

function CenteredState({ title, detail, action }: { title: string; detail: React.ReactNode; action?: React.ReactNode }) { return <main className="grid min-h-screen place-items-center p-6"><div className="grid max-w-md justify-items-center gap-3 text-center"><span className="grid size-9 place-items-center rounded-lg bg-accent font-semibold text-accent-foreground">M</span><h1 className="text-lg font-semibold">{title}</h1><p className="text-sm text-muted-foreground">{detail}</p>{action}</div></main>; }
function EmptyState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) { return <section className="grid min-h-64 content-center justify-items-center gap-3 rounded-xl border border-border border-dashed p-8 text-center"><h1 className="text-lg font-semibold">{title}</h1><p className="max-w-md text-sm text-muted-foreground">{detail}</p>{action}</section>; }

function AllProjects({ snapshot, member, setError, refresh }: { snapshot: Snapshot; member: Member; setError: (value: string) => void; refresh: () => Promise<void> }) {
  if (!snapshot.projects.length) return <EmptyState title="No projects yet" detail={member.role === 'member' ? 'You have not been added to a project yet.' : 'Create a project to start collaborating.'} action={member.role === 'member' ? undefined : <Button asChild><a href={href('connect')}>Create a project</a></Button>} />;
  return <div className="grid gap-6 xl:grid-cols-2">{snapshot.projects.map(project => <ProjectCard key={project.id} project={project} snapshot={snapshot} setError={setError} refresh={refresh} />)}</div>;
}

function masterBootstrapConnections(snapshot: Snapshot, projectId: string) {
  return (snapshot.providerConnections ?? []).filter(connection => connection.enabled && connection.status === 'available' && connection.projectIds.includes(projectId) && !!connection.connectorId && connection.models.includes('gpt-6.1-sol'));
}

function canBootstrapMaster(snapshot: Snapshot, projectId: string, messages: Message[]) {
  return messages.length === 0 && !snapshot.runs.some(run => run.projectId === projectId && run.kind === 'master' && !isCausalMasterWake(run));
}

function ProjectCard({ project, snapshot, setError, refresh }: { project: Project; snapshot: Snapshot; setError: (value: string) => void; refresh: () => Promise<void> }) {
  const history = useMessageHistory(project.id, undefined, false);
  const { messages, loadOlder, hasOlder, loadingOlder, olderError } = history;
  const [observedMessages, setObservedMessages] = useState<Message[]>([]);
  useEffect(() => {
    const incoming = snapshot.messages.filter(message => message.projectId === project.id && !message.workId);
    if (!incoming.length) return;
    // Keep snapshot updates for this mounted card even after global snapshot eviction.
    setObservedMessages(current => [...new Map([...current, ...incoming].map(message => [message.id, message])).values()]);
  }, [snapshot.messages, project.id]);
  const byId = new Map([...messages, ...snapshot.messages.filter(message => message.projectId === project.id && !message.workId)].map(message => [message.id, message]));
  observedMessages.forEach(message => byId.set(message.id, message));
  const visibleMessages = [...byId.values()].sort(messageOrder);
  const scroll = useConversationScroll(visibleMessages, history.initialState, loadingOlder, loadOlder);
  return <section className="flex h-[min(70vh,46rem)] min-h-[26rem] min-w-0 flex-col rounded-xl border border-border bg-background p-4 md:p-5">
    <header className="mb-3 flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent font-semibold text-accent-foreground">{project.name.slice(0, 1).toUpperCase()}</span><div className="min-w-0"><h2 className="truncate font-semibold">{project.name}</h2><a className="text-xs text-muted-foreground no-underline hover:underline" href={href('master', project.id)}>Open Master</a></div></div><Badge variant="outline">Project</Badge></header>
    <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1" aria-label={`${project.name} conversation`} aria-live="polite">
      <MessageHistoryStatus history={history} onRetry={() => void history.retry()} />
      {olderError && <p className="text-sm text-destructive" role="alert">Could not load earlier messages: {olderError}</p>}
      {hasOlder && <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void scroll.loadOlder()}>{loadingOlder ? 'Loading…' : olderError ? 'Retry loading earlier messages' : 'Load earlier messages'}</Button>}
      {visibleMessages.length ? visibleMessages.map(message => <MessageRow key={message.id} message={message} userName={snapshot.member.name} />) : history.initialState === 'loading' ? <p className="py-8 text-center text-sm text-muted-foreground" role="status">Loading messages…</p> : history.initialState === 'loaded' ? <p className="py-8 text-center text-sm text-muted-foreground">No messages yet. Start with the project Master.</p> : null}
    </div>
    <MessageComposer memberId={snapshot.member.id} project={project} refresh={refresh} setError={setError} bootstrapConnections={canBootstrapMaster(snapshot, project.id, visibleMessages) ? masterBootstrapConnections(snapshot, project.id) : []} />
  </section>;
}

function ConversationPage({ title, messages, project, snapshot, work, refresh, setError, initialDraft = '' }: { title: string; messages: Message[]; project: Project; snapshot: Snapshot; work?: Work; refresh: () => Promise<void>; setError: (value: string) => void; initialDraft?: string }) {
  const workRuns = snapshot.runs.filter(run => run.projectId === project.id && run.workId === work?.id && (['queued', 'running', 'paused', 'failed', 'interrupted', 'cancelled'].includes(run.status) || run.status === 'completed' && run.slackReply?.state === 'blocked'));
  const handoffHistory = snapshot.runs.filter(run => run.projectId === project.id && run.workId === work?.id && run.kind === 'implementation' && (run.threadId || run.execution?.connectorId || run.connectorId || run.targetConnectorId)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  const latestImplementation = handoffHistory.at(-1);
  const handoffConnectorId = latestImplementation?.execution?.connectorId ?? latestImplementation?.connectorId ?? latestImplementation?.targetConnectorId;
  const handoffConnection = latestImplementation && snapshot.providerConnections?.find(connection => connection.id === (latestImplementation.execution?.connectionId ?? work?.connectionId) && connection.connectorId === handoffConnectorId && connection.status === 'available');
  const handoffReserved = latestImplementation && snapshot.runs.some(run => run.projectId === project.id && run.workId === work?.id && run.id !== latestImplementation.id && run.kind !== 'master' && (['queued', 'running', 'paused', 'interrupted'].includes(run.status) || run.status === 'cancelled' && !run.stoppedAt));
  const handoffSource = latestImplementation && handoffConnection && latestImplementation.threadId && latestImplementation.execution && latestImplementation.execution.model === latestImplementation.model && (['completed', 'failed'].includes(latestImplementation.status) || latestImplementation.status === 'cancelled' && Boolean(latestImplementation.stoppedAt)) && !handoffReserved ? latestImplementation : undefined;
  const canManageProject = useProjectAdmin(project.id, snapshot.member, snapshot.projectRoles?.[project.id]);
  const history = useMessageHistory(project.id, work?.id);
  const displayedMessages = [...new Map([...messages, ...history.messages].map(message => [message.id, message])).values()].sort(messageOrder);
  const scroll = useConversationScroll(displayedMessages, history.initialState, history.loadingOlder, history.loadOlder);
  const firstImplementation = work ? snapshot.runs.filter(run => run.projectId === project.id && run.workId === work.id && run.kind === 'implementation')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] : undefined;
  const frozenProfileId = firstImplementation?.execution?.profileId ?? firstImplementation?.execution?.profile?.id ?? work?.profileId;
  const agentName = work
    ? firstImplementation?.execution?.profile?.name ?? snapshot.settings.find(setting => setting.kind === 'profile' && !setting.projectId && setting.id === frozenProfileId)?.name ?? 'Agent'
    : undefined;
  return <div className={`${work ? 'flex min-h-0 flex-1 flex-col' : 'flex h-[calc(100dvh-7.5rem)] flex-col'}`}>
    {title && <div className="mb-5 flex items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{work ? 'Conversation with the responsible Agent, Master, and subagents.' : `Project conversation · ${project.name}`}</p></div>{work && <Badge variant="outline">{work.status.replace('_', ' ')}</Badge>}</div>}
    {workRuns.map(run => <RunNotice key={run.id} run={run} canManageProject={canManageProject} refresh={refresh} setError={setError} blockingRuns={!work && run.kind === 'master' && run.status === 'queued' ? snapshot.runs.filter(other => blocksRunClaim(run, other)) : undefined} />)}
    <MessageHistoryStatus history={history} onRetry={() => void history.retry()} />
    <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 space-y-6 overflow-y-auto py-4" aria-live="polite">{history.olderError && <p className="text-sm text-destructive" role="alert">Could not load earlier messages: {history.olderError}</p>}{history.hasOlder && <Button variant="ghost" size="sm" disabled={history.loadingOlder} onClick={() => void scroll.loadOlder()}>{history.loadingOlder ? 'Loading…' : history.olderError ? 'Retry loading earlier messages' : 'Load earlier messages'}</Button>}{displayedMessages.length ? displayedMessages.map(message => <MessageRow key={message.id} message={message} multiParticipant={!!work} userName={snapshot.member.name} />) : history.initialState === 'loading' ? <p className="py-16 text-center text-sm text-muted-foreground" role="status">Loading messages…</p> : history.initialState === 'loaded' ? <p className="py-16 text-center text-sm text-muted-foreground">No messages yet. Send a message to begin.</p> : null}</div>
    <MessageComposer key={`composer-${project.id}-${work?.id ?? 'master'}`} memberId={snapshot.member.id} project={project} work={work} agentName={agentName} handoffSource={handoffSource} handoffConnection={handoffSource ? handoffConnection : undefined} refresh={refresh} setError={setError} initialDraft={initialDraft} bootstrapConnections={!work && canBootstrapMaster(snapshot, project.id, displayedMessages) ? masterBootstrapConnections(snapshot, project.id) : []} />
  </div>;
}

function useMessageHistory(projectId: string, workId?: string, poll = true) {
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const generationRef = useRef(0);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderPendingRef = useRef(false);
  const initialPendingRef = useRef(false);
  const historyPendingRef = useRef(false);
  const initialLoadedRef = useRef(false);
  const [initialState, setInitialState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [error, setError] = useState('');
  const [olderError, setOlderError] = useState('');
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
    const generation = ++generationRef.current;
    initialPendingRef.current = true; historyPendingRef.current = true; initialLoadedRef.current = false;
    messagesRef.current = []; olderPendingRef.current = false;
    setMessages([]); setNextBefore(null); setLoadingOlder(false); setInitialState('loading'); setError(''); setOlderError('');
    const request = (after?: string) => workbenchApi.projectMessages(projectId, { ...query, ...(after ? { after } : {}) });
    void request().then(result => { if (active && generation === generationRef.current) { merge(result.messages); setNextBefore(result.nextBefore); initialLoadedRef.current = true; setInitialState('loaded'); setError(''); } }).catch(cause => { if (active && generation === generationRef.current) { setInitialState('error'); setError(errorMessage(cause)); } }).finally(() => { if (generation === generationRef.current) { initialPendingRef.current = false; historyPendingRef.current = false; } });
    const timer = poll ? window.setInterval(() => {
      if (!active || historyPendingRef.current || !initialLoadedRef.current || document.hidden || !canAutoPoll()) return;
      historyPendingRef.current = true;
      const last = messagesRef.current.at(-1)?.createdAt;
      const after = last ? new Date(new Date(last).getTime() - 2_000).toISOString() : undefined;
      void request(after).then(result => { if (active && generation === generationRef.current) { if (result.messages.length) merge(result.messages); setError(''); } }).catch(cause => { if (active && generation === generationRef.current) setError(errorMessage(cause)); }).finally(() => { if (generation === generationRef.current) historyPendingRef.current = false; });
    }, 2_000) : undefined;
    return () => { active = false; ++generationRef.current; initialPendingRef.current = false; historyPendingRef.current = false; olderPendingRef.current = false; initialLoadedRef.current = false; window.clearInterval(timer); };
  }, [projectId, workId, merge, poll]);
  const retry = useCallback(async () => {
    const generation = generationRef.current;
    if (initialState === 'error') {
      if (initialState !== 'error' || initialPendingRef.current) return;
      initialPendingRef.current = true;
      setInitialState('loading'); setError('');
      try { const result = await workbenchApi.projectMessages(projectId, query); if (generation === generationRef.current) { merge(result.messages); setNextBefore(result.nextBefore); initialLoadedRef.current = true; setInitialState('loaded'); } }
      catch (cause) { if (generation === generationRef.current) { setInitialState('error'); setError(errorMessage(cause)); } }
      finally { if (generation === generationRef.current) initialPendingRef.current = false; }
      return;
    }
    if (!error || initialState !== 'loaded' || historyPendingRef.current) return;
    historyPendingRef.current = true;
    const last = messagesRef.current.at(-1)?.createdAt;
    const after = last ? new Date(new Date(last).getTime() - 2_000).toISOString() : undefined;
    setError('');
    try { const result = await workbenchApi.projectMessages(projectId, { ...query, ...(after ? { after } : {}) }); if (generation === generationRef.current) { if (result.messages.length) merge(result.messages); } }
    catch (cause) { if (generation === generationRef.current) setError(errorMessage(cause)); }
    finally { if (generation === generationRef.current) historyPendingRef.current = false; }
  }, [error, initialState, merge, projectId, workId]);
  const loadOlder = useCallback(async () => {
    if (!nextBefore || olderPendingRef.current) return;
    const generation = generationRef.current;
    olderPendingRef.current = true;
    setLoadingOlder(true);
    setOlderError('');
    try { const result = await workbenchApi.projectMessages(projectId, { ...query, before: nextBefore }); if (generation === generationRef.current) { merge(result.messages); setNextBefore(result.nextBefore); } }
    catch (cause) { if (generation === generationRef.current) setOlderError(errorMessage(cause)); }
    finally { if (generation === generationRef.current) { olderPendingRef.current = false; setLoadingOlder(false); } }
  }, [merge, nextBefore, projectId, workId]);
  return { messages, loadOlder, retry, hasOlder: Boolean(nextBefore), loadingOlder, initialState, error, olderError };
}

function MessageHistoryStatus({ history, onRetry }: { history: ReturnType<typeof useMessageHistory>; onRetry: () => void }) {
  if (!history.error) return null;
  return <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" role="alert"><span>Could not load messages: {history.error}</span><Button type="button" variant="outline" size="sm" disabled={history.initialState === 'loading'} onClick={onRetry}>{history.initialState === 'loading' ? 'Retrying…' : 'Retry'}</Button></div>;
}

function MessageRow({ message, multiParticipant = false, userName = 'You' }: { message: Message; multiParticipant?: boolean; userName?: string }) {
  const user = message.role === 'user';
  return <article data-message-id={message.id} className={`group flex items-start gap-3 ${user ? 'justify-end' : 'justify-start'}`}>
    {multiParticipant && !user && <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">{message.speaker.slice(0, 1).toUpperCase()}</span>}
    <div className={`min-w-0 max-w-[88%] ${user ? 'text-right' : ''}`}>
      {multiParticipant && !user && <p className="mb-1 text-xs font-medium text-muted-foreground">{message.speaker}</p>}
      <div className={user ? 'min-w-0 rounded-2xl rounded-br-sm bg-muted px-4 py-2.5' : 'min-w-0'}><Markdown>{message.text}</Markdown></div>
      <time className={`mt-1 block h-4 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${user ? 'text-left' : 'text-right'}`} dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
    </div>
    {multiParticipant && user && <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold">{userName.slice(0, 1).toUpperCase()}</span>}
  </article>;
}

function MessageComposer({ memberId, project, work, agentName, handoffSource, handoffConnection, refresh, setError, initialDraft = '', bootstrapConnections = [] }: { memberId: string; project: Project; work?: Work; agentName?: string; handoffSource?: SnapshotRun; handoffConnection?: NonNullable<Snapshot['providerConnections']>[number]; refresh: () => Promise<void>; setError: (value: string) => void; initialDraft?: string; bootstrapConnections?: NonNullable<Snapshot['providerConnections']> }) {
  const draftKey = `menoteam-workbench:draft:${memberId}:${project.id}:${work?.id ?? 'master'}`;
  const connectionKey = work ? '' : `menoteam-workbench:bootstrap-connection:${memberId}:${project.id}`;
  const [text, setText] = useState(() => { try { return sessionStorage.getItem(draftKey) || initialDraft; } catch { return initialDraft; } }); const [busy, setBusy] = useState(false); const [connectionId, setConnectionId] = useState(() => { try { return connectionKey ? sessionStorage.getItem(connectionKey) ?? '' : ''; } catch { return ''; } }); const [handoffMode, setHandoffMode] = useState(false); const [handoffModel, setHandoffModel] = useState(''); const [handoffReasoning, setHandoffReasoning] = useState('');
  const handoffModels = (handoffConnection?.models ?? []).filter(model => (handoffConnection?.modelReasoningEfforts?.[model]?.length ?? 0) > 0);
  const advertisedEfforts = handoffConnection?.modelReasoningEfforts?.[handoffModel] ?? [];
  const handoffReady = Boolean(handoffMode && handoffSource && handoffModel && handoffModels.includes(handoffModel) && handoffReasoning && advertisedEfforts.includes(handoffReasoning));
  useEffect(() => { setHandoffMode(false); setHandoffModel(''); setHandoffReasoning(''); }, [handoffSource?.id]);
  useEffect(() => { try { sessionStorage.setItem(draftKey, text); } catch { /* Keep the draft in memory when storage is unavailable. */ } }, [draftKey, text]);
  useEffect(() => { if (!connectionKey) return; try { if (connectionId) sessionStorage.setItem(connectionKey, connectionId); else sessionStorage.removeItem(connectionKey); } catch { /* Keep the selection in memory when storage is unavailable. */ } }, [connectionKey, connectionId]);
  useEffect(() => { if (!initialDraft) return; setText(current => current || initialDraft); const url = new URL(window.location.href); url.searchParams.delete('draft'); navigate(`${url.pathname}${url.search}${url.hash}`, true); }, [initialDraft]);
  return <form className={`mt-4 min-w-0 gap-2 border border-border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40 ${handoffMode ? 'flex flex-col items-stretch rounded-xl' : work ? 'grid grid-cols-[auto_minmax(0,1fr)_auto] rounded-xl' : 'flex items-center rounded-full'}`} onSubmit={async event => {
    event.preventDefault(); const value = text.trim(); if (!value || busy || (connectionId && !bootstrapConnections.some(item => item.id === connectionId)) || (handoffMode && !handoffReady)) return;
    setBusy(true); setError('');
    try { await workbenchApi.sendMessage(project.id, { text: value, ...(work ? { workId: work.id } : {}), ...(!work && bootstrapConnections.some(item => item.id === connectionId) ? { connectionId } : {}), ...(handoffMode && handoffSource ? { handoff: { fromRunId: handoffSource.id, model: handoffModel, reasoning: handoffReasoning } } : {}), requestId: crypto.randomUUID() }); setText(''); setConnectionId(''); setHandoffMode(false); setHandoffModel(''); setHandoffReasoning(''); await refresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
    {handoffMode && handoffSource && handoffConnection && <div className="grid gap-3 rounded-lg bg-muted/40 p-3 sm:grid-cols-2"><p className="text-sm text-muted-foreground sm:col-span-2">Continues Work {work?.title} on the same Connector and native thread. This new run uses the selected model and reasoning; the saved Agent profile remains unchanged.</p><div className="grid gap-2"><Label htmlFor={`handoff-model-${work?.id}`}>Model</Label><NativeSelect id={`handoff-model-${work?.id}`} className="h-9 rounded-md border bg-background px-3 text-sm" value={handoffModel} onChange={event => { setHandoffModel(event.target.value); setHandoffReasoning(''); }}><NativeSelectOption value="">Choose a reported model</NativeSelectOption>{handoffModels.map(model => <NativeSelectOption key={model} value={model}>{model}</NativeSelectOption>)}</NativeSelect></div><div className="grid gap-2"><Label htmlFor={`handoff-reasoning-${work?.id}`}>Advertised reasoning effort</Label><NativeSelect id={`handoff-reasoning-${work?.id}`} className="h-9 rounded-md border bg-background px-3 text-sm" value={handoffReasoning} onChange={event => setHandoffReasoning(event.target.value)} disabled={!advertisedEfforts.length}><NativeSelectOption value="">Choose an advertised effort</NativeSelectOption>{advertisedEfforts.map(effort => <NativeSelectOption key={effort} value={effort}>{effort}</NativeSelectOption>)}</NativeSelect></div><Button type="button" variant="ghost" size="sm" className="justify-self-start sm:col-span-2" onClick={() => { setHandoffMode(false); setHandoffModel(''); setHandoffReasoning(''); }}>Cancel model switch</Button></div>}
    {!work && (bootstrapConnections.length > 0 || connectionId) && <NativeSelect aria-label="Master provider connection" wrapperClassName="max-w-48" className="h-9 rounded-md border bg-background px-2 text-xs" value={connectionId} onChange={event => setConnectionId(event.target.value)}><NativeSelectOption value="">Workspace default</NativeSelectOption>{connectionId && !bootstrapConnections.some(item => item.id === connectionId) && <NativeSelectOption value={connectionId} disabled>Previously selected connection unavailable</NativeSelectOption>}{bootstrapConnections.map(connection => <NativeSelectOption key={connection.id} value={connection.id}>{connection.name}</NativeSelectOption>)}</NativeSelect>}
    {work && !handoffMode && <Input autoFocus={new URL(window.location.href).searchParams.has('draft')} aria-label={`Message ${agentName || 'Agent'}`} className="col-span-full row-start-1 h-10 min-w-0 w-full border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder={`Message ${agentName || 'Agent'}…`} value={text} onChange={event => setText(event.target.value)} />}
    <div className={work && !handoffMode ? 'col-span-full flex min-w-0 items-center gap-2 border-t border-border pt-2' : 'contents'}>
      {!handoffMode && <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center text-muted-foreground"><Plus className="size-4" /></span>}
      {!(work && !handoffMode) && <Input autoFocus={new URL(window.location.href).searchParams.has('draft')} aria-label={`Message ${work ? agentName || 'Agent' : 'Master'}`} className="h-10 min-w-0 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder={`Message ${work ? agentName || 'Agent' : 'Master'}…`} value={text} onChange={event => setText(event.target.value)} />}
      {!handoffMode && <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center text-muted-foreground"><Mic className="size-4" /></span>}
      {!handoffMode && handoffSource && handoffConnection && handoffModels.length > 0 && <Button type="button" size="sm" variant="outline" className="shrink-0 whitespace-nowrap" disabled={busy} onClick={() => setHandoffMode(true)}>Switch model</Button>}
      {connectionId && !bootstrapConnections.some(item => item.id === connectionId) && <span role="alert" className="text-xs text-destructive">Selected connection unavailable; no default will be substituted.</span>}
      <Button className={handoffMode ? 'sm:min-w-48' : 'size-9 shrink-0 rounded-full'} disabled={busy || !text.trim() || Boolean(connectionId && !bootstrapConnections.some(item => item.id === connectionId)) || handoffMode && !handoffReady} aria-label={handoffMode ? 'Switch model and continue' : 'Send message'}>{handoffMode ? busy ? 'Switching…' : 'Switch model and continue' : <Send aria-hidden="true" className="size-4" />}</Button>
    </div>
  </form>;
}

function RunNotice({ run, canManageProject, refresh, setError, blockingRuns }: { run: SnapshotRun; canManageProject: boolean; refresh: () => Promise<void>; setError: (value: string) => void; blockingRuns?: SnapshotRun[] }) {
  const queuedOrRunning = run.status === 'queued' || run.status === 'running';
  const cancelablePaused = run.kind !== 'delivery' && (run.status === 'paused' || run.status === 'interrupted');
  const pausedWaitingForStop = run.status === 'paused' && !run.stoppedAt;
  const interruptedWaitingForStop = run.status === 'interrupted' && !run.stoppedAt;
  const cancellationPending = run.status === 'cancelled' && !run.stoppedAt;
  const interruptedNextStep = cancelablePaused ? interruptedWaitingForStop ? '; End or wait for stop confirmation' : canManageProject ? '; Resume or End' : '; End' : '';
  return <><div id={`run-${encodeURIComponent(run.id)}`} role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"><span><strong>{runNoticeLabel(run)}</strong>{cancellationPending ? ' · Waiting for the Connector to confirm it has stopped' : run.status === 'interrupted' ? interruptedWaitingForStop ? ` · Waiting for the Connector to verify the old process has stopped${interruptedNextStep}` : ` · The Connector confirmed the old process stopped${interruptedNextStep}` : run.error ? ` · ${run.error}` : pausedWaitingForStop ? ' · Waiting for the Connector to confirm it has stopped before resuming' : ` · ${run.kind} run`}{run.slackReply?.state === 'blocked' && <> · Slack reply blocked · {run.slackReply.cause}</>}</span>{(queuedOrRunning || cancelablePaused) && <div className="flex gap-2">{queuedOrRunning && <Button variant="outline" size="sm" onClick={async () => { try { await workbenchApi.pauseRun(run.id); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Pause</Button>}<Button variant="ghost" size="sm" onClick={async () => { try { await workbenchApi.cancelRun(run.id); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>{cancelablePaused ? 'End' : 'Cancel'}</Button></div>}{run.status === 'paused' && run.stoppedAt && <Button variant="outline" size="sm" onClick={async () => { try { await workbenchApi.resumeRun(run.id); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Resume</Button>}{run.status === 'interrupted' && run.stoppedAt && canManageProject && <Button variant="outline" size="sm" onClick={async () => { try { await workbenchApi.reconcileRun(run.id); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Resume</Button>}</div>{blockingRuns && blockingRuns.length > 0 && <section className="mb-3 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm" aria-label={`Runs blocking ${runNoticeLabel(run)}`}><p className="font-medium">Waiting for these runs</p><ul className="mt-2 list-disc space-y-1 pl-5">{blockingRuns.map(blocker => <li key={blocker.id}><a className="underline underline-offset-2" href={`#run-${encodeURIComponent(blocker.id)}`}>{runNoticeLabel(blocker)}</a></li>)}</ul></section>}</>;
}

function WorkList({ project, works, snapshot }: { project: Project; works: Work[]; snapshot: Snapshot }) {
  const url = new URL(window.location.href); const selectedStatus = url.searchParams.get('status') ?? 'All';
  const query = url.searchParams.get('q') ?? '';
  const visibleWorks = filterWorks(works, selectedStatus, query);
  const updateQuery = (value: string) => {
    const next = new URL(window.location.href);
    if (value) next.searchParams.set('q', value); else next.searchParams.delete('q');
    navigate(`${next.pathname}${next.search}${next.hash}`, true);
  };
  const newWorkHref = `${href('master', project.id)}&draft=${encodeURIComponent('Help me plan a new work: ')}`;
  const workListHref = (status: string) => {
    const next = new URL(href('work', project.id), window.location.origin);
    if (status !== 'All') next.searchParams.set('status', status);
    if (query) next.searchParams.set('q', query);
    return `${next.pathname}${next.search}`;
  };
  return <><header className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">Work</h1><p className="mt-1 text-sm text-muted-foreground">{project.name}</p></div><Button asChild><a href={newWorkHref}><Plus aria-hidden="true" className="mr-1 size-4" />New work</a></Button></header>
    <nav className="mb-4 flex gap-5 border-b border-border" aria-label="Filter work">{['All', 'In progress', 'Paused', 'Done'].map(status => <a key={status} aria-current={selectedStatus === status ? 'page' : undefined} className={`border-b-2 px-1 py-3 text-sm no-underline ${selectedStatus === status ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground'}`} href={workListHref(status)}>{status}</a>)}</nav>
    <div className="mb-5 max-w-xl"><Label htmlFor="work-search">Search Work</Label><Input id="work-search" type="search" value={query} onChange={event => updateQuery(event.target.value)} placeholder="Search titles and overviews" /></div>
    {visibleWorks.length ? <div className="overflow-hidden rounded-xl border border-border bg-background">{visibleWorks.map(work => { const connection = snapshot.providerConnections?.find(item => item.id === work.connectionId); return <a key={work.id} className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-4 py-3 text-foreground no-underline last:border-b-0 hover:bg-muted/40" href={href('work-detail', project.id, work.id)}><span className="min-w-0"><strong className="block truncate text-sm">{work.title}</strong><span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{work.overview}</span><span className="mt-2 block text-xs text-muted-foreground">Provider · {connection?.name ?? (work.connectionId ? 'Unavailable connection' : 'Historical execution')}</span></span><span className="flex flex-col items-end gap-2"><Badge variant="outline" className="capitalize">{work.status.replace('_', ' ')}</Badge>{connection && <Badge variant={connection.status === 'available' ? 'secondary' : 'outline'}>{connection.status}</Badge>}</span></a>; })}</div> : query.trim() ? <EmptyState title="No matching Work" detail={`No Work matches “${query.trim()}” in ${selectedStatus}. Clear the search to see this status again.`} action={<Button variant="outline" onClick={() => updateQuery('')}>Clear search</Button>} /> : <EmptyState title={selectedStatus === 'All' ? 'No Work yet' : `No ${selectedStatus.toLowerCase()} Work`} detail="Start a conversation with Master to define a new Work." action={<Button asChild><a href={newWorkHref}>Start with Master</a></Button>} />}
  </>;
}

function WorkDetail({ work, project, snapshot, refresh, setError }: { work: Work; project: Project; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const url = new URL(window.location.href); const tab = url.searchParams.get('tab') === 'changes' || url.searchParams.get('tab') === 'qa' ? url.searchParams.get('tab') as 'changes' | 'qa' : 'overview';
  const artifactReader = useArtifactReader();
  const messages = snapshot.messages.filter(message => message.projectId === project.id && message.workId === work.id);
  const [evidence, setEvidence] = useState<{status:'loading'|'ready'|'error';data:WorkEvidence|null;authoritative:boolean}>(()=>({status:'loading',authoritative:false,data:{work,messages:snapshot.messages.filter(message=>message.projectId===project.id&&message.workId===work.id),runs:snapshot.runs.filter(run=>run.workId===work.id),artifacts:snapshot.artifacts.filter(artifact=>artifact.workId===work.id)}}));
  const [evidenceRetry, setEvidenceRetry] = useState(0);
  const evidenceSignature = JSON.stringify([snapshot.member.id,project.id,work.id,work.revision,work.updatedAt,
    snapshot.runs.filter(item=>item.workId===work.id).map(({updatedAt:_updatedAt,...run})=>run),
    snapshot.artifacts.filter(item=>item.workId===work.id).map(item=>artifactKey(item))]);
  const evidenceSignatureRef=useRef(evidenceSignature);
  useLayoutEffect(()=>{evidenceSignatureRef.current=evidenceSignature;},[evidenceSignature]);
  const refreshEvidence=useCallback(async()=>{
    const before=evidenceSignatureRef.current;
    setEvidence(current=>({...current,status:'loading'}));
    try { await refresh(); if(evidenceSignatureRef.current===before)setEvidenceRetry(value=>value+1); }
    catch(cause) { setEvidence(current=>({...current,status:'error'})); throw cause; }
  },[refresh]);
  const overviewEditor = useWorkOverviewEditor(work, refreshEvidence);
  useEffect(()=>{
    let active=true;
    const controller=new AbortController();
    setEvidence(current=>({...current,status:'loading'}));
    void workbenchApi.workEvidence(work.id,controller.signal).then(result=>{
      if(!active)return;
      if(result.work.id!==work.id||result.work.projectId!==project.id||result.runs.some(item=>item.workId!==work.id)||result.artifacts.some(item=>item.workId!==work.id))throw new Error('Work evidence response does not match this Work');
      setEvidence({status:'ready',data:result,authoritative:true});
    }).catch(()=>{if(active)setEvidence(current=>({...current,status:'error'}));});
    return()=>{active=false;controller.abort();};
  },[evidenceSignature,evidenceRetry,work.id,project.id]);
  const canManageStaging=snapshot.member.role==='owner'||snapshot.member.role==='admin'&&['owner','admin'].includes(snapshot.projectRoles?.[project.id]??'');
  return <div data-testid="work-detail-layout" className="grid min-h-[calc(100dvh-8.5rem)] min-w-0 gap-5 xl:h-[calc(100dvh-8.5rem)] xl:min-h-0 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] xl:gap-6">
    <section className="max-h-[70dvh] min-w-0 overflow-y-auto border-border pr-1 xl:max-h-none xl:min-h-0 xl:pr-2"><header className="mb-3"><h1 className="text-xl font-semibold tracking-tight text-foreground">{work.title}</h1></header><nav className="mb-5 flex flex-wrap items-center gap-5 border-b border-border" aria-label="Work details">{(['overview', 'changes', 'qa'] as const).map(item => <a key={item} className={`border-b-2 px-1 py-3 text-sm capitalize no-underline ${tab === item ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground'}`} href={`${href('work-detail', project.id, work.id)}&tab=${item}`}>{item === 'qa' ? 'QA' : item}</a>)}<Button size="sm" variant="outline" className="mb-1 ml-auto" disabled={evidence.status==='loading'} onClick={()=>void refreshEvidence().catch(cause=>setError(errorMessage(cause)))}>Refresh evidence</Button></nav>
      {evidence.data&&(!evidence.authoritative||evidence.status!=='ready')&&<div role={evidence.status==='error'?'alert':'status'} className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><span>{!evidence.authoritative?(evidence.status==='loading'?'Loading Work evidence…':'Could not load this Work’s evidence.'):(evidence.status==='loading'?'Refreshing Work evidence; displayed records may be stale.':'Could not refresh Work evidence; displayed records may be stale.')}</span>{evidence.status==='error'&&<Button size="sm" variant="outline" onClick={()=>setEvidenceRetry(value=>value+1)}>Retry</Button>}</div>}
      {tab==='overview'&&<WorkProfileSelector work={work} project={project} snapshot={snapshot} refresh={refreshEvidence} setError={setError} evidenceFresh={evidence.status==='ready'&&evidence.authoritative} />}
      {evidence.data&&<WorkArtifacts artifactReader={artifactReader} overviewEditor={overviewEditor} sessionKey={snapshot.member.id} tab={tab} work={work} project={project} artifacts={evidence.data.artifacts} runs={evidence.data.runs} projectRuns={snapshot.runs.filter(item => item.projectId === project.id)} settings={snapshot.settings} providerConnections={snapshot.providerConnections ?? []} runtimeProviders={snapshot.runtimeProviders} canManageStaging={canManageStaging&&evidence.status==='ready'&&evidence.authoritative} refresh={refreshEvidence} setError={setError} evidenceFresh={evidence.status==='ready'&&evidence.authoritative} />}
    </section>
    <section className="flex h-[min(70dvh,42rem)] min-h-[28rem] min-w-0 flex-col overflow-hidden border-t border-border pt-5 xl:h-full xl:min-h-0 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0" aria-label={`${work.title} conversation`}><div className="mb-3 shrink-0"><h2 className="font-semibold">Conversation</h2></div><ConversationPage title="" messages={messages} project={project} snapshot={snapshot} work={work} refresh={refresh} setError={setError} /></section>
  </div>;
}

function WorkProfileSelector({ work, project, snapshot, refresh, setError, evidenceFresh }: { work: Work; project: Project; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void; evidenceFresh:boolean }) {
  const [busy, setBusy] = useState(false);
  const profiles = snapshot.settings.filter(item => item.kind === 'profile' && !item.projectId);
  const firstImplementation = snapshot.runs.filter(run => run.workId === work.id && run.kind === 'implementation')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (firstImplementation) {
    const frozenProfileId = firstImplementation.execution?.profileId ?? firstImplementation.execution?.profile?.id ?? work.profileId;
    const frozenProfileName = firstImplementation.execution?.profile?.name ?? profiles.find(profile => profile.id === frozenProfileId)?.name ?? (frozenProfileId ? 'Historical profile snapshot unavailable' : 'No profile');
    return <div className="mb-5 flex flex-wrap items-center gap-3"><Label>Agent profile</Label><span className="text-sm">{frozenProfileName}</span><span role="status" className="text-xs text-muted-foreground">Frozen after implementation starts.</span></div>;
  }
  return <div className="mb-5 flex flex-wrap items-center gap-3"><Label htmlFor={`work-profile-${work.id}`}>Agent profile</Label><NativeSelect id={`work-profile-${work.id}`} wrapperClassName="min-w-56" className="h-9 rounded-md border border-border bg-background px-3 text-sm" value={work.profileId} disabled={busy||!evidenceFresh} onChange={async event => { setBusy(true); setError(''); try { await workbenchApi.updateWork(work.id, { revision: work.revision, profileId: event.target.value }); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><NativeSelectOption value="">No profile</NativeSelectOption>{profiles.map(profile => <NativeSelectOption key={profile.id} value={profile.id}>{profile.name} · {profile.projectId ? 'Project' : 'Workspace'}</NativeSelectOption>)}</NativeSelect><span role="status" className="text-xs text-muted-foreground">A queued run snapshots the selected profile’s enabled skill content and provenance.</span></div>;
}

function useWorkOverviewEditor(work: Work, refresh: () => Promise<void>) {
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(''),[baseRevision,setBaseRevision]=useState(work.revision),[busy,setBusy]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState<{revision:number;overview:string}|null>(null);
  const active=useRef(true),saving=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const changed=editing&&(conflict||work.revision>baseRevision);
  const currentRevision=saved&&saved.revision>work.revision?saved.revision:work.revision;
  const currentOverview=saved&&saved.revision>work.revision?saved.overview:work.overview;
  const begin=()=>{setDraft(currentOverview);setBaseRevision(currentRevision);setConflict(false);setError('');setEditing(true);};
  const save=async()=>{if(saving.current||changed)return;saving.current=true;setBusy(true);setError('');try{const updated=await workbenchApi.updateWork(work.id,{revision:baseRevision,overview:draft});if(!active.current)return;setSaved({revision:updated.revision,overview:updated.overview});setEditing(false);void refresh().catch(()=>undefined);}catch(cause){if(!active.current)return;if(cause instanceof ApiError&&cause.status===409){setConflict(true);await refresh().catch(()=>undefined);}setError(errorMessage(cause));}finally{if(active.current){saving.current=false;setBusy(false);}}};
  return { editing, setEditing, draft, setDraft, baseRevision, setBaseRevision, busy, conflict, setConflict, error, setError, changed, currentRevision, currentOverview, begin, save };
}

function WorkOverviewEditor({work, editor, evidenceFresh}:{work:Work; editor:ReturnType<typeof useWorkOverviewEditor>;evidenceFresh:boolean}) {
  const { editing, setEditing, draft, setDraft, setBaseRevision, busy, setConflict, error, setError, changed, currentRevision, currentOverview, begin, save } = editor;
  return <section className="min-w-0"><div className="mb-2 flex items-center justify-between gap-3"><h2 className="font-semibold">Current overview</h2>{!editing&&<Button size="sm" variant="outline" disabled={!evidenceFresh} onClick={begin}>Edit</Button>}</div>{editing?<div className="space-y-3">{changed&&<div className="space-y-1"><p role="alert" className="text-sm text-destructive">Work changed elsewhere</p><p className="min-w-0 whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-muted-foreground">{work.overview||'No overview has been recorded yet.'}</p><Button size="sm" variant="outline" disabled={busy||!evidenceFresh} onClick={()=>{setBaseRevision(currentRevision);setDraft(currentOverview);setConflict(false);setError('');}}>Use latest</Button></div>}<label className="sr-only" htmlFor={`work-overview-${work.id}`}>Work overview</label><Textarea id={`work-overview-${work.id}`} maxLength={32000} value={draft} disabled={busy} onChange={event=>setDraft(event.target.value)} className="min-h-32 whitespace-pre-wrap wrap-anywhere" />{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex gap-2"><Button disabled={busy||changed||!evidenceFresh} onClick={()=>void save()}>{busy?'Saving…':'Save'}</Button><Button variant="outline" disabled={busy} onClick={()=>{setEditing(false);setError('');}}>Cancel</Button></div></div>:<div className="min-w-0 text-muted-foreground"><Markdown>{currentOverview||'No overview has been recorded yet.'}</Markdown></div>}</section>;
}

function latestCandidateDelivery(runs:SnapshotRun[],candidateRunId?:string) {
  if(!candidateRunId)return undefined;
  return runs.filter(run=>run.kind==='delivery'&&run.targetRunId===candidateRunId&&(!run.operation?.candidateRunId||run.operation.candidateRunId===candidateRunId))
    .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.generation-a.generation||b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
}

function deliveryPhaseLabel(phase?:string) {
  if(!phase)return undefined;
  const labels:Record<string,string>={queued:'Queued',published:'Published',pr_created:'Draft PR created',ready_intent:'Ready requested',merge_intent:'Merge in progress',merged:'Merged',build_discovery:'Build discovery',build_verified:'Build verified',deploy_intent:'Deployment in progress',deployed:'Deployed',rollback_intent:'Rollback in progress',rolled_back:'Rolled back'};
  return labels[phase]??phase.replaceAll('_',' ').replace(/\b\w/gu,letter=>letter.toUpperCase());
}

function DeliverySummary({run,receiptCount}:{run?:SnapshotRun;receiptCount:number}) {
  if(!run&&!receiptCount)return null;
  const phase=deliveryPhaseLabel(run?.operation?.phase);
  return <section aria-label="Current delivery status" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-sm">
    <span role={run?.status==='failed'?'alert':'status'} className={run?.status==='failed'?'text-destructive':'text-muted-foreground'}>{run?`Latest delivery · ${run.status}${phase?` · ${phase}`:''} · Updated ${new Date(run.updatedAt).toLocaleString()}`:'Delivery receipt recorded · run status unavailable'}</span>
    {run?.operation?.external?.pullRequestUrl&&<a className="min-w-0 truncate text-primary underline-offset-4 hover:underline" href={run.operation.external.pullRequestUrl} target="_blank" rel="noreferrer">Related pull request</a>}
  </section>;
}

function WorkArtifacts({ artifactReader, overviewEditor, sessionKey,tab, work, project, artifacts, runs, projectRuns, settings, providerConnections, runtimeProviders, canManageStaging, refresh, setError, evidenceFresh }: { artifactReader:ArtifactReader;overviewEditor:ReturnType<typeof useWorkOverviewEditor>;sessionKey:string;tab: 'overview' | 'changes' | 'qa'; work: Work; project: Project; artifacts: Artifact[]; runs: SnapshotRun[]; projectRuns: SnapshotRun[]; settings: Setting[]; providerConnections: NonNullable<Snapshot['providerConnections']>; runtimeProviders: Snapshot['runtimeProviders']; canManageStaging:boolean; refresh:()=>Promise<void>; setError:(value:string)=>void;evidenceFresh:boolean }) {
  const latestDiff = [...artifacts.filter(artifact => artifact.kind === 'diff')].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const selected = artifacts.filter(artifact => {
    if (artifact.kind !== (tab === 'changes' ? 'diff' : 'qa') || (tab === 'qa' && latestDiff && artifact.revision !== latestDiff.revision)) return false;
    return true;
  });
  const latest = [...selected].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latestKey=latest?artifactKey(latest):null;
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [artifactState, setArtifactState] = useState<'idle' | 'loading' | 'error' | 'mismatch'>('idle');
  const [diffRetryVersion,setDiffRetryVersion]=useState(0);
  const handledDiffRetry=useRef(0);
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());const [deliveryBusy,setDeliveryBusy]=useState(false);
  const [reviewEvidence,setReviewEvidence]=useState<{scopeKey:string;artifact:Artifact|null}|null>(null);const [mergeRequestId,setMergeRequestId]=useState(()=>crypto.randomUUID());
  useEffect(() => {
    if(!evidenceFresh)return;
    if (tab === 'overview' || tab === 'qa' || !latest) { if(!latest)setArtifact(null);setArtifactState('idle'); return; }
    let active = true;const consumer=new AbortController();const retry=diffRetryVersion>handledDiffRetry.current;handledDiffRetry.current=diffRetryVersion;setArtifactState('loading');
    void artifactReader.read(latest,consumer.signal,retry).then(result => {
      if (!active) return;
      if (result.id !== latest.id || result.projectId !== project.id || result.kind !== latest.kind || result.workId !== work.id || result.runId !== latest.runId || result.revision !== latest.revision) {
        setArtifact(null); setArtifactState('mismatch'); return;
      }
      setArtifact(result); setArtifactState('idle');
    }).catch(() => { if (active) setArtifactState('error'); });
    return () => { active = false;consumer.abort(); };
  }, [latestKey, latestDiff?.revision, work.id, project.id, tab,diffRetryVersion,evidenceFresh]);
  const relatedRuns = runs.filter(run => tab === 'changes' ? run.kind === 'implementation' : run.kind === 'review');
  const deliveries=[...artifacts.filter(item=>item.kind==='delivery')].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const deliveryRuns=[...runs.filter(run=>run.kind==='delivery')].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const priorPr=[...runs].reverse().find(run=>run.kind==='delivery'&&run.operation?.action==='create_draft_pr'&&run.status==='completed'&&run.operation.phase==='pr_created');
  const eligibleReviewEvidence=artifacts.filter(item=>item.kind==='qa').map(item=>({artifact:item,run:runs.find(run=>run.id===item.runId&&run.kind==='review'&&run.status==='completed')})).filter((item):item is {artifact:Artifact;run:SnapshotRun}=>item.run!==undefined).sort((a,b)=>a.artifact.id.localeCompare(b.artifact.id)||a.artifact.revision.localeCompare(b.artifact.revision)||a.artifact.runId.localeCompare(b.artifact.runId));
  const reviewEvidenceScopeKey=JSON.stringify([sessionKey,work.id,priorPr?{id:priorPr.id,candidateRunId:priorPr.operation?.candidateRunId,commitSha:priorPr.operation?.commitSha,candidateFingerprint:priorPr.operation?.candidateFingerprint,artifactRevision:priorPr.operation?.artifactRevision}:null,latestDiff?artifactKey(latestDiff):null,eligibleReviewEvidence.map(({artifact,run})=>[artifactKey(artifact),run.id,run.generation,run.reviewBinding?.candidateRunId,run.reviewBinding?.commitSha,run.reviewBinding?.candidateFingerprint,run.reviewBinding?.diffArtifactId,run.reviewBinding?.diffRevision])]);
  const scopedReviewEvidence=reviewEvidence?.scopeKey===reviewEvidenceScopeKey?reviewEvidence.artifact:null;
  const typedReview=isRecord(scopedReviewEvidence?.data)&&isRecord(scopedReviewEvidence.data.typedReview)?scopedReviewEvidence.data.typedReview:null;
  useEffect(()=>{if(tab!=='overview'||!priorPr){setReviewEvidence(null);return;}let active=true;setReviewEvidence({scopeKey:reviewEvidenceScopeKey,artifact:null});void Promise.all(eligibleReviewEvidence.map(({artifact:item})=>artifactReader.read(item).catch(()=>null))).then(values=>{if(active)setReviewEvidence({scopeKey:reviewEvidenceScopeKey,artifact:values.find(item=>item&&isRecord(item.data)&&isRecord(item.data.typedReview)&&item.data.typedReview.disposition==='approved'&&item.data.typedReview.candidateRunId===priorPr.operation?.candidateRunId&&item.data.typedReview.commitSha===priorPr.operation?.commitSha)??null});});return()=>{active=false;};},[tab,reviewEvidenceScopeKey]);
  if(tab==='qa')return <QaEvidencePanel artifactReader={artifactReader} sessionKey={sessionKey} work={work} latestDiff={latestDiff} artifacts={artifacts} runs={runs} evidenceFresh={evidenceFresh}/>;
  if (tab === 'overview') {
    const latestRun = [...runs].filter(run => run.kind === 'implementation').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    const execution = latestRun?.execution;
    const legacyRun = latestRun;
    const connectionId = execution?.connectionId ?? work.connectionId;
    const connectionSetting = settings.find(setting => setting.id === connectionId && setting.kind === 'provider');
    const connection = providerConnections.find(item => item.id === connectionId);
    const plannedProfile = !latestRun ? settings.find(setting => setting.kind === 'profile' && setting.id === work.profileId) : undefined;
    const model = latestRun?.model ?? execution?.model ?? (latestRun ? 'Not recorded' : String(plannedProfile?.data.model ?? 'gpt-6-luna'));
    const legacyClaims = [execution?.connectorId, legacyRun?.connectorId, legacyRun?.targetConnectorId].filter((value): value is string => Boolean(value));
    const legacyConnectorId = execution?.connectorId ?? legacyRun?.connectorId ?? legacyRun?.targetConnectorId;
    const connectorId = legacyConnectorId ?? connection?.connectorId ?? String(connectionSetting?.data.connectorId ?? 'Unavailable');
    const legacyRuntime = latestRun && !connectionId ? runtimeProviders.find(item => item.connectorId === legacyConnectorId && item.projectIds?.includes(project.id)) : undefined;
    const legacyIdentityRecorded = Boolean(legacyConnectorId);
    const legacyIdentityProven = Boolean(legacyIdentityRecorded && legacyRuntime);
    const capabilityBlocked = connection?.localWorktrees === false || legacyRuntime?.localWorktrees === false || legacyRuntime?.codexAppServer === false;
    const identityConflict = new Set(legacyClaims).size > 1 || Boolean(connection?.connectorId && legacyConnectorId && connection.connectorId !== legacyConnectorId) || Boolean(latestRun?.model && execution?.model && latestRun.model !== execution.model);
    const executionProfileLabel = execution?.profile?.name ?? (!latestRun ? plannedProfile?.name ?? 'No profile' : execution?.profileId || work.profileId ? 'Historical profile snapshot unavailable' : 'Not recorded');
    const providerValue = execution?.provider ?? connectionSetting?.data.provider ?? legacyRuntime?.provider;
    const providerLabel = providerValue === 'openai' ? 'OpenAI' : typeof providerValue === 'string' ? providerValue : 'Provider not recorded';
    const modelAvailable = connectionId ? Boolean(connection && connection.status === 'available' && connection.models.includes(model) && !capabilityBlocked && !identityConflict) : Boolean(legacyIdentityProven && legacyRuntime?.available && legacyRuntime.models.includes(model) && !capabilityBlocked && !identityConflict);
    const executionProblem = identityConflict ? 'Recorded Connector or model identities disagree. The frozen execution selection cannot be verified.' : capabilityBlocked ? (connection?.reason ?? 'The recorded Connector no longer reports required execution capabilities.') : connectionId ? !connection ? 'The selected provider connection is unavailable. No other connection will be selected.' : connection.status !== 'available' ? `The Work’s bound provider connection is ${connection.status}. No other connection will be selected.` : 'This model is not reported by the Work’s bound provider connection.' : legacyIdentityRecorded && !legacyRuntime ? 'The historical Connector ID is recorded, but no matching Connector is currently authorized for this project.' : legacyIdentityProven ? !legacyRuntime?.available ? 'The historical Connector identity is recorded, but that Connector is currently unavailable.' : `The historical Connector is recorded, but model ${model} is not currently reported.` : 'This Work has no recorded connection or historical Connector ID; its execution binding cannot be proven.';
    const connectionLabel = connectionSetting?.name ?? (connectionId ? 'Unavailable connection' : legacyIdentityRecorded ? 'Historical Connector (no connection record)' : 'No connection recorded');
    const legacyModelAvailable = !connectionId && legacyIdentityProven && Boolean(legacyRuntime?.available && legacyRuntime.models.includes(model) && !capabilityBlocked && !identityConflict);
    const overviewCandidate=latestDiff&&runs.find(run=>run.id===latestDiff.runId&&run.kind==='implementation'&&run.status==='completed');
    const latestDeliveryRun=latestCandidateDelivery(runs,overviewCandidate?.id);
    const stagingRuns=runs.filter(run=>run.kind==='delivery'&&(run.operation?.action==='deploy_staging'||run.operation?.action==='rollback_staging'));
    const mergedRuns=runs.filter(run=>run.kind==='delivery'&&run.operation?.action==='merge_pr'&&run.operation.phase==='merged');
    return <div className="space-y-6"><WorkOverviewEditor work={work} editor={overviewEditor} evidenceFresh={evidenceFresh}/><DeliverySummary run={latestDeliveryRun} receiptCount={deliveries.length}/><section className="space-y-2"><h2 className="font-semibold">Execution selection</h2><dl className="grid gap-2 rounded-lg border border-border p-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]"><dt className="text-muted-foreground">Provider</dt><dd>{providerLabel} · {connectionLabel} · {connection?.status ?? (connectionId ? 'status unavailable' : legacyIdentityRecorded ? legacyRuntime?.available ? 'historical affinity' : 'historical ID recorded · unavailable' : 'not recorded')}</dd><dt className="text-muted-foreground">Profile</dt><dd>{executionProfileLabel}</dd><dt className="text-muted-foreground">{latestRun?.handoffFromRunId ? 'Effective model' : 'Model'}</dt><dd>{model}</dd>{latestRun?.handoffFromRunId && typeof execution?.profile?.data.model === 'string' ? <><dt className="text-muted-foreground">Profile model</dt><dd>{execution.profile.data.model} · unchanged</dd></> : null}<dt className="text-muted-foreground">Execution status</dt><dd>{latestRun?.status ?? 'Not started'}</dd></dl>{latestRun?.error ? <p role="alert" className="text-sm text-destructive">{latestRun.error}</p> : null}{!modelAvailable ? <p role="alert" className="text-sm text-destructive">{executionProblem}</p> : null}{latestRun?.handoffFromRunId ? <p role="status" className="text-sm text-muted-foreground">Explicit model handoff; the saved Agent profile and earlier run remain unchanged.</p> : null}{legacyModelAvailable && latestRun?.threadId ? <p role="status" className="text-sm text-muted-foreground">This legacy Work continues on its recorded Connector and native thread. No connection record has been added and its binding cannot be changed here.</p> : null}{legacyModelAvailable && !latestRun?.threadId ? <p role="status" className="text-sm text-muted-foreground">The historical Connector identity and model are available. No native thread was recorded for this run.</p> : null}<details className="rounded-lg border border-border px-3 py-2 text-sm"><summary className="cursor-pointer font-medium">Execution diagnostics</summary><dl className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-[9rem_minmax(0,1fr)]"><dt className="text-muted-foreground">Run ID</dt><dd className="break-all">{latestRun?.id ?? 'Not recorded'}</dd><dt className="text-muted-foreground">Connector ID</dt><dd className="break-all">{connectorId}</dd>{latestRun?.threadId ? <><dt className="text-muted-foreground">Native thread ID</dt><dd className="break-all">{latestRun.threadId}</dd></> : null}{latestRun?.handoffFromRunId ? <><dt className="text-muted-foreground">Handoff from run ID</dt><dd className="break-all">{latestRun.handoffFromRunId}</dd></> : null}<dt className="text-muted-foreground">Provider connection ID</dt><dd className="break-all">{connectionId ?? 'Not recorded'}</dd><dt className="text-muted-foreground">Profile ID</dt><dd className="break-all">{(execution?.profileId ?? work.profileId) || 'Not recorded'}</dd></dl></details></section>{(stagingRuns.length>0||mergedRuns.length>0)&&<StagingOverview work={work} project={project} runs={stagingRuns} allRuns={projectRuns} settings={settings} runtimeProviders={runtimeProviders} canManage={canManageStaging} refresh={refresh} setError={setError}/ >}{(deliveries.length>0||priorPr&&typedReview)&&<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Delivery history and details · {deliveryRuns.length} runs · {deliveries.length} receipts</summary><div className="mt-3 space-y-3">{deliveries.map(item=><FullArtifactCard artifactReader={artifactReader} key={item.id} artifact={item}/>)}{priorPr&&typedReview&&<section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><div><strong className="text-sm">Merge reviewed pull request</strong><p className="text-xs text-muted-foreground">Approved review {String(typedReview.reviewerRunId)} · candidate {priorPr.operation?.commitSha}</p></div><Button disabled={deliveryBusy||!evidenceFresh} onClick={async()=>{setDeliveryBusy(true);setError('');try{await workbenchApi.requestMergePr(work.id,{priorDeliveryRunId:priorPr.id,reviewRunId:String(typedReview.reviewerRunId),requestId:mergeRequestId});setMergeRequestId(crypto.randomUUID());await refresh();}catch(error){setError(errorMessage(error));}finally{setDeliveryBusy(false);}}}>{deliveryBusy?'Queueing…':'Queue merge'}</Button></section>}</div></details>}<section><h2 className="mb-2 font-semibold">Related</h2>{work.sources.length ? <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{work.sources.map(source => <li key={source}>{source}</li>)}</ul> : <p className="text-sm text-muted-foreground">No related sources.</p>}</section></div>;
  }
  const candidate=latestDiff&&runs.find(run=>run.id===latestDiff.runId&&run.kind==='implementation'&&run.status==='completed');
  const existing=candidate&&runs.find(run=>run.kind==='delivery'&&run.targetRunId===candidate.id);
  const retryable=existing&&['failed','interrupted','cancelled'].includes(existing.status);
  const deliveryLabel=retryable?'Retry Draft PR':existing?.status==='queued'?'Queued':existing?.status==='running'?'In progress':existing?.status==='paused'?'Paused':existing?.status==='completed'&&existing.operation?.phase==='pr_created'?'Draft PR created':existing?'Delivery status unavailable':'Create Draft PR';
  return <section className="space-y-4"><header><h2 className="font-semibold">Changes</h2><p className="mt-1 text-sm text-muted-foreground">Recorded file changes from this Work.</p></header>
    {artifactState==='loading'&&selected.length>0&&<p role="status" className="rounded-lg border border-border p-4 text-sm text-muted-foreground">Loading latest evidence…</p>}
    {(artifactState==='error'||artifactState==='mismatch')&&selected.length>0&&<div role="alert" className="space-y-2 rounded-lg border border-destructive/30 p-4 text-sm text-destructive"><p>{artifactState==='mismatch'?'The latest evidence did not match this Work.':'Could not load the latest evidence.'}</p><Button variant="outline" disabled={!evidenceFresh} onClick={()=>{setArtifactState('loading');setDiffRetryVersion(value=>value+1);}}>Retry</Button></div>}
    {artifact&&artifactKey(artifact)===latestKey&&<ArtifactCard key={`${sessionKey}:${artifact.id}:${artifact.revision}`} sessionKey={sessionKey} artifact={artifact}/>}
    {candidate&&<DeliverySummary run={latestCandidateDelivery(runs,candidate.id)} receiptCount={deliveries.length}/>}
    {(deliveries.length>0||candidate)&&<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Delivery history and details · {deliveryRuns.length} runs · {deliveries.length} receipts</summary><div className="mt-3 space-y-3">{latestDiff&&candidate&&<section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><div><strong className="text-sm">Draft pull request</strong><p className="text-xs text-muted-foreground">{existing?`Delivery ${existing.status}${existing.operation?.phase?` · ${existing.operation.phase}`:''}`:project.repositoryUrl?'Create a reviewable draft from this exact candidate.':'Connect a repository to enable delivery.'}</p></div><Button disabled={deliveryBusy||!evidenceFresh||(!retryable&&!!existing)||!project.repositoryUrl} onClick={async()=>{setDeliveryBusy(true);setError('');try{await workbenchApi.requestDraftPr(work.id,{candidateRunId:candidate.id,candidateRevision:latestDiff.revision,action:'create_draft_pr',requestId});setRequestId(crypto.randomUUID());await refresh();}catch(error){setError(errorMessage(error));}finally{setDeliveryBusy(false);}}}>{deliveryBusy?'Queueing…':deliveryLabel}</Button></section>}{deliveries.map(item=><FullArtifactCard artifactReader={artifactReader} key={item.id} artifact={item}/>)}</div></details>}
    {!selected.length&&!relatedRuns.length&&deliveries.length===0&&!evidenceFresh?<p role="status" className="rounded-lg border border-border border-dashed p-6 text-sm text-muted-foreground">Checking scoped Work evidence; no empty-state conclusion is available yet.</p>:!selected.length&&!relatedRuns.length&&deliveries.length===0?<div className="rounded-lg border border-border border-dashed p-6 text-sm text-muted-foreground">No change evidence has been recorded yet.</div>:<>
      {relatedRuns.length>0&&<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Execution history · {relatedRuns.length} runs</summary><div className="mt-3 space-y-3">{relatedRuns.map(run=><div key={run.id} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><strong className="text-sm">{run.kind==='review'?'Review run':'Implementation run'}</strong><Badge variant="outline" className="capitalize">{run.status}</Badge></div>{run.error&&<p className="mt-2 text-sm text-destructive">{run.error}</p>}<p className="mt-2 text-xs text-muted-foreground">Updated {new Date(run.updatedAt).toLocaleString()}</p></div>)}</div></details>}
    </>}
  </section>;
}

function StagingOverview({work,project,runs,allRuns,settings,runtimeProviders,canManage,refresh,setError}:{work:Work;project:Project;runs:SnapshotRun[];allRuns:SnapshotRun[];settings:Setting[];runtimeProviders:Snapshot['runtimeProviders'];canManage:boolean;refresh:()=>Promise<void>;setError:(value:string)=>void}){
  const [busyRun,setBusyRun]=useState('');
  const [selectedTarget,setSelectedTarget]=useState('');
  const [deployRequestId,setDeployRequestId]=useState(()=>crypto.randomUUID());
  const recoveryRequests=useRef(new Map<string,string>());
  const policies=settings.filter(item=>item.kind==='connection'&&item.projectId===work.projectId&&item.data.provider==='github'&&item.data.purpose==='delivery'&&item.data.url===project.repositoryUrl&&item.data.enabled!==false&&item.data.allowStagingDeploy===true);
  const resolveLabel=(run:SnapshotRun)=>{
    const op=run.operation,phase=op?.stagingReceipt?.phase??op?.phase;
    if(op?.stagingRetired)return 'Stopped · Target released';
    if(run.status==='paused')return 'Paused';
    if(run.status==='interrupted')return 'Interrupted';
    if(run.status==='cancelled')return 'Canceled';
    if(op?.action==='deploy_staging'&&op.phase==='build_discovery'){
      const labels={discovering:'Finding build',unavailable:'Build unavailable',running:'Build in progress',failed:'Build failed',receipt_missing:'Build receipt missing',receipt_expired:'Build receipt expired',provenance_failed:'Build could not be verified',verified:'Build verified'} as const;
      if(run.status==='failed'&&(op.buildStatus==='discovering'||op.buildStatus==='running'))return 'Build failed';
      return op.buildStatus?labels[op.buildStatus]:'Finding build';
    }
    if(run.status==='queued'||run.status==='running')return run.status==='queued'?'Queued':'In progress';
    if(phase==='unknown'||phase==='deploy_unknown'||phase==='deploy_intent'||phase==='rollback_intent')return 'Outcome unknown';
    if(phase==='health_passed')return 'Health check passed';
    if(phase==='rolled_back')return 'Rolled back';
    if(phase==='target_offline')return 'Target offline';
    if(phase==='deployed')return 'Awaiting health check';
    if(run.status==='failed')return 'Failed';
    if(run.status==='completed')return 'Receipt unavailable';
    return run.status;
  };
  const unresolvedFor=(targetId:string,exceptRunId?:string)=>allRuns.some(run=>run.id!==exceptRunId&&!run.operation?.stagingRetired&&!allRuns.some(next=>next.operation?.recoveryFromRunId===run.id)&&run.operation?.targetId===targetId&&['deploy_staging','rollback_staging'].includes(run.operation.action)&&!['health_passed','rolled_back'].includes(run.operation.phase));
  const latestByTarget=(targetId:string)=>[...allRuns].filter(run=>!run.operation?.stagingRetired&&run.operation?.targetId===targetId&&['deploy_staging','rollback_staging'].includes(run.operation.action)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).at(-1);
  const retryFor=(targetId:string,sourceMergeRunId:string|undefined):SnapshotRun|undefined=>sourceMergeRunId?allRuns.find(run=>run.projectId===work.projectId&&run.workId===work.id&&run.operation?.action==='deploy_staging'&&run.operation.targetId===targetId&&run.operation.sourceMergeRunId===sourceMergeRunId&&run.operation.phase==='build_discovery'&&run.operation.effectIntentGeneration===undefined&&!run.operation.stagingEffectStage&&!run.operation.stagingReceipt&&!run.operation.stagingRetired&&run.status==='failed'):undefined;
  const rollbackAvailable=(run:SnapshotRun)=>{
    const op=run.operation,receipt=op?.stagingReceipt;
    if(!canManage||run.status!=='completed'||receipt?.phase!=='health_passed'||!receipt.previousDeploymentId||!receipt.previousImageDigest||!op?.targetId||latestByTarget(op.targetId)?.id!==run.id||unresolvedFor(op.targetId))return false;
    const policy=policies.find(item=>Array.isArray(item.data.stagingTargets)&&item.data.stagingTargets.includes(op.targetId!));
    if(!policy)return false;
    const capable=runtimeProviders.filter(provider=>provider.available&&provider.projectIds?.includes(work.projectId)&&provider.deploymentTargets?.includes(op.targetId!)&&provider.deliveryActions?.includes('rollback_staging'));
    return capable.length===1;
  };
  const ordered=[...runs].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  const merged=allRuns.filter(run=>run.workId===work.id&&run.projectId===work.projectId&&run.kind==='delivery'&&run.status==='completed'&&run.operation?.action==='merge_pr'&&run.operation.phase==='merged'&&Boolean(run.operation.external?.mergeSha)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const mergedSha=merged?.operation?.external?.mergeSha;
  const retiredFor=(targetId:string,sourceMergeRunId:string|undefined)=>Boolean(sourceMergeRunId&&allRuns.some(run=>run.projectId===work.projectId&&run.workId===work.id&&run.operation?.action==='deploy_staging'&&run.operation.targetId===targetId&&run.operation.sourceMergeRunId===sourceMergeRunId&&run.operation.stagingRetired));
  const targetSet=new Set<string>();
  for(const policy of policies)for(const target of Array.isArray(policy.data.stagingTargets)?policy.data.stagingTargets:[])if(typeof target==='string'&&target)targetSet.add(target);
  const targets=[...targetSet].sort().map(id=>{
    const capable=runtimeProviders.filter(provider=>provider.available&&provider.projectIds?.includes(work.projectId)&&provider.deploymentTargets?.includes(id)&&provider.deliveryActions?.includes('deploy_staging'));
    const retry=retryFor(id,merged?.id);
    return {id,capable:capable.length===1,reserved:unresolvedFor(id,retry?.id)};
  });
  const selected=targets.find(target=>target.id===selectedTarget);
  const sameSourceRetired=Boolean(selected&&merged&&retiredFor(selected.id,merged.id));
  const retryRun=selected&&merged?retryFor(selected.id,merged.id):undefined;
  const retryStatus=retryRun?.status==='failed';
  const retryable=Boolean(merged&&selected&&retryRun?.operation?.sourceMergeRunId===merged.id&&retryRun.operation?.phase==='build_discovery'&&retryRun.operation.effectIntentGeneration===undefined&&!retryRun.operation.stagingEffectStage&&!retryRun.operation.stagingReceipt&&!retryRun.operation.stagingRetired&&retryStatus);
  const continueVerifiedBuild=retryable&&retryRun?.operation?.buildStatus==='verified';
  const canQueue=Boolean(canManage&&merged&&mergedSha&&selected?.capable&&!selected.reserved&&!sameSourceRetired&&!busyRun);
  const requestDeployment=async()=>{
    if(!canQueue||!merged||!selected)return;
    setBusyRun('deploy');setError('');
    try{await workbenchApi.requestStagingDeployment(work.id,{sourceMergeRunId:merged.id,targetId:selected.id,requestId:deployRequestId});setDeployRequestId(crypto.randomUUID());await refresh();}
    catch(cause){setError(errorMessage(cause));}
    finally{setBusyRun('');}
  };
  return <section className="space-y-3" aria-label="Staging delivery"><header><h2 className="font-semibold">Staging</h2><p className="mt-1 text-sm text-muted-foreground">Deployment status for this Work.</p></header>
    {merged&&<div className="rounded-lg border border-border border-dashed p-4 text-sm"><p className="font-medium">Merged source · {mergedSha}</p><p className="mt-1 text-muted-foreground">A trusted build is required before deployment.</p>
      {canManage&&<div className="mt-3 grid gap-2 sm:max-w-lg"><label htmlFor={`staging-target-${work.id}`} className="font-medium">Staging target</label><NativeSelect id={`staging-target-${work.id}`} className="h-9 rounded-md border border-border bg-background px-3 text-sm" value={selectedTarget} onChange={event=>setSelectedTarget(event.target.value)}><NativeSelectOption value="">Choose a target</NativeSelectOption>{targets.map(target=><NativeSelectOption key={target.id} value={target.id} disabled={!target.capable||target.reserved}>{target.id}{target.reserved?' · in use':!target.capable?' · unavailable':''}</NativeSelectOption>)}</NativeSelect>
        {targets.length===0&&<p role="status" className="text-sm text-muted-foreground">No staging targets available.</p>}
        {selected?.reserved&&<p role="status" className="text-sm text-amber-800">This target is in use by another delivery.</p>}
        {sameSourceRetired&&<p role="status" className="text-sm text-muted-foreground">This merged source was already released. Merge a new source before trying again.</p>}
        {!selected?.capable&&selectedTarget&&<p role="status" className="text-sm text-muted-foreground">This target is currently unavailable.</p>}
        <Button className="w-fit" disabled={!canQueue} onClick={()=>void requestDeployment()}>{busyRun==='deploy'?'Finding build…':retryable?continueVerifiedBuild?'Continue deployment':'Retry build':'Deploy to staging'}</Button>
        {retryable&&<p className="text-xs text-muted-foreground">{continueVerifiedBuild?'Continue the saved build for this same merged source.':'Retry the saved build check for this same merged source.'}</p>}
      </div>}
      {!canManage&&<p className="mt-3 text-sm text-muted-foreground">An authorized administrator can deploy this merged source to staging.</p>}
    </div>}
    {ordered.map(run=>{const op=run.operation!,receipt=op.stagingReceipt,phase=resolveLabel(run),latest=latestByTarget(op.targetId??'')?.id===run.id;const busy=busyRun===run.id;const recoverable=canManage&&canRecoverStagingRun(run)&&latest&&Boolean(op.sourceMergeRunId)&&targets.some(target=>target.id===op.targetId&&target.capable)&&!allRuns.some(next=>next.operation?.recoveryFromRunId===run.id);const releasable=canManage&&op.action==='deploy_staging'&&op.phase==='build_discovery'&&['failed','cancelled','interrupted'].includes(run.status)&&Boolean(run.stoppedAt)&&op.effectIntentGeneration===undefined&&!op.stagingEffectStage&&!op.stagingReceipt&&!op.stagingRetired;return <article key={run.id} className="rounded-lg border border-border p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-medium">{op.action==='rollback_staging'?'Staging rollback':'Staging deployment'}</h3><p className="mt-1 text-sm text-muted-foreground">{op.targetId??'Target unavailable'} · {phase}</p></div><div className="flex items-center gap-2"><Badge variant={phase==='Health check passed'||phase==='Rolled back'?'secondary':phase==='Failed'||phase==='Build failed'||phase==='Target offline'?'destructive':'outline'}>{phase}</Badge>{recoverable&&<Button variant="outline" size="sm" disabled={Boolean(busyRun)} onClick={async()=>{const key=`${run.id}:${run.generation}`;let requestId=recoveryRequests.current.get(key);if(!requestId){requestId=crypto.randomUUID();recoveryRequests.current.set(key,requestId);}setBusyRun(run.id);setError('');try{await workbenchApi.recoverStagingDeployment(work.id,{oldRunId:run.id,generation:run.generation,targetId:op.targetId!,requestId});await refresh();}catch(cause){setError(errorMessage(cause));}finally{setBusyRun('');}}}>{busy?'Queueing…':'Recover deployment'}</Button>}{releasable&&<Button variant="outline" size="sm" disabled={busy} onClick={async()=>{setBusyRun(run.id);setError('');try{await workbenchApi.retireStagingDeployment(run.id,run.generation);await refresh();}catch(cause){setError(errorMessage(cause));}finally{setBusyRun('');}}}>{busy?'Releasing…':'Release target'}</Button>}</div></div>
      {op.action==='deploy_staging'&&op.phase==='build_discovery'&&['failed','cancelled','interrupted'].includes(run.status)&&!run.operation?.stagingRetired&&!run.stoppedAt&&<p role="status" className="mt-2 text-sm text-amber-800">Waiting for the Connector to confirm it has stopped. The target remains in use.</p>}
      {op.action==='deploy_staging'&&!op.stagingRetired&&(op.phase==='build_discovery'||op.buildReceipt)&&<div className="mt-2 space-y-2 text-sm">{op.phase==='build_discovery'?<p className="text-muted-foreground">Build verification does not mean the application is deployed.</p>:<p className="text-muted-foreground">Build verified for this source.</p>}{op.buildMessage&&op.phase==='build_discovery'&&<p role="status" className="text-muted-foreground">{op.buildMessage}</p>}{op.buildReceipt&&<details><summary className="cursor-pointer text-xs text-muted-foreground">Build details</summary><dl className="mt-2 grid gap-1 text-xs sm:grid-cols-[9rem_minmax(0,1fr)]"><dt className="text-muted-foreground">Source commit</dt><dd className="break-all font-mono">{op.buildReceipt.sourceSha}</dd><dt className="text-muted-foreground">Image digest</dt><dd className="break-all font-mono">{op.buildReceipt.imageDigest}</dd><dt className="text-muted-foreground">Build archive digest</dt><dd className="break-all font-mono">{op.buildReceipt.archiveDigest}</dd><dt className="text-muted-foreground">Build run</dt><dd><a className="underline" href={op.buildReceipt.runUrl} target="_blank" rel="noreferrer">Open build record</a></dd></dl></details>}</div>}
      {phase==='Outcome unknown'&&<p role="status" className="mt-2 text-sm text-amber-800">The result is unknown. This target remains reserved until its status is confirmed.</p>}
      {phase==='Health check passed'&&<p className="mt-2 text-sm text-muted-foreground">The staging health check passed. This does not confirm the user flow.</p>}
      {phase==='Target offline'&&<p className="mt-2 text-sm text-muted-foreground">The target is offline; its previous state has not been verified.</p>}
      {op.phase!=='build_discovery'&&<details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Delivery details</summary><dl className="mt-2 grid gap-1 text-xs sm:grid-cols-[9rem_minmax(0,1fr)]"><dt className="text-muted-foreground">Commit</dt><dd className="break-all font-mono">{op.commitSha??'Not recorded'}</dd><dt className="text-muted-foreground">Image digest</dt><dd className="break-all font-mono">{op.imageDigest??'Not recorded'}</dd><dt className="text-muted-foreground">Deployment</dt><dd className="break-all">{receipt?.deploymentId??'Not confirmed'}</dd>{receipt?.checkedAt&&<><dt className="text-muted-foreground">Last checked</dt><dd>{new Date(receipt.checkedAt).toLocaleString()}</dd></>}{receipt?.previousDeploymentId&&<><dt className="text-muted-foreground">Previous deployment</dt><dd className="break-all">{receipt.previousDeploymentId}</dd></>}{receipt?.previousImageDigest&&<><dt className="text-muted-foreground">Previous digest</dt><dd className="break-all font-mono">{receipt.previousImageDigest}</dd></>}</dl></details>}
      {op.action==='deploy_staging'&&phase==='Health check passed'&&latest&&canManage&&<div className="mt-3"><Button variant="outline" size="sm" disabled={!rollbackAvailable(run)||busy} onClick={async()=>{setBusyRun(run.id);setError('');try{await workbenchApi.requestStagingRollback(work.id,{deploymentRunId:run.id,targetId:op.targetId!,requestId:crypto.randomUUID()});await refresh();}catch(cause){setError(errorMessage(cause));}finally{setBusyRun('');}}}>{busy?'Queueing…':'Roll back to previous verified version'}</Button>{!rollbackAvailable(run)&&<p className="mt-2 text-xs text-muted-foreground">Rollback is unavailable until the saved deployment details are confirmed.</p>}</div>}
      {op.action==='deploy_staging'&&phase==='Health check passed'&&latest&&!canManage&&<p className="mt-3 text-xs text-muted-foreground">An authorized administrator can request a rollback when the previous verified version is available.</p>}
    </article>;})}
  </section>;
}
function QaEvidencePanel({artifactReader,sessionKey,work,latestDiff,artifacts,runs,evidenceFresh}:{artifactReader:ArtifactReader;sessionKey:string;work:Work;latestDiff:Artifact|undefined;artifacts:Artifact[];runs:SnapshotRun[];evidenceFresh:boolean}){
  const candidate=latestDiff&&runs.find(run=>run.id===latestDiff.runId&&run.kind==='implementation');
  const candidateReviews=runs.filter(run=>run.kind==='review'&&run.workId===work.id&&run.reviewBinding?.candidateRunId===candidate?.id&&run.reviewBinding?.diffRevision===latestDiff?.revision);
  const latestBoundReview=[...candidateReviews].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const latestReview=latestBoundReview??[...runs].filter(run=>run.kind==='review'&&run.workId===work.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const metadata=artifacts.filter(item=>item.kind==='qa'&&item.workId===work.id&&(item.runId===candidate?.id||item.runId===latestReview?.id));
  const requestKey=JSON.stringify([latestDiff?artifactKey(latestDiff):null,...metadata.map(artifactKey).sort()]);
  const [loaded,setLoaded]=useState<Record<string,Artifact>>({});
  const [failed,setFailed]=useState<string[]>([]);
  const [loading,setLoading]=useState(false);
  const [retryMessage,setRetryMessage]=useState('');
  const evidenceGeneration=useRef(0);
  const retryPending=useRef(false);
  const evidenceController=useRef<AbortController|null>(null);
  const expectedArtifacts=new Map<string,Artifact>([[latestDiff?.id??'',latestDiff!],...metadata.map(item=>[item.id,item] as [string,Artifact])]);
  // Snapshot QA bodies are omitted; fixed IDs and owning runs establish the retry role.
  const evidenceRoles=new Map(metadata.map(item=>{
    const data=isRecord(item.data)?item.data:{};
    const role=item.id.startsWith(`artifact:${item.runId}:required-qa:`)||data.localQaContract==='project-local-qa/v2'?'required'
      :item.id.startsWith(`artifact:${item.runId}:typed-review:`)?'review'
      :item.id.startsWith(`artifact:${item.runId}:qa:`)||Array.isArray(data.checks)&&!isRecord(data.typedReview)?'command'
        :runs.find(run=>run.id===item.runId)?.kind==='review'?'review':item.runId===candidate?.id?'command':'unknown';
    return [item.id,role] as const;
  }));
  const snapshotSha=isRecord(latestDiff?.data)?latestDiff.data.candidateRevision:undefined;
  const trustedSha=typeof snapshotSha==='string'?snapshotSha:latestBoundReview?.reviewBinding?.commitSha;
  const loadEvidence=async(ids:string[],generation:number,replace:boolean,signal:AbortSignal,force=false)=>{
    const results=await Promise.all(ids.map(async id=>{try{const reference=expectedArtifacts.get(id);return reference?await artifactReader.read(reference,signal,force):null;}catch{return null;}}));
    if(generation!==evidenceGeneration.current)return;
    const valid:Record<string,Artifact>={},missing:string[]=[];
    results.forEach((result,index)=>{const id=ids[index]!,reference=expectedArtifacts.get(id);if(!result||!reference||result.id!==id||result.workId!==work.id||result.projectId!==work.projectId||result.runId!==reference.runId||result.kind!==reference.kind||result.revision!==reference.revision)missing.push(id);else valid[id]=result;});
    setLoaded(current=>replace?valid:{...current,...valid});
    setFailed(current=>replace?missing:[...new Set([...current,...missing])]);
    setLoading(false);retryPending.current=false;
    if(evidenceController.current?.signal===signal)evidenceController.current=null;
    if(!missing.length)setRetryMessage('');
  };
  useEffect(()=>{
    const generation=++evidenceGeneration.current;
    retryPending.current=false;setRetryMessage('');
    if(!latestDiff){setLoaded({});setFailed([]);setLoading(false);return()=>{++evidenceGeneration.current;};}
    const controller=new AbortController();evidenceController.current=controller;
    const ids=[latestDiff.id,...metadata.map(item=>item.id)];
    setLoaded({});setFailed([]);setLoading(true);
    void loadEvidence(ids,generation,true,controller.signal);
    return()=>{evidenceController.current?.abort();evidenceController.current=null;++evidenceGeneration.current;};
  },[requestKey,work.id,work.projectId]);

  const retryFailedEvidence=async()=>{
    if(!evidenceFresh||loading||retryPending.current||!retryable.length)return;
    if(!canAutoPoll()){setRetryMessage('Please wait for the server cooldown before retrying.');return;}
    retryPending.current=true;setLoading(true);setRetryMessage('');
    const controller=new AbortController();evidenceController.current=controller;
    await loadEvidence(retryable,evidenceGeneration.current,false,controller.signal,true);
  };

  const diff=latestDiff?loaded[latestDiff.id]:undefined;
  const diffData=isRecord(diff?.data)?diff.data:{};
  const commitSha=latestDiff&&failed.includes(latestDiff.id)?typeof trustedSha==='string'&&/^[a-f0-9]{40,64}$/u.test(trustedSha)?trustedSha:undefined:typeof diffData.candidateRevision==='string'?diffData.candidateRevision:undefined;
  const candidateQa=metadata.filter(item=>item.runId===candidate?.id).map(item=>loaded[item.id]).filter((item):item is Artifact=>Boolean(item));
  const currentCandidateQa=candidateQa.filter(item=>item.revision===latestDiff?.revision).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const localQa=currentCandidateQa.find(item=>isRecord(item.data)&&item.data.localQaContract==='project-local-qa/v2')??candidateQa.find(item=>isRecord(item.data)&&item.data.localQaContract==='project-local-qa/v2');
  const localData=isRecord(localQa?.data)?localQa.data:{};
  const localChecks=Array.isArray(localData.checks)?localData.checks.filter(isRecord):[];
  const localFingerprint=typeof localData.candidateFingerprint==='string'?localData.candidateFingerprint:undefined;
  const policy=candidate?.qaPolicySnapshot;
  const canonicalPolicy=qaPolicySnapshot.safeParse(policy);
  const currentCheckEvidence=(item:Artifact|undefined,required:boolean)=>{
    const data=isRecord(item?.data)?item.data:{};
    const checks=Array.isArray(data.checks)?data.checks.filter(isRecord):[];
    const fingerprint=data.candidateFingerprint;
    return Boolean(item&&latestDiff&&candidate&&item.runId===candidate.id&&item.revision===latestDiff.revision&&(required?data.localQaContract==='project-local-qa/v2':data.localQaContract!=='project-local-qa/v2'&&!isRecord(data.typedReview))&&data.verification==='current'&&data.stale===false&&typeof fingerprint==='string'&&/^[a-f0-9]{64}$/u.test(fingerprint)&&checks.length>0&&checks.every(check=>check.testedRevision===fingerprint));
  };
  const localCurrent=currentCheckEvidence(localQa,true);
  const localFailed=localChecks.filter(check=>check.exitCode!==0).length;
  let requiredStatus:'Not configured'|'Pending'|'Missing'|'Stale'|'Current'|'Unknown'='Unknown';
  if(!policy)requiredStatus='Not configured';
  else if(!localQa&&candidate&&candidate.status!=='completed')requiredStatus='Pending';
  else if(!localQa&&failed.some(id=>metadata.some(item=>item.id===id&&item.runId===candidate?.id)))requiredStatus='Unknown';
  else if(!localQa)requiredStatus='Missing';
  else if(failed.includes(localQa.id))requiredStatus='Unknown';
  else if(localData.stale===true||localData.verification==='stale'||localQa.revision!==latestDiff?.revision)requiredStatus='Stale';
  else if(localCurrent)requiredStatus='Current';
  else requiredStatus='Unknown';
  const localRequirementMet=Boolean(localCurrent&&canonicalPolicy.success&&localFingerprint&&hasRequiredLocalQa(localData,localFingerprint,canonicalPolicy.data));
  const requiredDetail=!policy?'No required-check policy was recorded.':requiredStatus==='Pending'?'Required checks have not finished.':requiredStatus==='Unknown'?'Required checks could not be loaded or verified.':requiredStatus==='Missing'?'Required checks are missing for this candidate.':requiredStatus==='Stale'?'Recorded required checks do not match this candidate.':localRequirementMet?`${localChecks.length} required checks recorded · requirements met`:localFailed?`${localChecks.length} required checks recorded · ${localFailed} failed or unknown`:`${localChecks.length} required checks recorded · required checks are incomplete`;

  const commandQa=currentCandidateQa.find(item=>{const data=isRecord(item.data)?item.data:{};return Array.isArray(data.checks)&&data.localQaContract!=='project-local-qa/v2'&&!isRecord(data.typedReview);})
    ??candidateQa.find(item=>{const data=isRecord(item.data)?item.data:{};return Array.isArray(data.checks)&&data.localQaContract!=='project-local-qa/v2'&&!isRecord(data.typedReview);});
  const commandData=isRecord(commandQa?.data)?commandQa.data:{};
  const commandChecks=Array.isArray(commandData.checks)?commandData.checks.filter(isRecord):[];
  const commandCurrent=currentCheckEvidence(commandQa,false);
  let commandStatus:'Pending'|'Missing'|'Stale'|'Current'|'Unknown'='Unknown';
  if(!commandQa&&candidate&&candidate.status!=='completed')commandStatus='Pending';
  else if(!commandQa&&failed.some(id=>metadata.some(item=>item.id===id&&item.runId===candidate?.id)))commandStatus='Unknown';
  else if(!commandQa)commandStatus='Missing';
  else if(failed.includes(commandQa.id))commandStatus='Unknown';
  else if(commandData.stale===true||commandData.verification==='stale'||commandQa.revision!==latestDiff?.revision)commandStatus='Stale';
  else if(commandCurrent)commandStatus='Current';
  else commandStatus='Unknown';
  const commandDetail=commandQa?`${checksDetail(commandChecks)}${commandCurrent?' · bound to this candidate':''}`:commandStatus==='Pending'?'Command checks have not finished.':commandStatus==='Unknown'?'Command-check evidence could not be loaded or verified.':'No command-check evidence is recorded.';
  const commandPassed=commandChecks.filter(check=>check.exitCode===0).length;
  const commandFailed=commandChecks.filter(check=>check.exitCode!==0).length;

  const reviewRun=latestReview;
  const reviewArtifact=metadata.filter(item=>item.runId===reviewRun?.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
    .map(item=>loaded[item.id]).find(item=>isRecord(item?.data)&&isRecord(item.data.typedReview));
  const reviewData=isRecord(reviewArtifact?.data)&&isRecord(reviewArtifact.data.typedReview)?reviewArtifact.data.typedReview:{};
  const binding=reviewRun?.reviewBinding;
  const matchesReviewEvidence=(item:Artifact|undefined)=>{
    const data=isRecord(item?.data)&&isRecord(item.data.typedReview)?item.data.typedReview:{};
    return Boolean(candidate&&latestDiff&&commitSha&&reviewRun?.status==='completed'&&binding&&binding.candidateRunId===candidate.id&&binding.diffArtifactId===latestDiff.id&&binding.diffRevision===latestDiff.revision&&binding.commitSha===commitSha&&/^[a-f0-9]{64}$/u.test(binding.candidateFingerprint)&&(!localFingerprint||binding.candidateFingerprint===localFingerprint)&&item?.revision===latestDiff.revision&&data.candidateRunId===candidate.id&&data.diffArtifactId===binding.diffArtifactId&&data.diffRevision===latestDiff.revision&&data.commitSha===commitSha&&data.candidateFingerprint===binding.candidateFingerprint&&data.reviewerRunId===reviewRun.id&&data.disposition&&['approved','changes_requested','insufficient_evidence'].includes(String(data.disposition)));
  };
  const reviewMatches=matchesReviewEvidence(reviewArtifact);
  const retrySemanticallyValid=(id:string,item:Artifact)=>{
    if(id===latestDiff?.id){
      const sha=isRecord(item.data)?item.data.candidateRevision:undefined;
      return typeof sha==='string'&&/^[a-f0-9]{40,64}$/u.test(sha)&&sha===trustedSha&&candidateReviews.every(run=>run.reviewBinding?.diffArtifactId===item.id&&run.reviewBinding?.commitSha===sha);
    }
    switch(evidenceRoles.get(id)){
      case 'review':return matchesReviewEvidence(item);
      case 'required':return currentCheckEvidence(item,true);
      case 'command':return currentCheckEvidence(item,false);
      default:return false;
    }
  };
  const invalidLoaded=Object.keys(loaded).filter(id=>{
    if(id!==latestDiff?.id)return !retrySemanticallyValid(id,loaded[id]!);
    const sha=isRecord(loaded[id]?.data)?loaded[id]!.data.candidateRevision:undefined;
    return typeof sha!=='string'||typeof trustedSha==='string'&&sha!==trustedSha;
  });
  const retryable=[...new Set([...failed,...invalidLoaded])];
  useEffect(()=>{invalidLoaded.forEach(id=>{const reference=expectedArtifacts.get(id);if(reference)artifactReader.forget(reference);});},[loaded,requestKey,JSON.stringify(invalidLoaded)]);
  useEffect(()=>{
    const recovered=failed.filter(id=>loaded[id]&&retrySemanticallyValid(id,loaded[id]!));
    if(recovered.length){setFailed(current=>current.filter(id=>!recovered.includes(id)));setRetryMessage('');}
  },[failed,loaded]);
  let reviewStatus:'Pending'|'Missing'|'Stale'|'Current'|'Unknown'='Unknown';
  if(!reviewRun)reviewStatus='Missing';
  else if(['queued','running'].includes(reviewRun.status))reviewStatus='Pending';
  else if(binding?.candidateRunId!==candidate?.id||binding?.diffRevision!==latestDiff?.revision)reviewStatus='Stale';
  else if(reviewArtifact&&failed.includes(reviewArtifact.id))reviewStatus='Unknown';
  else if(reviewArtifact&&!reviewMatches)reviewStatus='Stale';
  else if(reviewMatches)reviewStatus='Current';
  else if(failed.some(id=>metadata.some(item=>item.id===id&&item.runId===reviewRun.id)))reviewStatus='Unknown';
  else if(reviewRun.status==='completed')reviewStatus='Missing';
  const statusVariant=(status:string)=>status==='Current'?'secondary':status==='Stale'?'destructive':'outline';
  const shownRequiredStatus=evidenceFresh?requiredStatus:'Unknown';
  const shownCommandStatus=evidenceFresh?commandStatus:'Unknown';
  const shownReviewStatus=evidenceFresh?reviewStatus:'Unknown';
  function checksDetail(checks:Record<string,unknown>[]) { return checks.length?`${checks.filter(check=>check.exitCode===0).length} passed · ${checks.filter(check=>check.exitCode!==0).length} failed or unknown`:'No checks recorded'; }
  const fullFingerprint=typeof localFingerprint==='string'?localFingerprint:typeof reviewData.candidateFingerprint==='string'?reviewData.candidateFingerprint:undefined;
  return <section className="min-w-0 space-y-4"><header><h2 className="font-semibold">QA</h2><p className="mt-1 text-sm text-muted-foreground">Evidence is shown separately for the latest candidate.</p></header>
    {!latestDiff?<p className="rounded-lg border border-border border-dashed p-5 text-sm text-muted-foreground">{evidenceFresh?'No candidate changes are recorded. QA status is unknown.':'Checking scoped Work evidence; QA status is unknown.'}</p>:<>
      <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">{evidenceFresh?'Current candidate':'Last loaded candidate'} · commit {commitSha?.slice(0,12)??'unavailable'}</p>
      {!evidenceFresh&&<p role="status" className="text-sm text-amber-800">Work evidence is refreshing; QA results are Unknown until the scoped metadata is current.</p>}
      {loading&&<p role="status" className="text-sm text-muted-foreground">Loading candidate evidence…</p>}
      {failed.length>0&&!loading&&<p role="status" className="text-sm text-muted-foreground">Some evidence could not be loaded. Those results remain unknown.</p>}
      {retryable.length>0&&<div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={loading||!evidenceFresh} onClick={()=>void retryFailedEvidence()}>{loading?'Retrying evidence…':'Retry failed evidence'}</Button>{retryMessage&&<span role="status" className="text-sm text-muted-foreground">{retryMessage}</span>}</div>}
      <EvidenceSection title="Required checks" status={shownRequiredStatus} detail={evidenceFresh?requiredDetail:'Scoped Work evidence is refreshing; the last loaded result is unconfirmed.'}/>
      <EvidenceSection title="Command checks" status={shownCommandStatus} detail={evidenceFresh?commandDetail:'Scoped Work evidence is refreshing; the last loaded result is unconfirmed.'}/>
      <section className="min-w-0 space-y-2 rounded-lg border border-border p-3"><header className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Typed review</h3><Badge variant={statusVariant(shownReviewStatus)}>{shownReviewStatus==='Current'?'Current evidence':shownReviewStatus}</Badge></header><p className="min-w-0 wrap-anywhere text-sm text-muted-foreground">{!evidenceFresh?'Last loaded review is unconfirmed while Work evidence refreshes.':reviewRun?(reviewMatches?String(reviewData.disposition):reviewStatus==='Stale'?'does not match the latest candidate':'result unavailable'):'No review is recorded.'}</p>{evidenceFresh&&reviewMatches&&Array.isArray(reviewData.findings)&&reviewData.findings.map((item,index)=>isRecord(item)?<p key={String(item.id??index)} className="min-w-0 wrap-anywhere text-sm">{item.blocking===true?'Blocking · ':''}{String(item.summary??'Finding')}</p>:null)}{evidenceFresh&&reviewStatus==='Stale'&&<p className="text-xs text-amber-800">This review does not match the latest candidate and cannot approve it.</p>}</section>
      <details className="rounded-lg border border-border"><summary className="cursor-pointer px-3 py-2 text-sm">Evidence details</summary><div className="space-y-3 p-3"><dl className="grid min-w-0 gap-1 text-xs sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-muted-foreground">Candidate run</dt><dd className="wrap-anywhere font-mono">{candidate?.id??latestDiff.runId}</dd><dt className="text-muted-foreground">Diff artifact</dt><dd className="wrap-anywhere font-mono">{latestDiff.id}</dd><dt className="text-muted-foreground">Diff revision</dt><dd className="wrap-anywhere font-mono">{latestDiff.revision}</dd><dt className="text-muted-foreground">Commit SHA</dt><dd className="wrap-anywhere font-mono">{commitSha??'Not recorded'}</dd>{fullFingerprint&&<><dt className="text-muted-foreground">Candidate fingerprint</dt><dd className="wrap-anywhere font-mono">{fullFingerprint}</dd></>}{reviewRun&&<><dt className="text-muted-foreground">Review run</dt><dd className="wrap-anywhere font-mono">{reviewRun.id}</dd></>}</dl>{diff&&<ArtifactCard sessionKey={sessionKey} artifact={diff}/ >}{localQa&&loaded[localQa.id]&&<ArtifactCard sessionKey={sessionKey} artifact={loaded[localQa.id]!}/ >}{commandQa&&loaded[commandQa.id]&&<ArtifactCard sessionKey={sessionKey} artifact={loaded[commandQa.id]!}/ >}{reviewArtifact&&reviewMatches&&<ArtifactCard sessionKey={sessionKey} artifact={reviewArtifact}/>}</div></details>
    </>}
  </section>;
}

function EvidenceSection({title,status,detail}:{title:string;status:string;detail:string}){
  const variant=status==='Current'?'secondary':status==='Stale'?'destructive':'outline';
  return <section aria-label={title} className="space-y-2 rounded-lg border border-border p-3"><header className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{title}</h3><Badge variant={variant}>{status==='Current'?'Current evidence':status}</Badge></header><p className="text-sm text-muted-foreground">{detail}</p></section>;
}

function FullArtifactCard({artifact,artifactReader}:{artifact:Artifact;artifactReader:ArtifactReader}){const [full,setFull]=useState<{key:string;body:Artifact}|null>(null);const key=artifactKey(artifact);useEffect(()=>{let active=true;void artifactReader.read(artifact).then(body=>{if(active)setFull({key,body});}).catch(()=>undefined);return()=>{active=false;};},[key,artifactReader]);return full?.key===key?<ArtifactCard sessionKey="delivery" artifact={full.body}/>:<p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">Loading delivery evidence…</p>;}

function DiffRows({rows}:{rows:DiffRow[]}){
  return <div role="table" aria-label="Unified diff" className="max-h-[32rem] overflow-auto rounded bg-muted font-mono text-xs">{rows.map((line,index)=><div role="row" key={index} data-line-end={line.terminated?'true':undefined} aria-label={line.continuation?'Continuation of the same diff line':undefined} className={`grid grid-cols-[3.5rem_3.5rem_1fr] whitespace-pre ${line.type==='add'?'bg-emerald-100 text-emerald-950':line.type==='remove'?'bg-red-100 text-red-950':''}`}><span className="select-none text-right text-muted-foreground">{line.oldLine??''}</span><span className="select-none text-right text-muted-foreground">{line.newLine??''}</span><span>{line.text}</span></div>)}</div>;
}

function DiffFileViewer({artifactId,revision,file}:{artifactId:string;revision:string;file:DiffFileManifest}){
  const historical=!(file.chunkCount&&file.chunkCount>0)&&Array.isArray(file.hunks)&&file.hunks.length>0;
  const [busy,setBusy]=useState(false),[page,setPage]=useState(0),[pageLines,setPageLines]=useState<DiffRow[]>(),[rawPage,setRawPage]=useState(''),[pageBase64,setPageBase64]=useState(''),[hasNext,setHasNext]=useState(false),[continues,setContinues]=useState(false),[limited,setLimited]=useState(false),[portion,setPortion]=useState(0),[nextPortion,setNextPortion]=useState<number|null>(null),[warning,setWarning]=useState(''),[integrity,setIntegrity]=useState(''),[error,setError]=useState('');
  const cursors=useRef<Array<string|undefined>>([undefined]),lineStates=useRef<DiffPageState[]>([initialDiffPageState()]),unsupportedEncoding=useRef(file.encodingUnsupported===true),request=useRef<AbortController|null>(null),generation=useRef(0);
  const portionOffsets=useRef([0]),presentation=useRef<{text?:string;base64:string;before?:DiffPageState;unsupported:boolean}|null>(null);
  const showPortion=(offset:number)=>{
    const saved=presentation.current;if(!saved)return;
    if(saved.unsupported){const end=Math.min(saved.base64.length,offset+DIFF_VISIBLE_CHARS);setRawPage(saved.base64.slice(offset,end));setNextPortion(end<saved.base64.length?end:null);setLimited(end<saved.base64.length);}
    else if(saved.text!==undefined&&saved.before){const parsed=parseDiffPage(saved.text,saved.before,offset);setPageLines(parsed.rows);setNextPortion(parsed.nextOffset);setLimited(parsed.truncated);}
  };
  const navigatePortion=(index:number)=>{const offset=index>portion?nextPortion:portionOffsets.current[index];if(offset===null||offset===undefined)return;portionOffsets.current[index]=offset;setPortion(index);showPortion(offset);};
  useEffect(()=>()=>{generation.current++;request.current?.abort();},[artifactId,file.path,revision]);
  const load=async(index:number)=>{
    if(historical){const preview=historicalDiffRows(file.hunks);setPageLines(preview.rows);setLimited(preview.truncated);setWarning('Historical partial preview · full-file integrity is unverified.');return;}
    request.current?.abort();const controller=new AbortController();request.current=controller;const current=++generation.current;setBusy(true);setError('');
    setPageLines(undefined);setRawPage('');setPageBase64('');setIntegrity('');setLimited(false);setContinues(false);setHasNext(false);setPortion(0);setNextPortion(null);portionOffsets.current=[0];presentation.current=null;
    try{
      const result=await workbenchApi.diffFile(artifactId,file.path,revision,cursors.current[index],controller.signal);if(current!==generation.current)return;
      // Persist page identity, navigation and verification before any binary/decode branch returns.
      setPage(index);setHasNext(!!result.nextCursor);if(result.nextCursor)cursors.current[index+1]=result.nextCursor;
      setIntegrity(result.integrity==='verified'?'Whole-file SHA-256 verified':result.integrity==='pending'?'Page hash checked; whole-file SHA-256 is pending until the final page':'');
      setWarning(result.incomplete?result.reason??'Diff upload is incomplete; this page may not represent the full file.':'');
      if(result.binary){setWarning('Binary file change');return;}
      if(result.contentBase64){
        setPageBase64(result.contentBase64);const bytes=Uint8Array.from(atob(result.contentBase64),char=>char.charCodeAt(0));let decoded:string;
        const unsupported=()=>{unsupportedEncoding.current=true;presentation.current={base64:result.contentBase64,unsupported:true};showPortion(0);setWarning(`Unsupported UTF-8 encoding · raw page bytes are retained as base64.${result.reason?` ${result.reason}`:''}`);};
        if(result.encodingUnsupported||unsupportedEncoding.current){unsupported();return;}
        try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{unsupported();return;}
        const before=lineStates.current[index];if(!before)throw new Error('This page has no preceding hunk state. Read the previous page first.');
        const parsed=parseDiffPage(decoded,before);lineStates.current[index+1]=parsed.state;presentation.current={text:decoded,base64:result.contentBase64,before,unsupported:false};setPageLines(parsed.rows);setLimited(parsed.truncated);setNextPortion(parsed.nextOffset);setContinues(parsed.continues);
      }else if(!result.complete)setError(result.reason??'Diff page is missing; file is INCOMPLETE.');
    }catch(cause){if(!controller.signal.aborted&&current===generation.current)setError(cause instanceof Error?cause.message:'Unable to read this diff page.');}
    finally{if(current===generation.current)setBusy(false);}
  };
  const downloadPage=()=>{
    const bytes=Uint8Array.from(atob(pageBase64),char=>char.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes]));
    const link=document.createElement('a');link.href=url;link.download=`diff-page-${page+1}.bin`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
  };
  return <details className="overflow-hidden rounded-md border border-border" onToggle={event=>{const expanded=event.currentTarget.open;if(expanded&&!file.binary&&pageLines===undefined&&!rawPage)void load(page);if(!expanded){generation.current++;request.current?.abort();}}}>
    <summary className="flex cursor-pointer flex-wrap items-center gap-3 bg-muted/30 px-3 py-2 font-mono text-sm"><span className="min-w-0 flex-1 break-all">{file.oldPath?`${file.oldPath} → ${file.path}`:file.path}</span><span className="text-emerald-700">+{file.additions??'—'}</span><span className="text-red-700">−{file.deletions??'—'}</span><Badge variant="outline">{file.status}</Badge>{file.binary&&<Badge variant="secondary">Binary</Badge>}{historical&&<Badge variant="outline">Historical preview</Badge>}</summary>
    {file.binary?<p className="p-3 text-sm text-muted-foreground">Binary file change · no text diff is available.</p>:<div className="space-y-2 p-3">
      {busy&&<p role="status" className="text-xs text-muted-foreground">Loading diff page…</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{warning&&<p role="status" className="text-sm text-amber-800">{warning}</p>}{integrity&&<p role="status" className="text-xs text-muted-foreground">{integrity}</p>}
      {(pageLines||rawPage)&&<>
        {!historical&&<p className="text-xs text-muted-foreground">Page {page+1} of {file.chunkCount??'unknown'} · {file.textBytes??0} bytes</p>}
        {rawPage?<pre aria-label="Unsupported encoding raw page" className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 font-mono text-xs">base64:{rawPage}</pre>:<DiffRows rows={pageLines??[]}/>}
        {continues&&<p role="status" className="text-xs text-muted-foreground">The same diff line continues on the next byte page.</p>}
        {limited&&<p role="status" className="text-xs text-muted-foreground">Page display is limited.{historical?' Only the stored historical preview is available.':' Continue with More of this page to read all remaining text in app.'}</p>}
        {!historical&&<><p aria-label="Current page portion" className="text-xs text-muted-foreground">Portion {portion+1} of this page</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={portion===0||busy} onClick={()=>navigatePortion(portion-1)}>Previous portion</Button><Button size="sm" variant="outline" disabled={nextPortion===null||busy} onClick={()=>navigatePortion(portion+1)}>More of this page</Button></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page===0||busy} onClick={()=>void load(page-1)}>Previous page</Button><Button size="sm" variant="outline" disabled={!hasNext||busy} onClick={()=>void load(page+1)}>Next page</Button>{pageBase64&&<Button size="sm" variant="outline" onClick={downloadPage}>Download raw page</Button>}</div></>}
      </>}
    </div>}
  </details>;
}

function ArtifactCard({ artifact,sessionKey }: { artifact: Artifact;sessionKey:string }) {
  const data = isRecord(artifact.data) ? artifact.data : {};
  if(artifact.kind==='delivery'){const url=typeof data.pullRequestUrl==='string'?data.pullRequestUrl:'';const phase=typeof data.phase==='string'?data.phase:'queued';const action=data.action==='merge_pr'?'Merge receipt':'Draft PR delivery';return <section className="rounded-lg border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-sm">{action}</strong><p className="mt-1 text-xs text-muted-foreground">{url?<a href={url} target="_blank" rel="noreferrer">{url}</a>:`${phase} · ${String(data.operationId??artifact.runId)}`}</p></div><Badge variant={phase==='merged'?'secondary':'outline'}>{phase.replace('_',' ')}</Badge></div>{typeof data.commitSha==='string'&&<p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">Candidate · {data.commitSha}</p>}{typeof data.mergeSha==='string'&&<p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Merged commit · {data.mergeSha}</p>}</section>;}
  if (artifact.kind === 'diff') {
    const files = Array.isArray(data.files) ? data.files.filter(isDiffFile) : [];
    const totalFiles = typeof data.totalFiles === 'number' && Number.isSafeInteger(data.totalFiles) && data.totalFiles >= files.length ? data.totalFiles : undefined;
    const shown = `${files.length} changed file${files.length === 1 ? '' : 's'}`;
    const fileCount = totalFiles === undefined ? `Showing ${shown} · total unknown` : `Showing ${files.length} of ${totalFiles} changed file${totalFiles === 1 ? '' : 's'}`;
    const diffStatus = data.truncated === true ? 'Aggregate preview is truncated; the complete file manifest is listed below.' : data.truncated === false ? 'Aggregate preview is complete.' : 'Aggregate preview status is unknown.';
    return <section className="space-y-3 rounded-lg border border-border p-3"><header className="flex flex-wrap items-center justify-between gap-3"><div><strong>{fileCount}</strong><p className="text-xs text-muted-foreground">Base {String(data.baseRevision ?? 'unknown')}</p></div><span className="font-mono text-sm"><span className="text-emerald-700">+{Number(data.additions) || 0}</span> <span className="text-red-700">−{Number(data.deletions) || 0}</span></span></header><p role="status" className="text-xs text-muted-foreground">{diffStatus} Per-file text loads only when expanded.</p>{files.map(file => <DiffFileViewer key={`${sessionKey}:${artifact.projectId}:${artifact.workId}:${artifact.runId}:${artifact.id}:${artifact.revision}:${String(data.candidateRevision??'')}:${file.path}:${file.status}`} artifactId={artifact.id} revision={artifact.revision} file={file}/>)}</section>;
  }
  if (artifact.kind === 'qa') {
    const typedReview = isRecord(data.typedReview) ? data.typedReview : null;
    const checks = Array.isArray(data.checks) ? data.checks.filter(isRecord) : [];
    const verification = data.verification === 'stale' || data.stale === true ? 'Stale' : data.verification === 'current' ? 'Current' : 'Unverified';
    const review = typeof data.review === 'string' ? data.review : '';
    return <section className="min-w-0 space-y-3 rounded-lg border border-border p-3"><header className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0"><strong>Verification</strong><p className="text-xs text-muted-foreground">{checks.length ? `${checks.length} recorded checks` : 'No checks were recorded'}</p>{typeof data.candidateFingerprint === 'string' && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Candidate · {data.candidateFingerprint}</p>}</div><Badge className="shrink-0" variant={verification === 'Current' ? 'secondary' : verification === 'Stale' ? 'destructive' : 'outline'}>{verification} evidence</Badge></header>{typedReview&&<section className="min-w-0 rounded-md border border-border p-3"><div className="flex min-w-0 items-center justify-between gap-3"><h3 className="min-w-0 text-sm font-medium">Typed review</h3><Badge className="shrink-0" variant={typedReview.disposition==='approved'?'secondary':typedReview.disposition==='changes_requested'?'destructive':'outline'}>{String(typedReview.disposition)}</Badge></div>{Array.isArray(typedReview.findings)&&typedReview.findings.map((item,index)=>isRecord(item)?<p key={String(item.id??index)} className="mt-2 min-w-0 wrap-anywhere text-sm">{item.blocking===true?'Blocking · ':''}{String(item.summary??'Finding')}</p>:null)}<p className="mt-2 min-w-0 wrap-anywhere font-mono text-[11px] text-muted-foreground">Candidate · {String(typedReview.commitSha??'unknown')}</p></section>}{verification !== 'Current' && checks.length > 0 && <p className="min-w-0 wrap-anywhere text-sm text-muted-foreground">A passing command only records its exit status. These results do not verify the current change set.</p>}{review && <section className="min-w-0 rounded-md bg-muted/50 p-3"><h3 className="text-sm font-medium">Independent review</h3><p className="mt-1 min-w-0 whitespace-pre-wrap wrap-anywhere text-sm text-muted-foreground">{review}</p></section>}{checks.length ? checks.map((check, index) => { const passed = check.exitCode === 0; const output = typeof check.output === 'string' ? check.output : ''; const testedRevision = typeof check.testedRevision === 'string' ? check.testedRevision : ''; return <details key={`${String(check.name)}:${index}`} className="min-w-0 rounded-md border border-border"><summary className="flex min-w-0 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm"><span className="min-w-0 wrap-anywhere">{String(check.name ?? check.command ?? 'Check')}</span><Badge className="shrink-0" variant={check.exitCode === null ? 'outline' : passed ? 'secondary' : 'destructive'}>{check.exitCode === null ? 'Unknown' : passed ? 'Command passed' : `Command failed · ${String(check.exitCode)}`}</Badge></summary><div className="min-w-0 space-y-2 border-t p-3 text-xs"><p className="min-w-0 wrap-anywhere font-mono text-muted-foreground">{String(check.command ?? 'Command unavailable')}</p>{testedRevision && <p className="min-w-0 break-all text-muted-foreground">Tested fingerprint · {testedRevision}</p>}{output && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{output}</pre>}</div></details>; }) : typedReview ? null : <p className="text-sm text-muted-foreground">This evidence contains no recorded checks.</p>}</section>;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
type DiffFileManifest={path:string;oldPath?:string;status:string;binary:boolean;encodingUnsupported?:boolean;hunks?:unknown;additions:number|null;deletions:number|null;textBytes?:number;chunkCount?:number;fileSha256?:string};
function isDiffFile(value: unknown): value is DiffFileManifest {
  if (!isRecord(value) || typeof value.path !== 'string' || !['added', 'modified', 'deleted', 'renamed'].includes(String(value.status)) || typeof value.binary !== 'boolean') return false;
  const validCount = (count: unknown) => count === null || typeof count === 'number';
  return validCount(value.additions) && validCount(value.deletions) && (value.oldPath===undefined||typeof value.oldPath==='string');
}

function ConnectProject({ refresh, setError }: { refresh: () => Promise<void>; setError: (value: string) => void }) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [name, setName] = useState(''); const [repositoryUrl, setRepositoryUrl] = useState(''); const [busy, setBusy] = useState(false);
  return <form className="mx-auto grid max-w-xl gap-5" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const project = await workbenchApi.createProject({ name, ...(repositoryUrl.trim() ? { repositoryUrl } : {}) }); await refresh(); if (active.current) navigate(href('master', project.id)); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><header><h1 className="text-2xl font-semibold">Connect project</h1><p className="mt-1 text-sm text-muted-foreground">Create a project space and link its repository.</p></header><div className="grid gap-2"><Label htmlFor="project-name">Project name</Label><Input id="project-name" required value={name} onChange={event => setName(event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="repository-url">GitHub repository URL</Label><Input id="repository-url" type="url" placeholder="https://github.com/org/repository" value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} /></div><div><Button disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</Button></div></form>;
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
  return <section className="w-full"><ProjectSettingsNav project={project} active="instructions"/><header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Instructions</h1><p className="mt-1 text-sm text-muted-foreground">Project context that Master and Agents can use.</p></div>{editing ? <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => { const next = cancelInstructionsDraft(project.instructions); draftRef.current = next.draft; setDraftState(next); setEditing(false); }}>Cancel</Button><Button disabled={busy || draft === baseInstructions} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button></div> : canEdit && <Button variant="outline" onClick={() => { const next = startInstructionsDraft(project.instructions); draftRef.current = next.draft; setDraftState(next); setEditing(true); }}>Edit</Button>}</header>{hasRemoteUpdate && <div role="status" className="mb-4 grid gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm"><p><strong>Instructions changed elsewhere.</strong> Your draft is preserved. The latest saved version is shown below.</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-sans">{project.instructions || 'No project instructions yet.'}</pre><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { const next = useLatestInstructions(project.instructions); draftRef.current = next.draft; setDraftState(next); }}>Use latest version</Button><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { const next = keepInstructionsDraft({ draft: draftRef.current, base: baseInstructions }, project.instructions); draftRef.current = next.draft; setDraftState(next); }}>Keep editing my draft</Button></div></div>}{editing && canEdit ? <><Textarea className="min-h-[40vh] resize-y" value={draft} onChange={event => { draftRef.current = event.target.value; setDraftState(current => editInstructionsDraft(current, event.target.value)); }} placeholder="Add project context, working preferences, or quality expectations…" /><div className="mt-4 flex flex-wrap items-center gap-2"><span className="mr-1 text-sm text-muted-foreground">Optional starting points</span>{suggestions.map(([label, text]) => <Button key={label} type="button" variant="outline" size="sm" onClick={() => { const nextDraft = `${draftRef.current}${draftRef.current && !draftRef.current.endsWith('\n') ? '\n\n' : ''}${text}`; draftRef.current = nextDraft; setDraftState(current => editInstructionsDraft(current, nextDraft)); }}><Plus aria-hidden="true" className="mr-1 size-4" />{label}</Button>)}</div></> : <p className="min-h-32 whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-4 text-sm leading-relaxed">{project.instructions || 'No project instructions yet.'}</p>}</section>;
}

function Members({ project, snapshot, refresh, setError }: { project: Project; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void }) {
  type InviteRequest = Readonly<{ email: string; projectId: string; role: Member['role']; sendEmail: boolean; requestId: string }>;
  type InviteAttempt = Readonly<{ request: InviteRequest; phase: 'pending' | 'unknown' | 'complete' | 'revoking'; delivery: string; url: string; inviteId: string | null }>;
  const [email, setEmail] = useState(''); const [role, setRole] = useState<Member['role']>('member');
  const [emailAvailability, setEmailAvailability] = useState<'loading' | 'available' | 'unavailable' | 'error'>('loading');
  const [attempt, setAttempt] = useState<InviteAttempt | null>(null);
  const attemptRef = useRef<InviteAttempt | null>(null);
  const updateAttempt = useCallback((next: InviteAttempt | null) => { attemptRef.current=next;setAttempt(next); },[]);
  const busy=attempt?.phase==='pending'||attempt?.phase==='revoking',delivery=attempt?.delivery??'',inviteUrl=attempt?.url??'';
  const mountedRef = useRef(true);
  const [availabilityRetry, setAvailabilityRetry] = useState(0);
  const [members, setMembers] = useState<Member[]>([]); const [invites, setInvites] = useState<Array<{ id: string; email: string; role: Member['role']; expiresAt: string }>>([]);
  const canManage = useProjectAdmin(project.id, snapshot.member);
  useEffect(() => { mountedRef.current=true; return()=>{mountedRef.current=false;attemptRef.current=null;}; },[]);
  useEffect(() => { let active=true; setEmailAvailability('loading'); void workbenchApi.inviteEmailConfig(project.id).then(value=>{if(active)setEmailAvailability(value.emailAvailable?'available':'unavailable');}).catch(()=>{if(active)setEmailAvailability('error');}); return()=>{active=false;}; },[project.id,availabilityRetry]);
  const clearInvite=()=>updateAttempt(null);
  const submitInvite=async(sendEmail:boolean)=>{
    const previous=attemptRef.current;
    if(previous?.phase==='pending'||previous?.phase==='revoking')return;
    const payload={email:email.trim().toLowerCase(),projectId:project.id,role,sendEmail};
    const retry=previous?.phase==='unknown'&&previous.request.email===payload.email&&previous.request.projectId===payload.projectId&&previous.request.role===payload.role&&previous.request.sendEmail===payload.sendEmail;
    const pending:InviteAttempt={request:retry?previous.request:{...payload,requestId:crypto.randomUUID()},phase:'pending',delivery:retry?previous.delivery:'',url:retry?previous.url:'',inviteId:retry?previous.inviteId:null};
    // The ref is also the synchronous double-submit gate. Each snapshot fences its own completion.
    updateAttempt(pending);setError('');
    try {
      const result=await workbenchApi.invite(pending.request);
      if(attemptRef.current!==pending)return;
      const outcome=result.delivery??'not_requested';let url=pending.url;
      if(result.token){const link=new URL('/workbench/',window.location.origin);link.searchParams.set('invite',result.token);url=link.toString();}
      const completed:InviteAttempt={...pending,phase:outcome==='unknown'?'unknown':'complete',delivery:outcome,url,inviteId:result.inviteId??pending.inviteId};
      updateAttempt(completed);
      try { await load(); await refresh(); } catch(cause) { if(attemptRef.current===completed)setError(errorMessage(cause)); }
    } catch(cause) {
      if(attemptRef.current!==pending)return;
      const uncertain=!(cause instanceof ApiError)||cause.status>=500;
      updateAttempt({...pending,phase:uncertain?'unknown':'complete',delivery:uncertain?'unknown':''});setError(errorMessage(cause));
    }
  };
  const retryEmailAvailability=()=>{setEmailAvailability('loading');setAvailabilityRetry(value=>value+1);};
  const load = useCallback(async () => { const memberResult = await workbenchApi.projectMembers(project.id); setMembers(memberResult.members); if (canManage) { const inviteResult = await workbenchApi.projectInvites(project.id); setInvites(inviteResult.invites); } else setInvites([]); }, [canManage, project.id]);
  useEffect(() => { void load().catch(cause => setError(errorMessage(cause))); }, [load, setError]);
  const revokeInvite=async(invite:typeof invites[number])=>{
    const started=attemptRef.current;
    if(started?.phase==='pending'||started?.phase==='revoking')return;
    const related=started?.inviteId!=null&&started.inviteId===invite.id;
    const revoking:InviteAttempt|null=related?{...started,phase:'revoking'}:null;
    if(revoking)updateAttempt(revoking);
    try {
      await workbenchApi.revokeInvite(invite.id);
      if(!mountedRef.current)return;
      if(revoking&&attemptRef.current===revoking)clearInvite();
      await load();
    } catch(cause) {
      if(mountedRef.current&&attemptRef.current===(revoking??started)){if(revoking)updateAttempt(started?{...started}:null);setError(errorMessage(cause));}
    }
  };
  return <section className="w-full"><ProjectSettingsNav project={project} active="members"/><header className="mb-5"><h1 className="text-2xl font-semibold">Members</h1><p className="mt-1 text-sm text-muted-foreground">Invite people to this private project.</p></header>{canManage && <><form className="mb-3 flex flex-wrap items-end gap-3 rounded-lg border border-border p-4" onSubmit={event=>{event.preventDefault();if(emailAvailability==='available')void submitInvite(true);}}><div className="grid min-w-56 flex-1 gap-2"><Label htmlFor="invite-email">Email</Label><Input id="invite-email" type="email" required value={email} onChange={event=>{if(attemptRef.current?.request.email!==event.target.value.trim().toLowerCase())clearInvite();setEmail(event.target.value);}} /></div><div className="grid gap-2"><Label htmlFor="invite-role">Role</Label><NativeSelect id="invite-role" className="h-9 rounded-md border bg-background px-3 text-sm" value={role} onChange={event=>{if(attemptRef.current?.request.role!==event.target.value)clearInvite();setRole(event.target.value as Member['role']);}}><NativeSelectOption value="member">Member</NativeSelectOption><NativeSelectOption value="admin">Admin</NativeSelectOption></NativeSelect></div><Button disabled={busy||emailAvailability!=='available'}>{attempt?.phase==='revoking'?'Revoking…':busy?'Sending…':'Invite'}</Button>{(emailAvailability==='unavailable'||emailAvailability==='error'||attempt?.phase==='unknown'&&!attempt.request.sendEmail)&&<Button type="button" variant="outline" disabled={busy} onClick={()=>void submitInvite(false)}>Create link</Button>}{emailAvailability==='error'&&<Button type="button" variant="outline" disabled={busy} onClick={retryEmailAvailability}>Retry availability check</Button>}</form><p role={emailAvailability==='error'?'alert':'status'} className="mb-5 text-sm text-muted-foreground">{emailAvailability==='unavailable'?'Email sending is unavailable. Create a link to invite this person.':emailAvailability==='error'?'Could not check email sending availability. You can create a link without email or retry the check.':emailAvailability==='available'?'Invite sends an email; Copy link remains available.':'Checking email sending availability…'}</p></>}{delivery && <p role="status" className="mb-3 text-sm">{delivery==='accepted'?'Email accepted by the SMTP server; inbox delivery is not confirmed.':delivery==='failed'?'Email was rejected before acceptance.':delivery==='unknown'?'Email outcome is unknown. Do not retry automatically; check the recipient before sending again.':delivery==='unavailable'?'Email sending is unavailable. The invitation link is ready.':'Invitation link created.'}</p>}{inviteUrl && <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm"><span className="min-w-0 flex-1 break-all">Invitation link · {inviteUrl}</span><Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Copy link</Button></div>}
    <h2 className="mb-2 font-semibold">Project members</h2><ul className="mb-7 divide-y rounded-lg border border-border">{members.map(record => <li key={record.id} className="flex items-center justify-between gap-3 border-border p-3 text-sm"><span>{record.name} · {record.email}</span><span className="flex items-center gap-3 text-muted-foreground">{record.role}{canManage && record.id !== snapshot.member.id && record.role !== 'owner' && <Button variant="ghost" size="sm" onClick={async () => { try { await workbenchApi.removeProjectMember(project.id, record.id); await load(); } catch (cause) { setError(errorMessage(cause)); } }}>Remove</Button>}</span></li>)}</ul>
    {canManage && <><h2 className="mb-2 font-semibold">Pending invitations</h2><ul className="divide-y rounded-lg border border-border">{invites.map(invite => <li key={invite.id} className="flex items-center justify-between gap-3 border-border p-3 text-sm"><span>{invite.email} · {invite.role}</span><span className="flex items-center gap-3 text-muted-foreground">Expires {new Date(invite.expiresAt).toLocaleDateString()}<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void revokeInvite(invite)}>Revoke</Button></span></li>)}</ul></>}</section>;
}

function SettingsPage({ view, project, member, snapshot, refresh, setError }: { view: View; project?: Project; member: Member; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const projectTabs: [View, string][] = [['instructions', 'Instructions'], ['skills', 'Skills'], ['members', 'Members'], ['connections', 'Connections']];
  const workspaceTabs: [View, string][] = [['agent-profiles', 'Agent profiles'], ['workspace-skills', 'Skills'], ['model-providers', 'Model providers']];
  const workspace = view === 'agent-profiles' || view === 'model-providers' || view === 'workspace-skills';
  const projectAdmin = useProjectAdmin(workspace ? '' : project?.id ?? '', member);
  const canManage = workspace ? member.role === 'owner' || member.role === 'admin' : projectAdmin;
  const items = snapshot.settings.filter(item => workspace ? view === 'agent-profiles' ? item.kind === 'profile' && !item.projectId : view === 'workspace-skills' && item.kind === 'skill' && !item.projectId : item.projectId === project?.id && (view === 'skills' ? item.kind === 'skill' : item.kind === 'connection'));
  const profileModels = ['gpt-6-luna', 'gpt-6.1-sol'];
  const availableModels = [...new Set((snapshot.providerConnections ?? []).filter(connection => connection.enabled && connection.status === 'available').flatMap(connection => connection.models).filter(model => profileModels.includes(model)))];
  const [name, setName] = useState(''); const [content, setContent] = useState(''); const [model, setModel] = useState(''); const [reasoning, setReasoning] = useState<'low' | 'medium' | 'high' | 'xhigh'>('medium'); const [skillIds, setSkillIds] = useState<string[]>([]); const [connectionProvider, setConnectionProvider] = useState<'github' | 'slack'>('github'); const [connectionUrl, setConnectionUrl] = useState(''); const [connectionPurpose,setConnectionPurpose]=useState<'source'|'delivery'>('source');const [baseBranch,setBaseBranch]=useState('main'); const [busy, setBusy] = useState(false);
  const tabList = workspace ? workspaceTabs : projectTabs;
  const title = tabList.find(([id]) => id === view)?.[1] ?? 'Settings';
  return <section className="w-full">{!workspace && project ? <ProjectSettingsNav project={project} active={view}/>: <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border" aria-label="Workspace settings">{tabList.map(([id, label]) => <a key={id} className={`shrink-0 border-b-2 px-3 py-3 text-sm no-underline ${view === id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} href={href(id)}>{label}</a>)}</nav>}<header className="mb-5"><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{workspace ? 'Reusable workspace configuration.' : 'Project configuration.'}</p></header>
    {view === 'skills' && canManage && <form className="mb-7 grid gap-3 rounded-lg border border-border p-4 md:grid-cols-2" onSubmit={async event => { event.preventDefault(); if (!name.trim() || !content.trim() || !project) return; setBusy(true); setError(''); try { await workbenchApi.saveSetting({ kind: 'skill', projectId: project.id, name: name.trim(), data: { content: content.trim() } }); setName(''); setContent(''); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid gap-2"><Label htmlFor="skill-name">Skill name</Label><Input id="skill-name" required value={name} onChange={e => setName(e.target.value)} /></div><div className="grid gap-2 md:col-span-2"><Label htmlFor="skill-content">Skill instructions</Label><Textarea id="skill-content" required value={content} onChange={e => setContent(e.target.value)} placeholder="Write the reusable instructions this skill provides." /></div><div className="md:col-span-2"><Button disabled={busy || !name.trim() || !content.trim()}>{busy ? 'Saving…' : 'Create skill'}</Button></div></form>}
    {view === 'skills' && canManage && project && <GithubSkillImport project={project} refresh={refresh} setError={setError} />}
    {(view === 'skills' || view === 'workspace-skills') && canManage && <MarketplaceSkillsImport scope={workspace ? 'workspace' : 'project'} projectId={workspace ? undefined : project?.id} snapshot={snapshot} refresh={refresh} setError={setError} />}
    {view === 'agent-profiles' && canManage && <form className="mb-7 grid gap-4 rounded-lg border border-border p-4 md:grid-cols-2" onSubmit={async event => { event.preventDefault(); if (!name.trim() || !availableModels.includes(model)) return; setBusy(true); setError(''); try { await workbenchApi.saveSetting({ kind: 'profile', name: name.trim(), data: { model, reasoning, skillIds } }); setName(''); setSkillIds([]); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid gap-2"><Label htmlFor="profile-name">Profile name</Label><Input id="profile-name" required value={name} onChange={e => setName(e.target.value)} /></div><div className="grid gap-2"><Label htmlFor="profile-model">Model</Label><NativeSelect id="profile-model" value={model} onChange={e => setModel(e.target.value as typeof model)}><NativeSelectOption value="">Choose a reported model</NativeSelectOption>{availableModels.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></div><p className="text-sm text-muted-foreground md:col-span-2">Profiles are reusable across the workspace. Choose a model reported by an available provider connection; each new Work binds its own connection.</p><div className="grid gap-2"><Label htmlFor="profile-reasoning">Reasoning</Label><NativeSelect id="profile-reasoning" value={reasoning} onChange={e => setReasoning(e.target.value as typeof reasoning)}>{['low', 'medium', 'high', 'xhigh'].map(value => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></div><ProfileSkillsEditor idPrefix="new-profile" allSettings={snapshot.settings} skillIds={skillIds} setSkillIds={setSkillIds} refresh={refresh} setError={setError} /><div className="md:col-span-2"><Button disabled={busy || !name.trim() || !availableModels.includes(model)}>{busy ? 'Saving…' : 'Add profile'}</Button></div></form>}
    {view === 'model-providers' && <ProviderConnections settings={snapshot.settings} runtimes={snapshot.runtimeProviders} connections={snapshot.providerConnections} canManage={canManage} refresh={refresh} setError={setError} />}
    {view === 'connections' && canManage && project && <><FeedbackIntakeSettings project={project} refresh={refresh} setError={setError} /><form className="mb-7 flex flex-wrap items-end gap-3 rounded-lg border border-border p-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await workbenchApi.saveSetting({ kind: 'connection', projectId: project.id, name: connectionProvider === 'github' ? 'GitHub source' : 'Slack source', data: { provider: connectionProvider, url: connectionUrl, enabled: true } }); setConnectionUrl(''); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid gap-2"><Label htmlFor="connection-provider">Source</Label><NativeSelect id="connection-provider" className="h-9 rounded-md border bg-background px-3 text-sm" value={connectionProvider} onChange={e => setConnectionProvider(e.target.value as typeof connectionProvider)}><NativeSelectOption value="github">GitHub</NativeSelectOption><NativeSelectOption value="slack">Slack</NativeSelectOption></NativeSelect></div><div className="grid min-w-64 flex-1 gap-2"><Label htmlFor="connection-url">Repository or channel URL</Label><Input id="connection-url" type="url" required value={connectionUrl} onChange={e => setConnectionUrl(e.target.value)} /></div><Button disabled={busy || !connectionUrl.trim()}>{busy ? 'Saving…' : 'Add source reference'}</Button><p className="w-full text-xs text-muted-foreground">This saves a source reference; it does not authenticate GitHub or Slack. Slack events require server configuration.</p></form></>}
    {view === 'connections' && canManage && project && <DeliveryConnectionSettings project={project} snapshot={snapshot} refresh={refresh} setError={setError} />}
    {items.length ? <div className="divide-y rounded-lg border border-border">{items.map(item => <SettingRow key={item.id} item={item} allSettings={snapshot.settings} availableModels={availableModels} canEdit={canManage} canCopyToWorkspace={!workspace && (member.role === 'owner' || member.role === 'admin')} refresh={refresh} setError={setError} />)}</div> : view !== 'model-providers' && <EmptyState title={`No ${title.toLowerCase()} yet`} detail={(view === 'skills' || view === 'workspace-skills') ? 'Add reusable project instructions or import a GitHub SKILL.md below.' : view === 'agent-profiles' ? 'Create reusable profiles for the team’s Agents.' : 'No project connections are recorded.'} />}
  </section>;
}

function GithubSkillImport({ project, refresh, setError }: { project: Project; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [url, setUrl] = useState(''); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  return <form className="mb-7 flex flex-wrap items-end gap-3 rounded-lg border border-border p-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await workbenchApi.importGithubSkill(project.id, url, name.trim() || undefined); setUrl(''); setName(''); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div className="grid min-w-64 flex-1 gap-2"><Label htmlFor="github-skill-url">GitHub SKILL.md URL</Label><Input id="github-skill-url" required type="url" placeholder="https://github.com/org/repo/blob/main/SKILL.md" value={url} onChange={event => setUrl(event.target.value)} /></div><div className="grid min-w-40 gap-2"><Label htmlFor="github-skill-name">Display name (optional)</Label><Input id="github-skill-name" value={name} onChange={event => setName(event.target.value)} /></div><Button disabled={busy || !url.trim()}>{busy ? 'Importing…' : 'Import from GitHub'}</Button><p className="w-full text-xs text-muted-foreground">Imports the SKILL.md from the GitHub URL you provide as project instructions. The file is not run during import.</p></form>;
}

function MarketplaceSkillsImport({ scope, projectId, snapshot, refresh, setError }: { scope: 'project' | 'workspace'; projectId?: string; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const storageKey = `menoteam-marketplace-${scope}-${projectId ?? 'workspace'}`;
  const [catalogUrl, setCatalogUrl] = useState(() => localStorage.getItem(storageKey) ?? '');
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof workbenchApi.listCatalog>> | null>(null);
  const [pluginName, setPluginName] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>> | null>(null);
  const [details, setDetails] = useState<Awaited<ReturnType<typeof workbenchApi.previewCatalogPlugin>> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [importing, setImporting] = useState(false); const [success, setSuccess] = useState('');
  const requestGeneration = useRef(0);
  useEffect(() => { requestGeneration.current++; setBusy(false); setImporting(false); setCatalog(null); setCatalogUrl(localStorage.getItem(storageKey) ?? ''); setPluginName(''); setPreview(null); setDetails(null); setSelected([]); }, [scope, projectId, storageKey]);
  const imported = snapshot.settings.filter(item => item.kind === 'skill' && item.projectId === projectId);
  return <section className="mb-7 grid gap-4 rounded-lg border border-border p-4" aria-labelledby={`marketplace-title-${scope}`}>
    <header><h2 id={`marketplace-title-${scope}`} className="font-semibold">Skills Marketplace</h2><p className="mt-1 text-sm text-muted-foreground">GitHub marketplace.json · imports selected skills as instructions. Catalog content is untrusted reference data.</p></header>
    <form className="flex flex-wrap items-end gap-3" onSubmit={async event => { event.preventDefault(); const generation = ++requestGeneration.current; setBusy(true); setError(''); setSuccess(''); setPreview(null); setDetails(null); setSelected([]); try { const result = await workbenchApi.listCatalog({ scope, ...(projectId ? { projectId } : {}), catalogUrl }); if (requestGeneration.current !== generation) return; setCatalog(result); setPluginName(''); localStorage.setItem(storageKey, catalogUrl); } catch (cause) { if (requestGeneration.current === generation) { setCatalog(null); setError(errorMessage(cause)); } } finally { if (requestGeneration.current === generation) setBusy(false); } }}>
      <div className="grid min-w-64 flex-1 gap-2"><Label htmlFor={`marketplace-url-${scope}`}>GitHub catalog URL</Label><Input id={`marketplace-url-${scope}`} type="url" required placeholder="https://github.com/org/repo/blob/main/.agents/plugins/marketplace.json" value={catalogUrl} disabled={importing} onChange={event => { requestGeneration.current++; setBusy(false); setCatalogUrl(event.target.value); setCatalog(null); setPreview(null); setDetails(null); setSelected([]); }} /></div>
      <Button disabled={busy || importing || !catalogUrl.trim()}>{busy ? 'Loading catalog…' : 'Load catalog'}</Button>
    </form>
    {success && <p role="status" className="rounded-md border border-green-600/30 bg-green-600/5 p-3 text-sm">{success}</p>}
    {catalog && <div className="grid gap-3"><p className="text-xs text-muted-foreground">{catalog.name} · Catalog commit {catalog.commit}</p><div className="grid gap-2"><Label htmlFor={`marketplace-plugin-${scope}`}>Plugin</Label><NativeSelect id={`marketplace-plugin-${scope}`} wrapperClassName="max-w-xl" className="h-9 rounded-md border bg-background px-3 text-sm" value={pluginName} disabled={importing} onChange={event => { requestGeneration.current++; setBusy(false); setPluginName(event.target.value); setPreview(null); setDetails(null); setSelected([]); }}><NativeSelectOption value="">Choose a plugin</NativeSelectOption>{catalog.plugins.map(plugin => <NativeSelectOption key={plugin.name} value={plugin.name} disabled={Boolean(plugin.unsupportedReason)}>{plugin.name}{plugin.category ? ` · ${plugin.category}` : ''}{plugin.unsupportedReason ? ' · unsupported source' : ''}</NativeSelectOption>)}</NativeSelect>{catalog.plugins.some(plugin => plugin.unsupportedReason) && <p className="text-xs text-muted-foreground">{catalog.plugins.filter(plugin => plugin.unsupportedReason).map(plugin => `${plugin.name}: ${plugin.unsupportedReason}`).join(' · ')}</p>}</div><Button type="button" variant="outline" className="w-fit" disabled={busy || !pluginName} onClick={async () => { const generation = ++requestGeneration.current; setBusy(true); setError(''); setDetails(null); try { const result = await workbenchApi.previewCatalogPlugin({ scope, ...(projectId ? { projectId } : {}), catalogUrl, pluginName }); if (requestGeneration.current !== generation) return; if (result.catalog.commit !== catalog.commit) { setCatalog(null); setPreview(null); setDetails(null); setSelected([]); setError('Catalog changed since it was loaded. Reload the catalog before inspecting this plugin.'); return; } setPreview(result); } catch (cause) { if (requestGeneration.current === generation) { setPreview(null); setError(errorMessage(cause)); } } finally { if (requestGeneration.current === generation) setBusy(false); } }}>{busy ? 'Inspecting…' : 'Inspect plugin'}</Button></div>}
    {preview && <div className="grid gap-3 border-t border-border pt-4"><div><h3 className="font-medium">{preview.plugin.name}{preview.plugin.version ? ` · ${preview.plugin.version}` : ''}</h3><p className="mt-1 text-sm text-muted-foreground">{preview.plugin.description || 'No plugin description'} · Resolved commit {preview.plugin.commit}</p></div>
      {preview.unsupported.length > 0 && <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p className="font-medium">Plugin components not installed</p><p className="mt-1 text-muted-foreground">This is a skills-only import; the plugin remains unavailable as a runnable plugin. Unsupported components: {preview.unsupported.slice(0, 12).join(', ')}{preview.unsupported.length > 12 ? ` and ${preview.unsupported.length - 12} more` : ''}.</p></div>}
      {preview.skills.length ? <fieldset className="grid gap-3"><legend className="mb-2 text-sm font-medium">Choose skills to import</legend>{preview.skills.map(skill => { const detail = details?.skills.find(item => item.path === skill.path); return <label key={skill.path} className="grid gap-2 rounded-md border border-border p-3"><span className="flex items-start gap-2"><Checkbox aria-label={`Select ${skill.name}`} disabled={importing} checked={selected.includes(skill.path)} onCheckedChange={checked => { requestGeneration.current++; setBusy(false); setDetails(null); setSelected(paths => checked === true ? [...paths, skill.path] : paths.filter(path => path !== skill.path)); }} /><span className="min-w-0"><strong className="text-sm">{skill.name}</strong><span className="block text-sm text-muted-foreground">{skill.description}</span><span className="block text-xs text-muted-foreground">{skill.path}{detail?.license ? ` · ${detail.license}` : ''}{detail?.bundleFiles?.length ? ` · ${detail.bundleFiles.length} bundled files` : ''}{detail?.unsupportedDependency ? ` · Cannot import completely: ${detail.unsupportedDependency}` : ''}</span></span></span>{detail?.content !== undefined && <details className="ml-6"><summary className="cursor-pointer text-xs text-muted-foreground">Inspect verified SKILL.md and bundled files · SHA-256 {detail.bundleSha256}</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{detail.content}{detail.bundleFiles?.map(file => `\n${file.path} · ${file.mode} · ${file.bytes} bytes · SHA-256 ${file.sha256}`).join('')}</pre></details>}</label>; })}</fieldset> : <p className="text-sm text-muted-foreground">This plugin contains no supported SKILL.md entries.</p>}
      {selected.length > 0 && <Button type="button" variant="outline" className="w-fit" disabled={busy || importing} onClick={async () => { const generation = ++requestGeneration.current; const requested = [...selected]; setBusy(true); setError(''); try { const result = await workbenchApi.previewCatalogPlugin({ scope, ...(projectId ? { projectId } : {}), catalogUrl, pluginName, selectedPaths: requested }); if (requestGeneration.current !== generation) return; if (result.catalog.commit !== preview.catalog.commit || result.plugin.commit !== preview.plugin.commit) { setPreview(null); setDetails(null); setSelected([]); setError('Catalog or plugin source changed. Inspect the plugin again before selecting skills.'); return; } setDetails(result); } catch (cause) { if (requestGeneration.current === generation) { setDetails(null); setError(errorMessage(cause)); } } finally { if (requestGeneration.current === generation) setBusy(false); } }}>{busy ? 'Loading verified details…' : 'Load selected skill details'}</Button>}
      <p className="text-xs text-muted-foreground">Imported instructions and bundled files remain untrusted source content. Complete regular-file dependencies inside the selected skill folder are stored with the skill within bundle limits. Scripts are not automatically executed and package dependencies are not installed; plugin apps, MCP servers, hooks, agents and commands remain uninstalled and unexecuted. Import does not connect external accounts; allowed-tools metadata does not grant runtime permissions.</p>
      <Button className="w-fit" disabled={busy || importing || selected.length === 0 || !details || details.catalog.commit !== preview.catalog.commit || details.plugin.commit !== preview.plugin.commit || selected.some(path => !details.skills.find(skill => skill.path === path)?.bundleSha256)} onClick={async () => { const generation = ++requestGeneration.current; setBusy(true); setImporting(true); setError(''); try { const result = await workbenchApi.importCatalogSkills({ scope, ...(projectId ? { projectId } : {}), catalogUrl, pluginName, selectedPaths: selected, previewCommit: preview.plugin.commit, previewCatalogCommit: preview.catalog.commit }); if (requestGeneration.current !== generation) return; await refresh(); if (requestGeneration.current === generation) { setSelected([]); setPreview(null); setDetails(null); setCatalog(null); setError(''); setSuccess(`Installed ${result.installed.map(item => item.name).join(', ')} into ${scope} scope.`); } } catch (cause) { if (requestGeneration.current === generation) { if (cause instanceof ApiError && cause.status === 409) { setCatalog(null); setPreview(null); setDetails(null); setSelected([]); } setError(errorMessage(cause)); } } finally { if (requestGeneration.current === generation) { setBusy(false); setImporting(false); } } }}>{busy ? 'Importing atomically…' : `Import ${selected.length} selected skill${selected.length === 1 ? '' : 's'}`}</Button>
      {imported.filter(item => item.data.installed === true).length > 0 && <p role="status" className="text-sm text-muted-foreground">Persisted imports: {imported.filter(item => item.data.installed === true).map(item => `${item.name} (${item.data.enabled === false ? 'disabled' : 'enabled'})`).join(' · ')}. {scope === 'project' ? 'Project skills stay project-scoped; a workspace admin with project access can explicitly copy one to reusable workspace skills before selecting it in a profile.' : 'Select these workspace skills in an Agent profile to include them in later run snapshots.'}</p>}
    </div>}
  </section>;
}

function DeliveryConnectionSettings({ project, snapshot, refresh, setError }: { project: Project; snapshot: Snapshot; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const existing = snapshot.settings.find(item => item.kind === 'connection' && item.projectId === project.id && item.data.provider === 'github' && item.data.purpose === 'delivery' && item.data.url === project.repositoryUrl);
  type Draft = { baseBranch: string; allowMerge: boolean; requiredChecks: string; allowStaging: boolean; selectedTargets: string[] };
  type BoundDraft = { projectId: string; settingId: string; baseVersion: string; baseline: Draft; draft: Draft };
  const readDraft = (setting: Setting | undefined): Draft => ({
    baseBranch: String(setting?.data.baseBranch ?? 'main'),
    allowMerge: setting?.data.allowMergePr === true,
    requiredChecks: Array.isArray(setting?.data.requiredChecks) ? setting.data.requiredChecks.filter((value): value is string => typeof value === 'string').join(', ') : '',
    allowStaging: setting?.data.allowStagingDeploy === true,
    selectedTargets: Array.isArray(setting?.data.stagingTargets) ? setting.data.stagingTargets.filter((value): value is string => typeof value === 'string') : [],
  });
  const sameDraft = (left: Draft, right: Draft) => left.baseBranch === right.baseBranch && left.allowMerge === right.allowMerge && left.requiredChecks === right.requiredChecks && left.allowStaging === right.allowStaging && left.selectedTargets.join('\0') === right.selectedTargets.join('\0');
  const bind = (projectId: string, setting: Setting | undefined): BoundDraft => { const draft = readDraft(setting); return { projectId, settingId: setting?.id ?? '', baseVersion: setting?.updatedAt ?? '', baseline: draft, draft }; };
  const [boundDraft, setBoundDraft] = useState(() => bind(project.id, existing));
  const settingVersion = existing?.updatedAt ?? '';
  useEffect(() => {
    setBoundDraft(current => {
      const dirty = !sameDraft(current.draft, current.baseline);
      if (current.projectId !== project.id) return bind(project.id, existing);
      if (current.settingId !== (existing?.id ?? '') || current.baseVersion !== settingVersion) return dirty ? current : bind(project.id, existing);
      return current;
    });
  }, [project.id, existing?.id, settingVersion]);
  const { draft } = boundDraft;
  const bindingMatches = boundDraft.projectId === project.id && boundDraft.settingId === (existing?.id ?? '');
  const versionMatches = boundDraft.baseVersion === settingVersion;
  const draftIsDirty = !sameDraft(draft, boundDraft.baseline);
  const staleDraft = draftIsDirty && (!bindingMatches || !versionMatches);
  const readyToSave = bindingMatches && versionMatches;
  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => setBoundDraft(current => ({ ...current, draft: { ...current.draft, [key]: value } }));
  const reloadCurrentSettings = () => setBoundDraft(bind(project.id, existing));
  const [busy, setBusy] = useState(false);
  const mergeMethod = 'merge' as const;
  const eligible = snapshot.runtimeProviders.filter(provider => provider.available && provider.projectIds?.includes(project.id));
  const targetConnectorCounts = new Map<string, number>();
  for (const provider of eligible) for (const target of provider.deploymentTargets ?? []) if (provider.deliveryActions?.includes('deploy_staging')) targetConnectorCounts.set(target, (targetConnectorCounts.get(target) ?? 0) + 1);
  const uniqueTargets = [...targetConnectorCounts].filter(([, count]) => count === 1).map(([target]) => target).sort();
  const unavailableTargets = draft.selectedTargets.filter(target => !uniqueTargets.includes(target));
  const mergeChecks = draft.requiredChecks.split(',').map(value => value.trim()).filter(Boolean);
  return <form className="mb-7 grid gap-4 rounded-lg border border-border p-4" onSubmit={async event => {
    event.preventDefault();
    if (!readyToSave || staleDraft) { setError('These settings changed while you were editing. Reload the latest settings before saving.'); return; }
    if (!project.repositoryUrl || !draft.baseBranch.trim()) return;
    setBusy(true); setError('');
    try {
      const submittedDraft: Draft = { ...draft, selectedTargets: [...draft.selectedTargets] };
      const submittedBinding = { projectId: boundDraft.projectId, settingId: boundDraft.settingId, baseVersion: boundDraft.baseVersion };
      const data = { ...(existing?.data ?? {}), provider: 'github', url: project.repositoryUrl, enabled: true, purpose: 'delivery', baseBranch: submittedDraft.baseBranch.trim(), allowDraftPr: true, allowMergePr: submittedDraft.allowMerge, ...(submittedDraft.allowMerge ? { mergeMethod, requiredChecks: submittedDraft.requiredChecks.split(',').map(value => value.trim()).filter(Boolean) } : { requiredChecks: [] }), allowStagingDeploy: submittedDraft.allowStaging && submittedDraft.selectedTargets.length > 0, stagingTargets: submittedDraft.selectedTargets };
      const saved = existing
        ? await workbenchApi.updateSetting(existing.id, { data, expectedUpdatedAt: submittedBinding.baseVersion })
        : await workbenchApi.saveSetting({ kind: 'connection', projectId: project.id, name: 'GitHub delivery', data });
      setBoundDraft(current => current.projectId !== submittedBinding.projectId || current.settingId !== submittedBinding.settingId || current.baseVersion !== submittedBinding.baseVersion
        ? current
        : { ...current, settingId: saved.id, baseVersion: saved.updatedAt, baseline: submittedDraft });
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }}>
    <div><h2 className="font-medium">GitHub delivery</h2><p className="mt-1 text-sm text-muted-foreground">Choose which actions this project allows.</p></div>
    {!bindingMatches && <p role="status" className="text-sm text-muted-foreground">Loading settings for this project…</p>}
    {staleDraft && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><span>These settings changed while you were editing. Your unsaved changes are still here, but saving is paused.</span><Button type="button" variant="outline" size="sm" onClick={reloadCurrentSettings}>Discard draft and load latest</Button></div>}
    <div className="flex flex-wrap items-end gap-3"><div className="grid min-w-48 gap-2"><Label htmlFor="delivery-base-branch">Base branch</Label><Input id="delivery-base-branch" required value={draft.baseBranch} onChange={event => updateDraft('baseBranch', event.target.value)} /></div><label className="flex items-center gap-2 text-sm"><Checkbox aria-label="Allow merge after independent review and required checks" checked={draft.allowMerge} onCheckedChange={checked => updateDraft('allowMerge', checked === true)} />Allow merge after independent review and required checks</label></div>
    {draft.allowMerge && <div className="grid gap-3 sm:grid-cols-2"><div className="grid gap-2"><Label htmlFor="delivery-merge-method">Merge method</Label><NativeSelect id="delivery-merge-method" className="h-9 rounded-md border bg-background px-3 text-sm" value={mergeMethod} disabled><NativeSelectOption value="merge">Merge commit</NativeSelectOption></NativeSelect></div><div className="grid gap-2"><Label htmlFor="delivery-required-checks">Required check names</Label><Input id="delivery-required-checks" required placeholder="Exact GitHub check names, comma separated" value={draft.requiredChecks} onChange={event => updateDraft('requiredChecks', event.target.value)} /></div></div>}
    <section className="grid gap-3 border-t border-border pt-4"><div><h3 className="font-medium">Available staging targets</h3><p className="mt-1 text-sm text-muted-foreground">Choose from recently connected, project-authorized targets.</p></div><label className="flex items-center gap-2 text-sm"><Checkbox id="allow-staging" aria-label="Allow staging deployment actions for selected targets" checked={draft.allowStaging} onCheckedChange={checked => updateDraft('allowStaging', checked === true)} />Allow staging deployment actions for selected targets</label>
      {uniqueTargets.length ? <fieldset className="grid gap-2">{uniqueTargets.map(target => <label key={target} className="flex items-center gap-2 text-sm"><Checkbox id={`staging-target-${target}`} aria-label={`Allow staging target ${target}`} checked={draft.selectedTargets.includes(target)} onCheckedChange={checked => updateDraft('selectedTargets', checked === true ? [...new Set([...draft.selectedTargets, target])] : draft.selectedTargets.filter(value => value !== target))} />{target}</label>)}</fieldset> : <p role="status" className="rounded-md border border-border border-dashed p-3 text-sm text-muted-foreground">No staging targets available</p>}
      {unavailableTargets.map(target => <div key={target} className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{target} · currently unavailable</span><Button type="button" variant="ghost" size="sm" onClick={() => updateDraft('selectedTargets', draft.selectedTargets.filter(value => value !== target))}>Remove</Button></div>)}
      <p className="text-xs text-muted-foreground">Build required before deployment.</p>
    </section>
    <div><Button disabled={busy || !readyToSave || staleDraft || !project.repositoryUrl || !draft.baseBranch.trim() || draft.allowMerge && !mergeChecks.length || draft.allowStaging && !draft.selectedTargets.length}>{busy ? 'Saving…' : existing ? 'Save delivery settings' : 'Enable draft PRs'}</Button></div>
    {!project.repositoryUrl && <p className="text-sm text-muted-foreground">Add a repository to this project before enabling delivery.</p>}
  </form>;
}
function FeedbackIntakeSettings({ project, refresh, setError }: { project: Project; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [enabled, setEnabled] = useState(project.feedbackIntake?.enabled ?? false);
  const [allowExecution, setAllowExecution] = useState(project.feedbackIntake?.allowExecution ?? false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEnabled(project.feedbackIntake?.enabled ?? false); setAllowExecution(project.feedbackIntake?.allowExecution ?? false); }, [project.id, project.feedbackIntake?.enabled, project.feedbackIntake?.allowExecution]);
  const dirty = enabled !== Boolean(project.feedbackIntake?.enabled) || allowExecution !== Boolean(project.feedbackIntake?.allowExecution);
  return <form className="mb-7 grid gap-4 rounded-lg border border-border p-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await workbenchApi.updateProject(project.id, { feedbackIntake: { enabled, allowExecution: enabled && allowExecution } }); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}><div><h2 className="font-semibold">External feedback</h2><p className="mt-1 text-sm text-muted-foreground">Choose whether configured source events can be triaged by Master.</p></div><label className="flex items-start gap-3 text-sm"><Checkbox className="mt-1" aria-label="Enable source feedback intake" checked={enabled} onCheckedChange={checked => setEnabled(checked === true)} /><span><strong>Enable source feedback intake</strong><span className="block text-muted-foreground">Master can read the external report, link related Work, and ask for clarification.</span></span></label>{enabled && <label className="flex items-start gap-3 border-l-2 border-border pl-4 text-sm"><Checkbox className="mt-1" aria-label="Allow execution delegation" checked={allowExecution} onCheckedChange={checked => setAllowExecution(checked === true)} /><span><strong>Allow execution delegation</strong><span className="block text-muted-foreground">When enabled, incoming feedback may start bounded implementation work. Off by default.</span></span></label>}<div><Button disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save feedback settings'}</Button></div></form>;
}

function ProfileSkillsEditor({ allSettings, skillIds, setSkillIds, refresh, setError, idPrefix, projectId }: { allSettings: Setting[]; skillIds: string[]; setSkillIds: React.Dispatch<React.SetStateAction<string[]>>; refresh: () => Promise<void>; setError: (value: string) => void; idPrefix: string; projectId?: string }) {
  const [adding, setAdding] = useState(false); const [skillName, setSkillName] = useState(''); const [skillContent, setSkillContent] = useState(''); const [saving, setSaving] = useState(false);
  const globalSkills = allSettings.filter(setting => setting.kind === 'skill' && (!setting.projectId || setting.projectId === projectId));
  const scopedSkills = skillIds.map(id => ({ id, setting: allSettings.find(setting => setting.id === id) })).filter(({ setting }) => !setting || setting.kind !== 'skill' || Boolean(setting.projectId && setting.projectId !== projectId));
  async function createReusableSkill() { if (!skillName.trim() || !skillContent.trim()) return; setSaving(true); setError(''); try { const created = await workbenchApi.saveSetting({ kind: 'skill', name: skillName.trim(), data: { content: skillContent.trim() } }); setSkillIds(ids => ids.includes(created.id) ? ids : [...ids, created.id]); setSkillName(''); setSkillContent(''); setAdding(false); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); } }
  return <div className="grid gap-2 md:col-span-2"><Label htmlFor={`${idPrefix}-skills`}>Reusable skills</Label>{globalSkills.length > 0 ? <NativeSelect id={`${idPrefix}-skills`} multiple className="min-h-20 rounded-md border bg-background px-2 py-1 text-sm" value={skillIds.filter(id => globalSkills.some(skill => skill.id === id))} onChange={event => { const selected = Array.from(event.target.selectedOptions, option => option.value); setSkillIds([...scopedSkills.map(({ id }) => id), ...selected]); }} aria-describedby={`${idPrefix}-skills-hint`}>{globalSkills.map(skill => <NativeSelectOption key={skill.id} value={skill.id}>{skill.name}{skill.projectId ? ' · Project' : ' · Workspace'}</NativeSelectOption>)}</NativeSelect> : <p id={`${idPrefix}-skills-hint`} className="text-sm text-muted-foreground">No reusable skills yet. Skills created within a project stay project-only and cannot be selected by workspace profiles.</p>}{globalSkills.length > 0 && <p id={`${idPrefix}-skills-hint`} className="text-xs text-muted-foreground">Choose skills available to this profile’s scope.</p>}{scopedSkills.length > 0 && <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p className="text-amber-900 dark:text-amber-200">This profile has skills from another scope or skills that are unavailable. Remove them before saving.</p>{scopedSkills.map(({ id, setting }) => <div key={id} className="flex items-center justify-between gap-3"><span>{setting?.name ?? 'Unavailable skill'}</span><Button type="button" size="sm" variant="outline" onClick={() => setSkillIds(ids => ids.filter(skillId => skillId !== id))}>Remove from profile</Button></div>)}</div>}{adding ? <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3"><div className="grid gap-2"><Label htmlFor={`${idPrefix}-new-skill-name`}>Skill name</Label><Input id={`${idPrefix}-new-skill-name`} value={skillName} onChange={event => setSkillName(event.target.value)} placeholder="e.g. Accessibility review" /></div><div className="grid gap-2"><Label htmlFor={`${idPrefix}-new-skill-content`}>Skill instructions</Label><Textarea id={`${idPrefix}-new-skill-content`} value={skillContent} onChange={event => setSkillContent(event.target.value)} placeholder="What reusable guidance should this skill provide?" /></div><div className="flex gap-2"><Button type="button" disabled={saving || !skillName.trim() || !skillContent.trim()} onClick={() => void createReusableSkill()}>{saving ? 'Saving…' : 'Create reusable skill'}</Button><Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div></div> : <div><Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>Add or create skill</Button></div>}</div>;
}

function SettingRow({ item, allSettings, availableModels, canEdit, canCopyToWorkspace = false, refresh, setError }: { item: Setting; allSettings: Setting[]; availableModels: string[]; canEdit: boolean; canCopyToWorkspace?: boolean; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [editing, setEditing] = useState(false); const [copying, setCopying] = useState(false); const [copied, setCopied] = useState(false); const [enabled, setEnabled] = useState(item.data.enabled !== false); const [name, setName] = useState(item.name); const [content, setContent] = useState(String(item.data.content ?? '')); const [model, setModel] = useState(String(item.data.model ?? 'gpt-6-luna')); const [reasoning, setReasoning] = useState(String(item.data.reasoning ?? 'medium')); const [skillIds, setSkillIds] = useState(Array.isArray(item.data.skillIds) ? item.data.skillIds.filter((id): id is string => typeof id === 'string') : []); const [connectionProvider, setConnectionProvider] = useState(String(item.data.provider ?? 'github')); const [connectionUrl, setConnectionUrl] = useState(String(item.data.url ?? '')); const [connectionBaseBranch, setConnectionBaseBranch] = useState(String(item.data.baseBranch ?? 'main'));
  const detail = item.kind === 'skill' ? `${String(item.data.content ?? '')}${item.data.provenance ? `\n\nSource: ${String(item.data.sourceUrl)}\nRequested ref: ${String(item.data.requestedRef)}\nResolved commit: ${String(item.data.resolvedSha)}\nContent SHA-256: ${String(item.data.contentSha256)}\nCatalog: ${String(item.data.catalogUrl)} @ ${String(item.data.catalogResolvedSha)}` : ''}${item.data.copiedFrom ? `\n\nCopied from project skill ${String((item.data.copiedFrom as Record<string, unknown>).settingId)} in project ${String((item.data.copiedFrom as Record<string, unknown>).projectId)}\nOriginal source: ${String((item.data.copiedFrom as Record<string, unknown>).sourceUrl ?? (item.data.copiedFrom as Record<string, unknown>).provenance ?? 'Project skill') }\nRequested ref: ${String((item.data.copiedFrom as Record<string, unknown>).requestedRef ?? 'Not recorded')}\nResolved commit: ${String((item.data.copiedFrom as Record<string, unknown>).resolvedSha ?? 'Not recorded')}\nSource path: ${String((item.data.copiedFrom as Record<string, unknown>).sourcePath ?? 'Not recorded')}\nCatalog: ${String((item.data.copiedFrom as Record<string, unknown>).catalogUrl ?? 'Not recorded')} @ ${String((item.data.copiedFrom as Record<string, unknown>).catalogResolvedSha ?? 'Not recorded')}\nOriginal content SHA-256: ${String((item.data.copiedFrom as Record<string, unknown>).contentSha256 ?? 'Not recorded')}` : ''}` : item.kind === 'profile' ? `${String(item.data.model ?? '')} · ${String(item.data.reasoning ?? '')} reasoning` : item.kind === 'provider' ? `${String(item.data.provider ?? 'Provider')} · ${String(item.data.method ?? 'metadata only')}` : `${String(item.data.provider ?? 'Connection')} · ${String(item.data.url ?? '')}${item.data.purpose === 'delivery' ? ` · Draft PR to ${String(item.data.baseBranch ?? 'unknown')}` : ''}`;
  return <details className="border-border p-4"><summary className="flex items-center justify-between gap-4 text-sm font-medium"><span>{item.name}</span><Badge variant="outline">{item.kind === 'skill' && item.data.installed === true ? `Installed · ${item.data.enabled === false ? 'Disabled' : 'Enabled'}` : item.kind}</Badge></summary>{editing ? <div className="mt-3 grid gap-3"><div className="grid gap-2"><Label htmlFor={`setting-name-${item.id}`}>Name</Label><Input id={`setting-name-${item.id}`} value={name} onChange={event => setName(event.target.value)} /></div>{item.kind === 'skill' && <><div className="grid gap-2"><Label htmlFor={`setting-content-${item.id}`}>Instructions</Label><Textarea id={`setting-content-${item.id}`} value={content} onChange={event => setContent(event.target.value)} /></div><label className="flex items-center gap-2 text-sm"><Checkbox aria-label="Enabled for new runs" checked={enabled} onCheckedChange={checked => setEnabled(checked === true)} />Enabled for new runs</label></>}{item.kind === 'profile' && <div className="grid gap-3"><div className="flex flex-wrap gap-3"><div className="grid gap-2"><Label htmlFor={`setting-model-${item.id}`}>Model</Label><NativeSelect id={`setting-model-${item.id}`} value={model} onChange={event => setModel(event.target.value)}><NativeSelectOption value="">Choose a model reported by an available connection</NativeSelectOption>{!availableModels.includes(model) && <NativeSelectOption value={model} disabled>{model} · not reported by any available provider connection</NativeSelectOption>}{availableModels.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></div><div className="grid gap-2"><Label htmlFor={`setting-reasoning-${item.id}`}>Reasoning</Label><NativeSelect id={`setting-reasoning-${item.id}`} value={reasoning} onChange={event => setReasoning(event.target.value)}>{['low', 'medium', 'high', 'xhigh'].map(value => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></div></div><ProfileSkillsEditor idPrefix={`setting-${item.id}`} projectId={item.projectId} allSettings={allSettings} skillIds={skillIds} setSkillIds={setSkillIds} refresh={refresh} setError={setError} /></div>}{item.kind === 'connection' && <div className="flex flex-wrap gap-3"><div className="grid gap-2"><Label htmlFor={`connection-provider-${item.id}`}>Source</Label><NativeSelect id={`connection-provider-${item.id}`} className="h-9 rounded-md border bg-background px-3 text-sm" value={connectionProvider} onChange={event => setConnectionProvider(event.target.value)}><NativeSelectOption value="github">GitHub</NativeSelectOption><NativeSelectOption value="slack">Slack</NativeSelectOption></NativeSelect></div><div className="grid min-w-64 flex-1 gap-2"><Label htmlFor={`connection-url-${item.id}`}>Repository or channel URL</Label><Input id={`connection-url-${item.id}`} type="url" value={connectionUrl} onChange={event => setConnectionUrl(event.target.value)} /></div>{item.data.purpose === 'delivery' && <div className="grid gap-2"><Label htmlFor={`connection-base-${item.id}`}>Base branch</Label><Input id={`connection-base-${item.id}`} value={connectionBaseBranch} onChange={event => setConnectionBaseBranch(event.target.value)} /></div>}</div>}<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => { setName(item.name); setContent(String(item.data.content ?? '')); setEnabled(item.data.enabled !== false); setModel(String(item.data.model ?? 'gpt-6-luna')); setReasoning(String(item.data.reasoning ?? 'medium')); setSkillIds(Array.isArray(item.data.skillIds) ? item.data.skillIds.filter((id): id is string => typeof id === 'string') : []); setConnectionProvider(String(item.data.provider ?? 'github')); setConnectionUrl(String(item.data.url ?? '')); setConnectionBaseBranch(String(item.data.baseBranch ?? 'main')); setEditing(false); }}>Cancel</Button><Button size="sm" disabled={item.kind === 'profile' && ((!availableModels.includes(model) && model !== String(item.data.model ?? '')) || skillIds.some(id => { const skill = allSettings.find(setting => setting.id === id); return !skill || skill.kind !== 'skill' || Boolean(skill.projectId); }))} onClick={async () => { try { const data = item.kind === 'skill' ? { content, enabled } : item.kind === 'profile' ? { model, reasoning, skillIds } : item.kind === 'connection' ? { ...item.data, provider: connectionProvider, url: connectionUrl, enabled: item.data.enabled !== false, ...(item.data.purpose === 'delivery' ? { baseBranch: connectionBaseBranch } : {}) } : item.data; await workbenchApi.updateSetting(item.id, { name, data, expectedUpdatedAt: item.updatedAt }); setEditing(false); await refresh(); } catch (cause) { setError(errorMessage(cause)); } }}>Save</Button></div></div> : <><p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{detail || 'No details recorded.'}</p>{canCopyToWorkspace && item.kind === 'skill' && item.projectId && <div className="mt-3 flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={copying || copied} onClick={async () => { setCopying(true); try { await workbenchApi.copyProjectSkill(item.id); setCopied(true); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setCopying(false); } }}>{copying ? 'Copying…' : copied ? 'Copied to reusable skill' : 'Copy to reusable skill'}</Button>{copied && <span role="status" className="text-xs text-muted-foreground">Copied as a new workspace skill. Select it in a workspace Agent profile.</span>}</div>}{canEdit && ['skill', 'profile', 'connection'].includes(item.kind) && <Button className="mt-3" variant="outline" size="sm" onClick={() => { setConnectionBaseBranch(String(item.data.baseBranch ?? 'main')); setEnabled(item.data.enabled !== false); setEditing(true); }}>Edit</Button>}</>}</details>;
}

function ProjectSettingsNav({ project, active }: { project: Project; active: View }) {
  const tabs: Array<[View, string]> = [['instructions', 'Instructions'], ['skills', 'Skills'], ['members', 'Members'], ['connections', 'Connections']];
  return <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border" aria-label="Project settings">{tabs.map(([view, label]) => <a key={view} aria-current={view === active ? 'page' : undefined} className={`shrink-0 border-b-2 px-3 py-3 text-sm no-underline ${active === view ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} href={href(view, project.id)}>{label}</a>)}</nav>;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Try again.'; }

export default App;
