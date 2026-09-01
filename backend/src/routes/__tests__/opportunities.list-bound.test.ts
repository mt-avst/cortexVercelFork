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

import opportunitiesRouter, {
  ADMIN_RECENT_SESSIONS_ONLY,
  MAX_OPPORTUNITIES_RETURNED,
  MAX_OPPORTUNITY_SEARCH_LENGTH,
  MAX_SESSIONS_RETURNED,
} from '../opportunities';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * `GET /api/opportunities` HAD NO `LIMIT` CLAUSE OF ANY KIND. cto/AdaptaLabs#22.
 *
 * The lesson worth recording is why the sweep that closed !225 could not see
 * it. That sweep looked for a caller-supplied value reaching `LIMIT`/`OFFSET`
 * and clamped what it found. There is NO caller-supplied number on this route -
 * the bound was MISSING, not loose - so a search shaped like the previous
 * defect returned nothing here and reported the class closed.
 *
 * `?q=` IS NOT AN INJECTION and never was: it is bound as `$1` and interpolated
 * only into `%...%`. What it had no bound on was its LENGTH, and a leading
 * wildcard `ILIKE` cannot use an index, so an unbounded term is unbounded work
 * per row on an `optionalAuth` route.
 *
 * BOTH CEILINGS ARE ASSERTED AS LITERALS below - 1000 and 200 - and not read
 * from the constants they pin. A test that builds its expectation from
 * `MAX_OPPORTUNITIES_RETURNED` cannot see `MAX_OPPORTUNITIES_RETURNED` change,
 * which is exactly how three mutations survived in this repository.
 *
 * THE REFUSAL IS THE DECISION, not an implementation detail. This route answers
 * with a BARE JSON ARRAY - no offset, no cursor, no `has_more` - so a clamped
 * response is indistinguishable from the end of the catalogue, and a
 * participant would simply never see the study that fell off the end. The
 * arm below that asserts the SQL asks for one row MORE than it will return is
 * what keeps the 413 reachable at all: without the `+ 1` the `>` is
 * unsatisfiable and the refusal silently becomes the truncation.
 */

const appAs = (role: 'employee' | 'researcher_admin' | null, id = 'u1') => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = role
      ? { user: { id, name: 'A', email: 'a@example.com', role } }
      : {};
    next();
  });
  app.use('/api/opportunities', opportunitiesRouter);
  app.use(errorHandler);
  return app;
};

const anonApp = appAs(null);

const opportunityRow = (n: number) => ({
  id: `opp-${n}`,
  title: `Study ${n}`,
  type: 'survey',
  status: 'published',
  owner_user_id: 'someone-else',
  owner_name: 'Other Researcher',
  owner_email: 'other@example.com',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  start_date: null,
  end_date: null,
});

/** The listing SQL the route actually sent, or '' if it never got that far. */
const listingSql = (): string => {
  const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('FROM opportunities o'));
  return call ? String(call[0]) : '';
};

/** Answer the listing query with `count` rows; everything else with none. */
const listReturns = (count: number) => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    // The #45 liveness lookup in front of the listing's inline admin branch.
    // Dispatching on the SQL text rather than on call order is what lets this
    // file absorb an extra leading query without every fixture shifting - the
    // same reason the analytics block below already carries this arm. The role
    // agrees with the session throughout: this file is about parameter bounds,
    // and liveness is pinned by
    // `opportunities.inline-admin-gates-read-live-role.test.ts`.
    if (String(sql).includes('SELECT role FROM users')) {
      return { rows: [{ role: 'researcher_admin' }] };
    }
    if (String(sql).includes('FROM opportunities o')) {
      return { rows: Array.from({ length: count }, (_, i) => opportunityRow(i)) };
    }
    return { rows: [] };
  });
};

beforeEach(() => {
  jest.resetAllMocks();
  mockIsDatabaseAvailable.mockResolvedValue(true as never);
  listReturns(0);
});

describe('GET /api/opportunities is bounded', () => {
  it('asks the database for one opportunity more than it will return', async () => {
    await request(listening(anonApp)).get('/api/opportunities');

    // The literal, not `MAX_OPPORTUNITIES_RETURNED + 1`. 1000 is the ceiling and
    // 1001 is the probe that makes "there are more" a fact rather than an
    // inference from a full page.
    expect(listingSql()).toContain('LIMIT 1001');
  });

  it('holds the opportunities ceiling at the number that was decided', () => {
    expect(MAX_OPPORTUNITIES_RETURNED).toBe(1000);
  });

  it('refuses with 413 rather than truncating when the catalogue exceeds the ceiling', async () => {
    listReturns(1001);

    const res = await request(listening(anonApp)).get('/api/opportunities');

    expect(res.status).toBe(413);
    expect(res.body.maximumOpportunities).toBe(1000);
  });

  // The control arm for the refusal above. An assertion that 1001 rows are
  // refused passes just as well if the route refuses everything, so exactly
  // the ceiling must still come back as a list.
  it('returns a full page of opportunities at exactly the ceiling', async () => {
    listReturns(1000);

    const res = await request(listening(anonApp)).get('/api/opportunities');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1000);
  });

  it('does not fan out to the batch session read once it has refused', async () => {
    listReturns(1001);

    await request(listening(anonApp)).get('/api/opportunities');

    // The refusal has to be decided BEFORE `WHERE s.opportunity_id = ANY(...)`,
    // which is the per-row cost the ceiling exists to bound.
    const fannedOut = mockQuery.mock.calls.some((c) => String(c[0]).includes('FROM sessions s'));
    expect(fannedOut).toBe(false);
  });

  it('applies the ceiling to an admin listing every status too', async () => {
    listReturns(1001);

    const res = await request(listening(appAs('researcher_admin'))).get(
      '/api/opportunities?status=draft'
    );

    expect(res.status).toBe(413);
  });
});

/**
 * THE INNER DIMENSION, WHICH THE OUTER CEILING COULD NOT SEE. cto/AdaptaLabs#41.
 *
 * The block above bounds the number of OPPORTUNITIES. The listing then fans out
 * over the ids it returned with `WHERE s.opportunity_id = ANY($1::uuid[])` and
 * no `LIMIT` at all, so the worst case was 1000 opportunities multiplied by
 * however many sessions each one holds, materialised in one round trip. A bound
 * on the row count of the outer query cannot see an unbounded read hanging off
 * it - which is #22's own lesson, one level in, and it was found by the refute
 * gate on the MR that added the outer ceiling.
 *
 * REFUSES RATHER THAN TRUNCATING. A `LIMIT` on the fan-out would drop sessions
 * from SOME opportunities and hand back the rest as if complete - a lie with no
 * marker on it, and worse than the outer truncation #22 refused, because the
 * caller cannot see which opportunity was shortened.
 *
 * 5000 IS ASSERTED AS A LITERAL below, and the `LIMIT 5001` arm is what keeps
 * the refusal reachable: without the probe row the `>` is unsatisfiable and the
 * refusal silently becomes the truncation.
 */
const sessionRow = (n: number, opportunityId = 'opp-0') => ({
  id: `sess-${n}`,
  opportunity_id: opportunityId,
  start_time: new Date('2026-02-01T10:00:00Z'),
  end_time: new Date('2026-02-01T11:00:00Z'),
  capacity: 5,
  actual_booked_count: 1,
  location_or_meet_link_optional: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
});

/** The batch session query the route actually sent, or '' if it never got that far. */
const sessionsSql = (): string => {
  const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('FROM sessions s'));
  return call ? String(call[0]) : '';
};

/** One opportunity, and `sessions` session rows hanging off it. */
const fanOutReturns = (sessions: number) => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes('SELECT role FROM users')) {
      return { rows: [{ role: 'researcher_admin' }] };
    }
    if (String(sql).includes('FROM opportunities o')) {
      return { rows: [opportunityRow(0)] };
    }
    if (String(sql).includes('FROM sessions s')) {
      return { rows: Array.from({ length: sessions }, (_, i) => sessionRow(i)) };
    }
    return { rows: [] };
  });
};

describe('the session fan-out under GET /api/opportunities is bounded too', () => {
  it('holds the sessions ceiling at the number that was decided', () => {
    // The literal, not `MAX_SESSIONS_RETURNED`. A test that builds its
    // expectation from the constant cannot see the constant change.
    expect(MAX_SESSIONS_RETURNED).toBe(5000);
  });

  it('holds the admin recent-session window at the interval that was decided (#103)', () => {
    // The literal, so widening or narrowing the fourteen-day tail that closes
    // #103's growth fails here by name rather than silently moving the number an
    // admin's recruitment and "this week" counts are summed over.
    expect(ADMIN_RECENT_SESSIONS_ONLY).toBe(" AND s.end_time > NOW() - INTERVAL '14 days'");
  });

  it('asks the database for one session more than it will return', async () => {
    fanOutReturns(1);

    await request(listening(anonApp)).get('/api/opportunities');

    expect(sessionsSql()).toContain('LIMIT 5001');
  });

  it('refuses with 413 rather than truncating when the fan-out exceeds the ceiling', async () => {
    fanOutReturns(5001);

    const res = await request(listening(anonApp)).get('/api/opportunities');

    expect(res.status).toBe(413);
    expect(res.body.maximumSessions).toBe(5000);
  });

  /**
   * WHO THE REFUSAL TAKES DOWN, as a test name rather than as prose in a
   * docblock. Raised by the refute gate on !267: the disposition was argued and
   * its cost was never named, so the next reader would have met it in production.
   *
   * `GET /api/opportunities` is NOT an admin route. `frontend/src/pages/Home.tsx:42`
   * calls `getOpportunities({})` with no filters, so the ANONYMOUS PARTICIPANT
   * HOME PAGE is this same request. Above the ceiling every visitor gets a 413
   * with no `?limit` to lower, no cursor and no retry that would succeed - a
   * whole-product outage rather than a degraded admin view.
   *
   * It is accepted for the reason #22 accepted the same cost on the outer
   * ceiling: a catalogue that has outgrown this route should fail loudly and get
   * pagination. It is accepted with its name written down.
   *
   * The count behind it has no time filter and never shrinks - cto/AdaptaLabs#62.
   */
  it.each<[string, 'employee' | null]>([
    ['anonymous, which is the participant home page', null],
    ['a signed-in employee', 'employee'],
  ])('refuses the catalogue for %s too, not only for an admin', async (_who, role) => {
    fanOutReturns(5001);

    const res = await request(listening(appAs(role))).get('/api/opportunities');

    expect(res.status).toBe(413);
    expect(res.body.maximumSessions).toBe(5000);
  });

  /**
   * THE ARM THAT WOULD HAVE CAUGHT THE OBVIOUS WRONG IMPLEMENTATION.
   *
   * The fan-out sits inside a `try` whose `catch` logs and CARRIES ON with an
   * empty sessions map, because a transient session read failure should not take
   * the whole catalogue down. A refusal raised by THROWING inside that block
   * would be swallowed by it and answered as a 200 with every `sessions` array
   * empty - the exact silent truncation the ceiling exists to prevent, wearing a
   * success status. So the status is asserted as not-200 as well as as 413.
   */
  it('does not let the swallow-and-continue catch turn the refusal into a 200', async () => {
    fanOutReturns(5001);

    const res = await request(listening(anonApp)).get('/api/opportunities');

    expect(res.status).not.toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
  });

  // CONTROL ARM. The refusal above passes just as well if the route refuses
  // every listing that has any sessions at all, so exactly the ceiling must
  // still come back.
  it('returns the catalogue at exactly the sessions ceiling', async () => {
    fanOutReturns(5000);

    const res = await request(listening(anonApp)).get('/api/opportunities');

    expect(res.status).toBe(200);
    expect(res.body[0].sessions).toHaveLength(5000);
  });

  // CONTROL ARM, the second kind: an assertion about session COUNTS passes just
  // as well when sessions stopped being embedded at all. This proves the
  // detector still sees an ordinary session on an ordinary listing.
  it('still embeds sessions on a listing far below the ceiling', async () => {
    fanOutReturns(3);

    const res = await request(listening(anonApp)).get('/api/opportunities');

    expect(res.status).toBe(200);
    expect(res.body[0].sessions).toHaveLength(3);
    expect(res.body[0].sessions[0]).toMatchObject({ capacity: 5, booked_count: 1, remaining: 4 });
  });

  /**
   * THE TIME FILTER ON THE PARTICIPANT BRANCH (cto/AdaptaLabs#62).
   *
   * These are SHAPE arms, and shape is all they are: a SQL-text assertion cannot
   * see the rows the predicate actually excludes, and this suite's pool is a
   * mock. The BEHAVIOUR - a past session absent for a participant, a RECENT one
   * present for an admin and an OLD one absent - is pinned against a real
   * Postgres in `opportunities.list-upcoming-sessions-postgres.test.ts`, and that
   * is the file to change if the disposition changes. Both halves are asserted
   * here because the two branches carry DIFFERENT filters (#103 decided the
   * admin one is a recent window, not the participant's strict live schedule),
   * and a change that collapsed them to one must fail by name.
   *
   * `end_time`, not `start_time`, and the arm says so: `backend/src/routes/
   * bookings.ts:107` refuses a booking on `end_time <= now`, so a session in
   * progress is still bookable and still belongs in the catalogue.
   */
  it.each<[string, 'employee' | null]>([
    ['anonymous, which is the participant home page', null],
    ['a signed-in employee', 'employee'],
  ])('reads only sessions that can still be acted on for %s', async (_who, role) => {
    fanOutReturns(1);

    await request(listening(appAs(role))).get('/api/opportunities');

    expect(sessionsSql()).toContain('s.end_time > NOW()');
    // Not start_time: that would drop a session already under way, which the
    // booking route still accepts.
    expect(sessionsSql()).not.toContain('s.start_time > NOW()');
    expect(sessionsSql()).not.toContain('s.start_time >= NOW()');
  });

  it('windows the admin fan-out to a recent tail, not the whole archive (#103)', async () => {
    fanOutReturns(1);

    await request(listening(appAs('researcher_admin'))).get('/api/opportunities');

    // The admin branch IS filtered now - to the live schedule plus a recent
    // tail - so its count tracks the schedule rather than growing for ever.
    expect(sessionsSql()).toContain("s.end_time > NOW() - INTERVAL '14 days'");
    // The control against collapsing the two branches: the admin filter is the
    // WINDOW, not the participant's strict future-only bound.
    expect(sessionsSql()).not.toMatch(/s\.end_time > NOW\(\)\s+GROUP/);
  });

  // CONTROL. The two arms above pass just as well if the route stopped fanning
  // out at all, or if `sessionsSql()` started returning the wrong statement.
  it('still asks for the fan-out on both branches, filtered or not', async () => {
    for (const role of ['employee', 'researcher_admin'] as const) {
      mockQuery.mockClear();
      fanOutReturns(1);

      await request(listening(appAs(role))).get('/api/opportunities');

      expect(sessionsSql()).toContain('FROM sessions s');
      expect(sessionsSql()).toContain('LIMIT 5001');
    }
  });

  // The pre-existing behaviour this change had to preserve: a FAILED session
  // read is still logged and answered as a catalogue with empty session arrays,
  // not as a refusal and not as a 500.
  it('still answers with empty sessions when the fan-out query itself fails', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM opportunities o')) {
        return { rows: [opportunityRow(0)] };
      }
      if (String(sql).includes('FROM sessions s')) {
        throw new Error('connection terminated unexpectedly');
      }
      return { rows: [] };
    });

    const res = await request(listening(anonApp)).get('/api/opportunities');

    expect(res.status).toBe(200);
    expect(res.body[0].sessions).toEqual([]);
  });
});

describe('the q filter on GET /api/opportunities is length bounded', () => {
  it('holds the search-term ceiling at the number that was decided', () => {
    expect(MAX_OPPORTUNITY_SEARCH_LENGTH).toBe(200);
  });

  it('refuses a search term longer than the ceiling', async () => {
    const res = await request(listening(anonApp)).get(`/api/opportunities?q=${'a'.repeat(201)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('200');
  });

  // Control arm: a term AT the ceiling still searches, so the refusal above is
  // evidence about length rather than about `q` being rejected outright.
  it('searches on a term of exactly the ceiling length', async () => {
    const term = 'a'.repeat(200);

    const res = await request(listening(anonApp)).get(`/api/opportunities?q=${term}`);

    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('FROM opportunities o'));
    expect(call?.[1]).toContain(`%${term}%`);
  });

  // The bound sits above the mock/database split on purpose: which backend
  // answers must not decide whether the caller's input was acceptable.
  it('refuses an over-long search term even when the database is unavailable', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false as never);

    const res = await request(listening(anonApp)).get(`/api/opportunities?q=${'a'.repeat(201)}`);

    expect(res.status).toBe(400);
  });
});

/**
 * A REPEATED QUERY PARAMETER IS AN ARRAY, AND IT WALKED STRAIGHT PAST THE BOUND
 * ABOVE. Found by the independent refute gate on !253, in the fix's OWN new
 * code rather than in what it was fixing.
 *
 * `?q=a&q=b` arrives as `['a', 'b']`, so `typeof q === 'string'` was false, the
 * length guard was SKIPPED entirely, and `` `%${q}%` `` stringified the array by
 * comma-joining it into the ILIKE pattern. Measured before the fix: two 300
 * character values gave a 603 character pattern and a 200, and fifty 190
 * character values gave 9551 characters and a 200 - against a decided ceiling
 * of 200. The effective bound became Node's ~16 kB header limit, roughly 80x
 * what was chosen, on an unauthenticated route where the pattern is a
 * leading-wildcard ILIKE evaluated twice per row.
 *
 * IT DEFEATED THE PLACEMENT ARGUMENT TOO. The length check was put above the
 * mock/database split so the bound would not depend on which backend answered.
 * With an array it did not hold there either - the mock path 500'd.
 *
 * REFUSES A REPEAT RATHER THAN COERCING ONE. Taking the first value, joining
 * them, or treating the parameter as absent are all answers to a question
 * nobody asked, and the last silently WIDENS the result set. This repository
 * has already settled the same shape once, in `parseLimit` in
 * routes/gamification.ts: `?limit=5&limit=9999` answered with 5 by a
 * coincidence of comma-joining, and was refused rather than documented. Same
 * disposition here, and the caller's recourse is to send one.
 *
 * `type` AND `status` GOT THE SAME GUARD, which is the class rather than the
 * instance. Neither is a bound, but both are cast to `string` and pushed
 * straight into a `pool.query` parameter array, so a repeat sent an array where
 * Postgres expected text and answered an unauthenticated 500.
 */
describe('a repeated query parameter cannot walk past the bounds', () => {
  it('refuses a repeated q rather than letting it bypass the length bound', async () => {
    const term = 'a'.repeat(300);

    const res = await request(listening(anonApp)).get(
      `/api/opportunities?q=${term}&q=${term}`
    );

    expect(res.status).toBe(400);
  });

  it('never builds an ILIKE pattern longer than the bound allows', async () => {
    const term = 'b'.repeat(190);
    const repeated = Array.from({ length: 50 }, () => `q=${term}`).join('&');

    await request(listening(anonApp)).get(`/api/opportunities?${repeated}`);

    // The measurement the gate took: 9551 characters reached the pattern. Any
    // pattern at all here means the guard let the array through.
    const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('FROM opportunities o'));
    const pattern = (call?.[1] as string[] | undefined)?.find((p) => p.startsWith('%'));
    expect(pattern).toBeUndefined();
  });

  it('refuses a repeated q on the mock path too rather than throwing', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false as never);
    const term = 'a'.repeat(300);

    const res = await request(listening(anonApp)).get(
      `/api/opportunities?q=${term}&q=${term}`
    );

    // Not a 500. The bound is on what the caller sent, so it must not depend on
    // which backend happens to answer.
    expect(res.status).toBe(400);
  });

  it('refuses a repeated type rather than sending an array to Postgres', async () => {
    const res = await request(listening(anonApp)).get('/api/opportunities?type=survey&type=poll');

    expect(res.status).toBe(400);
  });

  it('refuses a repeated status rather than sending an array to Postgres', async () => {
    const res = await request(listening(appAs('researcher_admin'))).get(
      '/api/opportunities?status=draft&status=published'
    );

    expect(res.status).toBe(400);
  });

  // THE CONTROLS. Every arm above asserts a 400, which a handler that refused
  // every listing would satisfy perfectly. These prove a single value of each
  // parameter still reaches the query.
  it('still accepts a single q, type and status together', async () => {
    const res = await request(listening(appAs('researcher_admin'))).get(
      '/api/opportunities?q=usability&type=survey&status=draft'
    );

    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('FROM opportunities o'));
    expect(call?.[1]).toEqual(['survey', '%usability%', 'draft']);
  });

  it('still accepts a listing with no query parameters at all', async () => {
    const res = await request(listening(anonApp)).get('/api/opportunities');

    expect(res.status).toBe(200);
  });
});

/**
 * THE SAME SHAPE ONE HANDLER DOWN, which two rounds of fixing the NAMED
 * parameters both walked past.
 *
 * `GET /:id/sessions` is `optionalAuth` and reads `?from=`, casts it `as
 * string`, and pushes it into a `pool.query` parameter array against a
 * `timestamp` column. `?from=a&from=b` therefore sent Postgres the array
 * literal `{"a","b"}` - SQLSTATE 22007, an unauthenticated 500 - while the mock
 * branch beside it turned the same input into `Invalid Date` and carried on
 * regardless. Two backends, two different wrong answers, and neither of them a
 * refusal.
 *
 * Found by a sweep that went looking for the SHAPE rather than for `q`. The
 * enforcement against a fourth one is
 * `opportunities.query-params-are-single-valued.test.ts`, not this file.
 */
describe('GET /api/opportunities/:id/sessions refuses a repeated parameter', () => {
  const sessionsFor = (opportunityId: string) => `/api/opportunities/${opportunityId}/sessions`;

  beforeEach(() => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('FROM opportunities o')) {
        return { rows: [{ ...opportunityRow(1), id: 'opp-1' }] };
      }
      return { rows: [] };
    });
  });

  it('refuses a repeated from rather than sending an array to Postgres', async () => {
    const res = await request(listening(anonApp)).get(
      `${sessionsFor('opp-1')}?from=2026-01-01&from=2026-02-01`
    );

    expect(res.status).toBe(400);
  });

  it('refuses a repeated include_past', async () => {
    const res = await request(listening(anonApp)).get(
      `${sessionsFor('opp-1')}?include_past=true&include_past=false`
    );

    expect(res.status).toBe(400);
  });

  it('refuses a repeated from on the mock path too rather than answering anyway', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false as never);

    const res = await request(listening(anonApp)).get(
      `${sessionsFor('opp-1')}?from=2026-01-01&from=2026-02-01`
    );

    // The mock branch used to build an `Invalid Date` from the array and carry
    // on, so the same request got a 500 from one backend and a 200 from the
    // other.
    expect(res.status).toBe(400);
  });

  it('refuses before it looks the opportunity up at all', async () => {
    await request(listening(anonApp)).get(`${sessionsFor('opp-1')}?from=a&from=b`);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  // THE CONTROLS. A handler that refused every request would satisfy all four
  // arms above.
  it('still accepts a single from', async () => {
    const res = await request(listening(anonApp)).get(`${sessionsFor('opp-1')}?from=2026-01-01`);

    expect(res.status).toBe(200);
  });

  it('still accepts a request with no query parameters', async () => {
    const res = await request(listening(anonApp)).get(sessionsFor('opp-1'));

    expect(res.status).toBe(200);
  });
});

/**
 * THE THIRD CALL SITE, WHICH COULD BE UNWIRED WITH THE WHOLE SUITE GREEN.
 *
 * Round two of the refute gate deleted each `refusedRepeatedParameters` call in
 * turn and ran the full backend suite:
 *
 *   the listing guard    5 failed by name
 *   the sessions guard   4 failed by name
 *   the analytics guard  71 suites, 1189 tests, ALL GREEN
 *
 * Deleting the line outright is caught by lint, because
 * `SINGLE_VALUE_ANALYTICS_FILTERS` goes unused - but `if (false && ...)`, or any
 * reorder that moves a read above it, passes lint AND the suite. `period` had a
 * guard and no request-level arm, so the guard's own docblock was the only
 * thing asserting it existed.
 *
 * This is the sibling ticket #20's exact shape - a guard whose test cannot see
 * it being unwired - and it is not shipping from this MR uncovered.
 *
 * RUNS THROUGH THE REAL `requireAdmin`, not the session-trusting double. The
 * double exists for suites whose `pool.query` mock is a POSITIONAL QUEUE, where
 * the #14 liveness lookup consumes the first queued result and shifts every
 * later one. This file dispatches on the SQL text instead, so the extra
 * `SELECT role FROM users` is just one more arm and the gate under test stays
 * the real one.
 */
describe('GET /api/opportunities/:id/analytics refuses a repeated period', () => {
  const analyticsFor = (opportunityId: string) =>
    `/api/opportunities/${opportunityId}/analytics`;

  beforeEach(() => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      // The #14 liveness lookup in front of requireAdmin.
      if (text.includes('SELECT role FROM users')) {
        return { rows: [{ role: 'researcher_admin' }] };
      }
      // The handler's own existence + ownership lookup. Without this arm it
      // 404s, which is how the control below caught the fixture rather than the
      // guard.
      if (text.includes('SELECT owner_user_id, created_at FROM opportunities')) {
        return { rows: [{ owner_user_id: 'u1', created_at: new Date('2026-01-01T00:00:00Z') }] };
      }
      // The aggregates. One permissive row is enough: the handler indexes
      // `rows[0]` on the overall query - an empty array there was the 500 the
      // control caught - and uses `.find()` on the rest, which is total.
      if (text.includes('FROM opportunity_clicks')) {
        return {
          rows: [
            {
              total: 0,
              unique_users: 0,
              unique_count: 0,
              count_24h: 0,
              count_7d: 0,
              first_click: null,
              last_click: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
  });

  it('refuses a repeated period rather than answering by comma-joining', async () => {
    const res = await request(listening(appAs('researcher_admin'))).get(
      `${analyticsFor('opp-1')}?period=7&period=30`
    );

    // 7 was the answer before this guard, and it was the answer because
    // `parseInt('7,30')` is 7 - not because any rule chose it.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('period');
  });

  it('refuses a nested period object too', async () => {
    const res = await request(listening(appAs('researcher_admin'))).get(
      `${analyticsFor('opp-1')}?period[gte]=7`
    );

    expect(res.status).toBe(400);
  });

  // THE CONTROL. Both arms above assert a 400, which a route that refused every
  // analytics request would satisfy - and a route behind `requireAdmin` has two
  // other ways to refuse before ever reaching the guard.
  it('still accepts a single valid period', async () => {
    const res = await request(listening(appAs('researcher_admin'))).get(
      `${analyticsFor('opp-1')}?period=7`
    );

    expect(res.status).toBe(200);
  });

  it('still accepts an analytics request with no period at all', async () => {
    const res = await request(listening(appAs('researcher_admin'))).get(analyticsFor('opp-1'));

    expect(res.status).toBe(200);
  });
});
