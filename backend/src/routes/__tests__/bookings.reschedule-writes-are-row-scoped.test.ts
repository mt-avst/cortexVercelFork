import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import { expectScopedBy, whereClauseOf, executableSql } from '../../__tests__/helpers/sql-scope';
import express from 'express';

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

jest.mock('../../services/email', () => ({
  __esModule: true,
  default: { sendEmail: jest.fn() },
  EmailService: {
    getBookingConfirmationTemplate: jest.fn(),
  },
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';
import emailService, { EmailService } from '../../services/email';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;
const mockSendEmail = emailService.sendEmail as unknown as jest.Mock;

/**
 * RESCHEDULING ONE BOOKING WRITES THREE ROWS, AND NOTHING ASKED WHICH.
 *
 * `POST /api/bookings/:id/reschedule` moves the booking to a target session,
 * decrements the OLD session's `booked_count` and increments the TARGET's.
 * !227 pinned the CANCEL path's writes so a statement's scope is asserted, not
 * merely its existence. The reschedule handler carries the same shapes and none
 * was covered - raised as #27, fixed here.
 *
 * Measured by the merge gate on !227 against `claude/bound-param-assertions`,
 * each of these survived the WHOLE backend suite (59 suites / 1048 tests, exit
 * 0), typecheck clean, tree clean before and after:
 *
 *   UPDATE bookings SET session_id = $1 WHERE id = $2
 *     -> WHERE session_id = $2      moves EVERY booking on that session
 *   the decrement's WHERE id = $1
 *     -> WHERE opportunity_id = $1  decrements every session of the opportunity
 *   GREATEST(booked_count - 1, 0)
 *     -> booked_count - 1           loses the floor, so the count goes negative
 *
 * The increment's scope is pinned here too, on the same reasoning: bound to the
 * wrong key it over-increments some other session and the participant-facing
 * "N places left" is computed from `booked_count`.
 *
 * WHY THE DECREMENT NEEDS ITS OWN COVERAGE THOUGH IT IS BYTE-IDENTICAL TO
 * CANCEL'S. Nothing about pinning the cancel site constrains this one, and a
 * reader who sees the cancel entry may reasonably assume the shape is covered.
 * The canary anchors carry each handler's own preceding comment so a shorter
 * anchor cannot match both sites.
 *
 * WHY ASSERTING THE PARAMS ARRAY WOULD NOT HAVE HELPED: a bound parameter stays
 * bound whether the SQL uses it or not, and `pool` is mocked, so nothing raises
 * on an unused one. The assertions below tie the column, the `$n` placeholder
 * and the bound value together - see `__tests__/helpers/sql-scope.ts`.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const PARTICIPANT = { id: 'participant-1', name: 'Pat', email: 'pat@example.com' };
const OWNER = { id: 'admin-1', name: 'Olive', email: 'olive@example.com' };
const BOOKING = 'b1';
/**
 * Three ids, all distinct from each other and from the booking id, on purpose.
 * If any two were equal, a mutation that swapped their WHERE keys would bind the
 * same value and become invisible - the fixture would hide the defect it exists
 * to expose.
 */
const OLD_SESSION = 's-old';
const TARGET_SESSION = 's-target';
const PATH = `/api/bookings/${BOOKING}/reschedule`;

const FUTURE_START = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const FUTURE_END = new Date(FUTURE_START.getTime() + 60 * 60 * 1000);

const appAs = (role: Role, user: { id: string; name: string; email: string }) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { user: { ...user, role } };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/** A fresh transaction client per test, so recorded calls belong to one request. */
const makeClient = () => ({ query: jest.fn() as jest.Mock, release: jest.fn() });

/**
 * The booking row the handler loads (keyed on b.id + b.user_id + status booked),
 * and the target session it moves to. `booked_count < capacity` and a future
 * `end_time` so every guardrail passes and the three writes are reached.
 */
const bookingRow = (userId = PARTICIPANT.id) => ({
  id: BOOKING,
  user_id: userId,
  session_id: OLD_SESSION,
  status: 'booked',
  gcal_event_id: null,
  current_opportunity_id: 'opp-1',
  opportunity_title: 'A study',
});

const targetSessionRow = () => ({
  id: TARGET_SESSION,
  opportunity_id: 'opp-1',
  opportunity_status: 'published',
  opportunity_title: 'A study',
  purpose_one_liner: 'why',
  owner_user_id: OWNER.id,
  booked_count: 0,
  capacity: 5,
  start_time: FUTURE_START,
  end_time: FUTURE_END,
});

const arrange = (booking: ReturnType<typeof bookingRow> | null = bookingRow()) => {
  const client = makeClient();
  client.query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes('FROM bookings b')) return { rows: booking ? [booking] : [], rowCount: booking ? 1 : 0 };
    if (s.includes('FROM sessions s')) return { rows: [targetSessionRow()], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  mockConnect.mockResolvedValue(client as never);
  // Post-commit owner lookup goes through `pool.query`, not the tx client.
  mockQuery.mockResolvedValue({ rows: [{ name: OWNER.name, email: OWNER.email }], rowCount: 1 } as never);
  return client;
};

type Call = { sql: string; params: readonly unknown[] };

const clientCalls = (client: { query: jest.Mock }, fragment: string): Call[] =>
  client.query.mock.calls
    .map((call: unknown[]) => ({ sql: String(call[0]), params: (call[1] ?? []) as unknown[] }))
    .filter((c: Call) => executableSql(c.sql).toUpperCase().includes(fragment.toUpperCase()));

/** The two `booked_count` writes, told apart by the arithmetic each carries. */
const decrementOf = (client: { query: jest.Mock }): Call =>
  clientCalls(client, 'booked_count').find((c) => executableSql(c.sql).includes('GREATEST')) as Call;
const incrementOf = (client: { query: jest.Mock }): Call =>
  clientCalls(client, 'booked_count').find((c) => executableSql(c.sql).includes('booked_count + 1')) as Call;

const reschedule = (app: express.Express, path = PATH) =>
  request(listening(app)).post(path).send({ target_session_id: TARGET_SESSION });

describe('POST /api/bookings/:id/reschedule writes only the rows it should', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockSendEmail.mockResolvedValue({ success: true } as never);
    (EmailService.getBookingConfirmationTemplate as unknown as jest.Mock)
      .mockReturnValue({ subject: 'c', html: '', text: '' });
    client = arrange();
  });

  it('moves the booking by its own id, not by any other key', async () => {
    await reschedule(appAs('employee', PARTICIPANT)).expect(200);

    const updates = clientCalls(client, 'UPDATE bookings');
    // THE CONTROL for this statement: without it every assertion below passes on
    // a handler that wrote no booking move at all.
    expect(updates).toHaveLength(1);

    expectScopedBy(updates[0].sql, updates[0].params, 'id', BOOKING);
    // `WHERE session_id = $2` would move every booking on the old session.
    expect(whereClauseOf(updates[0].sql)).not.toMatch(/session_id/i);
  });

  it('decrements the OLD session, not every session of the opportunity', async () => {
    await reschedule(appAs('employee', PARTICIPANT)).expect(200);

    const decrement = decrementOf(client);
    expect(decrement).toBeDefined();
    // Bound to the old `booking.session_id`, distinct from booking id and target.
    expectScopedBy(decrement.sql, decrement.params, 'id', OLD_SESSION);
    // `WHERE opportunity_id = $1` would free phantom capacity on every session.
    expect(whereClauseOf(decrement.sql)).not.toMatch(/opportunity_id/i);
  });

  it('increments the TARGET session by its own id', async () => {
    await reschedule(appAs('employee', PARTICIPANT)).expect(200);

    const increment = incrementOf(client);
    expect(increment).toBeDefined();
    expectScopedBy(increment.sql, increment.params, 'id', TARGET_SESSION);
    expect(whereClauseOf(increment.sql)).not.toMatch(/opportunity_id/i);
  });

  it('keeps the floor on the decrement, so a count cannot go negative', async () => {
    // Not a scope assertion, but the same class of silent corruption: without
    // GREATEST a race drives `booked_count` below zero and the participant-facing
    // "N places left" is computed from it.
    await reschedule(appAs('employee', PARTICIPANT)).expect(200);

    expect(executableSql(decrementOf(client).sql)).toContain('GREATEST(booked_count - 1, 0)');
  });

  it('writes nothing outside those three statements', async () => {
    // The bound on blast radius. Any future write added to this transaction has
    // to be considered here rather than slipping in unnoticed. This is also the
    // control arm that proves the fixture produces all three writes.
    await reschedule(appAs('employee', PARTICIPANT)).expect(200);

    const writes = client.query.mock.calls
      .map((call: unknown[]) => executableSql(String(call[0])))
      .filter((sql: string) => /^(UPDATE|DELETE|INSERT)\b/i.test(sql));

    expect(writes).toHaveLength(3);
    // Every one restricted - a write with no WHERE at all is the failure this
    // file exists to make impossible.
    for (const sql of writes) {
      expect(whereClauseOf(sql) ?? `<no WHERE: ${sql}>`).toContain('=');
    }
  });

  it('binds the booking and target from the request rather than constants', async () => {
    // A statement can name the right column and bind the wrong value. Driving a
    // different booking id proves the move follows the request.
    await reschedule(appAs('employee', PARTICIPANT), '/api/bookings/b-other/reschedule').expect(200);

    const [update] = clientCalls(client, 'UPDATE bookings');
    expectScopedBy(update.sql, update.params, 'id', 'b-other');
    // The new session_id bound at $1 is the target from the body.
    expect(update.params[0]).toBe(TARGET_SESSION);
  });

  it('locks the old session NOWAIT, so a reschedule never waits on a session lock', async () => {
    // The target lock above is already NOWAIT; making the old-session lock NOWAIT
    // too means a reschedule never holds one session lock while WAITING on
    // another, which keeps it out of a deadlock cycle with the multi-row lockers
    // (the sync-booked-counts sweep and delete-sessions). cto/AdaptaLabs#34.
    await reschedule(appAs('employee', PARTICIPANT)).expect(200);

    // The plain current-session lock, told apart from the target lock (which
    // reads `FROM sessions s` with a join) by its bare `FROM sessions WHERE id`.
    const oldLock = clientCalls(client, 'FROM sessions WHERE id');
    expect(oldLock).toHaveLength(1);
    expect(executableSql(oldLock[0].sql).toUpperCase()).toContain('FOR UPDATE NOWAIT');
    expectScopedBy(oldLock[0].sql, oldLock[0].params, 'id', OLD_SESSION);
  });

  it('writes nothing when the booking is not the caller\'s to reschedule', async () => {
    // The handler scopes the load by `b.user_id = $2`, so someone else's booking
    // comes back empty. It must then write nothing and roll back, not fall
    // through to the moves.
    client = arrange(null);

    await reschedule(appAs('employee', PARTICIPANT)).expect(404);

    const writes = client.query.mock.calls
      .map((call: unknown[]) => executableSql(String(call[0])))
      .filter((sql: string) => /^(UPDATE|DELETE|INSERT)\b/i.test(sql));
    expect(writes).toHaveLength(0);
  });
});
