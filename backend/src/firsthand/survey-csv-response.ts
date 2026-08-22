import type { Response } from 'express';

import type { StudyStep } from '../../../shared/firsthand/contract';
import {
  CSV_LINE_ENDING,
  toCsvHeaderRow,
  toCsvParticipantRow,
  type RemovedQuestion
} from './survey-csv';
import type { StoredResponse } from './survey-results';
import { logger } from '../utils/logger';

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
export type SurveyCsvExportTimeoutReason = 'export_deadline' | 'drain_timeout';

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
  ) => AsyncGenerator<{ sessionId: string; answers: StoredResponse[] }>,
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

  /**
   * Writes one chunk, waiting for the socket if its buffer is full.
   *
   * EVERY LISTENER IS REMOVED ON EVERY PATH. The first version attached
   * `once('drain')` and `once('error')` and let whichever did not fire stay
   * attached - so a large export under backpressure accumulated one dead error
   * listener per slow write, thousands of them, with the
   * MaxListenersExceededWarning arriving long after the cause.
   *
   * `close` is waited on as well as `error`. A caller who hangs up mid-download
   * produces neither a drain nor an error, so without it this promise would
   * never settle and the loop would wait forever for a socket nobody is
   * reading.
   */
  const write = (chunk: string) =>
    new Promise<void>((resolve, reject) => {
      // DEFENCE IN DEPTH, and measured to be exactly that rather than the
      // fix. `close` fires ONCE, so a write on a response destroyed before it
      // can never be settled by a listener attached afterwards - Node emits no
      // `error` either, handing ERR_STREAM_DESTROYED to an absent callback and
      // returning false. Both gates found that and both reproduced it.
      //
      // But the guard that CLOSES it is the one before the header write, not
      // this one. Mutation testing says so plainly: removing the header guard
      // alone fails a test by name, removing this one alone fails nothing, and
      // removing both fails. With the header guard and the loop's own hangup
      // check in place, nothing async happens between either check and the
      // write that follows it, so this branch is unreachable today.
      //
      // Kept anyway, because it makes `write` safe independently of its
      // callers - but described as what it is. An unreachable guard advertised
      // as the fix is how the next reader deletes the wrong one.
      if (res.destroyed || res.writableEnded) {
        resolve();
        return;
      }

      if (res.write(chunk)) {
        resolve();
        return;
      }

      // THE WAIT IS BOUNDED, and before this line it was not. `drain`,
      // `error` and `close` are the only three events that could settle this
      // promise, and a client whose TCP window is zero emits none of them -
      // so the export stopped here forever, holding the only results-read
      // permit. Demonstrated rather than argued: a response whose `write`
      // returns false and never drains left this promise unsettled past five
      // seconds, half the queue timeout every other admin is waiting out.
      //
      // Whichever bound is nearer wins. Late in a long export the remaining
      // whole-export budget is the shorter of the two, and waiting the full
      // drain budget past the deadline would let the last write overshoot it.
      const budgetMs = remainingBudgetMs();

      // EQUIVALENT TO LETTING THE TIMER BELOW FIRE, and measured to be: with
      // a spent budget `Math.min` yields a non-positive delay, Node clamps it
      // to the next tick, and `onTimeout` rejects with the same reason. The
      // mutation removing this branch survives, correctly.
      //
      // Kept because a `setTimeout` with a negative delay is the kind of thing
      // a reader stops at, and stated as what it is rather than as a guard
      // that does something - an unreachable branch advertised as load-bearing
      // is how the next reader deletes the wrong one.
      if (budgetMs <= 0) {
        reject(new SurveyCsvExportTimeoutError('export_deadline'));
        return;
      }

      // A holder rather than a `let`, and only because of ordering: the
      // cleanup closure must exist before the listeners it removes, and the
      // timer must be created after the handler `done` produces. One of the
      // three has to be able to see something that does not exist yet.
      const drainWait: { timer?: ReturnType<typeof setTimeout> } = {};

      const done = (settle: () => void) => () => {
        // The timer is cleared on EVERY path, for the same reason the three
        // listeners are: a per-write timer left armed on a large export is a
        // handle leak, and one that outlives the request keeps the process
        // awake in tests.
        clearTimeout(drainWait.timer);
        res.off('drain', onDrain);
        res.off('error', onError);
        res.off('close', onClose);
        settle();
      };

      const onDrain = done(() => resolve());
      const onError = done(() =>
        reject(new Error('The connection failed while writing the export.'))
      );
      // Not an error: the caller left, which the loop below detects and stops
      // for. Resolving lets it reach that check rather than throwing into the
      // destroy path.
      const onClose = done(() => resolve());
      // REJECTS, and must. Resolving on a timeout would let the loop carry on
      // to the next row and then call `res.end()` - a short CSV that parses,
      // handed to a researcher who has no way to tell.
      const onTimeout = done(() =>
        reject(
          new SurveyCsvExportTimeoutError(
            remainingBudgetMs() <= 0 ? 'export_deadline' : 'drain_timeout'
          )
        )
      );

      drainWait.timer = setTimeout(
        onTimeout,
        Math.min(SURVEY_CSV_DRAIN_TIMEOUT_MS, budgetMs)
      );
      res.once('drain', onDrain);
      res.once('error', onError);
      res.once('close', onClose);
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
        toCsvParticipantRow(
          steps,
          removedQuestions,
          participant.sessionId,
          participant.answers
        ) + CSV_LINE_ENDING
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
