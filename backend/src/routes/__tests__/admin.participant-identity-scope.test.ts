import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import adminRouter from '../admin';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;

/**
 * TWO ROUTES IN admin.ts RETURN PARTICIPANT NAMES AND EMAILS, and each was
 * scoped to the caller's own opportunities by a bare `filterOwnerId` that no
 * test looked at. Setting either to `null` - the superadmin value - published
 * every other researcher's participants and passed 844 of 844 jest tests on
 * e717537. Measured separately for each of the two.
 *
 * The dashboard one is the sharper of the two, because four of the five
 * queries it governed return COUNTS. Counts read as presentational, so
 * "these numbers may as well be global" is a plausible-sounding change - and
 * making it widened the fifth query, which returns `recent_bookings`. That
 * argument is why the handler now declares two constants and why both are
 * pinned here.
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
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
};

/** Every query whose select list carries a participant identity. */
const identityCalls = () =>
  mockQuery.mock.calls.filter((call: unknown[]) =>
    String(call[0]).includes('u.email as participant_email') ||
    String(call[0]).includes('u.email AS participant_email')
  );

/** Every query that returns only counts. */
const countCalls = () =>
  mockQuery.mock.calls.filter((call: unknown[]) => {
    const sql = String(call[0]);
    return sql.includes('COUNT(') && !sql.includes('participant_email');
  });

describe('GET /api/admin/dashboard participant-identity scope', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue({ rows: [] } as never);
  });

  // THE CONTROL for every absence-assertion in this file. `identityCalls()`
  // returning nothing is the same observation whether the scoping worked or
  // the matcher simply stopped matching any SQL - a select-list rename would
  // silently turn every assertion below into a tautology. This arm fails when
  // that happens.
  it('runs exactly one query carrying participant identities', async () => {
    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get('/api/admin/dashboard')
      .expect(200);

    expect(identityCalls()).toHaveLength(1);
    expect(countCalls().length).toBeGreaterThan(0);
  });

  it('binds the caller to the participant-identity read', async () => {
    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get('/api/admin/dashboard')
      .expect(200);

    const [sql, params] = identityCalls()[0] as [string, unknown[]];
    // Scoped in SQL, not after the fact: a filter applied in JS has already
    // pulled every other researcher's participants into this process.
    expect(String(sql)).toMatch(/o\.owner_user_id\s*=\s*\$1/);
    // Asserted as the VALUE and not merely as "a parameter is bound". A bound
    // parameter stays bound whether the predicate still uses it or not.
    expect(params).toEqual(['admin-1']);
  });

  it('scopes the counts to the caller too', async () => {
    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get('/api/admin/dashboard')
      .expect(200);

    // BY POSITION, NOT BY MEMBERSHIP. `toContain` is position-blind, so it
    // passes just as well when `[ownerId, now]` is bound as `[now, ownerId]` -
    // a security gate demonstrated exactly that swap surviving all 884 tests
    // in both count queries that take two parameters. The swap fails loudly at
    // runtime rather than widening anything (Postgres refuses a timestamp cast
    // to uuid, measured), so this is correctness rather than a leak - but a
    // 500 on the admin dashboard is still a defect no test could name.
    for (const call of countCalls()) {
      const sql = String(call[0]);
      const params = call[1] as unknown[];
      const ownerPlaceholder = sql.match(/owner_user_id\s*=\s*\$(\d)/);

      expect(ownerPlaceholder).not.toBeNull();
      // `$1` is params[0].
      const at = Number(ownerPlaceholder![1]) - 1;
      expect(params[at]).toBe('admin-1');
    }
  });

  // The two constants are separate declarations with the same value today.
  // What this pins is that widening one does not widen the other: it is the
  // only assertion that fails if they are folded back into one.
  it('keeps the counts scope and the identity scope independently settable', async () => {
    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get('/api/admin/dashboard')
      .expect(200);

    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../admin.ts'),
      'utf8'
    ) as string;

    expect(src).toContain('const countsOwnerId =');
    expect(src).toContain('const participantIdentityOwnerId =');
    // Two declarations, not one aliased to the other.
    expect(src).not.toMatch(/const participantIdentityOwnerId = countsOwnerId/);
    expect(src).not.toMatch(/const countsOwnerId = participantIdentityOwnerId/);

    // AND THE BINDING SITES, which is the half that was missing. Asserting the
    // declarations alone let the split be undone where it matters: re-binding
    // recent_bookings to `countsOwnerId` passed all 884 tests, including this
    // one, because nothing asked WHICH constant reached the identity SQL. The
    // two constants hold the same value, so no behavioural assertion can tell
    // them apart - which is exactly why the shape has to be asserted as a
    // shape, and asserted completely.
    // SLICED PER HANDLER RATHER THAN REGEXED ACROSS THE FILE. The note above
    // records a lazy pattern spanning from one handler into the next and
    // reporting a match that was not there. Slicing on the two `router.get`
    // sites removes that whole class instead of tightening the pattern again,
    // and it is what let this survive #65 turning the export into a keyset
    // walk: the binding is still asserted, it simply is no longer the only
    // parameter in its array.
    const dashboardHandler = src.slice(
      src.indexOf("router.get('/dashboard'"),
      src.indexOf("router.get('/export/bookings'")
    );
    const exportHandler = src.slice(src.indexOf("router.get('/export/bookings'"));
    // Both slices are non-empty and in the expected order, or every assertion
    // below is vacuously true against an empty string.
    expect(dashboardHandler.length).toBeGreaterThan(0);
    expect(exportHandler.length).toBeGreaterThan(0);

    // The dashboard's recent_bookings still binds the identity constant, and
    // still as the sole parameter. The dashboard handler names BOTH constants
    // by design - counts for the count queries, identity for recent_bookings -
    // so the useful assertion is WHICH ONE reaches the query carrying the
    // participant join, not that the other is absent. Safe as a lazy match
    // here in a way it was not across the file, because the slice is one
    // handler: there is no next handler for it to run into.
    const dashboardIdentityBinding = dashboardHandler.match(
      /JOIN users u[\s\S]*?`, \[(\w+)\]\);/
    );
    expect(dashboardIdentityBinding).not.toBeNull();
    expect(dashboardIdentityBinding![1]).toBe('participantIdentityOwnerId');

    // The export binds it FIRST, which is what `$1` - the owner filter - takes.
    // #65 added four parameters after it for the keyset walk and the limit.
    expect(exportHandler).toMatch(/\[\s*participantIdentityOwnerId,/);
    // THE ASSERTION THAT KILLS THE ORIGINAL DEFECT. Re-binding the export to
    // the counts constant is the mutation this whole file exists for, and the
    // two constants hold the same value, so no behavioural test can tell them
    // apart. The export handler must not name it at all.
    expect(exportHandler).not.toContain('countsOwnerId');

    // And every count query is still bound to the OTHER constant. Decision 2's
    // toggle widens the counts by deriving `effectiveCountsOwnerId` from
    // `countsOwnerId`, so that derived value is what the four count queries now
    // bind - never the identity constant.
    const countBindings = src.match(/\[(?:now, )?effectiveCountsOwnerId(?:, now)?\]/g) ?? [];
    expect(countBindings).toHaveLength(4);
    // The widened value is derived from the counts constant and NEVER from the
    // identity one, so the toggle cannot quietly fold the two scopes together -
    // the assertion that fails if `effectiveCountsOwnerId` is ever computed from
    // `participantIdentityOwnerId`.
    const derivation = dashboardHandler.match(/const effectiveCountsOwnerId =[\s\S]*?;/);
    expect(derivation).not.toBeNull();
    expect(derivation![0]).toContain('countsOwnerId');
    expect(derivation![0]).not.toContain('participantIdentityOwnerId');
  });

  it('does not scope a superadmin, who is meant to see the whole platform', async () => {
    await request(listening(appAs('superadmin', 'root-1')))
      .get('/api/admin/dashboard')
      .expect(200);

    const [, params] = identityCalls()[0] as [string, unknown[]];
    expect(params).toEqual([null]);
  });

  it('refuses a non-admin without querying anything', async () => {
    await request(listening(appAs('employee', 'user-1')))
      .get('/api/admin/dashboard')
      .expect(403);

    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/export/bookings participant-identity scope', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue({ rows: [] } as never);
  });

  // THE CONTROL. Same reasoning as the dashboard's: an empty match set proves
  // nothing on its own.
  it('runs exactly one query, and it carries participant identities', async () => {
    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get('/api/admin/export/bookings')
      .expect(200);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(identityCalls()).toHaveLength(1);
  });

  it('binds the caller to the export query', async () => {
    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get('/api/admin/export/bookings')
      .expect(200);

    const [sql, params] = identityCalls()[0] as [string, unknown[]];
    expect(String(sql)).toMatch(/o\.owner_user_id\s*=\s*\$1/);
    // ASSERTED IN FULL, not by index. Since #65 the export is a keyset walk:
    // `$1` is still the owner scope, `$2`-`$4` are the batch cursor and are
    // null on the first batch, `$5` is the batch size as a LITERAL. A sixth
    // parameter, or the owner id moving out of `$1`, fails here.
    expect(params).toEqual(['admin-1', null, null, null, 500]);
  });

  it('does not scope a superadmin', async () => {
    await request(listening(appAs('superadmin', 'root-1')))
      .get('/api/admin/export/bookings')
      .expect(200);

    const [, params] = identityCalls()[0] as [string, unknown[]];
    expect(params).toEqual([null, null, null, null, 500]);
  });

  it('refuses a non-admin without querying anything', async () => {
    await request(listening(appAs('employee', 'user-1')))
      .get('/api/admin/export/bookings')
      .expect(403);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('emits the participant columns it is scoped to protect', async () => {
    // If the export stopped carrying identities, the scoping above would be
    // moot and these tests would be guarding an empty envelope. Named so that
    // change is a decision rather than a silent loosening of what matters.
    mockQuery.mockResolvedValue({
      rows: [
        {
          opportunity_title: 'Study A',
          opportunity_type: 'interview',
          session_start: new Date('2026-01-01T10:00:00Z'),
          session_end: new Date('2026-01-01T11:00:00Z'),
          participant_name: 'Sam Participant',
          participant_email: 'sam@example.com',
          booking_status: 'booked',
          booked_at: new Date('2026-01-01T09:00:00Z'),
        },
      ],
    } as never);

    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get('/api/admin/export/bookings')
      .expect(200);

    expect(res.text).toContain('sam@example.com');
    expect(res.text).toContain('Sam Participant');
  });
});
