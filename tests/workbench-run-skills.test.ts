import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { freezeRunSkills } from '../src/workbench/run-skills.js';
import type { Setting } from '../src/workbench/types.js';

const setting = (id: string, projectId: string | undefined, content: string, extra: Record<string, unknown> = {}): Setting => ({
    id, kind: 'skill', ...(projectId ? { projectId } : {}), name: id,
    data: { content, enabled: true, ...extra }, updatedAt: 'now'
});

describe('freezeRunSkills', () => {
    it('merges enabled workspace and matching project skills once, preserving hashes and provenance', () => {
        const workspace = setting('shared', undefined, 'Reusable');
        const project = setting('project-skill', 'project-a', 'Project rules', {
            provenance: 'github-import', sourceUrl: 'https://github.com/acme/skills/blob/main/SKILL.md',
            requestedRef: 'main', resolvedSha: 'a'.repeat(40), sourcePath: 'SKILL.md',
            contentSha256: createHash('sha256').update('Project rules').digest('hex')
        });
        const result = freezeRunSkills([
            workspace,
            setting('disabled-workspace', undefined, 'Disabled', { enabled: false })
        ], [
            project,
            setting('project-skill', 'project-a', 'Duplicate project ID'),
            setting('disabled-project', 'project-a', 'Disabled', { enabled: false }),
            setting('other-project', 'project-b', 'Do not leak')
        ], 'project-a');

        expect(result.map(skill => skill.id)).toEqual(['shared', 'project-skill']);
        expect(result[1]).toMatchObject({
            content: 'Project rules',
            contentSha256: project.data.contentSha256,
            provenance: 'github-import',
            sourceUrl: 'https://github.com/acme/skills/blob/main/SKILL.md',
            requestedRef: 'main', resolvedSha: 'a'.repeat(40), sourcePath: 'SKILL.md'
        });
    });
});
