import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

import { listening } from '../../__tests__/helpers/listening';

jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() }
}));
jest.mock('../../config/index', () => ({
  pool: { query: jest.fn(), connect: jest.fn() }
}));

import adminRouter from '../admin';
import feedbackRouter from '../feedback';
import { pool } from '../../config/index';
import { errorHandler } from '../../utils/errorHandler';
import { CSV_EXPORT_BATCH_ROWS } from '../../utils/csv-stream';

const mockQuery = pool.query as unknown as jest.Mock;

/**
 * THE TWO ADMIN CSV EXPORTS ARE STREAMED, NOT MATERIALISED. cto/AdaptaLabs#65.
 *
 * Both ran an unbounded SELECT, mapped every row into an array of strings,
 * joined it and `res.send` the result - the whole pg result set plus the whole
 * CSV on the heap at once, per concurrent caller. #65 measured the QUERY at
 * 472ms and 247ms over 200,000 rows, so the statement timeout was never the
 * ceiling and this is not a query-performance change. It is about what the
 * process holds.
 *
 * WHAT A MOCKED POOL CAN AND CANNOT SEE. These arms drive the real handlers
 * through supertest with a mocked `pool.query`, so they can observe the number
 * of statements, the parameters bound, the bytes on the wire and what happens
 * to the socket when a batch read fails. What they CANNOT observe is whether
 * the keyset predicate actually walks a real table without dropping or
 * repeating a row - a mock returns whatever it was told to, so that would pass
 * against a route that paged by luck. That property is pinned in
 * csv-exports-keyset-postgres.test.ts against a real database.
 *
 * EVERY ARM IS PAIRED. "It issued more than one query" passes just as well
 * against a handler that issues the same query twice, so the batching arms
 * also assert the cursor ADVANCED, and a short-result arm proves a small
 * export does not pay for a second query it does not need.
 *
 * ONE PAIRING DELIBERATELY LIVES ELSEWHERE, and the reason is recorded on the
 * arm itself. "The formula was neutralised" passes against a handler that
 * prefixes EVERY cell, so it needs a control showing a generated column is
 * left alone - and that control cannot work at this level, because no value in
 * a generated column here can begin with =, + or @, which makes the two
 * branches the same function and the mutant equivalent. Measured, not assumed:
 * flipping the export's `csvCell(id, false)` to `true` passed 11 of 11. The
 * branch is pinned in utils/__tests__/csv-cell.test.ts instead, against values
 * where the outputs actually differ.
 */

type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appWith = (mount: string, router: express.Router, role: Role, id = 'admin-1') => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id, name: 'A', email: 'a@example.com', role }
    };
    next();
  });
  app.use(mount, router);
  app.use(errorHandler);
  return app;
};

const adminApp = (role: Role = 'superadmin') => appWith('/api/admin', adminRouter, role);
const feedbackApp = (role: Role = 'superadmin') => appWith('/api/feedback', feedbackRouter, role);

/** The statements the handler issued, in order, with their parameters. */
const calls = () => mockQuery.mock.calls as [string, unknown[]][];

const bookingRow = (n: number) => ({
  opportunity_title: `Study ${n}`,
  opportunity_type: 'interview',
  session_start: new Date(`2030-01-01T10:00:00.000Z`),
  session_end: new Date(`2030-01-01T11:00:00.000Z`),
  participant_name: `Person ${n}`,
  participant_email: `p${n}@example.com`,
  booking_status: 'booked',
  booked_at: new Date(`2026-01-01T00:00:00.000Z`),
  booking_id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  // The lossless cursor columns the route now selects. Postgres's ::text
  // rendering, µs included - the whole point is that these are NOT the parsed
  // ms-precision Dates above. See the precision note on the route.
  cursor_start_time: '2030-01-01 10:00:00.123456+00',
  cursor_created_at: '2026-01-01 00:00:00.123456+00'
});

const feedbackRow = (n: number) => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  user_name: `Person ${n}`,
  user_email: `p${n}@example.com`,
  category: 'bug',
  feedback: `it broke ${n}`,
  url: 'https://example.test/page',
  user_agent: 'Mozilla/5.0',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  cursor_created_at: '2026-01-01 00:00:00.123456+00'
});

/** `count` rows, served in batches of CSV_EXPORT_BATCH_ROWS, then stop. */
const servesRows = (make: (n: number) => Record<string, unknown>, count: number) => {
  let served = 0;
  mockQuery.mockImplementation(async () => {
    const size = Math.min(CSV_EXPORT_BATCH_ROWS, count - served);
    const rows = Array.from({ length: Math.max(0, size) }, (_, i) => make(served + i));
    served += rows.length;
    return { rows, rowCount: rows.length };
  });
};

describe('the admin CSV exports are streamed rather than materialised (#65)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // ------------------------------------------------------------------
  // THE PAGE SIZE, pinned as a literal.
  // ------------------------------------------------------------------

  it('holds the batch size at the number that was decided', () => {
    // WRITTEN OUT rather than compared to the import. A test that derives its
    // expectation from the constant cannot see the constant change, which is
    // the one thing this arm exists to do.
    expect(CSV_EXPORT_BATCH_ROWS).toBe(500);
  });

  // ------------------------------------------------------------------
  // BATCHING. The defect was one unbounded read; the fix is several bounded
  // ones.
  // ------------------------------------------------------------------

  it('reads the bookings export in batches and advances the cursor between them', async () => {
    servesRows(bookingRow, CSV_EXPORT_BATCH_ROWS + 10);

    await request(listening(adminApp())).get('/api/admin/export/bookings').expect(200);

    // TWO statements for one-and-a-bit batches, not one for everything.
    expect(calls()).toHaveLength(2);

    const [firstSql, firstParams] = calls()[0];
    const [, secondParams] = calls()[1];

    // Every statement is bounded. This is the property the issue asked for.
    expect(String(firstSql)).toMatch(/LIMIT \$5/);
    expect(firstParams[4]).toBe(CSV_EXPORT_BATCH_ROWS);

    // THE CURSOR ADVANCED, which is what tells this apart from a handler that
    // issued the same query twice - and from one that pages by OFFSET.
    expect(firstParams.slice(1, 4)).toEqual([null, null, null]);
    expect(secondParams[3]).toBe(bookingRow(CSV_EXPORT_BATCH_ROWS - 1).booking_id);
    // THE STRING, NOT THE DATE. Binding the parsed Date is the µs-truncation
    // bug the postgres walk caught in CI - this arm now pins that the cursor
    // parameter is the ::text rendering, so reintroducing the Date fails here
    // as a type of value, before Postgres has to demonstrate the truncation.
    expect(secondParams[1]).toBe(bookingRow(0).cursor_start_time);
    expect(secondParams[2]).toBe(bookingRow(0).cursor_created_at);
  });

  it('reads the feedback export in batches and advances the cursor between them', async () => {
    servesRows(feedbackRow, CSV_EXPORT_BATCH_ROWS + 10);

    await request(listening(feedbackApp())).get('/api/feedback/export').expect(200);

    expect(calls()).toHaveLength(2);

    const [firstSql, firstParams] = calls()[0];
    const [, secondParams] = calls()[1];

    expect(String(firstSql)).toMatch(/LIMIT \$3/);
    expect(firstParams).toEqual([null, null, CSV_EXPORT_BATCH_ROWS]);
    expect(secondParams[0]).toBe(feedbackRow(0).cursor_created_at);
    expect(secondParams[1]).toBe(feedbackRow(CSV_EXPORT_BATCH_ROWS - 1).id);
  });

  // THE CONTROL for both arms above. A short result set must NOT cost a second
  // query - otherwise "it batches" is satisfied by a handler that always asks
  // twice, and every small export pays for a round trip that returns nothing.
  it('does not ask a second time when the first batch was short', async () => {
    servesRows(bookingRow, 3);

    const res = await request(listening(adminApp())).get('/api/admin/export/bookings').expect(200);

    expect(calls()).toHaveLength(1);
    // And the rows are all there, so the single query is a complete answer
    // rather than a truncated one.
    expect(res.text).toContain('Person 0');
    expect(res.text).toContain('Person 2');
  });

  // ------------------------------------------------------------------
  // THE SECURITY PROPERTY. Formula injection, which the route-local
  // `escapeCsvField` in each of these two files did not guard against.
  // ------------------------------------------------------------------

  it('neutralises a spreadsheet formula submitted in feedback text', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...feedbackRow(1), feedback: '=HYPERLINK("http://evil.test","click")' }],
      rowCount: 1
    } as never);

    const res = await request(listening(feedbackApp())).get('/api/feedback/export').expect(200);

    // A TAB IN FRONT OF THE `=`, inside the quoted field. Excel and Sheets
    // then show the text instead of executing it. Before #65 this cell reached
    // a superadmin's spreadsheet as a live formula, written by whichever
    // authenticated user submitted the feedback.
    expect(res.text).toContain('"\t=HYPERLINK(""http://evil.test"",""click"")"');
    // And the raw, unprefixed form is NOT on the wire.
    expect(res.text).not.toContain(',=HYPERLINK');
  });

  it('neutralises a formula in an opportunity title on the bookings export', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...bookingRow(1), opportunity_title: '@SUM(A1:A9)' }],
      rowCount: 1
    } as never);

    const res = await request(listening(adminApp())).get('/api/admin/export/bookings').expect(200);

    expect(res.text).toContain('\t@SUM(A1:A9)');
  });

  /**
   * THE CONTROL for the two arms above, AND A CORRECTION TO WHAT IT CLAIMS.
   *
   * "It was neutralised" passes just as well against a handler that
   * tab-prefixes EVERY cell, which would stop the timestamps being dates and
   * the ids being ids in the spreadsheet - the whole reason to export them. So
   * a control is genuinely needed.
   *
   * IT CANNOT LIVE HERE, and mutation says so. An earlier version of this arm
   * drove the feedback export and asserted the uuid and the ISO timestamp were
   * not prefixed; flipping `csvCell(id, false)` to `true` in the route - the
   * exact over-prefixing it claimed to catch - passed 11 of 11. It had to:
   * `neutraliseCsvFormula` fires only on a leading =, +, - or @, and neither a
   * uuid nor an ISO timestamp can begin with one, so for those columns the two
   * branches ARE the same function. The mutant is equivalent, not uncaught.
   *
   * The branch is therefore pinned in utils/__tests__/csv-cell.test.ts against
   * values where the two outputs actually differ. What this arm asserts is the
   * weaker thing it can honestly see: that those columns arrive in the shape a
   * spreadsheet will read as a uuid and a date.
   */
  it('emits generated columns in a shape a spreadsheet reads as an id and a date', async () => {
    mockQuery.mockResolvedValue({ rows: [feedbackRow(7)], rowCount: 1 } as never);

    const res = await request(listening(feedbackApp())).get('/api/feedback/export').expect(200);

    const dataLine = res.text.split('\r\n')[1];
    expect(dataLine.startsWith('00000000-')).toBe(true);
    expect(dataLine).toContain('2026-01-01T00:00:00.000Z');
  });

  // ------------------------------------------------------------------
  // THE SHAPE OF THE FILE.
  // ------------------------------------------------------------------

  it('writes the header row first, and separates rows with CRLF', async () => {
    servesRows(feedbackRow, 2);

    const res = await request(listening(feedbackApp())).get('/api/feedback/export').expect(200);

    expect(res.text.split('\r\n')[0]).toBe(
      'ID,User Name,User Email,Category,Feedback,URL,User Agent,Created At'
    );
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="feedback-export-/);
  });

  // ------------------------------------------------------------------
  // REFUSED, NOT TRUNCATED.
  //
  // The hardest property in the file and the reason the writer destroys the
  // socket. Once the header is written the status is 200 and cannot be taken
  // back, so a failure part-way through cannot become a 500 - and if it ends
  // TIDILY the admin gets a shorter CSV that parses perfectly, with nothing
  // anywhere saying it is incomplete.
  // ------------------------------------------------------------------

  it('destroys the connection when a batch fails part-way through, rather than ending tidily', async () => {
    let call = 0;
    mockQuery.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return {
          rows: Array.from({ length: CSV_EXPORT_BATCH_ROWS }, (_, i) => feedbackRow(i)),
          rowCount: CSV_EXPORT_BATCH_ROWS
        };
      }
      throw new Error('connection terminated unexpectedly');
    });

    // The request FAILS at the transport, which is the observable. A tidy
    // `res.end()` here would resolve with a 200 and a short body - the exact
    // outcome this arm exists to refuse.
    await expect(
      request(listening(feedbackApp())).get('/api/feedback/export')
    ).rejects.toThrow();

    // It really did get as far as a second batch, so the failure is the one
    // this arm means to drive rather than an early refusal.
    expect(call).toBe(2);
  });

  // THE CONTROL for the arm above: the same two-batch walk, succeeding, must
  // complete normally. Without it "the request rejects" would pass against a
  // handler that had simply broken.
  it('completes normally when every batch succeeds', async () => {
    servesRows(feedbackRow, CSV_EXPORT_BATCH_ROWS + 1);

    const res = await request(listening(feedbackApp())).get('/api/feedback/export').expect(200);

    expect(calls()).toHaveLength(2);
    // Header plus every row, and nothing lost at the batch boundary.
    expect(res.text.trimEnd().split('\r\n')).toHaveLength(CSV_EXPORT_BATCH_ROWS + 2);
  });

  // ------------------------------------------------------------------
  // AUTHORISATION IS UNCHANGED. The rewrite moved the query into a callback,
  // which is exactly the kind of move that can leave a guard behind.
  // ------------------------------------------------------------------

  it('still refuses a non-admin on both exports, without querying anything', async () => {
    await request(listening(adminApp('employee'))).get('/api/admin/export/bookings').expect(403);
    await request(listening(feedbackApp('employee'))).get('/api/feedback/export').expect(403);

    expect(mockQuery).not.toHaveBeenCalled();
  });
});
