import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

import { listening } from '../../__tests__/helpers/listening';

jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));
jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

import bookingsRouter, { ALL_BOOKINGS_PAGE_SIZE } from '../bookings';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;

/**
 * `GET /api/bookings/my/bookings/all` IS BOUNDED, AND THE BOUND DOES NOT LIE.
 * cto/AdaptaLabs#66.
 *
 * WHAT WAS ACTUALLY WRONG. Nothing, today - severity LOW and stated as such.
 * The route is owner-scoped by `WHERE b.user_id = $1` behind `requireAuth`, so
 * the blast radius is ONE user's own rows and the count is bounded by how many
 * studies a human books, realistically tens. What made it worth a bound anyway
 * is that this is the one booking surface whose row count only ever GROWS -
 * cancelled rows are never filtered out and nothing ages them out - and it had
 * no bound at all.
 *
 * WHY NOT A BARE `LIMIT`, which is the fix this route invites. Its contract is
 * "all of them, cancelled ones included". A clipped array is indistinguishable
 * from a complete one to the caller, and there is no way to ask for the rest -
 * so a bare LIMIT converts an unbounded read into a SILENTLY TRUNCATED one,
 * which is a correctness defect wearing a performance fix's clothes.
 *
 * THE PRECEDENT IS `GET /api/gamification/points-history`, not the leaderboard
 * clamp and not `GET /api/opportunities`' 413. The disposition rule is written
 * out on `parseLimit` in routes/gamification.ts: clamp where the ceiling IS the
 * answer, refuse where a short page would lie about a whole collection, report
 * `has_more` where the rows are the CALLER'S OWN and a page is legitimate.
 * These are the caller's own bookings, so this route copies the third shape -
 * `{ bookings, has_more, next_before }`, keyset on `(created_at, id)`, one
 * extra probe row - rather than inventing a fourth.
 *
 * THE REAL CURSOR WALK IS NEXT DOOR, in bookings-all-keyset-postgres.test.ts,
 * because the pool is MOCKED here: a mock returns whatever it was told to, so
 * nothing in this file can prove the keyset predicate actually pages. What this
 * file pins is the arithmetic and the wire shape - the page size as a LITERAL,
 * the probe row, both arms of `has_more`, and the 400 on an unreadable cursor.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const CALLER_ID = 'participant-1';

const appAs = (role: Role, id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: Role } } }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/**
 * A row shaped like the one the projection actually returns, `cursor_at`
 * included - that column is `to_char`'d in SQL rather than derived in JS, so a
 * fixture without it cannot see whether `next_before` is built from it.
 */
const row = (n: number) => ({
  id: `booking-${n}`,
  session_id: `session-${n}`,
  status: 'cancelled',
  created_at: new Date(Date.UTC(2026, 0, 1, 9, 0, 0) - n * 60_000),
  cursor_at: `2026-01-01T09:0${n % 10}:00.000000Z`,
  cancelled_at: new Date(Date.UTC(2026, 0, 2, 9, 0, 0)),
  opportunity_title: `Study ${n}`,
  opportunity_type: 'interview',
  session_start_time: new Date(Date.UTC(2026, 1, 1, 9, 0, 0)),
  session_end_time: new Date(Date.UTC(2026, 1, 1, 10, 0, 0)),
});

const rows = (count: number) => Array.from({ length: count }, (_unused, i) => row(i));

const get = (query = '') =>
  request(listening(appAs('employee', CALLER_ID))).get(`/api/bookings/my/bookings/all${query}`);

describe('GET my/bookings/all is a bounded page', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('holds the page size at the number that was decided', () => {
    // THE LITERAL, not `ALL_BOOKINGS_PAGE_SIZE` compared with itself. A test
    // that derives its expectation from the constant cannot see the constant
    // change, which is how three mutations survived a review in this
    // repository before.
    expect(ALL_BOOKINGS_PAGE_SIZE).toBe(100);
  });

  it('asks the database for one row more than a page, and for no more than that', async () => {
    mockQuery.mockResolvedValue({ rows: rows(3) } as never);

    await get().expect(200);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];

    // 101 AS A LITERAL, which pins BOTH halves of the arithmetic: the page size
    // and the `+ 1` probe row. Without the probe, a full page and the exact end
    // of history are the same response and `has_more` can only be guessed from
    // `rows.length === 100` - wrong for the caller with exactly 100 bookings,
    // and wrong in the direction that invents rows that do not exist.
    expect(params).toEqual([CALLER_ID, 101, null, null]);

    // The bound is in SQL rather than in a JS slice. A `slice` alone still
    // reads every row the caller has ever booked out of the database, which is
    // the thing #66 is about.
    expect(sql).toContain('LIMIT $2');
    expect(sql).toContain('WHERE b.user_id = $1');
  });

  it('orders by the id tiebreak and compares against it, so a page boundary cannot drop a row', async () => {
    mockQuery.mockResolvedValue({ rows: rows(3) } as never);

    await get().expect(200);

    const [sql] = mockQuery.mock.calls[0] as [string];

    // The keyset predicate and the ORDER BY have to agree EXACTLY. An order
    // that does not match the comparison is not pagination, it is a lottery.
    // `created_at` is not unique - two bookings written by one request share it
    // to the microsecond - so without `b.id` a boundary landing between two
    // equal timestamps drops one for ever and nothing reports it.
    //
    // ASSERTED AS TEXT HERE AND EXERCISED FOR REAL NEXT DOOR: the tiebreak's
    // effect is only observable against a real database, so
    // bookings-all-keyset-postgres.test.ts seeds two bookings sharing a
    // `created_at` across a page boundary. This arm exists because a mocked
    // pool can still see the statement drift.
    expect(sql).toContain('(b.created_at, b.id) < ($3::timestamptz, $4::uuid)');
    expect(sql).toContain('ORDER BY b.created_at DESC, b.id DESC');
  });

  it('reports has_more with a cursor when the probe row comes back', async () => {
    // 101 rows: a full page plus the probe.
    mockQuery.mockResolvedValue({ rows: rows(101) } as never);

    const res = await get().expect(200);

    expect(res.body.has_more).toBe(true);
    // The probe row is SLICED OFF and never reaches the caller.
    expect(res.body.bookings).toHaveLength(100);
    expect(res.body.bookings.map((b: { id: string }) => b.id)).not.toContain('booking-100');

    // Built from the last returned row's `cursor_at` - the microsecond-accurate
    // rendering out of SQL - and not from `created_at`, which has been through
    // a JavaScript `Date` and lost three digits. A cursor rebuilt from the
    // millisecond value skips every row in the gap, which is the exact defect
    // keyset paging is chosen to avoid.
    const last = row(99);
    expect(res.body.next_before).toBe(`${last.cursor_at},${last.id}`);
  });

  it('reports has_more false and no cursor on a short page', async () => {
    // THE CONTROL for the arm above, and it is not optional: a route answering
    // a hardcoded `has_more: true` with a hardcoded cursor satisfies every
    // assertion there, and a `has_more` that is always true is as useless as
    // one that is always absent.
    mockQuery.mockResolvedValue({ rows: rows(3) } as never);

    const res = await get().expect(200);

    expect(res.body.has_more).toBe(false);
    expect(res.body.bookings).toHaveLength(3);

    // `has_more === false` and a non-null `next_before` cannot disagree. A
    // cursor at the end of history invites a request that can only come back
    // empty, and a client looping until `next_before` is null never stops.
    expect(res.body.next_before).toBeNull();
  });

  it('answers with a page object rather than a bare array of bookings', async () => {
    mockQuery.mockResolvedValue({ rows: rows(2) } as never);

    const res = await get().expect(200);

    // THE WIRE SHAPE, which is the breaking half of this change and was taken
    // knowingly. `res.json(page.map(...))` is a one-word mutation that puts a
    // silently truncated array straight back on the wire while every arithmetic
    // assertion above still passes.
    expect(Array.isArray(res.body)).toBe(false);
    expect(Object.keys(res.body).sort()).toEqual(['bookings', 'has_more', 'next_before', 'user_id']);

    // `total_bookings` IS GONE. It was `rows.length`, so on a paged route it
    // would be the length of THIS page under a name that says "total" - the
    // same lie as a silently clipped array, with a number attached. The list
    // above is exhaustive, so re-adding it fails here.
    expect(res.body.total_bookings).toBeUndefined();

    // `cursor_at` is a rendering of a column the caller already has, so it is
    // not on the wire either: the cursor has exactly one representation,
    // `next_before`.
    expect(JSON.stringify(res.body)).not.toContain('cursor_at');
  });

  it('refuses an unreadable before cursor rather than putting it into SQL', async () => {
    const res = await get('?before=yesterday').expect(400);

    // Refused at the boundary, not at the database, where an unparseable
    // timestamp reaching `::timestamptz` is SQLSTATE 22007 - a 500 with the
    // cause only in the log. And NOT treated as absent: that would answer a
    // malformed cursor with a silent jump back to the top of history, which is
    // a wrong answer wearing a 200.
    expect(res.body.error).toContain('before must be a cursor');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses a repeated before parameter instead of picking one of them', async () => {
    // `?before=a&before=b` arrives as an ARRAY. Coercing it - `String([a, b])`
    // is `'a,b'` - answers a question nobody asked, which this repository has
    // already settled twice, on `parseLimit` and on `GET /api/opportunities`.
    await get('?before=2026-01-01T09:00:00Z,11111111-1111-1111-1111-111111111111&before=2026-01-02T09:00:00Z,22222222-2222-2222-2222-222222222222')
      .expect(400);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('puts a valid before cursor into the keyset comparison as two bound parameters', async () => {
    mockQuery.mockResolvedValue({ rows: rows(1) } as never);

    const at = '2026-01-01T09:41:07.481923Z';
    const id = '1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f';
    await get(`?before=${at},${id}`).expect(200);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];

    // THE CONTROL for the `[..., null, null]` assertion further up: without
    // this arm, a route that ignored `?before=` entirely and always bound two
    // nulls would pass every other assertion in this file. The microseconds
    // survive the round trip - `.481923`, not `.481` - which is the whole
    // reason the cursor is rendered in SQL.
    expect(params).toEqual([CALLER_ID, 101, at, id]);
  });

  it('still requires authentication', async () => {
    const anon = express();
    anon.use('/api/bookings', bookingsRouter);
    anon.use(errorHandler);

    await request(listening(anon)).get('/api/bookings/my/bookings/all').expect(401);

    expect(mockQuery).not.toHaveBeenCalled();
  });
});
