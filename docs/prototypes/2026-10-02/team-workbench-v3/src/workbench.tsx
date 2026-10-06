import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../../../../src/local/web/src/components/ui/badge';
import { Button } from '../../../../../src/local/web/src/components/ui/button';
import { Input } from '../../../../../src/local/web/src/components/ui/input';
import { AgentProfilesSettings, initialAgentProfiles, type AgentProfile } from './agent-profiles';
import { AttachmentList, ConversationComposer } from './conversation-composer';
import { attachmentMetadata, useLocalAttachmentPool, type LocalAttachment } from './local-attachments';
import { candidateSourcesForWork, relatedSourcesForWork } from './sample-sources';


type View = { id: string; title: string; area: string; nav: string };
const views: View[] = [
  { id: 'V01', title: 'All projects', area: 'Projects', nav: 'All projects' },
  { id: 'V17', title: 'Project Master', area: 'Project · Master', nav: 'Master' },
  { id: 'V03', title: 'Project · Work list', area: 'Project · Work', nav: 'Work' },
  { id: 'V02', title: 'Connect Project', area: 'Onboarding', nav: 'Connect project' },
  { id: 'V05', title: 'Work Detail', area: 'Contextual detail', nav: 'Work detail' },
  { id: 'V11', title: 'Project instructions', area: 'Project · Settings', nav: 'Instructions' },
  { id: 'V12', title: 'Skills Library', area: 'Project · Settings', nav: 'Skills' },
  { id: 'V13', title: 'Members & Access', area: 'Project · Settings', nav: 'Members' },
  { id: 'V14', title: 'Connections', area: 'Project · Settings', nav: 'Connections' },
  { id: 'V15', title: 'Workspace settings', area: 'Workspace', nav: 'Workspace settings' },
];

type ProjectWork = { id: string; title: string; outcome: string; status: string; tone: 'green' | 'indigo' | 'amber' | 'neutral'; next: string; agent: string; profileId?: string; executionConfig?: string };
type MasterUpdate = { time: string; text: string; target?: string; linkedWorkId?: string; sourceId?: string };
type Project = { id: string; name: string; initial: string; outcome: string; status: string; tone: 'green' | 'indigo' | 'amber'; next: string; decision?: string; works: ProjectWork[]; updates: MasterUpdate[] };
const projects: Project[] = [
  { id: 'field-notes', name: 'Field Notes', initial: 'F', outcome: 'Invite link fix passed required checks; post-deploy verification is pending.', status: 'In progress', tone: 'green', next: 'Review permission regression scope', decision: 'Review the FN-51 permission fix before I proceed.', works: [
    { id: 'FN-39', title: 'Explain scope on the project rules page', outcome: 'Delivered.', status: 'Done', tone: 'green', next: 'None', agent: 'Codex · FN-39' },
    { id: 'FN-51', title: 'Check permissions after the change', outcome: 'The baseline check points to project invite visibility.', status: 'In progress', tone: 'amber', next: 'Review the restricted fix plan', agent: 'Codex · FN-51' },
    { id: 'FN-56', title: 'Prepare a weekly access review summary', outcome: 'Separate request recorded; Master to assign.', status: 'Queued', tone: 'neutral', next: 'Master to assign', agent: 'Master to assign' },
    { id: 'FN-48', title: 'Retry the invite link', outcome: 'The fix passed required checks.', status: 'Verifying', tone: 'indigo', next: 'Verify after deployment', agent: 'Codex · FN-48' },
    { id: 'FN-43', title: 'Sync repository labels', outcome: 'A routine QA failure returned to Codex for a fix; the rerun checks passed.', status: 'Integrating', tone: 'indigo', next: 'Master to review and confirm the result', agent: 'Codex · FN-43' },
  ], updates: [
    { time: '10:18', text: 'FN-43 is fixed and checks are passing. I’m integrating the change.' },
    { time: '10:42', text: 'FN-48 is deployed. I’m checking the invite flow before marking it complete.', target: 'V09' },
    { time: '10:54', text: 'I’ve linked the Slack report, issue and PR feedback to FN-51. Guest access stays outside this fix until you confirm the scope.', linkedWorkId: 'FN-51', sourceId: 'fn51-slack-repro' },
    { time: '11:06', text: 'The weekly access review summary is an independent goal, so I recorded it as FN-56 for assignment without expanding FN-51.', linkedWorkId: 'FN-56', sourceId: 'fn56-independent-goal' },
  ] },
  { id: 'atlas', name: 'Atlas', initial: 'A', outcome: 'The source index has had its first review; duplicates are merged and gaps listed.', status: 'On track', tone: 'indigo', next: 'Review the next set of sources', works: [
    { id: 'AT-24', title: 'Organize new research sources', outcome: 'Deduplicated and filed 12 sources.', status: 'Done', tone: 'green', next: 'Return to the topic index', agent: 'Codex · AT-24' },
    { id: 'AT-27', title: 'Add methodology sources', outcome: 'Checking three citation trails.', status: 'In progress', tone: 'indigo', next: 'Submit source review', agent: 'Codex · AT-27' },
  ], updates: [
    { time: '10:12', text: 'I listed the methodology gaps in AT-27 and am checking the original sources before updating the topic index.', linkedWorkId: 'AT-27' },
    { time: '10:34', text: 'AT-24’s 12 new sources are deduplicated and filed. Next I’ll check AT-27’s remaining citation trails.', linkedWorkId: 'AT-24' },
  ] },
  { id: 'beacon', name: 'Beacon', initial: 'B', outcome: 'The pilot issue categories are settled; the handoff guide is in review.', status: 'Needs attention', tone: 'amber', next: 'Review the handoff guide', decision: 'Confirm support coverage before adding the night shift to the pilot.', works: [
    { id: 'BC-12', title: 'Refine pilot issue categories', outcome: 'The pilot team reviewed the categories.', status: 'Done', tone: 'green', next: 'File pilot feedback', agent: 'Codex · BC-12' },
    { id: 'BC-15', title: 'Prepare the shift handoff guide', outcome: 'Draft complete; coverage needs confirmation.', status: 'Paused', tone: 'amber', next: 'Review night-shift coverage', agent: 'Codex · BC-15' },
  ], updates: [
    { time: '10:03', text: 'BC-12’s pilot issue categories are settled. I’ve carried them into the BC-15 shift handoff guide.', linkedWorkId: 'BC-12' },
    { time: '10:27', text: 'The BC-15 draft is ready. I’ll document the current day-shift handoff and expand it once the pilot scope is set.', linkedWorkId: 'BC-15' },
  ] },
];
const legacyViews: Record<string, string> = { '#project-work': 'V01', '#project-master': 'V17', '#work-list': 'V03', '#label-V04': 'V03', '#label-V16': 'V15', '#runtime-config': 'V15' };
export function parsePrototypeLocation(input: string | URL) {
  const url = new URL(input, 'http://localhost/');
  const requestedProject = url.searchParams.get('project');
  const projectId = projects.some((project) => project.id === requestedProject) ? requestedProject! : 'field-notes';
  const requestedView = url.searchParams.get('view');
  const viewId = requestedView === 'V07' || url.hash === '#label-V07' ? 'V15' : ['V08', 'V09'].includes(requestedView ?? '') || ['#label-V08', '#label-V09'].includes(url.hash) || requestedView === 'V06' || url.hash === '#label-V06' || requestedView === 'V10' || url.hash === '#label-V10' ? 'V05' : requestedView === 'V04' ? 'V03' : requestedView === 'V16' ? 'V15' : views.some((view) => view.id === requestedView) ? requestedView! : legacyViews[url.hash] ?? views.find((view) => `#label-${view.id}` === url.hash)?.id ?? 'V01';
  return { projectId, viewId };
}
export function prototypeHref(projectId: string, viewId: string, base = window.location.href) {
  const url = new URL(base);
  url.searchParams.set('project', projects.some((project) => project.id === projectId) ? projectId : 'field-notes');
  const resolvedView = viewId === 'V07' ? 'V15' : ['V06', 'V08', 'V09', 'V10'].includes(viewId) ? 'V05' : viewId === 'V04' ? 'V03' : viewId === 'V16' ? 'V15' : views.some((view) => view.id === viewId) ? viewId : 'V01';
  if (!['V07','V15'].includes(resolvedView)) url.searchParams.delete('settings');
  url.searchParams.delete('work');
  url.searchParams.delete('source');
  url.searchParams.delete('tab');
  if (viewId === 'V08' || viewId === 'V09') { url.searchParams.set('work', viewId === 'V09' ? 'FN-48' : 'FN-51'); url.searchParams.set('tab', viewId === 'V08' ? 'qa' : 'overview'); }
  url.searchParams.set('view', resolvedView);
  url.hash = ({ V01: 'project-work', V17: 'project-master', V03: 'work-list' } as Record<string, string>)[resolvedView] ?? `label-${resolvedView}`;
  return `${url.pathname}${url.search}${url.hash}`;
}
export function projectWorkHref(projectId: string, workId: string, base = window.location.href) {
  const url = new URL(prototypeHref(projectId, 'V05', base), 'http://localhost/');
  url.searchParams.set('work', workId);
  return `${url.pathname}${url.search}${url.hash}`;
}
export function workSelectionFromUrl(input: string | URL, projectId: string, viewId: string) {
  const url = new URL(input, 'http://localhost/');
  const route = parsePrototypeLocation(url);
  if (viewId !== 'V03' || route.viewId !== 'V03' || route.projectId !== projectId) return { workId: '', sourceId: '' };
  const workId = url.searchParams.get('work') ?? '';
  return { workId, sourceId: workId ? url.searchParams.get('source') ?? '' : '' };
}
export function projectSourceHref(projectId: string, workId: string, sourceId: string, base = window.location.href) {
  const view = 'V05';
  const url = new URL(prototypeHref(projectId, view, base), 'http://localhost/');
  url.searchParams.set('work', workId);
  url.searchParams.set('source', sourceId);
  return `${url.pathname}${url.search}${url.hash}`;
}
type WorkspaceSettingsTab = 'profiles' | 'accounts';
export function settingsTabFromUrl(input: string | URL): WorkspaceSettingsTab {
  const url = new URL(input, 'http://localhost/');
  if (url.searchParams.get('view') === 'V07' || url.hash === '#label-V07') return 'accounts';
  if (url.searchParams.get('view') === 'V16' || url.searchParams.get('view') === 'V15' && url.searchParams.get('settings') === 'environment') return 'accounts';
  const selected = url.searchParams.get('settings');
  if (selected === 'profiles' || selected === 'accounts') return selected;
  if (url.hash === '#runtime-config' || url.hash === '#label-V16') return 'accounts';
  return 'profiles';
}
export function workspaceSettingsHref(tab: WorkspaceSettingsTab, projectId: string, base = window.location.href) {
  const url = new URL(prototypeHref(projectId, 'V15', base), 'http://localhost/');
  url.searchParams.set('settings', tab);
  return `${url.pathname}${url.search}${url.hash}`;
}
export function normalizeCodexAccount(value: string | null) {
  return value === 'codex-account-b' || value === 'Personal Research' ? 'codex-account-b' : 'codex-account-a';
}
type MasterTurn = { user: string; reply: string; time?: string; attachments?: LocalAttachment[] };
type ProjectRun = { paused: boolean; host: 'online' | 'sleeping'; cadence: 'important' | 'daily' | 'decisions'; entry: 'current' | 'slack'; runtimeConfig?: string };
const defaultProjectRun: ProjectRun = { paused: false, host: 'online', cadence: 'important', entry: 'current' };
function readSessionRecord<T>(key: string): Record<string, T> {
  try { return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, T>; } catch { return {}; }
}
function readSessionDrafts(key: string): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, string>; } catch { return {}; }
}
function readSessionValue<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null ?? fallback; } catch { return fallback; }
}

type IconName = 'grid' | 'work' | 'map' | 'agents' | 'quality' | 'release' | 'settings' | 'search' | 'arrow' | 'plus' | 'chevron' | 'external' | 'close' | 'spark' | 'clock' | 'link' | 'dots' | 'check' | 'alert' | 'github' | 'slack' | 'folder' | 'shield' | 'focus';
function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    work: <><path d="M3 7h18v13H3z"/><path d="M8 7V4h8v3M3 12h18M10 12v2h4v-2"/></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15m6-12v15"/></>,
    agents: <><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0m3-12h4m-2-2v4m-2 7h4"/></>,
    quality: <><path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.7 7.5 9.5 4.3-1.8 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/></>,
    release: <><path d="m5 19 5-5m-3 5H5v-2m10-9 3-3 3 3-3 3"/><path d="M8 16 4 12l9-9 4 4z"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.7-1.4-2.4 1.4-1.1a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 2Z" transform="translate(-1 -1) scale(1.08)"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    arrow: <><path d="M4 12h15m-6-6 6 6-6 6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    chevron: <><path d="m9 18 6-6-6-6"/></>,
    external: <><path d="M14 4h6v6m0-6-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l2-2A5 5 0 0 0 12 3.9l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></>,
    dots: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    alert: <><path d="M12 3 2.8 19h18.4z"/><path d="M12 9v4m0 3h.01"/></>,
    github: <><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.1-1.5 6.1-6.8a5.3 5.3 0 0 0-1.4-3.7 4.9 4.9 0 0 0-.1-3.7S17.5 1 15 3.4a13 13 0 0 0-7 0C5.5 1 3.3 2.3 3.3 2.3a4.9 4.9 0 0 0-.1 3.7 5.3 5.3 0 0 0-1.4 3.7c0 5.3 3.1 6.5 6.1 6.8A3.4 3.4 0 0 0 7 19v3"/></>,
    slack: <><path d="M9 4v12a2 2 0 0 1-4 0v-2m10 6V8a2 2 0 0 1 4 0v2"/><path d="M4 9h12a2 2 0 0 1 0 4H4a2 2 0 0 1 0-4Zm16 6H8a2 2 0 0 1 0-4h12a2 2 0 0 1 0 4Z"/></>,
    folder: <><path d="M3 6h7l2 2h9v11H3z"/><path d="M3 9h18"/></>,
    shield: <><path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.7 7.5 9.5 4.3-1.8 7.5-4.9 7.5-9.5V6z"/><path d="M12 8v4m0 3h.01"/></>,
    focus: <><path d="M9 3H5a2 2 0 0 0-2 2v4m12-6h4a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h4m6 0h4a2 2 0 0 0 2-2v-4"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const byId = (id: string) => views.find((view) => view.id === id)!;
const fixedFieldNotesViews = new Set<string>();
function ProjectTree({ projectId, viewId, openProject, onToggle, mobile = false }: { projectId: string; viewId: string; openProject: string; onToggle: (id: string) => void; mobile?: boolean }) {
  const childView = (id: string) => id === 'V11' && ['V11','V12','V13','V14'].includes(viewId) ? viewId : id;
  return <div className={`project-tree-container flex flex-[1] flex-col min-h-0 ${mobile ? "mobile-project-tree-container absolute z-[40] top-8.5 right-0 hidden flex-[none] w-[min(300px,_calc(100vw_-_44px))] max-h-[min(70vh,_540px)] overflow-auto m-0 p-2.5 border border-[#e4e4e8] rounded-[8px] bg-[#fff] shadow-[0_12px_28px_rgba(30,31,38,.12)] [&_.tree-toggle]:w-11 [&_.tree-toggle]:h-11 [&_.tree-global]:mt-3" : ""}`}>
    <nav className="project-tree grid gap-1 mt-3.5" aria-label="Project navigation">
      <a className={`tree-overview text-[#686b73] no-underline flex items-center gap-2.25 min-h-9 pt-0 pr-2.25 pb-0 pl-2.25 rounded-[6px] text-[14px] [&_>_span:nth-of-type(1)]:flex-[1] [&:hover]:bg-[#ededf0] [&:hover]:text-[#36373d] [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px] ${viewId === "V01" ? "tree-active bg-[#eeedf6] text-[#48456f]! font-semibold" : ""}`} href={prototypeHref(projectId, 'V01')}><Icon name="grid" size={15}/><span>All projects</span>{projects.filter((project) => project.decision).length > 0 && <span className="tree-overview-count grid place-items-center flex-[none] w-4.5 h-4.5 rounded-[9px] bg-[#f5ebdc] text-[#8c6127] text-[11px]">{projects.filter((project) => project.decision).length}</span>}</a>
      {projects.map((project) => <section className="tree-project min-w-0" key={project.id}>
        <div className="tree-project-head flex items-center gap-0.5"><a className={`tree-project-link text-[#686b73] no-underline flex flex-[1] items-center gap-1.25 min-w-0 min-h-9 pt-0 pr-0.5 pb-0 pl-0.5 rounded-[6px] text-[13px] [&_.project-glyph]:w-5.75 [&_.project-glyph]:h-5.75 [&_.project-glyph]:rounded-[6px] [&_>_span:nth-child(2)]:overflow-hidden [&_>_span:nth-child(2)]:text-ellipsis [&_>_span:nth-child(2)]:whitespace-nowrap [&:hover]:bg-[#ededf0] [&:hover]:text-[#36373d] [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px] ${viewId === "V17" && projectId === project.id ? "tree-active bg-[#eeedf6] text-[#48456f]! font-semibold" : ""}`} href={prototypeHref(project.id, 'V17')}><span className="project-glyph grid place-items-center flex-[none] w-6.5 h-6.5 rounded-[7px] bg-[#eae9f2] text-[#5b568a] text-[14px] font-bold">{project.initial}</span><span>{project.name}</span>{project.decision && <span className="tree-attention grid place-items-center flex-[none] w-4.25 h-4.25 ml-auto rounded-full bg-[#f5ebdc] text-[#8c6127] text-[11px]" aria-label="Decision needed">1</span>}</a><button type="button" className="tree-toggle grid place-items-center flex-[none] w-5.75 h-7.25 border-0 rounded-[5px] bg-transparent text-[#686b73] [&:hover]:bg-[#ededf0] [&[aria-expanded='true']_svg]:rotate-90 [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px]" aria-label={`${openProject === project.id ? 'Collapse' : 'Expand'} ${project.name}`} aria-expanded={openProject === project.id} onClick={() => onToggle(openProject === project.id ? '' : project.id)}><Icon name="chevron" size={14}/></button></div>
      {openProject === project.id && <div className="tree-children grid gap-0.25 mt-0.25 mr-0 mb-1.25 ml-5 pl-2.25 border-l border-l-[#e0e0e4]">{[['V17','Master'],['V03','Work'],['V11','Project settings']].map(([id,label]) => { const target = childView(id!); const selected = projectId === project.id && (target === viewId || id === 'V03' && viewId === 'V05' || id === 'V11' && ['V12','V13','V14'].includes(viewId)); return <a key={id} className={`tree-child text-[#686b73] no-underline min-h-7.25 pt-1 pr-2 pb-1 pl-2 rounded-[5px] text-[13px] [&:hover]:bg-[#ededf0] [&:hover]:text-[#36373d] [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px] ${selected ? "tree-active bg-[#eeedf6] text-[#48456f]! font-semibold" : ""}`} aria-current={selected ? 'page' : undefined} href={prototypeHref(project.id, target)}>{label}</a>; })}</div>}
      </section>)}
    </nav>
    <div className="tree-global [&_a]:text-[#686b73] [&_a]:no-underline [&_a]:pt-1.25 [&_a]:pr-2.25 [&_a]:pb-1.25 [&_a]:pl-2.25 [&_a]:rounded-[5px] [&_a]:text-[13px] [&_a:hover]:bg-[#ededf0] [&_a:hover]:text-[#36373d] grid flex-[none] gap-0.5 mt-auto pt-3.5 border-t border-t-[#e8e8ea] [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-[#817bbd] [&_a:focus-visible]:outline-offset-[2px]"><a href={prototypeHref(projectId, 'V02')}>＋ Add project</a><a className={viewId === "V15" ? "tree-active bg-[#eeedf6] text-[#48456f]! font-semibold" : ""} aria-current={viewId === 'V15' ? 'page' : undefined} href={workspaceSettingsHref('profiles', projectId)}>Workspace settings</a></div>
  </div>;
}
function Status({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'indigo' }) {
  return <Badge variant="outline" className={`status [&[data-slot='badge']]:inline-flex [&[data-slot='badge']]:items-center [&[data-slot='badge']]:gap-1.25 [&[data-slot='badge']]:w-[max-content] [&[data-slot='badge']]:pt-0.75 [&[data-slot='badge']]:pr-1.75 [&[data-slot='badge']]:pb-0.75 [&[data-slot='badge']]:pl-1.75 [&[data-slot='badge']]:rounded-[5px] [&[data-slot='badge']]:border [&[data-slot='badge']]:border-[transparent] [&[data-slot='badge']]:text-[13px] [&[data-slot='badge']]:font-semibold [&[data-slot='badge']]:leading-[1.25] [&.status-neutral]:text-[#686b73] [&.status-neutral]:bg-[#f2f2f3] [&.status-neutral]:border-[#ececef]! [&.status-green]:text-[#39755d] [&.status-green]:bg-[#edf6f1] [&.status-green]:border-[#dcece3]! [&.status-amber]:text-[#916220] [&.status-amber]:bg-[#fbf4e9] [&.status-amber]:border-[#f2e7d2]! [&.status-red]:text-[#a84945] [&.status-red]:bg-[#fbefee] [&.status-red]:border-[#f3dfdd]! [&.status-indigo]:text-[#5d598e] [&.status-indigo]:bg-[#f0eff8] [&.status-indigo]:border-[#e6e4f2]! status-${tone}`}>{children}</Badge>;
}
function Avatar({ initials, tone = 'slate' }: { initials: string; tone?: string }) {
  return <span className={`avatar grid place-items-center flex-[none] w-6.25 h-6.25 border border-[#e5e5e7] rounded-full text-[#686b73] bg-[#f2f2f3] text-[10px] font-semibold [&.avatar-indigo]:text-[#5a5688] [&.avatar-indigo]:bg-[#eeedf7] [&.avatar-indigo]:border-[#e5e3f0] [&.avatar-green]:text-[#477961] [&.avatar-green]:bg-[#edf5f0] [&.avatar-green]:border-[#e0ece4] [&.avatar-slate]:text-[#686b73] [&.avatar-slate]:bg-[#f2f2f3] avatar-${tone}`}>{initials}</span>;
}
function Row({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`list-row flex items-center gap-2.5 min-h-13 border-t border-t-[#ededf0] ${className}`}>{children}</div>;
}
function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="section-block mt-6"><div className="section-heading mb-3 flex items-center justify-between gap-3 [&_h3]:font-semibold [&_h3]:text-sm"><h3>{title}</h3>{action}</div>{children}</section>;
}
function App() {
  const initialRoute = parsePrototypeLocation(window.location.href);
  const [active, setActive] = useState(initialRoute.viewId);
  const [selectedProject, setSelectedProject] = useState(initialRoute.projectId);
  const [openProject, setOpenProject] = useState(initialRoute.projectId);
  const [drawer, setDrawer] = useState(false);
  const [agentWorkId, setAgentWorkId] = useState('FN-51');
  const [drawerTab, setDrawerTab] = useState('Master');
  const [drawerWorkContext, setDrawerWorkContext] = useState<{ projectId: string; workId: string; agentName: string } | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [reviewChoice, setReviewChoice] = useState('');
  const [profileDefault, setProfileDefault] = useState(() => normalizeCodexAccount(sessionStorage.getItem('menoteam-v3-execution-config')));
  const [settingsTab, setSettingsTab] = useState<WorkspaceSettingsTab>(() => settingsTabFromUrl(window.location.href));
  const [routeKey, setRouteKey] = useState(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);
  const settingsTabRef = useRef(settingsTab);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>(() => readSessionValue('menoteam-v3-agent-profiles', initialAgentProfiles));
  const [createdWorks, setCreatedWorks] = useState<Record<string, ProjectWork[]>>(() => readSessionRecord('menoteam-v3-created-works'));
  const [skillDecision, setSkillDecision] = useState('');
  const [drawerMessages, setDrawerMessages] = useState<Record<string, string[]>>({});
  const [drawerDrafts, setDrawerDrafts] = useState<Record<string, string>>({});
  const [masterMessages, setMasterMessages] = useState<Record<string, MasterTurn[]>>(() => {
    const saved = readSessionRecord<MasterTurn[]>('menoteam-v3-master-messages');
    const examples: Record<string, MasterTurn[]> = {
      'field-notes': [{ user: 'Let’s keep this fix focused on invite permissions. Guest access can wait.', reply: 'Understood. I’ll keep guest access out of FN-51 and continue with the invite fix.' }],
      atlas: [{ user: 'Prioritize the original research papers over summaries.', reply: 'I’ll verify the original sources first and keep summaries as supporting context.' }],
      beacon: [{ user: 'Start with the day-shift team. We can add nights after the pilot.', reply: 'I’ll keep the pilot to the day shift and update the handover plan.' }],
    };
    for (const [id, turns] of Object.entries(saved)) if (turns.length) examples[id] = turns;
    return examples;
  });
  const [masterDrafts, setMasterDrafts] = useState(() => readSessionDrafts('menoteam-v3-master-drafts'));
  const [masterDraftAttachments, setMasterDraftAttachments] = useState<Record<string, LocalAttachment[]>>({});
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string>>({});
  const attachmentPool = useLocalAttachmentPool();
  const [projectRuns, setProjectRuns] = useState<Record<string, ProjectRun>>(() => readSessionRecord('menoteam-v3-master-run-state'));
  const currentProject = projects.find((project) => project.id === selectedProject) ?? projects[0]!;
  const drawerProjectId = drawerWorkContext?.projectId ?? (active === 'V17' ? currentProject.id : active === 'V01' ? 'workspace' : 'field-notes');
  const drawerWorkId = drawerWorkContext?.workId ?? (drawerTab.includes('FN-48') ? 'FN-48' : 'FN-51');
  const drawerProject = projects.find((project) => project.id === drawerProjectId);
  const drawerWork = drawerProject?.works.find((work) => work.id === drawerWorkId);
  const drawerContextKey = `${active}:${drawerProjectId}:${drawerTab}:${drawerWorkId}`;
  const currentDrawerMessages = drawerMessages[drawerContextKey] ?? [];
  const currentDrawerDraft = drawerDrafts[drawerContextKey] ?? '';
  const addMasterFiles = (projectId: string, files: File[]) => {
    const result = attachmentPool.addFiles(files, masterDraftAttachments[projectId] ?? []);
    if (!result.error) setMasterDraftAttachments((items) => ({ ...items, [projectId]: [...(items[projectId] ?? []), ...result.attachments] }));
    setAttachmentErrors((errors) => ({ ...errors, [projectId]: result.error ?? '' }));
  };
  const removeMasterAttachment = (projectId: string, id: string) => {
    attachmentPool.release(id);
    setMasterDraftAttachments((items) => ({ ...items, [projectId]: (items[projectId] ?? []).filter((item) => item.id !== id) }));
  };
  const appendMasterDictation = (projectId: string, text: string) => setMasterDrafts((drafts) => {
    const current = drafts[projectId] ?? '';
    return { ...drafts, [projectId]: `${current}${current && !current.endsWith(' ') ? ' ' : ''}${text}` };
  });
  const sendMasterMessageFor = (projectId: string, rawMessage: string, attachments = masterDraftAttachments[projectId] ?? []) => {
    const message = rawMessage.trim();
    if (!message && !attachments.length) return;
    const project = projects.find((item) => item.id === projectId) ?? projects[0]!;
    const run = projectRuns[project.id] ?? defaultProjectRun;
    const reply = run.paused ? 'Message saved. Follow-up is paused and will resume from the current Work state.' : run.host === 'sleeping' ? 'Message saved. The local host is asleep; existing Work will resume when it comes back online.' : 'Got it. I’ll coordinate the existing Work around this priority.';
    const user = message || `Shared ${attachments.length} ${attachments.length === 1 ? 'file' : 'files'}.`;
    setMasterMessages((items) => ({ ...items, [project.id]: [...(items[project.id] ?? []), { user, reply, time: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), ...(attachments.length ? { attachments } : {}) }] }));
    setMasterDrafts((drafts) => ({ ...drafts, [project.id]: '' }));
    setMasterDraftAttachments((items) => ({ ...items, [project.id]: [] }));
    setAttachmentErrors((errors) => ({ ...errors, [project.id]: '' }));
  };
  const toggleExpand = (key: string) => setExpanded((values) => values.includes(key) ? values.filter((value) => value !== key) : [...values, key]);
  const syncRoute = (href: string, push = true) => {
    const url = new URL(href, window.location.href);
    if (push) window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    setRouteKey(`${url.pathname}${url.search}${url.hash}`);
    const next = parsePrototypeLocation(url);
    if (next.viewId === 'V03' && url.searchParams.has('work')) { setQuery(''); setFilter('All'); }
    const nextSettingsTab = settingsTabFromUrl(url);
    setSelectedProject(next.projectId); setOpenProject(next.projectId); setActive(next.viewId);
    settingsTabRef.current = nextSettingsTab; setSettingsTab(nextSettingsTab); setDrawer(false);
    requestAnimationFrame(() => document.getElementById(`review-${next.viewId}`)?.scrollIntoView({ behavior: 'auto', block: 'start' }));
  };
  const jumpTo = (id: string, projectId = selectedProject) => {
    const routeProject = fixedFieldNotesViews.has(id) ? 'field-notes' : projectId;
    const nextSettingsTab = id === 'V07' ? 'accounts' : id === 'V15' ? settingsTabRef.current === 'profiles' ? 'profiles' : 'accounts' : settingsTabRef.current;
    const href = id === 'V07' || id === 'V15' ? workspaceSettingsHref(nextSettingsTab, routeProject) : prototypeHref(routeProject, id);
    syncRoute(href);
  };
  const scrollToView = jumpTo;
  useEffect(() => {
    const route = parsePrototypeLocation(window.location.href);
    let restoringInitialRoute = true;
    requestAnimationFrame(() => {
      document.getElementById(`review-${route.viewId}`)?.scrollIntoView({ behavior: 'auto', block: 'start' });
      restoringInitialRoute = false;
    });
    const restoreRoute = () => syncRoute(window.location.href, false);
    window.addEventListener('popstate', restoreRoute);
    const interceptPrototypeLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement) || target.target || target.hasAttribute('download')) return;
      const url = new URL(target.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return;
      if (!url.searchParams.has('view') && !url.hash) return;
      event.preventDefault();
      syncRoute(url.href);
    };
    document.addEventListener('click', interceptPrototypeLink);
    const labels = [...document.querySelectorAll<HTMLElement>('.review-view-label[data-view-id]')];
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const viewId = (visible?.target as HTMLElement | undefined)?.dataset.viewId;
      if (viewId && !restoringInitialRoute) {
        setActive(viewId);
        const frame = document.getElementById(`review-${viewId}`);
        const projectId = frame?.dataset.projectId ?? parsePrototypeLocation(window.location.href).projectId;
        const url = new URL(window.location.href);
        const currentRoute = parsePrototypeLocation(url);
        if (currentRoute.projectId !== projectId || currentRoute.viewId !== viewId || url.searchParams.get('view') === 'V04' || url.hash === '#label-V04') {
          const href = viewId === 'V15'
            ? workspaceSettingsHref(settingsTabRef.current === 'profiles' ? 'profiles' : 'accounts', projectId)
            : prototypeHref(projectId, viewId);
          window.history.replaceState(null, '', href);
          const normalized = new URL(href, window.location.href);
          setRouteKey(`${normalized.pathname}${normalized.search}${normalized.hash}`);
        }
      }
    }, { rootMargin: '-70px 0px -62% 0px', threshold: [0, .15, .35, .6] });
    labels.forEach((label) => observer.observe(label));
    return () => { observer.disconnect(); window.removeEventListener('popstate', restoreRoute); document.removeEventListener('click', interceptPrototypeLink); };
  }, []);
  useEffect(() => {
    const globalView = ['V01','V02','V07','V15'].includes(active);
    document.title = active === 'V01' ? 'Workspace · All projects · Menoteam' : `${globalView ? 'Workspace' : projects.find((project) => project.id === selectedProject)?.name ?? 'Workspace'} · ${byId(active).nav} · Menoteam`;
  }, [active, selectedProject]);
  useEffect(() => {
    const stored = Object.fromEntries(Object.entries(masterMessages).map(([projectId, turns]) => [
      projectId,
      turns.map((turn) => ({ ...turn, ...(turn.attachments ? { attachments: turn.attachments.map(attachmentMetadata) } : {}) })),
    ]));
    sessionStorage.setItem('menoteam-v3-master-messages', JSON.stringify(stored));
  }, [masterMessages]);
  useEffect(() => { sessionStorage.setItem('menoteam-v3-master-drafts', JSON.stringify(masterDrafts)); }, [masterDrafts]);
  useEffect(() => { sessionStorage.removeItem('menoteam-v3-master-draft-attachments'); }, []);
  useEffect(() => { sessionStorage.setItem('menoteam-v3-master-run-state', JSON.stringify(projectRuns)); }, [projectRuns]);
  useEffect(() => { sessionStorage.setItem('menoteam-v3-agent-profiles', JSON.stringify(agentProfiles)); }, [agentProfiles]);
  useEffect(() => { sessionStorage.setItem('menoteam-v3-created-works', JSON.stringify(createdWorks)); }, [createdWorks]);
  useEffect(() => { sessionStorage.setItem('menoteam-v3-execution-config', profileDefault); }, [profileDefault]);
  const projectWorks = [...currentProject.works, ...(createdWorks[currentProject.id] ?? [])];
  const filteredWork = projectWorks.filter((item) => {
    const complete = item.status === 'Done';
    const paused = item.status === 'Paused';
    const running = !complete && !paused && item.status !== 'Queued';
    const visible = filter === 'All' || filter === 'In progress' && running || filter === 'Paused' && paused || filter === 'Done' && complete;
    return visible && `${item.title} ${item.outcome} ${item.agent}`.toLowerCase().includes(query.toLowerCase());
  });
  const createProjectWork = (projectId: string, title: string, profileId: string) => {
    const selectedProfile = agentProfiles.find((profile) => profile.id === profileId);
    const prefix = ({ 'field-notes': 'FN', atlas: 'AT', beacon: 'BC' } as Record<string, string>)[projectId] ?? 'WK';
    setCreatedWorks((items) => {
      const existing = [...(projects.find((project) => project.id === projectId)?.works ?? []), ...(items[projectId] ?? [])];
      const lastId = existing.reduce((last, work) => Math.max(last, Number(work.id.match(new RegExp(`^${prefix}-(\\d+)$`))?.[1] ?? 0)), 0);
      const work: ProjectWork = { id: `${prefix}-${lastId + 1}`, title, outcome: 'Goal recorded. Waiting for Master to assign it.', status: 'Unassigned', tone: 'neutral', next: 'Master to assign', agent: selectedProfile?.name ?? 'Master to assign', executionConfig: profileDefault, ...(selectedProfile ? { profileId: selectedProfile.id } : {}) };
      return { ...items, [projectId]: [...(items[projectId] ?? []), work] };
    });
  };

  return <div className="review-page min-h-screen text-foreground [&_button]:cursor-pointer [&_button:disabled]:cursor-not-allowed [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-ring [&_button:focus-visible]:outline-offset-2 [&_select]:rounded-md [&_select]:border [&_select]:border-input [&_select]:bg-background [&_select]:p-2 [&_textarea]:text-foreground [&_summary]:cursor-pointer">
    <header className="review-toolbar h-12.5 sticky top-0 z-[30] flex items-center justify-between pt-0 pr-[clamp(16px,] pb-[3vw,] pl-[42px)] bg-[rgba(250,250,251,.97)] border-b border-b-[#e5e5e8] text-[#686b73] text-[14px] [&_select]:appearance-none [&_select]:border [&_select]:border-[#e2e2e5] [&_select]:rounded-[6px] [&_select]:bg-[#fff] [&_select]:text-[#4e5058] [&_select]:pt-1.25 [&_select]:pr-6.25 [&_select]:pb-1.25 [&_select]:pl-2.25 [&_select]:max-w-[245px] [&_select]:text-[14px] max-[800px]:h-11.75 max-[800px]:pt-0 max-[800px]:pr-3 max-[800px]:pb-0 max-[800px]:pl-3 max-[800px]:[&_select]:max-w-[150px] max-[560px]:[&_select]:max-w-[116px] max-[560px]:[&_select]:text-[13px]">
      <div className="review-mark flex items-center gap-2.25 font-semibold tracking-[.01em] text-[#484a51] max-[560px]:gap-1.5 max-[560px]:text-[13px]"><span className="review-mark-dot w-1.75 h-1.75 rounded-full bg-[#7772b3]" />Workbench <span className="review-version">V3</span></div><span className="review-toolbar-note max-[560px]:flex-[1] max-[560px]:overflow-hidden max-[560px]:ml-2 max-[560px]:text-[#696d64] max-[560px]:text-[11px] max-[560px]:text-ellipsis max-[560px]:whitespace-nowrap text-[#696d64] text-[12px] whitespace-nowrap">Prototype · sample data</span>
      <div className="review-toolbar-actions flex items-center gap-2.25 max-[560px]:gap-1.25">
        <label className="jump-label text-[#686b73] max-[800px]:hidden" htmlFor="view-jump">Go to view</label>
        <select id="view-jump" value={active} onChange={(event) => jumpTo(event.target.value)}>
          {views.map((view) => <option value={view.id} key={view.id}>{view.id} · {view.id === 'V03' ? 'Project · Work' : view.id === 'V11' ? `${projects.find((project) => project.id === selectedProject)?.name} · Project settings` : view.title}</option>)}
        </select>
        <span className="review-count text-[#686b73] tabular-nums min-w-[30px] max-[560px]:hidden">{views.findIndex((view) => view.id === active) + 1} / {views.length}</span>
      </div>
    </header>
    <main className="review-stack grid gap-10 p-5 md:p-7">
      {views.map((view) => { const frameProjectId = fixedFieldNotesViews.has(view.id) ? 'field-notes' : selectedProject; const frameProject = projects.find((project) => project.id === frameProjectId) ?? projects[0]!; const shellName = view.id === 'V01' || ['V02','V07','V15'].includes(view.id) ? 'Workspace' : frameProject.name; const viewTitle = view.id === 'V03' ? `${frameProject.name} · Work` : view.id === 'V11' ? `${frameProject.name} · Project settings` : view.id === 'V15' ? 'Workspace settings' : view.id === 'V07' ? 'Workspace settings · Local environment' : view.title; return <article className="review-view scroll-mt-16" id={`review-${view.id}`} data-project-id={frameProjectId} key={view.id}>
        <div className="review-view-label mb-3 flex items-center gap-3 text-sm text-muted-foreground [&>span:first-child]:rounded [&>span:first-child]:bg-border [&>span:first-child]:px-1.5 [&>span:first-child]:font-semibold [&_h2]:font-semibold [&_h2]:text-foreground" id={view.id === 'V01' ? 'project-work' : view.id === 'V17' ? 'project-master' : view.id === 'V03' ? 'work-list' : `label-${view.id}`} data-view-id={view.id}><span>{view.id}</span><h2>{viewTitle}</h2><span className="review-area pl-2 border-l border-l-[#dddde2] text-[#686b73] max-[560px]:hidden">{view.area}</span></div>
        <div className="app-window grid min-h-[680px] grid-cols-[190px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-border bg-background max-[800px]:grid-cols-1">
          <aside className="sidebar flex min-w-0 flex-col border-r border-border bg-muted/60 p-3 max-[800px]:hidden">
            <div className="brand-row flex items-center gap-2 px-2 pb-5 pt-2 font-semibold"><span className="brand-mark grid size-6 shrink-0 place-items-center rounded-md bg-zinc-800 text-white"><Icon name="grid" size={15}/></span><span className="brand-name text-base font-bold tracking-tight">menoteam</span></div>
            <ProjectTree projectId={frameProjectId} viewId={view.id} openProject={openProject} onToggle={setOpenProject}/>
            <div className="sidebar-user mt-3.5 flex items-center gap-2 pt-2.75 pr-1.5 pb-0.5 pl-1.5 border-t border-t-[#e8e8ea] [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_strong]:text-[13px] [&_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px] [&_>_svg]:text-[#686b73]"><Avatar initials="YL" tone="indigo"/><span><strong>Yili Lin</strong><small>Workspace</small></span><Icon name="dots" size={16}/></div>
          </aside>
          <div className="app-main min-w-0 bg-background">
            <div className="mobile-project-bar hidden max-[800px]:relative max-[800px]:flex max-[800px]:items-center max-[800px]:gap-2 max-[800px]:h-10.5 max-[800px]:pt-0 max-[800px]:pr-3.75 max-[800px]:pb-0 max-[800px]:pl-3.75 max-[800px]:border-b max-[800px]:border-b-[#ececef] max-[800px]:bg-[#f6f6f7] max-[800px]:[&_.brand-mark]:w-5 max-[800px]:[&_.brand-mark]:h-5 max-[800px]:[&_strong]:text-[13px] max-[800px]:[&_strong]:font-semibold"><span className="brand-mark grid size-6 shrink-0 place-items-center rounded-md bg-zinc-800 text-white"><Icon name="grid" size={14}/></span><strong>{shellName}</strong><details className="mobile-tree-menu relative ml-auto [&_>_summary]:pt-1 [&_>_summary]:pr-2 [&_>_summary]:pb-1 [&_>_summary]:pl-2 [&_>_summary]:border [&_>_summary]:border-[#e2e2e5] [&_>_summary]:rounded-[5px] [&_>_summary]:bg-[#fff] [&_>_summary]:text-[#555760] [&_>_summary]:text-[13px] [&_>_summary]:cursor-pointer [&_>_summary::-webkit-details-marker]:hidden [&[open]_>_.mobile-project-tree-container]:flex"><summary>Projects and pages</summary><ProjectTree projectId={frameProjectId} viewId={view.id} openProject={openProject} onToggle={setOpenProject} mobile/></details></div>
            <div className="app-topbar flex min-h-12 items-center gap-3 border-b border-border px-7 py-3 max-[640px]:px-4"><nav className="breadcrumbs flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground [&_a]:no-underline [&_a:hover]:underline [&_a]:underline-offset-4" aria-label="Breadcrumb">{view.id === 'V05' ? <>
              <a href={prototypeHref(frameProjectId, 'V17')}>{frameProject.name}</a><Icon name="chevron" size={13}/><a href={prototypeHref(frameProjectId, 'V03')}>Work</a><Icon name="chevron" size={13}/><strong aria-current="page">{selectedDetailWork([...frameProject.works, ...(createdWorks[frameProject.id] ?? [])], routeKey)?.id}</strong>
            </> : ['V11','V12','V13','V14'].includes(view.id) ? <>
              <a href={prototypeHref(frameProjectId, 'V17')}>{frameProject.name}</a><Icon name="chevron" size={13}/><a href={prototypeHref(frameProjectId, 'V11')}>Project settings</a><Icon name="chevron" size={13}/><strong aria-current="page">{view.nav}</strong>
            </> : view.id === 'V15' ? <>
              <a href={prototypeHref(frameProjectId, 'V01')}>Workspace</a><Icon name="chevron" size={13}/><a href={workspaceSettingsHref('profiles', frameProjectId)}>Workspace settings</a><Icon name="chevron" size={13}/><strong aria-current="page">{settingsTab === 'accounts' ? 'Model providers' : 'Agent profiles'}</strong>
            </> : <><a href={prototypeHref(frameProjectId, ['V01','V02'].includes(view.id) ? 'V01' : 'V17')}>{shellName}</a><Icon name="chevron" size={13}/><strong aria-current="page">{view.nav}</strong></>}</nav></div>
            <div className={`work-area relative flex min-h-[632px] min-w-0 ${drawer && active === view.id ? "drawer-open [&_.view-content]:w-[calc(100%_-_365px)] max-[1050px]:[&_.view-content]:w-[calc(100%_-_320px)] max-[800px]:[&_.view-content]:w-full" : ""}`}>
              <div className="view-content @container/work-content w-full min-w-0 p-8 max-[640px]:p-4">{renderView({ view, routeKey, agentWorkId, setAgentWorkId, filteredWork: frameProjectId === currentProject.id ? filteredWork : [...frameProject.works, ...(createdWorks[frameProject.id] ?? [])], query, setQuery, filter, setFilter, jumpTo: (id) => jumpTo(id, frameProjectId), openDrawer: (tab = 'Master', workContext) => { if (tab === 'Master' && !fixedFieldNotesViews.has(view.id) && view.id !== 'V17') { jumpTo('V17', frameProjectId); return; } setDrawerTab(tab); setDrawerWorkContext(workContext ?? null); setDrawer(true); }, expanded, toggleExpand, reviewChoice, setReviewChoice, profileDefault, setProfileDefault, settingsTab, skillDecision, setSkillDecision, project: frameProject, projectWorks: [...frameProject.works, ...(createdWorks[frameProject.id] ?? [])], createProjectWork, agentProfiles, saveAgentProfile: (profile) => setAgentProfiles((profiles) => profiles.some((item) => item.id === profile.id) ? profiles.map((item) => item.id === profile.id ? profile : item) : [...profiles, profile]), projectRun: projectRuns[frameProject.id] ?? defaultProjectRun, updateProjectRun: (patch) => setProjectRuns((runs) => ({ ...runs, [frameProject.id]: { ...(runs[frameProject.id] ?? defaultProjectRun), ...patch } })), masterMessages: masterMessages[frameProject.id] ?? [], masterDraft: masterDrafts[frameProject.id] ?? '', setMasterDraft: (value) => setMasterDrafts((drafts) => ({ ...drafts, [frameProject.id]: value })), sendMasterMessage: () => sendMasterMessageFor(frameProject.id, masterDrafts[frameProject.id] ?? '', masterDraftAttachments[frameProject.id] ?? []), projectMasterMessages: masterMessages, projectMasterDrafts: masterDrafts, projectMasterAttachments: masterDraftAttachments, attachmentErrors, addProjectMasterFiles: addMasterFiles, removeProjectMasterAttachment: removeMasterAttachment, appendProjectMasterDictation: appendMasterDictation, masterComposerActive: (view.id === 'V01' || view.id === 'V17') && active === view.id && (view.id === 'V01' || frameProjectId === selectedProject), setProjectMasterDraft: (projectId, value) => setMasterDrafts((drafts) => ({ ...drafts, [projectId]: value })), sendProjectMasterMessage: sendMasterMessageFor })}</div>
              {drawer && active === view.id && <aside className="context-drawer sticky top-0 flex flex-[0_0_365px] flex-col w-91.25 max-h-[632px] min-h-158 pt-5.25 pr-4.75 pb-4 pl-4.75 border-l border-l-[#e8e8eb] bg-[#fcfcfd] max-[1050px]:basis-[320px] max-[1050px]:w-80 max-[800px]:absolute max-[800px]:z-[5] max-[800px]:top-0 max-[800px]:right-0 max-[800px]:bottom-0 max-[800px]:w-[min(365px,_100%)] max-[800px]:min-h-full max-[800px]:max-h-[none] max-[800px]:border-l max-[800px]:border-l-[#e8e8eb] max-[800px]:shadow-[-8px_0_20px_rgba(30,31,38,.06)]" aria-label={`${drawerTab} conversation`}>
                <div className="drawer-head flex items-start justify-between pb-4.5 border-b border-b-[#ebebed] [&_h3]:mt-0.75 [&_h3]:mr-0 [&_h3]:mb-0 [&_h3]:ml-0 [&_h3]:text-[17px] [&_h3]:font-semibold [&_h3]:tracking-[-.02em]"><div><h3>{drawerTab}</h3></div><button className="icon-button grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setDrawer(false)} aria-label="Close drawer"><Icon name="close"/></button></div>
                <div className="drawer-thread flex gap-2.25 pt-4.75 pr-0 pb-4 pl-0"><div className="message-avatar grid place-items-center flex-[none] w-6.25 h-6.25 rounded-[7px] master-avatar text-[#625d91] bg-[#eeedf6] w-5.75 h-5.75 border-[#e5e3f0]"><Icon name={drawerTab === 'Master' ? 'spark' : 'agents'} size={14}/></div><div className="message min-w-0 text-[#565860] text-[14px] leading-[1.65] [&_p]:mt-0 [&_p]:mr-0 [&_p]:mb-3 [&_p]:ml-0"><div className="message-meta flex gap-2 items-baseline mb-1.25 [&_strong]:text-[#34353a] [&_strong]:text-[14px] [&_strong]:font-semibold [&_span]:text-[#686b73] [&_span]:text-[13px]"><strong>{drawerTab}</strong></div><p>{drawerWorkContext ? `${drawerWorkContext.agentName} is responsible for ${drawerWorkContext.workId} in ${drawerProject?.name ?? 'this project'}. This conversation stays with that Work.` : drawerWorkId === 'FN-51' ? drawerTab === 'Master' ? 'The FN-51 fix plan needs your review. Restricted changes wait for approval; other Work can continue.' : 'The FN-51 fix is waiting on scope review. Restricted permission paths stay unchanged until approval; allowed checks can continue.' : drawerTab === 'Master' ? 'FN-48 passed required checks. Master is tracking post-deploy verification. Routine QA failures return to the responsible Agent.' : 'If FN-48 fails a later QA check, it returns to the responsible Agent for a fix and another check.'}</p>{!drawerWorkContext && (drawerWorkId === 'FN-51' ? <button className="evidence-link flex items-center gap-2 mt-2.75 mr-0 mb-2.75 ml-0 pt-2.25 pr-2 pb-2.25 pl-2 bg-[#fff] border border-[#e8e8eb] rounded-[7px] cursor-pointer [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_strong]:text-[#464850] [&_strong]:text-[13px] [&_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px] [&_>_svg]:text-[#686b73]" type="button" onClick={() => scrollToView('V08')}><span className="evidence-icon grid place-items-center flex-[none] w-6.75 h-6.75 rounded-[6px] bg-[#f1f1f4] text-[#686b73]"><Icon name="quality" size={14}/></span><span><strong>Permission regression · failed check</strong><small>FN-51 · QA evidence</small></span><Icon name="external" size={14}/></button> : <div className="evidence-link flex items-center gap-2 mt-2.75 mr-0 mb-2.75 ml-0 pt-2.25 pr-2 pb-2.25 pl-2 bg-[#fff] border border-[#e8e8eb] rounded-[7px] cursor-pointer [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_strong]:text-[#464850] [&_strong]:text-[13px] [&_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px] [&_>_svg]:text-[#686b73]" aria-label="FN-48 quality status"><span className="evidence-icon grid place-items-center flex-[none] w-6.75 h-6.75 rounded-[6px] bg-[#f1f1f4] text-[#686b73]"><Icon name="quality" size={14}/></span><span><strong>Invite link · required checks passed</strong><small>FN-48 · Post-deploy verification pending</small></span></div>)}{currentDrawerMessages.map((message, index) => <div className="sample-answer mt-3 mr-0 mb-0.5 ml-0 p-2.25 border border-[#e8e7f0] rounded-[6px] bg-[#fbfaff] text-[#686b73] text-[13px] [&_strong]:text-[#54516e] [&_strong]:text-[13px] [&_strong]:font-semibold [&_p]:mt-1.25 [&_p]:mr-0 [&_p]:mb-1 [&_p]:ml-0 [&_p]:leading-[1.55] [&_small]:text-[#686b73] [&_small]:text-[13px]" key={`${index}-${message}`}><strong>You: {message}</strong><p>{drawerWorkContext ? `${drawerWorkContext.agentName} will continue within ${drawerProject?.name ?? 'this project'} · ${drawerWorkId}.` : drawerWorkId === 'FN-51' ? 'I’ll wait for your scope decision. Other Work can continue.' : 'The responsible Agent will fix and recheck under the project rules; I’ll track the integration.'}</p></div>)}</div></div>
                <div className="drawer-context mt-auto border-t border-t-[#ebebed] pt-3 pr-0 pb-3 pl-0 [&_button]:flex [&_button]:items-center [&_button]:gap-1.75 [&_button]:w-full [&_button]:pt-2 [&_button]:pr-0 [&_button]:pb-0 [&_button]:pl-0 [&_button]:border-0 [&_button]:bg-[none] [&_button]:text-inherit [&_button]:font-sans [&_button]:text-[13px] [&_button]:text-left [&_button]:no-underline [&_a]:flex [&_a]:items-center [&_a]:gap-1.75 [&_a]:w-full [&_a]:pt-2 [&_a]:pr-0 [&_a]:pb-0 [&_a]:pl-0 [&_a]:border-0 [&_a]:bg-[none] [&_a]:text-inherit [&_a]:font-sans [&_a]:text-[13px] [&_a]:text-left [&_a]:no-underline [&_button_>_span:nth-child(2)]:flex-[1] [&_a_>_span:nth-child(2)]:flex-[1]"><span className="context-label text-[#686b73] text-[13px] tracking-[.08em] font-semibold">LINKED WORK</span><a href={projectWorkHref(drawerProjectId, drawerWorkId)}><span className="work-key text-[#686b73] text-[13px] font-semibold tabular-nums">{drawerWorkId}</span><span>{drawerWork?.title ?? 'Open Work'}</span><Icon name="chevron" size={13}/></a></div>
                <form className="composer mt-2 p-2 border border-[#e4e4e8] rounded-[8px] bg-[white] [&_textarea]:w-full [&_textarea]:min-h-13.75 [&_textarea]:resize-y [&_textarea]:border-0 [&_textarea]:outline-none [&_textarea]:text-[#383940] [&_textarea]:text-[14px] [&_textarea::placeholder]:text-[#686b73]" onSubmit={(event) => { event.preventDefault(); if (currentDrawerDraft.trim()) { setDrawerMessages((messages) => ({ ...messages, [drawerContextKey]: [...(messages[drawerContextKey] ?? []), currentDrawerDraft.trim()] })); setDrawerDrafts((drafts) => ({ ...drafts, [drawerContextKey]: '' })); } }}><textarea aria-label={`Ask ${drawerTab} about ${drawerWorkId}`} value={currentDrawerDraft} onChange={(event) => setDrawerDrafts((drafts) => ({ ...drafts, [drawerContextKey]: event.target.value }))} placeholder={`Ask ${drawerTab} about ${drawerWorkId}…`} /><div className="composer-footer flex items-center justify-between gap-2 text-[#686b73] text-[13px]"><span>{projects.find((project) => project.id === drawerProjectId)?.name ?? 'Workspace'} · {drawerWorkId}</span><Button type="submit" size="sm" className="dark-button border-primary bg-primary text-primary-foreground hover:bg-primary/90" disabled={!currentDrawerDraft.trim()}>Send <Icon name="arrow" size={14}/></Button></div></form>
              </aside>}
            </div>
          </div>
        </div>
      </article>; })}
    </main>
  </div>;
}
export default App;

type RenderProps = {
  view: View; routeKey: string; agentWorkId: string; setAgentWorkId: (id: string) => void; filteredWork: ProjectWork[]; query: string; setQuery: (value: string) => void; filter: string; setFilter: (value: string) => void;
  jumpTo: (id: string) => void; openDrawer: (tab?: string, work?: { projectId: string; workId: string; agentName: string }) => void; expanded: string[]; toggleExpand: (key: string) => void;
  reviewChoice: string; setReviewChoice: (value: string) => void; profileDefault: string; setProfileDefault: (value: string) => void; settingsTab: WorkspaceSettingsTab;
  skillDecision: string; setSkillDecision: (value: string) => void;
  projectWorks: ProjectWork[]; createProjectWork: (projectId: string, title: string, profileId: string) => void; agentProfiles: AgentProfile[]; saveAgentProfile: (profile: AgentProfile) => void;
  project: Project; projectRun: ProjectRun; updateProjectRun: (patch: Partial<ProjectRun>) => void; masterMessages: MasterTurn[]; masterDraft: string; setMasterDraft: (value: string) => void; sendMasterMessage: () => void;
  projectMasterMessages: Record<string, MasterTurn[]>; projectMasterDrafts: Record<string, string>; projectMasterAttachments: Record<string, LocalAttachment[]>; attachmentErrors: Record<string, string>; addProjectMasterFiles: (projectId: string, files: File[]) => void; removeProjectMasterAttachment: (projectId: string, id: string) => void; appendProjectMasterDictation: (projectId: string, text: string) => void; masterComposerActive: boolean; setProjectMasterDraft: (projectId: string, value: string) => void; sendProjectMasterMessage: (projectId: string, message: string, attachments?: LocalAttachment[]) => void;
};

function PageHeading({ title, description, action, meta }: { title: string; description?: string; action?: React.ReactNode; meta?: React.ReactNode }) {
  return <div className="page-heading mb-6 flex items-start justify-between gap-5 max-[640px]:flex-wrap [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:leading-tight [&_p]:mt-1.5 [&_p]:max-w-[68ch] [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground"><div><h1>{title}</h1></div>{action && <div className="heading-actions flex flex-wrap items-center justify-end gap-2">{action}</div>}</div>;
}
function WorkRow({ item, onOpen, href }: { item: ProjectWork; onOpen?: () => void; href?: string }) {
  const content = <><span className="work-key text-[#686b73] text-[13px] font-semibold tabular-nums">{item.id}</span><span className="work-copy min-w-0 grid items-center gap-0.5 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:text-[#393a40] [&_strong]:text-[13px] [&_strong]:font-semibold [&_strong]:whitespace-nowrap [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:text-[#686b73] [&_small]:text-[13px] [&_small]:whitespace-nowrap max-[560px]:[&_strong]:whitespace-normal max-[560px]:[&_strong]:leading-[1.35]"><strong>{item.title}</strong><small>{item.outcome}</small></span><span className="work-owner min-w-0 flex items-center gap-1.75 text-[#686b73] text-[13px] whitespace-nowrap [&_.avatar]:w-5.25 [&_.avatar]:h-5.25 [&_.avatar]:text-[12px] max-[1050px]:text-[13px] max-[1050px]:[&_.avatar]:w-4.75 max-[1050px]:[&_.avatar]:h-4.75 max-[560px]:hidden">{item.agent}</span><Status tone={item.tone}>{item.status}</Status>{(onOpen || href) && <Icon name="chevron" size={15}/>}</>;
  return href ? <a className="work-row grid grid-cols-[max-content_minmax(0,1fr)_minmax(112px,max-content)_max-content_18px] items-center gap-2.5 w-full min-h-16 pt-2.25 pr-0.5 pb-2.25 pl-0.5 text-left border-0 border-b border-b-[#f0f0f2] bg-[white] [&:hover]:bg-[#fafafd] [&_>_svg]:text-[#686b73] max-[1050px]:grid-cols-[max-content_minmax(0,1fr)_minmax(105px,max-content)_max-content_14px] max-[1050px]:gap-1.75 max-[560px]:grid-cols-[max-content_minmax(0,1fr)_15px] max-[560px]:grid-rows-[auto_auto] max-[560px]:min-h-17 max-[560px]:gap-[3px_7px] max-[560px]:[&_>_.status]:col-[2] max-[560px]:[&_>_.status]:row-[2] max-[560px]:[&_>_svg]:col-[3] max-[560px]:[&_>_svg]:row-[1] [&[href]]:text-inherit [&[href]]:no-underline" href={href}>{content}</a> : onOpen ? <button type="button" className="work-row grid grid-cols-[max-content_minmax(0,1fr)_minmax(112px,max-content)_max-content_18px] items-center gap-2.5 w-full min-h-16 pt-2.25 pr-0.5 pb-2.25 pl-0.5 text-left border-0 border-b border-b-[#f0f0f2] bg-[white] [&:hover]:bg-[#fafafd] [&_>_svg]:text-[#686b73] max-[1050px]:grid-cols-[max-content_minmax(0,1fr)_minmax(105px,max-content)_max-content_14px] max-[1050px]:gap-1.75 max-[560px]:grid-cols-[max-content_minmax(0,1fr)_15px] max-[560px]:grid-rows-[auto_auto] max-[560px]:min-h-17 max-[560px]:gap-[3px_7px] max-[560px]:[&_>_.status]:col-[2] max-[560px]:[&_>_.status]:row-[2] max-[560px]:[&_>_svg]:col-[3] max-[560px]:[&_>_svg]:row-[1] [&[href]]:text-inherit [&[href]]:no-underline" onClick={onOpen}>{content}</button> : <div className="work-row grid grid-cols-[max-content_minmax(0,1fr)_minmax(112px,max-content)_max-content_18px] items-center gap-2.5 w-full min-h-16 pt-2.25 pr-0.5 pb-2.25 pl-0.5 text-left border-0 border-b border-b-[#f0f0f2] bg-[white] [&:hover]:bg-[#fafafd] [&_>_svg]:text-[#686b73] max-[1050px]:grid-cols-[max-content_minmax(0,1fr)_minmax(105px,max-content)_max-content_14px] max-[1050px]:gap-1.75 max-[560px]:grid-cols-[max-content_minmax(0,1fr)_15px] max-[560px]:grid-rows-[auto_auto] max-[560px]:min-h-17 max-[560px]:gap-[3px_7px] max-[560px]:[&_>_.status]:col-[2] max-[560px]:[&_>_.status]:row-[2] max-[560px]:[&_>_svg]:col-[3] max-[560px]:[&_>_svg]:row-[1] [&[href]]:text-inherit [&[href]]:no-underline">{content}</div>;
}
function RelatedSources({ projectId, workId, focusSourceId = '' }: { projectId: string; workId: string; focusSourceId?: string }) {
  const linked = relatedSourcesForWork(projectId, workId);
  const candidates = candidateSourcesForWork(projectId, workId);
  if (!linked.length && !candidates.length) return null;
  return <details className="work-sources mt-1.75 border-t border-t-[#e8eae4] [&_>_summary]:min-h-9.5 [&_>_summary]:pt-2.5 [&_>_summary]:pr-0 [&_>_summary]:pb-2.5 [&_>_summary]:pl-0 [&_>_summary]:text-[#4f5b48] [&_>_summary]:text-[12px] [&_>_summary]:font-semibold [&_>_summary]:cursor-pointer" open={Boolean(focusSourceId)}>
    <summary>Sample sources · internal details · {linked.length + candidates.length}</summary>
    {linked.map((source) => <details className={`work-source grid gap-1.25 pt-2 pr-0 pb-2 pl-0 border-t border-t-[#eef0eb] [&_>_summary]:flex [&_>_summary]:items-baseline [&_>_summary]:flex-wrap [&_>_summary]:gap-[4px_9px] [&_>_summary]:text-[#454a42] [&_>_summary]:text-[12px] [&_>_summary]:cursor-pointer [&_>_div:first-child]:flex [&_>_div:first-child]:items-baseline [&_>_div:first-child]:flex-wrap [&_>_div:first-child]:gap-[4px_9px] [&_>_div:first-child]:text-[#454a42] [&_>_div:first-child]:text-[12px] [&_>_div:first-child]:cursor-pointer [&_>_summary_small]:ml-auto [&_>_summary_small]:text-[#74796f] [&_>_summary_small]:text-[11px] [&_>_div:first-child_small]:ml-auto [&_>_div:first-child_small]:text-[#74796f] [&_>_div:first-child_small]:text-[11px] [&_blockquote]:m-0 [&_blockquote]:pt-1.75 [&_blockquote]:pr-2.5 [&_blockquote]:pb-1.75 [&_blockquote]:pl-2.5 [&_blockquote]:border [&_blockquote]:border-[#edeee9] [&_blockquote]:rounded-[5px] [&_blockquote]:text-[#43473f] [&_blockquote]:text-[13px] [&_blockquote]:leading-[1.5] ${source.id === focusSourceId ? "source-focused bg-[#fbfcf8]" : ""}`} key={source.id} open={source.id === focusSourceId}>
      <summary><span className="source-kind text-[#646d5e] font-semibold">{source.type}</span><strong>{source.location}</strong><small>{source.author} · {source.time}</small></summary>
      <p className="source-excerpt m-0 text-[#62665e] text-[12px] leading-[1.45]">{source.excerpt}</p>
      <blockquote>{source.original}</blockquote>
      <p className="source-handling m-0 text-[#62665e] text-[12px] leading-[1.45]">Linked to {workId} · Responsible Agent: {source.responsibleAgent}{source.handling ? ` · ${source.handling}` : ''}</p>
      <div className="source-actions [&_button]:p-0 [&_button]:border-0 [&_button]:bg-transparent [&_button]:text-[#56634d] [&_button]:font-sans [&_button]:text-[12px] [&_button]:underline [&_button]:underline-offset-[2px] [&_button]:cursor-pointer flex flex-wrap gap-[5px_13px] text-[12px] [&_a]:text-[#56634d] [&_a]:underline [&_a]:underline-offset-[2px]"><a href={projectSourceHref(projectId, workId, source.id)}>Open source detail</a><a href={projectWorkHref(projectId, workId)}>Back to {workId} Work</a></div>
    </details>)}
    {candidates.map((source) => <article className="work-source grid gap-1.25 pt-2 pr-0 pb-2 pl-0 border-t border-t-[#eef0eb] [&_>_summary]:flex [&_>_summary]:items-baseline [&_>_summary]:flex-wrap [&_>_summary]:gap-[4px_9px] [&_>_summary]:text-[#454a42] [&_>_summary]:text-[12px] [&_>_summary]:cursor-pointer [&_>_div:first-child]:flex [&_>_div:first-child]:items-baseline [&_>_div:first-child]:flex-wrap [&_>_div:first-child]:gap-[4px_9px] [&_>_div:first-child]:text-[#454a42] [&_>_div:first-child]:text-[12px] [&_>_div:first-child]:cursor-pointer [&_>_summary_small]:ml-auto [&_>_summary_small]:text-[#74796f] [&_>_summary_small]:text-[11px] [&_>_div:first-child_small]:ml-auto [&_>_div:first-child_small]:text-[#74796f] [&_>_div:first-child_small]:text-[11px] [&_blockquote]:m-0 [&_blockquote]:pt-1.75 [&_blockquote]:pr-2.5 [&_blockquote]:pb-1.75 [&_blockquote]:pl-2.5 [&_blockquote]:border [&_blockquote]:border-[#edeee9] [&_blockquote]:rounded-[5px] [&_blockquote]:text-[#43473f] [&_blockquote]:text-[13px] [&_blockquote]:leading-[1.5] source-candidate mt-1 pt-2.25 pr-2.5 pb-2.25 pl-2.5 bg-[#fbfaf6] [&_>_strong]:text-[#806333] [&_>_strong]:text-[12px]" key={source.id}>
      <div><span className="source-kind text-[#646d5e] font-semibold">{source.type}</span><strong>{source.location}</strong><small>{source.author} · {source.time}</small></div>
      <strong>Possible match · Needs scope decision</strong>
      <p className="source-excerpt m-0 text-[#62665e] text-[12px] leading-[1.45]">{source.excerpt}</p>
      <blockquote>{source.original}</blockquote>
      <p className="source-handling m-0 text-[#62665e] text-[12px] leading-[1.45]">Candidate for {workId}; it is not linked or assigned to this Work.</p>
    </article>)}
  </details>;
}
function InlineDetail({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="inline-detail"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}
function MetaLine({ items }: { items: string[] }) { return <div className="meta-line flex flex-wrap gap-[8px_16px] mt-2.5 text-[#686b73] text-[13px]">{items.map((item) => <span key={item}>{item}</span>)}</div>; }

function renderView(p: RenderProps) {
  const { view, jumpTo, openDrawer, expanded, toggleExpand } = p;
  switch (view.id) {
    case 'V03': return <Workspace {...p}/>;
    case 'V01': return <MasterInbox {...p}/>;
    case 'V17': return <ProjectMaster key={p.project.id} {...p}/>;
    case 'V02': return <Connect {...p}/>;
    case 'V05': return <WorkDetail {...p}/>;
    case 'V11': return p.project.id === 'field-notes' ? <><SettingsTabs {...p}/><Rules {...p}/></> : <ProjectSettingsPreview {...p}/>;
    case 'V12': return p.project.id === 'field-notes' ? <><SettingsTabs {...p}/><Skills {...p}/></> : <ProjectSettingsPreview {...p}/>;
    case 'V13': return p.project.id === 'field-notes' ? <><SettingsTabs {...p}/><Members {...p}/></> : <ProjectSettingsPreview {...p}/>;
    case 'V14': return p.project.id === 'field-notes' ? <><SettingsTabs {...p}/><Connections {...p}/></> : <ProjectSettingsPreview {...p}/>;
    case 'V15': return <WorkspaceSettings {...p}/>;
    default: return <Workspace {...p}/>;
  }
}

function Workspace(p: RenderProps) {
  const { filteredWork, query, setQuery, filter, setFilter } = p;
  const startNewWork = () => {
    const prompt = "Help me plan a new work: ";
    const current = p.masterDraft;
    p.setMasterDraft(current.includes(prompt) ? current : `${current.trim() ? `${current.trim()} — ` : ''}${prompt}`);
    p.jumpTo('V17');
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('#review-V17 input[aria-label="Message Master"]');
      input?.focus({ preventScroll: true });
      if (input) input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  return <>
    <PageHeading title={`${p.project.name} Work`} action={<><Button className="dark-button border-primary bg-primary text-primary-foreground hover:bg-primary/90" onClick={startNewWork}><Icon name="plus" size={15}/> New work</Button></>}/>
    <div className="work-list-section">
      <div className="work-toolbar flex justify-between items-center gap-3 pt-1 pr-0 pb-1.75 pl-0 max-[560px]:items-start max-[560px]:flex-col max-[560px]:gap-1.25"><div className="work-toolbar-controls flex items-center flex-wrap gap-[8px_14px] min-w-0 max-[800px]:w-full max-[800px]:justify-between"><div className="filter-tabs flex flex-wrap gap-0.75 [&_button]:border-0 [&_button]:rounded-[5px] [&_button]:pt-1 [&_button]:pr-2 [&_button]:pb-1 [&_button]:pl-2 [&_button]:bg-transparent [&_button]:text-[#686b73] [&_button]:text-[13px] [&_button:hover]:bg-[#f3f3f5] [&_button.filter-active]:text-[#55536d] [&_button.filter-active]:bg-[#f0eff7]">{['All','In progress','Paused','Done'].map((name) => <button key={name} className={filter === name ? "filter-active" : ""} onClick={() => setFilter(name)} type="button">{name}</button>)}</div></div><label className="search-wrap flex items-center gap-1.5 w-41.25 text-[#686b73] [&_input]:h-7.25! [&_input]:pl-1.25! [&_input]:border-[transparent]! [&_input]:shadow-[none]! [&_input]:text-[13px]! [&:focus-within]:border-b [&:focus-within]:border-b-[#d7d6e7] max-[560px]:w-full max-[560px]:border-b max-[560px]:border-b-[#ededf0]"><Icon name="search" size={15}/><Input id="search-V03" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work" /></label></div>
      <div className="work-list border-t border-t-[#ededf0]">{filteredWork.map((item) => <WorkRow key={item.id} item={item} href={projectWorkHref(p.project.id, item.id)}/>)}</div>
      {!filteredWork.length && <div className="empty-inline pt-5.75 pr-1 pb-5.75 pl-1 text-[#686b73] text-[14px]">No matching work. Clear search or change the status filter.</div>}
    </div>
  </>;
}

export function shouldFollowLatest(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 56) {
  return scrollHeight - clientHeight - scrollTop <= threshold;
}

export function inboxAppendAction(followingLatest: boolean) {
  return followingLatest ? 'follow-now' as const : 'show-new-messages' as const;
}

type InboxPosition = { scrollTop: number; followingLatest: boolean; anchor: { key: string; offset: number } | null; itemCount: number; hasNewMessages: boolean };
function readInboxPosition(projectId: string): InboxPosition | null {
  try {
    const position = JSON.parse(sessionStorage.getItem(`menoteam-v3-master-inbox-scroll-${projectId}`) ?? 'null') as Partial<InboxPosition> | null;
    if (!position || typeof position.scrollTop !== 'number' || typeof position.followingLatest !== 'boolean' || typeof position.itemCount !== 'number') return null;
    return { scrollTop: position.scrollTop, followingLatest: position.followingLatest, anchor: position.anchor ?? null, itemCount: position.itemCount, hasNewMessages: position.hasNewMessages === true };
  } catch { return null; }
}
function saveInboxPosition(projectId: string, position: InboxPosition) {
  try { sessionStorage.setItem(`menoteam-v3-master-inbox-scroll-${projectId}`, JSON.stringify(position)); } catch { /* Keep the in-memory scroll state when storage is unavailable. */ }
}

function MasterInboxProject({ project, turns, draft, setDraft, send, attachments, addFiles, removeAttachment, appendDictation, active, attachmentError }: {
  project: Project; turns: MasterTurn[]; draft: string; setDraft: (value: string) => void; send: () => void; attachments: LocalAttachment[]; addFiles: (files: File[]) => void; removeAttachment: (id: string) => void; appendDictation: (text: string) => void; active: boolean; attachmentError?: string;
}) {
  const [restoredPosition] = useState(() => readInboxPosition(project.id));
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemCount = project.updates.length + turns.length;
  const savedScrollTop = useRef(restoredPosition?.scrollTop ?? 0);
  const savedAnchor = useRef(restoredPosition?.anchor ?? null);
  const followingLatest = useRef(restoredPosition?.followingLatest ?? true);
  const hasOpened = useRef(restoredPosition !== null);
  const previousItemCount = useRef(restoredPosition?.itemCount ?? itemCount);
  const [hasNewMessages, setHasNewMessages] = useState(restoredPosition?.hasNewMessages ?? false);

  const persistPosition = (overrides: Partial<InboxPosition> = {}) => saveInboxPosition(project.id, {
    scrollTop: savedScrollTop.current,
    followingLatest: followingLatest.current,
    anchor: savedAnchor.current,
    itemCount,
    hasNewMessages,
    ...overrides,
  });

  const rememberPosition = (node: HTMLDivElement) => {
    savedScrollTop.current = node.scrollTop;
    followingLatest.current = shouldFollowLatest(node.scrollTop, node.clientHeight, node.scrollHeight);
    const box = node.getBoundingClientRect();
    const anchor = Array.from(node.children).find((child) => child.getBoundingClientRect().bottom > box.top) as HTMLElement | undefined;
    savedAnchor.current = anchor?.dataset.inboxKey ? { key: anchor.dataset.inboxKey, offset: anchor.getBoundingClientRect().top - box.top } : null;
    persistPosition();
  };
  const restorePosition = (node: HTMLDivElement) => {
    const saved = savedAnchor.current;
    const anchor = saved && Array.from(node.children).find((child) => (child as HTMLElement).dataset.inboxKey === saved.key) as HTMLElement | undefined;
    if (anchor && saved) node.scrollTop += anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
    else node.scrollTop = savedScrollTop.current;
  };

  useEffect(() => {
    const previousCount = previousItemCount.current;
    previousItemCount.current = itemCount;
    const appended = itemCount > previousCount;
    const node = scrollRef.current;
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      if (!hasOpened.current) {
        node.scrollTop = node.scrollHeight;
        savedScrollTop.current = node.scrollTop;
        hasOpened.current = true;
        followingLatest.current = true;
        rememberPosition(node);
        return;
      }
      if (appended) {
        if (inboxAppendAction(followingLatest.current) === 'follow-now') {
          node.scrollTop = node.scrollHeight;
          savedScrollTop.current = node.scrollTop;
          setHasNewMessages(false);
          rememberPosition(node);
          persistPosition({ hasNewMessages: false });
        } else {
          setHasNewMessages(true);
          persistPosition({ hasNewMessages: true });
        }
        return;
      }
      if (followingLatest.current) node.scrollTop = node.scrollHeight;
      else restorePosition(node);
    });
    return () => cancelAnimationFrame(frame);
  }, [itemCount]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    let width = node.clientWidth;
    let height = node.clientHeight;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width && node.clientHeight === height) return;
      width = node.clientWidth;
      height = node.clientHeight;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followingLatest.current) node.scrollTop = node.scrollHeight;
        else restorePosition(node);
        rememberPosition(node);
      });
    });
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [itemCount, hasNewMessages]);

  const rememberScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    rememberPosition(node);
    if (followingLatest.current) {
      setHasNewMessages(false);
      persistPosition({ hasNewMessages: false });
    }
  };
  const jumpLatest = () => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'auto' });
    followingLatest.current = true;
    savedScrollTop.current = node.scrollHeight;
    savedAnchor.current = null;
    setHasNewMessages(false);
    persistPosition({ hasNewMessages: false });
  };
  return <article className="inbox-project flex h-140 min-w-0 min-h-105 flex-col pt-0 pr-5 pb-4.5 pl-5 overflow-hidden border border-[#e5e5e8] rounded-[16px] bg-[#fff] max-[560px]:h-110 max-[560px]:min-h-100 max-[640px]:h-130">
    <header className="inbox-project-head flex items-center justify-between flex-[none] gap-3 min-w-0 min-h-20 max-[800px]:min-h-12">
      <div className="inbox-project-identity flex items-center gap-2.5"><span className="inbox-project-monogram grid place-items-center w-8.5 h-8.5 rounded-[10px] bg-[#eeedf6] text-[#48456f] text-[13px] font-semibold">{project.initial}</span><div className="inbox-project-title grid gap-0.5 min-w-0 [&_time]:text-[#85897f] [&_time]:text-[11px] [&_time]:tabular-nums [&_time]:whitespace-nowrap max-[560px]:[&_time]:hidden"><strong className="inbox-project-name text-[#25262a] text-[15px] font-semibold tracking-[-.02em]">{project.name}</strong><span className="inbox-master-label flex items-center gap-1.25 text-[#686b73] text-[11px] [&_i]:w-1.25 [&_i]:h-1.25 [&_i]:rounded-full [&_i]:bg-[#39755d]"><i/>Master</span></div></div>
      <a className="inbox-project-link inline-flex items-center justify-center flex-[none] w-10 h-10 rounded-[8px] text-[#686b73] no-underline [&:hover]:bg-[#f1f3ed] [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px] max-[560px]:min-h-11 max-[560px]:text-[11px] max-[560px]:whitespace-nowrap" href={prototypeHref(project.id, 'V17')} aria-label={`Open ${project.name} conversation`} title="Open conversation"><Icon name="external" size={17}/></a>
    </header>
    <div className="inbox-scroll-wrap relative flex-[1_1_auto] min-h-0">
      <div className="inbox-thread grid h-full content-start gap-5.5 overflow-y-auto pt-0.5 pr-3 pb-6 pl-0" id={`inbox-thread-${project.id}`} ref={scrollRef} onScroll={rememberScroll}>
        {project.updates.map((update) => <article className="inbox-update group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto" data-inbox-key={`update-${update.time}`} key={`${project.id}-${update.time}`}><p><WorkMessage text={update.text} project={project}/></p><MessageMeta time={update.time}/></article>)}
        {turns.map((turn, index) => <article className="inbox-history-turn grid gap-5.5 p-0 border-0" data-inbox-key={`turn-${index}`} key={`${project.id}-${index}-${turn.user}`}><div className="chat-user-turn group/message flex w-full items-end justify-end gap-3 [&>.chat-message-meta]:order-first [&>.chat-message-meta]:pb-2 [&>.human-message]:max-w-[calc(100%-86px)]"><div className="inbox-user-message [&_>_.conversation-attachments]:mt-1.5 justify-self-end w-[fit-content] max-w-[min(88%,_66ch)] pt-2.5 pr-3.5 pb-2.5 pl-3.5 rounded-[14px_14px_4px_14px] bg-[#fafafb] text-[#25262a] ml-auto [&_>_span]:block [&_>_span]:text-[#687064] [&_>_span]:text-[11px] [&_>_span]:font-semibold [&_p]:mt-0.25 [&_p]:mr-0 [&_p]:mb-0 [&_p]:ml-0 [&_p]:text-[14px] [&_p]:leading-[1.45] [&_p]:whitespace-pre-wrap [&_p]:break-words"><p>{turn.user}</p><AttachmentList attachments={turn.attachments ?? []}/></div><MessageMeta time={turn.time ?? "11:08"}/></div><div className="inbox-master-message group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto"><p>{turn.reply}</p><MessageMeta time={turn.time ?? "11:09"}/></div></article>)}
      </div>
      {hasNewMessages && <button type="button" className="inbox-new-messages absolute right-2 bottom-2 inline-flex items-center gap-1.25 min-h-11 pt-0 pr-3 pb-0 pl-3 border border-[#dfe3d9] rounded-[22px] bg-[#fff] text-[#4e5b47] font-sans text-[12px] shadow-[0_1px_3px_#252a2017] cursor-pointer [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px]" onClick={jumpLatest}>New messages <Icon name="arrow" size={13}/></button>}
    </div>
    <ConversationComposer projectId={project.id} draft={draft} setDraft={setDraft} appendDictation={appendDictation} attachments={attachments} addFiles={addFiles} removeAttachment={removeAttachment} send={send} active={active} error={attachmentError}/>
  </article>;
}

function WorkMessage({ text, project, open }: { text: string; project: Project; open?: (id: string) => void }) {
  return <>{text.split(/([A-Z]{2}-\d+)/g).map((part, index) => {
    if (!project.works.some((work) => work.id === part)) return part;
    const url = new URL(prototypeHref(project.id, 'V17'), window.location.href);
    url.searchParams.set('work', part);
    return open
      ? <button key={index} type="button" className="inline-work-ref inline cursor-pointer border-0 bg-transparent p-0 text-inherit underline decoration-border underline-offset-4 hover:decoration-current hover:text-accent-foreground" onClick={() => open(part)}>{part}</button>
      : <a key={index} className="inline-work-ref inline cursor-pointer border-0 bg-transparent p-0 text-inherit underline decoration-border underline-offset-4 hover:decoration-current hover:text-accent-foreground" href={`${url.pathname}${url.search}${url.hash}`}>{part}</a>;
  })}</>;
}

function MessageMeta({ time }: { time: string }) {
  return <div className="chat-message-meta flex min-h-5.5 shrink-0 items-center gap-2 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none"><time>{time}</time></div>;
}

function MasterInbox(p: RenderProps) {
  return <><PageHeading title="All projects"/>
    <section className="master-inbox grid grid-cols-[minmax(0,1fr)] gap-5 w-full [&[aria-label]]:min-w-0 @min-[960px]/work-content:grid-cols-[repeat(2,_minmax(0,1fr))]" aria-label="All projects Master conversations">
      {projects.map((project) => {
        const turns = p.projectMasterMessages[project.id] ?? [];
        return <MasterInboxProject key={project.id} project={project} turns={turns} draft={p.projectMasterDrafts[project.id] ?? ''} setDraft={(value) => p.setProjectMasterDraft(project.id, value)} send={() => p.sendProjectMasterMessage(project.id, p.projectMasterDrafts[project.id] ?? '', p.projectMasterAttachments[project.id] ?? [])} attachments={p.projectMasterAttachments[project.id] ?? []} addFiles={(files) => p.addProjectMasterFiles(project.id, files)} removeAttachment={(id) => p.removeProjectMasterAttachment(project.id, id)} appendDictation={(text) => p.appendProjectMasterDictation(project.id, text)} active={p.masterComposerActive} attachmentError={p.attachmentErrors[project.id]}/>
      })}
    </section>
  </>;
}

function ProjectMaster(p: RenderProps) {
  const fieldNotes = p.project.id === 'field-notes';
  const [context, setContext] = useState<{ workId: string; sourceId?: string; kind: 'work' | 'source' | 'result' } | null>(null);
  useEffect(() => {
    const url = new URL(p.routeKey, window.location.href);
    const workId = url.searchParams.get('work');
    if (url.searchParams.get('view') === 'V17' && url.searchParams.get('project') === p.project.id && workId && p.projectWorks.some((work) => work.id === workId)) {
      setContext({ workId, kind: 'work' });
    }
  }, [p.routeKey, p.project.id]);
  const contextWork = context && p.projectWorks.find((work) => work.id === context.workId);
  const contextSources = context && relatedSourcesForWork(p.project.id, context.workId);
  const selectedSource = context?.sourceId && contextSources ? contextSources.find((source) => source.id === context.sourceId) : undefined;
  const threadRef = useRef<HTMLDivElement>(null);
  const followingLatest = useRef(true);
  const initialized = useRef(false);
  const savedThreadAnchor = useRef<{ key: string; offset: number } | null>(null);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const rememberThreadPosition = (node: HTMLDivElement) => {
    followingLatest.current = shouldFollowLatest(node.scrollTop, node.clientHeight, node.scrollHeight);
    const bounds = node.getBoundingClientRect();
    const anchor = Array.from(node.children).find((child) => child.getBoundingClientRect().bottom > bounds.top) as HTMLElement | undefined;
    savedThreadAnchor.current = anchor?.dataset.masterKey ? { key: anchor.dataset.masterKey, offset: anchor.getBoundingClientRect().top - bounds.top } : null;
  };
  const restoreThreadPosition = (node: HTMLDivElement) => {
    const saved = savedThreadAnchor.current;
    const anchor = saved && Array.from(node.children).find((child) => (child as HTMLElement).dataset.masterKey === saved.key) as HTMLElement | undefined;
    if (anchor && saved) node.scrollTop += anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
  };
  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      if (!initialized.current || followingLatest.current) node.scrollTop = node.scrollHeight;
      if (initialized.current && !followingLatest.current) setHasNewMessages(true);
      initialized.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [p.masterMessages.length]);
  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    let width = node.clientWidth;
    let height = node.clientHeight;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width && node.clientHeight === height) return;
      width = node.clientWidth;
      height = node.clientHeight;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followingLatest.current) node.scrollTop = node.scrollHeight;
        else restoreThreadPosition(node);
        rememberThreadPosition(node);
      });
    });
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return <>
    <PageHeading title={p.project.name}/>
    <div className={`master-layout grid gap-6 @min-[960px]/work-content:[&.has-context]:grid-cols-[minmax(0,1fr)_300px] ${context ? "has-context" : ""}`}>
    <div className="master-primary @min-[960px]/work-content:min-w-0">
    <section className="master-conversation flex h-[min(650px,72vh)] min-h-[400px] w-full min-w-0 flex-col gap-2.5" aria-label={`${p.project.name} Master conversation`}>
      <div className="master-thread-wrap relative min-h-0 flex-1"><div className="master-thread flex h-full flex-col gap-6 overflow-y-auto overscroll-contain pr-2 pb-3" ref={threadRef} onScroll={(event) => { rememberThreadPosition(event.currentTarget); if (followingLatest.current) setHasNewMessages(false); }}>
        <div className="master-updates grid gap-6" data-master-key="updates">{p.project.updates.map((update) => <article className="master-update group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto" key={`${p.project.id}-${update.time}`}><p><WorkMessage text={update.text} project={p.project} open={(workId) => setContext({ workId, kind: 'work' })}/></p><MessageMeta time={update.time}/></article>)}</div>
        {/* ponytail: append-only sample history preserves order, so array position is a stable key. */}
        {p.masterMessages.map((turn, index) => <div className="master-exchange grid gap-2 w-full min-w-0" data-master-key={`turn-${index}`} key={`${index}-${turn.user}`}><div className="chat-user-turn group/message flex w-full items-end justify-end gap-3 [&>.chat-message-meta]:order-first [&>.chat-message-meta]:pb-2 [&>.human-message]:max-w-[calc(100%-86px)]"><div className="human-message w-fit min-w-0 rounded-2xl rounded-br-sm bg-muted px-3 py-2 text-sm leading-relaxed"><p>{turn.user}</p><AttachmentList attachments={turn.attachments ?? []}/></div><MessageMeta time={turn.time ?? "11:08"}/></div><div className="master-reply group/message [&_p]:m-0 [&_p]:text-[#3f423d] [&_p]:text-[14px] [&_p]:leading-[1.55] [&_p]:break-words flex items-start gap-2 [&_>_div]:flex [&_>_div]:gap-3 [&_>_div]:min-w-0 [&_>_div]:w-full [&_>_div]:items-end [&_>_div_>_p]:w-auto [&_>_div_>_p]:p-0 [&_>_div_>_p]:border-0 [&_>_div_>_p]:rounded-0 [&_>_div_>_p]:bg-transparent [&_>_div_>_p]:flex-[0_1_auto] [&_>_div_>_p]:min-w-0 [&_.message-meta]:m-0 [&_.message-meta_strong]:text-[#55584f] [&_.message-meta_strong]:text-[12px] [&:hover_>_div_>_.chat-message-meta]:opacity-[1]"><div><p>{turn.reply}</p><MessageMeta time={turn.time ?? "11:09"}/></div></div></div>)}
      </div>{hasNewMessages && <button type="button" className="master-new-messages absolute right-2 bottom-2 inline-flex items-center gap-1.25 min-h-11 pt-0 pr-3 pb-0 pl-3 border border-[#dfe3d9] rounded-[22px] bg-[#fff] text-[#4e5b47] text-[12px] shadow-[0_1px_3px_#252a2017]" onClick={() => { const node = threadRef.current; if (!node) return; node.scrollTo({ top: node.scrollHeight, behavior: 'auto' }); followingLatest.current = true; setHasNewMessages(false); }}>New messages <Icon name="arrow" size={13}/></button>}</div>
      <ConversationComposer projectId={p.project.id} draft={p.projectMasterDrafts[p.project.id] ?? ''} setDraft={(value) => p.setProjectMasterDraft(p.project.id, value)} appendDictation={(text) => p.appendProjectMasterDictation(p.project.id, text)} attachments={p.projectMasterAttachments[p.project.id] ?? []} addFiles={(files) => p.addProjectMasterFiles(p.project.id, files)} removeAttachment={(id) => p.removeProjectMasterAttachment(p.project.id, id)} send={() => p.sendProjectMasterMessage(p.project.id, p.projectMasterDrafts[p.project.id] ?? '', p.projectMasterAttachments[p.project.id] ?? [])} active={p.masterComposerActive} error={p.attachmentErrors[p.project.id]}/>
    </section>
    </div>
    {context && <aside className="master-context-panel grid min-w-0 content-start gap-3 rounded-lg border border-border bg-background p-3 [&.work-detail-content]:rounded-none [&.work-detail-content]:border-0 [&.work-detail-content]:border-r [&.work-detail-content]:p-0 [&.work-detail-content]:pr-7 max-[800px]:[&.work-detail-content]:border-r-0 max-[800px]:[&.work-detail-content]:pr-0" aria-label={`${context.workId} ${context.kind}`}>
      <div className="master-context-head flex items-start justify-between gap-2 pb-2.5 border-b border-b-[#edeee9] [&_>_div_>_span]:text-[#797e73] [&_>_div_>_span]:text-[10px] [&_>_div_>_span]:font-semibold [&_>_div_>_span]:tracking-[.08em] [&_h2]:mt-0.75 [&_h2]:mr-0 [&_h2]:mb-0 [&_h2]:ml-0 [&_h2]:text-[#393d37] [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:leading-[1.35]"><div><span>{context.kind === 'source' ? 'SOURCE' : context.kind === 'result' ? 'RESULT' : 'WORK'}</span><h2>{contextWork?.id ?? context.workId} · {contextWork?.title ?? 'Work details'}</h2></div><button type="button" className="icon-button grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setContext(null)} aria-label="Close details"><Icon name="close"/></button></div>
      {context.kind === 'source' && selectedSource ? <div className="master-context-body grid content-start gap-2.25 min-w-0 [&_>_p]:m-0 [&_>_p]:text-[#555a51] [&_>_p]:text-[13px] [&_>_p]:leading-[1.5] [&_>_small]:text-[#73796d] [&_>_small]:text-[11px] [&_>_small]:leading-[1.4] [&_blockquote]:m-0 [&_blockquote]:pt-2.25 [&_blockquote]:pr-2.5 [&_blockquote]:pb-2.25 [&_blockquote]:pl-2.5 [&_blockquote]:border-l-2 [&_blockquote]:border-l-[#cbd2c3] [&_blockquote]:bg-[#f8f9f6] [&_blockquote]:text-[#454a42] [&_blockquote]:text-[13px] [&_blockquote]:leading-[1.5] [&_.source-actions_button]:p-0 [&_.source-actions_button]:border-0 [&_.source-actions_button]:bg-transparent [&_.source-actions_button]:text-[#56634d] [&_.source-actions_button]:font-sans [&_.source-actions_button]:text-[12px] [&_.source-actions_button]:underline [&_.source-actions_button]:underline-offset-[2px] [&_.source-actions_button]:cursor-pointer [&_.source-actions_a]:p-0 [&_.source-actions_a]:border-0 [&_.source-actions_a]:bg-transparent [&_.source-actions_a]:text-[#56634d] [&_.source-actions_a]:font-sans [&_.source-actions_a]:text-[12px] [&_.source-actions_a]:underline [&_.source-actions_a]:underline-offset-[2px] [&_.source-actions_a]:cursor-pointer"><div className="master-context-meta grid gap-0.5 [&_strong]:text-[#4d5547] [&_strong]:text-[12px] [&_span]:text-[#4d5149] [&_span]:text-[13px] [&_small]:text-[#73796d] [&_small]:text-[11px]"><strong>{selectedSource.type}</strong><span>{selectedSource.location}</span><small>{selectedSource.author} · {selectedSource.time}</small></div><p>{selectedSource.excerpt}</p><blockquote>{selectedSource.original}</blockquote><small>Linked to {context.workId} · Responsible Agent: {selectedSource.responsibleAgent}</small><button type="button" className="text-action inline-flex items-center justify-start gap-1.25 w-[fit-content] min-h-8 pt-0.75 pr-0.5 pb-0.75 pl-0.5 border-0 rounded-[4px] bg-transparent text-[#596451] text-[13px] leading-[1.4] text-left underline underline-offset-[3px] cursor-pointer [&:hover]:text-[#3f4c39] [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px] max-[560px]:min-h-11" onClick={() => setContext({ workId: context.workId, kind: 'work' })}>Back to {context.workId} Work</button></div>
        : context.kind === 'result' ? <div className="master-context-body grid content-start gap-2.25 min-w-0 [&_>_p]:m-0 [&_>_p]:text-[#555a51] [&_>_p]:text-[13px] [&_>_p]:leading-[1.5] [&_>_small]:text-[#73796d] [&_>_small]:text-[11px] [&_>_small]:leading-[1.4] [&_blockquote]:m-0 [&_blockquote]:pt-2.25 [&_blockquote]:pr-2.5 [&_blockquote]:pb-2.25 [&_blockquote]:pl-2.5 [&_blockquote]:border-l-2 [&_blockquote]:border-l-[#cbd2c3] [&_blockquote]:bg-[#f8f9f6] [&_blockquote]:text-[#454a42] [&_blockquote]:text-[13px] [&_blockquote]:leading-[1.5] [&_.source-actions_button]:p-0 [&_.source-actions_button]:border-0 [&_.source-actions_button]:bg-transparent [&_.source-actions_button]:text-[#56634d] [&_.source-actions_button]:font-sans [&_.source-actions_button]:text-[12px] [&_.source-actions_button]:underline [&_.source-actions_button]:underline-offset-[2px] [&_.source-actions_button]:cursor-pointer [&_.source-actions_a]:p-0 [&_.source-actions_a]:border-0 [&_.source-actions_a]:bg-transparent [&_.source-actions_a]:text-[#56634d] [&_.source-actions_a]:font-sans [&_.source-actions_a]:text-[12px] [&_.source-actions_a]:underline [&_.source-actions_a]:underline-offset-[2px] [&_.source-actions_a]:cursor-pointer"><Status tone={context.workId === 'FN-48' ? 'green' : 'red'}>{context.workId === 'FN-48' ? 'Required checks passed' : contextWork?.status ?? 'Review needed'}</Status><p>{context.workId === 'FN-48' ? 'Post-deploy verification is still pending. Master will report the result when it is complete.' : contextWork?.outcome}</p><button type="button" className="text-action inline-flex items-center justify-start gap-1.25 w-[fit-content] min-h-8 pt-0.75 pr-0.5 pb-0.75 pl-0.5 border-0 rounded-[4px] bg-transparent text-[#596451] text-[13px] leading-[1.4] text-left underline underline-offset-[3px] cursor-pointer [&:hover]:text-[#3f4c39] [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px] max-[560px]:min-h-11" onClick={() => p.jumpTo(context.workId === 'FN-48' ? 'V09' : 'V08')}>Open full result <Icon name="arrow" size={13}/></button></div>
        : <div className="master-context-body grid content-start gap-2.25 min-w-0 [&_>_p]:m-0 [&_>_p]:text-[#555a51] [&_>_p]:text-[13px] [&_>_p]:leading-[1.5] [&_>_small]:text-[#73796d] [&_>_small]:text-[11px] [&_>_small]:leading-[1.4] [&_blockquote]:m-0 [&_blockquote]:pt-2.25 [&_blockquote]:pr-2.5 [&_blockquote]:pb-2.25 [&_blockquote]:pl-2.5 [&_blockquote]:border-l-2 [&_blockquote]:border-l-[#cbd2c3] [&_blockquote]:bg-[#f8f9f6] [&_blockquote]:text-[#454a42] [&_blockquote]:text-[13px] [&_blockquote]:leading-[1.5] [&_.source-actions_button]:p-0 [&_.source-actions_button]:border-0 [&_.source-actions_button]:bg-transparent [&_.source-actions_button]:text-[#56634d] [&_.source-actions_button]:font-sans [&_.source-actions_button]:text-[12px] [&_.source-actions_button]:underline [&_.source-actions_button]:underline-offset-[2px] [&_.source-actions_button]:cursor-pointer [&_.source-actions_a]:p-0 [&_.source-actions_a]:border-0 [&_.source-actions_a]:bg-transparent [&_.source-actions_a]:text-[#56634d] [&_.source-actions_a]:font-sans [&_.source-actions_a]:text-[12px] [&_.source-actions_a]:underline [&_.source-actions_a]:underline-offset-[2px] [&_.source-actions_a]:cursor-pointer"><Status tone={contextWork?.tone ?? 'neutral'}>{contextWork?.status ?? 'Work'}</Status><p>{contextWork?.outcome}</p>{contextWork?.next && <p><strong>Next</strong> · {contextWork.next}</p>}<p><strong>Responsible Agent</strong> · {contextWork?.agent ?? 'Master to assign'}</p>{context.workId === 'FN-51' && <div className="master-scope-plan grid gap-1 p-2.25 border border-[#eee7da] rounded-[6px] bg-[#fdfbf7] [&_>_strong]:text-[#806333] [&_>_strong]:text-[12px] [&_>_p]:m-0 [&_>_p]:text-[#5e584e] [&_>_p]:text-[12px] [&_>_p]:leading-[1.45]"><strong>Proposed change</strong><p>Review the invite visibility guard against the project membership scope. Restricted permission changes remain unapplied until you approve the plan.</p></div>}<div className="source-actions [&_button]:p-0 [&_button]:border-0 [&_button]:bg-transparent [&_button]:text-[#56634d] [&_button]:font-sans [&_button]:text-[12px] [&_button]:underline [&_button]:underline-offset-[2px] [&_button]:cursor-pointer flex flex-wrap gap-[5px_13px] text-[12px] [&_a]:text-[#56634d] [&_a]:underline [&_a]:underline-offset-[2px]"><a href={projectWorkHref(p.project.id, context.workId)}>Open full Work</a></div>{contextSources?.length ? <div className="master-context-sources grid gap-1.25 mt-1 pt-2 border-t border-t-[#edeee9] [&_>_strong]:text-[#656b60] [&_>_strong]:text-[11px] [&_>_button]:grid [&_>_button]:gap-0.5 [&_>_button]:min-w-0 [&_>_button]:p-1.75 [&_>_button]:border [&_>_button]:border-[#eef0eb] [&_>_button]:rounded-[5px] [&_>_button]:bg-[#fff] [&_>_button]:text-left [&_>_button_span]:text-[#72786e] [&_>_button_span]:text-[11px] [&_>_button_small]:text-[#72786e] [&_>_button_small]:text-[11px] [&_>_button_strong]:text-[#454a42] [&_>_button_strong]:text-[12px] [&_>_button_strong]:font-semibold"><strong>Sample sources · {contextSources.length}</strong>{contextSources.map((source) => <button type="button" key={source.id} onClick={() => setContext({ workId: context.workId, sourceId: source.id, kind: 'source' })}><span>{source.type}</span><strong>{source.location}</strong><small>{source.author} · {source.time}</small></button>)}</div> : null}</div>}
    </aside>}
    </div>
  </>;
}

function Connect(p: RenderProps) {
  const [source, setSource] = useState('GitHub');
  const [path, setPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [connected, setConnected] = useState(false);
  return <><PageHeading title="Connect project" description="Select a repository or local folder." meta={<><span>Onboarding</span><span>GitHub or local folder</span></>}/>
    <div className="connect-layout w-[min(100%,_640px)] mt-0 mr-auto mb-0 ml-auto"><div className="connect-main grid gap-6"><div className="segmented-control inline-flex w-[max-content] gap-0.75 p-0.75 border border-[#e5e5e8] rounded-[7px] bg-[#f7f7f8] [&_button]:inline-flex [&_button]:items-center [&_button]:gap-1.75 [&_button]:min-h-9 [&_button]:pt-0 [&_button]:pr-3 [&_button]:pb-0 [&_button]:pl-3 [&_button]:border-0 [&_button]:rounded-[5px] [&_button]:bg-transparent [&_button]:text-[#65676f] [&_button]:text-[13px] [&_button.selected]:bg-[#fff] [&_button.selected]:text-[#3d3e45] [&_button.selected]:shadow-[0_1px_2px_#20212a12] max-[800px]:[&_button]:min-h-11" role="tablist" aria-label="Project source">{['GitHub','Local folder'].map((item) => <button key={item} role="tab" aria-selected={source === item} className={source === item ? "selected" : ""} onClick={() => { setSource(item); setConnected(false); }}>{item === 'GitHub' ? <Icon name="github" size={15}/> : <Icon name="folder" size={15}/>} {item}</button>)}</div>
      {source === 'GitHub' ? <label className="field-label grid gap-2 text-[#45474e] text-[13px] font-semibold [&_[data-slot='input']]:w-full">Repository URL<Input aria-label="Repository URL" placeholder="https://github.com/org/repository" value={path} onChange={(event) => setPath(event.target.value)} /></label> : <div className="folder-picker flex items-center gap-2.5 min-h-15 pt-2.25 pr-0 pb-2.25 pl-0 border-b border-b-[#ededf0] [&_strong]:flex-[1] [&_strong]:text-[#4e5057] [&_strong]:text-[13px] [&_strong]:font-semibold max-[800px]:[&_.dark-button]:min-h-11 max-[800px]:[&_[data-slot='button']]:min-h-11"><div className="folder-pick-icon grid place-items-center w-8 h-8 border border-[#e9e9ec] rounded-[7px] text-[#686b73]"><Icon name="folder" size={19}/></div><strong>{path || 'Choose a local folder'}</strong><Button variant="outline" size="sm" onClick={() => setPath('/Users/yili/Projects/field-notes')}>Browse folder</Button></div>}
      <label className="field-label grid gap-2 text-[#45474e] text-[13px] font-semibold [&_[data-slot='input']]:w-full">Project name<Input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
      {connected && <div className="connect-confirm flex items-center gap-2.25 p-2.25 text-[#4e7d67] bg-[#f0f7f3] rounded-[6px] [&_>_span]:grid [&_>_span]:flex-[1] [&_strong]:text-[13px] [&_small]:text-[#686b73] [&_small]:text-[13px]"><Icon name="check" size={16}/><span><strong>{projectName} · Details saved in this example</strong></span><Button variant="ghost" size="sm" onClick={() => p.jumpTo('V03')}>Back to Work</Button></div>}
      <div className="connect-actions flex justify-end gap-1.75 pt-0.75 mt-0.75 max-[800px]:[&_[data-slot='button']]:min-h-11"><Button variant="outline" onClick={() => p.jumpTo('V01')}>Cancel</Button><Button className="dark-button border-primary bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setConnected(true)} disabled={!projectName.trim() || !path.trim()}>{source === 'GitHub' ? 'Confirm repository' : 'Confirm folder'} <Icon name="arrow" size={14}/></Button></div>
      </div></div>
  </>;
}

function SettingsTabs(p: RenderProps) {
  return <nav className="settings-tabs mb-5 flex gap-2 overflow-x-auto border-b border-border pb-3 [&_a]:shrink-0 [&_a]:rounded-md [&_a]:px-3 [&_a]:py-2 [&_a]:text-sm [&_a]:text-muted-foreground [&_a:hover]:bg-muted [&_a.active]:bg-accent [&_a.active]:text-accent-foreground" aria-label={`${p.project.name} project settings`}>{[['V11','Instructions'],['V12','Skills'],['V13','Members'],['V14','Connections']].map(([id,label]) => <a key={id} className={p.view.id === id ? "active" : ""} aria-current={p.view.id === id ? 'page' : undefined} href={prototypeHref(p.project.id,id!)}>{label}</a>)}</nav>;
}
function ProjectSettingsPreview(p: RenderProps) {
  const labels: Record<string,string> = { V11: 'Instructions', V12: 'Skills', V13: 'Members', V14: 'Connections' };
  return <><PageHeading title={`${p.project.name} · ${labels[p.view.id] ?? 'Settings'}`}/><SettingsTabs {...p}/><div className="settings-unavailable flex items-center flex-wrap gap-3 pt-3.5 pr-0 pb-3.5 pl-0 text-[#5e625a] text-[14px]"><span>No separate {labels[p.view.id] ?? 'Settings'} example for this project.</span><Button variant="outline" size="sm" onClick={() => p.jumpTo('V17')}>Back to {p.project.name} Master</Button></div></>;
}

function selectedDetailWork(works: ProjectWork[], routeKey: string) {
  const location = new URL(routeKey, 'http://localhost');
  const id = location.searchParams.get('work') ?? (location.searchParams.get('view') === 'V09' || location.hash === '#label-V09' ? 'FN-48' : null);
  return works.find((work) => work.id === id) ?? works.find((work) => work.id === 'FN-51') ?? works[0];
}

function WorkSpeaker({ role, name }: { role: 'master' | 'agent' | 'subagent'; name: string }) {
  return <div className="work-speaker flex items-center gap-2 text-xs font-semibold text-muted-foreground"><span className={`participant-avatar inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground [&.participant-master]:bg-violet-50 [&.participant-master]:text-violet-600 [&.participant-agent]:bg-emerald-50 [&.participant-agent]:text-emerald-700 [&.participant-subagent]:bg-blue-50 [&.participant-subagent]:text-blue-600 participant-${role}`} aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() ?? '?'}</span><span>{name}</span>{role === 'subagent' && <span className="participant-role text-[11px] font-normal text-muted-foreground">Subagent</span>}</div>;
}
function WorkDetail(p: RenderProps) {
  const work = selectedDetailWork(p.projectWorks, p.routeKey)!;
  const key = `${p.project.id}:${work.id}`;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string[]>>({});
  const [panel, setPanel] = useState<'changes' | 'qa' | 'overview' >('overview');
  const assigned = work.agent !== 'Master to assign';
  const sourceId = new URL(p.routeKey, 'http://localhost').searchParams.get('source') ?? '';
  useEffect(() => { const url = new URL(p.routeKey, 'http://localhost'); setPanel(url.searchParams.get('tab') === 'qa' || url.searchParams.get('view') === 'V08' || url.hash === '#label-V08' ? 'qa' : 'overview'); }, [key, sourceId, p.routeKey]);
  const showPanel = panel;
  const overview = work.id === 'FN-51'
    ? 'Fix project invite visibility. Keep guest access unchanged.\n\nThe Slack report and PR feedback describe the same issue. Continue with the existing Agent; verify the invite flow after the fix.'
    : `${work.title}\n\n${work.outcome}${work.next === 'None' ? '' : `\n\n${work.next}`}`;
  return <>
    <PageHeading title={work.title}/>
    <div className="work-detail-split grid grid-cols-2 items-stretch gap-7 max-[800px]:grid-cols-1">
      <aside className="work-detail-content max-h-[72vh] min-w-0 overflow-y-auto border-r border-border pr-7 max-[800px]:max-h-[45vh] max-[800px]:border-r-0 max-[800px]:pr-0"><div className="work-detail-tabs mb-3 flex gap-6 overflow-x-auto border-b border-border [&_button]:shrink-0 [&_button]:border-0 [&_button]:border-b-2 [&_button]:border-transparent [&_button]:bg-transparent [&_button]:px-0 [&_button]:pb-3 [&_button]:pt-2 [&_button]:text-sm [&_button]:text-muted-foreground [&_button[aria-selected=true]]:border-ring [&_button[aria-selected=true]]:text-foreground" role="tablist" aria-label="Work details">{(['overview', 'changes', 'qa'] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={showPanel === tab} onClick={() => setPanel(tab)}>{tab === 'qa' ? 'QA' : tab.charAt(0).toUpperCase() + tab.slice(1)}</button>)}</div>{showPanel === 'changes' ? <WorkChanges workId={work.id}/> : showPanel === 'qa' ? <WorkQA workId={work.id} projectId={p.project.id}/> : <div className="work-overview text-[14px] leading-[1.8] [&_p]:mt-0 [&_p]:mr-0 [&_p]:mb-5 [&_p]:ml-0 [&_p]:whitespace-pre-line [&_small]:text-[#686b73] [&_small]:text-[12px]"><div className="work-overview-meta flex flex-wrap items-center gap-3 mb-6 text-[#686b73] text-[12px]"><Status tone={work.tone}>{work.status}</Status><span>{work.agent}</span></div>{overview.split('\n\n').map((paragraph, index) => <p key={index}>{paragraph}</p>)}{work.id === 'FN-51' && <small>Updated by Master · 10:29</small>}{work.id === 'FN-48' && <WorkDelivery/>}<div className="overview-related mt-7 pt-5 border-t border-t-[#e5e5e8] [&_h3]:mt-0 [&_h3]:mr-0 [&_h3]:mb-3 [&_h3]:ml-0 [&_h3]:text-[13px] [&_h3]:font-semibold"><h3>Related</h3><RelatedSources projectId={p.project.id} workId={work.id} focusSourceId={sourceId}/>{!relatedSourcesForWork(p.project.id, work.id).length && !['FN-51','FN-48'].includes(work.id) && <p>No linked items yet.</p>}</div></div>}</aside>
      <section className="master-conversation flex h-[min(650px,72vh)] min-h-[400px] w-full min-w-0 flex-col gap-2.5" aria-label={`${work.id} conversation`}>
        <div className="master-thread-wrap relative min-h-0 flex-1"><div className="master-thread flex h-full flex-col gap-6 overflow-y-auto overscroll-contain pr-2 pb-3">
          <article className="work-speaker-message grid gap-2"><WorkSpeaker role="master" name="Master"/><div className="master-update group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto"><p>{work.id === 'FN-51' ? 'Please fix invite visibility for this project. Keep guest access unchanged; the linked Slack report and PR feedback belong to this Work.' : `Please take this forward: ${work.title.toLowerCase()}.`}</p><MessageMeta time="10:18"/></div></article>
          {assigned && <article className="work-speaker-message grid gap-2"><WorkSpeaker role="agent" name={work.agent}/><div className="master-update group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto"><p>{work.outcome} {work.next !== 'None' ? work.next + '.' : ''}</p><MessageMeta time="10:24"/></div></article>}
          {work.id === 'FN-51' && <><div className="chat-user-turn group/message flex w-full items-end justify-end gap-3 [&>.chat-message-meta]:order-first [&>.chat-message-meta]:pb-2 [&>.human-message]:max-w-[calc(100%-86px)]"><div className="human-message w-fit min-w-0 rounded-2xl rounded-br-sm bg-muted px-3 py-2 text-sm leading-relaxed"><p>Keep this focused on the invitation fix. Guest access can wait.</p></div><MessageMeta time="10:28"/></div><article className="work-speaker-message grid gap-2"><WorkSpeaker role="master" name="Master"/><div className="master-update group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto"><p>I’ve updated the Work overview: guest access stays unchanged. Continue with the invitation fix.</p><MessageMeta time="10:29"/></div></article><article className="work-speaker-message grid gap-2"><WorkSpeaker role="agent" name={work.agent}/><div className="master-update group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto"><p>Understood. I’ll fix the membership check and rerun the regression test.</p><MessageMeta time="10:30"/></div></article></>}
          {work.id === 'FN-51' && <article className="work-speaker-message grid gap-2"><WorkSpeaker role="subagent" name="QA reviewer"/><div className="master-update group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto"><p>I reproduced the cross-project visibility failure. I’ll verify the same case again once the fix is ready.</p><MessageMeta time="10:31"/></div></article>}
          {!assigned && <article className="work-speaker-message grid gap-2"><WorkSpeaker role="master" name="Master"/><div className="master-update group/message flex items-end gap-3 text-sm leading-relaxed [&>p]:min-w-0 [&>p]:flex-auto"><p>This Work is queued. I’ll assign an Agent when it’s ready to start.</p><MessageMeta time="10:24"/></div></article>}
          {(messages[key] ?? []).map((message, index) => <div className="chat-user-turn group/message flex w-full items-end justify-end gap-3 [&>.chat-message-meta]:order-first [&>.chat-message-meta]:pb-2 [&>.human-message]:max-w-[calc(100%-86px)]" key={index}><div className="human-message w-fit min-w-0 rounded-2xl rounded-br-sm bg-muted px-3 py-2 text-sm leading-relaxed"><p>{message}</p></div><MessageMeta time="Now"/></div>)}
        </div></div>
        <ConversationComposer projectId={key} recipient={assigned ? work.agent : 'Master'} draft={drafts[key] ?? ''} setDraft={(value) => setDrafts((items) => ({ ...items, [key]: value }))} send={() => { const message = drafts[key]?.trim(); if (!message) return; setMessages((items) => ({ ...items, [key]: [...(items[key] ?? []), message] })); setDrafts((items) => ({ ...items, [key]: '' })); }} active attachments={[]} addFiles={() => {}} removeAttachment={() => {}} appendDictation={() => {}}/>
      </section>

    </div>
  </>;
}
type PreviewDiffLine = { kind: 'context' | 'add' | 'remove'; text: string };
function WorkChanges({ workId }: { workId: string }) {
  if (!['FN-51', 'FN-48'].includes(workId)) return <div className="master-context-body grid content-start gap-2.25 min-w-0 [&_>_p]:m-0 [&_>_p]:text-[#555a51] [&_>_p]:text-[13px] [&_>_p]:leading-[1.5] [&_>_small]:text-[#73796d] [&_>_small]:text-[11px] [&_>_small]:leading-[1.4] [&_blockquote]:m-0 [&_blockquote]:pt-2.25 [&_blockquote]:pr-2.5 [&_blockquote]:pb-2.25 [&_blockquote]:pl-2.5 [&_blockquote]:border-l-2 [&_blockquote]:border-l-[#cbd2c3] [&_blockquote]:bg-[#f8f9f6] [&_blockquote]:text-[#454a42] [&_blockquote]:text-[13px] [&_blockquote]:leading-[1.5] [&_.source-actions_button]:p-0 [&_.source-actions_button]:border-0 [&_.source-actions_button]:bg-transparent [&_.source-actions_button]:text-[#56634d] [&_.source-actions_button]:font-sans [&_.source-actions_button]:text-[12px] [&_.source-actions_button]:underline [&_.source-actions_button]:underline-offset-[2px] [&_.source-actions_button]:cursor-pointer [&_.source-actions_a]:p-0 [&_.source-actions_a]:border-0 [&_.source-actions_a]:bg-transparent [&_.source-actions_a]:text-[#56634d] [&_.source-actions_a]:font-sans [&_.source-actions_a]:text-[12px] [&_.source-actions_a]:underline [&_.source-actions_a]:underline-offset-[2px] [&_.source-actions_a]:cursor-pointer"><p>No changes yet.</p></div>;
  const files: { name: string; start: number; lines: PreviewDiffLine[] }[] = workId === 'FN-51' ? [
    { name: 'src/project-invites.ts', start: 24, lines: [
      { kind: 'context', text: 'export function findInviteMember(members, userId, projectId) {' },
      { kind: 'remove', text: '  return members.find(member => member.userId === userId);' },
      { kind: 'add', text: '  return members.find(member =>' },
      { kind: 'add', text: '    member.userId === userId && member.projectId === projectId' },
      { kind: 'add', text: '  );' },
      { kind: 'context', text: '}' },
    ] },
    { name: 'src/project-invites.test.ts', start: 48, lines: [
      { kind: 'add', text: "it('excludes members of another project', () => {" },
      { kind: 'add', text: "  const members = [{ userId: 'u1', projectId: 'other' }];" },
      { kind: 'add', text: "  expect(findInviteMember(members, 'u1', 'current'))" },
      { kind: 'add', text: '    .toBeUndefined();' },
      { kind: 'add', text: '});' },
    ] },
  ] : [
    { name: 'src/invite-retry.ts', start: 12, lines: [
      { kind: 'context', text: 'export async function sendInvite(request) {' },
      { kind: 'remove', text: '  return createInvite(request);' },
      { kind: 'add', text: '  return retry(() => createInvite(request), {' },
      { kind: 'add', text: '    attempts: 3, idempotencyKey: request.id' },
      { kind: 'add', text: '  });' },
      { kind: 'context', text: '}' },
    ] },
  ];
  const added = files.reduce((count, file) => count + file.lines.filter(line => line.kind === 'add').length, 0);
  const removed = files.reduce((count, file) => count + file.lines.filter(line => line.kind === 'remove').length, 0);
  return <div className="file-diffs grid min-w-0 gap-4"><div className="diff-summary flex items-center gap-2.5 text-[13px] [&_small]:ml-auto [&_small]:text-[#686b73]"><strong>{files.length} changed files</strong><span className="diff-add-count text-[#238636] text-[12px] tabular-nums">+{added}</span><span className="diff-remove-count text-[#cf222e] text-[12px] tabular-nums">−{removed}</span><small>Example diff</small></div>{files.map(file => {
    let oldLine = file.start; let newLine = file.start;
    return <details className="file-diff min-w-0 overflow-hidden rounded-lg border border-border [&_summary]:cursor-pointer [&_summary]:bg-muted/50 [&_summary]:p-3 [&_summary]:text-xs [&_summary_code]:mr-3 [&_summary_span]:ml-2" key={file.name}><summary><code>{file.name}</code><span className="diff-add-count text-[#238636] text-[12px] tabular-nums">+{file.lines.filter(line => line.kind === 'add').length}</span><span className="diff-remove-count text-[#cf222e] text-[12px] tabular-nums">−{file.lines.filter(line => line.kind === 'remove').length}</span></summary><div className="diff-scroll overflow-x-auto [&_table]:w-full [&_table]:border-collapse [&_table]:font-mono [&_table]:text-xs [&_table]:leading-relaxed [&_td]:border-0 [&_td]:px-1.5 [&_td]:py-0.5"><table aria-label={`Changes in ${file.name}`}><tbody>{file.lines.map((line, index) => <tr key={index} className={`diff-line [&.diff-add]:bg-emerald-50 [&.diff-add]:text-emerald-950 [&.diff-remove]:bg-red-50 [&.diff-remove]:text-red-950 diff-${line.kind}`}><td className="diff-number min-w-8 select-none text-right text-muted-foreground">{line.kind === 'add' ? '' : oldLine++}</td><td className="diff-number min-w-8 select-none text-right text-muted-foreground">{line.kind === 'remove' ? '' : newLine++}</td><td className="diff-sign w-4 select-none">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</td><td className="diff-code whitespace-pre"><code>{line.text}</code></td></tr>)}</tbody></table></div></details>;
  })}</div>;
}
function WorkQA({ workId, projectId }: { workId: string; projectId: string }) {
  return <div className="master-context-body grid content-start gap-2.25 min-w-0 [&_>_p]:m-0 [&_>_p]:text-[#555a51] [&_>_p]:text-[13px] [&_>_p]:leading-[1.5] [&_>_small]:text-[#73796d] [&_>_small]:text-[11px] [&_>_small]:leading-[1.4] [&_blockquote]:m-0 [&_blockquote]:pt-2.25 [&_blockquote]:pr-2.5 [&_blockquote]:pb-2.25 [&_blockquote]:pl-2.5 [&_blockquote]:border-l-2 [&_blockquote]:border-l-[#cbd2c3] [&_blockquote]:bg-[#f8f9f6] [&_blockquote]:text-[#454a42] [&_blockquote]:text-[13px] [&_blockquote]:leading-[1.5] [&_.source-actions_button]:p-0 [&_.source-actions_button]:border-0 [&_.source-actions_button]:bg-transparent [&_.source-actions_button]:text-[#56634d] [&_.source-actions_button]:font-sans [&_.source-actions_button]:text-[12px] [&_.source-actions_button]:underline [&_.source-actions_button]:underline-offset-[2px] [&_.source-actions_button]:cursor-pointer [&_.source-actions_a]:p-0 [&_.source-actions_a]:border-0 [&_.source-actions_a]:bg-transparent [&_.source-actions_a]:text-[#56634d] [&_.source-actions_a]:font-sans [&_.source-actions_a]:text-[12px] [&_.source-actions_a]:underline [&_.source-actions_a]:underline-offset-[2px] [&_.source-actions_a]:cursor-pointer work-artifacts flex flex-col gap-5 [&_.gate-item]:flex-wrap [&_.gate-item]:gap-2.5 [&_.gate-item]:pt-3 [&_.gate-item]:pr-0 [&_.gate-item]:pb-3 [&_.gate-item]:pl-0">{workId === 'FN-51' ? <><GateItem name="Unit tests" detail="184 passed" state="Passed" tone="green"/><GateItem name="Typecheck + lint" detail="Revision 7f3c2a1" state="Passed" tone="green"/><GateItem name="Permission regression" detail="Invite exposes a member outside the project" state="Failed" tone="red"/><GateItem name="Browser QA" detail="Waiting for the fix" state="Not run" tone="neutral"/><details className="qa-evidence-detail [&_summary]:cursor-pointer [&_summary]:text-[13px] [&_p]:mt-3 [&_p]:text-[13px] [&_p]:leading-[1.7]"><summary>Permission regression · evidence</summary><p>Observed: an invite exposes a member from another project. Expected: only members of the current project are visible.</p><small>Revision 7f3c2a1 · Rules v12 · Local browser · 10:47</small></details><GateItem name="Post-deploy verification" detail="Not deployed yet" state="Not run" tone="neutral"/></> : workId === 'FN-48' ? <><GateItem name="Required checks" detail="Tests, typecheck and lint" state="Passed" tone="green"/><GateItem name="Browser QA" detail="Invite retry verified" state="Passed" tone="green"/><GateItem name="Post-deploy verification" detail="Checking the deployed invite flow" state="Pending" tone="amber"/></> : <p>No QA results yet.</p>}</div>;
}
function EvidenceItem({ icon, title, detail, status, tone }: { icon: IconName; title: string; detail: string; status: string; tone: 'amber' | 'green' | 'red' | 'neutral' }) { return <div className="evidence-item flex items-center gap-2.25 min-h-14.5 border-b border-b-[#ededf0] [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_>_span:nth-child(2)]:gap-0.75 [&_strong]:text-[#45474e] [&_strong]:text-[13px] [&_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px]"><span className="evidence-icon grid place-items-center flex-[none] w-6.75 h-6.75 rounded-[6px] bg-[#f1f1f4] text-[#686b73]"><Icon name={icon} size={15}/></span><span><strong>{title}</strong><small>{detail}</small></span><Status tone={tone}>{status}</Status><button className="icon-button grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Open evidence for ${title}`}><Icon name="external" size={14}/></button></div>; }

function GateItem({ name, detail, state, tone, open, onClick }: { name: string; detail: string; state: string; tone: 'green' | 'red' | 'amber' | 'neutral'; open?: boolean; onClick?: () => void }) { return <div className="gate-item flex items-center gap-2.25 min-h-12 border-b border-b-[#f0f0f2] [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_>_span:nth-child(2)]:min-w-0 [&_strong]:text-[#4d4f56] [&_strong]:text-[13px] [&_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px] max-[560px]:gap-1.5 max-[560px]:[&_.text-action]:hidden"><span className={`gate-symbol grid place-items-center w-5.25 h-5.25 flex-[none] rounded-[6px] [&.green]:text-[#49816a] [&.green]:bg-[#edf5f0] [&.red]:text-[#ab504b] [&.red]:bg-[#faeeee] [&.amber]:text-[#a37532] [&.amber]:bg-[#faf3e7] [&.neutral]:text-[#686b73] [&.neutral]:bg-[#f0f0f2] ${tone}`}><Icon name={tone === 'green' ? 'check' : tone === 'red' ? 'alert' : 'clock'} size={14}/></span><span><strong>{name}</strong><small>{detail}</small></span><Status tone={tone}>{state}</Status>{onClick && <button className="text-action inline-flex items-center justify-start gap-1.25 w-[fit-content] min-h-8 pt-0.75 pr-0.5 pb-0.75 pl-0.5 border-0 rounded-[4px] bg-transparent text-[#596451] text-[13px] leading-[1.4] text-left underline underline-offset-[3px] cursor-pointer [&:hover]:text-[#3f4c39] [&:focus-visible]:outline-2 [&:focus-visible]:outline-[#817bbd] [&:focus-visible]:outline-offset-[2px] max-[560px]:min-h-11" onClick={onClick}>{open ? 'Collapse' : 'View'} <Icon name="chevron" size={12}/></button>}</div>; }

function WorkDelivery() {
  return <section className="work-delivery mt-6 pt-5 border-t border-t-[#e5e5e8] [&_h3]:text-[13px] [&_h3]:mt-0 [&_h3]:mr-0 [&_h3]:mb-3 [&_h3]:ml-0 [&_summary]:cursor-pointer [&_summary]:text-[13px] [&_details_p]:mt-3 [&_details_p]:text-[13px] [&_details_p]:leading-[1.7]"><h3>Delivery</h3><p><span className="diff-add-count text-[#238636] text-[12px] tabular-nums">PR merged → Deployed</span> → Verification pending</p><details><summary>Delivery details</summary><p>PR #184 · Merged at 09:22<br/>Revision b92ce10 · Deployed at 09:28 UTC</p><p>Required checks passed before deployment. The production invite flow still needs verification; this Work is not yet complete.</p></details></section>;
}

function Rules(p: RenderProps) {
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(true);
  const suggestions = [
    { label: 'Project context', text: 'Describe who this project serves and what matters most to them.' },
    { label: 'Working style', text: 'Prefer small, focused changes. Follow the existing project conventions.' },
    { label: 'Quality expectations', text: 'Verify the affected behavior before marking work complete. Explain anything that remains unverified.' },
    { label: 'When to ask', text: 'Ask before publishing externally or deploying to production.' },
    { label: 'Communication', text: 'Keep updates concise. Surface blockers, decisions, and meaningful results; avoid routine progress noise.' },
    { label: 'Research sources', text: 'Prefer primary sources. Link supporting evidence and distinguish verified facts from assumptions.' },
    { label: 'Writing style', text: 'Use plain language and concrete examples. Match the terminology and tone of existing project materials.' },
    { label: 'Design preferences', text: 'Keep interfaces simple and consistent. Reuse existing patterns and include accessible interaction states.' },
    { label: 'Dependencies', text: 'Prefer existing tools and dependencies. Explain the tradeoff before introducing a new one.' },
    { label: 'Handling uncertainty', text: 'State important assumptions. Ask when ambiguity would materially change the outcome; otherwise use reasonable judgment.' },
    { label: 'Sensitive information', text: 'Keep credentials and personal information out of logs, examples, and shared documents.' },
    { label: 'Definition of done', text: 'Check the result against the agreed goal. Summarize what was delivered and any remaining limitations.' },
  ];
  return <><PageHeading title="Project instructions" description="Give agents context and guidance for working on this project." action={editing ? <><Button variant="ghost" onClick={() => { setDraft(saved); setEditing(false); }}>Cancel</Button><Button onClick={() => { setSaved(draft.trim()); setEditing(false); }}>Save</Button></> : <Button variant="outline" onClick={() => { setDraft(saved); setEditing(true); }}>Edit</Button>}/>
    {editing ? <div className="project-instructions-editor [&_textarea]:min-h-80 [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-input [&_textarea]:bg-background [&_textarea]:p-5 [&_textarea]:text-sm [&_textarea]:leading-loose [&_textarea]:placeholder:text-muted-foreground"><textarea aria-label="Project instructions" value={draft} onChange={event => setDraft(event.target.value)} placeholder={'What should agents know about this project?\n\nYou might include project background, working preferences, quality expectations, or when to check with you. Write only what matters for your team.'}/><div className="instruction-suggestions flex flex-wrap items-center gap-2.5 mt-4 text-[12px] text-[#686b73] [&_button]:inline-flex [&_button]:items-center [&_button]:gap-3 [&_button]:pt-1.75 [&_button]:pr-2.5 [&_button]:pb-1.75 [&_button]:pl-2.5 [&_button]:border [&_button]:border-[#e5e5e8] [&_button]:rounded-[6px] [&_button]:bg-transparent [&_button]:text-[#25262a] [&_button]:cursor-pointer"><span>Optional starting points</span>{suggestions.map(suggestion => <button type="button" key={suggestion.label} onClick={() => setDraft(value => value.trim() ? `${value.trim()}\n\n${suggestion.text}` : suggestion.text)}>{suggestion.label}<Icon name="plus" size={13}/></button>)}</div></div> : <div className="project-instructions-document whitespace-pre-wrap text-sm leading-loose">{saved ? <p>{saved}</p> : <p className="settings-context-note my-3 text-sm leading-relaxed text-muted-foreground">No project instructions yet. Add guidance whenever you need it.</p>}</div>}
  </>;
}

function Skills(p: RenderProps) {
  const [mode, setMode] = useState<'create' | 'github' | 'marketplace' | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState([
    { name: 'Independent browser QA', source: 'Project · v3', detail: 'Verify user-facing behavior in the browser.' },
    { name: 'Slack feedback intake', source: 'Team · v2', detail: 'Connect customer feedback to the relevant Work.' },
  ]);
  const [expandedSkill, setExpandedSkill] = useState('');
  const add = (skillName: string, source: string, detail: string) => { setSkills(items => [...items, { name: skillName, source, detail }]); setMode(null); setName(''); setContent(''); setUrl(''); };
  const validUrl = (() => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.split('/').filter(Boolean).length >= 2; } catch { return false; } })();
  const catalog = [
    { name: 'Source research', type: 'Skill', detail: 'Find primary sources and summarize supporting evidence.' },
    { name: 'Writing toolkit', type: 'Plugin', detail: 'Includes Outline, Edit copy, and Review tone.', skills: ['Outline', 'Edit copy', 'Review tone'] },
    { name: 'Accessibility review', type: 'Skill', detail: 'Review keyboard navigation, labels, and contrast.' },
  ];
  return <><PageHeading title="Skills" action={<Button variant="outline" onClick={() => setMode('github')}><Icon name="plus" size={14}/>Add skill</Button>}/>
    {mode && <section className="skill-add-panel border border-[#e5e5e8] rounded-[10px] p-5.5 mb-7" aria-label="Add skill"><div className="skill-add-head flex justify-between items-center mb-3 [&_h3]:m-0 [&_h3]:text-[16px]"><h3>Add skill</h3><button type="button" className="icon-button grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close add skill" onClick={() => setMode(null)}><Icon name="close"/></button></div><div className="work-detail-tabs mb-3 flex gap-6 overflow-x-auto border-b border-border [&_button]:shrink-0 [&_button]:border-0 [&_button]:border-b-2 [&_button]:border-transparent [&_button]:bg-transparent [&_button]:px-0 [&_button]:pb-3 [&_button]:pt-2 [&_button]:text-sm [&_button]:text-muted-foreground [&_button[aria-selected=true]]:border-ring [&_button[aria-selected=true]]:text-foreground" role="tablist" aria-label="Skill source">{(['create', 'github', 'marketplace'] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={mode === tab} onClick={() => setMode(tab)}>{tab === 'create' ? 'Create' : tab === 'github' ? 'GitHub URL' : 'Marketplace'}</button>)}</div>
      {mode === 'create' && <form className="skill-create-form grid gap-4 [&_label]:grid [&_label]:gap-2 [&_label]:text-[13px] [&_textarea]:min-h-40 [&_textarea]:p-3 [&_textarea]:border [&_textarea]:border-[#e5e5e8] [&_textarea]:rounded-[6px] [&_textarea]:font-sans [&_textarea]:resize-y [&_textarea]:bg-transparent" onSubmit={event => { event.preventDefault(); if (name.trim() && content.trim()) add(name.trim(), 'Project · Custom', content.trim()); }}><label>Skill name<Input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Customer feedback triage"/></label><label>Instructions<textarea value={content} onChange={event => setContent(event.target.value)} placeholder="Describe when to use this skill and how to carry out the work."/></label><div><Button type="submit" disabled={!name.trim() || !content.trim()}>Create skill</Button></div></form>}
      {mode === 'github' && <form className="skill-create-form grid gap-4 [&_label]:grid [&_label]:gap-2 [&_label]:text-[13px] [&_textarea]:min-h-40 [&_textarea]:p-3 [&_textarea]:border [&_textarea]:border-[#e5e5e8] [&_textarea]:rounded-[6px] [&_textarea]:font-sans [&_textarea]:resize-y [&_textarea]:bg-transparent" onSubmit={event => { event.preventDefault(); if (validUrl) add(url.split('/').filter(Boolean).pop() ?? 'GitHub skill', 'GitHub · Preview', url); }}><label>GitHub URL<Input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"/></label><p className="skill-source-hint text-[#686b73] text-[12px]">Link to a skill folder or repository.</p><div><Button type="submit" disabled={!validUrl}>Add from GitHub</Button></div></form>}
      {mode === 'marketplace' && <><Input aria-label="Search marketplace" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search skills and plugins…"/><p className="skill-source-hint text-[#686b73] text-[12px]">Example catalog</p>{catalog.filter(item => `${item.name} ${item.detail}`.toLowerCase().includes(query.toLowerCase())).map(item => <div className="skill-market-row flex justify-between items-center gap-4 pt-4 pr-0 pb-4 pl-0 border-b border-b-[#e5e5e8] text-[14px] [&_p]:mt-1 [&_p]:mr-0 [&_p]:mb-0 [&_p]:ml-0 [&_p]:text-[#686b73] [&_p]:text-[13px]" key={item.name}><div><strong>{item.name}</strong><span className="skill-source-hint text-[#686b73] text-[12px]"> · {item.type}</span><p>{item.detail}</p></div><Button variant="outline" size="sm" disabled={(item.skills ?? [item.name]).every(skill => skills.some(existing => existing.name === skill))} onClick={() => { const names = item.skills ?? [item.name]; setSkills(items => [...items, ...names.filter(skill => !items.some(existing => existing.name === skill)).map(skill => ({ name: skill, source: `${item.name} · Marketplace preview`, detail: item.detail }))]); }}>{(item.skills ?? [item.name]).every(skill => skills.some(existing => existing.name === skill)) ? 'Added' : item.skills ? 'Add 3 skills' : 'Add'}</Button></div>)}</>}
    </section>}
    <Section title="Installed skills">{skills.map((skill, index) => <div key={`${skill.name}-${index}`}><button type="button" className="skill-library-row flex items-center gap-2.25 min-h-12.25 border-t border-t-[#ededf0] [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_>_span:nth-child(2)]:gap-0.5 [&_strong]:text-[#50525a] [&_strong]:text-[13px] [&_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px] skill-library-button w-full text-left bg-transparent border-0 border-b border-b-[#e5e5e8] cursor-pointer font-sans text-inherit" aria-expanded={expandedSkill === String(index)} onClick={() => setExpandedSkill(expandedSkill === String(index) ? '' : String(index))}><span className="skill-glyph grid place-items-center w-6.75 h-6.75 rounded-[6px] text-[#686b73] bg-[#f0f0f2]"><Icon name="work" size={15}/></span><span><strong>{skill.name}</strong><small>{skill.source}</small></span><Status tone={index < 2 ? 'green' : 'neutral'}>{index < 2 ? 'Current' : 'Preview'}</Status><Icon name="chevron" size={14}/></button>{expandedSkill === String(index) && <p className="skill-expanded-copy pt-3 pr-9 pb-3 pl-9 text-[14px] whitespace-pre-wrap break-words">{skill.detail}</p>}</div>)}</Section>
  </>;
}

function Members(p: RenderProps) {
  const [invite, setInvite] = useState(false);
  const [inviteStatus, setInviteStatus] = useState('');
  return <><PageHeading title="Members & access" description="Project members cannot access local folders or personal credentials." action={<Button className="dark-button border-primary bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setInvite(!invite)}><Icon name="plus" size={14}/> Invite member</Button>} meta={<><span>3 members · 1 pending invitation</span></>}/>
    {invite && <div className="invite-inline flex items-center gap-1.75 flex-wrap mb-3.75 p-2.25 border border-[#e9e9ed] rounded-[7px] bg-[#fbfbfc] [&_>_div]:grid [&_>_div]:flex-[1_0_100px] [&_>_div_strong]:text-[#51535a] [&_>_div_strong]:text-[13px] [&_>_div_small]:text-[#686b73] [&_>_div_small]:text-[13px] [&_input]:max-w-[185px] [&_select]:h-8.25 [&_select]:pt-0 [&_select]:pr-2 [&_select]:pb-0 [&_select]:pl-2 [&_select]:border [&_select]:border-[#e3e3e7] [&_select]:rounded-[6px] [&_select]:text-[#686b73] [&_select]:bg-[#fff] [&_select]:text-[13px]"><div><strong>Invite to Field Notes</strong><small>Invite will grant access to this project scope only.</small></div><Input placeholder="name@example.com" aria-label="Member email"/><select aria-label="Project role" defaultValue="Member"><option>Member</option><option>Admin</option></select><Button size="sm" className="dark-button border-primary bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setInviteStatus('Invitation pending · sample state')}>Send invite</Button><button className="icon-button grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close invite" onClick={() => setInvite(false)}><Icon name="close" size={14}/></button>{inviteStatus && <span className="invite-status text-[#686b73] text-[13px] w-full">{inviteStatus}</span>}</div>}
    <Section title="Active members" action={<span className="muted text-[#686b73] text-[13px]">Access follows project roles</span>}><MemberRow initials="YL" name="Yili Lin" email="yili@example.com" role="Owner" tone="indigo"/><MemberRow initials="M" name="Mika Chen" email="mika@example.com" role="Admin"/><MemberRow initials="A" name="Ari Zhou" email="ari@example.com" role="Member" tone="green"/></Section>
    <Section title="Pending invitation"><MemberRow initials="J" name="Jordan Wu" email="jordan@example.com" role="Member" state="Awaiting acceptance" tone="amber" action={<Button variant="ghost" size="sm" onClick={() => setInviteStatus('Invitation revoked · sample state')}>Revoke</Button>}/></Section>
    {inviteStatus && !invite && <div className="inline-feedback flex gap-1.75 items-center mt-3 text-[#686b73] text-[13px]"><Icon name="check" size={14}/>{inviteStatus}</div>}
  </>;
}
function MemberRow({ initials, name, email, role, state, tone = 'slate', action }: { initials: string; name: string; email: string; role: string; state?: string; tone?: string; action?: React.ReactNode }) { return <div className="member-row flex items-center gap-2.25 min-h-12.25 border-b border-b-[#f0f0f2] [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_>_span:nth-child(2)]:gap-0.25 [&_>_span:nth-child(2)_strong]:text-[#4c4e55] [&_>_span:nth-child(2)_strong]:text-[13px] [&_>_span:nth-child(2)_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px] max-[560px]:gap-1.5 max-[560px]:[&_>_span:nth-child(2)]:min-w-[90px]"><Avatar initials={initials} tone={tone}/><span><strong>{name}</strong><small>{email}</small></span><span className="member-role grid min-w-[105px] text-[#686b73] text-[13px] max-[560px]:min-w-auto">{role}{state && <small>{state}</small>}</span>{action || <button className="icon-button grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Options for ${name}`}><Icon name="dots"/></button>}</div>; }

function Connections(p: RenderProps) {
  const [scopes, setScopes] = useState(['repo:read/write','pull_request:read/write']);
  return <><PageHeading title="Connections" description="External access scopes, project mappings, and recent sync status." meta={<><span>2 connected services</span><span>Updated 8 minutes ago</span></>}/>
    <Section title="GitHub" action={<Status tone="green">Connected</Status>}><div className="connection-head flex items-center gap-2.25 pt-2.5 pr-0 pb-2.5 pl-0 border-t border-t-[#ededf0] [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_>_span:nth-child(2)]:gap-0.5 [&_strong]:text-[#494b52] [&_strong]:text-[13px] [&_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px]"><span className="service-icon grid place-items-center w-8 h-8 border border-[#e9e9ec] rounded-[8px] text-[#34353a] [&.slack-icon]:text-[#686b73]"><Icon name="github" size={19}/></span><span><strong>GitHub · yili-account</strong><small>Connected Sep 28, 2026 · Personal account</small></span><Button variant="outline" size="sm" onClick={() => p.toggleExpand('github-config')}>Manage</Button></div><div className="connection-details grid grid-cols-[1fr_1fr_1fr] gap-2.5 mt-0 mr-0 mb-1.5 ml-10.25 pt-2.25 pr-0 pb-3 pl-0 border-t border-t-[#f0f0f2] [&_>_span]:grid [&_>_span]:gap-0.75 [&_small]:text-[#686b73] [&_small]:text-[13px] [&_small]:font-semibold [&_small]:tracking-[.06em] [&_strong]:text-[#686b73] [&_strong]:text-[13px] [&_strong]:font-semibold [&_strong_.fresh-dot]:mr-1 [&_strong_.stale-dot]:mr-1 max-[560px]:grid-cols-[1fr_1fr] max-[560px]:ml-0 max-[560px]:[&_>_span:last-child]:col-[1_/_-1]"><span><small>PROJECT REPOSITORY</small><strong>org/field-notes</strong></span><span><small>CHECKOUT</small><strong>Local clone · current</strong></span><span><small>LAST SYNC</small><strong><i className="fresh-dot inline-block w-1.5 h-1.5 rounded-full bg-[#55a17e]"/> 8 minutes ago</strong></span></div>{p.expanded.includes('github-config') && <div className="expanded-settings grid gap-2 mt-0 mr-0 mb-2.25 ml-10.25 pt-2.25 pr-2.5 pb-2.25 pl-2.5 border-t border-t-[#ededf0] bg-[#fafafb] text-[#686b73] text-[13px] [&_>_strong]:text-[#55575f] [&_>_strong]:text-[13px] [&_>_div]:flex [&_>_div]:flex-wrap [&_>_div]:gap-[7px_12px] [&_label]:flex [&_label]:gap-1.25 [&_label]:items-center"><strong>Authorized scopes</strong><div>{['repo:read/write','pull_request:read/write','checks:read'].map((scope) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes(scopes.includes(scope) ? scopes.filter((item) => item !== scope) : [...scopes, scope])}/>{scope}</label>)}</div><small>Illustrative scope editor · no GitHub request is sent.</small></div>}</Section>
    <Section title="Slack" action={<Status tone="amber">Sync delayed</Status>}><div className="connection-head flex items-center gap-2.25 pt-2.5 pr-0 pb-2.5 pl-0 border-t border-t-[#ededf0] [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:flex-[1] [&_>_span:nth-child(2)]:gap-0.5 [&_strong]:text-[#494b52] [&_strong]:text-[13px] [&_strong]:font-semibold [&_small]:text-[#686b73] [&_small]:text-[13px]"><span className="service-icon grid place-items-center w-8 h-8 border border-[#e9e9ec] rounded-[8px] text-[#34353a] [&.slack-icon]:text-[#686b73] slack-icon"><Icon name="slack" size={19}/></span><span><strong>Slack · Product Team</strong><small>Workspace · product-feedback</small></span><Button variant="outline" size="sm" onClick={() => p.toggleExpand('slack-config')}>Reconnect</Button></div><div className="connection-details grid grid-cols-[1fr_1fr_1fr] gap-2.5 mt-0 mr-0 mb-1.5 ml-10.25 pt-2.25 pr-0 pb-3 pl-0 border-t border-t-[#f0f0f2] [&_>_span]:grid [&_>_span]:gap-0.75 [&_small]:text-[#686b73] [&_small]:text-[13px] [&_small]:font-semibold [&_small]:tracking-[.06em] [&_strong]:text-[#686b73] [&_strong]:text-[13px] [&_strong]:font-semibold [&_strong_.fresh-dot]:mr-1 [&_strong_.stale-dot]:mr-1 max-[560px]:grid-cols-[1fr_1fr] max-[560px]:ml-0 max-[560px]:[&_>_span:last-child]:col-[1_/_-1]"><span><small>PROJECT CHANNEL</small><strong>#product-feedback</strong></span><span><small>LAST SYNC</small><strong><i className="stale-dot inline-block w-1.5 h-1.5 rounded-full bg-[#c08b37]"/> 42 minutes ago · stale</strong></span><span><small>ROUTING</small><strong>Explicit project route</strong></span></div>{p.expanded.includes('slack-config') && <div className="expanded-settings grid gap-2 mt-0 mr-0 mb-2.25 ml-10.25 pt-2.25 pr-2.5 pb-2.25 pl-2.5 border-t border-t-[#ededf0] bg-[#fafafb] text-[#686b73] text-[13px] [&_>_strong]:text-[#55575f] [&_>_strong]:text-[13px] [&_>_div]:flex [&_>_div]:flex-wrap [&_>_div]:gap-[7px_12px] [&_label]:flex [&_label]:gap-1.25 [&_label]:items-center">Reconnect will require the host connector and authorized channel scope. <Status tone="amber">Connector currently offline</Status></div>}</Section>

  </>;
}

function WorkspaceSettings(p: RenderProps) {
  const selected = p.settingsTab === 'profiles' ? 'profiles' : 'accounts';
  return <><PageHeading title="Workspace settings"/><WorkspaceSettingsTabs selected={selected} projectId={p.project.id}/>
    {selected === 'profiles' ? <><p className="settings-context-note my-3 text-sm leading-relaxed text-muted-foreground">Profiles hold model, skills, and tools preferences.</p><AgentProfilesSettings profiles={p.agentProfiles} onSave={p.saveAgentProfile}/></> : <div className="runtime-settings w-full">
      <ProviderConnections/>
    </div>}
  </>;
}

function ProviderConnections() {
  const [connections, setConnections] = useState([
    { id: 'openai-personal', provider: 'OpenAI', name: 'Personal', method: 'Subscription' },
    { id: 'openai-team', provider: 'OpenAI', name: 'Team API', method: 'API key' },
  ]);
  const [defaultId, setDefaultId] = useState('openai-personal');
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState('OpenAI');
  const [name, setName] = useState('');
  return <Section title="Model providers" action={<Button variant="outline" onClick={() => setAdding(true)}><Icon name="plus" size={14}/>Add connection</Button>}>
    <p className="settings-context-note my-3 text-sm leading-relaxed text-muted-foreground">Manage provider connections for your agents.</p>
    {adding && <form className="provider-add-form flex flex-wrap gap-4 p-4.5 mt-4 mr-0 mb-4 ml-0 border border-[#e5e5e8] rounded-[8px] [&_label]:grid [&_label]:gap-2 [&_label]:text-[13px] [&_input]:border [&_input]:border-[#e5e5e8] [&_input]:rounded-[6px] [&_input]:pt-2.25 [&_input]:pr-3 [&_input]:pb-2.25 [&_input]:pl-3 [&_input]:bg-transparent [&_input]:font-sans [&_select]:border [&_select]:border-[#e5e5e8] [&_select]:rounded-[6px] [&_select]:pt-2.25 [&_select]:pr-3 [&_select]:pb-2.25 [&_select]:pl-3 [&_select]:bg-transparent [&_select]:font-sans" onSubmit={(event) => { event.preventDefault(); if (!name.trim()) return; setConnections(items => [...items, { id: `connection-${Date.now()}`, provider, name: name.trim(), method: 'API key' }]); setName(''); setAdding(false); }}><label>Provider<select value={provider} onChange={event => setProvider(event.target.value)}>{['OpenAI', 'Anthropic', 'OpenRouter', 'Z.ai'].map(item => <option key={item}>{item}</option>)}</select></label><label>Connection name<input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Research team" required/></label><div><Button variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" disabled={!name.trim()}>Add</Button></div></form>}
    <div className="provider-list">{connections.map(connection => <div className="provider-row flex flex-wrap items-center gap-4 border-b border-border py-4.5" key={connection.id}><Avatar initials={connection.provider.charAt(0)}/><div className="provider-identity grid flex-1 gap-1 [&_small]:text-xs [&_small]:text-muted-foreground"><strong>{connection.provider}</strong><small>{connection.name} · {connection.method}</small></div><span className="provider-state text-xs text-muted-foreground">Not connected</span>{defaultId === connection.id ? <Status tone="neutral">Default</Status> : <Button variant="ghost" size="sm" onClick={() => setDefaultId(connection.id)}>Set default</Button>}</div>)}</div>
    <p className="settings-context-note my-3 text-sm leading-relaxed text-muted-foreground">Prototype connections · no credentials required.</p>
  </Section>;
}

function WorkspaceSettingsTabs({ selected, projectId }: { selected: WorkspaceSettingsTab; projectId: string }) {
  const tabs: [WorkspaceSettingsTab, string][] = [['profiles','Agent profiles'],['accounts','Model providers']];
  return <nav className="settings-tabs mb-5 flex gap-2 overflow-x-auto border-b border-border pb-3 [&_a]:shrink-0 [&_a]:rounded-md [&_a]:px-3 [&_a]:py-2 [&_a]:text-sm [&_a]:text-muted-foreground [&_a:hover]:bg-muted [&_a.active]:bg-accent [&_a.active]:text-accent-foreground" aria-label="Workspace settings">{tabs.map(([tab, label]) => <a key={tab} className={selected === tab ? "active" : ""} aria-current={selected === tab ? 'page' : undefined} href={workspaceSettingsHref(tab, projectId)}>{label}</a>)}</nav>;
}
