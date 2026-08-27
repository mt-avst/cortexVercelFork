import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14/#37: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gates now re-read the DB role, which their positional pool mock cannot satisfy.
// Liveness for these two routes is pinned in bookings.inline-admin-gates-read-live-role.test.ts.
jest.mock('../../middleware/authenticate');
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

const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * GET /api/bookings/opportunities/:id/bookings returns, for every participant
 * who booked: their NAME, their EMAIL, their BUSINESS UNIT and their ROLE
 * TITLE. The owner check in front of it was held by no test at all - deleting
 * it passed 844 of 844 jest tests, `tsc` clean. Measured on e717537, one gate
 * at a time.
 *
 * This route USED to be the odd one out in the trust model: it admitted the
 * opportunity owner and nobody else, not even a superadmin. An earlier version
 * of this file pinned that asymmetry "so that whichever way a future reader
 * decides to resolve it, they have to do it on purpose". #79 resolved it on
 * purpose: the roster is now owner-or-superadmin, matching the recorded trust
 * model (#10: owners and superadmins see participant data) and the
 * approve/reject gates fifty lines down, because the Participants tab this
 * route now feeds is served to superadmins on every other opportunity surface.
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

const PATH = '/api/bookings/opportunities/opp-1/bookings';

/** The query that carries the identities, as distinct from the ownership probe. */
const participantQuery = () =>
  mockQuery.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .find((q: string) => q.includes('participant_email'));

describe('GET /api/bookings/opportunities/:id/bookings ownership', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
  });

  /** The ownership probe answers with `owner`, then the identity read answers. */
  const ownedBy = (owner: string | null) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: owner }] } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'b1',
          participant_name: 'Sam Participant',
          participant_email: 'sam@example.com',
          business_unit: 'Ops',
          role_title: 'Analyst',
          session_start_time: new Date('2026-01-01T10:00:00Z'),
          session_end_time: new Date('2026-01-01T11:00:00Z'),
          created_at: new Date('2026-01-01T09:00:00Z'),
          updated_at: new Date('2026-01-01T09:00:00Z'),
          cancelled_at: null,
        },
      ],
    } as never);
  };

  // THE CONTROL. Without this arm, a handler that answered 403 unconditionally
  // - or that threw before it reached the database - would satisfy every
  // refusal assertion below. This is the arm that proves the refusals are
  // about ownership and not about the route being broken.
  it('serves the owner the participant identities', async () => {
    ownedBy('admin-1');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(PATH)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].participant_email).toBe('sam@example.com');
    expect(participantQuery()).toBeDefined();
  });

  // THE READ HALF OF #79, which nothing else asserts. A refute gate measured
  // the gap: making this route answer `researcher_notes: null` passed 93
  // suites / 1537 tests, and so did dropping the `researcher_notes_updated_at`
  // serialisation. The write is well pinned; without this, a later narrowing
  // of `SELECT b.*` to an explicit column list - which this file's sibling
  // actively campaigns for - would render empty boxes over stored notes, and
  // a researcher typing into one would overwrite what was there.
  it('returns the researcher note and its timestamp to the owner', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'admin-1' }] } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'b1',
          participant_name: 'Sam Participant',
          participant_email: 'sam@example.com',
          business_unit: 'Ops',
          role_title: 'Analyst',
          session_start_time: new Date('2026-01-01T10:00:00Z'),
          session_end_time: new Date('2026-01-01T11:00:00Z'),
          created_at: new Date('2026-01-01T09:00:00Z'),
          updated_at: new Date('2026-01-01T09:00:00Z'),
          cancelled_at: null,
          researcher_notes: 'froze up when asked about the dashboard',
          researcher_notes_updated_at: new Date('2026-01-01T11:05:00Z'),
        },
      ],
    } as never);

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(PATH)
      .expect(200);

    expect(res.body[0].researcher_notes).toBe('froze up when asked about the dashboard');
    expect(res.body[0].researcher_notes_updated_at).toBe('2026-01-01T11:05:00.000Z');
  });

  it('refuses a researcher_admin who does not own the opportunity', async () => {
    ownedBy('admin-2');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(PATH)
      .expect(403);

    expect(res.body.error).toBe('Only the owner or a superadmin can view bookings for this opportunity');
  });

  // The absence-assertion, with the control above proving it can be present.
  // A filter applied after the read still pulls every participant's email
  // across the wire and into this process, and into any log that touches it.
  it('never runs the identity query for a non-owner', async () => {
    ownedBy('admin-2');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(PATH)
      .expect(403);

    expect(participantQuery()).toBeUndefined();
  });

  it('serves a superadmin the roster for an opportunity they do not own', async () => {
    ownedBy('admin-2');

    const res = await request(listening(appAs('superadmin', 'root-1')))
      .get(PATH)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(participantQuery()).toBeDefined();
  });

  it('refuses an ownerless opportunity rather than adopting it', async () => {
    // `canWriteStudy` fails OPEN for an unowned row so legacy studies stay
    // editable. A READ cannot adopt a row that way: there is nobody to hold
    // accountable for the participants named in it.
    ownedBy(null);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(PATH)
      .expect(403);

    expect(participantQuery()).toBeUndefined();
  });

  it('refuses a non-admin before it looks the opportunity up at all', async () => {
    const res = await request(listening(appAs('employee', 'user-1')))
      .get(PATH)
      .expect(403);

    expect(res.body.error).toBe('Admin access required');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('404s an opportunity that does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(PATH)
      .expect(404);

    expect(participantQuery()).toBeUndefined();
  });
});
