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
    const identityBinding = src.match(/JOIN users u[\s\S]*?`, \[(\w+)\]\);/);
    expect(identityBinding).not.toBeNull();
    expect(identityBinding![1]).toBe('participantIdentityOwnerId');

    // And every count query is bound to the OTHER constant. Counted rather
    // than pattern-matched across the file: a lazy `COUNT([\s\S]*?` regex
    // spans from one handler into the next and reports a match that is not
    // there - it did, on the first draft of this assertion.
    const countBindings = src.match(/\[(?:now, )?countsOwnerId(?:, now)?\]/g) ?? [];
    const identityBindings = src.match(/\[participantIdentityOwnerId\]/g) ?? [];
    expect(countBindings).toHaveLength(4);
    // One per handler: the dashboard's recent_bookings and the CSV export.
    expect(identityBindings).toHaveLength(2);
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
    expect(params).toEqual(['admin-1']);
  });

  it('does not scope a superadmin', async () => {
    await request(listening(appAs('superadmin', 'root-1')))
      .get('/api/admin/export/bookings')
      .expect(200);

    const [, params] = identityCalls()[0] as [string, unknown[]];
    expect(params).toEqual([null]);
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
