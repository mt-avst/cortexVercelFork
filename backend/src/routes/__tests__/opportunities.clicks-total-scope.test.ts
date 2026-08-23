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
 * `clicks_total` IS OPEN TO EVERY ADMIN, NOT SCOPED TO THE OWNER. #19.
 *
 * A review gate found this measured but undecided, so this file is the
 * decision rather than a change.
 *
 * THE LINE: engagement on a recruitment link is METADATA; answer volume is
 * RESEARCH OUTPUT. A click count says how many people followed a link that was
 * posted to a channel - it names nobody, and the admin opportunities table it
 * is rendered into is already a deliberate all-admins metadata surface
 * carrying every study's title, owner and launch state. `answer_counts` on the
 * study read is the other side of that line and IS owner-scoped, deliberately.
 *
 * SCOPING IT WOULD HAVE BEEN WORSE, not merely unnecessary. The field is
 * omitted rather than zeroed for a caller who may not see it - a colleague's
 * row showing `0` reads as "nobody clicked", not as "not yours", and this
 * repository already got that distinction right once on `answer_counts`.
 * Withheld is not the same as zero on the wire, and a scoped version would
 * have had to reintroduce the ambiguity or invent a third state.
 *
 * So the assertions below pin BOTH halves: an admin who owns nothing still
 * gets the number, and a non-admin gets no key at all.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (role: Role | null, id = 'u1') => {
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
  return app;
};

/** One survey opportunity, owned by somebody who is not the caller. */
const OPPORTUNITY = {
  id: 'opp-1',
  title: 'A survey',
  type: 'survey',
  status: 'published',
  owner_user_id: 'someone-else',
  owner_name: 'Other Researcher',
  owner_email: 'other@example.com',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  start_date: null,
  end_date: null,
};

describe('clicks_total on GET /api/opportunities', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('FROM opportunity_clicks')) {
        return { rows: [{ opportunity_id: 'opp-1', count: '8' }] };
      }
      if (text.includes('FROM opportunities o')) {
        return { rows: [OPPORTUNITY] };
      }
      return { rows: [] };
    });
  });

  it('gives an admin who does not own the opportunity the click count', async () => {
    const res = await request(listening(appAs('researcher_admin', 'not-the-owner')))
      .get('/api/opportunities')
      .expect(200);

    expect(res.body[0].clicks_total).toBe(8);
  });

  it('gives a superadmin the same', async () => {
    const res = await request(listening(appAs('superadmin', 'root-1')))
      .get('/api/opportunities')
      .expect(200);

    expect(res.body[0].clicks_total).toBe(8);
  });

  // The other half of the decision, and the control for the arms above: if the
  // field were present for everybody, "open to all ADMINS" would be recording
  // something that is not true of the code.
  it('withholds the key entirely from a non-admin, rather than sending a zero', async () => {
    const res = await request(listening(appAs('employee', 'user-1')))
      .get('/api/opportunities')
      .expect(200);

    // ABSENT, not 0. A zero reads as "nobody clicked" and would be a lie; the
    // absent key is the only honest way to say "not for you" in this shape.
    expect(res.body[0]).not.toHaveProperty('clicks_total');
    expect(res.body[0].clicks_total).toBeUndefined();
  });

  it('withholds it from an unauthenticated caller too', async () => {
    const res = await request(listening(appAs(null)))
      .get('/api/opportunities')
      .expect(200);

    expect(res.body[0]).not.toHaveProperty('clicks_total');
  });

  // THE CONTROL FOR THE TWO ABSENCE-ASSERTIONS ABOVE. They observe a missing
  // key, which is also what a broken response body, an empty list or a renamed
  // field looks like. This proves the shape they are reading is real.
  it('returns a body whose rows are real opportunities either way', async () => {
    const asAdmin = await request(listening(appAs('researcher_admin', 'not-the-owner')))
      .get('/api/opportunities')
      .expect(200);
    const asEmployee = await request(listening(appAs('employee', 'user-1')))
      .get('/api/opportunities')
      .expect(200);

    expect(asAdmin.body).toHaveLength(1);
    expect(asEmployee.body).toHaveLength(1);
    expect(asAdmin.body[0].id).toBe('opp-1');
    expect(asEmployee.body[0].id).toBe('opp-1');
    // And the admin arm really does carry the key the employee arm lacks.
    expect(asAdmin.body[0]).toHaveProperty('clicks_total');
  });

  it('does not even ask the database for clicks on behalf of a non-admin', async () => {
    await request(listening(appAs('employee', 'user-1')))
      .get('/api/opportunities')
      .expect(200);

    const askedForClicks = mockQuery.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes('FROM opportunity_clicks')
    );
    expect(askedForClicks).toBe(false);
  });
});
