import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVERY ROUTE SEGMENT THAT READS `req.query` NAMES A MECHANISM THAT REFUSES A
 * NON-STRING SHAPE. cto/AdaptaLabs#43.
 *
 * Express parses `?x=a&x=b` into a string array and `?x[foo]=bar` into an
 * object, so every `req.query.x as string` is a lie told to the type system.
 * The instance was fixed FOUR separate times (#17, #22 twice, !253) and the
 * class survived each one, because every fix guarded the parameters that had
 * been NAMED. `opportunities.query-params-are-single-valued.test.ts` closed the
 * class for its one file and says so: "the wider sweep found four more
 * instances outside it". This scan is the repo-wide version.
 *
 * WHAT COUNTS AS A MECHANISM. `validateQuery(...)` from validation/schemas.ts
 * is trusted everywhere - it zod-parses the whole query object before the
 * handler runs. A few files predate it with their own proven guards, each
 * listed with the test that demonstrates it refuses an array; those stay
 * because they are tested, not because they are grandfathered.
 *
 * WHAT THIS SCAN CANNOT SEE, stated so nobody mistakes its scope:
 *
 *   - It is SEGMENT-granular. A segment that both calls a trusted mechanism
 *     and reads a second parameter raw passes. The per-site behavioural suites
 *     (admin/auth/calendar/userCalendar `.query-shapes` files) are the arm
 *     that fails in that case.
 *   - It proves a mechanism is MENTIONED in the segment, not that the read
 *     flows through it. Mention-without-application is caught by the same
 *     behavioural suites, and unwiring `validateQuery` from a route is a
 *     mutation-canary entry.
 *   - A helper that takes `req` whole and reads the query inside a service
 *     file is invisible - only `backend/src/routes/*.ts` is read.
 */

const ROUTES_DIR = join(__dirname, '..');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

interface Segment {
  label: string;
  text: string;
}

/**
 * Splits a router module at each `router.<method>(` call. Everything before
 * the first route is the module prelude (imports plus shared helpers); each
 * later segment is one route plus any helpers declared between it and the
 * next. Comments are stripped FIRST - the sibling scan learned that lesson by
 * reporting a parameter named `x` out of its own docblock.
 */
const segmentsOf = (source: string): Segment[] => {
  const clean = stripComments(source);
  const marker = /router\.(get|post|put|patch|delete|all|use)\s*\(\s*(?:['"`]([^'"`\n]*)['"`])?/g;
  const starts: { index: number; label: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(clean)) !== null) {
    starts.push({ index: match.index, label: `router.${match[1]}('${match[2] ?? ''}')` });
  }
  if (starts.length === 0) {
    return [{ label: 'whole module', text: clean }];
  }
  const segments: Segment[] = [{ label: 'module prelude', text: clean.slice(0, starts[0].index) }];
  starts.forEach((start, i) => {
    const end = starts[i + 1]?.index ?? clean.length;
    segments.push({ label: start.label, text: clean.slice(start.index, end) });
  });
  return segments;
};

/**
 * Trusted everywhere: the boundary validator itself.
 */
const GLOBAL_MECHANISMS = ['validateQuery('] as const;

/**
 * Per-file mechanisms that predate `validateQuery`, each with the suite that
 * proves it refuses a non-string shape. An entry here without a proving test
 * is just an exemption, which is the thing this scan exists to end.
 */
const FILE_MECHANISMS: Record<string, readonly string[]> = {
  // opportunities.query-params-are-single-valued.test.ts (the scan) plus
  // opportunities.list-bound.test.ts (the request-level arms).
  'opportunities.ts': ['refusedRepeatedParameters'],
  // gamification.leaderboard-limit.test.ts and
  // gamification.points-history-limit.test.ts - the helpers take `unknown`
  // and refuse anything that is not a bare string or number.
  'gamification.ts': ['leaderboardLimit(', 'pointsHistoryLimit(', 'pointsHistoryCursor('],
  // bookings.all-is-paged.test.ts - same `unknown`-taking cursor parser.
  'bookings.ts': ['allBookingsCursor('],
  // firsthand-session.test.ts - `attemptFromQuery` treats anything but a bare
  // string as "unspecified"; the typeof guard is the mechanism.
  'firsthand-session.ts': ["typeof raw === 'string'"],
  // session-outputs router zod-parses the single query read in place.
  'session-outputs.ts': ['.safeParse(req.query'],
};

const routeFiles = (): string[] =>
  readdirSync(ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();

const violationsIn = (fileName: string, source: string): string[] => {
  const trusted = [...GLOBAL_MECHANISMS, ...(FILE_MECHANISMS[fileName] ?? [])];
  return segmentsOf(source)
    .filter((segment) => /req\.query/.test(segment.text))
    .filter((segment) => !trusted.some((mechanism) => segment.text.includes(mechanism)))
    .map((segment) => `${fileName} ${segment.label}`);
};

describe('every route segment that reads req.query names a shape-refusing mechanism', () => {
  it('finds no unvalidated req.query read in any router', () => {
    const violations = routeFiles().flatMap((name) =>
      violationsIn(name, readFileSync(join(ROUTES_DIR, name), 'utf8'))
    );

    expect(violations).toEqual([]);
  });

  // ------------------------------------------------------------------
  // THE CONTROLS. An empty violation list proves nothing if the detector
  // cannot detect or the splitter cannot split - an empty result from a
  // broken regex is indistinguishable from a clean tree.
  // ------------------------------------------------------------------

  it('still finds the files that read req.query at all', () => {
    // Measured against the real tree. A new file appearing here means a new
    // query-reading router - it passes the scan by using validateQuery, and
    // this list is updated as part of that change, deliberately.
    const readers = routeFiles().filter((name) =>
      /req\.query/.test(stripComments(readFileSync(join(ROUTES_DIR, name), 'utf8')))
    );

    expect(readers).toEqual([
      'admin.ts',
      'auth.ts',
      'bookings.ts',
      'calendar.ts',
      'firsthand-session.ts',
      'gamification.ts',
      'opportunities.ts',
      'session-outputs.ts',
      'userCalendar.ts',
    ]);
  });

  it('splits a module into a prelude and one segment per route', () => {
    const synthetic = `
      import { Router } from 'express';
      const helper = () => 1;
      router.get('/a', handlerA);
      router.post('/b', handlerB);
      router.delete('/c', handlerC);
    `;

    expect(segmentsOf(synthetic).map((s) => s.label)).toEqual([
      'module prelude',
      "router.get('/a')",
      "router.post('/b')",
      "router.delete('/c')",
    ]);
  });

  it('still reports a route that reads req.query with no mechanism', () => {
    const synthetic = `
      router.get('/unguarded', asyncHandler(async (req, res) => {
        const q = req.query.q as string;
        res.json({ q });
      }));
    `;

    expect(violationsIn('synthetic.ts', synthetic)).toEqual([
      "synthetic.ts router.get('/unguarded')",
    ]);
  });

  it('passes the same route once validateQuery is mounted on it', () => {
    const synthetic = `
      router.get('/guarded', validateQuery(schema), asyncHandler(async (req, res) => {
        const q = req.query.q as string;
        res.json({ q });
      }));
    `;

    expect(violationsIn('synthetic.ts', synthetic)).toEqual([]);
  });

  it('does not read a req.query mention in a comment as a read', () => {
    const synthetic = `
      // a req.query.sortBy as string read would need a validator
      /* req.query in a block comment is prose too */
      router.get('/clean', asyncHandler(async (req, res) => {
        res.json({ ok: true });
      }));
    `;

    expect(violationsIn('synthetic.ts', synthetic)).toEqual([]);
  });
});
