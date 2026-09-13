import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Row-actions dropdown on phone (fix-first row 20, dropdown half).
 *
 * Two rules both position `.admin-action-dropdown-menu`: the plain rule near
 * the top of the file (right: 0, no !important - correct for the desktop
 * table, where the kebab sits at the far right of a wide row) and a SECOND,
 * unconditional `!important` block further down ("Fix clipping: ...") that
 * ALSO forces `right: 0 !important` at every width. Below 768px the table
 * reflows to stacked cards and `.admin-action-group` becomes
 * `justify-content: flex-start`, moving the trigger to the LEFT of a narrow
 * card - so both rules open the menu off the LEFT edge of the viewport there
 * (confirmed live at 390px: the menu rendered with its left half negative and
 * its text clipped). Because the `!important` block wins outright and sits
 * LAST in the file, the phone override must also be `!important` and must sit
 * AFTER that block to win (two `!important` declarations of equal
 * specificity resolve by source order, same as normal rules) - an override
 * placed only after the FIRST rule is silently defeated. jsdom applies no
 * CSS, so the real containment check is Playwright
 * (e2e/accessibility.test.ts); this pins the source fix and its position.
 */

const CSS_PATH = join(__dirname, '..', '_components.css');
const css = readFileSync(CSS_PATH, 'utf8');

describe('admin action dropdown reverses its anchor on phone (row 20)', () => {
  it('the desktop rule (right: 0, no !important) is unchanged', () => {
    const desktopRule = css.match(/^\.admin-action-dropdown-menu\s*\{[^}]*right:\s*0;/m);
    expect(desktopRule, 'expected the original non-!important .admin-action-dropdown-menu rule').not.toBeNull();
  });

  it('the unconditional !important block still forces right: 0 !important (the thing being overridden)', () => {
    expect(css).toMatch(/\.admin-action-dropdown-menu,[\s\S]*?right:\s*0\s*!important;/);
  });

  it('a phone-width !important override sits AFTER the !important block and flips it to open rightward', () => {
    const importantBlockAt = css.search(/\.admin-action-dropdown-menu,[\s\S]*?right:\s*0\s*!important;/);
    expect(importantBlockAt, 'the unconditional !important block must exist').toBeGreaterThanOrEqual(0);

    // Find the phone override that comes right after that block, not just
    // anywhere in the file - a coincidental match inside an unrelated
    // @media (max-width: 767.98px) block elsewhere must not satisfy this.
    const searchFrom = importantBlockAt;
    const leftImportantAt = css.indexOf('left: 0 !important;\n    right: auto !important;', searchFrom);
    expect(
      leftImportantAt,
      'expected "left: 0 !important; right: auto !important;" to appear after the unconditional !important block'
    ).toBeGreaterThan(searchFrom);

    // It must be reachable from a @media (max-width: 767.98px) block with no
    // intervening closing `}` at column 0 (i.e. no unrelated top-level rule
    // sits between the media query opening and the declaration).
    const mediaQueryAt = css.lastIndexOf('@media (max-width: 767.98px) {', leftImportantAt);
    expect(mediaQueryAt, 'expected a @media (max-width: 767.98px) block wrapping the override').toBeGreaterThan(importantBlockAt);
    const selectorBetween = css.slice(mediaQueryAt, leftImportantAt);
    expect(selectorBetween, 'the media query must target .admin-action-dropdown-menu').toMatch(/\.admin-action-dropdown-menu/);
  });
});
