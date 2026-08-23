import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE SCANNER THAT KEEPS THE TRUST MODEL'S ‡ HONEST.
 *
 * Removing the ‡ markers from the table in routes/firsthand.ts records that no
 * gate compares an opportunity owner to a caller with a bare `===` any more.
 * That was true when it was written and nothing enforced it: a review gate
 * reverted seven converted sites to the bare form, one at a time, and every
 * revert passed all 884 tests. Only three of the twenty-five are canary
 * anchors, so at the other twenty-two the comment could go stale in silence -
 * which is the exact failure the marker exists to prevent.
 *
 * WHAT THIS DOES NOT COVER, said plainly so the absence is not read as a
 * closed class:
 *
 *  - Only `backend/src/routes/*.ts`. `canWriteStudy` in
 *    firsthand/studies-repository.ts still compares an owner to a requester
 *    with a bare `===`, deliberately: it FAILS OPEN on a null owner so legacy
 *    studies stay editable, which is the opposite disposition and not a bug.
 *    Its read-side caller `mayReadCounts` adds the null check separately, and
 *    that term IS pinned by name.
 *  - Only a TEXTUAL comparison against `owner_user_id`. A gate that copied the
 *    owner into another variable first, or compared a differently-named
 *    column, is invisible here.
 *  - It says nothing about whether a gate is CORRECT, only about which
 *    predicate it asks.
 */
const ROUTES_DIR = path.join(__dirname, '..');

/** A comparison with `owner_user_id` on either side of `===` or `!==`. */
const OWNER_COMPARISON = /owner_user_id\s*(?:===|!==)|(?:===|!==)\s*[\w.!?[\]]*\bowner_user_id/;

/**
 * The two shapes that are presence checks rather than identity checks:
 * `owner_user_id !== null` asks whether the row HAS an owner, and
 * `!== undefined` asks whether a caller supplied the field at all. Neither
 * compares an owner to a caller, so neither is what the ‡ was about.
 */
const PRESENCE_CHECK = /owner_user_id\s*(?:===|!==)\s*(?:null|undefined)\b/;

function offendingLines(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => OWNER_COMPARISON.test(line) && !PRESENCE_CHECK.test(line));
}

describe('owner-to-caller comparisons in the route layer', () => {
  const routeFiles = readdirSync(ROUTES_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(ROUTES_DIR, name));

  // THE CONTROL FOR THE FILE LIST. An empty or wrong directory makes the
  // assertion below pass by having nothing to read, which is the same
  // observation as "the routes are clean".
  it('actually reads the route files', () => {
    expect(routeFiles.length).toBeGreaterThan(5);
    expect(routeFiles.some((f) => f.endsWith('bookings.ts'))).toBe(true);
    expect(routeFiles.some((f) => f.endsWith('opportunities.ts'))).toBe(true);
  });

  // THE CONTROL FOR THE SCANNER. An empty result proves nothing unless the
  // scanner can still find what it is looking for. These are the exact forms
  // the twenty-five converted sites used.
  it('can still detect a bare comparison when one is present', () => {
    expect(offendingLines("  const isOwner = rows[0].owner_user_id === userId;")).toHaveLength(1);
    expect(offendingLines("  if (!isSuperadmin && o.owner_user_id !== req.user!.id) {")).toHaveLength(1);
    expect(offendingLines("  return existing.owner_user_id === req.user?.id;")).toHaveLength(1);
  });

  it('does not mistake a presence check for an identity check', () => {
    expect(offendingLines("  const owned = study.owner_user_id !== null;")).toHaveLength(0);
    expect(offendingLines("  const given = input.owner_user_id !== undefined;")).toHaveLength(0);
  });

  it('finds none in the route layer, which is what the trust model records', () => {
    const found = routeFiles.flatMap((file) =>
      offendingLines(readFileSync(file, 'utf8')).map(
        (line) => `${path.basename(file)}: ${line.trim()}`
      )
    );

    expect(found).toEqual([]);
  });
});
