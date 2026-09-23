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

import opportunitiesRouter from '../opportunities';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * ALL-TIME PROGRESS TOTALS ON THE ADMIN LIST: THE WIRING, WITH A MOCKED POOL.
 *
 * What the totals ARE (which sessions and bookings count) can only be proved
 * against a real database, and is, in
 * `opportunities.list-progress-totals-postgres.test.ts`. This file pins what a
 * mocked pool CAN see and a real-database run on a healthy server cannot:
 *
 *   - the totals batch is handed EXACTLY the id list the listing query
 *     returned, so the owner scope is inherited rather than re-derived;
 *   - a failing totals read degrades to absent fields, not a 500 (a real
 *     Postgres will not fail on cue);
 *   - a non-admin caller never costs the totals query at all;
 *   - the no-database fallback carries the same admin-only shape.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

/** `withLiveRoleIfPresent` re-reads the role by id; answered from this map. */
const USERS: Readonly<Record<string, Role>> = {
  'admin-1': 'researcher_admin',
  'user-1': 'employee',
};

const appAs = (role: Role | null, id = 'admin-1', path = '/api/opportunities') => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = role
      ? { user: { id, name: 'A', email: 'a@example.com', role } }
      : {};
    next();
  });
  app.use('/api/opportunities', opportunitiesRouter);
  app.use(errorHandler);
  return request(listening(app)).get(path);
};

const row = (id: string) => ({
  id,
  title: `Study ${id}`,
  type: 'interview',
  status: 'published',
  owner_user_id: 'admin-1',
  owner_name: 'Owner',
  owner_email: 'owner@example.com',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  start_date: null,
  end_date: null,
});

const LISTED = [row('11111111-1111-4111-8111-111111111111'), row('22222222-2222-4222-8222-222222222222')];

/** Distinguishes the totals batch from the windowed session fan-out. */
const isTotalsQuery = (sql: string) => sql.includes('per_session');
const totalsCalls = () =>
  mockQuery.mock.calls.filter((call: unknown[]) => isTotalsQuery(String(call[0])));

describe('GET /api/opportunities all-time progress totals (mocked pool)', () => {
  let totalsBehaviour: 'answer' | 'throw';

  beforeEach(() => {
    jest.resetAllMocks();
    totalsBehaviour = 'answer';
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
      const text = String(sql);
      if (text.includes('SELECT role FROM users')) {
        const role = USERS[(params as string[])[0]];
        return { rows: role ? [{ role }] : [] };
      }
      if (isTotalsQuery(text)) {
        if (totalsBehaviour === 'throw') {
          throw new Error('simulated totals read failure');
        }
        // Only the FIRST listed study has sessions; the second is absent from
        // the batch, which is how the real query reports "no sessions".
        return { rows: [{ opportunity_id: LISTED[0].id, total_booked: 3, total_capacity: 7 }] };
      }
      if (text.includes('FROM opportunities o')) {
        return { rows: LISTED };
      }
      return { rows: [] };
    });
  });

  it('spreads the totals onto the admin row that has sessions, and leaves them ABSENT on the one without', async () => {
    const res = await appAs('researcher_admin').expect(200);

    const [withSessions, withoutSessions] = res.body;
    expect(withSessions.total_booked).toBe(3);
    expect(withSessions.total_capacity).toBe(7);
    // Absent, not 0: "0 of 0" would read as an empty study rather than one
    // with nothing to count.
    expect(withoutSessions).not.toHaveProperty('total_booked');
    expect(withoutSessions).not.toHaveProperty('total_capacity');
  });

  it('hands the totals batch exactly the id list the listing query returned, in one query', async () => {
    await appAs('researcher_admin', 'admin-1', '/api/opportunities?scope=mine').expect(200);

    const calls = totalsCalls();
    expect(calls).toHaveLength(1);
    expect((calls[0] as unknown[])[1]).toEqual([[LISTED[0].id, LISTED[1].id]]);
    // No ownership predicate of its own: the scope is the id list, never a
    // second derivation that could disagree with the listing's.
    expect(String((calls[0] as unknown[])[0])).not.toContain('owner_user_id');
  });

  it('degrades a failed totals read to absent fields rather than failing the list', async () => {
    totalsBehaviour = 'throw';

    const res = await appAs('researcher_admin').expect(200);

    // THE CONTROL: the list itself still arrived, both rows of it.
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe(LISTED[0].id);
    expect(res.body[0]).not.toHaveProperty('total_booked');
    expect(res.body[0]).not.toHaveProperty('total_capacity');
    expect(totalsCalls()).toHaveLength(1);
  });

  it.each([
    ['a participant', 'employee' as const, 'user-1'],
    ['an anonymous caller', null, 'anon'],
  ])('never asks the database for totals on behalf of %s, and sends none', async (_label, role, id) => {
    const res = await appAs(role, id).expect(200);

    expect(totalsCalls()).toHaveLength(0);
    // THE CONTROL: rows did arrive, so the absence below is about the fields.
    expect(res.body).toHaveLength(2);
    for (const opportunity of res.body) {
      expect(opportunity).not.toHaveProperty('total_booked');
      expect(opportunity).not.toHaveProperty('total_capacity');
    }
  });
});

/**
 * THE NO-DATABASE FALLBACK (demo/mock-data.ts). `mock-1` has two sessions,
 * capacity 5 each, booked_count 2 and 0; `mock-2` has none. Values are written
 * down here rather than summed from the fixture, so a change to the fixture or
 * to the sum fails by name.
 */
describe('GET /api/opportunities all-time progress totals (no database)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(false as never);
    mockQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
      if (String(sql).includes('SELECT role FROM users')) {
        const role = USERS[(params as string[])[0]];
        return { rows: role ? [{ role }] : [] };
      }
      return { rows: [] };
    });
  });

  const byId = (body: Array<Record<string, unknown>>, id: string) =>
    body.find((opportunity) => opportunity.id === id) as Record<string, unknown>;

  it('gives an admin the same totals shape the database path does', async () => {
    const res = await appAs('researcher_admin').expect(200);

    expect(byId(res.body, 'mock-1')).toMatchObject({ total_booked: 2, total_capacity: 10 });
    expect(byId(res.body, 'mock-2')).not.toHaveProperty('total_booked');
    expect(byId(res.body, 'mock-2')).not.toHaveProperty('total_capacity');
  });

  it('gives a participant no totals', async () => {
    const res = await appAs('employee', 'user-1').expect(200);

    const mockOne = byId(res.body, 'mock-1');
    // THE CONTROL: the row with sessions is really in the participant's list.
    expect(mockOne).toBeDefined();
    expect(mockOne).not.toHaveProperty('total_booked');
    expect(mockOne).not.toHaveProperty('total_capacity');
  });
});
