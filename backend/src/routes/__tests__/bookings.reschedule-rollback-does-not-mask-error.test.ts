import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// Same auth double the other route suites use (see middleware/__mocks__/authenticate.ts):
// the real gate re-reads the DB role, which a session-injecting positional mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * POST /api/:id/reschedule: A FAILING `ROLLBACK` MUST NOT REPLACE THE ERROR THAT
 * CAUSED IT. The sibling of #67, one handler the original sweep (sessions.ts,
 * opportunities.ts) did not reach - found by the code-reviewer gate on the #116
 * session-delete lock_timeout change, bookings.ts:1012.
 *
 * The reschedule transaction locks the old session with `FOR UPDATE NOWAIT`
 * specifically so a contended row fails fast as SQLSTATE 55P03, which the
 * handler maps to a retryable 409 ConflictError. That mapping is the whole point
 * of the NOWAIT: a participant who hits a racing sweep should be told "try
 * again", not handed a 500. A dropped connection is one of the very failures the
 * transaction exists to survive - and when the socket has gone, the ROLLBACK in
 * the outer catch throws too. Unguarded, THAT error propagates, so the 55P03 is
 * gone and the caller gets an opaque 500 instead of the retryable 409. The fix
 * is `.catch(() => {})` on the ROLLBACK; it changes nothing while the connection
 * is alive.
 *
 * This handler has no outer flattening catch, so the original error reaches
 * `errorHandler` and the RESPONSE tells the two cases apart: a mapped 409 from
 * the 55P03, against a 500 whose body quotes the masking connection error.
 *
 * BOTH ARMS ARE PAIRED. "the response is still a 409" passes just as well
 * against a handler that stopped rolling back at all, so the healthy-connection
 * control also asserts the ROLLBACK was genuinely issued and no COMMIT was.
 */

const CONNECTION_GONE = 'Connection terminated unexpectedly';
const connectionGone = () => new Error(CONNECTION_GONE);

/** What node-postgres reports when `FOR UPDATE NOWAIT` cannot take the lock. */
const lockNotAvailable = () =>
  Object.assign(new Error('could not obtain lock on row in relation "sessions"'), {
    code: '55P03',
  });

const USER = 'user-1';

const appWithSession = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id: USER, name: 'A', email: 'a@example.com', role: 'employee' },
    };
    next();
  });
  app.use('/api', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/** The booking the handler loads and locks first. */
const bookingRow = () => ({
  id: 'b1',
  session_id: 's-old',
  user_id: USER,
  status: 'booked',
  current_opportunity_id: 'opp-1',
  opportunity_title: 'An opportunity',
});

/** The target session: same opportunity, published, future, with room. */
const targetSessionRow = () => ({
  id: 's-new',
  opportunity_id: 'opp-1',
  opportunity_status: 'published',
  opportunity_title: 'An opportunity',
  purpose_one_liner: 'why',
  owner_user_id: 'admin-1',
  start_time: new Date('2030-01-01T10:00:00Z'),
  end_time: new Date('2030-01-01T11:00:00Z'),
  booked_count: 0,
  capacity: 5,
});

/** Statements the transaction issued, in order. */
let statements: string[];

/**
 * A pooled client that walks the reschedule transaction as far as the old-session
 * `FOR UPDATE NOWAIT` lock, where it raises 55P03, and whose ROLLBACK either
 * works or - the case this file exists for - fails with a dropped connection.
 */
const clientReachingLockThenFailing = ({ rollbackFails }: { rollbackFails: boolean }) => {
  statements = [];
  const query = jest.fn(async (sql: unknown) => {
    const q = String(sql).trim();
    statements.push(q);

    if (/^ROLLBACK/i.test(q)) {
      if (rollbackFails) throw connectionGone();
      return { rows: [], rowCount: 0 };
    }
    if (/^BEGIN/i.test(q)) return { rows: [], rowCount: 0 };

    // The first SELECT: booking row, locked FOR UPDATE OF b.
    if (/FROM bookings b/i.test(q)) {
      return { rows: [bookingRow()], rowCount: 1 };
    }
    // The target-session SELECT (aliased `SELECT s.*, o.status as opportunity_status ...`).
    if (/opportunity_status/i.test(q)) {
      return { rows: [targetSessionRow()], rowCount: 1 };
    }
    // The old-session lock: `SELECT * FROM sessions WHERE id = $1 FOR UPDATE NOWAIT`.
    // This is where a contended reschedule raises 55P03 - the error that must survive.
    if (/SELECT \*\s+FROM sessions\s+WHERE/i.test(q)) {
      throw lockNotAvailable();
    }
    return { rows: [], rowCount: 0 };
  });
  const release = jest.fn();
  mockConnect.mockResolvedValue({ query, release } as never);
  return { release };
};

const matching = (pattern: RegExp) => statements.filter((sql) => pattern.test(sql));

describe('a failing ROLLBACK does not mask the 55P03 in POST /api/:id/reschedule', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers 409 from the real lock timeout even when the ROLLBACK also fails', async () => {
    clientReachingLockThenFailing({ rollbackFails: true });

    const res = await request(listening(appWithSession()))
      .post('/api/b1/reschedule')
      .send({ target_session_id: 's-new' });

    // THE PROPERTY. Before the guard, the dead-connection error replaced the
    // 55P03 and this was a 500 whose body quoted CONNECTION_GONE.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(JSON.stringify(res.body)).not.toContain(CONNECTION_GONE);
  });

  // THE CONTROL. A handler that never rolled back at all would satisfy the arm
  // above, so prove the ROLLBACK is still issued on a live connection and no
  // COMMIT slipped through, with the 55P03 still mapped to a 409.
  it('still rolls back, and still answers 409, on a healthy connection', async () => {
    const { release } = clientReachingLockThenFailing({ rollbackFails: false });

    const res = await request(listening(appWithSession()))
      .post('/api/b1/reschedule')
      .send({ target_session_id: 's-new' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(matching(/^ROLLBACK/i)).toHaveLength(1);
    expect(matching(/^COMMIT/i)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
