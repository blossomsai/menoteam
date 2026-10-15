import { describe, expect, it } from 'vitest';
import {
  QA_FIXTURE_ACTION_RESERVE_MS,
  QA_FIXTURE_CLEANUP_RESERVE_MS,
  QA_FIXTURE_CREATE_RESERVE_MS,
  QA_FIXTURE_FINALIZE_RESERVE_MS,
  QA_FIXTURE_VITEST_MARGIN_MS,
  qaFixtureBudget,
} from './helpers/qa-fixture-budget.js';

describe('QA fixture wall-clock budgets', () => {
  it('reserves action, stop-proof cleanup, directory finalization and Vitest margin', () => {
    let now = 0;
    const budget = qaFixtureBudget(40_000, 1, () => now);
    const creation = budget.creationMs();
    expect(creation).toBe(QA_FIXTURE_CREATE_RESERVE_MS);
    now += creation;
    const action = budget.actionMs();
    expect(action).toBe(40_000 - QA_FIXTURE_VITEST_MARGIN_MS - creation - QA_FIXTURE_CLEANUP_RESERVE_MS - QA_FIXTURE_FINALIZE_RESERVE_MS);

    now += action;
    const cleanup = budget.cleanupMs();
    expect(cleanup).toBe(QA_FIXTURE_CLEANUP_RESERVE_MS);
    now += cleanup;
    const finalization = budget.finalizeMs();
    expect(finalization).toBe(QA_FIXTURE_FINALIZE_RESERVE_MS);
    now += finalization;
    budget.finishFixture();

    expect(now + QA_FIXTURE_VITEST_MARGIN_MS).toBe(40_000);
  });

  it('keeps sequential failure cleanup, finalization and next-owner proof inside one 36s deadline', () => {
    let now = 0;
    const budget = qaFixtureBudget(36_000, 2, () => now);

    expect(budget.creationMs()).toBe(QA_FIXTURE_CREATE_RESERVE_MS);
    now += QA_FIXTURE_CREATE_RESERVE_MS;
    const firstAction = budget.actionMs();
    expect(firstAction).toBe(QA_FIXTURE_ACTION_RESERVE_MS);
    now += firstAction;
    const firstCleanup = budget.cleanupMs();
    expect(firstCleanup).toBe(QA_FIXTURE_CLEANUP_RESERVE_MS);
    now += firstCleanup;
    now += budget.finalizeMs();
    budget.finishFixture();

    expect(budget.creationMs()).toBe(QA_FIXTURE_CREATE_RESERVE_MS);
    now += QA_FIXTURE_CREATE_RESERVE_MS;
    const nextOwnerAction = budget.actionMs();
    expect(nextOwnerAction).toBe(QA_FIXTURE_ACTION_RESERVE_MS);
    now += nextOwnerAction;
    const nextOwnerCleanup = budget.cleanupMs();
    expect(nextOwnerCleanup).toBe(QA_FIXTURE_CLEANUP_RESERVE_MS);
    now += nextOwnerCleanup;
    now += budget.finalizeMs();
    budget.finishFixture();

    expect(budget.remainingFixtures()).toBe(0);
    expect(now + QA_FIXTURE_VITEST_MARGIN_MS).toBe(36_000);
  });

  it('accounts for slow cleanup near the shared deadline without consuming the next fixture slot', () => {
    let now = 0;
    const budget = qaFixtureBudget(40_000, 2, () => now);
    now += budget.creationMs();
    now += budget.actionMs() - 100;
    const cleanup = budget.cleanupMs();
    now += cleanup;
    now += budget.finalizeMs();
    budget.finishFixture();

    expect(budget.creationMs()).toBe(QA_FIXTURE_CREATE_RESERVE_MS);
    now += budget.creationMs();
    expect(budget.actionMs()).toBe(QA_FIXTURE_ACTION_RESERVE_MS + 100);
    expect(budget.cleanupMs()).toBe(QA_FIXTURE_CLEANUP_RESERVE_MS);
    now += budget.actionMs() + budget.cleanupMs() + budget.finalizeMs();
    budget.finishFixture();
    expect(now + QA_FIXTURE_VITEST_MARGIN_MS).toBe(40_000);
  });

  it('rejects a timeout that cannot reserve every fixture action, cleanup and finalization window', () => {
    expect(() => qaFixtureBudget(34_000, 2)).toThrow(/cannot reserve fixture creation, action, cleanup, finalization and margin/);
  });
});
