import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #142: the studies table rendered type (`.lozenge`), status
 * (`.admin-study-status`) and "Auto-closed" (a bootstrap-style
 * `.badge.bg-dark`) as three unrelated components with no shared metrics, so
 * they sat on different vertical centres and baselines within a row.
 *
 * `.admin-study-status` also computed `display: inline-block` even though its
 * own source declared `inline-flex`, because two ancestor-scoped rules in
 * `_components.css` (`td.col-status > *` and `td:not(:first-child) > span`)
 * outranked a bare class selector on specificity and forced `inline-block` on
 * any direct child of those cells - "Auto-closed" clipped to "AUTO-CLO" in a
 * narrow column as a result. The fix does not fight those two rules or except
 * itself from them; it declares the box on a selector that outranks them
 * (`td.col-type .admin-pill, td.col-status .admin-pill`, 0,4,3), which is the
 * one rule pinned below.
 *
 * jsdom does not do real layout, so source-pin assertions here cannot see a
 * computed height, a pixel-clipped label, a missing gutter or text spilling
 * out of a pill - that is what `e2e/admin-pill-primitive.test.ts` is for, in
 * a real Chromium, run in CI by the `test-a11y` job. What this file CAN see,
 * and fail by name on, is the shape of the source: the shared class present
 * on all three pills, the bootstrap badge gone, and the metrics/
 * label-truncation rules that make the visible fix possible.
 */

const ADMIN_TSX = readFileSync(join(__dirname, '..', '..', 'pages', 'Admin.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', '_components.css'), 'utf8');

describe('admin studies table pill primitive (#142)', () => {
  it('the type pill carries the shared .admin-pill class', () => {
    expect(ADMIN_TSX).toMatch(/className=\{`admin-pill \$\{getTypeBadgeClass\(opportunity\.type\)\}/);
  });

  it('the status pill carries the shared .admin-pill class', () => {
    expect(ADMIN_TSX).toMatch(/className=\{`admin-pill admin-study-status admin-study-status--\$\{opportunity\.status\}`\}/);
  });

  it('the auto-closed marker uses the shared primitive, not a bootstrap badge', () => {
    expect(ADMIN_TSX).toMatch(/className="admin-pill admin-pill--auto-closed"/);
    expect(ADMIN_TSX).not.toMatch(/badge bg-dark/);
  });

  it('.admin-pill declares one display/height/font-size/line-height contract', () => {
    expect(CSS).toMatch(
      /\.admin-dashboard table\.admin-data-table tbody td\.col-type \.admin-pill,\s*\n\.admin-dashboard table\.admin-data-table tbody td\.col-status \.admin-pill \{[^}]*display:\s*inline-flex;[^}]*height:\s*24px;[^}]*font-size:\s*0\.6875rem;[^}]*line-height:\s*1;/
    );
  });

  it('the auto-closed pill keeps the uppercase/tracking the other two pills carry', () => {
    // Code review HIGH 1 (#142): the bootstrap badge it replaced had neither,
    // so this was the one pill of the three still visibly a different style
    // even once the box metrics matched.
    expect(CSS).toMatch(/\.admin-pill--auto-closed \{[^}]*text-transform:\s*uppercase;[^}]*letter-spacing:\s*0\.03em;/);
    expect(CSS).not.toMatch(/\.admin-pill--auto-closed[^{]*\{[^}]*white-space:\s*normal;/);
  });

  it('the status label renders inside its own truncating span, not the pill directly', () => {
    // Code review HIGH 2 (#142): PUBLISHED_NOT_WORKING_LABEL already
    // overflowed this fixed-width cell on main; `justify-content: center`
    // on the shared primitive turned that overflow into glyph-on-glyph
    // overlap with the Type lozenge instead of main's harmless rightward
    // spill. `text-overflow: ellipsis` does not paint on the flex pill's
    // own overflow (measured: Chrome hard-clips both ends with no "…"), so
    // the label is wrapped in its own `.admin-study-status__label` span,
    // which does the shrinking and the ellipsis.
    expect(ADMIN_TSX).toMatch(/<span className="admin-study-status__label">/);
    expect(CSS).toMatch(
      /\.admin-study-status__label \{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/
    );
  });

  it('the status column is widened to fit "Auto-closed" on one line at the shared primitive height', () => {
    expect(CSS).toMatch(/\.admin-data-table \.col-status \{\s*width:\s*12%;/);
  });

  it('the auto-closed pill colours route through tokens, not a raw hex pair', () => {
    expect(CSS).toMatch(/\.admin-pill--auto-closed \{[^}]*background:\s*var\(--admin-pill-auto-closed-bg\);[^}]*color:\s*var\(--admin-pill-auto-closed-text\);/);
  });
});
