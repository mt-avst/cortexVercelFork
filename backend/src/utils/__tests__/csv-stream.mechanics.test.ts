import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  streamCsvExport,
  CSV_EXPORT_DEADLINE_MS,
  CSV_EXPORT_DRAIN_TIMEOUT_MS,
  CSV_EXPORT_BATCH_ROWS,
  type CsvExportTimeoutReason,
} from '../csv-stream';
import { logger } from '../logger';

/**
 * THE ADMIN WRITER'S OWN MECHANICS, pinned BEFORE the #80 extraction.
 *
 * cto/AdaptaLabs#80 folds this file's write/drain machinery together with
 * `writeSurveyCsv`'s. The survey copy already had its constants pinned as
 * literals and its mechanics asserted on the socket; this copy had neither -
 * its behavioural coverage lives in csv-exports-are-streamed.test.ts, which
 * drives the two routes and never stalls a socket. So before the refactor
 * exists, this file pins what the refactor must not change:
 *
 *  - the two budget constants, as literals (a test that derives its
 *    expectation from the constant cannot see the constant move - the #80
 *    issue names this rule);
 *  - a write that returns false and never drains DESTROYS within the drain
 *    budget rather than resolving into a short CSV that parses;
 *  - a client hangup mid-export stops the walk without destroying what the
 *    client already closed, and without `end()`;
 *  - a batch read that throws after the header destroys, never ends;
 *  - every listener and the timer are gone on every path - the leak that
 *    prompted the survey copy's correction was invisible to every
 *    behavioural assertion, so the assertion here is on listener COUNTS.
 */

type FakeRes = Response &
  EventEmitter & {
    chunks: string[];
    endCalls: number;
    destroyCalls: number;
  };

/** A response whose write behaviour is scripted per test. */
function fakeResponse(writeImpl: (res: FakeRes, chunk: string) => boolean) {
  const emitter = new EventEmitter();
  const res = emitter as unknown as FakeRes;

  Object.assign(res, {
    chunks: [] as string[],
    endCalls: 0,
    destroyCalls: 0,
    destroyed: false,
    writableEnded: false,
    setHeader: () => res,
    write: (chunk: string) => {
      res.chunks.push(chunk);
      return writeImpl(res, chunk);
    },
    end: () => {
      res.endCalls += 1;
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    destroy: () => {
      res.destroyCalls += 1;
      (res as { destroyed: boolean }).destroyed = true;
    },
  });

  return res;
}

const oneShortBatch =
  (rows: string[]) =>
  async (): Promise<{ rows: string[]; nextCursor: undefined }> => ({
    rows,
    nextCursor: undefined,
  });

describe('the admin export budgets are the numbers that were decided', () => {
  // LITERALS on both sides, deliberately - see the docblock above.
  it('holds the whole-export deadline at five minutes', () => {
    expect(CSV_EXPORT_DEADLINE_MS).toBe(300_000);
  });

  it('holds the single-write drain budget at thirty seconds', () => {
    expect(CSV_EXPORT_DRAIN_TIMEOUT_MS).toBe(30_000);
  });

  it('keeps the drain budget under the deadline, which is what makes them two bounds', () => {
    expect(CSV_EXPORT_DRAIN_TIMEOUT_MS).toBeLessThan(CSV_EXPORT_DEADLINE_MS);
  });

  it('keeps the timeout reason union at exactly the two bounds', () => {
    // A COMPILE-TIME pin: Record<union, true> against an exact literal fails
    // to build if the union gains a member (missing property) or loses one
    // (excess property). Both error classes render their message with a
    // binary ternary on this union, so a third member would silently make
    // both describe it as a drain failure. `npm run typecheck` is the runner
    // that sees this; the runtime assertion just keeps the value used.
    const everyReason: Record<CsvExportTimeoutReason, true> = {
      export_deadline: true,
      drain_timeout: true,
    };
    expect(Object.keys(everyReason)).toHaveLength(2);
  });
});

describe('the admin CSV write loop, asserted on the socket', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('destroys within the drain budget when the socket never drains', async () => {
    // False every time and no drain ever follows: the client that stopped
    // reading. Before the drain bound existed this promise had no reason to
    // settle, ever, while holding whatever the route was built to protect.
    const res = fakeResponse(() => false);

    const done = streamCsvExport({
      res,
      filename: 'x.csv',
      headerRow: 'a,b',
      context: { route: 'test' },
      readBatch: oneShortBatch(['1,2']),
    });

    await jest.advanceTimersByTimeAsync(CSV_EXPORT_DRAIN_TIMEOUT_MS - 1);
    expect(res.destroyCalls).toBe(0);

    await jest.advanceTimersByTimeAsync(1);
    // BOUNDED, so the assertion is what fails. Under the resolve-on-timeout
    // mutation the loop arms a fresh drain timer instead of destroying, and a
    // bare `await done` hangs to the jest timeout - a kill that reads as a
    // hang and costs a canary shard 15 seconds. The race keeps the mutant's
    // failure a named assertion.
    await Promise.race([
      done,
      jest.advanceTimersByTimeAsync(CSV_EXPORT_DRAIN_TIMEOUT_MS * 2),
    ]);

    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
    // The reason names the bound that fired, so an operator can tell a
    // stalled client from a slow export without correlating timestamps.
    expect(logger.error).toHaveBeenCalledWith(
      'CSV export failed part-way through',
      expect.objectContaining({ reason: 'drain_timeout' })
    );
  });

  it('stops without destroying or ending when the client hangs up mid-write', async () => {
    // A hangup produces neither drain nor error. `close` is the only signal,
    // and the loop treats it as "the caller left", not as a failure - there
    // is nobody left to protect from a short CSV.
    const res = fakeResponse(() => false);

    const done = streamCsvExport({
      res,
      filename: 'x.csv',
      headerRow: 'a,b',
      context: { route: 'test' },
      readBatch: oneShortBatch(['1,2']),
    });

    await jest.advanceTimersByTimeAsync(5);
    (res as { destroyed: boolean }).destroyed = true;
    res.emit('close');
    await done;

    expect(res.destroyCalls).toBe(0);
    expect(res.endCalls).toBe(0);
  });

  it('destroys immediately when the connection errors mid-write, logging no timeout reason', async () => {
    // The one line of the shared mechanism nothing previously asserted: the
    // `error` listener's rejection. Resolving there instead survived both
    // full suites, because on a real socket error Node destroys the stream
    // and the loop's own check returns early - only the timing and the log
    // can see the difference. So both are what this arm pins: destruction
    // before any timer fires, and a log whose reason is NOT a timeout.
    const res = fakeResponse(() => false);

    const done = streamCsvExport({
      res,
      filename: 'x.csv',
      headerRow: 'a,b',
      context: { route: 'test' },
      readBatch: oneShortBatch(['1,2']),
    });

    await jest.advanceTimersByTimeAsync(5);
    res.emit('error', new Error('ECONNRESET'));
    await Promise.race([done, jest.advanceTimersByTimeAsync(1)]);

    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'CSV export failed part-way through',
      expect.objectContaining({ reason: undefined })
    );
  });

  it('destroys rather than ending when a batch read throws after the header', async () => {
    const res = fakeResponse(() => true);

    let call = 0;
    const readBatch = async (): Promise<{ rows: string[]; nextCursor: number | undefined }> => {
      call += 1;
      if (call === 1) return { rows: ['1,2'], nextCursor: 1 };
      throw new Error('the pool refused');
    };

    await streamCsvExport({
      res,
      filename: 'x.csv',
      headerRow: 'a,b',
      context: { route: 'test' },
      readBatch,
    });

    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
    // The header DID go out before the failure - that is what makes destroy
    // the only honest option left.
    expect(res.chunks[0].startsWith('a,b')).toBe(true);
  });

  it('enforces the deadline between batches even when no write ever stalls', async () => {
    const res = fakeResponse(() => true);

    let call = 0;
    const readBatch = async (): Promise<{ rows: string[]; nextCursor: number | undefined }> => {
      call += 1;
      // The second read lands past the deadline: a steadily progressing
      // export that never hits backpressure must still be bounded in time.
      jest.advanceTimersByTime(CSV_EXPORT_DEADLINE_MS + 1);
      return { rows: ['1,2'], nextCursor: call };
    };

    await streamCsvExport({
      res,
      filename: 'x.csv',
      headerRow: 'a,b',
      context: { route: 'test' },
      readBatch,
    });

    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'CSV export failed part-way through',
      expect.objectContaining({ reason: 'export_deadline' })
    );
  });

  it('lets the deadline win a late stall instead of granting the full drain budget', async () => {
    // The security gate on the #80 fold proved this exact seam unguarded on
    // the admin side: replacing this caller's remainingBudgetMs closure with
    // a never-expiring one survived 1501 jest and 715 vitest tests, because
    // only the survey suite exercised the Math.min clamp. This arm is the
    // admin mirror - a required parameter stops a caller passing NOTHING; it
    // cannot stop them passing something ELSE, so the something-else must
    // fail a test by name.
    const res = fakeResponse(() => false);

    let reads = 0;
    const readBatch = async (): Promise<{ rows: string[]; nextCursor: number | undefined }> => {
      reads += 1;
      return { rows: ['1,2'], nextCursor: reads };
    };

    const done = streamCsvExport({
      res,
      filename: 'x.csv',
      headerRow: 'a,b',
      context: { route: 'test' },
      readBatch,
    });

    // Walk the clock to ten seconds short of the deadline in under-drain-budget
    // steps, draining each stalled write by hand just before its bound fires.
    for (let i = 0; i < 10; i += 1) {
      await jest.advanceTimersByTimeAsync(29_000);
      res.emit('drain');
    }

    // 290s elapsed: the stalled write ahead has 10s of deadline left against
    // a 30s drain budget. The nearer bound must win.
    await jest.advanceTimersByTimeAsync(9_999);
    expect(res.destroyCalls).toBe(0);

    await Promise.race([done, jest.advanceTimersByTimeAsync(2)]);

    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'CSV export failed part-way through',
      expect.objectContaining({ reason: 'export_deadline' })
    );
  });

  it('leaves no listener and no timer behind on the happy path', async () => {
    // Every write takes the slow path (false, then a drain on the next tick),
    // so every write attaches the three listeners - the only path where a
    // leak can happen. The leak that prompted the survey copy's fix was one
    // dead listener per slow write, invisible to every content assertion.
    const res = fakeResponse((r) => {
      setImmediate(() => r.emit('drain'));
      return false;
    });

    let call = 0;
    const readBatch = async (): Promise<{ rows: string[]; nextCursor: number | undefined }> => {
      call += 1;
      return { rows: ['1,2'], nextCursor: call < 4 ? call : undefined };
    };

    const done = streamCsvExport({
      res,
      filename: 'x.csv',
      headerRow: 'a,b',
      context: { route: 'test' },
      readBatch,
    });

    await jest.advanceTimersByTimeAsync(1000);
    await done;

    expect(res.endCalls).toBe(1);
    expect(res.listenerCount('drain')).toBe(0);
    expect(res.listenerCount('error')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves no listener behind on the timeout path either', async () => {
    const res = fakeResponse(() => false);

    const done = streamCsvExport({
      res,
      filename: 'x.csv',
      headerRow: 'a,b',
      context: { route: 'test' },
      readBatch: oneShortBatch(['1,2']),
    });

    await jest.advanceTimersByTimeAsync(CSV_EXPORT_DRAIN_TIMEOUT_MS + 1);
    await done;

    expect(res.destroyCalls).toBe(1);
    expect(res.listenerCount('drain')).toBe(0);
    expect(res.listenerCount('error')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('still batches by the number the routes were measured with', () => {
    // Already pinned in csv-exports-are-streamed.test.ts; repeated here so
    // this file alone states the writer's full numeric contract.
    expect(CSV_EXPORT_BATCH_ROWS).toBe(500);
  });
});
