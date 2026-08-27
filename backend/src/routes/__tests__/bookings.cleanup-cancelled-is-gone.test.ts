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
 * NOTHING IS LOST. `GET /api/bookings/my/bookings/all` returns a superset -
 * the caller's bookings including cancelled ones - owner-scoped by the same
 * `WHERE b.user_id = $1`. The last two arms below pin that, so the claim that
 * this deletion costs nothing is asserted rather than asserted-in-prose.
 *
 * THAT ROUTE WAS `GET /api/bookings/my/bookings/debug` UNTIL cto/AdaptaLabs#54,
 * and the rename is the point of #54 rather than an incidental tidy. This
 * docblock is the argument that #49's deletion cost nothing, and it rests
 * entirely on that route continuing to exist - while the route's own name told
 * the next reader it was disposable. #54 considered deleting it and rewriting
 * this argument from first principles, and chose the smaller, truer change:
 * the route keeps its gate, its statement and its response, and loses the name
 * that invited a confident wrong cleanup. So this argument is unchanged in
 * substance; only the URL it names has moved.
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

  it('answers 404 on the old debug spelling of the superset route', async () => {
    // #54 renamed `/my/bookings/debug` to `/my/bookings/all`. Without this arm
    // the rename could have been a COPY - the old path left mounted beside the
    // new one - and the arm below would pass identically while the name the
    // rename existed to remove was still being served. Its control is that
    // arm: the new path answers 200 on the same router in the same file.
    await request(listening(appAs('employee', CALLER_ID)))
      .get('/api/bookings/my/bookings/debug')
      .expect(404);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('leaves the caller their cancelled bookings on the all route scoped to their own id', async () => {
    // THE REPLACEMENT, asserted rather than promised. This is the capability
    // the deleted route provided, and it is owner-scoped by the caller's id -
    // which is also the evidence for the triage verdict that the deleted route
    // was never an escalation in the first place.
    mockQuery.mockResolvedValue({ rows: [CANCELLED_ROW] } as never);

    const res = await request(listening(appAs('employee', CALLER_ID)))
      .get('/api/bookings/my/bookings/all')
      .expect(200);

    // The presence control: the fixture DOES come back, so the scoping
    // assertions below are read off a call that actually returned rows.
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].status).toBe('cancelled');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE b.user_id = $1');
    // THE OWNER SCOPE IS `$1` AND STILL THE ONLY SCOPE. The three parameters
    // after it arrived with cto/AdaptaLabs#66, which made this route a keyset
    // PAGE: `$2` is the page size plus a probe row, `$3`/`$4` are the
    // `?before=` cursor and are null on the first page. Asserted in full rather
    // than by index, so a fifth parameter - or the owner id moving out of `$1` -
    // fails here. The page arithmetic itself is pinned in
    // bookings.all-is-paged.test.ts, and the real cursor walk in
    // bookings-all-keyset-postgres.test.ts.
    expect(params).toEqual([CALLER_ID, 101, null, null]);
  });

  it('says nothing about "debug" to the caller, including on the 500 path', async () => {
    // #54's defect was a NAME telling the next reader this route is
    // disposable, and renaming the path left that name being served anyway:
    // the catch block answered `{"error":"Failed to fetch debug bookings"}`.
    // A refute gate on !270 found it because nothing asserted it - `git grep
    // "Failed to fetch debug\|fetching debug"` over every tracked file
    // returned those two lines and nothing else, so the rename was incomplete
    // and the whole suite was green.
    //
    // The error path rather than the happy path, because that is where the
    // string actually lived, and a route's 500 body is client-visible.
    mockQuery.mockRejectedValue(new Error('connection terminated') as never);

    const res = await request(listening(appAs('employee', CALLER_ID)))
      .get('/api/bookings/my/bookings/all')
      .expect(500);

    // THE CONTROL: the error path really was taken, so the absence below is
    // read off the response that carries the string rather than off a 200.
    expect(res.body.error).toBeTruthy();
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('debug');
  });

  it('sends no researcher-only column to the caller, whatever the row carries', async () => {
    // OWNER-SCOPED IS NOT THE SAME AS SAFE TO SPREAD. The bookings row holds
    // `admin_notes` - a researcher's free-text judgement about this
    // participant, written on a surface labelled "Admin Notes (Optional)" -
    // plus `approved_by` and `approved_at`. `WHERE b.user_id = $1` keeps
    // another user's row out; it does nothing about which of the caller's OWN
    // columns reach the caller's browser. This repository has already shipped
    // that leak once on the sibling route, recorded at learnings.md:349.
    //
    // WHY THIS ARM EXISTS. The route used `SELECT b.*` and relied entirely on
    // the response map to drop those three fields, and a refute gate on !270
    // proved the map was an unguarded guard: adding
    // `admin_notes: booking.admin_notes` to it measured 1313 passed / 1313 on
    // both the mutated and the baseline tree, interleaved. The leak was
    // invisible to all 78 backend suites.
    //
    // So the fixture below carries all three fields even though the narrowed
    // projection means production never selects them - a test that only fed
    // the columns the query asks for could not tell a narrowed projection from
    // a lucky one, and would go green again the moment somebody widened it.
    mockQuery.mockResolvedValue({
      rows: [
        {
          ...CANCELLED_ROW,
          admin_notes: 'flaky attendance, do not re-invite',
          approved_by: 'researcher-9',
          approved_at: new Date('2026-01-03T09:00:00.000Z'),
          researcher_notes: 'froze up when asked about the dashboard',
        },
      ],
    } as never);

    const res = await request(listening(appAs('employee', CALLER_ID)))
      .get('/api/bookings/my/bookings/all')
      .expect(200);

    // THE CONTROL FOR THE ABSENCES BELOW, and without it they all pass against
    // an empty response, a 500 body or a route that returned nothing at all.
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].status).toBe('cancelled');

    // Over the whole serialised body rather than key-by-key, so a field
    // renamed on the way out - `notes`, `internal_notes` - is caught by its
    // VALUE even when its key is not one of the three below.
    const wire = JSON.stringify(res.body);
    for (const secret of [
      'admin_notes',
      'approved_by',
      'approved_at',
      'flaky attendance, do not re-invite',
      'researcher-9',
      'researcher_notes',
      'froze up when asked about the dashboard',
    ]) {
      expect({ secret, onTheWire: wire.includes(secret) }).toEqual({
        secret,
        onTheWire: false,
      });
    }

    // AND THE PROJECTION, which is where the class is closed rather than the
    // instance. A column never selected cannot be mapped out by accident, so
    // the map stops being the only thing between a researcher's notes and a
    // participant's Network tab.
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('b.*');
    expect(sql).toContain('b.id, b.session_id, b.status, b.created_at, b.cancelled_at');
  });
});
