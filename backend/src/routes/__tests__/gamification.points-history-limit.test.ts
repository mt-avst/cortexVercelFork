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
  pointsHistoryCursor,
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
    // The PAGE shape, not a bare array (cto/AdaptaLabs#23). The `has_more`
    // arithmetic itself is unobservable here - the service is mocked - so it is
    // proven against a real Postgres in
    // services/__tests__/gamification-postgres.test.ts. This mock only has to
    // be the shape the route now forwards.
    mockGetPointsHistory.mockResolvedValue({ transactions: [], has_more: false } as never);
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

  // cto/AdaptaLabs#23. `res.json(history.transactions)` is a one-word mutation
  // that puts the silent truncation straight back on the wire while every limit
  // assertion above still passes. The route's job is to FORWARD the page.
  it('answers with the page and carries a true has_more onto the wire', async () => {
    mockGetPointsHistory.mockResolvedValue({
      transactions: [{ id: 'txn-1' }],
      has_more: true,
    } as never);

    const response = await request(listening(app)).get(`${PATH}?limit=1`).expect(200);

    expect(response.body.has_more).toBe(true);
    expect(response.body.transactions).toHaveLength(1);
  });

  // THE CONTROL for the arm above. Without it, a route that answered a
  // hardcoded `has_more: true` would satisfy every assertion there - and
  // `has_more` that is always true is as useless as one that is always absent.
  it('carries a false has_more onto the wire too', async () => {
    mockGetPointsHistory.mockResolvedValue({
      transactions: [{ id: 'txn-1' }],
      has_more: false,
    } as never);

    const response = await request(listening(app)).get(`${PATH}?limit=1`).expect(200);

    expect(response.body.has_more).toBe(false);
    expect(response.body.transactions).toHaveLength(1);
  });

  it('still requires authentication', async () => {
    const anon = express();
    anon.use('/api/gamification', gamificationRouter);
    anon.use(errorHandler);

    await request(listening(anon)).get(PATH).expect(401);

    expect(mockGetPointsHistory).not.toHaveBeenCalled();
  });
});

/**
 * `?before=` MAKES THE OLDER ROWS REACHABLE. cto/AdaptaLabs#47.
 *
 * #23 gave this route `has_more`, which killed the SILENT truncation - a short
 * page stopped being indistinguishable from the end of history. It did not make
 * the rows behind it askable for. A caller could be told their history continued
 * and have no way to continue it, which is a half-open door: better than a lie,
 * and still not an answer.
 *
 * THIS FILE PROVES THE BOUNDARY, NOT THE PAGING. The service is mocked here, so
 * the keyset arithmetic - no row skipped, none repeated, equal timestamps
 * separated by the id tiebreak - is unobservable and is proven against a real
 * Postgres in services/__tests__/gamification-postgres.test.ts. What is
 * observable here is what the route does with the string a browser sent, and
 * that half matters on its own: BOTH halves of the cursor reach SQL as a cast,
 * `::timestamptz` and `::uuid`, where an unparseable value is SQLSTATE 22007 or
 * 22P02 - which this route's catch turns into a 500 with the cause only in the
 * log. That is the same shape as the `?limit=-5` 500 above, one parameter over.
 */
describe('GET /api/gamification/points-history cursor', () => {
  const CURSOR = '2026-08-25T09:41:07.481923Z,1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f';

  /** The cursor the route actually asked the service for. */
  const requestedCursor = () => mockGetPointsHistory.mock.calls[0]?.[2];

  beforeEach(() => {
    jest.resetAllMocks();
    mockGetPointsHistory.mockResolvedValue({
      transactions: [],
      has_more: false,
      next_before: null,
    } as never);
  });

  // THE CONTROL, and it comes first on purpose: every refusal arm below would
  // be satisfied by a route that refused every cursor outright.
  it('passes a well-formed cursor through to the service', async () => {
    await request(listening(app)).get(`${PATH}?before=${encodeURIComponent(CURSOR)}`).expect(200);

    expect(requestedCursor()).toEqual({
      created_at: '2026-08-25T09:41:07.481923Z',
      id: '1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f',
    });
  });

  // THE SECOND CONTROL. The first page must still work, and must be
  // distinguishable from a paged one - a route that always passed a cursor
  // would satisfy the arm above.
  it('asks for the first page when no cursor is sent', async () => {
    await request(listening(app)).get(PATH).expect(200);

    expect(requestedCursor()).toBeUndefined();
  });

  it.each([
    ['no separator at all', 'not-a-cursor'],
    ['an unparseable timestamp half', 'yesterday,1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f'],
    ['a malformed uuid half', '2026-08-25T09:41:07.481923Z,not-a-uuid'],
    ['an empty uuid half', '2026-08-25T09:41:07.481923Z,'],
    ['an empty timestamp half', ',1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f'],
    ['a SQL fragment where the uuid goes', "2026-08-25T09:41:07Z,1' OR '1'='1"],
    ['a date with no time', '2026-08-25,1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f'],
  ])('refuses a cursor with %s rather than sending it to Postgres', async (_shape, cursor) => {
    await request(listening(app)).get(`${PATH}?before=${encodeURIComponent(cursor)}`).expect(400);

    // The refusal is worth nothing if the query ran anyway.
    expect(mockGetPointsHistory).not.toHaveBeenCalled();
  });

  // The disposition `parseLimit` settled for this file, applied to the new
  // parameter rather than rediscovered later: a repeated parameter arrives as
  // an ARRAY, and taking the first or joining them answers a question nobody
  // asked. `GET /api/opportunities` refuses the same shape for the same reason.
  it('refuses a repeated before rather than coercing the array', async () => {
    await request(listening(app))
      .get(`${PATH}?before=${encodeURIComponent(CURSOR)}&before=${encodeURIComponent(CURSOR)}`)
      .expect(400);

    expect(mockGetPointsHistory).not.toHaveBeenCalled();
  });

  // cto/AdaptaLabs#47's whole point on the wire: `res.json(history)` forwards
  // the envelope, and dropping `next_before` on the way out would leave the
  // caller exactly where #23 left them - told there is more, unable to ask.
  it('carries next_before onto the wire beside has_more', async () => {
    mockGetPointsHistory.mockResolvedValue({
      transactions: [{ id: 'txn-1' }],
      has_more: true,
      next_before: CURSOR,
    } as never);

    const response = await request(listening(app)).get(`${PATH}?limit=1`).expect(200);

    expect(response.body.has_more).toBe(true);
    expect(response.body.next_before).toBe(CURSOR);
  });

  // THE CONTROL for the arm above. A route echoing a hardcoded cursor would
  // satisfy it, and a cursor at the end of history invites a request that can
  // only come back empty - a client looping until it is null would never stop.
  it('carries a null next_before at the end of history', async () => {
    mockGetPointsHistory.mockResolvedValue({
      transactions: [{ id: 'txn-1' }],
      has_more: false,
      next_before: null,
    } as never);

    const response = await request(listening(app)).get(`${PATH}?limit=1`).expect(200);

    expect(response.body.has_more).toBe(false);
    expect(response.body.next_before).toBeNull();
  });
});

describe('pointsHistoryCursor', () => {
  it('separates absent from unusable, because they are answered differently', () => {
    // undefined - no cursor asked for, so the first page. null - a cursor this
    // route will not read, so a 400. Collapsing the two would turn every
    // malformed cursor into a silent jump back to the top of history, which is
    // the coercion this repository refuses everywhere else.
    expect(pointsHistoryCursor(undefined)).toBeUndefined();
    expect(pointsHistoryCursor('')).toBeNull();
    expect(pointsHistoryCursor(['a,b', 'c,d'])).toBeNull();
    expect(pointsHistoryCursor(42)).toBeNull();
  });

  it('accepts the microsecond precision the server actually emits', () => {
    // Six fractional digits, because `created_at` is TIMESTAMPTZ and Postgres
    // keeps microseconds. A cursor rounded to the millisecond skips every row
    // in between, which is the defect keyset pagination exists to avoid.
    expect(pointsHistoryCursor('2026-08-25T09:41:07.481923Z,1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f'))
      .toEqual({
        created_at: '2026-08-25T09:41:07.481923Z',
        id: '1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f',
      });

    // A hand-written whole-second position is a legitimate place in the ledger
    // even though it is not what the server hands out.
    expect(pointsHistoryCursor('2026-08-25T09:41:07Z,1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f'))
      .not.toBeNull();
  });

  it('splits on the FIRST comma, so a comma in the id half cannot be misread', () => {
    // The timestamp half carries no comma. Splitting on all of them would take
    // `a,b,c` apart into three pieces and read the middle one as a uuid, which
    // is a misreading rather than a refusal.
    expect(pointsHistoryCursor('2026-08-25T09:41:07Z,1f5c9e2a-4b3d-4c8e-9f01-2a3b4c5d6e7f,extra'))
      .toBeNull();
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
  const BOUNDING_PARSERS = ['leaderboardLimit', 'pointsHistoryLimit', 'pointsHistoryCursor'];

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
    // `pointsHistoryCursor` joined the set with cto/AdaptaLabs#47 - a
    // DELIBERATE edit, which is exactly what this list is for. It bounds a
    // shape rather than a magnitude: an unparseable timestamp or uuid reaching
    // `::timestamptz`/`::uuid` is a 500, so refusing at the boundary is the
    // same job as refusing an over-large number.
    expect(BOUNDING_PARSERS).toEqual([
      'leaderboardLimit',
      'pointsHistoryLimit',
      'pointsHistoryCursor',
    ]);
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
    // route the assertions below never reach - shows up here. 4 since
    // cto/AdaptaLabs#47 added `?before=` to points-history; the fourth read is
    // `pointsHistoryCursor(req.query.before)`.
    expect(readsQueryParam(source)).toHaveLength(4);
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

    // Every call site's row-count argument is the identifier `limit`, and the
    // only thing permitted after it is the keyset cursor `before` - which is
    // itself bounded by `pointsHistoryCursor` above (cto/AdaptaLabs#47). An
    // arbitrary third argument still fails here.
    expect(calls.filter((line) => !/\blimit(,\s*before)?\)/.test(line))).toEqual([]);

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
