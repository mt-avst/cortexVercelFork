import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14: route suites use the session-trusting auth double; the real gate re-reads
// the DB role, which a positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

import sessionsRouter from '../sessions';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * DELETE /api/sessions/:id - the booking check and the delete run in ONE
 * transaction that holds FOR UPDATE on the session row (cto/AdaptaLabs#34).
 *
 * It used to `SELECT booked_count` and then `DELETE` on two separate pooled
 * connections with no lock. A booking that committed between the two was
 * deleted regardless - a TOCTOU that silently strands the participant who
 * booked, the exact harm the count check exists to prevent. Every writer of
 * booked_count locks the session row first, so re-reading the count under
 * FOR UPDATE makes it the committed truth.
 *
 * The lock is asserted here BY SHAPE - a mocked pool cannot race - which is what
 * a revert to the pooled, lockless form trips over. The booked-session refusal
 * (previously pinned by NOTHING) is asserted behaviourally.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const OWNER = 'admin-1';

const appAs = (role: Role, id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: Role } } }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
};

/** Ownership on the pool: the JOIN predicate answers with the owner's id. */
const ownershipAnswers = () => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    if (q.includes('FROM sessions s') && q.includes('JOIN opportunities o')) {
      return { rows: [{ owner_user_id: OWNER }] };
    }
    if (/SELECT id\s+FROM sessions WHERE id = \$1/.test(q)) {
      return { rows: [{ id: 'sess-1' }] };
    }
    return { rows: [] };
  });
};

/** Records every statement the transaction client issued, in order. */
let clientStatements: string[];
let release: jest.Mock;

/**
 * The transaction client. `bookedCount` is what the FOR UPDATE read returns;
 * `missing` makes that read find no row (the session vanished under the lock).
 */
const clientAnswering = ({ bookedCount = 0, missing = false }: { bookedCount?: number; missing?: boolean } = {}) => {
  clientStatements = [];
  const query = jest.fn(async (sql: unknown) => {
    const q = String(sql);
    clientStatements.push(q);
    if (/SELECT booked_count FROM sessions WHERE id = \$1\s+FOR UPDATE/i.test(q)) {
      return missing ? { rows: [] } : { rows: [{ booked_count: bookedCount }] };
    }
    if (/^\s*DELETE FROM sessions/i.test(q)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
  release = jest.fn();
  mockConnect.mockResolvedValue({ query, release } as never);
};

const matching = (pattern: RegExp) => clientStatements.filter((sql) => pattern.test(sql));

const del = () => request(listening(appAs('researcher_admin', OWNER))).delete('/api/sessions/sess-1');

describe('DELETE /api/sessions/:id - the delete is transactional and row-locked (#34)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    ownershipAnswers();
  });

  it('reads the count and deletes inside one committed transaction, holding FOR UPDATE', async () => {
    clientAnswering({ bookedCount: 0 });

    await del().expect(204);

    expect(matching(/^\s*BEGIN/)).toHaveLength(1);
    // The lock is what stops a booking committing between the check and the
    // delete. Dropping FOR UPDATE, or reverting the read to the pool, trips this.
    expect(matching(/SELECT booked_count FROM sessions WHERE id = \$1\s+FOR UPDATE/i)).toHaveLength(1);
    expect(matching(/^\s*DELETE FROM sessions WHERE id = \$1/)).toHaveLength(1);
    expect(matching(/^\s*COMMIT/)).toHaveLength(1);
    expect(matching(/^\s*ROLLBACK/)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses a session with bookings, rolls back, and deletes nothing', async () => {
    clientAnswering({ bookedCount: 2 });

    const res = await del().expect(400);

    expect(res.body.error).toBe('Cannot delete session with existing bookings');
    // The count was read under the lock, and NO delete followed.
    expect(matching(/SELECT booked_count FROM sessions WHERE id = \$1\s+FOR UPDATE/i)).toHaveLength(1);
    expect(matching(/^\s*DELETE FROM sessions/)).toHaveLength(0);
    expect(matching(/^\s*COMMIT/)).toHaveLength(0);
    expect(matching(/^\s*ROLLBACK/)).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('answers 404 and deletes nothing when the row is gone under the lock', async () => {
    clientAnswering({ missing: true });

    await del().expect(404);

    expect(matching(/^\s*DELETE FROM sessions/)).toHaveLength(0);
    expect(matching(/^\s*ROLLBACK/)).toHaveLength(1);
    expect(matching(/^\s*COMMIT/)).toHaveLength(0);
    // The connection is returned to the pool even on the refusal path.
    expect(release).toHaveBeenCalledTimes(1);
  });
});
