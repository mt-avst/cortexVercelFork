import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express, { Router } from 'express';

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
 * THE THREE SESSION-WRITE OWNERSHIP GATES, PINNED FROM ONE TABLE.
 *
 * Each of these neutered to `const isOwner = true;` passed 919 of 919 jest
 * tests on 6504612 - measured one gate at a time, tree clean before and after:
 *
 *   POST   /api/opportunities/:id/sessions   opportunities.ts:3209
 *   DELETE /api/opportunities/:id/sessions   opportunities.ts:3347
 *   POST   /api/sessions                     sessions.ts:124
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
    if (q.trimStart().startsWith('DELETE')) return { rows: [], rowCount: 2 };
    // autoCloseOpportunityIfNeeded, and anything else.
    return { rows: [] };
  };
  mockQuery.mockImplementation(impl);
};

/**
 * Every statement the handler issued, across BOTH sinks.
 *
 * `POST /api/opportunities/:id/sessions` inserts through a transaction client
 * from `pool.connect()`; `POST /api/sessions` inserts on the pool directly.
 * Collecting both means the write assertions keep working if a handler moves
 * between the two - a refactor that would otherwise silently disarm a
 * single-sink assertion into passing for the wrong reason.
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
    refusal: 'Only the owner can add sessions to this opportunity',
    write: /INSERT INTO sessions/,
    writeCount: 1,
  },
  {
    name: 'DELETE /api/opportunities/:id/sessions',
    mount: '/api/opportunities',
    router: opportunitiesRouter,
    method: 'delete' as const,
    path: '/api/opportunities/opp-1/sessions',
    body: undefined,
    okStatus: 200,
    refusal: 'Only the owner can delete sessions from this opportunity',
    // Both the explicit booking sweep and the session delete. Counting them
    // asserts the handler removes participant bookings too, which is the part
    // that makes an unauthorised call unrecoverable.
    write: /^\s*DELETE FROM (bookings|sessions)/,
    writeCount: 2,
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
  ({ name, mount, router, method, path, body, okStatus, refusal, write, writeCount }) => {
    beforeEach(() => {
      jest.resetAllMocks();
      mockIsDatabaseAvailable.mockResolvedValue(true as never);
      clientQuery = jest.fn(async (sql: unknown) => {
        const q = String(sql);
        if (q.includes('INSERT INTO sessions')) return { rows: [INSERTED_ROW] };
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
      expect(matching(/SELECT owner_user_id FROM opportunities/)).toHaveLength(0);
    });

    it(`404s an opportunity that does not exist, and writes nothing, on ${name}`, async () => {
      answering('admin-1', false);

      await call('researcher_admin', 'admin-1').expect(404);

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
  it('covers all three session-write gates and not a subset', () => {
    expect(ROUTES.map((r) => r.name).sort()).toEqual([
      'DELETE /api/opportunities/:id/sessions',
      'POST /api/opportunities/:id/sessions',
      'POST /api/sessions',
    ]);
  });
});
