import { freezeSkillBundle } from './skill-bundle.js';
import type { ExecutionContext, Setting } from './types.js';

export function freezeRunSkills(workspaceSkills: Setting[], projectSkills: Setting[], projectId: string): ExecutionContext['skills'] {
    const selected = [
        ...workspaceSkills.filter(skill => skill.kind === 'skill' && !skill.projectId && skill.data.enabled !== false),
        ...projectSkills.filter(skill => skill.kind === 'skill' && skill.projectId === projectId && skill.data.enabled !== false)
    ];
    const seen = new Set<string>();
    const skills: ExecutionContext['skills'] = selected.filter(skill => {
        if (seen.has(skill.id)) return false;
        seen.add(skill.id);
        return true;
    }).map(skill => ({...(skill.data.bundle !== undefined ? {bundle: freezeSkillBundle(skill.data.bundle, String(skill.data.content))} : {}), id: skill.id, name: skill.name, content: String(skill.data.content), ...(typeof skill.data.provenance === 'string' ? {provenance: skill.data.provenance} : {}), ...(typeof skill.data.sourceUrl === 'string' ? {sourceUrl: skill.data.sourceUrl} : {}), ...(typeof skill.data.requestedRef === 'string' ? {requestedRef: skill.data.requestedRef} : {}), ...(typeof skill.data.resolvedSha === 'string' ? {resolvedSha: skill.data.resolvedSha} : {}), ...(typeof skill.data.sourcePath === 'string' ? {sourcePath: skill.data.sourcePath} : {}), ...(typeof skill.data.contentSha256 === 'string' ? {contentSha256: skill.data.contentSha256} : {}), ...(typeof skill.data.sourceContentSha256 === 'string' ? {sourceContentSha256: skill.data.sourceContentSha256} : {}), ...(typeof skill.data.catalogUrl === 'string' ? {catalogUrl: skill.data.catalogUrl} : {}), ...(typeof skill.data.catalogResolvedSha === 'string' ? {catalogResolvedSha: skill.data.catalogResolvedSha} : {}), ...(skill.data.copiedFrom && typeof skill.data.copiedFrom === 'object' ? {copiedFrom: structuredClone(skill.data.copiedFrom) as ExecutionContext['skills'][number]['copiedFrom']} : {})}));
    return skills;
}
