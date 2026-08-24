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

// The handler emails the participant and the opportunity's owner after it
// commits. Both calls sit inside `try`/`catch`, so an unmocked failure would
// be swallowed rather than failing a test - which is exactly why this is
// mocked rather than left to fall over quietly on a machine with no SMTP.
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
 * POST /api/bookings/:id/cancel IS A WRITE, AND ITS OWNER TERM WAS HELD BY NO
 * TEST. Neutering `(isAdmin && isOpportunityOwner(booking, req.user))` to
 * `(isAdmin && true)` passed 919 of 919 jest tests on 6504612 - measured, one
 * gate at a time, tree clean before and after.
 *
 * What that admits is a researcher_admin cancelling a colleague's participant
 * out of a session they have nothing to do with: the participant loses their
 * slot, `booked_count` is decremented, the participant is emailed a
 * cancellation naming the caller as the person who did it, and the real owner
 * is emailed a participant-cancelled notice naming the participant. There is
 * no undo and no audit row.
 *
 * That sentence used to say both of them were emailed "a cancellation naming
 * the caller", and it was wrong in a different way before and after the fix
 * that put the participant in scope. The two mails are different templates:
 * `getBookingCancellationTemplate` has a `cancelledBy` parameter and
 * `getAdminNotificationTemplate` does not, so the owner is never told who
 * cancelled. Two gates caught the wording independently.
 *
 * OUT OF SCOPE OF cto/AdaptaLabs#21, which pinned the participant-data READ
 * gates. This one was unpinned before that work and stayed unpinned; nothing
 * regressed.
 *
 * THE GATE HAS THREE TERMS AND EVERY ONE IS LOAD-BEARING:
 *
 *   booking.user_id === userId || (isAdmin && isOpportunityOwner(booking, ...))
 *
 * Dropping any one of them fails open in a different direction - the
 * participant's own cancellation, an admin who owns nothing, a non-admin who
 * happens to own the opportunity - so each gets its own arm below rather than
 * one arm standing in for the shape.
 *
 * THIS ROUTE HAS NO SUPERADMIN BYPASS. `isAdmin` includes superadmin, but the
 * ownership term then applies to them identically, so a superadmin who does
 * not own the opportunity is refused. That matches
 * `GET /api/bookings/opportunities/:id/bookings` and differs from most of the
 * sessions routes, which do carry a bypass. Pinned below in both directions so
 * that whichever way a future reader resolves the asymmetry, they do it on
 * purpose rather than by deleting a line.
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

const PATH = '/api/bookings/b1/cancel';

/** Far enough ahead that the "cannot cancel past sessions" check never fires. */
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

/**
 * The booking the handler loads, in one place.
 *
 * `participantId` and `ownerUserId` are separate knobs on purpose: every arm
 * below is about which of the two - if either - the caller is.
 */
const bookingLoads = (participantId: string, ownerUserId: string | null) => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes('FROM bookings b')) {
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
            opportunity_id: 'opp-1',
            owner_user_id: ownerUserId,
            opportunity_title: 'A study',
            owner_name: 'Owner',
            owner_email: 'owner@example.com',
            // The handler now joins `b.user_id` as well, so the participant is
            // in scope and receives the cancellation. Carried here to keep this
            // fixture the shape the statement actually returns; what those
            // recipients are is asserted in
            // bookings.cancel-notifies-participant.test.ts, not here.
            participant_name: 'Participant',
            participant_email: 'participant@example.com',
          },
        ],
      };
    }
    // The notification-preferences read on the post-commit email path.
    return { rows: [] };
  });
};

/** The transaction client `pool.connect()` hands back. */
const makeClient = () => {
  // rowCount 1 = the cancel UPDATE transitioned exactly one booked row, which
  // is what gates the decrement (see the handler's `AND status = 'booked'`
  // guard). A racing double-cancel would see rowCount 0 here; that path is
  // pinned in bookings.cancel-writes-are-row-scoped.test.ts.
  const query = jest.fn(async () => ({ rows: [], rowCount: 1 }));
  return { query, release: jest.fn() };
};

const statementsOn = (client: { query: jest.Mock }) =>
  client.query.mock.calls.map((call: unknown[]) => String(call[0]));

const cancellingUpdates = (client: { query: jest.Mock }) =>
  statementsOn(client).filter((sql) => sql.includes('UPDATE bookings'));

/**
 * The capacity decrement, matched in ONE place so both of its arms move
 * together.
 *
 * It is a separate matcher from `cancellingUpdates` because the two writes
 * fail apart: a gate that stopped the status change but not the decrement
 * would leave the booking live while `sessions.booked_count` fell, so the
 * session shows a free slot that is not free. Both arms below call THIS
 * function rather than inlining the string - if the SQL is reworded or the
 * column renamed, the presence arm goes red and names itself, instead of the
 * absence arm quietly becoming a tautology that can never fail.
 */
const capacityDecrements = (client: { query: jest.Mock }) =>
  statementsOn(client).filter((sql) => sql.includes('booked_count'));

describe('POST /api/bookings/:id/cancel ownership', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    client = makeClient();
    mockConnect.mockResolvedValue(client as never);
  });

  // ------------------------------------------------------------------
  // THE CONTROLS. Without these, a handler that 403'd unconditionally - or one
  // whose mocked load returned nothing, so every call 404'd - would satisfy
  // every refusal assertion below while proving nothing about ownership. They
  // are also the presence arms for the absence-assertions further down: they
  // show this exact fixture DOES produce one `UPDATE bookings` and DOES open a
  // transaction, when the caller is entitled to.
  // ------------------------------------------------------------------

  it('lets the opportunity owner cancel a participant booking', async () => {
    bookingLoads('participant-1', 'admin-1');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(PATH)
      .expect(200);

    expect(cancellingUpdates(client)).toHaveLength(1);
    // THE PRESENCE CONTROL for the absence-assertion further down. Without it
    // that arm passes whether the decrement was suppressed or the matcher
    // simply stopped matching, and those are not the same observation.
    expect(capacityDecrements(client)).toHaveLength(1);
    expect(statementsOn(client)).toContain('COMMIT');
  });

  it('lets the participant cancel their own booking', async () => {
    // The first term of the gate, and it needs its own control: an admin-only
    // reading of this route would refuse every participant cancelling their
    // own slot, and no other arm here would notice.
    bookingLoads('participant-1', 'admin-1');

    await request(listening(appAs('employee', 'participant-1')))
      .post(PATH)
      .expect(200);

    expect(cancellingUpdates(client)).toHaveLength(1);
  });

  // ------------------------------------------------------------------
  // THE REFUSALS.
  // ------------------------------------------------------------------

  it('refuses a researcher_admin who does not own the opportunity', async () => {
    bookingLoads('participant-1', 'admin-2');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(PATH)
      .expect(403);

    expect(res.body.error).toBe('Not authorized to cancel this booking');
  });

  // The absence-assertion. BOTH of its matchers have a presence arm on the
  // owner control above, asserting exactly one statement each from this same
  // fixture - `cancellingUpdates` for the status change and
  // `capacityDecrements` for the slot. An absence-assertion whose matcher has
  // no presence arm passes identically when the write was refused and when the
  // matcher went stale, and only one of those is the property.
  it('writes nothing and opens no transaction for a non-owning admin', async () => {
    bookingLoads('participant-1', 'admin-2');

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(PATH)
      .expect(403);

    expect(mockConnect).not.toHaveBeenCalled();
    expect(cancellingUpdates(client)).toHaveLength(0);
    expect(capacityDecrements(client)).toHaveLength(0);
  });

  it('refuses a superadmin who does not own the opportunity, which is this route', async () => {
    // No bypass here, unlike the sessions routes. If someone adds one, this
    // fails by name and they have to mean it.
    bookingLoads('participant-1', 'admin-2');

    await request(listening(appAs('superadmin', 'root-1')))
      .post(PATH)
      .expect(403);

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('lets a superadmin cancel only when they own the opportunity', async () => {
    // The mirror of the arm above, and what makes it about ownership rather
    // than about superadmins being refused everything on this route.
    bookingLoads('participant-1', 'root-1');

    await request(listening(appAs('superadmin', 'root-1')))
      .post(PATH)
      .expect(200);

    expect(cancellingUpdates(client)).toHaveLength(1);
  });

  it('refuses a non-admin who owns the opportunity but did not book', async () => {
    // The `isAdmin` term, alone. Owning the opportunity is not sufficient -
    // both halves of the second disjunct are required - and without this arm
    // dropping `isAdmin` would pass every other case in this file.
    bookingLoads('participant-1', 'owner-1');

    await request(listening(appAs('employee', 'owner-1')))
      .post(PATH)
      .expect(403);

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('refuses an admin cancelling an ownerless booking rather than adopting it', async () => {
    // DEFENCE IN DEPTH, AND SAID AS THAT. The load `JOIN users u ON
    // o.owner_user_id = u.id` is an INNER join, so an opportunity with no
    // owner produces no row here and 404s before the gate is reached - this
    // pair is not reachable through Postgres today. What the arm pins is the
    // disposition: if that join ever becomes a LEFT JOIN, or the column is
    // added to a different load, an absent owner must not read as a match.
    // `canWriteStudy` fails OPEN for an unowned study because a write can
    // adopt the row; cancelling somebody else's booking adopts nothing.
    bookingLoads('participant-1', null);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(PATH)
      .expect(403);

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('refuses an unrelated employee who neither booked nor owns', async () => {
    bookingLoads('participant-1', 'admin-1');

    await request(listening(appAs('employee', 'bystander-1')))
      .post(PATH)
      .expect(403);

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('refuses a non-owner even when the booking is already cancelled', async () => {
    // The "already cancelled" short-circuit answers 200 with a message, and it
    // sits AFTER the gate. If the two were ever reordered, a non-owner would
    // learn that a given booking id exists and has been cancelled - a small
    // leak, but the ordering is the thing being pinned.
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM bookings b')) {
        return {
          rows: [
            {
              id: 'b1',
              user_id: 'participant-1',
              session_id: 's1',
              status: 'cancelled',
              gcal_event_id: null,
              end_time: FUTURE,
              owner_user_id: 'admin-2',
              opportunity_title: 'A study',
              owner_name: 'Owner',
              owner_email: 'owner@example.com',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(PATH)
      .expect(403);

    expect(res.body.error).toBe('Not authorized to cancel this booking');
  });

  it('404s a booking that does not exist, before deciding anything about ownership', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(PATH)
      .expect(404);

    expect(mockConnect).not.toHaveBeenCalled();
  });
});
