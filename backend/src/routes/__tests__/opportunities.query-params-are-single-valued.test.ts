import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVERY `req.query.x as string` IN opportunities.ts IS COVERED BY A GUARD.
 *
 * THIS EXISTS BECAUSE THE INSTANCE WAS FIXED TWICE AND THE CLASS SURVIVED BOTH
 * TIMES.
 *
 * cto/AdaptaLabs#22 put a 200-character bound on `?q=`. A refute gate then found
 * the bound was bypassed entirely by `?q=a&q=b`, because express parses a
 * repeated parameter into a `string[]` and the guard was written
 * `typeof q === 'string'`. That was fixed for `q`, `type` and `status`.
 *
 * A sweep run immediately afterwards found `from` on `GET /:id/sessions` - same
 * file, same cast, pushed straight into a `pool.query` parameter array against
 * a `timestamp` column, an unauthenticated 500 - still there. Two rounds of
 * fixing the parameters that had been NAMED, while the shape went on living one
 * handler down.
 *
 * That is the same failure `gamification.leaderboard-limit.test.ts` records:
 * "#17's finding named an INSTANCE and the class was the file". This repository
 * has now made it twice in the same week, so this scan is the third attempt and
 * it does not name any parameter.
 *
 * WHAT IT CANNOT SEE, stated so nobody mistakes its scope. Three things:
 *
 *   - It reads THIS FILE ONLY. The wider sweep found four more instances of the
 *     same shape outside it - admin.ts twice, userCalendar.ts, auth.ts, plus an
 *     unnormalised header read in utils/logger.ts - and those are a tracked
 *     follow-up, not something this file pretends to cover.
 *   - It only recognises the `req.query.NAME as string` spelling. A read
 *     written `const { from } = req.query` is invisible to it.
 *   - It proves a parameter is LISTED, never that its list is APPLIED. Deleting
 *     a `refusedRepeatedParameters` call leaves every name still declared and
 *     this suite green; what fails then is the request-level arms in
 *     `opportunities.list-bound.test.ts`. Measured, both ways round. The two
 *     files are one guard between them and neither is sufficient alone.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'opportunities.ts'), 'utf8');

/**
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness.
 *
 * The first version of this scan read the raw file and reported an unguarded
 * parameter called `x` - from the phrase "a `req.query.x as string` read" in
 * the docblock of the very guard it was checking. A scan that reads its own
 * documentation as code fails on prose, which is the fastest way to get a scan
 * deleted rather than fixed.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Every `req.query.NAME as string` read in the router. */
const castQueryReads = (source: string): string[] => [
  ...new Set(
    [...withoutComments(source).matchAll(/req\.query\.([A-Za-z_][A-Za-z0-9_]*)\s+as\s+string/g)].map(
      (m) => m[1]
    )
  ),
];

/** Every name in a `const SINGLE_VALUE_... = [...] as const` declaration. */
const guardedNames = (source: string): string[] => [
  ...new Set(
    [...source.matchAll(/const SINGLE_VALUE_[A-Z_]+ = \[([^\]]*)\] as const;/g)].flatMap((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((n) => n[1])
    )
  ),
];

describe('every query parameter this router reads is guarded against a repeat', () => {
  it('leaves no cast query read outside a single-value list', () => {
    const unguarded = castQueryReads(SOURCE).filter((name) => !guardedNames(SOURCE).includes(name));

    expect(unguarded).toEqual([]);
  });

  // ------------------------------------------------------------------
  // THE CONTROLS. `expect(unguarded).toEqual([])` passes just as well when
  // either extractor silently matches nothing - an empty result from a broken
  // regex is indistinguishable from an empty result from a clean file. These
  // three prove both extractors still find what they are looking for, and that
  // the comparison between them can still produce a finding.
  // ------------------------------------------------------------------

  it('still finds the reads it is scanning for', () => {
    // Measured against the real file rather than asserted as a count, because a
    // count here would need editing every time a handler is added.
    expect(castQueryReads(SOURCE).sort()).toEqual([
      'from',
      'include_past',
      'period',
      'q',
      'scope',
      'status',
      'type',
    ]);
  });

  it('still finds the guard lists it is scanning for', () => {
    expect(guardedNames(SOURCE).sort()).toEqual([
      'from',
      'include_past',
      'period',
      'q',
      'scope',
      'status',
      'type',
    ]);
  });

  it('does not read a code example in a comment as a real read', () => {
    const commentedExample = `
      // a req.query.sortBy as string read would need a list
      /* and req.query.cursor as string in a block comment too */
      const SINGLE_VALUE_FILTERS = ['type'] as const;
      const type = req.query.type as string | undefined;
    `;

    expect(castQueryReads(commentedExample)).toEqual(['type']);
  });

  it('still reports a read that no list covers', () => {
    const withAnUnguardedRead = `
      const SINGLE_VALUE_FILTERS = ['type'] as const;
      const type = req.query.type as string | undefined;
      const sortBy = req.query.sortBy as string | undefined;
    `;

    const unguarded = castQueryReads(withAnUnguardedRead).filter(
      (name) => !guardedNames(withAnUnguardedRead).includes(name)
    );

    expect(unguarded).toEqual(['sortBy']);
  });
});
