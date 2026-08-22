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
  participants: AsyncGenerator<{ sessionId: string; answers: StoredResponse[] }>,
  context: { studyId: string }
): Promise<void> {
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

      const done = (settle: () => void) => () => {
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

      res.once('drain', onDrain);
      res.once('error', onError);
      res.once('close', onClose);
    });

  try {
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
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    });

    // Not `res.end()`. See above: a tidy ending would hand the researcher a
    // valid CSV containing part of their data.
    res.destroy();
  }
}
