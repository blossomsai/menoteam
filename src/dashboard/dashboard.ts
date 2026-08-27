import type { TeammateSummary, WorkSummary } from '../domain/model.js';

export type OwnerSource = 'confirmed' | 'inferred' | 'unresolved';

export interface OwnerEvidence {
  kind: string;
  label: string;
  ref?: string;
  detail?: string;
}

/** Optional provenance fields are additive: the MCP summary remains the source of truth. */
export type DashboardWork = Omit<WorkSummary, 'owner_source'> & {
  owner_display_name?: string;
  owner_name?: string;
  owner_source?: OwnerSource;
  owner_status?: OwnerSource | 'candidate';
  owner_evidence?: OwnerEvidence[];
  owner_inference?: {
    status?: OwnerSource | 'candidate';
    confirmed?: boolean;
    person?: { displayName?: string; name?: string } | null;
    evidence?: OwnerEvidence[];
  };
};

export type DashboardTeammate = TeammateSummary & { memory?: string };

export interface DashboardSnapshot {
  works: DashboardWork[];
  teammates: DashboardTeammate[];
}

export interface WorkViewFilters {
  query: string;
  state: 'all' | 'current' | 'completed';
  owner: string;
  includeCompleted: boolean;
}

export interface WorkRelationship {
  ref: string;
  title: string;
  state?: 'current' | 'completed';
}

export interface WorkViewRow {
  ref: string;
  title: string;
  summary: string;
  owner: string;
  ownerName: string;
  ownerSource: OwnerSource;
  ownerEvidence: OwnerEvidence[];
  state: 'current' | 'completed';
  parent: WorkRelationship | null;
  dependencies: WorkRelationship[];
  revision: number;
  updatedAt: string;
}

export interface WorkViewModel {
  nodes: WorkViewRow[];
  rows: WorkViewRow[];
  completedRows: WorkViewRow[];
  currentCount: number;
  completedCount: number;
  matchedCount: number;
}

export function buildWorkViewModel(snapshot: DashboardSnapshot, filters: WorkViewFilters): WorkViewModel {
  const teammates = new Map(snapshot.teammates.map((teammate) => [teammate.ref, teammate]));
  const byRef = new Map(snapshot.works.map((work) => [work.ref, work]));
  const allRows = snapshot.works.map((work) => toWorkViewRow(work, byRef, teammates));
  const matchingRows = allRows.filter((row) => matchesWork(row, filters));
  const currentRows = matchingRows.filter((row) => row.state === 'current');
  const completedRows = matchingRows.filter((row) => row.state === 'completed');
  const revealCompleted = filters.includeCompleted || filters.query.trim() !== '';
  const rows = filters.state === 'completed'
    ? completedRows
    : revealCompleted
      ? matchingRows
      : currentRows;

  return {
    // Graph and dense list intentionally share these exact row objects and facts.
    nodes: orderRowsParentFirst(rows),
    rows,
    completedRows: revealCompleted || filters.state === 'completed' ? [] : orderRowsParentFirst(completedRows),
    currentCount: allRows.filter((row) => row.state === 'current').length,
    completedCount: allRows.filter((row) => row.state === 'completed').length,
    matchedCount: matchingRows.length,
  };
}

function orderRowsParentFirst(rows: WorkViewRow[]): WorkViewRow[] {
  const included = new Set(rows.map((row) => row.ref));
  const children = new Map<string | null, WorkViewRow[]>();
  for (const row of rows) {
    const parent = row.parent && included.has(row.parent.ref) ? row.parent.ref : null;
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const compare = (left: WorkViewRow, right: WorkViewRow): number =>
    left.title.localeCompare(right.title) || left.ref.localeCompare(right.ref);
  for (const group of children.values()) group.sort(compare);

  const ordered: WorkViewRow[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (row: WorkViewRow): void => {
    if (visited.has(row.ref) || visiting.has(row.ref)) return;
    visiting.add(row.ref);
    visited.add(row.ref);
    ordered.push(row);
    for (const child of children.get(row.ref) ?? []) visit(child);
    visiting.delete(row.ref);
  };
  for (const root of children.get(null) ?? []) visit(root);
  for (const row of [...rows].sort(compare)) visit(row);
  return ordered;
}

function toWorkViewRow(
  work: DashboardWork,
  byRef: ReadonlyMap<string, DashboardWork>,
  teammates: ReadonlyMap<string, DashboardTeammate>,
): WorkViewRow {
  const owner = teammates.get(work.owner);
  const ownerSource = normalizeOwnerSource(work, owner);
  const ownerInference = work.owner_inference;
  return {
    ref: work.ref,
    title: work.title,
    summary: work.current_summary,
    owner: work.owner,
    ownerName: work.owner_display_name ?? work.owner_name ?? ownerInference?.person?.displayName ?? ownerInference?.person?.name ?? owner?.display_name ?? 'Unknown teammate',
    ownerSource,
    ownerEvidence: [...(work.owner_evidence ?? ownerInference?.evidence ?? [])],
    state: work.state,
    parent: work.parent ? relationshipFor(work.parent, byRef) : null,
    dependencies: work.dependencies.map((ref) => relationshipFor(ref, byRef)),
    revision: work.revision,
    updatedAt: work.updated_at,
  };
}

function normalizeOwnerSource(work: DashboardWork, owner: DashboardTeammate | undefined): OwnerSource {
  const explicit = work.owner_source ?? work.owner_status ?? work.owner_inference?.status;
  if (explicit === 'candidate' || explicit === 'inferred') return 'inferred';
  if (explicit === 'unresolved') return 'unresolved';
  if (explicit === 'confirmed' || work.owner_inference?.confirmed === true) return 'confirmed';
  return owner ? 'confirmed' : 'unresolved';
}

function relationshipFor(ref: string, byRef: ReadonlyMap<string, DashboardWork>): WorkRelationship {
  const work = byRef.get(ref);
  return work ? { ref, title: work.title, state: work.state } : { ref, title: 'Unknown Work' };
}

function matchesWork(row: WorkViewRow, filters: WorkViewFilters): boolean {
  if (filters.state !== 'all' && row.state !== filters.state) return false;
  if (filters.owner && row.owner !== filters.owner) return false;
  const query = filters.query.trim().toLocaleLowerCase();
  if (!query) return true;
  return `${row.title} ${row.summary} ${row.ownerName} ${row.ref}`.toLocaleLowerCase().includes(query);
}

export function renderLivingDocMarkdown(markdown: string): string {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length) {
      output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list.length) {
      output.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      list = [];
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      if (code === null) code = [];
      else {
        output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
    } else if (bullet) {
      flushParagraph();
      list.push(bullet[1] ?? '');
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  if (code !== null) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return output.join('');
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

function renderInline(value: string): string {
  const linkTokens: Array<{ html?: string; raw?: string }> = [];
  const tokenized = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (full, label: string, url: string) => {
    const token = `\u0000${linkTokens.length}\u0000`;
    linkTokens.push(/^https:\/\//iu.test(url)
      ? { html: `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` }
      : { raw: full });
    return token;
  });
  let rendered = escapeHtml(tokenized);
  rendered = rendered.replace(/`([^`]+)`/gu, '<code>$1</code>');
  rendered = rendered.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
  rendered = rendered.replace(/__([^_]+)__/gu, '<strong>$1</strong>');
  rendered = rendered.replace(/\*([^*]+)\*/gu, '<em>$1</em>');
  rendered = rendered.replace(/_([^_]+)_/gu, '<em>$1</em>');
  return rendered.replace(/\u0000(\d+)\u0000/gu, (_token, index: string) => {
    const link = linkTokens[Number(index)];
    return link?.html ?? escapeHtml(link?.raw ?? '');
  });
}

export const dashboardCss = String.raw`
:root {
  color-scheme: light;
  --work-green: oklch(0.400 0.087 160);
  --work-green-soft: oklch(0.955 0.020 160);
  --signal-amber: oklch(0.690 0.135 70);
  --signal-amber-soft: oklch(0.965 0.032 78);
  --ink: oklch(0.205 0.018 250);
  --muted: oklch(0.430 0.018 250);
  --canvas: oklch(0.990 0.003 250);
  --surface: oklch(1 0 0);
  --subtle: oklch(0.970 0.006 250);
  --line: oklch(0.855 0.010 250);
  --danger: oklch(0.470 0.175 25);
  --focus: oklch(0.400 0.087 160 / 0.28);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--canvas);
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--canvas); }
button, input, select { font: inherit; }
button, select { min-height: 44px; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible, [tabindex="0"]:focus-visible {
  outline: 2px solid var(--work-green);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--focus);
}
.skip-link { position: fixed; left: 12px; top: 8px; z-index: 4; transform: translateY(-150%); background: var(--ink); color: white; padding: 8px 12px; border-radius: 6px; }
.skip-link:focus { transform: translateY(0); }
.app-header { border-bottom: 1px solid var(--line); background: var(--surface); }
.header-inner { max-width: 1440px; margin: 0 auto; padding: 18px 28px 14px; display: flex; align-items: end; justify-content: space-between; gap: 24px; }
.wordmark { font-weight: 700; letter-spacing: -0.02em; font-size: 1.1rem; }
.product-note { color: var(--muted); font-size: .86rem; margin-top: 4px; }
.view-tabs { display: flex; gap: 4px; }
.view-tab { border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); padding: 10px 12px 9px; min-height: 44px; }
.view-tab[aria-selected="true"] { color: var(--work-green); border-bottom-color: var(--work-green); font-weight: 650; }
.read-only-note { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); font-size: .71rem; letter-spacing: .02em; white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.workspace { max-width: 1440px; margin: 0 auto; padding: 28px; }
.auth-panel { width: min(480px, 100%); margin: 8vh auto 0; border-top: 3px solid var(--work-green); padding-top: 20px; }
.auth-panel h1 { margin: 0 0 10px; font-size: 1.65rem; letter-spacing: -.025em; }
.auth-panel p { max-width: 62ch; color: var(--muted); line-height: 1.55; }
.auth-panel form { display: grid; gap: 14px; margin-top: 24px; }
.unlock-button { width: fit-content; border: 1px solid var(--work-green); border-radius: 6px; background: var(--work-green); color: white; padding: 10px 16px; min-height: 44px; font-weight: 650; }
.unlock-button:hover { background: oklch(.34 .087 160); }
.toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto; align-items: end; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 20px; }
.field-label { display: grid; gap: 6px; color: var(--muted); font: 600 .74rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
.text-input, .select { width: 100%; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 6px; padding: 10px 12px; min-height: 44px; }
.text-input::placeholder { color: var(--muted); opacity: 1; }
.toolbar-count { color: var(--muted); font-size: .88rem; white-space: nowrap; padding-bottom: 12px; }
.error-message, .empty-message, .loading-message { margin-top: 24px; border: 1px solid var(--line); background: var(--surface); padding: 24px; border-radius: 10px; }
.error-message { border-color: color-mix(in oklch, var(--danger) 55%, var(--line)); }
.error-message strong, .empty-message strong { display: block; margin-bottom: 6px; }
.view-columns { display: grid; grid-template-columns: minmax(300px, .9fr) minmax(420px, 1.1fr); gap: 24px; margin-top: 24px; }
.panel { min-width: 0; }
.panel-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.panel-heading h2 { font-size: 1rem; margin: 0; letter-spacing: -.01em; }
.panel-heading small { color: var(--muted); }
.graph-map { position: relative; min-height: 260px; border: 1px solid var(--line); background: var(--surface); border-radius: 10px; padding: 20px 18px; overflow: auto; }
.graph-list, .work-children { list-style: none; margin: 0; padding: 0; }
.graph-item { position: relative; padding: 4px 0 4px calc(var(--depth, 0) * 22px); }
.graph-item[data-depth="1"]::before, .graph-item[data-depth="2"]::before, .graph-item[data-depth="3"]::before { content: ""; position: absolute; width: 14px; height: 1px; background: var(--line); left: calc(var(--depth, 0) * 22px - 14px); top: 27px; }
.graph-item[data-depth="1"]::after, .graph-item[data-depth="2"]::after, .graph-item[data-depth="3"]::after { content: ""; position: absolute; width: 1px; background: var(--line); left: calc(var(--depth, 0) * 22px - 14px); top: -6px; bottom: 0; }
.graph-node { width: 100%; text-align: left; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; padding: 10px 12px; min-height: 58px; display: grid; gap: 6px; }
.graph-node:hover, .work-row:hover { background: var(--work-green-soft); }
.node-title, .work-link { color: var(--ink); font-weight: 650; }
.node-meta, .work-meta { color: var(--muted); font-size: .8rem; }
.dependency-note { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 6px 0 6px calc(var(--depth, 0) * 22px + 10px); color: var(--muted); font-size: .73rem; }
.dependency-label { color: var(--signal-amber); font-weight: 650; }
.completed-disclosure { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
.completed-disclosure summary { cursor: pointer; color: var(--muted); padding: 8px 4px; min-height: 44px; }
.completed-disclosure[open] summary { color: var(--ink); }
.work-table-wrap { border: 1px solid var(--line); border-radius: 10px; overflow: auto; background: var(--surface); }
.work-table { width: 100%; border-collapse: collapse; min-width: 560px; }
.work-table th { text-align: left; font: 600 .72rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); padding: 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.work-table td { padding: 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
.work-table tr:last-child td { border-bottom: 0; }
.work-row { width: 100%; text-align: left; border: 0; background: transparent; padding: 0; display: grid; gap: 5px; }
.state-label, .inferred-label, .relation-label { display: inline-flex; align-items: center; width: fit-content; border: 1px solid var(--line); border-radius: 999px; padding: 3px 7px; color: var(--muted); font: 600 .68rem/1.15 ui-monospace, SFMono-Regular, Menlo, monospace; }
.state-label[data-state="current"] { color: var(--work-green); border-color: color-mix(in oklch, var(--work-green) 55%, var(--line)); }
.inferred-label { color: oklch(.38 .11 70); background: var(--signal-amber-soft); border-color: color-mix(in oklch, var(--signal-amber) 60%, var(--line)); }
.relation-label { margin: 2px 2px 2px 0; }
button.relation-label { background: var(--surface); cursor: pointer; }
button.relation-label:hover { background: var(--work-green-soft); color: var(--ink); }
.revision { color: var(--muted); font: .72rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.team-list { border-top: 1px solid var(--line); }
.team-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(180px, 2fr) auto; gap: 16px; align-items: start; border-bottom: 1px solid var(--line); padding: 16px 0; }
.team-name { font-weight: 650; }
.team-addresses, .team-memory-preview { color: var(--muted); font-size: .88rem; }
.team-owned-work { margin-top: 8px; font-size: .82rem; }
.team-addresses code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .76rem; }
.team-work-count { color: var(--muted); font-size: .8rem; white-space: nowrap; }
.detail-drawer { width: min(680px, 100vw); max-width: 100%; height: 100dvh; max-height: none; margin: 0 0 0 auto; border: 0; border-left: 1px solid var(--line); padding: 0; background: var(--surface); color: var(--ink); box-shadow: 0 16px 48px oklch(.205 .018 250 / .14); }
.detail-drawer::backdrop { background: oklch(.205 .018 250 / .32); }
.drawer-inner { height: 100%; overflow: auto; padding: 28px; }
.drawer-header { display: flex; align-items: start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
.drawer-header h2 { font-size: 1.45rem; line-height: 1.2; letter-spacing: -.02em; margin: 0; }
.close-drawer, .logout-button { border: 1px solid var(--line); background: var(--surface); border-radius: 6px; padding: 7px 10px; }
.detail-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 16px 0; margin-bottom: 24px; }
.detail-meta dt { color: var(--muted); font: 600 .7rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
.detail-meta dd { margin: 4px 0 0; }
.detail-section { margin-top: 24px; }
.detail-section h3 { font-size: .92rem; margin: 0 0 8px; }
.summary-copy { max-width: 72ch; line-height: 1.55; }
.living-doc { max-width: 72ch; line-height: 1.65; }
.living-doc h1, .living-doc h2, .living-doc h3 { line-height: 1.25; margin: 1.5em 0 .5em; }
.living-doc h1:first-child, .living-doc h2:first-child, .living-doc h3:first-child { margin-top: 0; }
.living-doc p { margin: .85em 0; }
.living-doc ul { padding-left: 1.25rem; }
.living-doc code { background: var(--subtle); border-radius: 4px; padding: 2px 4px; font-size: .9em; }
.living-doc pre { overflow: auto; background: var(--subtle); border: 1px solid var(--line); border-radius: 6px; padding: 12px; }
.living-doc pre code { padding: 0; background: none; }
.memory-copy { max-width: 72ch; line-height: 1.6; white-space: pre-wrap; }
.evidence { margin: 8px 0 0; padding-left: 1.2rem; color: var(--muted); font-size: .85rem; }
.overflow-note { margin: 16px 0 0; color: var(--muted); font-size: .82rem; }
@media (max-width: 920px) { .toolbar { grid-template-columns: 1fr 1fr; } .toolbar > :first-child { grid-column: 1 / -1; } .toolbar-count { padding-bottom: 0; } .view-columns { grid-template-columns: 1fr; } }
@media (max-width: 680px) { .header-inner, .workspace { padding-left: 16px; padding-right: 16px; } .header-inner { align-items: start; flex-direction: column; gap: 12px; } .view-tabs { width: 100%; } .view-tab { flex: 1; } .read-only-note { white-space: normal; } .toolbar { grid-template-columns: 1fr; gap: 12px; } .toolbar > :first-child { grid-column: auto; } .team-row { grid-template-columns: 1fr; gap: 8px; } .detail-drawer { width: 100%; border-left: 0; } .drawer-inner { padding: 20px 16px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; } }
`;

export function renderDashboardShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Read-only Work Map for durable team context">
    <title>Work Map · Menoteam</title>
    <style>${dashboardCss}</style>
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    <div id="dashboard-root" aria-live="polite">
      <main id="main-content" class="workspace"><div class="loading-message"><strong>Loading Work Map</strong><span>Reading the team's current context…</span></div></main>
    </div>
    <script type="module" src="/dashboard/client.js"></script>
  </body>
</html>`;
}

export type { TeammateSummary, WorkSummary };
