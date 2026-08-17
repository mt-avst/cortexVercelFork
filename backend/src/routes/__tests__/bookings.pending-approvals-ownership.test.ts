import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
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

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

// Typed as bare jest.Mock rather than `any`: this file is new, so it carries no
// suppression budget and a single `any` fails the repo lint.
const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * GET /pending-approvals gated on the admin ROLE and nothing else, while the
 * approve and reject endpoints beside it both check ownership - "You can only
 * approve sessions for your own opportunities".
 *
 * So every researcher_admin could read every other researcher's completed
 * sessions: participant names, participant EMAILS, and `admin_notes`, which is
 * a researcher's written judgement of a named colleague. The query already
 * selected `o.owner_user_id`; it simply never compared it to the caller.
 *
 * It also listed rows the reader could not act on - clicking Approve on
 * another researcher's session 403s - so the leak was showing people data that
 * was useless to them as well as not theirs.
 *
 * Superadmins keep seeing everything, matching approve and reject exactly.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';
type SessionUserStub = { id: string; name: string; email: string; role: Role };

const appAs = (role: Role, id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Through `unknown`: express types `session` as a real Session, and this
    // harness only needs the `user` the route reads off it.
    (req as unknown as { session: { user: SessionUserStub } }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

describe('GET /api/bookings/pending-approvals ownership', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue({ rows: [] } as never);
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
  });

  const listQuery = () =>
    mockQuery.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .find((q: string) => q.includes('completion_status'));

  const listParams = () =>
    mockQuery.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('completion_status')
    )?.[1] as unknown[] | undefined;

  it('asks the database only for the caller\'s own opportunities', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'researcher_admin' }] } as never);

    await request(appAs('researcher_admin', 'admin-1'))
      .get('/api/bookings/pending-approvals')
      .expect(200);

    // Filtered in SQL, not after the fact: a filter applied in JS still pulls
    // every other researcher's participant emails and admin_notes across the
    // wire and into this process.
    expect(listQuery()).toMatch(/owner_user_id\s*=\s*\$1/);
    expect(listParams()).toContain('admin-1');
  });

  it('does not filter for a superadmin, who approves any session anyway', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'superadmin' }] } as never);

    await request(appAs('superadmin', 'super-1'))
      .get('/api/bookings/pending-approvals')
      .expect(200);

    expect(listQuery()).not.toMatch(/owner_user_id\s*=\s*\$1/);
  });

  it('still refuses a non-admin outright', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'employee' }] } as never);

    const response = await request(appAs('employee', 'user-1'))
      .get('/api/bookings/pending-approvals')
      .expect(403);

    expect(response.body.error).toBe('Only admins can view pending approvals');
  });

  it('returns what the filtered query returns, and nothing added afterwards', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'researcher_admin' }] } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          booking_id: 'b1',
          user_email: 'participant@example.com',
          admin_notes: 'Struggled with the export step',
          owner_user_id: 'admin-1',
        },
      ],
    } as never);

    const response = await request(appAs('researcher_admin', 'admin-1'))
      .get('/api/bookings/pending-approvals')
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].booking_id).toBe('b1');
  });
});
