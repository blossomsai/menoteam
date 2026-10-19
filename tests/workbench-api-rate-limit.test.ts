import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, canAutoPoll, resetRateLimitCooldown, workbenchApi } from '../src/workbench/web/api';

const response = (status: number, retryAfter?: string) => new Response(JSON.stringify({ message: 'limited' }), { status, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } });

describe('workbench API rate limit cooldown', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00.000Z')); resetRateLimitCooldown(); vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { resetRateLimitCooldown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each([
    ['120', 120_000], ['Mon, 19 Oct 2026 00:03:00 GMT', 180_000],
    [undefined, 2_000], ['bad', 2_000], ['2027-01-01', 2_000], ['Sat, 18 Oct 2026 00:00:00 GMT', 2_000], ['1e999', 2_000], ['-3', 2_000],
  ] as const)('parses Retry-After %s without a 60-second cap', async (header, wait) => {
    vi.mocked(fetch).mockResolvedValueOnce(response(429, header));
    await expect(workbenchApi.snapshot()).rejects.toMatchObject({ status: 429, retryAfter: header ?? null });
    expect(canAutoPoll()).toBe(false);
    vi.advanceTimersByTime(wait - 1); expect(canAutoPoll()).toBe(false);
    vi.advanceTimersByTime(1); expect(canAutoPoll()).toBe(true);
  });

  it('accepts zero Retry-After as a valid immediate deadline', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(429, '0'));
    await expect(workbenchApi.snapshot()).rejects.toMatchObject({ status: 429 });
    expect(canAutoPoll()).toBe(true);
  });

  it.each([401, 500])('does not create a cooldown for HTTP %s', async status => {
    vi.mocked(fetch).mockResolvedValueOnce(response(status, '120'));
    await expect(workbenchApi.snapshot()).rejects.toBeInstanceOf(ApiError);
    expect(canAutoPoll()).toBe(true);
  });

  it('does not let a late old-scope 429 extend the new session cooldown', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const oldRequest = workbenchApi.snapshot();
    resetRateLimitCooldown();
    resolve(response(429, '120'));
    await expect(oldRequest).rejects.toMatchObject({ status: 429 });
    expect(canAutoPoll()).toBe(true);
  });

  it('extends cooldown only when a new same-scope 429 has a later deadline', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(429, '120')).mockResolvedValueOnce(response(429, '3'));
    await expect(workbenchApi.snapshot()).rejects.toMatchObject({ status: 429 });
    await expect(workbenchApi.snapshot()).rejects.toMatchObject({ status: 429 });
    vi.advanceTimersByTime(119_999); expect(canAutoPoll()).toBe(false);
    vi.advanceTimersByTime(1); expect(canAutoPoll()).toBe(true);
  });

  it('ignores a late 429 from an aborted evidence request', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const controller = new AbortController();
    const pending = workbenchApi.artifact('evidence', controller.signal);
    controller.abort();
    resolve(response(429, '120'));
    await expect(pending).rejects.toMatchObject({ status: 429 });
    expect(canAutoPoll()).toBe(true);
  });
});
