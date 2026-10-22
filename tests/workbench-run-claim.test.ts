import { describe, expect, it } from 'vitest';
import { blocksRunClaim } from '../src/workbench/run-claim.js';

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'candidate', projectId: 'project', workId: undefined, kind: 'master', status: 'queued',
  createdAt: '2026-10-22T10:00:00.000Z', ...overrides,
});

describe('blocksRunClaim', () => {
  it.each([
    ['self', run(), false],
    ['other project', run({ id: 'other', projectId: 'elsewhere', status: 'running' }), false],
    ['other work', run({ id: 'other', workId: 'work', status: 'running' }), false],
    ['null work differs from undefined', run({ id: 'other', workId: null, status: 'running' }), false],
    ['running blocks despite stoppedAt', run({ id: 'other', status: 'running', stoppedAt: '2026-10-22T10:01:00.000Z' }), true],
    ['interrupted blocks despite stoppedAt', run({ id: 'other', status: 'interrupted', stoppedAt: '2026-10-22T10:01:00.000Z' }), true],
    ['unstopped paused blocks', run({ id: 'other', status: 'paused' }), true],
    ['stopped paused does not block', run({ id: 'other', status: 'paused', stoppedAt: '2026-10-22T10:01:00.000Z' }), false],
    ['unstopped cancelled blocks', run({ id: 'other', status: 'cancelled' }), true],
    ['stopped cancelled does not block', run({ id: 'other', status: 'cancelled', stoppedAt: '2026-10-22T10:01:00.000Z' }), false],
    ['earlier queued delivery blocks', run({ id: 'a-delivery', kind: 'delivery', status: 'queued', createdAt: '2026-10-22T09:59:00.000Z' }), true],
    ['later queued delivery does not block', run({ id: 'a-delivery', kind: 'delivery', status: 'queued', createdAt: '2026-10-22T10:01:00.000Z' }), false],
    ['delivery tie uses id order', run({ id: 'a-delivery', kind: 'delivery', status: 'queued' }), true],
    ['delivery tie after candidate does not block', run({ id: 'z-delivery', kind: 'delivery', status: 'queued' }), false],
    ['queued non-delivery does not block', run({ id: 'other', kind: 'master', status: 'queued', createdAt: '2026-10-22T09:00:00.000Z' }), false],
  ] as const)('%s', (_label, other, expected) => {
    expect(blocksRunClaim(run(), other)).toBe(expected);
  });
});
