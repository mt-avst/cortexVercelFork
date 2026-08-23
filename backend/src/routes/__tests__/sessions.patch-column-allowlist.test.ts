import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

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
 * PATCH /api/sessions/:id BUILT ITS SET CLAUSE FROM REQUEST-BODY KEYS.
 *
 * `updateFields.push(`${key} = $${paramCount}`)` interpolated the key and
 * parameterised only the value, and nothing upstream refused an unexpected
 * key: `const data: UpdateSessionRequest = req.body` is a type annotation that
 * erases at runtime, and `validateSessionData` is positive-only.
 *
 * The first test below is the exploit that was reported, used verbatim as the
 * regression case. It is a SELECT against `users` smuggled through a column
 * name, returned to the caller by the handler's own `RETURNING *`.
 *
 * WHAT THESE TESTS PIN, precisely: that a body key outside the allow-list is
 * REFUSED, and that no SQL is built or run for it. They do not prove the
 * builder is safe for the four permitted names - those are literals in this
 * file's own allow-list, not caller input, which is the point of the fix.
 */
const appAs = (role: 'employee' | 'researcher_admin' | 'superadmin') => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id: 'admin-1', name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
};

const PATH = '/api/sessions/s1';

/** A client that would happily run whatever SQL the handler builds. */
const makeClient = () => {
  const query = jest.fn(async (sql: unknown) => {
    if (String(sql).includes('SELECT')) {
      return {
        rows: [{ id: 's1', opportunity_id: 'opp-1', start_time: new Date(), end_time: new Date(), capacity: 5, booked_count: 0 }],
        rowCount: 1,
      };
    }
    // The handler calls .toISOString() on four columns of the RETURNING row,
    // so all four must be Dates or the success path 500s and the control arms
    // below stop being controls.
    return {
      rows: [{
        id: 's1', opportunity_id: 'opp-1', capacity: 7, booked_count: 0, remaining: 7,
        start_time: new Date('2030-01-01T10:00:00Z'), end_time: new Date('2030-01-01T11:00:00Z'),
        created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
      }],
      rowCount: 1,
    };
  });
  return { query, release: jest.fn() };
};

const statementsOn = (client: { query: jest.Mock }) =>
  client.query.mock.calls.map((call: unknown[]) => String(call[0]));

/** Every UPDATE the handler actually built, matched in one place. */
const updateStatements = (client: { query: jest.Mock }) =>
  statementsOn(client).filter((sql) => sql.includes('UPDATE sessions'));

describe('PATCH /api/sessions/:id column allow-list', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    client = makeClient();
    mockConnect.mockResolvedValue(client as never);

    // The handler reads on the POOL before it opens a transaction:
    // `checkSessionOwnership` then `SELECT * FROM sessions`. The caller owns
    // this session, so the ownership gate at :124 is satisfied and the update
    // path is genuinely reachable - which is what makes the control arms below
    // controls rather than decoration.
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('owner_user_id')) return { rows: [{ owner_user_id: 'admin-1' }], rowCount: 1 };
      if (text.includes('SELECT * FROM sessions')) {
        return {
          rows: [{
            id: 's1', opportunity_id: 'opp-1', capacity: 5, booked_count: 0,
            start_time: new Date('2030-01-01T10:00:00Z'), end_time: new Date('2030-01-01T11:00:00Z'),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  // THE EXPLOIT, verbatim. Before the fix this produced
  //   UPDATE sessions SET location_or_meet_link_optional =
  //     (SELECT email FROM users ORDER BY created_at LIMIT 1), capacity = $1
  //   WHERE id = $2 RETURNING *
  it('refuses a body key carrying a subquery, and builds no SQL for it', async () => {
    const res = await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({
        'location_or_meet_link_optional = (SELECT email FROM users ORDER BY created_at LIMIT 1), capacity': 5,
      })
      .expect(400);

    expect(res.body.error).toBe('Validation failed');
    // The refusal must happen before anything is built OR run. Asserting only
    // the status would pass on a handler that ran the injection and then
    // failed for some later reason.
    expect(updateStatements(client)).toHaveLength(0);
    expect(mockConnect).not.toHaveBeenCalled();
    // Refused before the ownership lookup too - nothing about this request
    // reached the database at all.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses mass assignment of columns the caller does not own', async () => {
    // The weaker half of the same hole: both are real columns on `sessions`,
    // so no injection is needed - just naming them was enough. `opportunity_id`
    // moved a session and its bookings under another researcher's opportunity.
    for (const body of [{ booked_count: 999 }, { opportunity_id: 'someone-elses' }, { id: 'other-session' }]) {
      client = makeClient();
      mockConnect.mockResolvedValue(client as never);

      await request(listening(appAs('researcher_admin'))).patch(PATH).send(body).expect(400);

      expect(updateStatements(client)).toHaveLength(0);
    }
  });

  it('never echoes the offending key back to the caller', async () => {
    // Reflecting attacker-chosen text into a response body is one careless
    // render away from being a second vulnerability.
    const marker = 'capacity, evil_marker_9f3a';
    const res = await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ [marker]: 1 })
      .expect(400);

    expect(JSON.stringify(res.body)).not.toContain('evil_marker_9f3a');
    // The control: the response is not empty, so the assertion above is about
    // the marker's absence and not about there being nothing to search.
    expect(JSON.stringify(res.body).length).toBeGreaterThan(20);
  });

  // THE CONTROL FOR EVERY REFUSAL ABOVE. Without it, a handler that rejected
  // every PATCH - or that threw before reaching the builder for an unrelated
  // reason - would satisfy all four assertions and pin nothing.
  it('still updates the four permitted columns', async () => {
    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ capacity: 7, location_or_meet_link_optional: 'https://meet.example.com/x' })
      .expect(200);

    const updates = updateStatements(client);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/capacity = \$\d/);
    expect(updates[0]).toMatch(/location_or_meet_link_optional = \$\d/);
  });

  it('accepts each permitted column on its own', async () => {
    // Named separately so a fix that narrowed the allow-list too far - dropping
    // a field the editor actually sends - fails here rather than in the UI.
    for (const body of [
      { capacity: 3 },
      { location_or_meet_link_optional: 'https://meet.example.com/y' },
      { start_time: '2030-01-01T10:00:00.000Z', end_time: '2030-01-01T11:00:00.000Z' },
    ]) {
      client = makeClient();
      mockConnect.mockResolvedValue(client as never);

      await request(listening(appAs('researcher_admin'))).patch(PATH).send(body).expect(200);

      expect(updateStatements(client)).toHaveLength(1);
    }
  });

  // THE MOCK-DATA PATH. Every arm above sets `isDatabaseAvailable` true, so
  // none of them reached the `!dbAvailable` branch - and a security gate proved
  // that gap by making the allow-list database-only, which survived all 958
  // tests. The branch needs the check as much as the SQL path does:
  // `updateMockSession` spreads `{ ...session, ...updates }`, so an unknown key
  // was unrestricted mass assignment into the mock store.
  it('refuses an unknown column with no database, where there is no SQL to inject', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false as never);

    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ booked_count: 999 })
      .expect(400);

    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still refuses a non-admin outright', async () => {
    await request(listening(appAs('employee')))
      .patch(PATH)
      .send({ capacity: 3 })
      .expect(403);

    expect(mockConnect).not.toHaveBeenCalled();
  });
});
