import { NextFunction, Request, Response } from 'express';

import { AppError } from '../../../shared/types';
import {
  Semaphore,
  SemaphoreAbandonedError,
  releaseOnce
} from '../utils/semaphore';

/**
 * How many survey-results reads may be IN FLIGHT at once, across the process.
 *
 * The connection is not the expensive part of these four routes - the heap is,
 * and the heap is held after the connection has gone back. `listResponsesWhere`
 * materialises up to 200,001 rows before it decides whether to answer 413, then
 * the aggregator or the CSV writer builds a second structure from them and the
 * response body a third. That is a few hundred megabytes for one request, on a
 * SINGLE-REPLICA 2Gi pod. Enough of them at once is an OOM kill, and an OOM
 * kill here drops every live participant session, not just the caller's.
 *
 * So this bounds the one thing the rate limiters cannot. !201 put 10-a-minute
 * and 60-a-minute ceilings on these routes; a minute's worth of either can
 * still arrive in the same second, and `express-rate-limit` has no notion of a
 * request still running.
 *
 * The 413 does not help with any of this. It protects the CALLER from being
 * handed a truncated answer, and it is decided AFTER the rows are already in
 * the heap.
 *
 * ONE, and it was two until both review gates pointed out the same thing: a
 * results read is ADMIN-CLASS, so it also holds one of the two permits in
 * runtime-pool-admission.ts, for a query allowed 120 seconds. At two, two
 * exports owned the ENTIRE admin budget for up to two minutes, and every other
 * admin runtime request - open a study, save an edit, list studies - waited out
 * its admission budget and answered 503. The lowest admin role could lock out
 * the superadmin, where before this change they would merely have queued.
 *
 * So this must stay STRICTLY BELOW ADMIN_CONCURRENCY_LIMIT, and there is a test
 * pinning the relation rather than the number, because the coupling is the
 * point and neither constant's docblock used to mention the other. That the two
 * were equal read as a coincidence; the next person to raise this to three
 * would have created a permanent admin outage during exports.
 *
 * One also halves the memory ceiling this exists for. The cost is that two
 * researchers exporting at the same moment serialise, and the second waits up
 * to RESULTS_READ_QUEUE_TIMEOUT_MS. These are hand-driven superadmin surfaces
 * that !201 established nothing polls, so that is a cost worth paying to keep
 * the authoring surface responsive.
 */
export const MAX_CONCURRENT_RESULTS_READS = 1;

/**
 * How long a results read waits for its turn before being refused.
 *
 * Matched to the FirstHand runtime pool's own admission budget so the two
 * ceilings a results read passes through are the same size, and an operator
 * reading a 503 does not have to work out which one produced it - the codes
 * differ for that.
 */
export const RESULTS_READ_QUEUE_TIMEOUT_MS = 10_000;

let gate = new Semaphore(MAX_CONCURRENT_RESULTS_READS);

function tooManyResultsReads(): AppError {
  return new AppError(
    'Too many result sets are being read at once. Wait a few seconds and try again.',
    503,
    'RESULTS_READ_QUEUE_FULL'
  );
}

/**
 * Holds a permit for the WHOLE request, not just the database checkout.
 *
 * Released on the response's `close`, which Node emits both when a response
 * completes and when the connection is torn down early - so a caller who
 * cancels a slow export gives their permit back. `finish` alone would miss the
 * aborted case, which is precisely the case somebody hits when the export is
 * slow enough to be worth bounding.
 *
 * THE LISTENER IS REGISTERED BEFORE THE WAIT, and the first version of this
 * function got that wrong in a way that permanently disabled all four results
 * routes. Registered inside the `.then`, it only ever existed for requests that
 * had already been admitted: a caller who closed the tab while QUEUED had
 * already had `close` emitted, so the listener attached afterwards could never
 * fire, and the permit was gone for the life of the process. Two of those and a
 * gate of two is shut - 503 forever, on a single-replica pod, for every admin
 * including the superadmin. Reachable by a tab close, a reload, or an ingress
 * read timeout. The test that was supposed to cover it aborted a request that
 * had ALREADY BEEN ADMITTED, which is the case that always worked.
 *
 * One listener rather than two, doing the right thing from whichever state it
 * is called in. Swapping listeners at the moment of the grant leaves a window
 * between them, and the window is the bug.
 *
 * The abort also travels into `Semaphore.acquire`, which removes the waiter
 * from the queue. Handing the permit back at the grant would settle the
 * accounting, but the dead waiter would keep its place in a FIFO queue and a
 * live caller would wait behind somebody who had left.
 *
 * `.then(onGranted, onRefused)` rather than `.then(...).catch(next)`: with a
 * trailing catch, a throw inside the success arm reaches `next` as well, and
 * calling `next` twice on one request is its own defect.
 *
 * Mounted AFTER `requireAdmin` on every route that carries it. Mounted before,
 * an unauthenticated caller could fill the queue and refuse the superadmin who
 * is entitled to read. Note what that does NOT say: `requireAdmin` is a ROLE
 * gate, and the per-resource owner check runs inside the handler, so any
 * researcher_admin can occupy these permits while being refused the data.
 * Bounding that needs the ownership decision to move into middleware, which is
 * a larger change than this one.
 */
export function boundResultsRead(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  const abandoned = new AbortController();
  let release: (() => void) | undefined;
  let closed = false;

  const onClose = () => {
    closed = true;
    // Before the grant this cancels the wait; after it, this IS the release.
    abandoned.abort();
    release?.();
  };

  res.on('close', onClose);

  gate.acquire(RESULTS_READ_QUEUE_TIMEOUT_MS, tooManyResultsReads, abandoned.signal).then(
    () => {
      release = releaseOnce(gate);

      // The close raced the grant and won. Hand the permit straight back and
      // do not start a handler whose response nobody is reading.
      if (closed || res.destroyed || res.writableEnded) {
        release();
        return;
      }

      next();
    },
    (error) => {
      res.off('close', onClose);

      // Nobody left to answer. Passing this to `next` would mean writing a 503
      // to a response that has already closed.
      if (error instanceof SemaphoreAbandonedError) {
        return;
      }

      next(error);
    }
  );
}

/** Test seam. Nothing in the application resets the gate. */
export function resetResultsReadGateForTests(): void {
  gate = new Semaphore(MAX_CONCURRENT_RESULTS_READS);
}

/** Test seam. See Semaphore.stats. */
export function resultsReadGateStats(): { available: number; waiting: number } {
  return gate.stats();
}
