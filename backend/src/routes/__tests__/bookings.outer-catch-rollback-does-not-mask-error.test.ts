import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// Same auth double the other route suites use (see middleware/__mocks__/authenticate.ts):
// the real gates re-read the DB role, which a session-injecting positional mock cannot
// satisfy. `withLiveRole` (on the cancel route) resolves to the same double.
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

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * A FAILING `ROLLBACK` MUST NOT REPLACE THE ERROR THAT SENT CONTROL INTO THE
 * OUTER CATCH - the five bookings.ts handlers the #67 sweep (sessions.ts,
 * opportunities.ts) and !390 (reschedule) did not reach. cto/AdaptaLabs#123.
 *
 * Each handler runs a transaction and, in its outer `catch (error)`, rolls the
 * transaction back before mapping/rethrowing. When the connection has already
 * died, that ROLLBACK throws too; unguarded, THAT connection error propagates
 * in place of the real one, so the caller's retryable status degrades to an
 * opaque 500 and the true cause never reaches the logs. The fix is
 * `.catch(() => {})` on the outer-catch ROLLBACK, matching sessions.ts and the
 * reschedule site (bookings.ts:1017); it is a no-op while the connection lives.
 *
 * THE REPRESENTATIVE ERROR is SQLSTATE 55P03 (lock not available). It is the
 * exact class book and reschedule raise on their `FOR UPDATE NOWAIT` locks and
 * map to a retryable 409, and it stands in here for any real database failure
 * that reaches the outer catch: `errorHandler`/`mapDatabaseError` turns a bare
 * 55P03 into a 409 ConflictError, so the two arms differ by STATUS - a 409 that
 * survives the guard against a 500 that quotes the masking connection error.
 * The guard's contract is error-agnostic; 55P03 is the concrete instance whose
 * mapping the failing ROLLBACK erases.
 *
 * BOTH ARMS ARE PAIRED per site. "the response is still a 409" passes just as
 * well against a handler that stopped rolling back at all, so the
 * healthy-connection control also asserts the ROLLBACK was genuinely issued,
 * that no COMMIT slipped through, and that the client was released.
 *
 * The in-transaction VALIDATION-path ROLLBACKs in these same handlers (e.g.
 * `ROLLBACK; throw new NotFoundError(...)` on a refusal) are deliberately left
 * bare per #67's negative control: a ROLLBACK that was never on a caught-error
 * path should surface if it throws. Only the outer `catch (error)` ROLLBACKs
 * are guarded, and only those are exercised here.
 */

const CONNECTION_GONE = 'Connection terminated unexpectedly';
const connectionGone = () => new Error(CONNECTION_GONE);

/** What node-postgres reports for SQLSTATE 55P03 (lock not available). */
const lockNotAvailable = () =>
  Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });

type Role = 'employee' | 'researcher_admin' | 'superadmin';
const USER = 'user-1';

const appAs = (role: Role, userId: string = USER) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id: userId, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/**
 * A pooled client that walks a handler's transaction via `respond`, and whose
 * ROLLBACK either works or - the case this file exists for - fails with a
 * dropped connection. `respond` returns rows for the domain SELECTs and THROWS
 * the 55P03 at the transaction's write, i.e. from inside the try, so control
 * reaches the outer catch exactly as a contended statement would in production.
 */
const makeClient = (
  respond: (q: string) => { rows: unknown[]; rowCount: number },
  { rollbackFails }: { rollbackFails: boolean },
) => {
  const statements: string[] = [];
  const query = jest.fn(async (sql: unknown) => {
    const q = String(sql).trim();
    statements.push(q);
    if (/^ROLLBACK/i.test(q)) {
      if (rollbackFails) throw connectionGone();
      return { rows: [], rowCount: 0 };
    }
    if (/^BEGIN/i.test(q) || /^COMMIT/i.test(q)) return { rows: [], rowCount: 0 };
    return respond(q);
  });
  const release = jest.fn();
  return { client: { query, release }, statements, release };
};

const empty = { rows: [] as unknown[], rowCount: 0 };
const pastEnd = new Date(Date.now() - 60 * 60 * 1000);

interface Scenario {
  label: string;
  path: string;
  role: Role;
  userId?: string;
  /** Pre-transaction `pool.query` reads (role gate, booking lookup). */
  arrangePool: () => void;
  /** Domain SELECTs return rows; the transaction's write throws 55P03. */
  respond: (q: string) => { rows: unknown[]; rowCount: number };
}

const scenarios: Scenario[] = [
  {
    // book: 55P03 on the `FOR UPDATE NOWAIT` session lock, mapped to a 409 by
    // the handler itself (bookings.ts:444). No pre-transaction pool read.
    label: 'POST /sessions/:id/book',
    path: '/api/bookings/sessions/s-1/book',
    role: 'employee',
    arrangePool: () => mockQuery.mockResolvedValue(empty as never),
    respond: (q) => {
      if (/FROM sessions s/i.test(q)) throw lockNotAvailable();
      return empty;
    },
  },
  {
    // cancel: participant cancelling their own booking; 55P03 on the conditional
    // `UPDATE bookings`. Rethrown bare, mapped to a 409 by errorHandler.
    label: 'POST /:id/cancel',
    path: '/api/bookings/b1/cancel',
    role: 'employee',
    arrangePool: () =>
      mockQuery.mockImplementation(async (sql: unknown) => {
        if (String(sql).includes('FROM bookings b')) {
          return {
            rows: [{
              id: 'b1', user_id: USER, session_id: 's-1', status: 'booked',
              gcal_event_id: null, opportunity_id: 'opp-1', owner_user_id: 'admin-1',
              opportunity_title: 'A study', owner_name: 'O', owner_email: 'o@example.com',
              participant_name: 'P', participant_email: 'p@example.com',
              start_time: new Date(Date.now() + 60 * 60 * 1000), end_time: new Date(Date.now() + 2 * 60 * 60 * 1000),
            }],
            rowCount: 1,
          };
        }
        return empty;
      }),
    respond: (q) => {
      if (/^UPDATE bookings/i.test(q)) throw lockNotAvailable();
      return empty;
    },
  },
  {
    // complete: 55P03 on the completion `UPDATE bookings`, after the session and
    // existing-completion reads pass. Rethrown bare, mapped to a 409.
    label: 'POST /sessions/:id/complete',
    path: '/api/bookings/sessions/s-1/complete',
    role: 'employee',
    arrangePool: () => mockQuery.mockResolvedValue(empty as never),
    respond: (q) => {
      if (/FROM sessions s/i.test(q)) {
        return { rows: [{ end_time: pastEnd, booking_id: 'b1', booking_status: 'booked' }], rowCount: 1 };
      }
      if (/^UPDATE bookings/i.test(q)) throw lockNotAvailable();
      // The existing-completion SELECT: nothing already submitted.
      return empty;
    },
  },
  {
    // approve: superadmin (owner check bypassed); 55P03 on the approval
    // `UPDATE bookings`, before COMMIT and the post-commit points award.
    label: 'POST /:bookingId/approve',
    path: '/api/bookings/b1/approve',
    role: 'superadmin',
    arrangePool: () =>
      mockQuery.mockResolvedValue({ rows: [{ role: 'superadmin' }], rowCount: 1 } as never),
    respond: (q) => {
      if (/FROM bookings b/i.test(q)) {
        return { rows: [{ id: 'b1', user_id: USER, owner_user_id: 'admin-1', opportunity_type: 'test', opportunity_id: 'opp-1', session_id: 's-1' }], rowCount: 1 };
      }
      if (/^UPDATE bookings/i.test(q)) throw lockNotAvailable();
      return empty;
    },
  },
  {
    // reject: superadmin (owner check bypassed); 55P03 on the rejection
    // `UPDATE bookings`. Rethrown bare, mapped to a 409.
    label: 'POST /:bookingId/reject',
    path: '/api/bookings/b1/reject',
    role: 'superadmin',
    arrangePool: () =>
      mockQuery.mockResolvedValue({ rows: [{ role: 'superadmin' }], rowCount: 1 } as never),
    respond: (q) => {
      if (/FROM bookings b/i.test(q)) {
        return { rows: [{ id: 'b1', user_id: USER, owner_user_id: 'admin-1', opportunity_type: 'test', opportunity_id: 'opp-1', session_id: 's-1' }], rowCount: 1 };
      }
      if (/^UPDATE bookings/i.test(q)) throw lockNotAvailable();
      return empty;
    },
  },
];

describe('a failing ROLLBACK does not mask the real error in the bookings.ts outer catches (#123)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(scenarios)('$label', ({ path, role, userId, arrangePool, respond }) => {
    it('answers 409 from the real lock timeout even when the ROLLBACK also fails', async () => {
      arrangePool();
      const { client } = makeClient(respond, { rollbackFails: true });
      mockConnect.mockResolvedValue(client as never);

      const res = await request(listening(appAs(role, userId))).post(path).send({});

      // THE PROPERTY. Without the guard the dead-connection error replaces the
      // 55P03 and this is a 500 whose body quotes CONNECTION_GONE.
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(JSON.stringify(res.body)).not.toContain(CONNECTION_GONE);
    });

    // THE CONTROL. A handler that never rolled back at all would satisfy the arm
    // above, so prove the ROLLBACK is still issued on a live connection, no
    // COMMIT slipped through, and the client was released - 55P03 still a 409.
    it('still rolls back, still answers 409, and releases, on a healthy connection', async () => {
      arrangePool();
      const { client, statements, release } = makeClient(respond, { rollbackFails: false });
      mockConnect.mockResolvedValue(client as never);

      const res = await request(listening(appAs(role, userId))).post(path).send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(statements.filter((s) => /^ROLLBACK/i.test(s))).toHaveLength(1);
      expect(statements.filter((s) => /^COMMIT/i.test(s))).toHaveLength(0);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });
});
