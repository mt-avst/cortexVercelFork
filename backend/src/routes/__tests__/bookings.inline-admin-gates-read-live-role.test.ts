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

// The cancel handler emails the participant and the owner after it commits,
// inside try/catch, so an unmocked failure would be swallowed rather than
// failing an arm here.
jest.mock('../../services/email', () => ({
  __esModule: true,
  default: { sendEmail: jest.fn() },
  EmailService: {
    getBookingCancellationTemplate: jest.fn(),
    getAdminNotificationTemplate: jest.fn(),
  },
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * THE SESSION ROLE IS NOT THE ROLE. cto/AdaptaLabs#37.
 *
 * #14 made `requireAdmin`/`requireSuperadmin` re-read the caller's role from
 * `users` on every request, so revoking an admin takes effect at once instead
 * of when their cookie expires. Two bookings routes were outside that fix:
 * both sat on `requireAuth` and computed `isAdmin` inline from
 * `req.user.role`, which is a copy of the role stamped into the session at
 * LOGIN. A revoked admin kept both for up to SESSION_MAX_AGE_MS = 24h.
 *
 *   GET  /api/bookings/opportunities/:id/bookings - participant names, emails,
 *        business units and role titles for everyone booked onto a study.
 *   POST /api/bookings/:id/cancel - the admin branch, which cancels ANOTHER
 *        participant out of a session: slot lost, capacity decremented, the
 *        participant emailed, no undo and no audit row.
 *
 * DELIBERATELY DOES NOT `jest.mock('../../middleware/authenticate')`. Every
 * other bookings suite opts into the manual double so its positionally
 * sequenced `pool.query` mock is not shifted by the leading role read - which
 * means every other bookings suite is blind to exactly this defect. This one
 * drives the real middleware, and the role read is answered from the `users`
 * table like any other query.
 *
 * EVERY ARM IS PAIRED. `session` and `db` are separate knobs: a test that only
 * showed the revoked admin refused would pass just as well against a route
 * that refused everybody, so each refusal has a live-admin control on the same
 * fixture that differs in the DB role alone.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (sessionRole: Role, id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: Role } } }).session = {
      user: { id, name: 'A', email: 'a@example.com', role: sessionRole },
    };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/** Far enough ahead that the "cannot cancel past sessions" check never fires. */
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const LISTING = '/api/bookings/opportunities/opp-1/bookings';
const CANCEL = '/api/bookings/b1/cancel';

/**
 * One `pool.query` router for both routes, keyed on the SQL rather than call
 * order, so an arm cannot pass because a queued result happened to land in the
 * right slot.
 *
 * `dbRole` is what `users` actually says - the live role. It is answered to the
 * middleware's `SELECT role FROM users` and to nothing else.
 */
const database = (dbRole: Role, ownerUserId: string | null, participantId = 'participant-1') => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);

    if (text.includes('SELECT role FROM users')) {
      return { rows: [{ role: dbRole }] };
    }
    if (text.includes('FROM opportunities WHERE id')) {
      return { rows: [{ owner_user_id: ownerUserId }] };
    }
    if (text.includes('participant_email') && text.includes('FROM bookings b')) {
      return {
        rows: [
          {
            id: 'b1',
            user_id: participantId,
            session_id: 's1',
            status: 'booked',
            gcal_event_id: null,
            start_time: FUTURE,
            end_time: FUTURE,
            session_start_time: FUTURE,
            session_end_time: FUTURE,
            created_at: FUTURE,
            updated_at: FUTURE,
            opportunity_id: 'opp-1',
            owner_user_id: ownerUserId,
            opportunity_title: 'A study',
            owner_name: 'Owner',
            owner_email: 'owner@example.com',
            participant_name: 'Sam Participant',
            participant_email: 'sam@example.com',
            business_unit: 'Ops',
            role_title: 'Analyst',
          },
        ],
      };
    }
    return { rows: [] };
  });
};

/** The transaction client `pool.connect()` hands back for the cancel path. */
const makeClient = () => {
  const query = jest.fn(async (sql: unknown) =>
    String(sql).toUpperCase().includes('UPDATE BOOKINGS')
      ? { rows: [{ session_id: 's1' }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
  return { query, release: jest.fn() };
};

const cancellingUpdates = (client: { query: jest.Mock }) =>
  client.query.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((sql: string) => sql.includes('UPDATE bookings'));

/** The read that carries participant identities, as distinct from the ownership probe. */
const identityQueryRan = () =>
  mockQuery.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .some((sql: string) => sql.includes('participant_email'));

describe('bookings inline admin gates read the live role', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    client = makeClient();
    mockConnect.mockResolvedValue(client as never);
  });

  describe('GET opportunities id bookings', () => {
    // THE CONTROL. Session and database agree that the caller is an admin, and
    // they own the opportunity, so the identities are served. Without this arm
    // the refusal below passes against a route that 403s everyone.
    it('serves a still-live admin the participant identities', async () => {
      database('researcher_admin', 'admin-1');

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(LISTING)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].participant_email).toBe('sam@example.com');
    });

    it('refuses an admin whose database role was downgraded after login', async () => {
      // Same owner, same session cookie, one knob moved: `users.role` now says
      // employee. Pre-#37 this answered 200 with every participant's email.
      database('employee', 'admin-1');

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(LISTING)
        .expect(403);

      expect(res.body.error).toBe('Admin access required');
      // The absence-assertion, with the control above as its presence arm: a
      // filter applied after the read still pulls every email across the wire.
      expect(identityQueryRan()).toBe(false);
    });

    // Moved here from `bookings.test.ts`, which mocks the auth middleware and
    // therefore cannot see this. That suite asserted a `DB_CONNECTION_FAILED`
    // code, which was the handler's own outage answer; the gate's role read now
    // runs first and fails first, so production sends this body instead. An
    // assertion that only passes because the gate is mocked out documents
    // behaviour the route does not have.
    it('answers the gate outage rather than the handler outage during a database failure', async () => {
      mockQuery.mockRejectedValue(new Error('connection terminated') as never);

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(LISTING)
        .expect(503);

      expect(res.body.error).toBe('Authorization check failed');
      expect(res.body.code).toBeUndefined();
      expect(identityQueryRan()).toBe(false);
    });
  });

  describe('POST bookings id cancel', () => {
    // THE CONTROL for the admin branch specifically - the caller is not the
    // participant, so only the admin term can admit them.
    it('lets a still-live admin owner cancel another participant booking', async () => {
      database('researcher_admin', 'admin-1');

      await request(listening(appAs('researcher_admin', 'admin-1')))
        .post(CANCEL)
        .expect(200);

      expect(cancellingUpdates(client)).toHaveLength(1);
    });

    it('refuses the admin cancel branch to a downgraded admin', async () => {
      database('employee', 'admin-1');

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .post(CANCEL)
        .expect(403);

      expect(res.body.error).toBe('Not authorized to cancel this booking');
      expect(cancellingUpdates(client)).toHaveLength(0);
    });

    // The OTHER direction, and it needs its own arm: a live-role read that
    // simply refused everyone whose session role outranked their DB role would
    // satisfy both arms above. Cancelling your own booking is not an admin
    // action and must survive the re-read untouched.
    it('still lets a participant cancel their own booking', async () => {
      database('employee', 'admin-1', 'participant-1');

      await request(listening(appAs('employee', 'participant-1')))
        .post(CANCEL)
        .expect(200);

      expect(cancellingUpdates(client)).toHaveLength(1);
    });

    // Fails closed, matching `currentDbRole`'s contract for the #14 gates: if
    // the role cannot be read, the admin branch is not guessed at.
    it('refuses the cancel route outright when the role read fails', async () => {
      mockQuery.mockRejectedValue(new Error('connection terminated') as never);

      await request(listening(appAs('researcher_admin', 'admin-1')))
        .post(CANCEL)
        .expect(503);

      expect(cancellingUpdates(client)).toHaveLength(0);
    });
  });
});
