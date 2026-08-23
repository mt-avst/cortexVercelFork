import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

jest.mock('../../services/gamification', () => ({
  awardPoints: jest.fn(),
  awardPointsAfterApproval: jest.fn(),
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { awardPointsAfterApproval } from '../../services/gamification';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;
const mockAward = awardPointsAfterApproval as unknown as jest.Mock;

/**
 * POST /:bookingId/approve and /reject write `admin_notes` - a researcher's
 * written judgement of a named colleague - and approve additionally awards
 * that colleague points. Both gate on owning the opportunity, and NEITHER gate
 * was held by a test: deleting either passed 844 of 844 on e717537.
 *
 * The two handlers are near-identical and 80 lines apart, which is exactly the
 * shape where a fix applied to one reads as a fix applied to both. Every case
 * below therefore runs against BOTH, from one table.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (role: Role, id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: Role } } }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/**
 * The client the handler gets from `pool.connect()`. Its `query` is separate
 * from the pool's, which is what lets the assertions below tell an ownership
 * probe apart from the UPDATE that acts on the answer.
 */
const makeClient = (ownerUserId: string | null) => {
  const clientQuery = jest.fn(async (sql: unknown) => {
    if (String(sql).includes('SELECT')) {
      return {
        rows: [
          {
            id: 'b1',
            user_id: 'participant-1',
            session_id: 's1',
            opportunity_id: 'opp-1',
            opportunity_type: 'interview',
            owner_user_id: ownerUserId,
          },
        ],
      };
    }
    return { rows: [] };
  });
  return { query: clientQuery, release: jest.fn() };
};

const updateStatements = (client: { query: jest.Mock }) =>
  client.query.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((sql: string) => sql.includes('UPDATE bookings'));

const ROUTES = [
  {
    name: 'approve',
    path: '/api/bookings/b1/approve',
    refusal: 'You can only approve sessions for your own opportunities',
  },
  {
    name: 'reject',
    path: '/api/bookings/b1/reject',
    refusal: 'You can only reject sessions for your own opportunities',
  },
] as const;

describe.each(ROUTES)('POST $path ownership', ({ name, path, refusal }) => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockAward.mockResolvedValue({
      points: 10,
      newLevel: 1,
      levelUp: false,
      totalPoints: 10,
    } as never);
  });

  /** The role lookup the handler does on the pool before it connects. */
  const roleIs = (role: Role) =>
    mockQuery.mockResolvedValueOnce({ rows: [{ role }] } as never);

  // THE CONTROL. Without it, a handler that refused everything - or one whose
  // mocked client never returned a booking, so it 404'd - would pass every
  // refusal assertion below while proving nothing about ownership.
  it(`lets the opportunity owner ${name} the session`, async () => {
    roleIs('researcher_admin');
    const client = makeClient('admin-1');
    mockConnect.mockResolvedValue(client as never);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(path)
      .send({ adminNotes: 'Clear and useful session' })
      .expect(200);

    expect(updateStatements(client)).toHaveLength(1);
  });

  it(`refuses a researcher_admin who does not own the opportunity, on ${name}`, async () => {
    roleIs('researcher_admin');
    const client = makeClient('admin-2');
    mockConnect.mockResolvedValue(client as never);

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(path)
      .send({ adminNotes: 'Not mine to judge' })
      .expect(403);

    expect(res.body.error).toBe(refusal);
  });

  // The absence-assertion. Its control is the arm above, which shows the same
  // fixture DOES produce exactly one UPDATE when the caller owns the row.
  it(`writes nothing when a non-owner tries to ${name}, and rolls back`, async () => {
    roleIs('researcher_admin');
    const client = makeClient('admin-2');
    mockConnect.mockResolvedValue(client as never);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(path)
      .send({ adminNotes: 'Not mine to judge' })
      .expect(403);

    expect(updateStatements(client)).toHaveLength(0);
    expect(client.query.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it(`lets a superadmin ${name} anything, which is the documented asymmetry`, async () => {
    roleIs('superadmin');
    const client = makeClient('admin-2');
    mockConnect.mockResolvedValue(client as never);

    await request(listening(appAs('superadmin', 'root-1')))
      .post(path)
      .send({ adminNotes: 'Reviewed centrally' })
      .expect(200);

    expect(updateStatements(client)).toHaveLength(1);
  });

  it(`refuses to ${name} an ownerless opportunity rather than adopting it`, async () => {
    roleIs('researcher_admin');
    const client = makeClient(null);
    mockConnect.mockResolvedValue(client as never);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(path)
      .send({ adminNotes: 'Nobody owns this' })
      .expect(403);

    expect(updateStatements(client)).toHaveLength(0);
  });

  // THE ROLE COMES FROM THE DATABASE, NOT FROM THE SESSION, and that is a
  // control rather than an accident. These two handlers mount on `requireAuth`
  // and then re-read `SELECT role FROM users` - stricter than the `requireAdmin`
  // their siblings use, because a session is a snapshot: `req.user` is a copy
  // of `req.session.user`, and `UPDATE users SET role` in admin.ts invalidates
  // no session. Re-reading is what stops a stale elevated session approving.
  //
  // Every other case in this table sets both roles to the same value, so none
  // of them can see which one the handler consulted. A security gate proved
  // that by swapping the source to `req.user!.role` and passing all 884 tests.
  // These two arms disagree on purpose, in both directions.
  it(`reads the ${name} superadmin bypass from the database, not the session`, async () => {
    roleIs('researcher_admin');
    const client = makeClient('admin-2');
    mockConnect.mockResolvedValue(client as never);

    // A session claiming superadmin, held by someone the database has since
    // demoted. The stale claim must not carry the bypass.
    await request(listening(appAs('superadmin', 'stale-1')))
      .post(path)
      .send({ adminNotes: 'Elevated yesterday, not today' })
      .expect(403);

    expect(updateStatements(client)).toHaveLength(0);
  });

  it(`grants the ${name} superadmin bypass on the database role alone`, async () => {
    roleIs('superadmin');
    const client = makeClient('admin-2');
    mockConnect.mockResolvedValue(client as never);

    // The mirror image, and it is what makes the arm above about the SOURCE
    // rather than merely about refusing. A session that has not caught up with
    // a promotion still gets the authority the database records.
    await request(listening(appAs('researcher_admin', 'promoted-1')))
      .post(path)
      .send({ adminNotes: 'Promoted this morning' })
      .expect(200);

    expect(updateStatements(client)).toHaveLength(1);
  });

  it(`refuses a non-admin ${name} before it opens a transaction`, async () => {
    roleIs('employee');

    await request(listening(appAs('employee', 'user-1')))
      .post(path)
      .send({ adminNotes: 'x' })
      .expect(403);

    expect(mockConnect).not.toHaveBeenCalled();
  });
});

/**
 * Named separately from the table above because it is about the table itself.
 * The two handlers are near-identical, so a case added to one and forgotten in
 * the other is the likely failure. This fails if the table ever stops covering
 * both routes - by name, rather than by a quiet drop in the test count.
 */
describe('the approve/reject ownership table', () => {
  it('covers both routes and not just one of them', () => {
    expect(ROUTES.map((r) => r.name).sort()).toEqual(['approve', 'reject']);
  });
});
