type ClaimRun = {
  id: string;
  projectId: string;
  workId?: string | null;
  kind: string;
  status: string;
  stoppedAt?: string;
  createdAt: string;
};

export function blocksRunClaim(candidate: ClaimRun, other: ClaimRun): boolean {
  return other.id !== candidate.id && other.projectId === candidate.projectId && other.workId === candidate.workId &&
    (['running', 'interrupted'].includes(other.status) ||
      (['paused', 'cancelled'].includes(other.status) && !other.stoppedAt) ||
      (other.kind === 'delivery' && other.status === 'queued' &&
        (Date.parse(other.createdAt) < Date.parse(candidate.createdAt) ||
          (Date.parse(other.createdAt) === Date.parse(candidate.createdAt) && other.id < candidate.id))));
}
