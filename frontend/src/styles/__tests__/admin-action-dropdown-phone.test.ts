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
  it('the reflow breakpoint is pinned at row 16\'s measured value (768-1220 band)', () => {
    // MEASURED (row 16 second-pass): the admin content column's own
    // max-width holds the table at a fixed rendered width from 1440px
    // viewport up, so nothing above ~1220px was ever squeezed. A derived
    // comparison (this test's own REFLOW_BREAKPOINT read above) cannot see
    // the constant silently drift back toward 767.98px - pin the literal too.
    expect(REFLOW_BREAKPOINT).toBe('1219.98');
  });

  it('the desktop rule (right: 0, no !important) is unchanged', () => {
    const desktopRule = css.match(/^\.admin-action-dropdown-menu\s*\{[^}]*right:\s*0;/m);
    expect(desktopRule, 'expected the original non-!important .admin-action-dropdown-menu rule').not.toBeNull();
  });

  it('the unconditional !important block still forces right: 0 !important (the thing being overridden)', () => {
    expect(css).toMatch(/\.admin-action-dropdown-menu,[\s\S]*?right:\s*0\s*!important;/);
  });

  it('a reflow-width !important override sits AFTER the !important block and flips it to open rightward, at the SAME breakpoint as the card reflow', () => {
    const importantBlockAt = css.search(/\.admin-action-dropdown-menu,[\s\S]*?right:\s*0\s*!important;/);
    expect(importantBlockAt, 'the unconditional !important block must exist').toBeGreaterThanOrEqual(0);

    // Find the anchor override that comes right after that block, not just
    // anywhere in the file - a coincidental match inside an unrelated
    // media block elsewhere must not satisfy this.
    const searchFrom = importantBlockAt;
    const leftImportantAt = css.indexOf('left: 0 !important;\n    right: auto !important;', searchFrom);
    expect(
      leftImportantAt,
      'expected "left: 0 !important; right: auto !important;" to appear after the unconditional !important block'
    ).toBeGreaterThan(searchFrom);

    // It must be reachable from a @media block at the SAME breakpoint as the
    // card reflow, with no intervening closing `}` at column 0 (i.e. no
    // unrelated top-level rule sits between the media query opening and the
    // declaration).
    const mediaQueryAt = css.lastIndexOf(`@media (max-width: ${REFLOW_BREAKPOINT}px) {`, leftImportantAt);
    expect(
      mediaQueryAt,
      `expected a @media (max-width: ${REFLOW_BREAKPOINT}px) block (the same breakpoint as the .admin-data-table card reflow) wrapping the override`
    ).toBeGreaterThan(importantBlockAt);
    const selectorBetween = css.slice(mediaQueryAt, leftImportantAt);
    expect(selectorBetween, 'the media query must target .admin-action-dropdown-menu').toMatch(/\.admin-action-dropdown-menu/);
  });
});
