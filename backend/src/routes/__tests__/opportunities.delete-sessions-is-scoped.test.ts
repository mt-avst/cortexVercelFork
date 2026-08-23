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

import opportunitiesRouter from '../opportunities';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * `DELETE /api/opportunities/:id/sessions` ISSUES TWO GLOBAL-SHAPED DELETES AND
 * NOTHING ASKED WHAT THEY AFFECT.
 *
 * Measured on `bedc2fe`, each of these passed the WHOLE backend suite - 1007 of
 * 1007, tree clean before and after, typecheck clean:
 *
 *   'DELETE FROM bookings WHERE session_id IN (SELECT id FROM sessions WHERE opportunity_id = $1)'
 *     -> 'DELETE FROM bookings'
 *   'DELETE FROM sessions WHERE opportunity_id = $1'
 *     -> 'DELETE FROM sessions'
 *
 * The first empties the bookings table for every user of the product. The
 * second does the same for sessions. There is no undo and no audit row, and
 * the route answers `200 {"message":"All sessions deleted successfully"}`
 * either way.
 *
 * WHY THE EXISTING TESTS CANNOT SEE IT. They match that a statement EXISTS -
 * `sql.includes('DELETE FROM bookings')` - which is still true of the mutant,
 * and they assert the params array still carries the opportunity id, which is
 * ALSO still true: **a bound parameter stays bound whether the SQL uses it or
 * not.** A real server would reject the unused parameter; `pool` is mocked in
 * every one of these suites, so nothing does.
 *
 * The assertions below therefore tie the column, the `$n` placeholder and the
 * bound VALUE together. See `__tests__/helpers/sql-scope.ts`.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const OWNER = 'admin-1';
const OPPORTUNITY = 'opp-1';
const PATH = `/api/opportunities/${OPPORTUNITY}/sessions`;

const appAs = (role: Role, id = OWNER) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/opportunities', opportunitiesRouter);
  app.use(errorHandler);
  return app;
};

/** The caller owns the opportunity and no session has a live booking. */
const arrangeDeletable = () => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('SELECT owner_user_id FROM opportunities')) {
      return { rows: [{ owner_user_id: OWNER }], rowCount: 1 };
    }
    // The "any session still booked?" guard. Empty means deletion proceeds.
    if (text.includes('EXISTS (SELECT 1 FROM bookings')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 2 };
  });
};

type Call = { sql: string; params: readonly unknown[] };

const callsMatching = (fragment: string): Call[] =>
  mockQuery.mock.calls
    .map((call: unknown[]) => ({ sql: String(call[0]), params: (call[1] ?? []) as unknown[] }))
    .filter((c: Call) => executableSql(c.sql).toUpperCase().includes(fragment.toUpperCase()));

describe('DELETE /api/opportunities/:id/sessions is scoped to the opportunity', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    arrangeDeletable();
  });

  it('deletes only the bookings belonging to this opportunity', async () => {
    await request(listening(appAs('researcher_admin'))).delete(PATH).expect(200);

    const deletes = callsMatching('DELETE FROM bookings');
    // THE CONTROL. If the handler stopped issuing this statement at all, every
    // assertion below would have nothing to check and would pass vacuously.
    expect(deletes).toHaveLength(1);

    // It reaches its rows through a subquery, so the restricting column is not
    // on the table being written - which is exactly why "does it name the
    // opportunity id" has to be asked of the WHERE clause rather than assumed
    // from the params.
    expectScopedBy(deletes[0].sql, deletes[0].params, 'opportunity_id', OPPORTUNITY);
    expect(whereClauseOf(deletes[0].sql)).toContain('session_id IN');
  });

  it('deletes only the sessions belonging to this opportunity', async () => {
    await request(listening(appAs('researcher_admin'))).delete(PATH).expect(200);

    const deletes = callsMatching('DELETE FROM sessions');
    expect(deletes).toHaveLength(1);

    expectScopedBy(deletes[0].sql, deletes[0].params, 'opportunity_id', OPPORTUNITY);
  });

  // THE ASSERTION THAT KILLS THE MUTATION MOST DIRECTLY, stated separately
  // because it is the one a reader should not have to infer: no statement this
  // route runs may be unrestricted. A DELETE with no WHERE is not a narrower
  // bug than the wrong WHERE, it is the whole table.
  it('issues no unrestricted DELETE at all', async () => {
    await request(listening(appAs('researcher_admin'))).delete(PATH).expect(200);

    const deletes = callsMatching('DELETE FROM');
    // The control for the loop: there ARE deletes to examine.
    expect(deletes.length).toBeGreaterThanOrEqual(2);

    // Reported as a LIST of the offending statements rather than as a loop of
    // booleans, so a failure names the statement that lost its WHERE instead of
    // saying `false is not true`.
    const unrestricted = deletes
      .map((call) => executableSql(call.sql))
      .filter((sql) => whereClauseOf(sql) === undefined);

    expect(unrestricted).toEqual([]);
  });

  it('binds the opportunity from the route, not some other id', async () => {
    // A statement can name the right column and still bind the wrong value.
    // Driving a DIFFERENT id proves the binding follows the request rather
    // than a constant that happens to match the fixture.
    const other = 'opp-2';
    await request(listening(appAs('researcher_admin')))
      .delete(`/api/opportunities/${other}/sessions`)
      .expect(200);

    for (const call of callsMatching('DELETE FROM')) {
      expectScopedBy(call.sql, call.params, 'opportunity_id', other);
    }
  });

  // ------------------------------------------------------------------
  // The refusals, so the arms above cannot pass on a route that deleted
  // nothing for an unrelated reason.
  // ------------------------------------------------------------------

  it('refuses an admin who does not own the opportunity, and deletes nothing', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('SELECT owner_user_id FROM opportunities')) {
        return { rows: [{ owner_user_id: 'somebody-else' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await request(listening(appAs('researcher_admin'))).delete(PATH).expect(403);

    expect(callsMatching('DELETE FROM')).toHaveLength(0);
  });

  it('refuses when a session still has a live booking, and deletes nothing', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('SELECT owner_user_id FROM opportunities')) {
        return { rows: [{ owner_user_id: OWNER }], rowCount: 1 };
      }
      if (text.includes('EXISTS (SELECT 1 FROM bookings')) {
        return { rows: [{ id: 's1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await request(listening(appAs('researcher_admin'))).delete(PATH).expect(400);

    expect(callsMatching('DELETE FROM')).toHaveLength(0);
  });
});
