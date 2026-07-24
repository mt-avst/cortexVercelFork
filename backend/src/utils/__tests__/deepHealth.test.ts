import { describe, it, expect, jest, beforeEach } from '@jest/globals';

import { checkDatabaseHealth, createDatabaseHealthProbe } from '../deepHealth';

type FakePool = { query: jest.MockedFunction<any> };

const makePool = (): FakePool => ({ query: jest.fn() });

describe('checkDatabaseHealth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports healthy when the probe query succeeds', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const result = await checkDatabaseHealth(pool as any, 2000);

    expect(result.healthy).toBe(true);
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('reports unhealthy when the probe query rejects', async () => {
    const pool = makePool();
    pool.query.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkDatabaseHealth(pool as any, 2000);

    expect(result.healthy).toBe(false);
  });

  // The pool is configured with connectionTimeoutMillis: 10_000, so without an
  // independent cap a health check against a dead database would hang for ten
  // seconds - long enough for a probe or an uptime monitor to time out first
  // and report nothing useful.
  it('gives up on its own timeout rather than waiting for the pool', async () => {
    const pool = makePool();
    pool.query.mockImplementation(() => new Promise(() => {})); // never settles

    const started = Date.now();
    const result = await checkDatabaseHealth(pool as any, 50);

    expect(result.healthy).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // A late failure from the losing probe must not take the check (or the
  // process) with it. Deliberately NOT asserted via a process-level
  // 'unhandledRejection' listener added inside the test: jest replaces those,
  // so the listener never fires and such an assertion cannot fail. The runner
  // DOES still fail the suite on a genuinely unhandled rejection - it crashes
  // the worker - so that safety net is real, it just is not this test's to
  // claim. What this test asserts is the observable part: the verdict.
  it('survives the probe rejecting after the timeout has already won', async () => {
    const pool = makePool();
    let rejectQuery: (error: Error) => void = () => {};
    pool.query.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectQuery = reject;
        })
    );

    const result = await checkDatabaseHealth(pool as any, 20);
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe('timeout');

    rejectQuery(new Error('connection terminated unexpectedly'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Still the timeout verdict; the late rejection changed nothing.
    expect(result.healthy).toBe(false);
  });

  // pg throws synchronously if the pool has been ended. The probe call sits
  // inside the try for this reason - outside it, this rejects and the caller
  // inherits a throwing health check.
  it('never rejects, even when the pool throws synchronously', async () => {
    const pool = makePool();
    pool.query.mockImplementation(() => {
      throw new Error('Cannot use a pool after calling end on the pool');
    });

    await expect(checkDatabaseHealth(pool as any, 2000)).resolves.toMatchObject({
      healthy: false,
      reason: 'error',
    });
  });

  it('does not leak the driver message into the returned value', async () => {
    const pool = makePool();
    pool.query.mockRejectedValue(
      new Error('password authentication failed for user "adaptalabs"')
    );

    const result = await checkDatabaseHealth(pool as any, 2000);

    expect(JSON.stringify(result)).not.toMatch(/password/i);
  });
});

describe('createDatabaseHealthProbe', () => {
  it('shares one probe between concurrent callers', async () => {
    const pool = makePool();
    let resolveQuery: (value: unknown) => void = () => {};
    pool.query.mockImplementation(() => new Promise((resolve) => { resolveQuery = resolve; }));
    const probe = createDatabaseHealthProbe(pool as any, { timeoutMs: 2000, cacheMs: 0 });

    const all = Promise.all([probe(), probe(), probe()]);
    resolveQuery({ rows: [] });
    const results = await all;

    // The safety property: one query, not three. Without this an
    // unauthenticated caller pins a pool client per request during an outage.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.healthy)).toBe(true);
  });

  it('reuses a verdict for the cache window, then probes again', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [] });
    const probe = createDatabaseHealthProbe(pool as any, { timeoutMs: 2000, cacheMs: 50 });

    await probe();
    await probe();
    expect(pool.query).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 70));
    await probe();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('does not wedge after a failed probe', async () => {
    const pool = makePool();
    pool.query.mockRejectedValueOnce(new Error('down')).mockResolvedValue({ rows: [] });
    const probe = createDatabaseHealthProbe(pool as any, { timeoutMs: 2000, cacheMs: 0 });

    await expect(probe()).resolves.toMatchObject({ healthy: false });
    await expect(probe()).resolves.toMatchObject({ healthy: true });
  });
});
