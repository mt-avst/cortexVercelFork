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

/**
 * How many results reads ONE CALLER may have in flight at once.
 *
 * The global permit above bounds the heap. This bounds a CALLER, and it exists
 * because the two are not the same thing: cto/AdaptaLabs#9 measured one
 * authenticated `researcher_admin`, staying entirely inside the !201 rate
 * limits, refusing 86-93% of another admin's results-route requests for as long
 * as they cared to. A gate of one is fair between requests and says nothing
 * about who sent them.
 *
 * TWO JOBS, and it was worth building for either one alone.
 *
 * FIRST, it bounds how deep one caller can make the queue. `studyResultsLimiter`
 * allows ten a minute and `surveyResultsLimiter` sixty, and a minute's worth of
 * either can arrive in the same second - so without this, one caller could put
 * ten holds in a FIFO queue ahead of a victim who then waits ten times the
 * maximum hold and answers 503 at RESULTS_READ_QUEUE_TIMEOUT_MS. Refused rather
 * than queued, deliberately: queueing the ones over the limit would BE the
 * starvation, just at a politer status code.
 *
 * SECOND, it is what makes the early release below safe. Once the global permit
 * is handed back at the preflight boundary, nothing else bounds how many CSV
 * streams run at once - each holding one batch plus its id list, up to 200,000
 * session ids. Held for the whole request, this caps concurrent streams at TWO
 * PER ADMIN rather than at a minute's worth of rate limit, and
 * `researcher_admin` is held by the handful of people who run the research.
 *
 * THE CEILING GENUINELY WIDENED, and here is the arithmetic rather than the
 * assurance. Before the early release the permit capped concurrent streams at
 * ONE, globally. Now it is two per admin id, and 200,000 UUID strings is
 * roughly 8-16MB of heap - so ten admins exporting large studies at the same
 * moment is 160-320MB, a measurable fraction of a single-replica 2Gi pod. A
 * second identity buys two more unpermitted streams, so this bounds a
 * COOPERATIVE population, not an adversarial one.
 *
 * That is a bound a reader can check against their own admin count, which is
 * the point of writing it down: "a handful of people" is an assertion about a
 * number nobody has looked up, and it is the kind that stops being true
 * quietly. If the admin roll grows past ten, or the largest study approaches
 * the 200,000 participant ceiling, this trade needs re-deciding - and the way
 * to close it properly is to stop materialising the id list, not to lower this.
 *
 * TWO RATHER THAN ONE, and the number was measured twice before it was chosen.
 *
 * One is the tighter bound and it costs the primary workflow of the person this
 * feature exists for: download a CSV, then reload your own results view, and
 * the second request answers 429 until the download has drained. Not an edge
 * case - the ordinary way a researcher uses the page.
 *
 * What two costs was measured with `backend/probe/occupancy.ts`, interleaved,
 * three rounds, and the answer is NOTHING ON THE PROPERTY #9 IS ABOUT. A burst
 * of 20 from one caller against a victim polling every 2s:
 *
 *   slots  victim 200  503  429   the 503s are the attack landing
 *   0 (no limit)    51    6    0   <- one admin starving another
 *   1               54    0    3
 *   2               51    0    6
 *
 * Attacker-caused starvation is ZERO at both one and two, in every round. The
 * success ratio differs - 0.95 against 0.89 - and every one of those refusals
 * is a 429 the victim earned from their OWN limit, because polls queued behind
 * the burst overlap each other. A larger budget lets more of the victim's own
 * polls into the queue, where they sit longer and meet the limit more often.
 *
 * So the ratio is worse and the outage is not, and the polling pattern that
 * produces the difference is one !201 established nothing performs: a human
 * reloading a page has one request in flight. The `csv after` arm measured 1.00
 * at both, so the fix itself does not depend on this number.
 *
 * WHAT WOULD SEND IT BACK TO ONE: evidence of a real caller with three
 * concurrent results reads, or a 503 appearing in the burst arm at two.
 *
 * NOT A COOLDOWN and nothing here waits: a caller over the limit is refused in
 * the same tick. A limit that queued would be a second place a request can wait
 * forever, and the whole point of this file is that such places become CI hangs
 * with no named failing test.
 */
export const MAX_IN_FLIGHT_RESULTS_READS_PER_USER = 2;

let gate = new Semaphore(MAX_CONCURRENT_RESULTS_READS);

/**
 * In-flight results reads per caller id.
 *
 * A Map rather than a counter object so an absent key is genuinely zero, and
 * DELETED at zero rather than left at 0 - a key per admin who ever exported is
 * a slow leak on a process that runs for weeks.
 */
let inFlightByUser = new Map<string, number>();

/**
 * The early release, keyed by the response it belongs to.
 *
 * A WeakMap rather than a property on `Response`, so nothing has to widen the
 * Express types and a forgotten entry cannot keep a response alive.
 */
const earlyRelease = new WeakMap<Response, () => void>();

/**
 * The caller a permit is charged to.
 *
 * `boundResultsRead` is mounted after `requireAdmin` on every route that
 * carries it, so `req.user` is always set in the application and this fallback
 * is only reached by a test mounting the middleware alone.
 *
 * ponytail: one shared bucket for callers with no id, so a mount that loses
 *   `req.user` fails CLOSED - every such request contends for the same single
 *   slot rather than being waved through unbounded. The upgrade path is to make
 *   the middleware require an authenticated user and throw without one, which
 *   needs the four route tests to build sessions.
 */
function chargedTo(req: Request): string {
  return req.user?.id ?? 'unidentified-caller';
}

function tooManyResultsReads(): AppError {
  return new AppError(
    'Too many result sets are being read at once. Wait a few seconds and try again.',
    503,
    'RESULTS_READ_QUEUE_FULL'
  );
}

/**
 * 429 rather than 503, and the difference is whose fault it is.
 *
 * A 503 says the server is busy and invites a retry. This says the CALLER
 * already has a results read running, which no amount of retrying changes and
 * which a client should surface as "your other download is still going" rather
 * than as an outage.
 */
function callerAlreadyReading(): AppError {
  return new AppError(
    'You already have a result set being read. Wait for it to finish and try again.',
    429,
    'RESULTS_READ_USER_BUSY'
  );
}

/**
 * Holds a permit past the database checkout, and a per-caller slot for the
 * whole request.
 *
 * THIS DOCBLOCK SAID "THE WHOLE REQUEST" FOR BOTH, and that was true of all
 * four routes until cto/AdaptaLabs#9. It is still true of the two AGGREGATE
 * routes; the two CSV routes now hand the permit back at their preflight-to-
 * stream boundary, because the phase after it is paced by the client and a
 * permit whose length the client chooses is a lever rather than a bound. See
 * `releaseResultsReadPermit`. The per-caller slot is held to `close` on all
 * four.
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
 *
 * WHICH IS WHAT #9 MEASURED, and it is why `req` is read here at all. That
 * paragraph used to end "bounding that needs the ownership decision to move
 * into middleware, which is a larger change than this one" - and the conclusion
 * was wrong, not the observation. Bounding the CALLER needs no ownership
 * decision: `requireAdmin` has already established who they are, and one slot
 * each is enough to stop one of them occupying the queue. What still needs the
 * ownership decision is stopping them reaching the gate at all, which nothing
 * here attempts.
 */
export function boundResultsRead(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const userId = chargedTo(req);
  const alreadyInFlight = inFlightByUser.get(userId) ?? 0;

  // BEFORE THE QUEUE, not after it. Checked after `acquire`, this would bound
  // how many of one caller's requests run and not how many of them WAIT, which
  // is the half that starves everybody else.
  if (alreadyInFlight >= MAX_IN_FLIGHT_RESULTS_READS_PER_USER) {
    next(callerAlreadyReading());
    return;
  }

  inFlightByUser.set(userId, alreadyInFlight + 1);

  const abandoned = new AbortController();
  let releaseGate: (() => void) | undefined;
  let slotReleased = false;
  let closed = false;

  /**
   * Gives back BOTH, and is safe to call from any state.
   *
   * The slot has its own once-flag rather than leaning on `releaseOnce`,
   * because the two are taken at different moments: the slot is held from the
   * first line of this function and the gate permit only from the grant. A
   * single flag would either decrement a slot twice on the refusal path or
   * skip it entirely.
   */
  const releaseHeld = () => {
    if (!slotReleased) {
      slotReleased = true;
      const held = inFlightByUser.get(userId) ?? 0;
      if (held <= 1) {
        inFlightByUser.delete(userId);
      } else {
        inFlightByUser.set(userId, held - 1);
      }
    }

    releaseGate?.();
  };

  const onClose = () => {
    closed = true;
    // Before the grant this cancels the wait; after it, this IS the release.
    abandoned.abort();
    releaseHeld();
  };

  res.on('close', onClose);

  gate.acquire(RESULTS_READ_QUEUE_TIMEOUT_MS, tooManyResultsReads, abandoned.signal).then(
    () => {
      releaseGate = releaseOnce(gate);

      // The close raced the grant and won. Hand the permit straight back and
      // do not start a handler whose response nobody is reading.
      if (closed || res.destroyed || res.writableEnded) {
        releaseHeld();
        return;
      }

      // Registered only once a permit is actually held, so an early release
      // called from a handler that never got one cannot exist.
      earlyRelease.set(res, releaseGate);

      next();
    },
    (error) => {
      res.off('close', onClose);

      // RELEASED ON THE REFUSAL PATH TOO, and this is the one that is easy to
      // miss: the listener has just been removed, so nothing else will ever
      // give the slot back and the caller would be locked out of all four
      // routes for the life of the process by a single 503.
      releaseHeld();

      // Nobody left to answer. Passing this to `next` would mean writing a 503
      // to a response that has already closed.
      if (error instanceof SemaphoreAbandonedError) {
        return;
      }

      next(error);
    }
  );
}

/**
 * Hands the GLOBAL permit back before the response has drained.
 *
 * For the two CSV routes, and called at the preflight-to-stream boundary. What
 * the permit exists to bound is the heap, and after !210 the streaming phase's
 * heap is one batch plus the id list - not the 200,001 rows this file's own
 * docblock still describes. So the phase after this call is not the phase the
 * permit was written for; it is the phase the CLIENT controls, and a permit the
 * client controls the length of is not a bound, it is a lever.
 *
 * cto/AdaptaLabs#9 measured that lever: one admin requesting a CSV and reading
 * nothing held the only permit for SURVEY_CSV_DRAIN_TIMEOUT_MS every time, ten
 * times a minute, refusing another admin 86-93% of their requests. No deadline
 * closes that - occupancy stays under 100% only while requests-per-minute times
 * maximum-hold is under 60 seconds, which at ten a minute needs a hold under
 * six seconds and no bound that also serves a legitimate slow client is near
 * that. Taking the client-controlled phase out of the permit does close it.
 *
 * THE PER-CALLER SLOT IS NOT RELEASED HERE, deliberately. It is what keeps the
 * now-unpermitted streaming phase bounded - see
 * MAX_IN_FLIGHT_RESULTS_READS_PER_USER. Releasing both here would trade an
 * availability bound for a memory one, which is the same mistake in the other
 * direction.
 *
 * A NO-OP when called twice, or on a response that holds nothing: it resolves
 * to the same `releaseOnce` the close listener calls, so the ceiling cannot be
 * widened by calling this from a handler that has already finished.
 *
 * NOT called by the two aggregate routes, and that is not an omission. Their
 * body carries every open-text answer verbatim, so the heap genuinely is held
 * until the client drains it, and releasing there would be handing back a
 * permit while still holding what the permit is for. They remain exposed to the
 * same occupancy attack - recorded on cto/AdaptaLabs#9 rather than fixed here,
 * because closing it needs the aggregate BODY bounded, which is a decision
 * about what a researcher is shown.
 */
export function releaseResultsReadPermit(res: Response): void {
  earlyRelease.get(res)?.();
}

/** Test seam. Nothing in the application resets the gate. */
export function resetResultsReadGateForTests(): void {
  gate = new Semaphore(MAX_CONCURRENT_RESULTS_READS);
  // RESET TOO. A per-caller slot surviving into the next test locks that
  // caller out of it, and the symptom is an unrelated 429 in a later file.
  inFlightByUser = new Map();
}

/** Test seam. See Semaphore.stats. */
export function resultsReadGateStats(): { available: number; waiting: number } {
  return gate.stats();
}

/** Test seam. How many reads one caller is charged with right now. */
export function resultsReadsInFlightFor(userId: string): number {
  return inFlightByUser.get(userId) ?? 0;
}

/** Test seam. Callers currently charged with anything - a leak is visible here. */
export function resultsReadCallersInFlight(): number {
  return inFlightByUser.size;
}
