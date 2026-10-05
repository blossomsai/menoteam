import type { Member, Project, Work } from '../types';

export type View = 'all' | 'master' | 'work' | 'work-detail' | 'connect' | 'instructions' | 'skills' | 'members' | 'connections' | 'agent-profiles' | 'model-providers';
export type Route = { view: View; projectId: string; workId: string; settingsTab: 'agent-profiles' | 'model-providers' };

const views: View[] = ['all', 'master', 'work', 'work-detail', 'connect', 'instructions', 'skills', 'members', 'connections', 'agent-profiles', 'model-providers'];

export function readRoute(href: string): Route {
  const url = new URL(href);
  const view = url.searchParams.get('view') as View | null;
  const selected = view && views.includes(view) ? view : 'all';
  return { view: selected, projectId: url.searchParams.get('project') ?? '', workId: url.searchParams.get('work') ?? '', settingsTab: selected === 'model-providers' ? 'model-providers' : 'agent-profiles' };
}

export function selectProject(projects: Project[], requestedId: string): Project | undefined {
  return requestedId ? projects.find(project => project.id === requestedId) : projects[0];
}

export function selectWork(works: Work[], requestedId: string, projectId?: string): Work | undefined {
  if (!requestedId || !projectId) return undefined;
  return works.find(work => work.id === requestedId && work.projectId === projectId);
}

export function filterWorks(works: Work[], status: string, query: string): Work[] {
  const search = query.trim().toLowerCase();
  return works.filter(work =>
    (status === 'All' || status === 'In progress' && work.status === 'in_progress' || status === 'Paused' && work.status === 'paused' || status === 'Done' && work.status === 'done') &&
    (!search || work.title.toLowerCase().includes(search) || work.overview.toLowerCase().includes(search))
  );
}

export function canManageProject(member: Member, memberships: Pick<Member, 'id' | 'role'>[]): boolean {
  return member.role === 'owner' || memberships.some(item => item.id === member.id && ['owner', 'admin'].includes(item.role));
}
