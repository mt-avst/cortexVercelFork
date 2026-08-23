import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

jest.mock('../../services/gamification', () => ({
  getUserProfile: jest.fn(),
  getUserAchievements: jest.fn(),
  getLeaderboard: jest.fn(),
  getMonthlyLeaderboard: jest.fn(),
  getPointsHistory: jest.fn(),
}));

import gamificationRouter, { MAX_LEADERBOARD_LIMIT, leaderboardLimit } from '../gamification';
import { getLeaderboard, getMonthlyLeaderboard } from '../../services/gamification';
import { errorHandler } from '../../utils/errorHandler';

const mockGetLeaderboard = getLeaderboard as unknown as jest.Mock;
const mockGetMonthlyLeaderboard = getMonthlyLeaderboard as unknown as jest.Mock;

/**
 * Both leaderboard routes are UNAUTHENTICATED and both took `limit` from the
 * query string with only a `|| 10` fallback in front of a SQL `LIMIT $1`, so
 * `?limit=1000000` ordered the whole `user_profiles` table joined to `users`
 * and serialised every participant's name and points to anyone on the network.
 *
 * TWO ROUTES, and the cap is asserted on BOTH from one table. The pair is
 * fourteen lines apart and near-identical, which is the shape where a fix
 * applied to one reads as a fix applied to both - the same trap the approve
 * and reject handlers set in bookings.ts.
 */
const app = (() => {
  const a = express();
  a.use(express.json());
  a.use('/api/gamification', gamificationRouter);
  a.use(errorHandler);
  return a;
})();

const ROUTES = [
  { name: 'all-time', path: '/api/gamification/leaderboard', mock: () => mockGetLeaderboard },
  { name: 'monthly', path: '/api/gamification/leaderboard/monthly', mock: () => mockGetMonthlyLeaderboard },
] as const;

/** The limit the route actually asked the service for. */
const requestedLimit = (m: jest.Mock) => m.mock.calls[0]?.[0];

describe.each(ROUTES)('GET $path limit', ({ name, path, mock }) => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetLeaderboard.mockResolvedValue([] as never);
    mockGetMonthlyLeaderboard.mockResolvedValue([] as never);
  });

  // THE CONTROL. Without an arm showing an ordinary limit passes THROUGH
  // untouched, a route that hardcoded 10 and ignored the query entirely would
  // satisfy every ceiling assertion below.
  it(`passes an ordinary ${name} limit through unchanged`, async () => {
    await request(listening(app)).get(`${path}?limit=25`).expect(200);

    expect(requestedLimit(mock())).toBe(25);
  });

  it(`caps the ${name} limit at the number that was decided`, async () => {
    await request(listening(app)).get(`${path}?limit=1000000`).expect(200);

    // THE LITERAL, not `MAX_LEADERBOARD_LIMIT`. A test that derives its
    // expectation from the constant cannot see the constant change, which is
    // how three mutations survived a review in this repository before.
    expect(requestedLimit(mock())).toBe(100);
  });

  it(`falls back for a missing ${name} limit`, async () => {
    await request(listening(app)).get(path).expect(200);

    expect(requestedLimit(mock())).toBe(10);
  });

  // `parseInt('-5')` is -5, which is TRUTHY, so the old `|| 10` fallback never
  // fired and `LIMIT -5` reached Postgres, which refuses it. An
  // unauthenticated 500 on a public route, and the sharper half of the defect.
  it(`refuses a negative ${name} limit rather than passing it to SQL`, async () => {
    await request(listening(app)).get(`${path}?limit=-5`).expect(200);

    expect(requestedLimit(mock())).toBe(10);
  });

  it(`refuses a non-numeric ${name} limit`, async () => {
    await request(listening(app)).get(`${path}?limit=all`).expect(200);

    expect(requestedLimit(mock())).toBe(10);
  });
});

/**
 * Named separately because it is about the table, not about a route. The two
 * handlers are near-identical, so a case added to one and forgotten in the
 * other is the likely failure, and it would show up as a quiet drop in the
 * test count rather than as a red test.
 */
describe('the leaderboard limit table', () => {
  it('covers both leaderboard routes and not just one of them', () => {
    expect(ROUTES.map((r) => r.name).sort()).toEqual(['all-time', 'monthly']);
  });
});

describe('leaderboardLimit', () => {
  it('holds the ceiling at the number that was decided', () => {
    // Asserted on the exported constant too, so that raising the ceiling is a
    // deliberate two-place edit rather than something a route change carries
    // along with it.
    expect(MAX_LEADERBOARD_LIMIT).toBe(100);
  });

  it('clamps at the boundary rather than one either side of it', () => {
    expect(leaderboardLimit(99)).toBe(99);
    expect(leaderboardLimit(100)).toBe(100);
    expect(leaderboardLimit(101)).toBe(100);
    expect(leaderboardLimit(1)).toBe(1);
    // Zero is not a page of results, it is an empty one asked for by mistake.
    expect(leaderboardLimit(0)).toBe(10);
  });

  it('refuses the shapes a query string can actually carry', () => {
    // Express gives `req.query.limit` as string, string[] or undefined.
    expect(leaderboardLimit(undefined)).toBe(10);
    expect(leaderboardLimit('')).toBe(10);
    expect(leaderboardLimit('NaN')).toBe(10);
    expect(leaderboardLimit(['5', '9999'])).toBe(10);
    expect(leaderboardLimit(Infinity)).toBe(10);
  });
});
