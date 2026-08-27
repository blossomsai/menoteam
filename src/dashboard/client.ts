import type { Teammate, Work } from '../domain/model.js';
import {
  buildWorkViewModel,
  escapeHtml,
  renderLivingDocMarkdown,
  type DashboardSnapshot,
  type DashboardTeammate,
  type DashboardWork,
  type OwnerEvidence,
  type WorkViewFilters,
  type WorkViewRow,
} from './dashboard.js';

interface DashboardApi {
  login(password: string, signal?: AbortSignal): Promise<void>;
  logout(signal?: AbortSignal): Promise<void>;
  loadSnapshot(signal?: AbortSignal): Promise<DashboardSnapshot>;
  readWork(ref: string, signal?: AbortSignal): Promise<Work>;
  readTeammate(ref: string, signal?: AbortSignal): Promise<Teammate>;
}

class DashboardAuthError extends Error {
  constructor() {
    super('Dashboard authentication is required.');
    this.name = 'DashboardAuthError';
  }
}

interface ListPage<T> {
  items: T[];
  next_cursor: string | null;
  total_count: number;
}

export interface DashboardClientOptions {
  api?: DashboardApi;
  refreshIntervalMs?: number | false;
}

interface DashboardState {
  snapshot: DashboardSnapshot | null;
  authenticated: boolean;
  view: 'work' | 'team';
  filters: WorkViewFilters;
  query: string;
  loading: boolean;
  error: string | null;
  authError: string | null;
  logoutStatus: 'idle' | 'pending' | 'failed';
  selectedRef: string | null;
  selectedKind: 'work' | 'teammate' | null;
  previousFocus: HTMLElement | null;
  drawerLoading: boolean;
  drawerError: string | null;
  drawerEntity: Work | Teammate | null;
}

export function shouldRefreshDashboard(input: {
  authenticated: boolean;
  loading: boolean;
  selectedRef: string | null;
  visibilityState: DocumentVisibilityState;
  editingFilter: boolean;
}): boolean {
  return input.authenticated
    && !input.loading
    && !input.selectedRef
    && input.visibilityState !== 'hidden'
    && !input.editingFilter;
}

export function dashboardRequestIsCurrent(input: {
  requestGeneration: number;
  currentGeneration: number;
  authenticated: boolean;
  expectedSelectedRef?: string;
  selectedRef?: string | null;
}): boolean {
  return input.authenticated
    && input.requestGeneration === input.currentGeneration
    && (input.expectedSelectedRef === undefined || input.selectedRef === input.expectedSelectedRef);
}

const initialState = (): DashboardState => ({
  snapshot: null,
  authenticated: false,
  view: 'work',
  filters: { query: '', state: 'all', owner: '', includeCompleted: false },
  query: '',
  loading: true,
  error: null,
  authError: null,
  logoutStatus: 'idle',
  selectedRef: null,
  selectedKind: null,
  previousFocus: null,
  drawerLoading: false,
  drawerError: null,
  drawerEntity: null,
});

export function mountDashboard(root: HTMLElement, options: DashboardClientOptions = {}): void {
  const state = initialState();
  state.authenticated = Boolean(options.api);
  const api = options.api ?? createFetchDashboardApi();
  let snapshotAbortController = new AbortController();
  let detailAbortController = new AbortController();
  let authAbortController = new AbortController();
  let snapshotGeneration = 0;
  let detailGeneration = 0;
  let authGeneration = 0;

  const render = (): void => {
    root.innerHTML = renderApp(state);
    bindInteractions();
  };

  const invalidateRequests = (): void => {
    snapshotGeneration += 1;
    detailGeneration += 1;
    authGeneration += 1;
    snapshotAbortController.abort();
    detailAbortController.abort();
    authAbortController.abort();
    snapshotAbortController = new AbortController();
    detailAbortController = new AbortController();
    authAbortController = new AbortController();
  };

  const dismissDrawerElement = (): void => {
    const drawer = document.querySelector<HTMLDialogElement>('#detail-drawer');
    if (drawer?.open && typeof drawer.close === 'function') drawer.close();
    drawer?.removeAttribute('open');
  };

  const clearSessionState = (authError: string | null): void => {
    dismissDrawerElement();
    state.authenticated = false;
    state.snapshot = null;
    state.loading = false;
    state.selectedRef = null;
    state.selectedKind = null;
    state.previousFocus = null;
    state.drawerLoading = false;
    state.drawerError = null;
    state.drawerEntity = null;
    state.authError = authError;
    state.error = null;
  };

  const expireSession = (): void => {
    invalidateRequests();
    clearSessionState('Your dashboard session expired. Unlock it again to continue.');
    state.logoutStatus = 'idle';
    render();
  };

  const lockDashboard = (): void => {
    invalidateRequests();
    const generation = authGeneration;
    const controller = authAbortController;
    clearSessionState(null);
    state.logoutStatus = 'pending';
    render();
    void api.logout(controller.signal).then(() => {
      if (generation !== authGeneration) return;
      state.logoutStatus = 'idle';
      state.authError = null;
      render();
    }).catch((error) => {
      if (generation !== authGeneration) return;
      state.logoutStatus = 'failed';
      state.authError = error instanceof Error
        ? `Local dashboard data was cleared, but the signed session cookie could not be invalidated: ${error.message}`
        : 'Local dashboard data was cleared, but the signed session cookie could not be invalidated.';
      render();
    });
  };

  const load = async (background = false): Promise<void> => {
    if (!state.authenticated) return;
    const activeElement = document.activeElement;
    if (background && !shouldRefreshDashboard({
      authenticated: state.authenticated,
      loading: state.loading,
      selectedRef: state.selectedRef,
      visibilityState: document.visibilityState,
      editingFilter: activeElement instanceof HTMLInputElement || activeElement instanceof HTMLSelectElement,
    })) return;
    const generation = ++snapshotGeneration;
    snapshotAbortController.abort();
    const controller = new AbortController();
    snapshotAbortController = controller;
    state.loading = true;
    state.error = null;
    if (!background || !state.snapshot) render();
    try {
      const snapshot = await api.loadSnapshot(controller.signal);
      if (!dashboardRequestIsCurrent({ requestGeneration: generation, currentGeneration: snapshotGeneration, authenticated: state.authenticated })) return;
      state.snapshot = snapshot;
    } catch (error) {
      if (!dashboardRequestIsCurrent({ requestGeneration: generation, currentGeneration: snapshotGeneration, authenticated: state.authenticated })) return;
      if ((error as { name?: string }).name === 'AbortError') return;
      if (error instanceof DashboardAuthError) {
        expireSession();
        return;
      }
      state.error = error instanceof Error ? error.message : 'The Work Map could not be loaded.';
    } finally {
      if (!dashboardRequestIsCurrent({ requestGeneration: generation, currentGeneration: snapshotGeneration, authenticated: state.authenticated })) return;
      state.loading = false;
      render();
    }
  };

  const openDrawer = async (kind: 'work' | 'teammate', ref: string, trigger: HTMLElement): Promise<void> => {
    const generation = ++detailGeneration;
    detailAbortController.abort();
    const controller = new AbortController();
    detailAbortController = controller;
    state.selectedKind = kind;
    state.selectedRef = ref;
    state.previousFocus = trigger;
    state.drawerLoading = true;
    state.drawerError = null;
    state.drawerEntity = null;
    render();
    const drawer = document.querySelector<HTMLDialogElement>('#detail-drawer');
    if (drawer) {
      if (typeof drawer.showModal === 'function' && !drawer.open) drawer.showModal();
      else drawer.setAttribute('open', '');
      drawer.querySelector<HTMLElement>('[data-drawer-close]')?.focus();
    }
    try {
      if (kind === 'work') {
        const detail = await api.readWork(ref, controller.signal);
        if (!dashboardRequestIsCurrent({ requestGeneration: generation, currentGeneration: detailGeneration, authenticated: state.authenticated, expectedSelectedRef: ref, selectedRef: state.selectedRef })) return;
        const summary = state.snapshot?.works.find((work) => work.ref === ref);
        const owner = state.snapshot?.teammates.find((teammate) => teammate.ref === detail.owner);
        state.drawerEntity = {
          ...(summary ?? {}),
          ...detail,
          ...(owner ? { owner_display_name: owner.display_name } : {}),
        };
      } else {
        const detail = await api.readTeammate(ref, controller.signal);
        if (!dashboardRequestIsCurrent({ requestGeneration: generation, currentGeneration: detailGeneration, authenticated: state.authenticated, expectedSelectedRef: ref, selectedRef: state.selectedRef })) return;
        state.drawerEntity = detail;
      }
    } catch (error) {
      if (!dashboardRequestIsCurrent({ requestGeneration: generation, currentGeneration: detailGeneration, authenticated: state.authenticated, expectedSelectedRef: ref, selectedRef: state.selectedRef })) return;
      if ((error as { name?: string }).name !== 'AbortError') {
        if (error instanceof DashboardAuthError) {
          expireSession();
        } else {
          state.drawerError = error instanceof Error ? error.message : 'This detail could not be loaded.';
        }
      }
    } finally {
      if (!dashboardRequestIsCurrent({ requestGeneration: generation, currentGeneration: detailGeneration, authenticated: state.authenticated, expectedSelectedRef: ref, selectedRef: state.selectedRef })) return;
      state.drawerLoading = false;
      render();
      const nextDrawer = document.querySelector<HTMLDialogElement>('#detail-drawer');
      if (state.authenticated && nextDrawer && typeof nextDrawer.showModal === 'function' && !nextDrawer.open) nextDrawer.showModal();
      nextDrawer?.querySelector<HTMLElement>('[data-drawer-close]')?.focus();
    }
  };

  const closeDrawer = (): void => {
    detailGeneration += 1;
    detailAbortController.abort();
    const drawer = document.querySelector<HTMLDialogElement>('#detail-drawer');
    if (drawer?.open && typeof drawer.close === 'function') drawer.close();
    drawer?.removeAttribute('open');
    const focusTarget = state.previousFocus;
    const focusSelector = state.selectedKind && state.selectedRef
      ? `[data-open-${state.selectedKind}="${CSS.escape(state.selectedRef)}"]`
      : null;
    state.selectedKind = null;
    state.selectedRef = null;
    state.drawerEntity = null;
    state.drawerError = null;
    state.drawerLoading = false;
    state.previousFocus = null;
    render();
    (focusSelector ? root.querySelector<HTMLElement>(focusSelector) : null)?.focus();
    if (document.activeElement === document.body) focusTarget?.focus();
  };

  const bindInteractions = (): void => {
    root.querySelector<HTMLFormElement>('[data-auth-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = root.querySelector<HTMLInputElement>('[data-auth-password]');
      if (!input?.value) {
        state.authError = 'Enter the dashboard password to continue.';
        render();
        root.querySelector<HTMLInputElement>('[data-auth-password]')?.focus();
        return;
      }
      const generation = ++authGeneration;
      authAbortController.abort();
      const controller = new AbortController();
      authAbortController = controller;
      const login = api.login(input.value, controller.signal);
      input.value = '';
      void login.then(() => {
        if (generation !== authGeneration) return;
        state.authenticated = true;
        state.authError = null;
        state.logoutStatus = 'idle';
        void load();
      }).catch((error) => {
        if (generation !== authGeneration) return;
        state.authError = error instanceof DashboardAuthError
          ? 'That password was not accepted. Try again.'
          : error instanceof Error ? error.message : 'The dashboard could not be unlocked.';
        render();
        root.querySelector<HTMLInputElement>('[data-auth-password]')?.focus();
      });
    });
    root.querySelector<HTMLButtonElement>('[data-logout]')?.addEventListener('click', lockDashboard);
    root.querySelector<HTMLButtonElement>('[data-retry-logout]')?.addEventListener('click', lockDashboard);
    root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => {
        state.view = button.dataset.view === 'team' ? 'team' : 'work';
        render();
      });
    });
    root.querySelector<HTMLInputElement>('[data-search]')?.addEventListener('input', (event) => {
      state.query = (event.target as HTMLInputElement).value;
      state.filters = { ...state.filters, query: state.query };
      render();
      const input = root.querySelector<HTMLInputElement>('[data-search]');
      if (input) {
        input.focus();
        input.setSelectionRange(state.query.length, state.query.length);
      }
    });
    root.querySelector<HTMLSelectElement>('[data-state-filter]')?.addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value;
      state.filters = { ...state.filters, state: value === 'current' || value === 'completed' ? value : 'all' };
      render();
    });
    root.querySelector<HTMLSelectElement>('[data-owner-filter]')?.addEventListener('change', (event) => {
      state.filters = { ...state.filters, owner: (event.target as HTMLSelectElement).value };
      render();
    });
    root.querySelector<HTMLInputElement>('[data-include-completed]')?.addEventListener('change', (event) => {
      state.filters = { ...state.filters, includeCompleted: (event.target as HTMLInputElement).checked };
      render();
    });
    root.querySelectorAll<HTMLElement>('[data-open-work], [data-open-teammate]').forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        if (trigger instanceof HTMLAnchorElement) event.preventDefault();
        const kind = trigger.dataset.openWork ? 'work' : 'teammate';
        const ref = trigger.dataset.openWork ?? trigger.dataset.openTeammate;
        if (ref) void openDrawer(kind, ref, trigger);
      });
      trigger.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          trigger.click();
        }
      });
    });
    root.querySelector<HTMLElement>('[data-drawer-close]')?.addEventListener('click', closeDrawer);
    root.querySelector<HTMLDialogElement>('#detail-drawer')?.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDrawer();
    });
    root.querySelector<HTMLDialogElement>('#detail-drawer')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeDrawer();
    });
    root.querySelector<HTMLElement>('[data-retry]')?.addEventListener('click', () => void load());
  };

  render();
  if (state.authenticated) void load();
  const refreshIntervalMs = options.refreshIntervalMs === false ? 0 : options.refreshIntervalMs ?? 15_000;
  if (refreshIntervalMs > 0) {
    window.setInterval(() => void load(true), refreshIntervalMs);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void load(true);
    });
  }
}

export function renderApp(state: DashboardState): string {
  const body = !state.authenticated
    ? renderUnlock(state)
    : state.loading && !state.snapshot
    ? `<main id="main-content" class="workspace"><div class="loading-message"><strong>Loading Work Map</strong><span>Reading the team's current context…</span></div></main>`
    : state.error && !state.snapshot
      ? `<main id="main-content" class="workspace"><div class="error-message" role="alert"><strong>Work Map unavailable</strong><span>${escapeHtml(state.error)}</span><button class="close-drawer" type="button" data-retry>Try again</button></div></main>`
      : `<main id="main-content" class="workspace">${renderToolbar(state)}${state.view === 'work' ? renderWorkView(state) : renderTeamView(state)}</main>`;
  const tabs = state.authenticated ? `<div class="view-tabs" role="tablist" aria-label="Dashboard view"><button class="view-tab" type="button" role="tab" aria-selected="${state.view === 'work'}" data-view="work">Work View</button><button class="view-tab" type="button" role="tab" aria-selected="${state.view === 'team'}" data-view="team">Team View</button></div>` : '';
  const lockButton = state.authenticated ? '<button class="logout-button" type="button" data-logout>Lock dashboard</button>' : '';
  const drawer = state.authenticated ? renderDrawer(state) : '';
  return `<header class="app-header"><div class="header-inner"><div><div class="wordmark">Menoteam · Work Map</div><div class="product-note">A shared surface for durable work and teammate context.</div></div>${tabs}${lockButton}<div class="read-only-note">Read-only · corrections happen through a teammate agent</div></div></header>${body}${drawer}`;
}

function renderUnlock(state: DashboardState): string {
  const authForm = `<form data-auth-form><label class="field-label">Dashboard password<input class="text-input" data-auth-password type="password" autocomplete="current-password" required></label><button class="unlock-button" type="submit">Unlock Work Map</button></form>`;
  const lockStatus = state.logoutStatus === 'pending'
    ? '<p role="status">Local dashboard data is cleared. Finishing server-side lock…</p><button class="unlock-button" type="button" data-retry-logout>Retry lock</button>'
    : state.logoutStatus === 'failed'
      ? `<p class="error-message" role="alert">${escapeHtml(state.authError ?? 'The signed session cookie may still be valid.')}</p><button class="unlock-button" type="button" data-retry-logout>Retry lock</button>`
      : `${authForm}${state.authError ? `<p class="error-message" role="alert">${escapeHtml(state.authError)}</p>` : ''}`;
  return `<main id="main-content" class="workspace"><section class="auth-panel" aria-labelledby="unlock-title"><h1 id="unlock-title">Unlock Work Map</h1><p>Use the separate dashboard password to read this team's durable context. The server returns a signed HttpOnly session cookie; the password is never persisted in browser JavaScript, storage, URLs, cookies, or page source.</p>${lockStatus}</section></main>`;
}

function renderToolbar(state: DashboardState): string {
  const snapshot = state.snapshot;
  if (!snapshot) return '';
  const ownerOptions = snapshot.teammates.map((teammate) => `<option value="${escapeHtml(teammate.ref)}" ${state.filters.owner === teammate.ref ? 'selected' : ''}>${escapeHtml(teammate.display_name)}</option>`).join('');
  const model = buildWorkViewModel(snapshot, state.filters);
  const count = state.view === 'work' ? `${model.matchedCount} matching Work` : `${filteredTeammates(snapshot.teammates, state.query).length} teammates`;
  return `<section class="toolbar" aria-label="Dashboard filters"><label class="field-label">Search Work and teammates<input class="text-input" type="search" data-search value="${escapeHtml(state.query)}" placeholder="Search titles, summaries, people, refs" autocomplete="off"></label>${state.view === 'work' ? `<label class="field-label">State<select class="select" data-state-filter><option value="all" ${state.filters.state === 'all' ? 'selected' : ''}>Current + completed</option><option value="current" ${state.filters.state === 'current' ? 'selected' : ''}>Current only</option><option value="completed" ${state.filters.state === 'completed' ? 'selected' : ''}>Completed only</option></select></label><label class="field-label">Owner<select class="select" data-owner-filter><option value="">All owners</option>${ownerOptions}</select></label><label class="toolbar-count"><input type="checkbox" data-include-completed ${state.filters.includeCompleted ? 'checked' : ''}> Show completed in the main view</label>` : ''}<div class="toolbar-count" aria-live="polite">${escapeHtml(count)}</div>${state.error ? `<p class="error-message" role="alert">${escapeHtml(state.error)}</p>` : ''}</section>`;
}

function renderWorkView(state: DashboardState): string {
  const snapshot = state.snapshot;
  if (!snapshot) return '';
  const model = buildWorkViewModel(snapshot, state.filters);
  if (!model.matchedCount) return `<section class="empty-message" aria-live="polite"><strong>No Work matches this view</strong><span>Try a different search or clear the filters. Completed Work remains durable and searchable.</span></section>`;
  return `<section class="view-columns" aria-label="Work Map"><div class="panel"><div class="panel-heading"><h2>Relationships</h2><small>${model.currentCount} current · ${model.completedCount} completed</small></div><div class="graph-map" role="region" aria-label="Work hierarchy and dependency map" tabindex="0"><ul class="graph-list" role="tree">${model.nodes.map((row) => renderGraphNode(row, model.nodes)).join('')}</ul>${renderCompletedDisclosure(model.completedRows, 'graph')}</div></div><div class="panel"><div class="panel-heading"><h2>All Work</h2><small>Dense list · same facts as the map</small></div><div class="work-table-wrap" tabindex="0" aria-label="Scrollable Work list"><table class="work-table"><caption class="sr-only">Work nodes with owner, state, relationships, and revision time</caption><thead><tr><th scope="col">Work</th><th scope="col">Owner</th><th scope="col">State</th><th scope="col">Relationships</th><th scope="col">Updated</th></tr></thead><tbody>${model.rows.map(renderWorkRow).join('')}</tbody></table></div><p class="overflow-note">On narrow screens, scroll the Work list horizontally to inspect every field.</p>${renderCompletedDisclosure(model.completedRows, 'list')}</div></section>`;
}

export function renderGraphNode(row: WorkViewRow, visibleRows: WorkViewRow[]): string {
  const depth = depthFor(row, visibleRows);
  const dependencyText = row.dependencies.length
    ? `<div class="dependency-note" style="--depth:${depth}" aria-label="Dependencies"><span class="dependency-label">Depends on</span>${row.dependencies.map((item) => `<button class="relation-label" type="button" data-open-work="${escapeHtml(item.ref)}" aria-label="Open dependency: ${escapeHtml(item.title)}">${escapeHtml(item.title)}</button>`).join('')}</div>`
    : '';
  return `<li class="graph-item" style="--depth:${depth}" data-depth="${Math.min(depth, 3)}" role="treeitem" aria-level="${depth + 1}"><button class="graph-node" type="button" data-open-work="${escapeHtml(row.ref)}"><span class="node-title">${escapeHtml(row.title)}</span><span class="node-meta">${escapeHtml(row.ownerName)} · <span class="state-label" data-state="${row.state}">${row.state === 'current' ? 'Current' : 'Completed'}</span>${renderOwnerLabel(row)}</span></button>${dependencyText}</li>`;
}

function renderWorkRow(row: WorkViewRow): string {
  const relationships = [
    row.parent ? `<button class="relation-label" type="button" data-open-work="${escapeHtml(row.parent.ref)}" aria-label="Open parent: ${escapeHtml(row.parent.title)}">Parent: ${escapeHtml(row.parent.title)}</button>` : '',
    ...row.dependencies.map((item) => `<button class="relation-label" type="button" data-open-work="${escapeHtml(item.ref)}" aria-label="Open dependency: ${escapeHtml(item.title)}">Depends on: ${escapeHtml(item.title)}</button>`),
  ].filter(Boolean).join('');
  return `<tr><td><button class="work-row" type="button" data-open-work="${escapeHtml(row.ref)}"><span class="work-link">${escapeHtml(row.title)}</span><span class="work-meta">${escapeHtml(row.summary)}</span></button></td><td><span>${escapeHtml(row.ownerName)}</span>${renderOwnerLabel(row)}</td><td><span class="state-label" data-state="${row.state}">${row.state === 'current' ? 'Current' : 'Completed'}</span></td><td>${relationships || '<span class="work-meta">No parent or dependencies</span>'}</td><td><span class="revision">r${row.revision} · ${formatDate(row.updatedAt)}</span></td></tr>`;
}

function renderCompletedDisclosure(rows: WorkViewRow[], location: 'graph' | 'list'): string {
  if (!rows.length) return '';
  const content = location === 'graph'
    ? `<ul class="graph-list">${rows.map((row) => renderGraphNode(row, rows)).join('')}</ul>`
    : `<div class="work-table-wrap"><table class="work-table"><caption class="sr-only">Completed Work</caption><tbody>${rows.map(renderWorkRow).join('')}</tbody></table></div>`;
  return `<details class="completed-disclosure"><summary>Completed Work (${rows.length}) · collapsed by default</summary>${content}</details>`;
}

function renderOwnerLabel(row: WorkViewRow): string {
  if (row.ownerSource === 'confirmed') return '';
  const evidence = row.ownerEvidence.length ? `<ul class="evidence">${row.ownerEvidence.map((item) => `<li>${escapeHtml(evidenceLabel(item))}</li>`).join('')}</ul>` : '';
  return `<span class="inferred-label">${row.ownerSource === 'inferred' ? 'Inferred owner' : 'Owner unresolved'}</span>${evidence}`;
}

function evidenceLabel(evidence: OwnerEvidence): string {
  return evidence.ref ? `${evidence.label} (${evidence.kind}:${evidence.ref})` : `${evidence.label} (${evidence.kind})`;
}

function renderTeamView(state: DashboardState): string {
  const snapshot = state.snapshot;
  if (!snapshot) return '';
  const members = filteredTeammates(snapshot.teammates, state.query);
  const byOwner = new Map<string, DashboardWork[]>();
  for (const work of snapshot.works) byOwner.set(work.owner, [...(byOwner.get(work.owner) ?? []), work]);
  if (!members.length) return `<section class="empty-message" aria-live="polite"><strong>No teammates match this view</strong><span>Search names or context from Team Memory.</span></section>`;
  return `<section class="panel" aria-label="Team context"><div class="panel-heading"><h2>Teammate Memory</h2><small>Workload is derived from Work ownership.</small></div><div class="team-list">${members.map((member) => renderTeamRow(member, byOwner.get(member.ref) ?? [])).join('')}</div></section>`;
}

function renderTeamRow(member: DashboardTeammate, works: DashboardWork[]): string {
  const currentWorks = works.filter((work) => work.state === 'current');
  const current = currentWorks.length;
  const addresses = Object.entries(member.default_agent_addresses).map(([platform, address]) => `<code>${escapeHtml(platform)}: ${escapeHtml(address)}</code>`).join(' · ') || 'No reachable address recorded';
  const currentWorkText = currentWorks.length ? currentWorks.map((work) => work.title).join(' · ') : 'No current Work';
  return `<article class="team-row"><button class="work-row" type="button" data-open-teammate="${escapeHtml(member.ref)}"><span class="team-name">${escapeHtml(member.display_name)}</span><span class="team-addresses">${addresses}</span></button><div><div class="team-memory-preview">${escapeHtml(member.memory || 'No Teammate Memory recorded.')}</div><div class="team-owned-work"><strong>Current Work:</strong> ${escapeHtml(currentWorkText)}</div></div><div class="team-work-count">${current} current · ${works.length - current} completed</div></article>`;
}

function renderDrawer(state: DashboardState): string {
  const entity = state.drawerEntity;
  let content = '';
  if (state.drawerLoading) content = '<div class="loading-message"><strong>Loading detail</strong><span>Reading the latest durable context…</span></div>';
  else if (state.drawerError) content = `<div class="error-message" role="alert"><strong>Detail unavailable</strong><span>${escapeHtml(state.drawerError)}</span></div>`;
  else if (entity && 'living_doc_markdown' in entity) content = renderWorkDetail(entity as Work & Partial<DashboardWork>);
  else if (entity) content = renderTeammateDetail(entity);
  else content = '<div class="empty-message"><strong>No detail selected</strong></div>';
  return `<dialog class="detail-drawer" id="detail-drawer" aria-labelledby="drawer-title"><div class="drawer-inner"><div class="drawer-header"><h2 id="drawer-title">${entity ? escapeHtml('title' in entity ? entity.title : entity.display_name) : 'Detail'}</h2><button class="close-drawer" type="button" data-drawer-close aria-label="Close detail">Close</button></div>${content}</div></dialog>`;
}

function renderWorkDetail(work: Work & Partial<DashboardWork>): string {
  const parent = work.parent ? `<button class="relation-label" type="button" data-open-work="${escapeHtml(work.parent)}">${escapeHtml(work.parent)}</button>` : '<span class="work-meta">None</span>';
  const dependencies = work.dependencies.length ? work.dependencies.map((ref) => `<button class="relation-label" type="button" data-open-work="${escapeHtml(ref)}">${escapeHtml(ref)}</button>`).join('') : '<span class="work-meta">None</span>';
  const ownerName = work.owner_display_name ?? work.owner_name ?? work.owner;
  const source = work.owner_source ?? work.owner_status ?? (work.owner_inference?.status === 'candidate' ? 'inferred' : work.owner_inference?.status);
  const evidence = work.owner_evidence ?? work.owner_inference?.evidence ?? [];
  const ownerEvidence = source && source !== 'confirmed'
    ? `<span class="inferred-label">${source === 'inferred' ? 'Inferred owner' : 'Owner unresolved'}</span>${evidence.length ? `<ul class="evidence">${evidence.map((item) => `<li>${escapeHtml(item.ref ? `${item.label} (${item.kind}:${item.ref})` : `${item.label} (${item.kind})`)}</li>`).join('')}</ul>` : ''}`
    : '';
  return `<dl class="detail-meta"><div><dt>Owner</dt><dd>${escapeHtml(ownerName)} ${ownerEvidence}</dd></div><div><dt>State</dt><dd><span class="state-label" data-state="${work.state}">${work.state === 'current' ? 'Current' : 'Completed'}</span></dd></div><div><dt>Parent</dt><dd>${parent}</dd></div><div><dt>Dependencies</dt><dd>${dependencies}</dd></div><div><dt>Revision</dt><dd class="revision">r${work.revision}</dd></div><div><dt>Updated</dt><dd>${formatDate(work.updated_at)}</dd></div></dl><section class="detail-section"><h3>Current summary</h3><p class="summary-copy">${escapeHtml(work.current_summary)}</p></section><section class="detail-section"><h3>Living Doc</h3><article class="living-doc">${renderLivingDocMarkdown(work.living_doc_markdown)}</article></section>`;
}

function renderTeammateDetail(teammate: Teammate): string {
  const addresses = Object.entries(teammate.default_agent_addresses).map(([platform, address]) => `<li><strong>${escapeHtml(platform)}:</strong> <code>${escapeHtml(address)}</code></li>`).join('') || '<li>No reachable address recorded.</li>';
  return `<dl class="detail-meta"><div><dt>Revision</dt><dd class="revision">r${teammate.revision}</dd></div><div><dt>Updated</dt><dd>${formatDate(teammate.updated_at)}</dd></div></dl><section class="detail-section"><h3>Reachable default agent addresses</h3><ul>${addresses}</ul></section><section class="detail-section"><h3>Teammate Memory</h3><p class="memory-copy">${escapeHtml(teammate.memory || 'No Teammate Memory recorded.')}</p></section>`;
}

function filteredTeammates(teammates: DashboardTeammate[], query: string): DashboardTeammate[] {
  const needle = query.trim().toLocaleLowerCase();
  return teammates.filter((teammate) => !needle || `${teammate.display_name} ${teammate.memory ?? ''} ${teammate.ref}`.toLocaleLowerCase().includes(needle));
}

function depthFor(row: WorkViewRow, visibleRows: WorkViewRow[]): number {
  const visibleRefs = new Set(visibleRows.map((work) => work.ref));
  const parents = new Map(visibleRows.map((work) => [
    work.ref,
    work.parent && visibleRefs.has(work.parent.ref) ? work.parent.ref : null,
  ]));
  let depth = 0;
  const visited = new Set<string>();
  let parent = parents.get(row.ref) ?? null;
  while (parent && !visited.has(parent) && depth < 12) {
    visited.add(parent);
    depth += 1;
    parent = parents.get(parent) ?? null;
  }
  return depth;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function createFetchDashboardApi(): DashboardApi {
  const request = async <T>(url: string, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal });
    if (response.status === 401) throw new DashboardAuthError();
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return await response.json() as T;
  };
  return {
    async login(password, signal) {
      const response = await fetch('/api/dashboard/session', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password }),
        signal,
      });
      if (response.status === 401) throw new DashboardAuthError();
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
    },
    async logout(signal) {
      const response = await fetch('/api/dashboard/session/logout', {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal,
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
    },
    async loadSnapshot(signal) {
      const [works, teammateSummaries] = await Promise.all([
        fetchAll<DashboardWork>('/api/works', signal),
        fetchAll<DashboardTeammate>('/api/teammates', signal),
      ]);
      // Teammate list intentionally returns compact summaries; read full memory
      // concurrently so Team View can show the canonical context immediately.
      const details = await Promise.allSettled(teammateSummaries.map((summary) => this.readTeammate(summary.ref, signal)));
      const teammates = teammateSummaries.map((summary, index) => {
        const detail = details[index];
        return detail?.status === 'fulfilled' ? { ...summary, memory: detail.value.memory } : summary;
      });
      return { works, teammates };
    },
    async readWork(ref, signal) {
      const payload = await request<{ entity?: Work; work?: Work } | Work>(`/api/entity/${encodeURIComponent(ref)}`, signal);
      return 'entity' in payload && payload.entity ? payload.entity : 'work' in payload && payload.work ? payload.work : payload as Work;
    },
    async readTeammate(ref, signal) {
      const payload = await request<{ entity?: Teammate; teammate?: Teammate } | Teammate>(`/api/entity/${encodeURIComponent(ref)}`, signal);
      return 'entity' in payload && payload.entity ? payload.entity : 'teammate' in payload && payload.teammate ? payload.teammate : payload as Teammate;
    },
  };

  async function fetchAll<T>(url: string, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const separator = url.includes('?') ? '&' : '?';
      const page: ListPage<T> = await request<ListPage<T>>(`${url}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal);
      items.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return items;
  }
}

const dashboardRoot = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('#dashboard-root');
if (dashboardRoot) mountDashboard(dashboardRoot);
