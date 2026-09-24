import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Row-actions dropdown reflow (fix-first row 20, dropdown half).
 *
 * Two rules both position `.admin-action-dropdown-menu`: the plain rule near
 * the top of the file (right: 0, no !important - correct for the desktop
 * table, where the kebab sits at the far right of a wide row) and a SECOND,
 * unconditional `!important` block further down ("Fix clipping: ...") that
 * ALSO forces `right: 0 !important` at every width. Below the card-reflow
 * breakpoint the table reflows to stacked cards and `.admin-action-group`
 * becomes `justify-content: flex-start`, moving the trigger to the LEFT of a
 * narrow card - so both rules open the menu off the LEFT edge of the
 * viewport there (confirmed live at 390px: the menu rendered with its left
 * half negative and its text clipped). Because the `!important` block wins
 * outright and sits LAST in the file, the reflow-width override must also be
 * `!important` and must sit AFTER that block to win (two `!important`
 * declarations of equal specificity resolve by source order, same as normal
 * rules) - an override placed only after the FIRST rule is silently
 * defeated. jsdom applies no CSS, so the real containment check is
 * Playwright (e2e/accessibility.test.ts); this pins the source fix and its
 * position.
 *
 * The anchor override and the card reflow it depends on MUST share the same
 * breakpoint - they drifted apart once (anchor stayed at 767.98px when row
 * 16 second-pass raised the reflow to 1219.98px), which opened the menu
 * off-screen for every card view in that 450px gap. Read the reflow's own
 * breakpoint from its rule rather than hard-coding it a second time, so a
 * future change to one is forced to update the other or fail here by name.
 *
 * The Admin table Step 1 fix (2026-09-23) moved both to 1023.98px: the table
 * now holds its columns down to 1024px, so the card view - and the
 * left-aligned kebab this override exists for - starts below that.
 */

const CSS_PATH = join(__dirname, '..', '_components.css');
const css = readFileSync(CSS_PATH, 'utf8');

const reflowBreakpointMatch = css.match(
  /ROW 14 - Research Studies table reflows to cards[\s\S]*?@media \(max-width: ([\d.]+)px\) \{\s*\.admin-data-table,/
);
if (!reflowBreakpointMatch) {
  throw new Error('could not find the .admin-data-table card-reflow @media rule to read its breakpoint from');
}
const REFLOW_BREAKPOINT = reflowBreakpointMatch[1];

describe('admin action dropdown reverses its anchor below the card-reflow breakpoint (row 20)', () => {
  it('the reflow breakpoint is pinned at the Step 1 value (table from 1024px up)', () => {
    // Admin table Step 1 (2026-09-23): fixed pixel columns with Study the only
    // fluid one keep the table readable - Study >= 300px of content box,
    // measured 310px at 1024 - so the card view starts below 1024px. A
    // derived comparison (this test's own REFLOW_BREAKPOINT read above)
    // cannot see the constant drift - pin the literal too.
    expect(REFLOW_BREAKPOINT).toBe('1023.98');
  });

  it('the desktop rule (right: 0, no !important) is unchanged', () => {
    const desktopRule = css.match(/^\.admin-action-dropdown-menu\s*\{[^}]*right:\s*0;/m);
    expect(desktopRule, 'expected the original non-!important .admin-action-dropdown-menu rule').not.toBeNull();
  });

  it('the unconditional !important block still forces right: 0 !important (the thing being overridden)', () => {
    expect(css).toMatch(/\.admin-action-dropdown-menu,[\s\S]*?right:\s*0\s*!important;/);
  });

  // C-H2 (fix round 4): the M1 rebuild's kebab sits at the card's own
  // top-right corner at every width under 1024px (`.admin-data-table
  // td.col-actions { position: absolute; right: 12px }`), not at its LEFT
  // edge as an earlier round's card layout did - so the menu anchor no
  // longer flips to `left: 0` below the reflow breakpoint. It stays
  // right-anchored, matching the desktop rule; the <1024px block re-asserting
  // `right: 0 !important` is kept only so a future kebab-position change has
  // one place to update rather than two rules to reconcile (see the block's
  // own comment).
  it('the <1024 block re-asserts the SAME right anchor as the desktop rule, at the card-reflow breakpoint - no left-hand flip any more (fix round 4)', () => {
    const importantBlockAt = css.search(/\.admin-action-dropdown-menu,[\s\S]*?right:\s*0\s*!important;/);
    expect(importantBlockAt, 'the unconditional !important block must exist').toBeGreaterThanOrEqual(0);

    // No left-hand anchor override survives anywhere in the file. Bounded on
    // the left so `margin-left:`/`padding-left:` (genuinely unrelated
    // properties) do not false-match.
    expect(css).not.toMatch(/(^|[^-\w])left:\s*0\s*!important/);

    // A second !important block, after the first, re-declares the same
    // right anchor - not just anywhere in the file, but wrapped in a @media
    // block at the SAME breakpoint as the card reflow.
    const secondBlockAt = css.indexOf(
      'right: 0 !important;\n    left: auto !important;',
      importantBlockAt + 1
    );
    expect(
      secondBlockAt,
      'expected a second "right: 0 !important; left: auto !important;" declaration after the unconditional block'
    ).toBeGreaterThan(importantBlockAt);

    const mediaQueryAt = css.lastIndexOf(`@media (max-width: ${REFLOW_BREAKPOINT}px) {`, secondBlockAt);
    expect(
      mediaQueryAt,
      `expected a @media (max-width: ${REFLOW_BREAKPOINT}px) block (the same breakpoint as the .admin-data-table card reflow) wrapping the override`
    ).toBeGreaterThan(importantBlockAt);
    const selectorBetween = css.slice(mediaQueryAt, secondBlockAt);
    expect(selectorBetween, 'the media query must target .admin-action-dropdown-menu').toMatch(/\.admin-action-dropdown-menu/);
  });
});
