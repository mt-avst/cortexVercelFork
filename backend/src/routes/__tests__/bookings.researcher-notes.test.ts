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

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';
import { VALIDATION } from '../../../../shared/constants';

const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * PUT /:bookingId/notes writes `researcher_notes` - a researcher's running
 * observations about a named colleague's moderated session (#79). The write is
 * gated exactly as approve/reject are: a live-role admin check, then owner or
 * superadmin on the opportunity the booking belongs to.
 *
 * The cases below are the same shape as
 * bookings.approve-reject-ownership.test.ts because the routes are siblings:
 * the field is the point (free text about a person), so the refusals carry
 * no-UPDATE arms, not just status codes.
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

const PATH = '/api/bookings/b1/notes';

/**
 * Answers the handler's queries in order: the live-role read, then the
 * booking+owner read, then the UPDATE. The role passed here is the LIVE one -
 * the session role in `appAs` is what the caller claims, and the difference is
 * itself a case below.
 */
const respondsWith = (liveRole: Role | null, ownerUserId: string | null | 'missing') => {
  mockQuery.mockResolvedValueOnce({
    rows: liveRole === null ? [] : [{ role: liveRole }],
  } as never);
  if (ownerUserId !== 'missing') {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'b1', owner_user_id: ownerUserId }],
    } as never);
  } else {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
  }
  mockQuery.mockResolvedValueOnce({
    rows: [
      {
        researcher_notes: 'observed hesitation on step 2',
        researcher_notes_updated_at: new Date('2026-08-27T10:00:00.000Z'),
      },
    ],
  } as never);
};

const updateStatements = () =>
  mockQuery.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((sql: string) => sql.includes('UPDATE bookings'));

describe('PUT /api/bookings/:bookingId/notes', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
  });

  // THE CONTROL for every refusal below: the write path genuinely works, so a
  // 403 elsewhere is about the gate and not about the route being broken.
  it('lets the opportunity owner write the note, row-scoped', async () => {
    respondsWith('researcher_admin', 'admin-1');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'observed hesitation on step 2' })
      .expect(200);

    expect(res.body.researcher_notes).toBe('observed hesitation on step 2');
    expect(res.body.researcher_notes_updated_at).toBe('2026-08-27T10:00:00.000Z');

    const updates = updateStatements();
    expect(updates).toHaveLength(1);
    // Row-scoped by id, and the id is a bound parameter - the same pin every
    // other bookings write carries (bookings.cancel-writes-are-row-scoped).
    expect(updates[0]).toContain('WHERE id =');
    const updateCall = mockQuery.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('UPDATE bookings')
    ) as unknown[];
    expect(updateCall[1]).toEqual(['observed hesitation on step 2', 'admin-1', 'b1']);
  });

  it('lets a superadmin write a note on an opportunity they do not own', async () => {
    respondsWith('superadmin', 'admin-2');

    await request(listening(appAs('superadmin', 'root-1')))
      .put(PATH)
      .send({ researcher_notes: 'covering for the owner' })
      .expect(200);

    expect(updateStatements()).toHaveLength(1);
  });

  it('refuses a researcher_admin who does not own the opportunity, without writing', async () => {
    respondsWith('researcher_admin', 'admin-2');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'should never land' })
      .expect(403);

    expect(res.body.error).toBe('You can only edit notes for your own studies');
    expect(updateStatements()).toHaveLength(0);
  });

  it('refuses an ownerless opportunity for a researcher_admin rather than adopting it', async () => {
    respondsWith('researcher_admin', null);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'nobody owns this' })
      .expect(403);

    expect(updateStatements()).toHaveLength(0);
  });

  it('refuses a caller whose LIVE role is employee, whatever the session says', async () => {
    // The session claims researcher_admin; the users table says employee. The
    // live role is the one that decides (authenticate.ts:70 family).
    respondsWith('employee', 'admin-1');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'demoted since login' })
      .expect(403);

    expect(res.body.error).toBe('Only admins can edit researcher notes');
    expect(updateStatements()).toHaveLength(0);
  });

  it('refuses a caller whose LIVE role dropped from superadmin, on an opportunity they do not own', async () => {
    // The SUPERADMIN half of the liveness check, which the admin half's
    // canary entry does not cover: a refute gate showed that deciding
    // `isSuperadmin` from `req.user!.role` - the LOGIN SNAPSHOT, since this
    // route sits on `requireAuth` alone - passed all 1537 backend tests. A
    // superadmin demoted since login would keep writing notes on any
    // opportunity for the life of their session.
    respondsWith('researcher_admin', 'admin-2');

    const res = await request(listening(appAs('superadmin', 'root-1')))
      .put(PATH)
      .send({ researcher_notes: 'demoted since login' })
      .expect(403);

    expect(res.body.error).toBe('You can only edit notes for your own studies');
    expect(updateStatements()).toHaveLength(0);
  });

  it('404s a booking deleted between the ownership read and the write', async () => {
    // Reachable: DELETE /opportunities/:id/sessions removes bookings by
    // session id. Without a length check the handler dereferences
    // `rows[0].researcher_notes` and the caller gets a 500 built from a
    // TypeError.
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'researcher_admin' }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'b1', owner_user_id: 'admin-1' }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'raced a delete' })
      .expect(404);

    expect(res.body.error).toBeTruthy();
  });

  it('404s a booking that does not exist, without writing', async () => {
    respondsWith('researcher_admin', 'missing');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'no such booking' })
      .expect(404);

    expect(updateStatements()).toHaveLength(0);
  });

  it('refuses a note over the ceiling rather than truncating it', async () => {
    respondsWith('researcher_admin', 'admin-1');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'x'.repeat(VALIDATION.MAX_RESEARCHER_NOTES_CHARS + 1) })
      .expect(400);

    expect(res.body.error).toBeTruthy();
    expect(updateStatements()).toHaveLength(0);
  });

  it('accepts a note exactly at the ceiling', async () => {
    respondsWith('researcher_admin', 'admin-1');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'x'.repeat(VALIDATION.MAX_RESEARCHER_NOTES_CHARS) })
      .expect(200);

    expect(updateStatements()).toHaveLength(1);
  });

  // The ceiling is policy, so it is pinned as a LITERAL. A test that derived
  // its expectation from the constant could not see the constant change
  // (rules/common/testing.md, "Pin policy constants as literals").
  it('pins the ceiling at 20000 characters', () => {
    expect(VALIDATION.MAX_RESEARCHER_NOTES_CHARS).toBe(20000);
  });

  it('refuses a body with unexpected keys', async () => {
    // The PATCH /api/sessions injection (!222) came in through body KEYS.
    // This body never builds SQL, but a strict schema is the shape that stays
    // true when somebody later widens the write.
    respondsWith('researcher_admin', 'admin-1');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 'fine', completion_status: 'approved' })
      .expect(400);

    expect(updateStatements()).toHaveLength(0);
  });

  it('refuses a missing or non-string note', async () => {
    respondsWith('researcher_admin', 'admin-1');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({})
      .expect(400);

    respondsWith('researcher_admin', 'admin-1');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: 42 })
      .expect(400);

    expect(updateStatements()).toHaveLength(0);
  });

  it('stores an empty note as NULL rather than as an empty string', async () => {
    respondsWith('researcher_admin', 'admin-1');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .put(PATH)
      .send({ researcher_notes: '' })
      .expect(200);

    const updateCall = mockQuery.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('UPDATE bookings')
    ) as unknown[];
    expect(updateCall[1]).toEqual([null, 'admin-1', 'b1']);
  });
});
