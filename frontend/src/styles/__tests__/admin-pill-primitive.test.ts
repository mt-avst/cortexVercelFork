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
 * outrank a bare class selector on specificity and force `inline-block` on
 * any direct child of those cells - "Auto-closed" clipped to "AUTO-CLO" in a
 * narrow column as a result.
 *
 * jsdom does not do real layout, so this cannot measure a computed height or
 * a pixel-clipped label (that is the Playwright falsifier used to diagnose
 * and verify the fix by hand - see the MR description). What it CAN see, and
 * fail by name on, is: the shared class present on all three pills, the
 * bootstrap badge gone, and the higher-specificity rule that wins the
 * cascade for the studies table still declaring `inline-flex`.
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

  it('the col-status/col-type override is resolved at matching specificity, not deleted wholesale', () => {
    // The two legacy rules that forced inline-block on any direct child
    // still exist - they still do real work for other cells in these
    // columns/table - but the pill primitive rule above now outranks them.
    expect(CSS).toMatch(/\.admin-dashboard table\.admin-data-table tbody td\.col-status > \* \{/);
    expect(CSS).toMatch(/\.admin-dashboard table tbody td:not\(:first-child\) > span,/);
  });

  it('the auto-closed pill wraps instead of clipping in a narrow column', () => {
    expect(CSS).toMatch(
      /\.admin-dashboard table\.admin-data-table tbody td\.col-status \.admin-pill--auto-closed \{[^}]*white-space:\s*normal;/
    );
  });
});
