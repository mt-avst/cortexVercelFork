import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

import { listening } from '../../__tests__/helpers/listening';

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
 * `POST /api/bookings/cleanup-cancelled` IS DELETED, AND THIS IS WHY. #49.
 *
 * The route was raised as a possible privilege escalation: `requireAuth` alone
 * on something named "cleanup", where every sibling maintenance job -
 * `POST /api/sessions/sync-booked-counts` most obviously - is `superadmin`.
 * Nothing in the repository could see it before #13, because the old route
 * table imported three routers and this route was in none of them.
 *
 * IT WAS NOT AN ESCALATION. The handler issued exactly ONE statement, a
 * `SELECT ... FROM bookings b JOIN sessions s JOIN opportunities o WHERE
 * b.user_id = $1 AND b.status = 'cancelled'`, with `$1` bound to
 * `req.user!.id`. It could not read, let alone write, another user's row, and
 * it answered with five harmless fields. `requireAuth` was the correct gate for
 * what it actually did.
 *
 * SAID CAREFULLY, because an earlier draft of this comment said "projected five
 * columns rather than spreading `b.*`" and that was simply false: the statement
 * WAS `SELECT b.*, s.start_time, s.end_time, o.title ...`, so `admin_notes`,
 * `approved_by` and `approved_at` were all read out of the database. What kept
 * them off the wire was the RESPONSE MAP picking five fields by name, not the
 * projection list - the same distinction the `NOT b.*` comment on
 * `GET /api/bookings/my/bookings` further down this file was written about,
 * where the map was the thing that was missing. Nothing leaked either way, and
 * the route is gone regardless, but a docblock that credits the wrong mechanism
 * teaches the next reader the wrong lesson.
 *
 * WHAT IT DID WAS NOTHING. It cleaned nothing up: the only mutation in the file
 * was a commented-out `DELETE FROM bookings WHERE user_id = $1 AND status = $2`
 * sitting under "uncomment if needed". A route whose name promises a bulk
 * mutation, carrying a ready-made bulk mutation in a comment, on the weakest
 * gate in the vocabulary, is a loaded gun rather than a feature - the next
 * person to uncomment that line ships a destructive write on a route nobody
 * ever chose the gate for. Deleting the route is the only fix that closes that
 * for good; documenting it just re-arms it for the next reader.
 *
 * AND NOTHING CALLED IT. Grepped `cleanupCancelledBookings`,
 * `cleanup-cancelled` and `cleanup_cancelled` across the whole tree - every
 * file type, `node_modules` and `.git` excluded - plus a case-insensitive
 * `cleanup` sweep of `frontend/src`, `e2e`, `demo` and `scripts`. Four hits:
 * the route, its inventory entry, an unreferenced `cleanupCancelledBookings`
 * export in `frontend/src/api/client.ts` (deleted with it), and a row in
 * `docs/FORGE-CONFLUENCE-REBUILD-SPEC.md` already marked "optional". No
 * component, page, hook, test, script or spec imported the export.
 *
 * NOTHING IS LOST. `GET /api/bookings/my/bookings/debug` returns a superset -
 * the caller's bookings including cancelled ones - owner-scoped by the same
 * `WHERE b.user_id = $1`. The last arm below pins that, so the claim that this
 * deletion costs nothing is asserted rather than asserted-in-prose.
 *
 * The inventory in `authorisation-inventory.test.ts` walks the real mount graph
 * and compares whole maps, so a re-added route fails there too - but it fails
 * as a map diff. This file fails BY NAME and says what the decision was.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const CALLER_ID = 'participant-1';

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

const CANCELLED_ROW = {
  id: 'b1',
  session_id: 's1',
  status: 'cancelled',
  created_at: new Date('2026-01-01T09:00:00.000Z'),
  cancelled_at: new Date('2026-01-02T09:00:00.000Z'),
  opportunity_title: 'A study',
  opportunity_type: 'interview',
  session_start_time: new Date('2026-02-01T09:00:00.000Z'),
  session_end_time: new Date('2026-02-01T10:00:00.000Z'),
};

describe('bookings cleanup-cancelled is gone', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
  });

  it('answers 404 on POST api bookings cleanup-cancelled and runs no handler', async () => {
    const res = await request(listening(appAs('employee', CALLER_ID)))
      .post('/api/bookings/cleanup-cancelled')
      .expect(404);

    // The route is not merely refused, it is not mounted: no statement is
    // issued, because there is no handler to issue one. A re-added route
    // reaches the database and fails this line as well as the status.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(res.body.cancelled_bookings).toBeUndefined();
  });

  it('answers 404 for a superadmin too, so this is removal and not a gate', async () => {
    // Without this arm the arm above passes identically against a route that
    // had merely been raised to `requireSuperadmin` and answered 404 to an
    // employee. Deleted means deleted for everybody.
    await request(listening(appAs('superadmin', 'root-1')))
      .post('/api/bookings/cleanup-cancelled')
      .expect(404);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still answers GET api bookings my bookings on the same router', async () => {
    // THE CONTROL. Without it every 404 above is satisfied by a router that
    // was never mounted, a broken import or a harness that answers 404 to
    // everything - none of which is the property being pinned.
    mockIsDatabaseAvailable.mockResolvedValue(false as never);

    const res = await request(listening(appAs('employee', CALLER_ID)))
      .get('/api/bookings/my/bookings')
      .expect(200);

    expect(res.body).toEqual({ upcoming: [], past: [] });
  });

  it('leaves the caller their cancelled bookings on the debug route scoped to their own id', async () => {
    // THE REPLACEMENT, asserted rather than promised. This is the capability
    // the deleted route provided, and it is owner-scoped by the caller's id -
    // which is also the evidence for the triage verdict that the deleted route
    // was never an escalation in the first place.
    mockQuery.mockResolvedValue({ rows: [CANCELLED_ROW] } as never);

    const res = await request(listening(appAs('employee', CALLER_ID)))
      .get('/api/bookings/my/bookings/debug')
      .expect(200);

    // The presence control: the fixture DOES come back, so the scoping
    // assertions below are read off a call that actually returned rows.
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].status).toBe('cancelled');

    const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(sql).toContain('WHERE b.user_id = $1');
    expect(params).toEqual([CALLER_ID]);
  });
});
