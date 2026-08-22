import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter, once } from 'node:events';
import { createServer, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Request, Response } from 'express';

import { AppError } from '../../../../shared/types';
import { ADMIN_CONCURRENCY_LIMIT } from '../../firsthand/runtime-pool-admission';
import {
  MAX_CONCURRENT_RESULTS_READS,
  RESULTS_READ_QUEUE_TIMEOUT_MS,
  boundResultsRead,
  resetResultsReadGateForTests,
  resultsReadGateStats
} from '../results-read-concurrency';

/**
 * The permit is held for the WHOLE REQUEST, and that is the only reason this
 * middleware exists.
 *
 * A gate released at the end of the database checkout would bound nothing that
 * matters: the two hundred thousand rows are in the heap AFTER the connection
 * has gone back, and they stay there through the aggregation and the
 * serialisation. So every test here holds its response open and asserts on
 * what is admitted meanwhile.
 *
 * Driven against a stub response rather than a server for everything except
 * the abort case. The response is an EventEmitter and `close` is the whole
 * contract, so a stub says exactly as much - and a real socket held open under
 * fake timers is how this file first hung.
 */

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type Held = { close: () => void; admitted: () => boolean; error: () => unknown };

/** Starts one gated request and leaves its response open. */
function start(): Held {
  const res = new EventEmitter() as unknown as Response;
  let admitted = false;
  let error: unknown;

  boundResultsRead({} as Request, res, ((failure?: unknown) => {
    if (failure) {
      error = failure;
    } else {
      admitted = true;
    }
  }) as never);

  return {
    close: () => (res as unknown as EventEmitter).emit('close'),
    admitted: () => admitted,
    error: () => error
  };
}

describe('bounding concurrent results reads', () => {
  beforeEach(() => {
    resetResultsReadGateForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * PINNED, because the number IS the policy.
   *
   * Every other test here derives its expectations from the constant, so they
   * all keep passing at any ceiling - including one high enough to be no
   * ceiling at all. Two is a memory budget: two worst-case result sets is a
   * few hundred megabytes on a single-replica 2Gi pod. Raising it is a
   * decision about how close to an OOM kill this pod is allowed to run, and
   * an OOM kill here drops every live participant session.
   */
  it('holds the ceiling at the number that was decided', () => {
    expect(MAX_CONCURRENT_RESULTS_READS).toBe(1);
    expect(RESULTS_READ_QUEUE_TIMEOUT_MS).toBe(10_000);
  });

  it('stays strictly below the admin budget it also consumes', () => {
    // THE RELATION, not just the number. A results read is admin-class, so it
    // holds one of ADMIN_CONCURRENCY_LIMIT permits for a query allowed 120
    // seconds. At two and two, two exports owned the entire admin budget for
    // two minutes and every other admin request 503'd - the lowest admin role
    // able to lock out the superadmin. Neither constant's docblock used to
    // mention the other, so their equality read as coincidence.
    expect(MAX_CONCURRENT_RESULTS_READS).toBeLessThan(ADMIN_CONCURRENCY_LIMIT);
  });

  it('lets MAX_CONCURRENT_RESULTS_READS through and queues the next one', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_RESULTS_READS }, start);
    await settle();

    expect(held.every((request_) => request_.admitted())).toBe(true);
    expect(resultsReadGateStats()).toEqual({ available: 0, waiting: 0 });

    const queued = start();
    await settle();

    expect(queued.admitted()).toBe(false);
    expect(resultsReadGateStats().waiting).toBe(1);

    held[0].close();
    await settle();

    expect(queued.admitted()).toBe(true);
  });

  it('gives the permit back when the response closes, however it ended', async () => {
    // One event covers completion, failure and a caller hanging up. `finish`
    // alone would miss the last, and an abandoned slow export is exactly the
    // case worth bounding - its permit would never come back.
    const held = start();
    await settle();
    expect(resultsReadGateStats().available).toBe(
      MAX_CONCURRENT_RESULTS_READS - 1
    );

    held.close();
    expect(resultsReadGateStats()).toEqual({
      available: MAX_CONCURRENT_RESULTS_READS,
      waiting: 0
    });
  });

  it('does not hand one closed response two permits', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_RESULTS_READS }, start);
    await settle();

    const queued = [start(), start()];
    await settle();
    expect(resultsReadGateStats().waiting).toBe(2);

    // Node emits `close` once, but a permit released twice would be handed
    // straight to a second waiter and the ceiling would be silently wider for
    // as long as that request ran.
    held[0].close();
    held[0].close();
    await settle();

    expect(queued.filter((request_) => request_.admitted())).toHaveLength(1);
    expect(resultsReadGateStats().waiting).toBe(1);
  });

  /**
   * THE RACE BETWEEN THE GRANT AND THE CLOSE, which is a window of one
   * microtask and a real permit leak.
   *
   * `onClose` does `release?.()`, and `release` is only assigned once the
   * `.then` after `acquire` runs. If the caller disconnects in the gap between
   * the semaphore resolving and that microtask executing, `onClose` sees
   * `undefined`, does nothing, and the `.then` then hands a permit to a
   * response nobody is reading - with no listener left to give it back.
   *
   * The abort signal does not cover this one: by then the waiter has already
   * been shifted off the queue and its promise resolved, so aborting is a
   * no-op. Only the guard covers it, and a mutation deleting the guard survived
   * every other test in this file.
   *
   * Provoked deterministically rather than raced: `release()` resolves the
   * waiter synchronously, and emitting `close` immediately afterwards lands
   * inside the window, because the `.then` body is queued as a microtask.
   */
  it('gives the permit back when the close lands between the grant and the handler', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_RESULTS_READS }, start);
    await settle();
    expect(resultsReadGateStats().available).toBe(0);

    const queued = start();
    await settle();
    expect(resultsReadGateStats().waiting).toBe(1);

    // Resolve the waiter and close in the SAME synchronous block, before the
    // continuation that assigns `release` has had a chance to run.
    held[0].close();
    queued.close();
    await settle();
    await settle();

    expect(queued.admitted()).toBe(false);
    expect(resultsReadGateStats()).toEqual({
      available: MAX_CONCURRENT_RESULTS_READS,
      waiting: 0
    });
  });

  it('refuses with a 503 rather than queueing forever', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });

    Array.from({ length: MAX_CONCURRENT_RESULTS_READS }, start);
    await settle();

    const refused = start();
    await jest.advanceTimersByTimeAsync(RESULTS_READ_QUEUE_TIMEOUT_MS);
    await settle();

    const error = refused.error();
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(503);
    expect((error as AppError).code).toBe('RESULTS_READ_QUEUE_FULL');
    // Told apart from the runtime pool's own 503 by its code, because a
    // results read passes through both ceilings and an operator reading one
    // line has to know which refused.
    expect((error as AppError).code).not.toBe('RUNTIME_POOL_ADMISSION_TIMEOUT');
    expect(refused.admitted()).toBe(false);

    // The abandoned waiter left the queue, so the permit is still real.
    expect(resultsReadGateStats()).toEqual({ available: 0, waiting: 0 });
  });
});

/**
 * The real-socket half, which a stub response cannot answer.
 *
 * Two assumptions everything above rests on: that Node emits `close` on a
 * response whose caller hung up, and that a permit survives the difference
 * between hanging up BEFORE and AFTER being admitted. The second is where the
 * shipped version was wrong.
 *
 * A raw http request against a server this file owns, rather than supertest:
 * the handler under test never answers, and supertest has nowhere to close a
 * server whose request was abandoned, which leaves the runner hanging after the
 * assertion has already passed.
 */
describe('a caller who hangs up', () => {
  beforeEach(() => {
    resetResultsReadGateForTests();
  });

  /**
   * Polls the gate rather than sleeping at it.
   *
   * The first version of this file waited a flat 30ms. It passed 5/5 in
   * isolation and failed in the full jest run, where the event loop is shared
   * with 30 other suites - and I read that red run as the repository's known
   * connection flake rather than as my own test. A fixed sleep asserts that the
   * machine is fast enough, which is not the property under test.
   */
  const until = async (predicate: () => boolean, what: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for: ${what}`);
  };

  const startServer = async () => {
    const app = express();
    app.get('/slow', boundResultsRead, (_req: Request, _res: Response) => {
      // Never answers. The caller gives up instead.
    });

    const server = createServer(app).listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const requests: ReturnType<typeof httpGet>[] = [];
    return {
      fire: () => {
        const pending = httpGet(`http://127.0.0.1:${port}/slow`);
        pending.on('error', () => {});
        requests.push(pending);
        return pending;
      },
      close: async () => {
        requests.forEach((pending) => pending.destroy());
        server.closeAllConnections?.();
        server.close();
        await once(server, 'close');
      }
    };
  };

  it('gives its permit back after being admitted', async () => {
    const { fire, close } = await startServer();

    try {
      const pending = fire();
      await until(
        () => resultsReadGateStats().available === MAX_CONCURRENT_RESULTS_READS - 1,
        'the request to be admitted'
      );

      pending.destroy();
      await until(
        () => resultsReadGateStats().available === MAX_CONCURRENT_RESULTS_READS,
        'the permit to come back'
      );
    } finally {
      await close();
    }
  });

  /**
   * THE ONE THAT SHIPPED BROKEN.
   *
   * Hanging up while still QUEUED. The `close` listener used to be registered
   * inside the `.then`, so it did not exist yet - `close` had already been
   * emitted and could never fire again, the waiter kept its place in the FIFO
   * queue, and the next `release()` handed it a permit that nobody would ever
   * give back. Two of these shut all four results routes for the life of the
   * pod.
   *
   * Asserted on the QUEUE as well as the count: guarding at the grant would fix
   * `available` and still leave a dead waiter ahead of a live caller.
   */
  it('leaves the queue when it hangs up while still waiting', async () => {
    const { fire, close } = await startServer();

    try {
      const admitted = Array.from({ length: MAX_CONCURRENT_RESULTS_READS }, fire);
      await until(
        () => resultsReadGateStats().available === 0,
        'the gate to fill'
      );

      const queued = fire();
      await until(() => resultsReadGateStats().waiting === 1, 'a queued request');

      queued.destroy();
      await until(
        () => resultsReadGateStats().waiting === 0,
        'the abandoned waiter to leave the queue'
      );

      admitted.forEach((pending) => pending.destroy());
      await until(
        () => resultsReadGateStats().available === MAX_CONCURRENT_RESULTS_READS,
        'every permit to come back'
      );
    } finally {
      await close();
    }
  });

  it('survives more abandoned waiters than it has permits', async () => {
    // The arithmetic of the shipped defect: each abandoned waiter cost one
    // permit, so MAX_CONCURRENT_RESULTS_READS of them closed the gate
    // permanently. Run more than that and assert the gate is still open.
    const { fire, close } = await startServer();

    try {
      for (let round = 0; round < MAX_CONCURRENT_RESULTS_READS + 1; round += 1) {
        const admitted = Array.from({ length: MAX_CONCURRENT_RESULTS_READS }, fire);
        await until(() => resultsReadGateStats().available === 0, 'the gate to fill');

        const queued = fire();
        await until(() => resultsReadGateStats().waiting === 1, 'a queued request');
        queued.destroy();

        // WAITED FOR, not raced. Without this the loop went straight on to
        // release the holders, the dead waiter was handed a permit before the
        // server had even processed its disconnect, and its listener was
        // registered in time after all - so this test PASSED against the very
        // defect it was written for. Found by re-running it against the
        // reverted code rather than by reading it.
        await until(
          () => resultsReadGateStats().waiting === 0,
          `the abandoned waiter to leave the queue in round ${round}`
        );

        admitted.forEach((pending) => pending.destroy());
        await until(
          () => resultsReadGateStats().available === MAX_CONCURRENT_RESULTS_READS,
          `every permit to come back after round ${round}`
        );
      }
    } finally {
      await close();
    }
  });
});
