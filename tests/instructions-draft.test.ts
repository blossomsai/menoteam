import { describe, expect, it } from 'vitest';
import { cancelInstructionsDraft, completeInstructionsSave, editInstructionsDraft, hasRemoteInstructionsUpdate, keepInstructionsDraft, startInstructionsDraft, useLatestInstructions } from '../src/workbench/web/instructions-draft';
import { createSnapshotRequestHandler } from '../src/workbench/web/snapshot-request';

describe('Project Instructions draft resolution', () => {
  it('keeps edits intact when polling observes a remote change', () => {
    const editing = editInstructionsDraft(startInstructionsDraft('Initial'), 'My unsaved edit');
    expect(hasRemoteInstructionsUpdate(editing, 'Remote update')).toBe(true);
    expect(editing.draft).toBe('My unsaved edit');
  });

  it('makes reload, keep editing, and cancel explicit and lossless', () => {
    const local = editInstructionsDraft(startInstructionsDraft('Initial'), 'My unsaved edit');
    const kept = keepInstructionsDraft(local, 'Remote update');
    expect(kept).toEqual({ draft: 'My unsaved edit', base: 'Remote update' });
    expect(useLatestInstructions('Remote update')).toEqual({ draft: 'Remote update', base: 'Remote update' });
    expect(cancelInstructionsDraft('Latest confirmed')).toEqual({ draft: 'Latest confirmed', base: 'Latest confirmed' });
  });

  it('preserves typing made while an earlier save is in flight', () => {
    const submitted = editInstructionsDraft(startInstructionsDraft('Initial'), 'Submitted version');
    const typedWhileSaving = editInstructionsDraft(submitted, 'Newer unsaved edit');
    expect(completeInstructionsSave(typedWhileSaving, 'Submitted version')).toEqual({
      state: { draft: 'Newer unsaved edit', base: 'Submitted version' },
      closeEditor: false,
    });
    expect(completeInstructionsSave(submitted, 'Submitted version')).toEqual({
      state: { draft: 'Submitted version', base: 'Submitted version' },
      closeEditor: true,
    });
  });

  it('keeps a save refresh ahead of an older in-flight poll and resolves the draft against that latest snapshot', async () => {
    let resolvePoll!: (snapshot: string) => void;
    let resolveRefresh!: (snapshot: string) => void;
    const pollResponse = new Promise<string>(resolve => { resolvePoll = resolve; });
    const refreshResponse = new Promise<string>(resolve => { resolveRefresh = resolve; });
    const responses = [pollResponse, refreshResponse];
    let accepted = 'Initial';
    const applySnapshot = (snapshot: string) => { accepted = snapshot; };
    const requestSnapshot = createSnapshotRequestHandler(() => responses.shift()!, () => 0, applySnapshot, cause => { throw cause; });

    const polling = requestSnapshot();
    let draft = editInstructionsDraft(startInstructionsDraft('Initial'), 'Submitted B');
    draft = editInstructionsDraft(draft, 'Typing C while saving');
    const saveRefresh = requestSnapshot();
    resolveRefresh('Saved B');
    await saveRefresh;
    expect(accepted).toBe('Saved B');
    expect(hasRemoteInstructionsUpdate(draft, accepted)).toBe(true);
    expect(completeInstructionsSave(draft, 'Submitted B').state).toEqual({ draft: 'Typing C while saving', base: 'Submitted B' });

    resolvePoll('Old A');
    await polling;
    expect(accepted).toBe('Saved B');
    expect(useLatestInstructions(accepted)).toEqual({ draft: 'Saved B', base: 'Saved B' });
    expect(cancelInstructionsDraft(accepted)).toEqual({ draft: 'Saved B', base: 'Saved B' });
  });
});
