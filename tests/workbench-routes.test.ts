import { describe, expect, it } from 'vitest';
import type { Member, Project, Work } from '../src/workbench/types';
import { canManageProject, readRoute, selectProject, selectWork } from '../src/workbench/web/routes';

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

  it('shows project editing actions only to the owner or project admins', () => {
    const member: Member = { id: 'user-a', email: 'a@example.com', name: 'A', role: 'member' };
    expect(canManageProject(member, [{ ...member, role: 'member' }])).toBe(false);
    expect(canManageProject(member, [{ ...member, role: 'admin' }])).toBe(true);
    expect(canManageProject({ ...member, role: 'owner' }, [])).toBe(true);
    expect(canManageProject({ ...member, id: 'user-b', role: 'admin' }, [])).toBe(false);
  });
});
