import { describe, expect, it } from 'vitest';
import type { Member, Project, Work } from '../src/workbench/types';
import { canManageProject, filterWorks, readRoute, selectProject, selectWork } from '../src/workbench/web/routes';

const project = (id: string): Project => ({ id, name: id, instructions: '', repositoryUrl: '', deliveryAuthorization: '', createdAt: '' });
const work = (id: string, projectId: string): Work => ({ id, projectId, title: id, overview: '', status: 'in_progress', revision: 1, profileId: '', sources: [], createdAt: '', updatedAt: '' });

describe('workbench route boundaries', () => {
  it('keeps the project-creation route available in an empty workspace', () => {
    const route = readRoute('http://localhost/workbench/?view=connect');
    expect(route.view).toBe('connect');
    expect(selectProject([], route.projectId)).toBeUndefined();
  });

  it('does not substitute the first project for an unknown explicit project id', () => {
    expect(selectProject([project('project-a')], 'missing-project')).toBeUndefined();
  });

  it('does not show a Work detail under a different project', () => {
    expect(selectWork([work('work-a', 'project-a')], 'work-a', 'project-b')).toBeUndefined();
    expect(selectWork([work('work-a', 'project-a')], 'work-a', 'project-a')?.id).toBe('work-a');
  });

  it('matches title or overview case-insensitively and intersects with status', () => {
    const works = [
      { ...work('title-match', 'project-a'), title: 'Build SEARCH panel', status: 'in_progress' as const },
      { ...work('overview-match', 'project-a'), overview: 'Contains searchable phrase', status: 'paused' as const },
      { ...work('wrong-status', 'project-a'), title: 'Search', status: 'done' as const },
    ];
    expect(filterWorks(works, 'All', 'sEaRcH').map(item => item.id)).toEqual(['title-match', 'overview-match', 'wrong-status']);
    expect(filterWorks(works, 'Paused', 'SEARCH').map(item => item.id)).toEqual(['overview-match']);
    expect(filterWorks(works, 'Paused', 'phrase').map(item => item.id)).toEqual(['overview-match']);
    expect(filterWorks(works, 'Done', 'search').map(item => item.id)).toEqual(['wrong-status']);
    expect(filterWorks(works, 'In progress', '').map(item => item.id)).toEqual(['title-match']);
  });

  it('shows project editing actions only to the owner or project admins', () => {
    const member: Member = { id: 'user-a', email: 'a@example.com', name: 'A', role: 'member' };
    expect(canManageProject(member, [{ ...member, role: 'member' }])).toBe(false);
    expect(canManageProject(member, [{ ...member, role: 'admin' }])).toBe(true);
    expect(canManageProject({ ...member, role: 'owner' }, [])).toBe(true);
    expect(canManageProject({ ...member, id: 'user-b', role: 'admin' }, [])).toBe(false);
  });
});
