import type { Response } from 'express';

/**
 * THE ONE COPY OF THE CSV WRITE/DRAIN MACHINERY. cto/AdaptaLabs#80.
 *
 * `utils/csv-stream.ts` (#65) and `firsthand/survey-csv-response.ts` (!210)
 * each carried this loop, line for line. None of it was right first time -
 * it was corrected by two independent review gates and by mutation testing -
 * and a second copy was a second place for the next correction to miss,
 * which is exactly what #65 found had already happened to `escapeCsvField`
 * across three files. This module is the fold.
 *
 * WHAT IS DELIBERATELY NOT HERE: the budget constants and the error types.
 * The two callers' deadlines are equal today (300s / 30s) and MEAN different
 * things - the survey deadline is sized against `boundResultsRead` admission
 * (one permit, four routes starved by one stalled export), the admin one is
 * not - so each caller supplies its own numbers and its own error class, and
 * an edit to one cannot quietly retime the other. Both pairs are pinned as
 * literals in their own suites.
 *
 * THE CONTRACT, hard-won and asserted by both suites plus the canary:
 *
 *  - `res.write` returning false means wait for `drain`;
 *  - `drain`, `error` and `close` are all listened for, and EVERY listener
 *    plus the timer is removed on every path - the first survey version
 *    leaked one dead listener per slow write;
 *  - the wait is bounded by min(drain budget, remaining export budget), so a
 *    late write cannot overshoot the caller's deadline;
 *  - a timeout REJECTS rather than resolves - resolving would let the loop
 *    reach `res.end()` and hand over a short CSV that parses;
 *  - `close` resolves, because a hangup is the caller leaving, not a failure:
 *    the loop's own hangup check decides what happens next;
 *  - what to do with a rejection is the CALLER's half of the contract: any
 *    failure after the header row must `res.destroy()`, never `end()`.
 */

/**
 * Which of the two bounds fired. Both callers use these exact names.
 *
 * TWO MEMBERS BY DESIGN, and both callers' suites pin the membership. Both
 * error classes render their message with a binary ternary on this union, so
 * a third member would silently make both describe it as a drain failure -
 * and the survey file's history records a gate rejecting exactly that
 * three-member union once already (see SurveyCsvExportEnded's docblock).
 */
export type SocketWriteTimeoutReason = 'export_deadline' | 'drain_timeout';

interface BoundedSocketWriteOptions {
  res: Response;
  /**
   * The caller's whole-export budget, as a closure over its own start time
   * and its own deadline constant. This module never sees the number.
   */
  remainingBudgetMs: () => number;
  /** How long one write may wait for `drain`. The caller's own constant. */
  drainTimeoutMs: number;
  /**
   * Wraps the fired bound in the caller's own error type, so each caller
   * keeps its taxonomy (`CsvExportTimeoutError`, `SurveyCsvExportTimeoutError`)
   * and its catch blocks and logs read unchanged.
   */
  makeTimeoutError: (reason: SocketWriteTimeoutReason) => Error;
}

/**
 * Builds the write function: one chunk in, a promise that settles when the
 * socket accepted it, the client left, or a bound fired.
 */
export function makeBoundedSocketWrite({
  res,
  remainingBudgetMs,
  drainTimeoutMs,
  makeTimeoutError
}: BoundedSocketWriteOptions): (chunk: string) => Promise<void> {
  return (chunk: string) =>
    new Promise<void>((resolve, reject) => {
      // DEFENCE IN DEPTH, and measured to be exactly that rather than the
      // fix. `close` fires ONCE, so a write on a response destroyed before it
      // can never be settled by a listener attached afterwards - Node emits no
      // `error` either. But the guard that CLOSES that hole is the one each
      // caller runs before its header write plus its loop's own hangup check;
      // with those in place nothing async happens between check and write, so
      // this branch is unreachable today. Kept because it makes `write` safe
      // independently of its callers - an unreachable guard advertised as the
      // fix is how the next reader deletes the wrong one.
      if (res.destroyed || res.writableEnded) {
        resolve();
        return;
      }

      if (res.write(chunk)) {
        resolve();
        return;
      }

      // Whichever bound is nearer wins. Late in a long export the remaining
      // whole-export budget is the shorter of the two, and waiting a full
      // drain budget past the deadline would let the last write overshoot it.
      const budgetMs = remainingBudgetMs();

      // EQUIVALENT TO LETTING THE TIMER BELOW FIRE with a clamped-to-zero
      // delay, and measured to be - the mutation removing this branch
      // survives, correctly. Kept because a `setTimeout` with a negative
      // delay is the kind of thing a reader stops at.
      if (budgetMs <= 0) {
        reject(makeTimeoutError('export_deadline'));
        return;
      }

      // A holder rather than a `let` only because of ordering: the cleanup
      // closure must exist before the listeners it removes, and the timer
      // must be created after the handler that clears it.
      const drainWait: { timer?: ReturnType<typeof setTimeout> } = {};

      const done = (settle: () => void) => () => {
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
      // Not an error: the caller left, which each caller's loop detects and
      // stops for. Resolving lets it reach that check rather than throwing
      // into the destroy path.
      const onClose = done(() => resolve());
      // REJECTS, and must. Resolving on a timeout would let the loop carry
      // on to the next batch and then call `res.end()` - a short CSV that
      // parses, handed to a reader who has no way to tell.
      const onTimeout = done(() =>
        reject(
          makeTimeoutError(
            remainingBudgetMs() <= 0 ? 'export_deadline' : 'drain_timeout'
          )
        )
      );

      drainWait.timer = setTimeout(
        onTimeout,
        Math.min(drainTimeoutMs, budgetMs)
      );
      res.once('drain', onDrain);
      res.once('error', onError);
      res.once('close', onClose);
    });
}
