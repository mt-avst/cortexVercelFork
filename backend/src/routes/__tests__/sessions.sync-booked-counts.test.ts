import { describe, it, expect, beforeEach, jest } from '@jest/globals';
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

import sessionsRouter from '../sessions';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockConnect = pool.connect as unknown as jest.Mock;

/**
 * POST /api/sessions/sync-booked-counts - the operator repair tool, pinned as
 * SUPERADMIN ONLY and TRANSACTIONAL. cto/AdaptaLabs#26.
 *
 * Two properties, and both were absent before:
 *
 *  - It was `requireAdmin`, so any researcher_admin could trigger writes to
 *    every other researcher's sessions. It is the one session write that is not
 *    owner-gated, and the value is derived rather than caller-supplied, so the
 *    right gate is the operator role, not ownership.
 *  - It counted and updated on separate pooled connections with no lock, so a
 *    booking committed mid-sweep was clobbered - the repair could CAUSE the
 *    drift it exists to fix. The lock is asserted here by shape (a mocked pool
 *    cannot race); the real guarantee is proven against Postgres, but the shape
 *    is what a revert to the pooled form trips over.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (role?: Role) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) {
      (req as unknown as { session: { user: { id: string; name: string; email: string; role: Role } } }).session = {
        user: { id: 'u-1', name: 'A', email: 'a@example.com', role },
      };
    }
    next();
  });
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
};

const PATH = '/api/sessions/sync-booked-counts';

/** Records every statement the transaction client issued, in order. */
let clientStatements: string[];

const clientAnswering = (sessionIds: string[], { failOnUpdate = false } = {}) => {
  clientStatements = [];
  const query = jest.fn(async (sql: unknown) => {
    const q = String(sql);
    clientStatements.push(q);
    if (/SELECT id\s+FROM sessions/i.test(q) && /FOR UPDATE/i.test(q)) {
      return { rows: sessionIds.map((id) => ({ id })), rowCount: sessionIds.length };
    }
    if (/^\s*UPDATE sessions/i.test(q)) {
      if (failOnUpdate) throw new Error('boom');
      return { rows: [], rowCount: sessionIds.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = jest.fn();
  mockConnect.mockResolvedValue({ query, release } as never);
  return { release };
};

const matching = (pattern: RegExp) => clientStatements.filter((sql) => pattern.test(sql));

describe('POST /api/sessions/sync-booked-counts', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('lets a superadmin through and reports the number of sessions synced', async () => {
    clientAnswering(['s-1', 's-2', 's-3']);

    const res = await request(listening(appAs('superadmin'))).post(PATH).expect(200);

    expect(res.body.synced_count).toBe(3);
  });

  // THE GATE. The whole point of the change: this is superadmin-only now.
  it('refuses a researcher_admin, and connects to nothing', async () => {
    clientAnswering(['s-1']);

    const res = await request(listening(appAs('researcher_admin'))).post(PATH).expect(403);

    expect(res.body.error).toBe('Superadmin access required');
    // Refused before any database work - the pool is never even borrowed.
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('refuses a plain employee too', async () => {
    clientAnswering(['s-1']);

    const res = await request(listening(appAs('employee'))).post(PATH).expect(403);

    expect(res.body.error).toBe('Superadmin access required');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller with 401', async () => {
    clientAnswering(['s-1']);

    await request(listening(appAs(undefined))).post(PATH).expect(401);

    expect(mockConnect).not.toHaveBeenCalled();
  });

  // THE TRANSACTION AND THE LOCK. A revert to the old count-then-update on the
  // pool, or dropping FOR UPDATE, trips these.
  it('locks the rows and rewrites them inside one committed transaction', async () => {
    clientAnswering(['s-1', 's-2']);

    await request(listening(appAs('superadmin'))).post(PATH).expect(200);

    expect(matching(/^\s*BEGIN/)).toHaveLength(1);
    // The lock is what stops a concurrent booking being clobbered.
    expect(matching(/SELECT id\s+FROM sessions[\s\S]*FOR UPDATE/i)).toHaveLength(1);
    // One set-based UPDATE, NOT a per-session N+1: the count is a correlated
    // subquery, so the whole table is repaired in a single statement.
    const updates = matching(/^\s*UPDATE sessions/i);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/SELECT COUNT\(\*\) FROM bookings/i);
    expect(matching(/^\s*COMMIT/)).toHaveLength(1);
    expect(matching(/^\s*ROLLBACK/)).toHaveLength(0);
  });

  it('rolls back and releases the client when the update fails', async () => {
    const { release } = clientAnswering(['s-1'], { failOnUpdate: true });

    await request(listening(appAs('superadmin'))).post(PATH).expect(500);

    expect(matching(/^\s*ROLLBACK/)).toHaveLength(1);
    expect(matching(/^\s*COMMIT/)).toHaveLength(0);
    // The connection is returned to the pool even on the error path.
    expect(release).toHaveBeenCalledTimes(1);
  });
});
