import { describe, expect, it } from 'vitest';
import { candidateSourcesForWork, relatedSourcesForWork } from '../docs/prototypes/2026-10-02/team-workbench-v3/src/sample-sources';
import { parsePrototypeLocation, projectSourceHref, projectWorkHref, prototypeHref, workSelectionFromUrl } from '../docs/prototypes/2026-10-02/team-workbench-v3/src/workbench';

describe('project Work source relationships', () => {
  it('selects the requested Work and source after SPA navigation and history restoration', () => {
    const url = 'http://localhost/prototype?project=field-notes&view=V03&work=FN-51&source=fn51-slack-repro#work-list';
    expect(workSelectionFromUrl(url, 'field-notes', 'V03')).toEqual({ workId: 'FN-51', sourceId: 'fn51-slack-repro' });
    expect(workSelectionFromUrl(url.replace('FN-51', 'FN-56').replace('fn51-slack-repro', 'fn56-independent-goal'), 'field-notes', 'V03')).toEqual({ workId: 'FN-56', sourceId: 'fn56-independent-goal' });
    expect(workSelectionFromUrl(url, 'atlas', 'V03')).toEqual({ workId: '', sourceId: '' });
    expect(workSelectionFromUrl(url, 'field-notes', 'V17')).toEqual({ workId: '', sourceId: '' });
  });
  it('redirects every old Work Map URL to the same project Work list', () => {
    for (const projectId of ['field-notes', 'atlas', 'beacon']) {
      for (const input of [
        `http://localhost/prototype?project=${projectId}&view=V04`,
        `http://localhost/prototype?project=${projectId}#label-V04`,
      ]) {
        expect(parsePrototypeLocation(input)).toEqual({ projectId, viewId: 'V03' });
      }
      const legacyHref = prototypeHref(projectId, 'V04', `http://localhost/prototype?project=${projectId}&view=V04`);
      const url = new URL(legacyHref, 'http://localhost');
      expect(url.searchParams.get('project')).toBe(projectId);
      expect(url.searchParams.get('view')).toBe('V03');
      expect(url.hash).toBe('#work-list');
    }
  });

  it('keeps linked sources project and Work scoped while candidate evidence stays unlinked', () => {
    const linked = relatedSourcesForWork('field-notes', 'FN-51');
    expect(linked).toHaveLength(5);
    expect(relatedSourcesForWork('atlas', 'FN-51')).toEqual([]);
    expect(relatedSourcesForWork('field-notes', 'FN-48')).toEqual([]);

    const candidate = candidateSourcesForWork('field-notes', 'FN-51');
    expect(candidate).toHaveLength(1);
    expect(candidate[0]).toMatchObject({ relation: 'candidate', candidateWorkId: 'FN-51' });
    expect(candidate[0]).not.toHaveProperty('workId');
    expect(candidateSourcesForWork('atlas', 'FN-51')).toEqual([]);
    expect(relatedSourcesForWork('field-notes', 'FN-56')).toMatchObject([{ id: 'fn56-independent-goal', workId: 'FN-56', responsibleAgent: 'Master to assign' }]);
  });

  it('keeps repeat reports, PR review, and CI failure with FN-51 and its responsible Agent', () => {
    const linked = relatedSourcesForWork('field-notes', 'FN-51');
    expect(linked.filter((source) => source.type === 'Slack message')).toHaveLength(2);
    expect(new Set(linked.map((source) => source.workId))).toEqual(new Set(['FN-51']));
    expect(new Set(linked.map((source) => source.responsibleAgent))).toEqual(new Set(['Codex · FN-51']));
    expect(linked.find((source) => source.type === 'CI check')?.handling).toBe('Returned to the responsible Agent');
  });

  it('creates source and Work return links with their original project and selected Work', () => {
    const source = new URL(projectSourceHref('field-notes', 'FN-51', 'fn51-slack-repro', 'http://localhost/prototype?project=atlas&view=V03'), 'http://localhost');
    expect(parsePrototypeLocation(source)).toEqual({ projectId: 'field-notes', viewId: 'V05' });
    expect(source.searchParams.get('work')).toBe('FN-51');
    expect(source.searchParams.get('source')).toBe('fn51-slack-repro');

    const work = new URL(projectWorkHref('field-notes', 'FN-51', source.href), 'http://localhost');
    expect(parsePrototypeLocation(work)).toEqual({ projectId: 'field-notes', viewId: 'V05' });
    expect(work.searchParams.get('work')).toBe('FN-51');
    expect(work.searchParams.has('source')).toBe(false);

    for (const [projectId, workId] of [['atlas', 'AT-24'], ['beacon', 'BC-15']]) {
      const projectSource = new URL(projectSourceHref(projectId, workId, 'sample-source', source.href), 'http://localhost');
      expect(parsePrototypeLocation(projectSource)).toEqual({ projectId, viewId: 'V05' });
      expect(projectSource.searchParams.get('work')).toBe(workId);
    }
  });
});
