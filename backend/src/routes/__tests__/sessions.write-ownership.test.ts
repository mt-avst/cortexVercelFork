import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express, { Router } from 'express';

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

import opportunitiesRouter from '../opportunities';
import sessionsRouter from '../sessions';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * THE FIVE SESSION-WRITE OWNERSHIP GATES, PINNED FROM ONE TABLE.
 *
 * Each of these neutered to `const isOwner = true;` passed 919 of 919 jest
 * tests on 6504612 - measured one gate at a time, tree clean before and after:
 *
 *   POST   /api/opportunities/:id/sessions   opportunities.ts:3209
 *   DELETE /api/opportunities/:id/sessions   opportunities.ts:3347
 *   POST   /api/sessions                     sessions.ts:124
 *
 * The last two were added later and were unpinned by the same measurement.
 * Both route through `checkSessionOwnership` (sessions.ts:36), and neutering
 * THAT helper to `return true;` passed 1036 of 1036 on d3aa9c6 - as did making
 * its predicate `return true;` one line lower:
 *
 *   PATCH  /api/sessions/:id                 sessions.ts:321
 *   DELETE /api/sessions/:id                 sessions.ts:456
 *
 * "Three gates" was five. The finding that produced this file named the
 * INSTANCES it had found; the class was every write in the session family.
 *
 * What they admit is one researcher_admin editing another's recruitment
 * schedule: adding slots to a study they have nothing to do with, or deleting
 * every session under it. The DELETE is the worse of the two - it removes
 * bookings along with the sessions, and its only safety rail is a check for
 * bookings in `status = 'booked'`, so anything already cancelled or pending
 * goes silently.
 *
 * OUT OF SCOPE OF cto/AdaptaLabs#21, which pinned the participant-data READ
 * gates. These were unpinned before that work and stayed unpinned.
 *
 * WHY ONE TABLE AND NOT THREE FILES. The two POST handlers are near-duplicates
 * in different routers - same predicate, same 403 wording, ~100 lines and one
 * file apart - and the DELETE is the same shape again. That is exactly the
 * arrangement where a fix applied to one reads as a fix applied to all three,
 * which is how `approve`/`reject` came to be pinned together in
 * bookings.approve-reject-ownership.test.ts. Every case below therefore runs
 * against all three, and a separate test at the bottom fails by name if the
 * table ever stops covering one.
 *
 * THESE THREE DO CARRY A SUPERADMIN BYPASS, and that is pinned too. It is the
 * opposite disposition from POST /api/bookings/:id/cancel and from
 * GET /api/bookings/opportunities/:id/bookings, both of which refuse a
 * superadmin who does not own the opportunity. The asymmetry is real; the
 * point of pinning it on both sides is that changing it has to be deliberate.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (mount: string, router: Router, role: Role, id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: Role } } }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use(mount, router);
  app.use(errorHandler);
  return app;
};

const START = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const END = new Date(START.getTime() + 60 * 60 * 1000);

const VALID_SESSION = {
  start_time: START.toISOString(),
  end_time: END.toISOString(),
  capacity: 1,
};

/** The row an INSERT ... RETURNING gives back. Dates, because the handlers call `.toISOString()`. */
const INSERTED_ROW = {
  id: 'sess-1',
  opportunity_id: 'opp-1',
  capacity: 1,
  booked_count: 0,
  remaining: 1,
  start_time: START,
  end_time: END,
  created_at: START,
  updated_at: START,
};

/** The row PATCH reads back before it decides anything. `booked_count` is 0 so
 * the capacity guard does not fire and the arms stay about ownership. */
const CURRENT_SESSION_ROW = { ...INSERTED_ROW, booked_count: 0 };

/**
 * One dispatcher rather than a queue of `mockResolvedValueOnce`.
 *
 * A queue encodes call ORDER, so an arm that refuses early leaves entries
 * unconsumed and the next test fails for reasons that look nothing like the
 * cause. Routing on the SQL also means each arm below states which query it is
 * talking about, which is what the absence-assertions need.
 */
const answering = (ownerUserId: string | null, opportunityExists = true): void => {
  const impl = async (sql: unknown) => {
    const q = String(sql);
    if (q.includes('SELECT owner_user_id FROM opportunities')) {
      return opportunityExists ? { rows: [{ owner_user_id: ownerUserId }] } : { rows: [] };
    }
    if (q.includes('overlap_count')) return { rows: [{ overlap_count: '0' }] };
    if (q.includes('INSERT INTO sessions')) return { rows: [INSERTED_ROW] };
    // The DELETE route's "does anything still have a live booking?" probe.
    if (q.includes('FROM sessions s') && q.includes('EXISTS')) return { rows: [] };
    // ------------------------------------------------------------------
    // `checkSessionOwnership`, for PATCH and DELETE /api/sessions/:id.
    //
    // THIS ARM IS LOAD-BEARING AND ITS ABSENCE IS WHY THOSE TWO GATES WENT
    // UNPINNED. The predicate reaches the owner through a JOIN from the
    // session - `SELECT o.owner_user_id FROM sessions s JOIN opportunities o`
    // - which does NOT match the `SELECT owner_user_id FROM opportunities`
    // arm above. Without a row of its own it fell to the catch-all `{ rows:
    // [] }`, `isOpportunityOwner(undefined, ...)` returned false, and every
    // refusal assertion passed WITHOUT THE GATE BEING CONSULTED AT ALL. A
    // fixture that answers nothing makes a deny-by-default handler look
    // correct no matter what its predicate says.
    // ------------------------------------------------------------------
    if (q.includes('FROM sessions s') && q.includes('JOIN opportunities o')) {
      return opportunityExists ? { rows: [{ owner_user_id: ownerUserId }] } : { rows: [] };
    }
    // The superadmin half of the same predicate: existence, not ownership.
    if (/SELECT id\s+FROM sessions WHERE id = \$1/.test(q)) {
      return opportunityExists ? { rows: [{ id: 'sess-1' }] } : { rows: [] };
    }
    // PATCH's current-row read. DELETE's booking-count read moved to the
    // transaction client (see the clientQuery arm below) when the delete became
    // row-locked (cto/AdaptaLabs#34), so there is no pool-side booked_count arm
    // here any more.
    if (q.includes('SELECT * FROM sessions WHERE id = $1')) {
      return opportunityExists ? { rows: [CURRENT_SESSION_ROW] } : { rows: [] };
    }
    if (q.trimStart().startsWith('DELETE')) return { rows: [], rowCount: 2 };
    // autoCloseOpportunityIfNeeded, and anything else.
    return { rows: [] };
  };
  mockQuery.mockImplementation(impl);
};

/**
 * Every statement the handler issued, across BOTH sinks.
 *
 * Both `POST /api/opportunities/:id/sessions` and `POST /api/sessions` now
 * insert through a transaction client from `pool.connect()`. The second one did
 * NOT until cto/AdaptaLabs#42 - it inserted on the pool directly - and this
 * collection is why that move cost nothing here: a single-sink assertion would
 * have silently disarmed into passing for the wrong reason. Keep both sinks,
 * because the ownership probes still land on `pool.query`.
 */
let clientQuery: jest.Mock;

const allStatements = () =>
  [...mockQuery.mock.calls, ...clientQuery.mock.calls].map((call: unknown[]) => String(call[0]));

const matching = (pattern: RegExp) => allStatements().filter((sql) => pattern.test(sql));

const ROUTES = [
  {
    name: 'POST /api/opportunities/:id/sessions',
    mount: '/api/opportunities',
    router: opportunitiesRouter,
    method: 'post' as const,
    path: '/api/opportunities/opp-1/sessions',
    body: [VALID_SESSION],
    okStatus: 201,
    refusal: 'Only the owner can add sessions to this study',
    write: /INSERT INTO sessions/,
    writeCount: 1,
    ownershipProbe: /SELECT owner_user_id FROM opportunities/,
    missingStatus: 404,
  },
  {
    name: 'DELETE /api/opportunities/:id/sessions',
    mount: '/api/opportunities',
    router: opportunitiesRouter,
    method: 'delete' as const,
    path: '/api/opportunities/opp-1/sessions',
    body: undefined,
    okStatus: 200,
    refusal: 'Only the owner can delete sessions from this study',
    // Both the explicit booking sweep and the session delete. Counting them
    // asserts the handler removes participant bookings too, which is the part
    // that makes an unauthorised call unrecoverable.
    write: /^\s*DELETE FROM (bookings|sessions)/,
    writeCount: 2,
    ownershipProbe: /SELECT owner_user_id FROM opportunities/,
    missingStatus: 404,
  },
  {
    name: 'POST /api/sessions',
    mount: '/api/sessions',
    router: sessionsRouter,
    method: 'post' as const,
    path: '/api/sessions',
    body: { opportunity_id: 'opp-1', sessions: [VALID_SESSION] },
    okStatus: 201,
    refusal: 'Only the owner can add sessions to this opportunity',
    write: /INSERT INTO sessions/,
    writeCount: 1,
    ownershipProbe: /SELECT owner_user_id FROM opportunities/,
    missingStatus: 404,
  },
  // --------------------------------------------------------------------
  // THE TWO THAT GO THROUGH `checkSessionOwnership`, added because both were
  // unpinned. Neutering that helper to `return true;` passed 1036 of 1036 on
  // d3aa9c6 - measured, tree clean before and after - and so did making its
  // predicate `return true;` one line lower. What that admits is a
  // researcher_admin editing or deleting a session under a study they have
  // nothing to do with.
  //
  // They answer 403 rather than 404 to a researcher_admin for a session that
  // does not exist: the opposite leaks which session ids exist, which is the
  // oracle !215 closed on the results routes, so `missingStatus` records the
  // 403 deliberately rather than letting one table assume every route 404s.
  // A superadmin, entitled to the truth and able to enumerate every session
  // anyway, now gets the honest 404 instead - the !215 disposition, applied to
  // these two routes by cto/AdaptaLabs#28. That is pinned by the superadmin arm
  // below, which asserts 404 for the whole family.
  // --------------------------------------------------------------------
  {
    name: 'PATCH /api/sessions/:id',
    mount: '/api/sessions',
    router: sessionsRouter,
    method: 'patch' as const,
    path: '/api/sessions/sess-1',
    body: { capacity: 2 },
    okStatus: 200,
    refusal: 'Only the owner can edit this session',
    write: /UPDATE sessions/,
    writeCount: 1,
    ownershipProbe: /FROM sessions s[\s\S]*JOIN opportunities o/,
    missingStatus: 403,
  },
  {
    name: 'DELETE /api/sessions/:id',
    mount: '/api/sessions',
    router: sessionsRouter,
    method: 'delete' as const,
    path: '/api/sessions/sess-1',
    body: undefined,
    okStatus: 204,
    refusal: 'Only the owner can delete this session',
    write: /^\s*DELETE FROM sessions/,
    writeCount: 1,
    ownershipProbe: /FROM sessions s[\s\S]*JOIN opportunities o/,
    missingStatus: 403,
  },
] as const;

/**
 * EVERY `it` TITLE BELOW CARRIES ITS ROUTE NAME, and that is a requirement
 * rather than a flourish. scripts/mutation-canary.mjs selects the test an
 * entry names with `fullName.endsWith(...)` and refuses to run when more than
 * one matches - so three routes sharing one title makes every entry in this
 * family TEST_AMBIGUOUS and reds the build. It is also what lets a reader of a
 * failure line know which of the three handlers broke without opening the file.
 */
describe.each(ROUTES)(
  '$name ownership',
  ({ name, mount, router, method, path, body, okStatus, refusal, write, writeCount, ownershipProbe, missingStatus }) => {
    beforeEach(() => {
      jest.resetAllMocks();
      mockIsDatabaseAvailable.mockResolvedValue(true as never);
      clientQuery = jest.fn(async (sql: unknown) => {
        const q = String(sql);
        if (q.includes('INSERT INTO sessions')) return { rows: [INSERTED_ROW] };
        // PATCH updates inside a transaction, and reads the returned row back
        // through `.toISOString()` - so an empty result is a TypeError, not a
        // failed assertion.
        if (q.includes('UPDATE sessions')) return { rows: [INSERTED_ROW] };
        if (q.includes('overlap_count')) return { rows: [{ overlap_count: '0' }] };
        // DELETE /api/sessions/:id now reads the booking count under FOR UPDATE
        // on the transaction client, not the pool (cto/AdaptaLabs#34 TOCTOU
        // fix). 0 bookings, so the owner-through arm reaches the DELETE.
        if (q.includes('booked_count FROM sessions WHERE id')) return { rows: [{ booked_count: 0 }] };
        return { rows: [] };
      });
      mockConnect.mockResolvedValue({ query: clientQuery, release: jest.fn() } as never);
    });

    const call = (role: Role, id: string) => {
      const req = request(listening(appAs(mount, router, role, id)))[method](path);
      return body === undefined ? req : req.send(body as object);
    };

    // ----------------------------------------------------------------
    // THE CONTROL. Without it, a handler that answered 403 unconditionally, or
    // one that threw before it reached the database, would satisfy every
    // refusal assertion below while proving nothing about ownership. It is
    // also the presence arm for the absence-assertions: it shows this exact
    // fixture DOES produce the write when the caller is entitled to it.
    // ----------------------------------------------------------------
    it(`lets the opportunity owner through, and the write actually happens, on ${name}`, async () => {
      answering('admin-1');

      await call('researcher_admin', 'admin-1').expect(okStatus);

      expect(matching(write)).toHaveLength(writeCount);
      // THE PRESENCE ARM FOR THE PROBE ABSENCE-ASSERTION FURTHER DOWN. That one
      // requires the ownership query NOT to be issued for a non-admin; without
      // this, it would pass just as well against a route that never issues the
      // query at all - which is exactly what happened when the pattern named a
      // statement the session routes do not emit.
      expect(matching(ownershipProbe).length).toBeGreaterThan(0);
    });

    it(`refuses a researcher_admin who does not own the opportunity, on ${name}`, async () => {
      answering('admin-2');

      const res = await call('researcher_admin', 'admin-1').expect(403);

      expect(res.body.error).toBe(refusal);
    });

    // The absence-assertion, controlled by the arm above.
    it(`writes nothing at all for a non-owning admin on ${name}`, async () => {
      answering('admin-2');

      await call('researcher_admin', 'admin-1').expect(403);

      expect(matching(write)).toHaveLength(0);
    });

    it(`lets a superadmin through, which is this family and not the bookings routes, on ${name}`, async () => {
      answering('admin-2');

      await call('superadmin', 'root-1').expect(okStatus);

      expect(matching(write)).toHaveLength(writeCount);
    });

    it(`refuses an ownerless opportunity rather than adopting it, on ${name}`, async () => {
      // `canWriteStudy` fails OPEN for an unowned study so legacy studies stay
      // editable by whoever finds them. These three do not, and should not: an
      // unowned row here is a schedule with nobody accountable for the
      // participants already booked into it.
      answering(null);

      const res = await call('researcher_admin', 'admin-1').expect(403);

      expect(res.body.error).toBe(refusal);
      expect(matching(write)).toHaveLength(0);
    });

    it(`refuses a non-admin before it looks the opportunity up at all, on ${name}`, async () => {
      answering('admin-1');

      const res = await call('employee', 'user-1').expect(403);

      expect(res.body.error).toBe('Admin access required');
      expect(matching(ownershipProbe)).toHaveLength(0);
    });

    it(`refuses a target that does not exist, and writes nothing, on ${name}`, async () => {
      answering('admin-1', false);

      await call('researcher_admin', 'admin-1').expect(missingStatus);

      expect(matching(write)).toHaveLength(0);
    });

    // The superadmin half of the arm above, and NOT redundant with it. Every
    // other refusal case here runs as a researcher_admin, so the superadmin
    // branch of `checkSessionOwnership` - a separate query that checks only
    // that the row EXISTS - was reachable with nothing asserting it. Replacing
    // that branch with `return true;` survived all 36 tests until this arm was
    // added.
    //
    // A superadmin is told the truth: 404 for a session that genuinely does not
    // exist, across the whole family. That is !215's disposition (abea2c6),
    // which collapsed the RESULTS routes onto 403 for a caller who may not read
    // and deliberately KEPT the superadmin's accurate 404, pinned there by
    // `still tells a superadmin the truth about an id that is not there`. Its
    // message records why answering 403 to everybody was wrong: it "also closes
    // the oracle and passed all 295 tests while losing the truth for the one
    // caller entitled to it". A superadmin can enumerate every session anyway,
    // so there is no oracle to close against them.
    //
    // For the two /api/sessions/:id routes this used to be 403 - the predicate
    // returned one boolean and the handler could not tell "no such session"
    // from "not yours" - and was pinned as deliberate pending a decision.
    // cto/AdaptaLabs#28 took that decision (option B): `checkSessionOwnership`
    // now returns three-way and the superadmin arm answers 404 like the rest of
    // the family. So this arm asserts 404 directly rather than through
    // `missingStatus` (which still carries the researcher_admin 403 for the
    // session routes).
    it(`answers 404 to a superadmin for a target that does not exist, on ${name}`, async () => {
      answering('admin-1', false);

      await call('superadmin', 'root-1').expect(404);

      expect(matching(write)).toHaveLength(0);
    });
  }
);

/**
 * About the table rather than about the routes.
 *
 * Three near-identical handlers is precisely the shape where a case gets added
 * to one and forgotten on the others. This fails by name if a row is ever
 * dropped - rather than the coverage disappearing as a quiet fall in the test
 * count, which nobody reads.
 */
describe('the session-write ownership table', () => {
  it('covers all five session-write gates and not a subset', () => {
    expect(ROUTES.map((r) => r.name).sort()).toEqual([
      'DELETE /api/opportunities/:id/sessions',
      'DELETE /api/sessions/:id',
      'PATCH /api/sessions/:id',
      'POST /api/opportunities/:id/sessions',
      'POST /api/sessions',
    ]);
  });
});
