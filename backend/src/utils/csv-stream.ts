import type { Response } from 'express';

import {
  makeBoundedSocketWrite,
  type SocketWriteTimeoutReason
} from './bounded-socket-write';
import { CSV_ROW_SEPARATOR } from './csv-cell';
import { logger } from './logger';

/**
 * STREAM A CSV EXPORT TO THE SOCKET INSTEAD OF BUILDING IT IN MEMORY.
 * cto/AdaptaLabs#65.
 *
 * The two admin exports each ran an unbounded `SELECT`, mapped every row into
 * an array of strings, `join`ed it and `res.send` the result. Peak memory was
 * the whole pg result set PLUS the whole CSV string, on the heap, at once, per
 * concurrent caller, on a single-replica 2Gi pod. The query was never the
 * ceiling - #65 measured 200,000 rows at 472ms and 247ms, so the 120s
 * statement timeout is 250x clear - the MATERIALISATION was.
 *
 * WHY NOT `pg-query-stream`, WHICH #65 RECOMMENDS. Because the premise of that
 * recommendation is wrong: it says "this is what firsthand/survey-csv-
 * response.ts already does", and that file does not. `pg-query-stream` and
 * `QueryStream` appear nowhere in `backend/` outside `node_modules` - checked
 * as a plain substring over the whole directory. The survey export streams by
 * reading BATCHES and writing them with backpressure, and that is the pattern
 * copied here, so this adds no dependency and matches the one working example
 * in the tree.
 *
 * WHAT A BATCHED WALK IS NOT: a consistent snapshot. Each batch is its own
 * statement, so a row written between two batches is not in a transaction with
 * the ones already sent. Both exports order DESCENDING by time, so a row
 * created mid-export sorts BEFORE the first batch and is simply absent from
 * this export - the same outcome as if the request had started a moment
 * earlier, and the honest description of it. A row DELETED mid-export shifts
 * nothing, because the keyset cursor addresses a position by value rather than
 * by offset, which is the reason the walk is keyset rather than LIMIT/OFFSET.
 * Holding one transaction open for the whole export would give a true snapshot
 * and would pin a pool connection for as long as the slowest client takes to
 * read - which is the resource this change exists to stop over-committing.
 */

/**
 * How many rows one batch holds.
 *
 * A LITERAL, and asserted as the same literal in the test rather than derived
 * from this constant - a test that reads the constant cannot see the constant
 * change. 500 rows of these two shapes is a few hundred kilobytes, comfortably
 * under the 64KB socket high-water mark times a small multiple, and large
 * enough that a 200,000-row export is 400 round trips rather than 200,000.
 */
export const CSV_EXPORT_BATCH_ROWS = 500;

/**
 * The whole export's wall-clock budget.
 *
 * Bounds the export that is progressing but will never finish, which is a
 * different failure from the client that has stopped reading. Deliberately the
 * same five minutes `SURVEY_CSV_EXPORT_DEADLINE_MS` uses, because it is the
 * same question about the same kind of file and two different answers would
 * only invite a reader to wonder which is right.
 */
export const CSV_EXPORT_DEADLINE_MS = 300_000;

/**
 * How long ONE write may wait for the socket to drain.
 *
 * This is the bound that closes the stall. A client that reads nothing stalls
 * at the first write - no query in flight, nothing to cancel, just a promise
 * with no reason to settle. Thirty seconds of a full socket buffer is a client
 * that has gone rather than a slow one: the default high-water mark is 64KB,
 * so draining it inside this budget needs about 17 kbit/s.
 */
export const CSV_EXPORT_DRAIN_TIMEOUT_MS = 30_000;

/** Which bound fired. Carried into the log and asserted on. */
export type CsvExportTimeoutReason = SocketWriteTimeoutReason;

/**
 * Thrown INTO the existing failure path rather than beside it.
 *
 * Not handled specially by the caller: it reaches the same `catch` as a failed
 * batch read and gets the same `res.destroy()`. A timeout that ended the
 * response tidily would hand an admin a CSV that parses and holds part of the
 * data, which is the one outcome this file exists to prevent.
 */
export class CsvExportTimeoutError extends Error {
  constructor(readonly reason: CsvExportTimeoutReason) {
    super(
      reason === 'export_deadline'
        ? `The export exceeded its ${CSV_EXPORT_DEADLINE_MS}ms deadline.`
        : `The connection did not drain within ${CSV_EXPORT_DRAIN_TIMEOUT_MS}ms.`
    );
    this.name = 'CsvExportTimeoutError';
  }
}

/**
 * Reads the batch that follows `cursor`, or the first batch when it is
 * undefined. Returns fewer than `limit` rows exactly once, at the end.
 *
 * The cursor is opaque to this module ON PURPOSE. Each export keys on its own
 * ORDER BY - the bookings one on `(s.start_time, b.created_at, b.id)`, the
 * feedback one on `(created_at, id)` - and the only thing this file needs to
 * know is that the value it hands back is the one to ask with next.
 */
export type CsvBatchReader<TCursor> = (
  cursor: TCursor | undefined,
  limit: number
) => Promise<{ rows: string[]; nextCursor: TCursor | undefined }>;

/**
 * Writes a CSV export to the response a BATCH at a time.
 *
 * REFUSED, NOT TRUNCATED. Once the header row is written the status is 200 and
 * cannot be taken back, so a failure part-way through cannot become a 500.
 * What it must not do is finish tidily: a short CSV that parses is an admin
 * reading part of their data with nothing on the page saying so. So on any
 * failure the connection is DESTROYED - the client sees a transfer that ended
 * early, which is what it is.
 *
 * Backpressure is respected. `res.write` returning false means the socket
 * buffer is full, and ignoring that is how a slow client turns a bounded
 * export into an unbounded heap - reintroducing at the socket exactly the
 * problem this removes at the database.
 */
export async function streamCsvExport<TCursor>({
  res,
  filename,
  headerRow,
  readBatch,
  context
}: {
  res: Response;
  filename: string;
  headerRow: string;
  readBatch: CsvBatchReader<TCursor>;
  context: Record<string, unknown>;
}): Promise<void> {
  const startedAt = Date.now();
  const remainingBudgetMs = () => CSV_EXPORT_DEADLINE_MS - (Date.now() - startedAt);

  // The write/drain machinery lives in bounded-socket-write.ts (#80) - one
  // copy, two callers. This caller supplies its OWN budgets and error type;
  // the survey export supplies different ones, and equal values today do not
  // make them the same number (see the constants' docblocks).
  const write = makeBoundedSocketWrite({
    res,
    remainingBudgetMs,
    drainTimeoutMs: CSV_EXPORT_DRAIN_TIMEOUT_MS,
    makeTimeoutError: (reason) => new CsvExportTimeoutError(reason)
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  try {
    // Guarded before the header too: it is the one write with nothing in front
    // of it, and it follows the route's auth and ownership reads, which is the
    // likeliest place for a caller to have left.
    if (res.destroyed || res.writableEnded) {
      return;
    }

    await write(headerRow + CSV_ROW_SEPARATOR);

    let cursor: TCursor | undefined = undefined;

    for (;;) {
      // Checked BEFORE paying for the next batch, so a caller who left does
      // not cost a further round trip to the database.
      if (res.destroyed || res.writableEnded) {
        return;
      }

      // The deadline is observed BETWEEN batches as well as inside `write`.
      // Without this a export that is progressing steadily - never stalling on
      // the socket, so never reaching the drain bound - would run past the
      // deadline until it happened to hit backpressure.
      if (remainingBudgetMs() <= 0) {
        throw new CsvExportTimeoutError('export_deadline');
      }

      const batch = await readBatch(cursor, CSV_EXPORT_BATCH_ROWS);

      if (batch.rows.length > 0) {
        // Joined per batch rather than per row: one `write` per batch is one
        // backpressure decision per batch, and the string being joined is
        // bounded by CSV_EXPORT_BATCH_ROWS rather than by the table.
        await write(batch.rows.join(CSV_ROW_SEPARATOR) + CSV_ROW_SEPARATOR);
      }

      // THE TERMINATION CONDITION IS THE SHORT BATCH, NOT AN EMPTY ONE. A
      // reader that returned exactly `limit` rows on its last full batch and
      // then an empty one would work either way; a reader whose final batch is
      // short would loop once more for nothing. Stopping on `nextCursor` being
      // undefined lets the reader say "that was the end" directly, so a batch
      // that happens to land exactly on the boundary does not cost an extra
      // query and cannot be mistaken for the end when it is not.
      if (batch.nextCursor === undefined) {
        break;
      }

      cursor = batch.nextCursor;
    }

    res.end();
  } catch (error) {
    logger.error('CSV export failed part-way through', {
      ...context,
      error,
      reason: error instanceof CsvExportTimeoutError ? error.reason : undefined
    });

    // DESTROY, NEVER `end()`. See the docblock: a tidy end hands over a short
    // CSV that parses. `destroy` makes it a broken download instead, which is
    // the truth and is the only signal available once the 200 has gone out.
    res.destroy();
  }
}
