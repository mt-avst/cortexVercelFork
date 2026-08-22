import { describe, it, expect } from '@jest/globals';

import { Semaphore, SemaphoreAbandonedError, releaseOnce } from '../semaphore';

/**
 * The queue, tested by HOLDING permits rather than by counting acquisitions.
 *
 * Both callers of this class exist because counting arrivals is not the same
 * as bounding occupancy, so a test that acquired and released in sequence
 * would pass against a semaphore that did nothing at all.
 */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const timeoutError = () => new Error('timed out');

describe('Semaphore', () => {
  it('admits up to its permits and holds the rest', async () => {
    const semaphore = new Semaphore(2);

    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(false);

    let admitted = false;
    void semaphore.acquire(1_000, timeoutError).then(() => {
      admitted = true;
    });
    await settle();

    expect(admitted).toBe(false);
    expect(semaphore.stats()).toEqual({ available: 0, waiting: 1 });

    semaphore.release();
    await settle();
    expect(admitted).toBe(true);
  });

  it('serves the longest-waiting acquirer first', async () => {
    const semaphore = new Semaphore(1);
    semaphore.tryAcquire();

    const order: string[] = [];
    const first = semaphore.acquire(1_000, timeoutError).then(() => order.push('first'));
    const second = semaphore.acquire(1_000, timeoutError).then(() => order.push('second'));
    await settle();

    semaphore.release();
    await first;
    semaphore.release();
    await second;

    expect(order).toEqual(['first', 'second']);
  });

  it('rejects with the error the caller built, not one of its own', async () => {
    const semaphore = new Semaphore(1);
    semaphore.tryAcquire();

    const mine = new Error('the report queue is full');
    await expect(semaphore.acquire(5, () => mine)).rejects.toBe(mine);

    // The abandoned waiter is gone, so the permit it would have been handed is
    // still real.
    expect(semaphore.stats()).toEqual({ available: 0, waiting: 0 });
    semaphore.release();
    expect(semaphore.stats().available).toBe(1);
  });

  /**
   * A caller who has already gone must not take a permit on the way past.
   *
   * Refused BEFORE `tryAcquire`, so an abandoned request cannot hold a permit
   * even momentarily while a live one waits - and, when the semaphore is full,
   * cannot join the queue at all. Adding an `abort` listener to a signal that
   * has already fired does NOT invoke it, so a waiter enqueued in that state
   * would sit there until its timeout with nobody coming back for it.
   *
   * Not reachable from `boundResultsRead` today - it registers its listener
   * and calls `acquire` in one synchronous block - which is exactly why it
   * needs asserting here rather than through a caller.
   */
  it('refuses an acquire whose caller has already gone, and takes nothing', async () => {
    const semaphore = new Semaphore(2);
    const controller = new AbortController();
    controller.abort();

    await expect(
      semaphore.acquire(1_000, timeoutError, controller.signal)
    ).rejects.toBeInstanceOf(SemaphoreAbandonedError);

    expect(semaphore.stats()).toEqual({ available: 2, waiting: 0 });
  });

  it('removes an aborted waiter from a full queue instead of leaving it parked', async () => {
    const semaphore = new Semaphore(1);
    semaphore.tryAcquire();

    const controller = new AbortController();
    const abandoned = semaphore.acquire(1_000, timeoutError, controller.signal);
    await settle();
    expect(semaphore.stats().waiting).toBe(1);

    controller.abort();
    await expect(abandoned).rejects.toBeInstanceOf(SemaphoreAbandonedError);
    expect(semaphore.stats()).toEqual({ available: 0, waiting: 0 });

    // The permit the parked waiter would have absorbed is still real.
    semaphore.release();
    expect(semaphore.stats().available).toBe(1);
  });

  it('does not hand one release to two waiters when release is called twice', async () => {
    const semaphore = new Semaphore(1);
    semaphore.tryAcquire();

    let admitted = 0;
    // EVERY WAITER IS SETTLED BEFORE THIS TEST RETURNS, and that is not
    // tidiness. The first version left the loser of this race queued with a
    // live 1000ms timer. `unref()` stops a timer holding the process open; it
    // does not stop it FIRING. A second later it rejected a promise carrying
    // only a `.then`, and the unhandled rejection was attributed to whichever
    // suite happened to be running by then - which is how this file timed out
    // `admin.db-tls-diagnostics.test.ts` in CI while passing on its own, and
    // pointed a stack trace at a module that turned out to be correct.
    //
    // Reproduced before it was believed. A test that leaves work running after
    // it has passed has not finished; it has just stopped looking.
    const waiters = [
      semaphore.acquire(1_000, timeoutError).then(() => {
        admitted += 1;
      }),
      semaphore.acquire(1_000, timeoutError).then(() => {
        admitted += 1;
      })
    ];
    await settle();

    const release = releaseOnce(semaphore);
    release();
    release();
    await settle();

    // Without releaseOnce the second call is handed straight to the second
    // waiter and the ceiling is silently one wider. The `Math.min` clamp
    // cannot see it, because with a queue the count never goes above permits.
    expect(admitted).toBe(1);
    expect(semaphore.stats().waiting).toBe(1);

    // Serve the loser so its timer is cleared and its promise settles inside
    // the test that created it.
    semaphore.release();
    await Promise.all(waiters);
    expect(admitted).toBe(2);
    expect(semaphore.stats().waiting).toBe(0);
  });

  it('leaves no timer running once every waiter has settled', async () => {
    // The general form of the defect above, asserted directly: a semaphore
    // nobody is waiting on must have nothing pending. Cheap, and it is the
    // property every other test in this file has to preserve.
    const semaphore = new Semaphore(1);
    semaphore.tryAcquire();

    const waiter = semaphore.acquire(1_000, timeoutError);
    await settle();
    expect(semaphore.stats().waiting).toBe(1);

    semaphore.release();
    await waiter;

    expect(semaphore.stats()).toEqual({ available: 0, waiting: 0 });
  });
});
