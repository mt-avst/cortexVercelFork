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

// The brief route reads its counts through the FirstHand runtime pool, which is
// a second database this suite has no business standing up. Only the two
// functions the handler calls are doubled; everything else in the module is the
// real thing, so an import-time change there still reaches this file.
jest.mock('../../firsthand/studies-repository', () => ({
  ...(jest.requireActual('../../firsthand/studies-repository') as object),
  countStudyTasks: jest.fn(),
  getStudyById: jest.fn(),
}));

import opportunitiesRouter from '../opportunities';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { countStudyTasks, getStudyById } from '../../firsthand/studies-repository';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;
const mockCountStudyTasks = countStudyTasks as unknown as jest.Mock;
const mockGetStudyById = getStudyById as unknown as jest.Mock;

/**
 * THE SESSION ROLE IS NOT THE ROLE, on the participant catalogue. #45.
 *
 * The sibling of `bookings.inline-admin-gates-read-live-role.test.ts`, for the
 * four `optionalAuth` routes in `opportunities.ts` whose handlers compute
 * `isAdmin` inline from `req.user?.role` - a copy of the role stamped into the
 * session at LOGIN. #14 made the admin GATES re-read the live role and #37
 * extended it to two `bookings.ts` routes; neither reached here, so a revoked
 * `researcher_admin` kept the admin view of the catalogue for up to
 * SESSION_MAX_AGE_MS = 24h.
 *
 *   GET /api/opportunities                            drafts, owner identity,
 *                                                     `clicks_total`
 *   GET /api/opportunities/:id                        an UNPUBLISHED study
 *   GET /api/opportunities/:id/sessions               a draft's sessions, and
 *                                                     the joining link
 *   GET /api/opportunities/:id/recorded-study-brief   a draft study's brief
 *
 * `withLiveRole` could not be chained here: it 401s without a session and these
 * routes must answer a signed-out browser. `withLiveRoleIfPresent` re-reads
 * instead, and ONLY for a session whose stored role is already an admin one.
 *
 * THE FIFTH ROUTE, `POST /:id/click`, IS DELIBERATELY UNCHANGED, and the last
 * describe block below is what keeps that a decision rather than an oversight:
 * it asserts the handler has no role branch to go stale.
 *
 * DELIBERATELY DOES NOT `jest.mock('../../middleware/authenticate')`. The
 * double has no database call at all, so a suite that opts into it is blind to
 * exactly this defect. This one drives the real middleware and answers the role
 * read out of the `users` table like any other query.
 *
 * EVERY ABSENCE HAS A PRESENCE ARM. `session` and `db` are separate knobs, so
 * each "the revoked admin does not get X" arm has a live-admin control on the
 * same fixture differing in the DB role alone - otherwise it would pass just as
 * well against a route that 404s everybody - plus a signed-out arm proving the
 * catalogue still serves without a cookie at all.
 *
 * AND THE QUERY COUNT IS PINNED AS A LITERAL, because the narrowing is the
 * other half of the decision: `GET /api/opportunities` is the hot participant
 * path, and re-reading for a caller who cannot gain anything from it would be
 * a per-request cost for nothing. Deriving the expectation from a constant
 * would not see that constant change, so 0 and 1 are written down.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (sessionRole: Role | null, id = 'u1') => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = sessionRole
      ? { user: { id, name: 'A', email: 'a@example.com', role: sessionRole } }
      : {};
    next();
  });
  app.use('/api/opportunities', opportunitiesRouter);
  app.use(errorHandler);
  return app;
};

const PUBLISHED_ID = 'opp-published';
const DRAFT_ID = 'opp-draft';
const JOINING_LINK = 'https://meet.example.com/secret-room';

const opportunityRow = (id: string, status: string) => ({
  id,
  title: `Study ${id}`,
  type: 'unmoderated',
  status,
  owner_user_id: 'someone-else',
  owner_name: 'Other Researcher',
  owner_email: 'other@example.com',
  firsthand_study_id: 'study-1',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  start_date: null,
  end_date: null,
});

const sessionRow = (id: string) => ({
  id: 'sess-1',
  opportunity_id: id,
  start_time: new Date('2026-12-01T10:00:00Z'),
  end_time: new Date('2026-12-01T11:00:00Z'),
  capacity: 5,
  booked_count: 0,
  actual_booked_count: 0,
  location_or_meet_link_optional: JOINING_LINK,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
});

/**
 * One `pool.query` router for all four routes, keyed on the SQL rather than on
 * call order, so no arm can pass because a queued result happened to land in
 * the right slot.
 *
 * IT HONOURS THE STATUS FILTER the handlers append for a non-admin, which is
 * the whole mechanism under test on three of the four routes: `AND o.status =
 * 'published'` really does hide the draft here, the way Postgres would.
 *
 * `dbRole` is what `users` actually says - the live role. It is answered to the
 * middleware's `SELECT role FROM users` and to nothing else.
 */
const database = (dbRole: Role) => {
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
    const text = String(sql);

    if (text.includes('SELECT role FROM users')) {
      return { rows: [{ role: dbRole }] };
    }

    // The pre-consent brief. Its own SELECT list, and its own status filter.
    if (text.includes('SELECT status, type, firsthand_study_id')) {
      const id = (params as string[])[0];
      const publishedOnly = text.includes("status = 'published'");
      if (publishedOnly && id !== PUBLISHED_ID) return { rows: [] };
      return {
        rows: [
          {
            status: id === PUBLISHED_ID ? 'published' : 'draft',
            type: 'unmoderated',
            firsthand_study_id: 'study-1',
          },
        ],
      };
    }

    // GET /:id and GET /:id/sessions both read one opportunity by id. Only the
    // detail route appends the status filter; the sessions route refuses the
    // draft in the handler instead, so both must 404 for a non-admin.
    if (text.includes('FROM opportunities o') && text.includes('WHERE o.id = $1')) {
      const id = (params as string[])[0];
      if (text.includes("o.status = 'published'") && id !== PUBLISHED_ID) {
        return { rows: [] };
      }
      return { rows: [opportunityRow(id, id === PUBLISHED_ID ? 'published' : 'draft')] };
    }

    // The listing. The draft is only in the answer when the handler did not ask
    // for published rows only.
    if (text.includes('FROM opportunities o')) {
      const rows = text.includes("o.status = 'published'")
        ? [opportunityRow(PUBLISHED_ID, 'published')]
        : [opportunityRow(PUBLISHED_ID, 'published'), opportunityRow(DRAFT_ID, 'draft')];
      return { rows };
    }

    // The click route's own opportunity read. No `o` alias and no status
    // filter, because it never branches on the role - which is the point.
    if (text.includes('SELECT id, type, status FROM opportunities')) {
      const id = (params as string[])[0];
      return { rows: [{ id, type: 'unmoderated', status: id === PUBLISHED_ID ? 'published' : 'draft' }] };
    }

    if (text.includes('FROM sessions s')) {
      return { rows: [sessionRow(PUBLISHED_ID)] };
    }

    if (text.includes('FROM opportunity_clicks')) {
      return { rows: [{ opportunity_id: PUBLISHED_ID, count: '8' }] };
    }

    return { rows: [] };
  });
};

const sqlIssued = () => mockQuery.mock.calls.map((call: unknown[]) => String(call[0]));

/** How many times the live-role re-read actually hit the database. */
const roleReads = () => sqlIssued().filter((sql) => sql.includes('SELECT role FROM users')).length;

const titles = (body: Array<{ title: string }>) => body.map((row) => row.title).sort();

const LIST = '/api/opportunities';
const DRAFT_DETAIL = `/api/opportunities/${DRAFT_ID}`;
const DRAFT_SESSIONS = `/api/opportunities/${DRAFT_ID}/sessions`;
const DRAFT_BRIEF = `/api/opportunities/${DRAFT_ID}/recorded-study-brief`;
const PUBLISHED_DETAIL = `/api/opportunities/${PUBLISHED_ID}`;
const PUBLISHED_SESSIONS = `/api/opportunities/${PUBLISHED_ID}/sessions`;
const PUBLISHED_BRIEF = `/api/opportunities/${PUBLISHED_ID}/recorded-study-brief`;

describe('the opportunities catalogue reads the live role', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockCountStudyTasks.mockResolvedValue(4 as never);
    mockGetStudyById.mockResolvedValue(null as never);
  });

  describe('GET /api/opportunities', () => {
    // THE CONTROL. Session and database agree the caller is an admin, so the
    // drafts and the click count are served. Without this arm every absence
    // below passes against a route that serves nobody anything.
    it('serves a still-live admin the drafts, the owner identity and clicks_total', async () => {
      database('researcher_admin');

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(LIST)
        .expect(200);

      expect(titles(res.body)).toEqual([`Study ${DRAFT_ID}`, `Study ${PUBLISHED_ID}`]);
      expect(res.body[0].clicks_total).toBe(8);
      expect(res.body[0].owner_email).toBe('other@example.com');
    });

    it('gives an admin whose database role was revoked after login the participant view', async () => {
      // Same cookie, same fixture, one knob moved: `users.role` now says
      // employee. Pre-#45 this answered with the draft and the click count.
      database('employee');

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(LIST)
        .expect(200);

      expect(titles(res.body)).toEqual([`Study ${PUBLISHED_ID}`]);
      expect(res.body[0]).not.toHaveProperty('clicks_total');
      expect(res.body[0]).not.toHaveProperty('owner_email');
      // And it did not merely withhold the number after fetching it.
      expect(sqlIssued().some((sql) => sql.includes('FROM opportunity_clicks'))).toBe(false);
    });

    // THE OTHER CONTROL, and the reason `withLiveRole` could not be used: these
    // routes are the catalogue a signed-out browser loads.
    it('still serves a signed-out browser its catalogue', async () => {
      database('employee');

      const res = await request(listening(appAs(null))).get(LIST).expect(200);

      expect(titles(res.body)).toEqual([`Study ${PUBLISHED_ID}`]);
    });
  });

  describe('GET /api/opportunities/:id', () => {
    it('serves a still-live admin an unpublished opportunity', async () => {
      database('researcher_admin');

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(DRAFT_DETAIL)
        .expect(200);

      expect(res.body.status).toBe('draft');
      expect(res.body.owner_email).toBe('other@example.com');
    });

    it('refuses the unpublished opportunity to a revoked admin', async () => {
      database('employee');

      await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(DRAFT_DETAIL)
        .expect(404);
    });

    it('still serves a signed-out browser a published opportunity', async () => {
      database('employee');

      const res = await request(listening(appAs(null))).get(PUBLISHED_DETAIL).expect(200);

      expect(res.body.id).toBe(PUBLISHED_ID);
      expect(res.body).not.toHaveProperty('owner_email');
    });
  });

  describe('GET /api/opportunities/:id/sessions', () => {
    it("serves a still-live admin a draft's sessions, joining link and all", async () => {
      database('researcher_admin');

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(DRAFT_SESSIONS)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].location_or_meet_link_optional).toBe(JOINING_LINK);
    });

    it("refuses a draft's sessions to a revoked admin", async () => {
      database('employee');

      await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(DRAFT_SESSIONS)
        .expect(404);
    });

    // Two properties in one arm, both controls: the signed-out catalogue still
    // works, AND the non-admin branch it lands in is the redacting one, so the
    // revoked admin above is being pushed somewhere that actually withholds.
    it('still serves a signed-out browser the published sessions, with the link stripped', async () => {
      database('employee');

      const res = await request(listening(appAs(null))).get(PUBLISHED_SESSIONS).expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).not.toHaveProperty('location_or_meet_link_optional');
    });
  });

  describe('GET /api/opportunities/:id/recorded-study-brief', () => {
    it("serves a still-live admin a draft study's brief", async () => {
      database('researcher_admin');

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(DRAFT_BRIEF)
        .expect(200);

      expect(res.body.task_count).toBe(4);
    });

    it("refuses a draft study's brief to a revoked admin", async () => {
      database('employee');

      await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(DRAFT_BRIEF)
        .expect(404);
    });

    it('still serves a signed-out browser the published brief', async () => {
      database('employee');

      const res = await request(listening(appAs(null))).get(PUBLISHED_BRIEF).expect(200);

      expect(res.body.task_count).toBe(4);
    });
  });

  /**
   * THE OTHER ADMIN ROLE, and the reason it needs its own block.
   *
   * Every arm above drives a `researcher_admin` session, so the narrowing's
   * `superadmin` term had NO enforcement at all: the refute gate on !264
   * deleted `&& storedRole !== 'superadmin'` and measured 1301 passed / 1301,
   * twice. The symmetric mutation - dropping `researcher_admin` and keeping
   * `superadmin` - failed 25 tests. 0 against 25 is the finding.
   *
   * It is reachable. `admin.ts` deliberately refuses in-API superadmin
   * revocation as a recorded #14 decision, so a superadmin is demoted by script
   * or direct SQL - which is precisely the channel the live-role family exists
   * to honour, not an excuse for skipping it.
   */
  describe('a revoked superadmin, not only a revoked researcher_admin', () => {
    it('gives a superadmin whose database role was revoked the participant view', async () => {
      database('employee');

      const res = await request(listening(appAs('superadmin', 'root-1')))
        .get(LIST)
        .expect(200);

      expect(titles(res.body)).toEqual([`Study ${PUBLISHED_ID}`]);
      expect(res.body[0]).not.toHaveProperty('clicks_total');
      expect(res.body[0]).not.toHaveProperty('owner_email');
    });

    it('refuses the draft detail, sessions and brief to a revoked superadmin', async () => {
      for (const url of [DRAFT_DETAIL, DRAFT_SESSIONS, DRAFT_BRIEF]) {
        jest.clearAllMocks();
        mockIsDatabaseAvailable.mockResolvedValue(true as never);
        mockCountStudyTasks.mockResolvedValue(4 as never);
        database('employee');

        const res = await request(listening(appAs('superadmin', 'root-1'))).get(url);

        expect({ url, status: res.status }).toEqual({ url, status: 404 });
      }
    });

    // THE CONTROL. Without it every assertion above is satisfied by a
    // superadmin session that is refused unconditionally.
    it('serves a still-live superadmin the drafts and clicks_total', async () => {
      database('superadmin');

      const res = await request(listening(appAs('superadmin', 'root-1')))
        .get(LIST)
        .expect(200);

      expect(titles(res.body)).toEqual([`Study ${DRAFT_ID}`, `Study ${PUBLISHED_ID}`]);
      expect(res.body[0].clicks_total).toBe(8);
    });
  });

  /**
   * THE PERFORMANCE DECISION, pinned as literals.
   *
   * The re-read is skipped when the session's stored role is not already an
   * admin role, because a re-read can only ever take privilege AWAY - so a
   * participant has nothing to gain from it, and `GET /api/opportunities` is
   * the catalogue every signed-in user loads. Option 1 in #45 was to re-read
   * for everybody; these numbers are what makes the narrowing an assertion
   * rather than a preference. 0 and 1 are written down rather than derived,
   * because an expectation computed from the code cannot see the code change.
   */
  describe('the query the narrowing exists to avoid', () => {
    it('issues no role query at all for a signed-out catalogue load', async () => {
      database('employee');

      await request(listening(appAs(null))).get(LIST).expect(200);

      expect(roleReads()).toBe(0);
    });

    it('issues no role query for a signed-in participant, on any of the four routes', async () => {
      for (const url of [LIST, PUBLISHED_DETAIL, PUBLISHED_SESSIONS, PUBLISHED_BRIEF]) {
        jest.clearAllMocks();
        mockIsDatabaseAvailable.mockResolvedValue(true as never);
        mockCountStudyTasks.mockResolvedValue(4 as never);
        database('employee');

        await request(listening(appAs('employee', 'user-1'))).get(url).expect(200);

        expect({ url, roleReads: roleReads() }).toEqual({ url, roleReads: 0 });
      }
    });

    // THE CONTROL for the three zeroes above: a counter that always reads 0 is
    // indistinguishable from one that is looking for the wrong string.
    it('issues exactly one role query for an admin catalogue load', async () => {
      database('researcher_admin');

      await request(listening(appAs('researcher_admin', 'admin-1'))).get(LIST).expect(200);

      expect(roleReads()).toBe(1);
    });
  });

  /**
   * FAILS CLOSED, matching `currentDbRole`'s contract for the #14 gates. Worth
   * its own arms because the failure mode on an `optionalAuth` route is not
   * obvious: the caller HAS a cookie, so falling back to the anonymous view
   * would look reasonable and would be a guess at the role.
   */
  describe('when the role read fails', () => {
    it('refuses the catalogue to an admin session rather than guessing', async () => {
      mockQuery.mockRejectedValue(new Error('connection terminated') as never);

      const res = await request(listening(appAs('researcher_admin', 'admin-1')))
        .get(LIST)
        .expect(503);

      expect(res.body.error).toBe('Authorization check failed');
      expect(sqlIssued().some((sql) => sql.includes('FROM opportunities o'))).toBe(false);
    });

    // THE CONTROL, and it took a refute gate to make it an honest one. The
    // first version called `database('employee')` as its first line, which
    // reinstalls a HEALTHY pool - so it asserted a 200 through no outage at all
    // and its name claimed a property nothing checked.
    //
    // What is actually true under a total outage, and is what the arm above
    // needs: the gate does not refuse the anonymous caller. It never asks for a
    // role, so the request reaches the handler and fails on the HANDLER's terms
    // - a 500 that this MR does not change - rather than on the gate's 503.
    // That is the difference the 503 above is measuring.
    it('does not refuse an anonymous caller at the gate during the same outage', async () => {
      mockQuery.mockRejectedValue(new Error('connection terminated') as never);

      const res = await request(listening(appAs(null))).get(LIST);

      expect(res.status).toBe(500);
      expect(res.body.error).not.toBe('Authorization check failed');
      expect(roleReads()).toBe(0);
    });

    it('401s an admin session whose user row has been deleted', async () => {
      mockQuery.mockImplementation(async () => ({ rows: [] }));

      await request(listening(appAs('researcher_admin', 'admin-1'))).get(LIST).expect(401);
    });
  });

  /**
   * WHY THE FIFTH ROUTE IS NOT IN THIS FILE.
   *
   * #45 lists `POST /api/opportunities/:id/click` alongside the four above, and
   * it is the one route left on plain `optionalAuth`. The justification is that
   * its handler has no role branch to go stale - which is a claim about the
   * code, so it is asserted rather than written in a comment and left to rot.
   */
  describe('POST /api/opportunities/:id/click, deliberately not chained', () => {
    it('records a click for a signed-in admin without ever reading the role', async () => {
      database('researcher_admin');

      await request(listening(appAs('researcher_admin', 'admin-1')))
        .post(`/api/opportunities/${PUBLISHED_ID}/click`)
        .send({ click_type: 'view' })
        .expect(200);

      expect(roleReads()).toBe(0);
      expect(sqlIssued().some((sql) => sql.includes('INSERT INTO opportunity_clicks'))).toBe(true);
    });

    it('answers a revoked admin and a participant identically', async () => {
      // The property the exemption rests on: the response does not depend on
      // the role at all, so a stale role cannot disclose anything here.
      database('employee');
      const asRevoked = await request(listening(appAs('researcher_admin', 'admin-1')))
        .post(`/api/opportunities/${PUBLISHED_ID}/click`)
        .send({ click_type: 'view' })
        .expect(200);

      database('employee');
      const asParticipant = await request(listening(appAs('employee', 'user-1')))
        .post(`/api/opportunities/${PUBLISHED_ID}/click`)
        .send({ click_type: 'view' })
        .expect(200);

      expect(asRevoked.body).toEqual(asParticipant.body);
    });
  });
});
