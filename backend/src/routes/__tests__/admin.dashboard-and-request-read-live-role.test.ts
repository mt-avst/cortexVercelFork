import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import adminRouter from '../admin';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;

/**
 * A DEMOTION IS NOT A REVOCATION, AND THE GATE CANNOT SEE ONE. cto/AdaptaLabs#38.
 *
 * `GET /api/admin/dashboard` sat on `requireAuth`, which copies the role
 * stamped into the session at LOGIN, and then made THREE decisions from it:
 * the admin gate, `countsOwnerId`, and `participantIdentityOwnerId`. #14 and
 * #37 closed the same shape elsewhere; this handler was outside both.
 *
 * The gate is the least of it. A superadmin demoted to researcher_admin is
 * STILL AN ADMIN, so the gate admits them correctly - and the two scope
 * constants then read the same stale `superadmin` and resolve to `null`, which
 * is not a filter at all. They kept receiving GLOBAL counts and, in
 * `recent_bookings`, every other researcher's participant NAMES AND EMAILS,
 * for up to SESSION_MAX_AGE_MS = 24h. No gate anywhere could have caught that,
 * because they really were an admin.
 *
 * `POST /api/admin/request` had the milder half of the same read: a revoked
 * admin was told "You already have admin access" and could not ask for it back.
 *
 * DELIBERATELY DOES NOT `jest.mock('../../middleware/authenticate')`. The
 * sibling suite `admin.participant-identity-scope.test.ts` opts into the manual
 * double - which is why it cannot see this defect at all: the double answers
 * the session role and never queries `users`. This suite drives the real
 * middleware and answers the role read from the `users` table like any other
 * query.
 *
 * EVERY ARM IS PAIRED. `session` and `db` are separate knobs. An arm showing
 * the demoted caller scoped passes just as well against a handler that scopes
 * everybody, so each has a still-live control differing in the DB role alone.
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
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
};

const DASHBOARD = '/api/admin/dashboard';
const REQUEST = '/api/admin/request';

/** The caller's own participant, and one belonging to a different researcher. */
const OWN_PARTICIPANT = 'sam@example.com';
const OTHER_PARTICIPANT = 'rival-participant@example.com';

/**
 * Carries the column names of BOTH identity reads - the dashboard's
 * `recent_bookings` and the CSV export's row - so one fixture drives both.
 */
const bookingRow = (email: string, name: string) => ({
  id: `b-${email}`,
  opportunity_id: 'opp-1',
  opportunity_title: 'A study',
  opportunity_type: 'interview',
  session_start: new Date('2026-01-01T10:00:00Z'),
  session_end: new Date('2026-01-01T11:00:00Z'),
  participant_name: name,
  participant_email: email,
  status: 'booked',
  booking_status: 'booked',
  booked_at: new Date('2026-01-01T09:00:00Z'),
});

/**
 * One `pool.query` router keyed on the SQL rather than call order, so an arm
 * cannot pass because a queued result happened to land in the right slot.
 *
 * `dbRole` is what `users` actually says - the live role. It is answered to the
 * middleware's `SELECT role FROM users` and to nothing else.
 *
 * THE IDENTITY READ ANSWERS FROM THE DATABASE'S POINT OF VIEW, honouring the
 * owner parameter it is given. That is what makes the demotion arm an
 * observation of what crosses the wire rather than an assertion about a
 * variable: bound to `null` it returns the other researcher's participant too,
 * exactly as Postgres would for `($1::uuid IS NULL OR o.owner_user_id = $1)`.
 */
const database = (dbRole: Role) => {
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
    const text = String(sql);

    if (text.includes('SELECT role FROM users')) {
      return { rows: [{ role: dbRole }] };
    }
    if (text.includes('participant_email')) {
      const ownerId = (params as unknown[] | undefined)?.[0] ?? null;
      const rows =
        ownerId === null
          ? [bookingRow(OWN_PARTICIPANT, 'Sam Participant'), bookingRow(OTHER_PARTICIPANT, 'Rival Participant')]
          : [bookingRow(OWN_PARTICIPANT, 'Sam Participant')];
      return { rows };
    }
    if (text.includes('FROM admin_requests')) {
      return { rows: [] };
    }
    if (text.includes('INSERT INTO admin_requests')) {
      return { rows: [{ id: 'req-1', user_id: 'admin-1', status: 'pending' }] };
    }
    return { rows: [{}] };
  });
};

/** The one query in the dashboard handler whose select list carries identities. */
const identityCall = () =>
  mockQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('participant_email')) as
    | [string, unknown[]]
    | undefined;

/** Every dashboard query that returns only counts. */
const countCalls = () =>
  mockQuery.mock.calls.filter((call: unknown[]) => {
    const sql = String(call[0]);
    return sql.includes('COUNT(') && !sql.includes('participant_email');
  });

const emailsOnTheWire = (body: { data?: { recent_bookings?: Array<{ participant_email: string }> } }) =>
  (body.data?.recent_bookings ?? []).map((row) => row.participant_email);

describe('GET /api/admin/dashboard reads the live role', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // THE ARM THIS ISSUE IS ABOUT. The caller is still legitimately an admin, so
  // the gate admits them and can never be the thing that catches this. What
  // must change is the SCOPE: the demoted superadmin is a researcher_admin now
  // and must see only their own participants.
  it('scopes a demoted superadmin to their own participants', async () => {
    database('researcher_admin');

    const res = await request(listening(appAs('superadmin', 'admin-1')))
      .get(DASHBOARD)
      .expect(200);

    // WHAT CROSSED THE WIRE, not what a variable held. Pre-#38 this response
    // carried the other researcher's participant name and email.
    expect(emailsOnTheWire(res.body)).toEqual([OWN_PARTICIPANT]);
    expect(JSON.stringify(res.body)).not.toContain('Rival Participant');

    // And it was scoped in SQL rather than filtered afterwards: a JS filter has
    // already pulled every other researcher's participants into this process.
    const [sql, params] = identityCall()!;
    expect(sql).toMatch(/o\.owner_user_id\s*=\s*\$1/);
    expect(params).toEqual(['admin-1']);
  });

  // THE CONTROL for the arm above. Without it, that arm passes just as well
  // against a handler that scopes everybody and has no superadmin case left.
  it('still serves a live superadmin the whole platform', async () => {
    database('superadmin');

    const res = await request(listening(appAs('superadmin', 'root-1')))
      .get(DASHBOARD)
      .expect(200);

    expect(emailsOnTheWire(res.body)).toEqual([OWN_PARTICIPANT, OTHER_PARTICIPANT]);
    expect(identityCall()![1]).toEqual([null]);
  });

  // The counts are the OTHER stale decision, and it needs its own arm: the two
  // constants are separate declarations, so an arm on the identity read alone
  // leaves the counts free to keep reading the session role.
  it('scopes a demoted superadmin counts to their own opportunities', async () => {
    database('researcher_admin');

    await request(listening(appAs('superadmin', 'admin-1')))
      .get(DASHBOARD)
      .expect(200);

    expect(countCalls().length).toBeGreaterThan(0);
    for (const call of countCalls()) {
      const sql = String(call[0]);
      const params = call[1] as unknown[];
      const placeholder = sql.match(/owner_user_id\s*=\s*\$(\d)/);
      expect(placeholder).not.toBeNull();
      expect(params[Number(placeholder![1]) - 1]).toBe('admin-1');
    }
  });

  // THE CONTROL for the counts arm.
  it('leaves a live superadmin counts unscoped', async () => {
    database('superadmin');

    await request(listening(appAs('superadmin', 'root-1')))
      .get(DASHBOARD)
      .expect(200);

    expect(countCalls().length).toBeGreaterThan(0);
    for (const call of countCalls()) {
      const params = call[1] as unknown[];
      const placeholder = String(call[0]).match(/owner_user_id\s*=\s*\$(\d)/);
      expect(params[Number(placeholder![1]) - 1]).toBeNull();
    }
  });

  it('refuses an admin whose database role was revoked after login', async () => {
    database('employee');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(DASHBOARD)
      .expect(403);

    expect(res.body.error).toBe('Forbidden: Admin access required');
    // The absence-assertion, with the control below as its presence arm.
    expect(identityCall()).toBeUndefined();
  });

  // THE CONTROL for the refusal: same session, same fixture, DB role alone
  // differs. Without it the refusal passes against a route that 403s everyone.
  it('still admits an admin whose database role is unchanged', async () => {
    database('researcher_admin');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(DASHBOARD)
      .expect(200);

    expect(emailsOnTheWire(res.body)).toEqual([OWN_PARTICIPANT]);
    expect(identityCall()).toBeDefined();
  });

  // Fails closed, matching `currentDbRole`'s contract for the #14 gates.
  it('answers the gate outage and reads no identities when the role query fails', async () => {
    mockQuery.mockRejectedValue(
      new Error('connect ECONNREFUSED cortex-db.internal:5432 as user firsthand_app') as never
    );

    const res = await request(listening(appAs('superadmin', 'admin-1')))
      .get(DASHBOARD)
      .expect(503);

    expect(res.body.error).toBe('Authorization check failed');
    expect(identityCall()).toBeUndefined();

    // The refusal must not become an infrastructure disclosure. Asserted on the
    // whole response, because a leak could arrive in any field.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('cortex-db.internal');
    expect(body).not.toContain('5432');
    expect(body).not.toContain('firsthand_app');
    expect(body).not.toContain('ECONNREFUSED');
  });

  it('treats a caller whose account was deleted after login as unauthenticated', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never);

    const res = await request(listening(appAs('superadmin', 'admin-1')))
      .get(DASHBOARD)
      .expect(401);

    expect(res.body.error).toBe('Authentication required');
    expect(identityCall()).toBeUndefined();
  });
});

/**
 * THE PREMISE THIS WHOLE FAMILY RESTS ON, AND IT WAS UNPINNED.
 *
 * #38's report - and this file's own commit message - excused
 * `GET /api/admin/export/bookings` on the grounds that it "sits on
 * `requireAdmin`", which since #14 sets `req.user = { ...req.session.user, role }`
 * with the freshly-read role. True, and NOTHING FAILED IF IT STOPPED BEING
 * TRUE. Dropping `, role` from that one line in `authenticate.ts` - the gate
 * itself left completely intact, only the carry-forward removed - passed 1227
 * jest and 650 vitest tests, and re-opened this exact defect on this exact
 * route: a demoted superadmin gets a global CSV of every participant's name and
 * email.
 *
 * That is the shape this repository treats as a defect in its own right: a
 * claim ABOUT VERIFICATION that is itself unverified. The carry-forward is what
 * every in-handler `role === 'superadmin'` branch behind `requireAdmin` reads -
 * this route, `session-outputs.ts`, `firsthand.ts`'s
 * `requireSuperadminForStudyResults`, and a dozen scope decisions in
 * `opportunities.ts` - so it is the single most load-bearing line in the #14 /
 * #37 / #38 chain and it was the one link with no guard on it.
 *
 * BEHAVIOURAL, ON THE REAL MIDDLEWARE. A source scan asserting the line still
 * reads `, role` would pass against a `requireAdmin` that never ran.
 */
describe('GET /api/admin/export/bookings carries the live role into the handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // THE ARM. `requireAdmin` admits the caller either way - they are still an
  // admin - so this is purely about WHICH role reaches the handler's scope
  // decision. Fails if `requireAdmin` stops carrying the live role forward.
  it('scopes the exported CSV for a demoted superadmin', async () => {
    database('researcher_admin');

    const res = await request(listening(appAs('superadmin', 'admin-1')))
      .get('/api/admin/export/bookings')
      .expect(200);

    // The bytes on the wire, which is what a CSV export actually leaks.
    expect(res.text).toContain(OWN_PARTICIPANT);
    expect(res.text).not.toContain(OTHER_PARTICIPANT);
    expect(res.text).not.toContain('Rival Participant');

    // Since cto/AdaptaLabs#65 the export is a keyset walk, so its parameter
    // list is the owner scope, the three-part batch cursor - null on the first
    // batch - and the batch size as a literal. Asserted in FULL rather than by
    // index: the point of this arm is which owner id reaches `$1`, and a
    // full-array assertion also fails if a parameter is added in front of it.
    expect(identityCall()![1]).toEqual(['admin-1', null, null, null, 500]);
  });

  // THE CONTROL. A live superadmin is meant to export the whole platform, so
  // without this arm the assertion above passes against a route that scopes
  // everybody - and it is also what proves the fixture can still produce the
  // rival row at all.
  it('still exports the whole platform for a live superadmin', async () => {
    database('superadmin');

    const res = await request(listening(appAs('superadmin', 'root-1')))
      .get('/api/admin/export/bookings')
      .expect(200);

    expect(res.text).toContain(OWN_PARTICIPANT);
    expect(res.text).toContain(OTHER_PARTICIPANT);
    // Since cto/AdaptaLabs#65 the export is a keyset walk, so its parameter
    // list is the owner scope, the three-part batch cursor - null on the first
    // batch - and the batch size as a literal. Asserted in FULL rather than by
    // index: the point of this arm is which owner id reaches `$1`, and a
    // full-array assertion also fails if a parameter is added in front of it.
    expect(identityCall()![1]).toEqual([null, null, null, null, 500]);
  });
});

describe('POST /api/admin/request reads the live role', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('lets a revoked admin ask for access again', async () => {
    database('employee');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(REQUEST)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(
      mockQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('INSERT INTO admin_requests'))
    ).toBe(true);
  });

  // THE CONTROL: the "you already have it" refusal is correct and must survive.
  // Without this arm the one above passes against a route that never refuses.
  it('still refuses a live admin who already has access', async () => {
    database('researcher_admin');

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .post(REQUEST)
      .expect(400);

    expect(res.body.error).toBe('You already have admin access');
    expect(
      mockQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('INSERT INTO admin_requests'))
    ).toBe(false);
  });

  it('fails closed and writes nothing when the role query fails', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated') as never);

    const res = await request(listening(appAs('employee', 'user-1')))
      .post(REQUEST)
      .expect(503);

    expect(res.body.error).toBe('Authorization check failed');
    expect(
      mockQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('INSERT INTO admin_requests'))
    ).toBe(false);
  });
});
