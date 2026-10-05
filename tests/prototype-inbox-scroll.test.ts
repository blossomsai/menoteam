import { describe, expect, it } from 'vitest';
import { inboxAppendAction, shouldFollowLatest } from '../docs/prototypes/2026-10-02/team-workbench-v3/src/workbench';

describe('Master inbox scroll policy', () => {
  it('treats the 56px bottom gap as following and the next pixel as reading history', () => {
    expect(shouldFollowLatest(344, 400, 800)).toBe(true);
    expect(shouldFollowLatest(343, 400, 800)).toBe(false);
  });

  it('uses the previous real scroll position to choose follow-now versus the new-message action', () => {
    const nearBottomBeforeAppend = shouldFollowLatest(344, 400, 800);
    const readingOlderMessages = shouldFollowLatest(240, 400, 800);
    expect(inboxAppendAction(nearBottomBeforeAppend)).toBe('follow-now');
    expect(inboxAppendAction(readingOlderMessages)).toBe('show-new-messages');
  });
});
