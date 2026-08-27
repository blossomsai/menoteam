import { describe, expect, it } from 'vitest';
import { dashboardRequestIsCurrent, renderApp, renderGraphNode, shouldRefreshDashboard } from '../src/dashboard/client.js';
import type { DashboardSnapshot, WorkViewFilters } from '../src/dashboard/dashboard.js';
import { buildWorkViewModel, renderDashboardShell, renderLivingDocMarkdown } from '../src/dashboard/dashboard.js';

const snapshot: DashboardSnapshot = {
  works: [
    {
      ref: 'work_root',
      title: 'Release readiness',
      owner: 'teammate_alice',
      owner_source: 'confirmed',
      owner_evidence: [],
      state: 'current',
      parent: null,
      dependencies: ['work_dependency'],
      current_summary: 'Keep the release path clear.',
      subtree_count: 2,
      revision: 3,
      updated_at: '2026-08-26T16:00:00.000Z',
    },
    {
      ref: 'work_dependency',
      title: 'API reliability',
      owner: 'teammate_bob',
      owner_source: 'confirmed',
      owner_evidence: [],
      state: 'completed',
      parent: 'work_root',
      dependencies: [],
      current_summary: 'Document the reliable API path.',
      subtree_count: 1,
      revision: 2,
      updated_at: '2026-08-25T16:00:00.000Z',
    },
  ],
  teammates: [
    {
      ref: 'teammate_alice',
      display_name: 'Alice',
      default_agent_addresses: { slack: '@alice' },
      revision: 1,
      updated_at: '2026-08-26T16:00:00.000Z',
    },
    {
      ref: 'teammate_bob',
      display_name: 'Bob',
      default_agent_addresses: {},
      revision: 1,
      updated_at: '2026-08-25T16:00:00.000Z',
    },
  ],
};

describe('Work Map dashboard view model', () => {
  it('derives graph nodes and list rows from the same work facts', () => {
    const model = buildWorkViewModel(snapshot, { query: '', state: 'all', owner: '', includeCompleted: true });

    expect(model.nodes.map((node) => node.ref)).toEqual(['work_root', 'work_dependency']);
    expect(model.rows.map((row) => row.ref)).toEqual(['work_root', 'work_dependency']);
    expect(model.nodes[0]).toMatchObject({
      title: 'Release readiness',
      ownerName: 'Alice',
      dependencies: [{ ref: 'work_dependency', title: 'API reliability' }],
    });
    expect(model.rows[1]).toMatchObject({ title: 'API reliability', ownerName: 'Bob', state: 'completed' });
  });

  it('orders the graph parent-first even when the dense API list is alphabetical', () => {
    const alphabetical: DashboardSnapshot = {
      ...snapshot,
      works: [snapshot.works[1], snapshot.works[0]],
    };
    const model = buildWorkViewModel(alphabetical, { query: '', state: 'all', owner: '', includeCompleted: true });

    expect(model.nodes.map((node) => node.ref)).toEqual(['work_root', 'work_dependency']);
    expect(model.rows.map((row) => row.ref)).toEqual(['work_dependency', 'work_root']);
  });

  it('keeps completed work searchable while hiding it from the default current view', () => {
    const defaultFilters: WorkViewFilters = { query: '', state: 'all', owner: '', includeCompleted: false };
    expect(buildWorkViewModel(snapshot, defaultFilters).rows.map((row) => row.ref)).toEqual(['work_root']);

    const searchFilters: WorkViewFilters = { ...defaultFilters, query: 'reliability' };
    expect(buildWorkViewModel(snapshot, searchFilters).rows.map((row) => row.ref)).toEqual(['work_dependency']);
  });

  it('marks unconfirmed owner metadata as inferred and preserves its evidence', () => {
    const inferredSnapshot: DashboardSnapshot = {
      ...snapshot,
      works: [{ ...snapshot.works[0], owner_source: 'inferred', owner_evidence: [{ kind: 'commit', label: '2 matching commits' }] }],
    };
    const model = buildWorkViewModel(inferredSnapshot, { query: '', state: 'all', owner: '', includeCompleted: true });

    expect(model.rows[0]).toMatchObject({ ownerName: 'Alice', ownerSource: 'inferred', ownerEvidence: [{ kind: 'commit' }] });
  });
});

describe('Living Doc rendering', () => {
  it('renders basic markdown as escaped, semantic HTML without executing markup', () => {
    const html = renderLivingDocMarkdown('# Current truth\n\nUse **the map**. <script>alert(1)</script>\n\n- One\n- Two');

    expect(html).toContain('<h1>Current truth</h1>');
    expect(html).toContain('<strong>the map</strong>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<ul><li>One</li><li>Two</li></ul>');
    expect(html).not.toContain('<script>');
  });

  it('turns safe document links into external links and leaves unsafe schemes plain', () => {
    const html = renderLivingDocMarkdown('[Source document](https://example.com/spec?a=1&b=2) [Plain HTTP](http://example.com) [Unsafe](javascript:alert(1)) [Data](data:text/html,hi)');

    expect(html).toContain('<a href="https://example.com/spec?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Source document</a>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain('href="http://');
    expect(html).toContain('[Plain HTTP](http://example.com)');
    expect(html).toContain('[Unsafe](javascript:alert(1))');
    expect(html).toContain('[Data](data:text/html,hi)');
  });
});

describe('dashboard shell interface', () => {
  const unauthenticatedState = {
    snapshot: null,
    authenticated: false,
    view: 'work' as const,
    filters: { query: '', state: 'all' as const, owner: '', includeCompleted: false },
    query: '',
    loading: false,
    error: null,
    authError: null,
    logoutStatus: 'idle' as const,
    selectedRef: null,
    selectedKind: null,
    previousFocus: null,
    drawerLoading: false,
    drawerError: null,
    drawerEntity: null,
  };

  it('does not render a drawer while the dashboard is locked', () => {
    expect(renderApp(unauthenticatedState)).not.toContain('id="detail-drawer"');
  });

  it('does not pretend a failed cookie invalidation completed', () => {
    const pending = renderApp({ ...unauthenticatedState, logoutStatus: 'pending' });
    expect(pending).toContain('Finishing server-side lock');
    expect(pending).toContain('data-retry-logout');
    expect(pending).not.toContain('data-auth-form');

    const failed = renderApp({ ...unauthenticatedState, logoutStatus: 'failed', authError: 'Signed cookie may still be valid.' });
    expect(failed).toContain('Signed cookie may still be valid.');
    expect(failed).toContain('Retry lock');
    expect(failed).not.toContain('data-auth-form');
    expect(failed).not.toContain('id="detail-drawer"');
  });

  it('ships read-only navigation, explicit loading, and the client asset without write affordances', () => {
    const shell = renderDashboardShell();

    expect(shell).toContain('Loading Work Map');
    expect(shell).toContain('/dashboard/client.js');
    expect(shell).toContain('prefers-reduced-motion');
    expect(shell).not.toMatch(/\b(?:kanban|drag(?:-and-drop)?|save|edit|create)\b/iu);
  });

  it('renders dependency edges as read-only links to dependency detail', () => {
    const model = buildWorkViewModel(snapshot, { query: '', state: 'all', owner: '', includeCompleted: true });
    const html = renderGraphNode(model.nodes[0]!, model.nodes);

    expect(html).toContain('Depends on');
    expect(html).toContain('data-open-work="work_dependency"');
    expect(html).toContain('aria-label="Open dependency: API reliability"');
    expect(html).toContain('>API reliability</button>');
  });

  it('refreshes living data only when the visible dashboard is idle', () => {
    const ready = { authenticated: true, loading: false, selectedRef: null, visibilityState: 'visible' as const, editingFilter: false };
    expect(shouldRefreshDashboard(ready)).toBe(true);
    expect(shouldRefreshDashboard({ ...ready, visibilityState: 'hidden' })).toBe(false);
    expect(shouldRefreshDashboard({ ...ready, selectedRef: 'work_detail' })).toBe(false);
    expect(shouldRefreshDashboard({ ...ready, editingFilter: true })).toBe(false);
  });

  it('rejects late responses after logout or a newer detail request', () => {
    expect(dashboardRequestIsCurrent({ requestGeneration: 4, currentGeneration: 4, authenticated: true })).toBe(true);
    expect(dashboardRequestIsCurrent({ requestGeneration: 4, currentGeneration: 5, authenticated: true })).toBe(false);
    expect(dashboardRequestIsCurrent({ requestGeneration: 4, currentGeneration: 4, authenticated: false })).toBe(false);
    expect(dashboardRequestIsCurrent({ requestGeneration: 4, currentGeneration: 4, authenticated: true, expectedSelectedRef: 'work_new', selectedRef: 'work_old' })).toBe(false);
  });
});
