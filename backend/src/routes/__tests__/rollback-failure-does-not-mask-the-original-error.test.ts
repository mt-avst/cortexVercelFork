import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

import opportunitiesRouter from '../opportunities';
import sessionsRouter from '../sessions';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';
import { logger } from '../../utils/logger';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * A FAILING `ROLLBACK` MUST NOT REPLACE THE ERROR THAT CAUSED IT. #67.
 *
 * Every one of these four handlers ended its transaction with
 *
 *   } catch (error) { await client.query('ROLLBACK'); throw error; }
 *
 * and a dropped connection is one of the very failures the transaction exists
 * to survive. When the socket has gone, the ROLLBACK throws too - and THAT
 * error is the one that propagates, so the caller and the log both get the
 * symptom instead of the cause. The fix is `.catch(() => {})` on the ROLLBACK,
 * one line per site, and it changes nothing on any path where the connection
 * is alive.
 *
 * Severity is diagnostic, not data: the server aborts the transaction itself
 * when the connection dies, so nothing is half-committed either way. What is
 * lost is the ability to tell WHY.
 *
 * HOW THE TWO OBSERVABLES DIFFER, and why this file uses both.
 *
 *  - `routes/sessions.ts` has no outer catch, so the original error reaches
 *    `errorHandler`, which maps SQLSTATE 23505 to a 409. A masking connection
 *    error carries no SQLSTATE and falls through to a 500. Those arms assert
 *    on the RESPONSE, which is the strongest form available.
 *  - `routes/opportunities.ts` wraps both handlers in an outer catch that
 *    flattens anything which is not an AppError to a flat 500, so the status
 *    code is 500 either way and cannot see this bug. There the surviving
 *    observable is `logger.error`'s payload - which is precisely the "the log
 *    records the symptom rather than the cause" the issue describes. Those
 *    arms assert on the LOGGED error.
 *
 * EVERY ARM IS PAIRED. A healthy-connection control sits beside each
 * failing-ROLLBACK arm, because "the error is still the original one" passes
 * just as well against a handler that stopped rolling back at all - so each
 * control also asserts the ROLLBACK was genuinely issued and no COMMIT was.
 */

/**
 * The error the transaction body hits: a real unique violation as node-postgres
 * reports one. `errorHandler` maps 23505 to ConflictError -> 409.
 */
const originalError = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "sessions_pkey"'), {
    code: '23505',
  });

/**
 * What a dropped socket looks like from node-postgres: a bare Error with NO
 * SQLSTATE, which is why it cannot be mapped and lands as a 500. This is the
 * error that used to win.
 */
const CONNECTION_GONE = 'Connection terminated unexpectedly';
const connectionGone = () => new Error(CONNECTION_GONE);

type Role = 'employee' | 'researcher_admin' | 'superadmin';

const OWNER = 'admin-1';

const appWith = (mount: string, router: express.Router, role: Role, id = OWNER) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use(mount, router);
  app.use(errorHandler);
  return app;
};

/** A row shaped well enough that the handlers' `.toISOString()` calls survive. */
const sessionRow = () => ({
  id: 's1',
  opportunity_id: 'opp-1',
  capacity: 5,
  booked_count: 0,
  remaining: 5,
  start_time: new Date('2030-01-01T10:00:00Z'),
  end_time: new Date('2030-01-01T11:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
});

/** Statements the transaction issued, in order. */
let statements: string[];

/**
 * A pooled client whose transaction body fails at `failOn`, and whose ROLLBACK
 * either works or - the case this file exists for - fails as well.
 */
const clientThatFails = ({
  failOn,
  rollbackFails,
}: {
  failOn: RegExp;
  rollbackFails: boolean;
}) => {
  statements = [];
  const query = jest.fn(async (sql: unknown) => {
    const q = String(sql).trim();
    statements.push(q);

    if (/^ROLLBACK/i.test(q)) {
      if (rollbackFails) throw connectionGone();
      return { rows: [], rowCount: 0 };
    }

    // The transaction body's failure - the error that must survive.
    if (failOn.test(q)) throw originalError();

    // The "does any session still have a live booking?" guard on
    // DELETE /api/opportunities/:id/sessions. Empty means deletion proceeds,
    // so the arms below reach the DELETE rather than the 400 refusal.
    if (/EXISTS \(SELECT 1 FROM bookings/i.test(q)) {
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT id\s+FROM sessions/i.test(q)) {
      return { rows: [{ id: 's1' }], rowCount: 1 };
    }
    return { rows: [sessionRow()], rowCount: 1 };
  });
  const release = jest.fn();
  mockConnect.mockResolvedValue({ query, release } as never);
  return { release };
};

const matching = (pattern: RegExp) => statements.filter((sql) => pattern.test(sql));

/** The pool reads both files do BEFORE opening their transaction. */
const arrangePoolReads = () => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    // Ownership, for both opportunities routes and `checkSessionOwnership`.
    if (text.includes('owner_user_id')) {
      return { rows: [{ owner_user_id: OWNER }], rowCount: 1 };
    }
    if (text.includes('SELECT * FROM sessions')) {
      return { rows: [sessionRow()], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
};

/** The error object `logger.error` was handed under `message`. */
const loggedErrorsFor = (spy: jest.Mock, message: string): unknown[] =>
  spy.mock.calls
    .filter((call: unknown[]) => String(call[0]) === message)
    .map((call: unknown[]) => (call[1] as { error?: unknown } | undefined)?.error);

const messageOf = (error: unknown) => (error as { message?: string } | undefined)?.message;
const codeOf = (error: unknown) => (error as { code?: string } | undefined)?.code;

describe('a failing ROLLBACK does not mask the error that caused it (#67)', () => {
  let logSpy: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    arrangePoolReads();
    logSpy = jest.spyOn(logger, 'error').mockImplementation(() => {}) as unknown as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // routes/opportunities.ts - POST /api/opportunities/:id/sessions
  //
  // The site the issue names. Its outer catch flattens every non-AppError to
  // `500 Failed to create sessions`, so the STATUS cannot see this bug and the
  // log is the observable. That is the damage the issue describes.
  // ------------------------------------------------------------------

  const OPP_SESSIONS = '/api/opportunities/opp-1/sessions';
  const oppApp = (role: Role = 'researcher_admin') =>
    appWith('/api/opportunities', opportunitiesRouter, role);
  const validSession = {
    start_time: '2030-01-01T10:00:00Z',
    end_time: '2030-01-01T11:00:00Z',
    capacity: 5,
  };

  it('POST /api/opportunities/:id/sessions logs the constraint violation, not the dead connection', async () => {
    clientThatFails({ failOn: /INSERT INTO sessions/i, rollbackFails: true });

    await request(listening(oppApp())).post(OPP_SESSIONS).send(validSession).expect(500);

    const logged = loggedErrorsFor(logSpy, 'Error creating sessions');
    // The control for this assertion: the handler did log, once, so the
    // checks below are examining something rather than nothing.
    expect(logged).toHaveLength(1);
    // THE PROPERTY. Before the guard this was the connection error.
    expect(codeOf(logged[0])).toBe('23505');
    expect(messageOf(logged[0])).toContain('duplicate key value');
    expect(messageOf(logged[0])).not.toContain(CONNECTION_GONE);
  });

  // THE CONTROL ARM. A handler that never rolled back at all would satisfy the
  // arm above, so prove the ROLLBACK is still issued on a live connection and
  // the original error still gets through unchanged.
  it('POST /api/opportunities/:id/sessions still rolls back, and still reports the original error, on a healthy connection', async () => {
    const { release } = clientThatFails({ failOn: /INSERT INTO sessions/i, rollbackFails: false });

    await request(listening(oppApp())).post(OPP_SESSIONS).send(validSession).expect(500);

    expect(matching(/^ROLLBACK/i)).toHaveLength(1);
    expect(matching(/^COMMIT/i)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);

    const logged = loggedErrorsFor(logSpy, 'Error creating sessions');
    expect(logged).toHaveLength(1);
    expect(codeOf(logged[0])).toBe('23505');
  });

  // ------------------------------------------------------------------
  // routes/opportunities.ts - DELETE /api/opportunities/:id/sessions
  // ------------------------------------------------------------------

  it('DELETE /api/opportunities/:id/sessions logs the constraint violation, not the dead connection', async () => {
    clientThatFails({ failOn: /DELETE FROM sessions/i, rollbackFails: true });

    await request(listening(oppApp())).delete(OPP_SESSIONS).expect(500);

    const logged = loggedErrorsFor(logSpy, 'Error deleting sessions');
    expect(logged).toHaveLength(1);
    expect(codeOf(logged[0])).toBe('23505');
    expect(messageOf(logged[0])).not.toContain(CONNECTION_GONE);
  });

  it('DELETE /api/opportunities/:id/sessions still rolls back, and still reports the original error, on a healthy connection', async () => {
    const { release } = clientThatFails({ failOn: /DELETE FROM sessions/i, rollbackFails: false });

    await request(listening(oppApp())).delete(OPP_SESSIONS).expect(500);

    expect(matching(/^ROLLBACK/i)).toHaveLength(1);
    expect(matching(/^COMMIT/i)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);

    const logged = loggedErrorsFor(logSpy, 'Error deleting sessions');
    expect(logged).toHaveLength(1);
    expect(codeOf(logged[0])).toBe('23505');
  });

  // ------------------------------------------------------------------
  // routes/sessions.ts - PATCH /api/sessions/:id
  //
  // No outer catch here, so the original error reaches `errorHandler` and the
  // RESPONSE tells the two cases apart: 409 from the mapped 23505, against a
  // 500 whose body literally quotes the masking connection error.
  // ------------------------------------------------------------------

  const sessApp = (role: Role = 'researcher_admin') =>
    appWith('/api/sessions', sessionsRouter, role);

  it('PATCH /api/sessions/:id answers 409 from the real constraint violation when the ROLLBACK also fails', async () => {
    clientThatFails({ failOn: /^UPDATE sessions/i, rollbackFails: true });

    // `capacity` only, so the in-transaction overlap check does not run and
    // the UPDATE is genuinely reached.
    const res = await request(listening(sessApp())).patch('/api/sessions/s1').send({ capacity: 7 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(JSON.stringify(res.body)).not.toContain(CONNECTION_GONE);
  });

  it('PATCH /api/sessions/:id still rolls back, and still answers 409, on a healthy connection', async () => {
    const { release } = clientThatFails({ failOn: /^UPDATE sessions/i, rollbackFails: false });

    const res = await request(listening(sessApp())).patch('/api/sessions/s1').send({ capacity: 7 });

    expect(res.status).toBe(409);
    expect(matching(/^ROLLBACK/i)).toHaveLength(1);
    expect(matching(/^COMMIT/i)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // routes/sessions.ts - POST /api/sessions/sync-booked-counts
  // ------------------------------------------------------------------

  const SYNC = '/api/sessions/sync-booked-counts';

  it('POST /api/sessions/sync-booked-counts answers 409 from the real constraint violation when the ROLLBACK also fails', async () => {
    clientThatFails({ failOn: /^UPDATE sessions/i, rollbackFails: true });

    const res = await request(listening(sessApp('superadmin'))).post(SYNC);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(JSON.stringify(res.body)).not.toContain(CONNECTION_GONE);
  });

  it('POST /api/sessions/sync-booked-counts still rolls back, and still answers 409, on a healthy connection', async () => {
    const { release } = clientThatFails({ failOn: /^UPDATE sessions/i, rollbackFails: false });

    const res = await request(listening(sessApp('superadmin'))).post(SYNC);

    expect(res.status).toBe(409);
    expect(matching(/^ROLLBACK/i)).toHaveLength(1);
    expect(matching(/^COMMIT/i)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // THE NEGATIVE CONTROL for the whole file.
  //
  // Every arm above asserts a connection error is ABSENT. An absence-assertion
  // that can never see the thing it looks for is decoration, so this proves the
  // masking IS detectable by these assertions: the one unguarded shape left in
  // these files is a ROLLBACK on the NORMAL path (PATCH's "No fields to update"
  // at sessions.ts:477), which is deliberately NOT guarded - if that ROLLBACK
  // throws, the caller should hear about it. Here it does, and the connection
  // error surfaces exactly as the guarded arms above prove it does not.
  // ------------------------------------------------------------------

  it('surfaces a failing ROLLBACK that was never on an error path, proving these assertions can see it', async () => {
    statements = [];
    const query = jest.fn(async (sql: unknown) => {
      const q = String(sql).trim();
      statements.push(q);
      if (/^ROLLBACK/i.test(q)) throw connectionGone();
      return { rows: [sessionRow()], rowCount: 1 };
    });
    mockConnect.mockResolvedValue({ query, release: jest.fn() } as never);

    // An empty body reaches `if (updateFields.length === 0)`, whose ROLLBACK is
    // on the success path, not in a catch, and is therefore unguarded by design.
    const res = await request(listening(sessApp())).patch('/api/sessions/s1').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain(CONNECTION_GONE);
    // TWO, and the number is the mechanism. The normal-path ROLLBACK at
    // sessions.ts:477 throws, which lands in the catch at :505, whose own
    // guarded ROLLBACK swallows its second failure - so the error that reaches
    // the caller is the one from the FIRST, unguarded call. That is why this
    // arm can see a masking connection error while the guarded arms cannot.
    expect(matching(/^ROLLBACK/i)).toHaveLength(2);
  });
});
