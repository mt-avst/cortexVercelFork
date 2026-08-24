import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { SessionUser } from '../../../../shared/types';

jest.mock('../../services/gamification', () => ({
  getUserProfile: jest.fn(),
  getUserAchievements: jest.fn(),
  getLeaderboard: jest.fn(),
  getMonthlyLeaderboard: jest.fn(),
  getPointsHistory: jest.fn(),
}));

import gamificationRouter, {
  MAX_POINTS_HISTORY_LIMIT,
  pointsHistoryLimit,
} from '../gamification';
import { getPointsHistory } from '../../services/gamification';
import { errorHandler } from '../../utils/errorHandler';

const mockGetPointsHistory = getPointsHistory as unknown as jest.Mock;

/**
 * THE THIRD ROUTE IN THE FILE, left behind when cto/AdaptaLabs#17 capped the
 * other two. That is the whole lesson worth recording here: #17's finding
 * named an INSTANCE - "the two leaderboard routes" - and the class was the
 * file. `GET /points-history` sat thirteen lines below the pair it was
 * grouped with, kept its `parseInt(req.query.limit as string) || 20`, and the
 * docblock above it recorded the defect as fixed.
 *
 * It is NOT the leaderboard leak. `getPointsHistory` binds `limit` as `$2` -
 * no injection - and scopes rows to `WHERE user_id = $1`, the caller's own
 * id, so no other user's data is reachable at any limit. Two things remain:
 *
 *   `?limit=999999999` is an unbounded read of the caller's own table.
 *   `?limit=-5` is a 500. `parseInt('-5')` is -5, TRUTHY, so `|| 20` never
 *   fired and `LIMIT -5` reached Postgres. Verified against a real Postgres
 *   17 rather than assumed: it raises SQLSTATE 2201W, "LIMIT must not be
 *   negative", which this route's catch turns into a 500. Same sharper half
 *   as #17, on the route #17 missed.
 *
 * The default here is 20 and NOT the leaderboard's 10, which is why this
 * route gets its own bounded parser rather than borrowing `leaderboardLimit`.
 * Sharing that function would have been a one-word fix that silently halved
 * the page.
 */
const AUTHENTICATED_USER: SessionUser = {
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@example.com',
  role: 'employee',
};

// `requireAuth` reads `req.session.user` and nothing else - no `.save()`, no
// `.touch()` - so a plain object is enough and the real express-session
// middleware would only add moving parts. Typed as the session's own shape
// rather than `any`, so a change to `SessionUser` reaches this file.
const attachSession = (req: Request, _res: Response, next: NextFunction) => {
  req.session = { user: AUTHENTICATED_USER } as Request['session'];
  next();
};

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use(attachSession);
  a.use('/api/gamification', gamificationRouter);
  a.use(errorHandler);
  return a;
})();

const PATH = '/api/gamification/points-history';

/** The limit the route actually asked the service for. */
const requestedLimit = () => mockGetPointsHistory.mock.calls[0]?.[1];

describe('GET /api/gamification/points-history limit', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetPointsHistory.mockResolvedValue([] as never);
  });

  // THE CONTROL. Without an arm showing an ordinary limit passes THROUGH
  // untouched, a route that hardcoded 20 and ignored the query string
  // entirely would satisfy every ceiling assertion below.
  it('passes an ordinary limit through unchanged', async () => {
    await request(listening(app)).get(`${PATH}?limit=25`).expect(200);

    expect(requestedLimit()).toBe(25);
  });

  // cto/AdaptaLabs#24: above the ceiling is now a VISIBLE wall, not a silent
  // clamp. The rows are the caller's own transactions with no cursor, so a
  // clamped short page is indistinguishable from the end of history - refusing
  // is the only answer that does not lie by omission.
  it('refuses a limit above the ceiling instead of silently capping it', async () => {
    await request(listening(app)).get(`${PATH}?limit=999999999`).expect(400);

    // Nothing is fetched, so there is no short page to mistake for the end.
    expect(mockGetPointsHistory).not.toHaveBeenCalled();
  });

  it('allows exactly the ceiling and passes it through', async () => {
    await request(listening(app)).get(`${PATH}?limit=100`).expect(200);

    // THE LITERAL, not `MAX_POINTS_HISTORY_LIMIT`. A test that derives its
    // expectation from the constant cannot see the constant change, which is
    // how three mutations survived a review in this repository before.
    expect(requestedLimit()).toBe(100);
  });

  it('refuses one above the ceiling and passes one at it', async () => {
    await request(listening(app)).get(`${PATH}?limit=101`).expect(400);

    expect(mockGetPointsHistory).not.toHaveBeenCalled();
  });

  // The half that 500s, and the reason this is a bug rather than a policy
  // gap.
  //
  // THE ASSERTION THAT CARRIES THE PROPERTY IS `toBe(20)`, NOT `.expect(200)`.
  // An earlier draft of this comment claimed the 200 proved the 500 was gone.
  // It does not and cannot: `getPointsHistory` is mocked here, so `LIMIT -5`
  // never reaches a database and the route answers 200 with or without the
  // fix. Reinstating the pre-fix line fails on the `toBe(20)` line below and
  // never on the status. The 200 proves only that the route does not reject
  // the request outright; the 500 is reachable only against a real Postgres,
  // where `LIMIT -5` raises SQLSTATE 2201W.
  it('refuses a negative limit rather than passing it to SQL', async () => {
    await request(listening(app)).get(`${PATH}?limit=-5`).expect(200);

    expect(requestedLimit()).toBe(20);
  });

  it('falls back to the points-history default, which is not the leaderboard default', async () => {
    await request(listening(app)).get(PATH).expect(200);

    // 20, not 10. Reusing `leaderboardLimit` here would pass every other
    // assertion in this file and quietly halve the page.
    expect(requestedLimit()).toBe(20);
  });

  it('refuses a non-numeric limit', async () => {
    await request(listening(app)).get(`${PATH}?limit=all`).expect(200);

    expect(requestedLimit()).toBe(20);
  });

  it('still requires authentication', async () => {
    const anon = express();
    anon.use('/api/gamification', gamificationRouter);
    anon.use(errorHandler);

    await request(listening(anon)).get(PATH).expect(401);

    expect(mockGetPointsHistory).not.toHaveBeenCalled();
  });
});

describe('pointsHistoryLimit', () => {
  it('holds the ceiling at the number that was decided', () => {
    expect(MAX_POINTS_HISTORY_LIMIT).toBe(100);
  });

  it('refuses above the boundary, and holds it at and below', () => {
    expect(pointsHistoryLimit(99)).toBe(99);
    expect(pointsHistoryLimit(100)).toBe(100);
    // Above the ceiling is REFUSED (null -> the route answers 400), not
    // clamped to 100, so a short page is never mistaken for the end of history
    // (cto/AdaptaLabs#24).
    expect(pointsHistoryLimit(101)).toBeNull();
    expect(pointsHistoryLimit(1)).toBe(1);
    // Zero is not a page of results, it is an empty one asked for by mistake -
    // a malformed request, so it falls back to the default rather than being
    // refused. Only an over-large limit hits the wall.
    expect(pointsHistoryLimit(0)).toBe(20);
  });

  it('refuses the shapes a query string can actually carry', () => {
    expect(pointsHistoryLimit(undefined)).toBe(20);
    expect(pointsHistoryLimit('')).toBe(20);
    expect(pointsHistoryLimit('NaN')).toBe(20);
    // A repeated parameter is an array, and `String(['5','9999'])` is
    // '5,9999', which `parseInt` reads as 5 - an answer nobody chose.
    expect(pointsHistoryLimit(['5', '9999'])).toBe(20);
    expect(pointsHistoryLimit(Infinity)).toBe(20);
  });
});

/**
 * THE CLASS, NOT THE INSTANCE.
 *
 * #17 fixed the two routes it named and left the third, and nothing failed.
 * Per-route tables cannot detect a route added LATER, because a test that
 * does not exist cannot fail. So this reads the source, and the file itself
 * is the subject.
 *
 * THREE CHECKS, BECAUSE THE FIRST DRAFT HAD TWO BLIND SPOTS AND BOTH WERE
 * FOUND BY REVIEW GATES RATHER THAN BY ME:
 *
 *   A gate appended a route reading `req.query['limit']` and another
 *   destructuring `const { limit } = req.query`. Twelve tests stayed green.
 *   The matcher knew one idiom.
 *
 *   A second gate appended a route reading a DIFFERENT PARAMETER NAME -
 *   `req.query.count` - feeding the same unbounded `LIMIT $2`. Twenty-six
 *   tests stayed green, including the count that was meant to be the
 *   tripwire. The matcher knew one parameter.
 *
 * Both mutants were the original defect wearing different clothes. A guard
 * written against the shape of the bug you already found is an instance
 * again, one level up - which is the exact mistake this file exists to
 * record. The controls below therefore exercise the shapes the scan might
 * MISS, not the shape that motivated writing it.
 */
describe('every limit in routes/gamification.ts is bounded', () => {
  const SOURCE_PATH = join(__dirname, '..', 'gamification.ts');
  const source = readFileSync(SOURCE_PATH, 'utf8');

  /**
   * Comment lines are dropped because the docblocks in this file QUOTE the
   * old broken expressions verbatim, which is the point of them. The pattern
   * only matches a line that STARTS with a comment marker, so it cannot hide
   * a line of code.
   */
  const isComment = (line: string) => /^\s*(\/\/|\/?\*)/.test(line);

  const codeLines = (text: string) => text.split('\n').filter((line) => !isComment(line));

  /**
   * ANY parameter, not just `limit`, and any of the three ways to read one.
   * The second gate's mutant used `req.query.count`; a scan keyed to the word
   * `limit` is a scan for the bug that already happened.
   */
  const READ_SHAPES = [
    /req\.query\.\w+/,
    /req\.query\[\s*['"`][^'"`]+['"`]\s*\]/,
    /\{[^}]*\}\s*=\s*req\.query/,
  ];

  const readsQueryParam = (text: string) =>
    codeLines(text).filter((line) => READ_SHAPES.some((shape) => shape.test(line)));

  /**
   * The bounding parsers, PINNED BY NAME. A name-shaped check alone would be
   * satisfied by a `fooLimit` that returns its input untouched - a real gap a
   * gate named. Pinning the set means a new parser has to be added here
   * deliberately, and the canary entries pin that each one actually clamps.
   */
  const BOUNDING_PARSERS = ['leaderboardLimit', 'pointsHistoryLimit'];

  const isBounded = (line: string) =>
    BOUNDING_PARSERS.some((parser) => new RegExp(`\\b${parser}\\(req\\.query`).test(line));

  /**
   * Query parameters deliberately reviewed and found not to be a bound - a
   * sort key, a filter string. EMPTY TODAY, and that is the point: a new
   * non-numeric parameter must be added here by a person, rather than
   * slipping past a scan that only looked for numbers.
   */
  const REVIEWED_NON_BOUNDS: string[] = [];

  const isReviewed = (line: string) =>
    REVIEWED_NON_BOUNDS.some((param) => line.includes(param));

  // ---- the controls, each exercising a shape the scan might miss ----

  const UNBOUNDED_SHAPES = [
    { shape: 'dot notation, the historic defect', line: '  const limit = parseInt(req.query.limit as string) || 20;' },
    { shape: 'bracket notation, single quotes', line: "  const limit = parseInt(req.query['limit'] as string) || 20;" },
    { shape: 'bracket notation, double quotes', line: '  const limit = parseInt(req.query["limit"] as string) || 20;' },
    { shape: 'destructured', line: '  const { limit } = req.query;' },
    { shape: 'destructured alongside siblings', line: '  const { page, limit, sort } = req.query;' },
    { shape: 'destructured and renamed', line: '  const { limit: raw } = req.query;' },
    { shape: 'a DIFFERENT PARAMETER NAME', line: '  const count = parseInt(req.query.count as string) || 20;' },
    { shape: 'a different name, bracket notation', line: "  const rows = parseInt(req.query['rows'] as string) || 20;" },
  ];

  it.each(UNBOUNDED_SHAPES)('detects an unbounded read written as $shape', ({ line }) => {
    const brokenFile = [
      '/**',
      ' * A docblock quoting parseInt(req.query.limit as string) || 20.',
      ' */',
      'router.get("/made-up", async (req, res) => {',
      line,
      '});',
    ].join('\n');

    const found = readsQueryParam(brokenFile);

    // ONE, not two: the comment quoting the dot-notation expression is
    // dropped and the real line is not. If the comment filter ever swallowed
    // code this reports zero and fails here, rather than passing silently.
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(line);
    expect(found.filter((candidate) => !isBounded(candidate) && !isReviewed(candidate))).toHaveLength(1);
  });

  it('does not mistake a bounded read for an unbounded one', () => {
    const fixed = '    const limit = pointsHistoryLimit(req.query.limit);';

    expect(readsQueryParam(fixed)).toHaveLength(1);
    expect(isBounded(fixed)).toBe(true);
  });

  it('refuses a parser that is merely NAMED like one', () => {
    // The gap a gate named: `isBounded` checks a name, and a `fooLimit` that
    // returned its input would satisfy a looser check. The set is pinned.
    expect(isBounded('  const limit = fooLimit(req.query.limit);')).toBe(false);
    expect(BOUNDING_PARSERS).toEqual(['leaderboardLimit', 'pointsHistoryLimit']);
  });

  it('covers every read shape the scan claims to handle', () => {
    // Table and matcher grow together. A shape added to READ_SHAPES with no
    // row above is a matcher nobody has watched fire.
    expect(UNBOUNDED_SHAPES).toHaveLength(8);
    expect(READ_SHAPES).toHaveLength(3);
  });

  // ---- the assertions about the real file ----

  it('finds the query reads it is supposed to be checking', () => {
    // A literal, so that deleting a route's limit handling - or adding a
    // route the assertions below never reach - shows up here.
    expect(readsQueryParam(source)).toHaveLength(3);
  });

  it('routes every query read through a bounded parser', () => {
    const unbounded = readsQueryParam(source).filter(
      (line) => !isBounded(line) && !isReviewed(line)
    );

    expect(unbounded).toEqual([]);
  });

  /**
   * THE SINK, not the source. Belt and braces against a bound that arrives
   * from somewhere the query scan never looks - a request body, a header, a
   * computed value. Every service call in this file takes its row limit last.
   */
  it('hands every gamification service call a bounded value', () => {
    const calls = codeLines(source).filter((line) =>
      /await\s+get(Leaderboard|MonthlyLeaderboard|PointsHistory)\(/.test(line)
    );

    expect(calls).toHaveLength(3);

    // Every call site's final argument is the identifier `limit`...
    expect(calls.filter((line) => !/,?\s*limit\)/.test(line))).toEqual([]);

    // ...and every `limit` in this file is assigned from a bounding parser.
    const assignments = codeLines(source).filter((line) => /\bconst limit\s*=/.test(line));
    expect(assignments).toHaveLength(3);
    expect(assignments.filter((line) => !isBounded(line))).toEqual([]);
  });

  /**
   * ONE `parseInt` IN THE FILE, and it is the one inside `parseLimit`.
   *
   * The most direct statement of the property, and the one a new route trips
   * over first: the second gate's mutant added a bare `parseInt` and every
   * other check at the time let it through.
   */
  it('parses a number in exactly one place', () => {
    const parses = codeLines(source).filter((line) => /\bparseInt\s*\(/.test(line));

    expect(parses).toHaveLength(1);
    expect(parses[0]).toContain('const parsed = parseInt(String(raw), 10);');
  });
});
