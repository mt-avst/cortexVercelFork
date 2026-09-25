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
 * itself from them; it declared the box on a selector that outranked them
 * (then `td.col-type .admin-pill, td.col-status .admin-pill`, 0,4,3), which is
 * the one rule pinned below - now `td.col-title .admin-pill` (0,4,3) and
 * `td.col-status .admin-pill:not(.admin-pill--auto-closed)` (0,5,3).
 *
 * Admin table Step 1 (2026-09-23): the Type column is gone and its pill -
 * unchanged - rides in the Study cell's meta line, so the primitive's first
 * selector is `td.col-title .admin-pill`. "Auto-closed" stopped being a pill:
 * a second pill read as a second status, so it is a muted caption under the
 * status pill and the primitive excludes it.
 *
 * jsdom does not do real layout, so source-pin assertions here cannot see a
 * computed height, a pixel-clipped label, a missing gutter or text spilling
 * out of a pill - that is what `e2e/admin-pill-primitive.test.ts` is for, in
 * a real Chromium, run in CI by the `test-a11y` job. What this file CAN see,
 * and fail by name on, is the shape of the source: the shared class present
 * on all three pills, the bootstrap badge gone, and the metrics/
 * label-truncation rules that make the visible fix possible.
 *
 * cto/AdaptaLabs#163: the per-opportunity row markup these pins describe -
 * including all three pills - moved out of `pages/Admin.tsx` into its own
 * `components/admin/StudyRow.tsx` (a deliberate extraction, behaviour
 * unchanged). The source-pin assertions below read that file now.
 */

const STUDY_ROW_TSX = readFileSync(join(__dirname, '..', '..', 'components', 'admin', 'StudyRow.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', '_components.css'), 'utf8');

describe('admin studies table pill primitive (#142)', () => {
  it('the type pill carries the shared .admin-pill class', () => {
    expect(STUDY_ROW_TSX).toMatch(/className=\{`admin-pill \$\{getTypeBadgeClass\(opportunity\.type\)\}/);
  });

  it('the status pill carries the shared .admin-pill class', () => {
    // Open-ended after the status modifier: a broken published study appends
    // `admin-study-status--not-working` inside the same template (#149).
    expect(STUDY_ROW_TSX).toMatch(/className=\{`admin-pill admin-study-status admin-study-status--\$\{opportunity\.status\}/);
  });

  it('the auto-closed marker is not a bootstrap badge', () => {
    expect(STUDY_ROW_TSX).toMatch(/className="admin-pill admin-pill--auto-closed"/);
    expect(STUDY_ROW_TSX).not.toMatch(/badge bg-dark/);
  });

  it('the type pill lives in the Study cell now - there is no Type column for it', () => {
    expect(STUDY_ROW_TSX).not.toMatch(/className="col-type"/);
    // It sits inside the Study cell's meta line, ahead of the purpose text.
    expect(STUDY_ROW_TSX).toMatch(
      /<td className="col-title"[\s\S]*?<div className="admin-study-meta">\s*<span className=\{`admin-pill \$\{getTypeBadgeClass/
    );
  });

  it('.admin-pill declares one display/height/font-size/line-height contract, for the Study-cell type pill and the status pill', () => {
    expect(CSS).toMatch(
      /\.admin-dashboard table\.admin-data-table tbody td\.col-title \.admin-pill,\s*\n\.admin-dashboard table\.admin-data-table tbody td\.col-status \.admin-pill:not\(\.admin-pill--auto-closed\) \{[^}]*display:\s*inline-flex;[^}]*height:\s*24px;[^}]*font-size:\s*0\.6875rem;[^}]*line-height:\s*1;/
    );
  });

  it('the auto-closed marker is a caption: muted 12px/400 text, block, 2px under the pill, no fill or border', () => {
    // Step 1 (Mav 3.4): a CLOSED pill with an AUTO-CLOSED pill stacked under it
    // read as two statuses. The information stays; the box goes.
    const rule = CSS.match(/\n\.admin-pill--auto-closed \{([^}]*)\}/);
    expect(rule, 'the .admin-pill--auto-closed rule').not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/display:\s*block;/);
    expect(body).toMatch(/margin:\s*2px 0 0;/);
    expect(body).toMatch(/border:\s*0;/);
    expect(body).toMatch(/background:\s*none;/);
    expect(body).toMatch(/color:\s*var\(--text-muted\);/);
    expect(body).toMatch(/font-size:\s*12px;/);
    expect(body).toMatch(/font-weight:\s*400;/);
    expect(body).toMatch(/text-transform:\s*none;/);
  });

  it('the status label renders inside its own truncating span, not the pill directly', () => {
    // Code review HIGH 2 (#142): PUBLISHED_NOT_WORKING_LABEL ("Published, not
    // working" until #157, "Broken" now, which fits) overflowed this
    // fixed-width cell on main; `justify-content: center`
    // on the shared primitive turned that overflow into glyph-on-glyph
    // overlap with the Type lozenge instead of main's harmless rightward
    // spill. `text-overflow: ellipsis` does not paint on the flex pill's
    // own overflow (measured: Chrome hard-clips both ends with no "…"), so
    // the label is wrapped in its own `.admin-study-status__label` span,
    // which does the shrinking and the ellipsis.
    //
    // Matched with the attribute list open rather than as an exact string: the
    // span carries a `title` as well, and a pin that spells the whole opening
    // tag fails on any attribute added beside the class - which is a pin
    // reporting on its own spelling rather than on the structure it is here to
    // hold.
    expect(STUDY_ROW_TSX).toMatch(/<span\s+className="admin-study-status__label"[^>]*>/);
    // The hover title. It carries the label's own value, except for a broken
    // published study, where it carries the full meaning the short "Broken"
    // cannot (#157) - the pill's fill and glyph are the Draft pill's and do
    // not say "published". Behaviour is pinned in Admin.readiness-state.test.
    expect(STUDY_ROW_TSX).toMatch(
      /<span\s+className="admin-study-status__label"\s+title=\{notWorking \? PUBLISHED_NOT_WORKING_DESCRIPTION : statusLabel\}\s*>\s*\{statusLabel\}\s*<\/span>/
    );
    expect(CSS).toMatch(
      /\.admin-study-status__label \{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/
    );
  });

  it('the status column is a fixed 128px <col>, not a percentage', () => {
    // Percentages under `table-layout: fixed` are what starved the Study
    // column (14%, 129px at 1440). The widest pill, PUBLISHED, is ~97px of a
    // 104px content box at 128px.
    expect(CSS).toMatch(/\.admin-data-table col\.col-status \{\s*width:\s*128px;\s*\}/);
    expect(CSS).not.toMatch(/\.admin-data-table \.col-status \{\s*width:\s*\d+%/);
  });

  it('the auto-closed caption is muted in both themes, past the blanket table-text colours', () => {
    // `_themes.css` paints every `td *` #D4D4D4 in dark; without these the
    // caption would read as body text.
    const THEMES = readFileSync(join(__dirname, '..', '_themes.css'), 'utf8');
    for (const theme of ['dark', 'light']) {
      expect(THEMES).toMatch(
        new RegExp(
          `body\\.theme-${theme} \\.admin-dashboard table\\.admin-data-table tbody td\\.col-status \\.admin-pill--auto-closed \\{\\s*color:\\s*var\\(--text-muted\\);`
        )
      );
    }
  });
});
