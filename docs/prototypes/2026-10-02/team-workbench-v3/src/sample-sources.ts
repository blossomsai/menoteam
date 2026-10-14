export type SampleWorkSource = {
  id: string;
  projectId: string;
  relation: 'linked' | 'candidate';
  workId?: string;
  candidateWorkId?: string;
  type: 'Slack message' | 'GitHub issue' | 'GitHub pull request' | 'CI check';
  location: string;
  author: string;
  time: string;
  excerpt: string;
  original: string;
  responsibleAgent?: string;
  handling?: string;
};

export const sampleWorkSources: SampleWorkSource[] = [
  {
    id: 'fn51-slack-report', projectId: 'field-notes', relation: 'linked', workId: 'FN-51',
    type: 'Slack message', location: '#product-feedback', author: 'Nia Chen', time: 'Oct 5 · 09:12',
    excerpt: 'A project invite shows one member outside the expected scope.',
    original: 'I invited a teammate to Field Notes. The project invite page shows one existing member who should not be visible in this scope. Can you check the visibility rule before changing permissions?',
    responsibleAgent: 'Codex · FN-51',
  },
  {
    id: 'fn51-slack-repro', projectId: 'field-notes', relation: 'linked', workId: 'FN-51',
    type: 'Slack message', location: '#product-feedback · thread', author: 'Sam Rivera', time: 'Oct 5 · 09:28',
    excerpt: 'Reproduced with a second invite; same visibility mismatch.',
    original: 'I reproduced this with a second invite from a project admin account. The same extra member appears. This looks like the FN-51 permission regression, so I added the repro details there.',
    responsibleAgent: 'Codex · FN-51',
  },
  {
    id: 'fn51-github-issue', projectId: 'field-notes', relation: 'linked', workId: 'FN-51',
    type: 'GitHub issue', location: 'Issue #284', author: 'Nia Chen', time: 'Oct 5 · 09:41',
    excerpt: 'Track invite visibility against the project membership scope.',
    original: 'Issue #284 records the two invite reproductions and asks for a scope check before implementation. It is attached to the existing FN-51 regression work.',
    responsibleAgent: 'Codex · FN-51',
  },
  {
    id: 'fn51-github-pr', projectId: 'field-notes', relation: 'linked', workId: 'FN-51',
    type: 'GitHub pull request', location: 'Pull request #291 · review', author: 'Codex · FN-51', time: 'Oct 5 · 10:02',
    excerpt: 'Restricted fix plan is waiting for scope approval.',
    original: 'The proposed invite-scope change is still a plan for review. No restricted permission change has been applied; the review request stays on FN-51.',
    responsibleAgent: 'Codex · FN-51',
  },
  {
    id: 'fn51-ci-failure', projectId: 'field-notes', relation: 'linked', workId: 'FN-51',
    type: 'CI check', location: 'Pull request #291 · invite-visibility', author: 'GitHub Actions', time: 'Oct 5 · 10:18',
    excerpt: 'Invite visibility regression check failed; returned to the assigned Agent.',
    original: 'Baseline revision 7f3c2a1 failed the invite-visibility regression check. Master returned diagnosis to the responsible Codex · FN-51; no restricted permission change has been applied.',
    responsibleAgent: 'Codex · FN-51',
    handling: 'Returned to the responsible Agent',
  },
  {
    id: 'fn51-slack-guest-scope', projectId: 'field-notes', relation: 'candidate', candidateWorkId: 'FN-51',
    type: 'Slack message', location: '#product-feedback', author: 'Nia Chen', time: 'Oct 5 · 10:31',
    excerpt: 'Could guest access be included in the same change?',
    original: 'One more request: could this also change guest access? I am not sure whether that is part of the invite visibility fix or a separate policy decision.',
  },
  {
    id: 'fn56-independent-goal', projectId: 'field-notes', relation: 'linked', workId: 'FN-56',
    type: 'Slack message', location: '#product-feedback', author: 'Devon Park', time: 'Oct 5 · 10:48',
    excerpt: 'Please prepare a weekly access review summary for onboarding.',
    original: 'Separate request from the invite regression: please prepare a weekly access review summary for onboarding. A CSV-style snapshot of membership changes would be enough for the first version.',
    responsibleAgent: 'Master to assign',
  },
];

export function relatedSourcesForWork(projectId: string, workId: string) {
  return sampleWorkSources.filter((source) => source.projectId === projectId && source.relation === 'linked' && source.workId === workId);
}

export function candidateSourcesForWork(projectId: string, workId: string) {
  return sampleWorkSources.filter((source) => source.projectId === projectId && source.relation === 'candidate' && source.candidateWorkId === workId);
}
