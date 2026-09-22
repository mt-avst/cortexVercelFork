import type { Response } from 'express';

import {
  makeBoundedSocketWrite,
  type SocketWriteTimeoutReason
} from '../utils/bounded-socket-write';
import type { StudyStep } from '../../../shared/firsthand/contract';
import {
  CSV_LINE_ENDING,
  toCsvHeaderRow,
  toCsvSessionRow,
  type CsvSessionRow,
  type RemovedQuestion
} from './survey-csv';
import { logger } from '../utils/logger';

/*
 * THE HALF OF THIS DESIGN NO TEST IN THIS REPOSITORY CAN REACH.
 *
 * Every failure path below destroys the socket rather than ending the response,
 * so a failure part-way through cannot become a short CSV that parses. That is
 * proven here and on the wire. What is NOT proven anywhere is the INGRESS: a
 * buffering proxy in front of the app collects the whole body before forwarding
 * a byte, and a destroyed socket then reaches the researcher as a
 * complete-looking truncated file with a Content-Length on it. The refusal
 * design is defeated in production, silently, and no local check can see it
 * (cto/AdaptaLabs#11).
 *
 * `scripts/csv-stream-check.mjs` is that check, made runnable in five minutes
 * against a real export with a session cookie. Its own tests measure it against
 * a streaming server and a buffering one, so its verdict means something before
 * anyone relies on it. Run it before the first real study collects responses -
 * that is the first moment a truncated file could reach a researcher.
 */

/**
 * The whole export's wall-clock budget.
 *
 * WITHOUT THIS THE EXPORT HAS NO BOUND IN TIME AT ALL, and that is not an
 * abstract worry. `boundResultsRead` releases its permit on the response's
 * `close`, MAX_CONCURRENT_RESULTS_READS is 1, and Node's `server.timeout`
 * defaults to 0 - so one authenticated admin who requests a CSV and then reads
 * nothing holds the only results-read permit indefinitely, and every other
 * admin including the superadmin gets 503 RESULTS_READ_QUEUE_FULL on all four
 * results routes for as long as they care to keep the socket open. No data and
 * no large study required. RESULTS_STATEMENT_TIMEOUT_MS bounds each STATEMENT;
 * nothing bounded the request.
 *
 * Five minutes is generous against the largest export the bounds allow and
 * still far below "indefinitely". It is deliberately much larger than
 * SURVEY_CSV_DRAIN_TIMEOUT_MS, because these two bound different things: the
 * drain bound catches the client that has stopped reading, this one catches
 * the export that is progressing but will never finish.
 *
 * WHAT IT DOES NOT BOUND: a batch read already in flight. The deadline is
 * observed between batches and while waiting for the socket, so a firing
 * deadline can overshoot by at most one batch read. That is NOT just
 * RESULTS_STATEMENT_TIMEOUT_MS, and an earlier version of this comment said
 * it was: a batch read is up to ADMIN_ADMISSION_TIMEOUT_MS queueing for a
 * permit, plus the pool's own connectionTimeoutMillis, plus the statement -
 * about 140 seconds, not 120. Cancelling an in-flight `pg` query needs a
 * second connection, which is the resource being protected.
 */
export const SURVEY_CSV_EXPORT_DEADLINE_MS = 300_000;

/**
 * How long one write may wait for the socket to drain.
 *
 * This is the bound that closes the attack. A client that reads nothing stalls
 * at the FIRST write - there is no query in flight, nothing to cancel, just a
 * promise that used to have no reason ever to settle. Thirty seconds of a full
 * socket buffer is a client that has gone, not a slow one: the default high
 * water mark is 64KB, so draining it inside this budget needs about 17 kbit/s.
 *
 * Sized in the knowledge that RESULTS_READ_QUEUE_TIMEOUT_MS is 10 seconds, so
 * a stall of this length still refuses other admins for a while. Trading the
 * other way - a bound below the queue timeout - would start destroying real
 * downloads on genuinely bad connections, which is a data-integrity cost paid
 * by the honest caller to shorten an outage the deadline already bounds.
 */
export const SURVEY_CSV_DRAIN_TIMEOUT_MS = 30_000;

/** Which of the two bounds fired. Carried into the log, and asserted on. */
export type SurveyCsvExportTimeoutReason = SocketWriteTimeoutReason;

/**
 * Thrown INTO the existing failure path rather than beside it.
 *
 * Deliberately not handled specially by the caller: it reaches the same
 * `catch` as a failed batch read and gets the same `res.destroy()`. A timeout
 * that ended the response tidily would hand the researcher a CSV that parses
 * and holds part of their data, which is the one outcome this whole file
 * exists to prevent.
 */
export class SurveyCsvExportTimeoutError extends Error {
  constructor(readonly reason: SurveyCsvExportTimeoutReason) {
    super(
      reason === 'export_deadline'
        ? `The export exceeded its ${SURVEY_CSV_EXPORT_DEADLINE_MS}ms deadline.`
        : `The connection did not drain within ${SURVEY_CSV_DRAIN_TIMEOUT_MS}ms.`
    );
    this.name = 'SurveyCsvExportTimeoutError';
  }
}

/**
 * Raised into the deadline signal when the export ENDS, however it ended.
 *
 * A SEPARATE TYPE, and it was briefly a third member of the reason union
 * above - which a gate correctly called out. The drain-timeout path never
 * aborts the controller (it rejects the write promise instead), so on that
 * path this supplies the only reason the signal ever carries: anything reading
 * `signal.reason` after a stalled client would have been handed a value whose
 * own type said "timeout" and whose text said "finished". Two types cannot be
 * confused; one union of three could be, and the union's docblock said "two"
 * while listing three.
 *
 * The log is unaffected and still names the bound that fired. This says only
 * what a watcher needs: stop.
 */
export class SurveyCsvExportEnded extends Error {
  constructor() {
    super('The export ended; nothing should still be reading.');
    this.name = 'SurveyCsvExportEnded';
  }
}

/**
 * Writes an export to the response a participant at a time.
 *
 * The whole reason this exists rather than `res.send(toResponsesCsv(...))`:
 * that path materialises up to 200,001 rows, then an object graph built from
 * them, then the response body - a few hundred megabytes for one request on a
 * single-replica 2Gi pod. This holds one batch of participants.
 *
 * REFUSED, NOT TRUNCATED - the same principle as the row bound, at a point
 * where the tools are worse. Once the header row is written the status is 200
 * and cannot be taken back, so a failure part-way through CANNOT become a 500.
 * What it must not do is finish tidily: a short CSV that parses is a researcher
 * computing a mean over part of their data with nothing on the page saying so.
 * So the connection is DESTROYED. The client sees a transfer that ended early -
 * a broken download, which is what it is - rather than a smaller data set than
 * they think they are looking at.
 *
 * Backpressure is respected. `res.write` returning false means the socket's
 * buffer is full, and ignoring that is how a slow client turns a bounded export
 * into an unbounded heap - reintroducing, at the socket, exactly the problem
 * this removes at the database.
 */
export async function writeSurveyCsv(
  res: Response,
  steps: StudyStep[],
  removedQuestions: RemovedQuestion[],
  openParticipants: (
    signal: AbortSignal
  ) => AsyncGenerator<CsvSessionRow>,
  // Also the HMAC key material for each row's Participant digest
  // (cto/AdaptaLabs#154), not only the failure log's context below - a
  // mismatch between this and the study the rows actually belong to would
  // silently digest under the wrong study.
  context: { studyId: string }
): Promise<void> {
  /**
   * A FACTORY RATHER THAN A GENERATOR, and that is the deadline's reach.
   *
   * The reads happen inside the generator, so a deadline the generator cannot
   * see bounds only the half of the export that waits on the socket. A slow
   * export that is progressing - or one retrying a busy pool, which
   * cto/AdaptaLabs#6 adds - would run past it until the next yield.
   *
   * The signal is created here because the deadline belongs to the response:
   * this is the only place that knows when the first byte was written and the
   * only place that can destroy the socket when the budget is gone.
   */
  const startedAt = Date.now();
  const remainingBudgetMs = () =>
    SURVEY_CSV_EXPORT_DEADLINE_MS - (Date.now() - startedAt);

  const expired = new AbortController();
  const deadlineTimer = setTimeout(
    () => expired.abort(new SurveyCsvExportTimeoutError('export_deadline')),
    SURVEY_CSV_EXPORT_DEADLINE_MS
  );

  // The write/drain machinery lives in utils/bounded-socket-write.ts (#80) -
  // one copy, two callers. THE HISTORY THAT SHAPED IT IS RECORDED THERE: the
  // listener-per-slow-write leak, the unbounded wait that held the only
  // results-read permit, and which guards mutation testing proved load-bearing
  // versus defence in depth. This caller supplies its OWN budgets and error
  // type - the deadline here is sized against `boundResultsRead` admission,
  // which the admin exports do not contend with, so equal values today are
  // two decisions, not one (see the constants' docblocks above).
  const write = makeBoundedSocketWrite({
    res,
    remainingBudgetMs,
    drainTimeoutMs: SURVEY_CSV_DRAIN_TIMEOUT_MS,
    makeTimeoutError: (reason) => new SurveyCsvExportTimeoutError(reason)
  });

  try {
    // OPENED INSIDE THE TRY, and that is not tidiness. Called above the
    // `try`, a factory that threw synchronously left the five-minute deadline
    // timer armed with nothing to clear it - a probe with a throwing factory
    // measured the process staying alive 300005ms, against a control arm that
    // exited in 1ms. Both gates found it independently.
    //
    // Not reachable through either route today: calling an async generator
    // function cannot execute its body, so it cannot throw. It becomes
    // reachable the moment the factory is anything else, and its symptom is a
    // dangling timer - a CI job that hangs with no named failing test, which
    // is the hardest kind of regression to read.
    const participants = openParticipants(expired.signal);

    // Guarded before the header too. It is the one write with nothing in front
    // of it, and it is reached straight after the preflight reads - the
    // slowest part of the request and so the likeliest place for a caller to
    // have left.
    if (res.destroyed || res.writableEnded) {
      return;
    }

    await write(toCsvHeaderRow(steps, removedQuestions) + CSV_LINE_ENDING);

    for await (const participant of participants) {
      // Checked BEFORE using the batch this pull just paid for, and note what
      // it cannot do: `for await` has already advanced the generator by the
      // time this runs, so a hangup during the last yield of a batch still
      // costs one more query. Moving the whole check inside the generator
      // would close that, at the cost of putting response state into the
      // repository.
      if (res.writableEnded || res.destroyed) {
        return;
      }

      // THROWS RATHER THAN RETURNING, and the difference is the whole defect
      // this file guards. `return` here leaves `res.end()` unreached but also
      // leaves the socket open, so the permit - released on `close` - is never
      // handed back; and the obvious "tidy up" repair of ending the response
      // instead produces a valid CSV holding part of the data. Throwing lands
      // in the catch below, which destroys.
      expired.signal.throwIfAborted();

      // A PARTICIPANT WHOSE ANSWERS VANISHED IS AN ABSENCE, NOT A BLANK ROW.
      //
      // Every id in the list came from a GROUP BY over participant_responses,
      // so each had at least one answer when the preflight ran. Reaching this
      // point with none means they disappeared in between - and that is not
      // exotic: `session_id` carries ON DELETE CASCADE, and a participant
      // retaking a session deletes the old runtime_sessions row, so an
      // ordinary retake between the preflight and this batch cascades their
      // answers away.
      //
      // Emitting the row anyway writes a session id followed by empty cells,
      // which lands in the denominator of any response-rate calculation for
      // somebody who did answer.
      //
      // BE PRECISE ABOUT WHY, because the obvious reason is wrong: a row of
      // empty cells is NOT otherwise impossible. A participant whose only
      // stored row is a detached non-question - an `instruction`, storable by
      // any client driving the participant API - renders exactly that, and the
      // unbatched export renders it too.
      //
      // The real test is agreement with `toResponsesCsv` over the same rows,
      // and it separates the two cases cleanly. That builder works from answer
      // rows, so the instruction-only participant HAS a row and keeps their
      // blank line, while a participant whose rows have gone has nothing to
      // build from and simply is not there. Skipping here reproduces both.
      if (participant.answers.length === 0) {
        continue;
      }

      await write(
        toCsvSessionRow(steps, removedQuestions, participant, context.studyId) +
          CSV_LINE_ENDING
      );
    }

    res.end();
  } catch (error) {
    logger.error('Survey CSV export failed part-way through', {
      studyId: context.studyId,
      // Named so an operator reading this can tell a stalled client from a
      // failed read without correlating timestamps. 'error' is everything
      // else - a batch read that threw, a pool refusal that outlasted its
      // retries - which is what this log used to be able to say and all it
      // used to be able to say.
      reason:
        error instanceof SurveyCsvExportTimeoutError ? error.reason : 'error',
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    });

    // Not `res.end()`. See above: a tidy ending would hand the researcher a
    // valid CSV containing part of their data.
    res.destroy();
  } finally {
    clearTimeout(deadlineTimer);

    // ABORTED ON EVERY EXIT, not only when the deadline fires - and it is an
    // OBSERVABILITY device rather than a correctness one. Said plainly,
    // because an earlier version of this comment claimed the opposite and a
    // gate measured it false.
    //
    // The claim was that an early `return` leaves the generator suspended with
    // a batch read or a retry backoff still watching this signal. It does not:
    // `for await` performs AsyncIteratorClose on every abrupt exit, so
    // `participants.return()` runs and the generator's own `finally` completes
    // BEFORE this line - observed with the signal still unaborted. The
    // consumer only ever holds control while the generator is parked at a
    // `yield`, so there cannot be a `pause` outstanding at this moment.
    //
    // What it IS for: it is what makes the plumbing observable, which is why
    // the review gate could break the route call site with the whole suite
    // green.
    // Swapping `csvExport.participants` for
    // `() => csvExport.participants(new AbortController().signal)` type-checks,
    // passes 831 jest and 622 vitest tests, and silently unbounds the database
    // half of the deadline - a required parameter stops a caller passing
    // NOTHING, it cannot stop them passing something ELSE. Because this fires
    // on the ordinary success path too, a route test can hold the signal its
    // stand-in was handed and assert it ends up aborted, which no assertion
    // about the deadline itself could reach without waiting five minutes.
    // And it stays correct if a future caller passes a factory `for await`
    // cannot close, which is the only reason to prefer it to a test seam.
    expired.abort(new SurveyCsvExportEnded());
  }
}
