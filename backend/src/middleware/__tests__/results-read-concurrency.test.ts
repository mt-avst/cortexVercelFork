import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter, once } from 'node:events';
import { createServer, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Request, Response } from 'express';

import { AppError, type SessionUser } from '../../../../shared/types';
import { ADMIN_CONCURRENCY_LIMIT } from '../../firsthand/runtime-pool-admission';
import {
  MAX_CONCURRENT_RESULTS_READS,
  MAX_IN_FLIGHT_RESULTS_READS_PER_USER,
  RESULTS_READ_QUEUE_TIMEOUT_MS,
  boundResultsRead,
  releaseResultsReadPermit,
  resetResultsReadGateForTests,
  resultsReadCallersInFlight,
  resultsReadGateStats,
  resultsReadsInFlightFor
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

type Held = {
  close: () => void;
  releaseEarly: () => void;
  admitted: () => boolean;
  error: () => unknown;
};

/**
 * Starts one gated request, as a NAMED CALLER, and leaves its response open.
 *
 * The caller id is required rather than defaulted, and that is not ceremony.
 * `boundResultsRead` now charges a per-caller slot as well as a permit, so a
 * test that omitted the id would silently make every request in it the same
 * admin - and the tests below about queueing would then be measuring the
 * per-caller refusal instead of the queue. Every one of them describes several
 * DIFFERENT admins contending, which is the situation the gate exists for, so
 * every one of them has to say so.
 */
const adminNamed = (id: string): SessionUser => ({
  id,
  name: id,
  email: `${id}@example.test`,
  // `researcher_admin` rather than `superadmin` on purpose: the whole point of
  // #9 is that `requireAdmin` is a ROLE gate and the lowest admin role can
  // occupy these permits while being refused the data.
  role: 'researcher_admin'
});

function start(userId: string): Held {
  const res = new EventEmitter() as unknown as Response;
  let admitted = false;
  let error: unknown;

  boundResultsRead({ user: adminNamed(userId) } as Request, res, ((
    failure?: unknown
  ) => {
    if (failure) {
      error = failure;
    } else {
      admitted = true;
    }
  }) as never);

  return {
    close: () => (res as unknown as EventEmitter).emit('close'),
    releaseEarly: () => releaseResultsReadPermit(res),
    admitted: () => admitted,
    error: () => error
  };
}

/** N distinct admins, one request each. */
const startDistinct = (count: number, prefix = 'admin'): Held[] =>
  Array.from({ length: count }, (_unused, index) =>
    start(`${prefix}-${index}`)
  );

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
   * ceiling at all. ONE is a memory budget: a single worst-case result set is
   * already a few hundred megabytes on a single-replica 2Gi pod. Raising it is
   * a decision about how close to an OOM kill this pod is allowed to run, and
   * an OOM kill here drops every live participant session.
   *
   * This docblock said "Two is a memory budget" until it was corrected - it
   * had been written when the ceiling was two, and survived the change to one
   * because nothing reads a comment. That is the failure mode the canary entry
   * beside this test exists for.
   *
   * ONE CONSTANT PER TEST, and that is not tidiness. Both numbers were pinned
   * on this single assertion, so a red run said only that one of them had
   * moved - and a test must be able to fail BY NAME or the reader starts their
   * diagnosis in the wrong place. Split after a review gate pointed out the
   * canary had two entries answering to one test title.
   */
  it('holds the ceiling at the number that was decided', () => {
    expect(MAX_CONCURRENT_RESULTS_READS).toBe(1);
  });

  /**
   * PINNED SEPARATELY, for the reason above.
   *
   * Every wait in this file is sized from the constant, so a widened queue
   * timeout - one long enough that a refused caller waits past every ingress
   * bound - passes all of them.
   */
  it('holds the queue timeout at the number that was decided', () => {
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
    const held = startDistinct(MAX_CONCURRENT_RESULTS_READS, 'holder');
    await settle();

    expect(held.every((request_) => request_.admitted())).toBe(true);
    expect(resultsReadGateStats()).toEqual({ available: 0, waiting: 0 });

    const queued = start('another-admin');
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
    const held = start('one-admin');
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
    const held = startDistinct(MAX_CONCURRENT_RESULTS_READS, 'holder');
    await settle();

    const queued = [start('waiter-a'), start('waiter-b')];
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
    const held = startDistinct(MAX_CONCURRENT_RESULTS_READS, 'holder');
    await settle();
    expect(resultsReadGateStats().available).toBe(0);

    const queued = start('racing-admin');
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

    startDistinct(MAX_CONCURRENT_RESULTS_READS, 'holder');
    await settle();

    const refused = start('refused-admin');
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
    // Stands in for `requireAdmin`, which establishes the caller and nothing
    // else. Each `fire()` below is a DIFFERENT admin, because every test here
    // is about the shared gate rather than the per-caller limit - without
    // distinct ids they would all be one admin and would measure a 429.
    app.use((req: Request, _res: Response, next: () => void) => {
      req.user = adminNamed(req.headers['x-admin'] as string);
      next();
    });
    app.get('/slow', boundResultsRead, (_req: Request, _res: Response) => {
      // Never answers. The caller gives up instead.
    });

    const server = createServer(app).listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const requests: ReturnType<typeof httpGet>[] = [];
    let fired = 0;
    return {
      fire: () => {
        fired += 1;
        const pending = httpGet(`http://127.0.0.1:${port}/slow`, {
          headers: { 'x-admin': `admin-${fired}` }
        });
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

/**
 * The per-caller half, added for cto/AdaptaLabs#9.
 *
 * The gate above is fair between REQUESTS and says nothing about who sent
 * them, which #9 measured: one authenticated `researcher_admin`, inside the
 * !201 rate limits, refusing another admin's results-route requests for as long
 * as they cared to. These tests are about the counter that bounds a caller, and
 * every one has a control beside it - a limit that refused everybody would pass
 * a starvation test perfectly.
 */
describe('bounding one caller', () => {
  beforeEach(() => {
    resetResultsReadGateForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * PINNED AS A LITERAL, because the number is the policy and nothing else
   * here can see it change.
   *
   * Every other test in this block derives its expectation from the constant,
   * so all of them keep passing at a limit of fifty - which is no limit at all
   * on a surface `studyResultsLimiter` allows ten requests a minute.
   *
   * TWO, and it was measured rather than picked. One is the tighter bound and
   * costs the ordinary workflow - download a CSV, reload your own results view,
   * get a 429 until the download drains. Two removes that and, measured
   * interleaved over three rounds, costs nothing on the property #9 is about:
   * attacker-caused 503s are zero at both one and two. See the constant's own
   * docblock for the table.
   */
  it('holds the per-caller limit at the number that was decided', () => {
    expect(MAX_IN_FLIGHT_RESULTS_READS_PER_USER).toBe(2);
  });

  /**
   * PINNED FROM BELOW, which the assertion above cannot do.
   *
   * `toBe(2)` fails if the constant moves, but nothing proves the code HONOURS
   * two rather than merely declaring it - a limit that refused the second read
   * while the constant said two would pass every other test in this block, and
   * would be exactly the 429 the second measurement was run to remove.
   */
  it('lets one caller hold a second read at the same time', async () => {
    const first = start('busy-admin');
    await settle();
    expect(first.admitted()).toBe(true);

    const second = start('busy-admin');
    await settle();

    expect(second.error()).toBeUndefined();
    expect(resultsReadsInFlightFor('busy-admin')).toBe(2);

    // Queued rather than refused - the GLOBAL gate is one, so the second read
    // waits its turn. That is contention, not a per-caller refusal, and the
    // difference is the whole point of this test.
    expect(resultsReadGateStats().waiting).toBe(1);

    first.close();
    await settle();
    expect(second.admitted()).toBe(true);
  });

  it('refuses one caller a third read while two are in flight', async () => {
    const held = [start('busy-admin'), start('busy-admin')];
    await settle();
    expect(resultsReadsInFlightFor('busy-admin')).toBe(2);

    const third = start('busy-admin');
    await settle();

    expect(third.admitted()).toBe(false);
    const error = third.error();
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(429);
    expect((error as AppError).code).toBe('RESULTS_READ_USER_BUSY');
    // Told apart from the gate's own refusal, because a caller reading one
    // status has to know whether waiting will help. It will not, here.
    expect((error as AppError).code).not.toBe('RESULTS_READ_QUEUE_FULL');

    // REFUSED, NOT QUEUED. Queueing the third request would BE the starvation
    // this limit exists to remove - it would sit in the FIFO queue ahead of the
    // next admin to arrive. Only the two admitted reads are accounted for.
    expect(resultsReadGateStats().waiting).toBe(1);
    expect(resultsReadsInFlightFor('busy-admin')).toBe(2);

    held.forEach((request_) => request_.close());
  });

  /**
   * THE CONTROL for the test above, and it is the one that matters.
   *
   * "A second request is refused" passes just as well when the limit is a
   * permanent lockout - which is the exact shape of defect this file's permit
   * accounting has shipped with before.
   */
  it('lets the same caller read again once their first read has ended', async () => {
    const first = start('serial-admin');
    await settle();
    first.close();
    await settle();

    const second = start('serial-admin');
    await settle();

    expect(second.admitted()).toBe(true);
    expect(resultsReadsInFlightFor('serial-admin')).toBe(1);
  });

  /**
   * THE OTHER CONTROL: the limit is per CALLER, not a second global gate.
   *
   * A limit that turned away every caller once any one of them was reading
   * would pass every assertion above, and would be a worse outage than the one
   * #9 reports.
   */
  it('lets a different caller in while one caller is at their limit', async () => {
    // At their limit means MAX_IN_FLIGHT_RESULTS_READS_PER_USER in flight, so
    // this is derived rather than written as two - the point of this test is
    // the per-caller/global distinction, and the literal is pinned above.
    const atTheirLimit = Array.from(
      { length: MAX_IN_FLIGHT_RESULTS_READS_PER_USER },
      () => start('admin-a')
    );
    await settle();
    const refused = start('admin-a');
    await settle();
    expect(refused.admitted()).toBe(false);

    const other = start('admin-b');
    await settle();

    // Queued rather than refused: the shared gate is full, which is the
    // ordinary contention the semaphore is for. What matters is that it is IN
    // the queue and not turned away by the per-caller counter. It sits behind
    // admin-a's own queued reads, hence the arithmetic rather than a 1.
    expect(other.error()).toBeUndefined();
    expect(resultsReadGateStats().waiting).toBe(
      MAX_IN_FLIGHT_RESULTS_READS_PER_USER
    );

    atTheirLimit.forEach((request_) => request_.close());
    await settle();
    expect(other.admitted()).toBe(true);
  });

  /**
   * THE 503 PATH, which is the expensive one to get wrong.
   *
   * The refusal arm removes the `close` listener before answering, so a slot
   * not given back there is never given back at all - and one queue timeout
   * would lock that admin out of all four results routes for the life of the
   * process.
   */
  it('gives the caller their slot back when the queue refuses them', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });

    startDistinct(MAX_CONCURRENT_RESULTS_READS, 'holder');
    await settle();

    const refused = start('timed-out-admin');
    await jest.advanceTimersByTimeAsync(RESULTS_READ_QUEUE_TIMEOUT_MS);
    await settle();

    expect((refused.error() as AppError).code).toBe('RESULTS_READ_QUEUE_FULL');
    expect(resultsReadsInFlightFor('timed-out-admin')).toBe(0);
  });

  it('gives the caller their slot back when they hang up while queued', async () => {
    startDistinct(MAX_CONCURRENT_RESULTS_READS, 'holder');
    await settle();

    const queued = start('departing-admin');
    await settle();
    expect(resultsReadGateStats().waiting).toBe(1);

    queued.close();
    await settle();

    expect(resultsReadsInFlightFor('departing-admin')).toBe(0);
    expect(resultsReadGateStats().waiting).toBe(0);
  });

  /**
   * THE LEAK DETECTOR, and it needs its own control.
   *
   * A Map keyed by admin id that is never pruned is a slow leak on a process
   * that runs for weeks, and it is invisible: the limit keeps working, the
   * counts keep reading correctly, and only the heap grows. Asserting the map
   * is EMPTY is an absence-assertion, so the first half proves it can be
   * non-empty.
   */
  it('charges nobody once every request has ended', async () => {
    const running = startDistinct(3, 'transient');
    await settle();

    // The control. An empty map at the end says nothing unless it was full.
    expect(resultsReadCallersInFlight()).toBe(3);

    running.forEach((request_) => request_.close());
    await settle();

    expect(resultsReadCallersInFlight()).toBe(0);
  });
});

/**
 * Handing the permit back before the response drains - cto/AdaptaLabs#9.
 *
 * The permit is released on `close`, and `close` waits for the CLIENT. So the
 * length of the hold is the client's to choose, and #9 measured what that is
 * worth to an attacker: a CSV requested and never read held the only permit for
 * the whole drain timeout, ten times a minute, indefinitely. No deadline closes
 * that - occupancy stays under 100% only while requests-per-minute times
 * maximum-hold is under 60 seconds, and at ten a minute that needs a hold under
 * six seconds.
 *
 * So the two CSV routes hand the permit back at the preflight-to-stream
 * boundary. These tests are about that handover, and about the two things it
 * must NOT do.
 */
describe('releasing the permit before the response closes', () => {
  beforeEach(() => {
    resetResultsReadGateForTests();
  });

  /**
   * THE ONE THAT FAILS IF THE FIX IS REMOVED.
   *
   * Make `releaseResultsReadPermit` a no-op and this fails by name: the queued
   * admin is still waiting, which is the measured outage.
   */
  it('admits the next caller while the first is still streaming', async () => {
    const streaming = start('exporting-admin');
    await settle();
    expect(streaming.admitted()).toBe(true);

    const queued = start('waiting-admin');
    await settle();
    expect(queued.admitted()).toBe(false);

    // The boundary. The response is still open - nothing has closed, and
    // nobody has drained the stream.
    streaming.releaseEarly();
    await settle();

    expect(queued.admitted()).toBe(true);
  });

  /**
   * THE CONTROL, and it is what stops this being a permit leak dressed up as a
   * fix. The per-caller slot is NOT handed back at the boundary: it is what
   * bounds how many streams hold an id list at once now that the gate does not.
   */
  it('keeps the caller charged for their still-streaming read', async () => {
    const streaming = start('exporting-admin');
    await settle();

    streaming.releaseEarly();
    await settle();

    // STILL ONE, not zero. This is the assertion the whole test exists for: if
    // the early release handed back the slot as well as the permit, nothing
    // would bound how many CSV streams hold an id list at once.
    expect(resultsReadsInFlightFor('exporting-admin')).toBe(1);

    // And the limit still bites for the same admin, one read later than it
    // used to - which is the point of raising it to two. The download draining
    // no longer refuses their next read; a THIRD concurrent one does.
    const alsoAllowed = start('exporting-admin');
    await settle();
    expect(alsoAllowed.error()).toBeUndefined();

    const refused = start('exporting-admin');
    await settle();
    expect((refused.error() as AppError).code).toBe('RESULTS_READ_USER_BUSY');

    // Still BOUNDED: the slots come back when the responses finally close.
    streaming.close();
    alsoAllowed.close();
    await settle();
    expect(resultsReadsInFlightFor('exporting-admin')).toBe(0);
  });

  /**
   * RELEASED TWICE AND THEN CLOSED, which is what actually happens: the route
   * releases at the boundary and the `close` listener fires later.
   *
   * A second release handed to a waiter would widen the ceiling silently for as
   * long as that request ran, and `Semaphore`'s own clamp hides it whenever
   * nobody is queued.
   */
  it('cannot invent a permit by releasing more than once', async () => {
    const streaming = start('exporting-admin');
    await settle();

    streaming.releaseEarly();
    streaming.releaseEarly();
    streaming.close();
    await settle();

    expect(resultsReadGateStats()).toEqual({
      available: MAX_CONCURRENT_RESULTS_READS,
      waiting: 0
    });
  });

  it('does nothing for a response that never held a permit', async () => {
    startDistinct(MAX_CONCURRENT_RESULTS_READS, 'holder');
    await settle();

    const queued = start('queued-admin');
    await settle();
    expect(queued.admitted()).toBe(false);

    // A handler that never ran cannot have reached the boundary, but a future
    // caller might reach for this from an error path. It must not hand back a
    // permit this request does not hold.
    queued.releaseEarly();
    await settle();

    expect(resultsReadGateStats()).toEqual({ available: 0, waiting: 1 });
  });
});
