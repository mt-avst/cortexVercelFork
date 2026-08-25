import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import { expectScopedBy, whereClauseOf, executableSql } from '../../__tests__/helpers/sql-scope';
import express from 'express';

// #14/#37: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gates now re-read the DB role, which their positional pool mock cannot satisfy.
// Liveness for these two routes is pinned in bookings.inline-admin-gates-read-live-role.test.ts.
jest.mock('../../middleware/authenticate');
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
    getBookingCancellationTemplate: jest.fn(),
    getAdminNotificationTemplate: jest.fn(),
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
 * CANCELLING ONE BOOKING WRITES TWO ROWS, AND NOTHING ASKED WHICH.
 *
 * `POST /api/bookings/:id/cancel` marks the booking cancelled and decrements
 * its session's `booked_count`. Existing tests match that both statements
 * EXIST - `sql.includes('UPDATE bookings')`, `sql.includes('booked_count')` -
 * and one of them has a presence arm proving the fixture produces exactly one
 * of each. None of them asks what row either statement hits.
 *
 * Measured on `bedc2fe`, each of these passed the WHOLE backend suite, 1007 of
 * 1007, typecheck clean and tree clean before and after:
 *
 *   UPDATE bookings SET status='cancelled' ... WHERE id = $1
 *     -> WHERE session_id = $1     cancels by the wrong key entirely
 *   UPDATE sessions SET booked_count = GREATEST(booked_count - 1, 0) WHERE id = $1
 *     -> WHERE opportunity_id = $1  decrements EVERY session of that opportunity
 *   GREATEST(booked_count - 1, 0)
 *     -> booked_count - 1           loses the floor, so the count goes negative
 *
 * The decrement's row scope is the sharpest of the three: `booking.session_id`
 * bound against `opportunity_id` decrements every session under that
 * opportunity, so cancelling one person's slot frees phantom capacity on every
 * other session in the study. `booked_count` is what the participant-facing
 * "N places left" is computed from.
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
const SESSION = 's-77';
const PATH = `/api/bookings/${BOOKING}/cancel`;

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

/**
 * The transaction client. Deliberately a fresh object per test so the recorded
 * calls belong to one request only.
 */
const makeClient = () => ({
  query: jest.fn(async (sql: unknown) => {
    // The cancel UPDATE reads the current session_id back via RETURNING and
    // decrements THAT session (cto/AdaptaLabs#31), so the mock has to yield it.
    if (String(sql).toUpperCase().includes('UPDATE BOOKINGS')) {
      return { rows: [{ session_id: SESSION }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }),
  release: jest.fn(),
});

/**
 * `SESSION` is deliberately NOT equal to `BOOKING`. If the two ids were the
 * same string, swapping `WHERE id` for `WHERE session_id` would bind the same
 * value and the mutation would be invisible - the fixture would be hiding the
 * defect rather than exposing it.
 */
const arrange = () => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes('FROM bookings b')) {
      return {
        rows: [{
          id: BOOKING,
          user_id: PARTICIPANT.id,
          session_id: SESSION,
          status: 'booked',
          gcal_event_id: null,
          opportunity_id: 'opp-1',
          owner_user_id: OWNER.id,
          opportunity_title: 'A study',
          owner_name: OWNER.name,
          owner_email: OWNER.email,
          participant_name: PARTICIPANT.name,
          participant_email: PARTICIPANT.email,
          start_time: FUTURE_START,
          end_time: FUTURE_END,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
};

type Call = { sql: string; params: readonly unknown[] };

const clientCalls = (client: { query: jest.Mock }, fragment: string): Call[] =>
  client.query.mock.calls
    .map((call: unknown[]) => ({ sql: String(call[0]), params: (call[1] ?? []) as unknown[] }))
    .filter((c: Call) => executableSql(c.sql).toUpperCase().includes(fragment.toUpperCase()));

describe('POST /api/bookings/:id/cancel writes only the rows it should', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockSendEmail.mockResolvedValue({ success: true } as never);
    (EmailService.getBookingCancellationTemplate as unknown as jest.Mock)
      .mockReturnValue({ subject: 'c', html: '', text: '' });
    (EmailService.getAdminNotificationTemplate as unknown as jest.Mock)
      .mockReturnValue({ subject: 'a', html: '', text: '' });
    client = makeClient();
    mockConnect.mockResolvedValue(client as never);
    arrange();
  });

  it('cancels the booking by its own id, not by any other key', async () => {
    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    const updates = clientCalls(client, 'UPDATE bookings');
    // THE CONTROL. Without it every assertion below passes on a handler that
    // wrote nothing at all.
    expect(updates).toHaveLength(1);

    expectScopedBy(updates[0].sql, updates[0].params, 'id', BOOKING);
  });

  it('decrements the booked session, not every session of the opportunity', async () => {
    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    const decrements = clientCalls(client, 'booked_count');
    expect(decrements).toHaveLength(1);

    // Bound to `booking.session_id`, which the fixture makes distinct from the
    // booking id on purpose.
    expectScopedBy(decrements[0].sql, decrements[0].params, 'id', SESSION);
    // And the scope must be the SESSION row. `WHERE opportunity_id = $1` would
    // free phantom capacity on every other session in the study.
    expect(whereClauseOf(decrements[0].sql)).not.toMatch(/opportunity_id/i);
  });

  it('keeps the floor on the decrement, so a count cannot go negative', async () => {
    // Not a scope assertion, but the same class of silent corruption: without
    // GREATEST, a double-cancel drives `booked_count` below zero and the
    // participant-facing "N places left" is computed from it.
    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    const [decrement] = clientCalls(client, 'booked_count');
    expect(executableSql(decrement.sql)).toContain('GREATEST(booked_count - 1, 0)');
  });

  it('writes nothing outside those two statements', async () => {
    // The bound on blast radius. Any future write added to this transaction has
    // to be considered here rather than slipping in unnoticed.
    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    const writes = client.query.mock.calls
      .map((call: unknown[]) => executableSql(String(call[0])))
      .filter((sql: string) => /^(UPDATE|DELETE|INSERT)\b/i.test(sql));

    expect(writes).toHaveLength(2);
    // Every one of them restricted - a write with no WHERE at all is the
    // failure this file exists to make impossible.
    for (const sql of writes) {
      expect(whereClauseOf(sql) ?? `<no WHERE: ${sql}>`).toContain('=');
    }
  });

  it('binds the booking from the route rather than a constant', async () => {
    // A statement can name the right column and bind the wrong value. Driving a
    // different id proves the binding follows the request.
    await request(listening(appAs('researcher_admin', OWNER)))
      .post('/api/bookings/b-other/cancel')
      .expect(200);

    const [update] = clientCalls(client, 'UPDATE bookings');
    expectScopedBy(update.sql, update.params, 'id', 'b-other');
  });

  it('pins the transition guard on the cancel UPDATE', async () => {
    // Removing `AND status = 'booked'` restores the double-decrement race: two
    // concurrent cancels of one booking both match the row and both decrement,
    // so a single cancellation subtracts two from booked_count.
    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    const [update] = clientCalls(client, 'UPDATE bookings');
    expect(whereClauseOf(update.sql) ?? `<no WHERE: ${update.sql}>`).toMatch(/status\s*=\s*'booked'/i);
  });

  it('gates the decrement on the real transition: a racing double-cancel neither decrements nor re-notifies', async () => {
    // The pre-transaction status read is a fast path, not the guard. When a
    // concurrent request has already flipped the row, the conditional UPDATE
    // matches zero rows (rowCount 0); the handler must then skip the decrement
    // and the emails rather than firing a second set.
    (client.query as unknown as jest.Mock).mockImplementation(async (sql: unknown) => {
      if (String(sql).toUpperCase().includes('UPDATE BOOKINGS')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    // Nothing transitioned, so nothing is decremented.
    expect(clientCalls(client, 'booked_count')).toHaveLength(0);
    // The transaction the handler opened is still committed, not left dangling.
    const sql = client.query.mock.calls.map((c: unknown[]) => String(c[0]).trim());
    expect(sql).toContain('COMMIT');
    // The request that won the race sent the notices; the loser sends none.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('decrements the session read back from the locked cancel UPDATE, not the pre-transaction read - cto/AdaptaLabs#31', async () => {
    // The stale-session race: the pre-transaction read sees the booking on
    // S_OLD, but a reschedule commits in the window before the transaction, so
    // the conditional UPDATE - which holds the booking's row lock - re-reads a
    // row now on S_NEW. The decrement must land on S_NEW (RETURNING), not on the
    // S_OLD captured before any lock was held. Binding it to booking.session_id
    // double-counts S_OLD and leaves S_NEW with a phantom slot.
    const S_OLD = 's-old';
    const S_NEW = 's-new';

    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM bookings b')) {
        return {
          rows: [{
            id: BOOKING, user_id: PARTICIPANT.id, session_id: S_OLD, status: 'booked',
            gcal_event_id: null, opportunity_id: 'opp-1', owner_user_id: OWNER.id,
            opportunity_title: 'A study', owner_name: OWNER.name, owner_email: OWNER.email,
            participant_name: PARTICIPANT.name, participant_email: PARTICIPANT.email,
            start_time: FUTURE_START, end_time: FUTURE_END,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    (client.query as unknown as jest.Mock).mockImplementation(async (sql: unknown) => {
      if (String(sql).toUpperCase().includes('UPDATE BOOKINGS')) {
        return { rows: [{ session_id: S_NEW }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    const [decrement] = clientCalls(client, 'booked_count');
    // Bound to the RETURNING value (S_NEW), never the pre-transaction S_OLD.
    expectScopedBy(decrement.sql, decrement.params, 'id', S_NEW);
    expect(decrement.params).not.toContain(S_OLD);
  });

  it('refuses an admin who owns nothing, and writes nothing', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM bookings b')) {
        return {
          rows: [{
            id: BOOKING, user_id: PARTICIPANT.id, session_id: SESSION, status: 'booked',
            gcal_event_id: null, opportunity_id: 'opp-1', owner_user_id: 'somebody-else',
            opportunity_title: 'A study', owner_name: 'X', owner_email: 'x@example.com',
            participant_name: PARTICIPANT.name, participant_email: PARTICIPANT.email,
            start_time: FUTURE_START, end_time: FUTURE_END,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(403);

    expect(mockConnect).not.toHaveBeenCalled();
  });
});
