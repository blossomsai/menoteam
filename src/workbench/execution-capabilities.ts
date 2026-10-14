import type { Run } from './types.js';

/** Both implementation and candidate review prepare an isolated checkout. */
export function requiresLocalWorktree(kind: Run['kind'] | undefined): boolean {
  return kind === 'implementation' || kind === 'review';
}
