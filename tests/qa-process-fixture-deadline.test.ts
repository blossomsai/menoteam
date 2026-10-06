import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QaProcessFixture, qaProcessFixture } from './helpers/qa-process-fixture.js';
import { qaFixtureBudget } from './helpers/qa-fixture-budget.js';
import { qaPolicyFixture } from './helpers/local-qa-fixture.js';
// Timers drive bounded races; only explicit lifecycle boundaries move the clock.
function controlledClock() {
  let now = 1_800_000_000_000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });


it('charges delayed directory removal to the shared deadline before allowing the next fixture', async () => {
  const clock = controlledClock();
  let actions = 0;
  let removedDirectory = '';
  const budget = qaFixtureBudget(36_000, 2, clock.now);

  await qaProcessFixture(async () => {
    actions++;
    clock.advance(6_900);
  }, budget, async directory => {
    removedDirectory = directory;
    clock.advance(10_700);
    await rm(directory, { recursive: true, force: true });
  });

  expect(actions).toBe(1);
  await expect(access(removedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  // Directory finalization consumed 10.7s; the next 6s action reserve no longer fits.
  await expect(qaProcessFixture(async () => { actions++; }, budget)).rejects.toThrow(/deadline exhausted; no action started/);
  expect(actions).toBe(1);
  expect(budget.remainingFixtures()).toBe(1);
});

it('tracks timed-out removal and blocks another action until that removal settles', async () => {
  const clock = controlledClock();
  const budget = qaFixtureBudget(36_000, 2, clock.now);
  const removing = barrier(), releaseRemoval = barrier();
  let directory = '', actions = 0;
  const first = qaProcessFixture(async () => { actions++; clock.advance(6_900); }, budget, async owned => {
    directory = owned;
    clock.advance(10_700);
    removing.release();
    await releaseRemoval.promise;
    await rm(owned, { recursive: true, force: true });
  });
  const rejected = expect(first).rejects.toThrow(/directory removal remains pending; another fixture is blocked/);
  try {
    await removing.promise;
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(budget.pendingFinalizations()).toBe(1);
    await expect(qaProcessFixture(async () => { actions++; }, budget)).rejects.toThrow(/finalization is still pending; no action started/);
    expect(actions).toBe(1);
    releaseRemoval.release();
    await budget.drainFinalizations();
    expect(budget.pendingFinalizations()).toBe(0);
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    releaseRemoval.release();
    await first.catch(() => undefined);
    await budget.drainFinalizations().catch(() => undefined);
  }
});

it('rejects an expired budget before creating a directory or invoking the action', async () => {
  let actions = 0;
  const clock = controlledClock();
  const budget = qaFixtureBudget(36_000, 1, clock.now);
  clock.advance(40_000);

  await expect(qaProcessFixture(async () => { actions++; }, budget)).rejects.toThrow(/deadline exhausted; no action started/);
  expect(actions).toBe(0);
  expect(budget.pendingFinalizations()).toBe(0);
});

it('bounds delayed directory creation, removes its late directory, and blocks actions until cleanup settles', async () => {
  const clock = controlledClock();
  const budget = qaFixtureBudget(40_000, 2, clock.now);
  let releaseCreate!: () => void;
  const creationGate = new Promise<void>(resolve => { releaseCreate = resolve; });
  let createdDirectory = '';
  let removeStarted = false;
  let signalRemovalStarted!: () => void;
  const removalStarted = new Promise<void>(resolve => { signalRemovalStarted = resolve; });
  let releaseRemoval!: () => void;
  const removalGate = new Promise<void>(resolve => { releaseRemoval = resolve; });
  const actions: string[] = [];

  const createDirectory = async () => {
    creationStarted.release();
    await creationGate;
    createdDirectory = await mkdtemp(path.join(os.tmpdir(), 'qa-late-create-owned-'));
    return createdDirectory;
  };
  const removeDirectory = async (directory: string) => {
    removeStarted = true;
    signalRemovalStarted();
    await removalGate;
    await rm(directory, { recursive: true, force: true });
  };
  const actionThatWouldStartARealParent = async (fixture: QaProcessFixture) => {
    actions.push('parent-action');
    await fixture.parent(fixture.state(), qaPolicyFixture());
  };

  const creationStarted = barrier();
  const first = qaProcessFixture(actionThatWouldStartARealParent, budget, removeDirectory, createDirectory);
  try {
    const rejected = expect(first).rejects.toThrow(/directory creation deadline exceeded/);
    await creationStarted.promise;
    clock.advance(500);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(actions).toEqual([]);
    expect(budget.pendingFinalizations()).toBe(1);
    expect(removeStarted).toBe(false);

    await expect(qaProcessFixture(actionThatWouldStartARealParent, budget)).rejects.toThrow(/finalization is still pending; no action started/);
    expect(actions).toEqual([]);

    releaseCreate();
    await removalStarted;
    expect(removeStarted).toBe(true);
    expect(createdDirectory).not.toBe('');
    await expect(access(createdDirectory)).resolves.toBeUndefined();

    // A third fixture cannot race the late removal. Release it only after proving the owned directory is gone.
    await expect(qaProcessFixture(async () => { actions.push('next-action'); }, budget)).rejects.toThrow(/finalization is still pending; no action started/);
    expect(actions).toEqual([]);
    releaseRemoval();
    await budget.drainFinalizations();
    expect(budget.pendingFinalizations()).toBe(0);
    await expect(access(createdDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    await qaProcessFixture(async fixture => {
      actions.push('resumed-action');
      await expect(access(fixture.directory)).resolves.toBeUndefined();
    }, budget);
    expect(actions).toEqual(['resumed-action']);
  } finally {
    releaseCreate();
    releaseRemoval();
    await first.catch(() => undefined);
    await budget.drainFinalizations().catch(() => undefined);
    if (createdDirectory) await rm(createdDirectory, { recursive: true, force: true });
  }
});

it('drains a failed directory creation without starting an action or poisoning later fixtures', async () => {
  const clock = controlledClock();
  const budget = qaFixtureBudget(40_000, 2, clock.now);
  const actions: string[] = [];
  await expect(qaProcessFixture(async () => { actions.push('unexpected'); }, budget, undefined, async () => { throw Error('controlled mkdir failure'); }))
    .rejects.toThrow(/Fixture directory creation failed; no action started/);
  expect(actions).toEqual([]);
  expect(budget.pendingFinalizations()).toBe(0);
  expect(budget.failedFinalizations()).toBe(0);
  await qaProcessFixture(async fixture => {
    actions.push('after-create-failure');
    await expect(access(fixture.directory)).resolves.toBeUndefined();
  }, budget);
  expect(actions).toEqual(['after-create-failure']);
});

it('accepts the exact two-fixture boundary and rejects one millisecond of insufficient creation reserve', async () => {
  const clock = controlledClock();
  const budget = qaFixtureBudget(36_000, 2, clock.now);
  const originalCleanup = QaProcessFixture.prototype.cleanup;
  vi.spyOn(QaProcessFixture.prototype, 'cleanup').mockImplementation(async function(this: QaProcessFixture, deadline) {
    await originalCleanup.call(this, deadline);
    clock.advance(10_000);
  });
  const create = async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'qa-exact-boundary-'));
    clock.advance(500);
    return directory;
  };
  const remove = async (directory: string) => {
    await rm(directory, { recursive: true, force: true });
    clock.advance(500);
  };
  for (let i = 0; i < 2; i++) {
    await qaProcessFixture(async () => { clock.advance(6_000); }, budget, remove, create);
  }
  expect(budget.remainingFixtures()).toBe(0);
  expect(clock.now()).toBe(budget.deadline);

  const insufficient = qaFixtureBudget(36_000, 2, clock.now);
  clock.advance(1);
  const createSideEffect = vi.fn(create);
  await expect(qaProcessFixture(async () => { throw Error('must not run'); }, insufficient, remove, createSideEffect))
    .rejects.toThrow(/deadline exhausted; no action started/);
  expect(createSideEffect).not.toHaveBeenCalled();
});

it('tracks timed-out original cleanup through safe removal and requires explicit drain before budget reuse', async () => {
  const clock = controlledClock();
  const budget = qaFixtureBudget(40_000, 1, clock.now);
  const tracking = vi.spyOn(budget, 'trackFinalization');
  const cleanupStarted = barrier(), releaseCleanup = barrier();
  const removalStarted = barrier(), releaseRemoval = barrier(), removalCompleted = barrier();
  const originalCleanup = QaProcessFixture.prototype.cleanup;
  const cleanupSpy = vi.spyOn(QaProcessFixture.prototype, 'cleanup').mockImplementation(async function(this: QaProcessFixture, deadline) {
    // Actual empty-fixture stop proof succeeds; only its acknowledgement is delayed.
    await originalCleanup.call(this, deadline);
    cleanupStarted.release();
    await releaseCleanup.promise;
  });
  let directory = '';
  const first = qaProcessFixture(async fixture => { directory = fixture.directory; }, budget, async owned => {
    removalStarted.release();
    await releaseRemoval.promise;
    await rm(owned, { recursive: true, force: true });
    removalCompleted.release();
  });
  const rejected = expect(first).rejects.toThrow(/Fixture cleanup failed; preserved/);
  const forbiddenAction = vi.fn(async () => {});
  try {
    await cleanupStarted.promise;
    clock.advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    await expect(access(directory)).resolves.toBeUndefined();
    expect(budget.pendingFinalizations()).toBe(1);
    await expect(qaProcessFixture(forbiddenAction, budget)).rejects.toThrow(/still pending/);
    expect(forbiddenAction).not.toHaveBeenCalled();
    releaseCleanup.release();
    await removalStarted.promise;
    await expect(qaProcessFixture(forbiddenAction, budget)).rejects.toThrow(/still pending/);
    releaseRemoval.release();
    await removalCompleted.promise;
    // Creation is the first tracked operation; the second is the original
    // cleanup plus late removal. Observe its actual settle, not a guessed tick.
    await tracking.mock.results[1]!.value;
    await expect(qaProcessFixture(forbiddenAction, budget)).rejects.toThrow(/explicit safe drain/);
    await budget.drainFinalizations();
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(budget.pendingFinalizations()).toBe(0);
    cleanupSpy.mockRestore();
    await qaProcessFixture(async fixture => { await access(fixture.directory); }, budget);
  } finally {
    releaseCleanup.release();
    releaseRemoval.release();
    await first.catch(() => undefined);
    await budget.drainFinalizations().catch(() => undefined);
  }
});

it('poisons the same budget on unknown stop proof and preserves its original evidence', async () => {
  const clock = controlledClock();
  const budget = qaFixtureBudget(40_000, 1, clock.now);
  vi.spyOn(QaProcessFixture.prototype, 'cleanup').mockRejectedValue(Error('Fixture stop proof unknown; ownership retained'));
  let directory = '';
  try {
    await expect(qaProcessFixture(async fixture => {
      directory = fixture.directory;
      await writeFile(path.join(directory, 'owned-evidence.json'), '{"stop":"unknown"}');
    }, budget)).rejects.toThrow(/Fixture cleanup failed; preserved/);
    expect(await readFile(path.join(directory, 'owned-evidence.json'), 'utf8')).toBe('{"stop":"unknown"}');
    expect(budget.pendingFinalizations()).toBe(0);
    expect(budget.failedFinalizations()).toBe(1);
    await expect(budget.drainFinalizations()).rejects.toThrow(/ownership retained/);
    const forbiddenAction = vi.fn(async () => {});
    await expect(qaProcessFixture(forbiddenAction, budget)).rejects.toThrow(/finalization failed; ownership retained/);
    expect(forbiddenAction).not.toHaveBeenCalled();
    expect(budget.creationMs()).toBe(500); // Time remains; poison, not timeout, blocks the start.
  } finally {
    // This controlled fixture never created any process or resource lock.
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it('keeps a late original-cleanup rejection poisoned after the bounded caller already returned', async () => {
  const clock = controlledClock();
  const budget = qaFixtureBudget(40_000, 1, clock.now);
  const tracking = vi.spyOn(budget, 'trackFinalization');
  const started = barrier(), release = barrier();
  const originalCleanup = QaProcessFixture.prototype.cleanup;
  vi.spyOn(QaProcessFixture.prototype, 'cleanup').mockImplementation(async function(this: QaProcessFixture, deadline) {
    started.release();
    await release.promise;
    // The real cleanup now fails its stop-proof deadline; no identity is invented.
    await originalCleanup.call(this, deadline);
  });
  let directory = '';
  const first = qaProcessFixture(async fixture => { directory = fixture.directory; }, budget);
  const rejected = expect(first).rejects.toThrow(/Fixture cleanup failed; preserved/);
  try {
    await started.promise;
    clock.advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(budget.pendingFinalizations()).toBe(1);
    release.release();
    await expect(tracking.mock.results[1]!.value).rejects.toThrow(/Fixture stop proof unknown/);
    expect(budget.pendingFinalizations()).toBe(0);
    expect(budget.failedFinalizations()).toBe(1);
    await expect(access(directory)).resolves.toBeUndefined();
    await expect(budget.drainFinalizations()).rejects.toThrow(/ownership retained/);
    await expect(qaProcessFixture(async () => { throw Error('must not run'); }, budget)).rejects.toThrow(/ownership retained/);
  } finally {
    release.release();
    await first.catch(() => undefined);
    await budget.drainFinalizations().catch(() => undefined);
    // No child/resource was started by this controlled empty fixture.
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
