import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #131: the Sort-by control (`Admin.tsx`, `.admin-card-sort`) must be visible
 * wherever a sortable header is out of view and invisible everywhere else.
 * Since the Admin table Step 1 fix (2026-09-23) that is:
 *
 *   >= 1280px       full table, every sort header visible   -> control hidden
 *   1024-1279.98px  table without the Created column        -> control shown
 *   < 1024px        ROW 14 card view, <thead> hidden         -> control shown
 *
 * jsdom applies no layout, so this pins those states as literal text in
 * `_components.css` rather than trying to measure them. Every breakpoint is
 * pinned as a literal (`1279.98px`, `1023.98px`, `1024px`): a test that
 * derived them from the media queries themselves could not see them drift.
 */

const CSS = readFileSync(join(__dirname, '..', '_components.css'), 'utf8');

/** One `selector { declarations }` block, matched on the FIRST occurrence of
 * `selector` as a whole item in a rule's own selector list - anchored to the
 * start of its line (whitespace only before it), followed by a comma (more
 * selectors follow) or the rule's own opening brace. C-L6: a plain
 * `indexOf('${selector} {')` also matches a COMPOUND selector that merely
 * ends in the same text (e.g. `.admin-phone-filters .admin-chip {`), which
 * is a different, more specific rule - that false match is exactly what let
 * `.admin-phone-chip` exist only to dodge this lookup rather than share
 * `.admin-chip`. Assumes flat declarations (no nested braces) - true of
 * every plain rule in this file. */
const blockFor = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchored at the start of its own line (only whitespace before it) and
  // followed directly by its rule's opening brace - so `selector` must be
  // the WHOLE (possibly multi-line, comma-joined) selector list this call
  // was given, not a suffix inside a longer compound/descendant selector.
  const found = new RegExp(`^[ \\t]*${escaped}[ \\t]*\\{`, 'm').exec(css);
  if (!found) throw new Error(`selector not found: ${selector}`);
  const start = found.index;
  const from = css.indexOf('{', start);
  // Declarations end at the rule's own closing brace, which - for every rule
  // in this file - sits alone on its own line, indented to match its
  // selector. Walk forward from the opening brace to the first line whose
  // trimmed content is exactly "}".
  const lines = css.slice(from + 1).split('\n');
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === '}') break;
    body.push(line);
  }
  return body.join('\n');
};

/** The body of the FIRST top-level `@media ${query} {` block, up to its closing
 * `}` at column 0. Throws, rather than returning an empty string, when the
 * query is absent - an empty slice would make every "not.toMatch" vacuous. */
const mediaBlock = (query: string): string => {
  const mediaStart = CSS.indexOf(`@media ${query} {`);
  if (mediaStart === -1) throw new Error(`media block not found: @media ${query}`);
  const braceOpen = CSS.indexOf('{', mediaStart);
  const mediaEnd = CSS.indexOf('\n}', braceOpen);
  if (mediaEnd === -1) throw new Error(`media block does not close: @media ${query}`);
  return CSS.slice(braceOpen + 1, mediaEnd);
};

const SORT_CONTROL_MEDIA = '(max-width: 1279.98px)';
const CARD_REFLOW_MEDIA = '(max-width: 1023.98px)';
const CREATED_HIDDEN_MEDIA = '(min-width: 1024px) and (max-width: 1279.98px)';

describe('.admin-card-sort visibility (#131, Admin table Step 1)', () => {
  it('finds the stylesheet it is supposed to be checking', () => {
    // Control: an empty read would make every assertion below vacuous.
    expect(CSS.length).toBeGreaterThan(1000);
  });

  it('is display:none outside the media query, by default', () => {
    // The FIRST occurrence of the selector is its base rule, declared before
    // the media query that shows it (checked below) - not the "shown"
    // override inside it.
    const base = blockFor(CSS, '.admin-card-sort');
    expect(base).toMatch(/display:\s*none\s*;/);

    const baseIndex = CSS.indexOf('.admin-card-sort {');
    const mediaIndex = CSS.indexOf(`@media ${SORT_CONTROL_MEDIA} {`);
    expect(baseIndex).toBeGreaterThan(-1);
    expect(mediaIndex).toBeGreaterThan(-1);
    expect(baseIndex).toBeLessThan(mediaIndex);
  });

  it('is shown below 1280px - the Created-hidden band AND the card view - not only in card view', () => {
    // The control is shown by the 1279.98px block, which covers both bands
    // where a sortable header is out of view.
    expect(mediaBlock(SORT_CONTROL_MEDIA)).toMatch(/\.admin-card-sort\s*\{[^}]*display:\s*flex/);
    // ...and NOT by the card reflow block alone: on main (08b65f80) the only
    // "shown" rule sat inside the reflow block, so a 1024-1279px window lost
    // the Created sort when Created's column went.
    expect(mediaBlock(CARD_REFLOW_MEDIA)).not.toMatch(/\.admin-card-sort\s*\{[^}]*display:\s*flex/);
  });

  it('the card reflow starts below 1024px and still hides <thead> there', () => {
    const reflow = mediaBlock(CARD_REFLOW_MEDIA);
    // Control arm: prove the parser found the reflow block itself - this is
    // the rule the ROW 14 fix added.
    expect(reflow).toMatch(/\.admin-data-table,\s*\.admin-data-table tbody,\s*\.admin-data-table tr\s*\{[^}]*display:\s*block/);
    expect(reflow).toMatch(/\.admin-data-table thead\s*\{[^}]*display:\s*none/);
    // The old 1219.98px reflow must be gone, or 1024-1219px is still cards.
    expect(CSS).not.toMatch(/@media \(max-width: 1219\.98px\)/);
  });

  it('hides the Created column - its <col>, header and cells together - between 1024 and 1279.98px', () => {
    const band = mediaBlock(CREATED_HIDDEN_MEDIA);
    // All three, in one rule: hiding th/td but not the <col> would leave six
    // <col>s for five cells and slide Actions under Created's width.
    expect(band).toMatch(
      /\.admin-data-table col\.col-date,\s*\.admin-dashboard table\.admin-data-table th\.col-date,\s*\.admin-dashboard table\.admin-data-table td\.col-date\s*\{[^}]*display:\s*none/
    );
  });

  it('keeps the card view free of the table-mode <col> widths, which would push a phone sideways', () => {
    expect(mediaBlock(CARD_REFLOW_MEDIA)).toMatch(/\.admin-data-table colgroup\s*\{[^}]*display:\s*none/);
  });

  it('lets each card cell use the full card width, cancelling the tablet/phone 35%/40% first-cell clamp', () => {
    // Control: the clamp being cancelled must still exist, or this test is
    // guarding against nothing.
    expect(CSS).toMatch(/tbody td:nth-child\(1\)\s*\{[^}]*max-width:\s*40%/);
    expect(mediaBlock(CARD_REFLOW_MEDIA)).toMatch(/\.admin-data-table td\s*\{[^}]*max-width:\s*none\s*!important/);
  });
});

describe('.filter-field-sm floor (found alongside #131)', () => {
  it('is never narrower than the select it holds, so the filters row wraps instead of overlapping', () => {
    // Both floors pinned as literals: a test that compared one to the other
    // without naming either could not see both drifting together.
    const control = blockFor(CSS, '.filters-row .form-control,\n.filters-row .form-select,\n.admin-search-input,\n.admin-filter-select');
    expect(control).toMatch(/min-width:\s*180px\s*;/);
    expect(blockFor(CSS, '.filter-field-sm')).toMatch(/min-width:\s*180px\s*;/);
  });
});

describe('.admin-card-sort shared control height (#131)', () => {
  it('keeps the select and direction pill one height, 2.125rem, and out-specifies the phone select rule', () => {
    // 2rem until Admin table Step 2, which gave the chips beside the control
    // an explicit 2.125rem and the control the same (handover section 4:
    // "the Sort-by control's height and radius match the chips").
    expect(mediaBlock(SORT_CONTROL_MEDIA)).toMatch(/--admin-card-sort-height:\s*2\.125rem\s*;/);
    // The `.admin-dashboard` prefix is load-bearing: without it the phone
    // `.admin-dashboard .form-select` rule wins, and its side padding sits
    // over the chevron and clips the selected field's name.
    const shared = blockFor(CSS, '.admin-dashboard .admin-card-sort .form-select,\n  .admin-dashboard .admin-card-sort-dir');
    expect(shared).toMatch(/height:\s*var\(--admin-card-sort-height\)\s*;/);
    expect(shared).toMatch(/min-height:\s*0\s*;/);
  });

  it('matches the quick-filter chips it sits beside: 2.125rem tall, pill-shaped (Admin table Step 2)', () => {
    // Both heights pinned as literals, not compared to each other: two values
    // drifting together would pass a comparison.
    const chip = blockFor(CSS, '.admin-chip');
    expect(chip).toMatch(/(^|\n)\s*height:\s*2\.125rem\s*;/);
    expect(chip).toMatch(/border-radius:\s*var\(--radius-full\)\s*;/);
    // The select was the one square-cornered piece of the family; the
    // direction pill already carried --radius-full (control, below).
    const select = blockFor(mediaBlock(SORT_CONTROL_MEDIA), '.admin-dashboard .admin-card-sort .form-select');
    expect(select).toMatch(/border-radius:\s*var\(--radius-full\)\s*;/);
    // Anchored at the line start: `.admin-dashboard .admin-card-sort-dir {`
    // (the shared-height rule) also contains the bare selector.
    expect(mediaBlock(SORT_CONTROL_MEDIA)).toMatch(
      /\n\s*\.admin-card-sort-dir \{[^}]*border-radius:\s*var\(--radius-full\)\s*;/
    );
  });

  it('grows both controls to 2.5rem on a phone, matching every other admin select there', () => {
    // Control: the phone rule it matches still sets 2.5rem.
    expect(CSS).toMatch(/\.admin-dashboard \.form-select \{[^}]*min-height:\s*2\.5rem/);
    // C-L2: the phone breakpoint was unified on 575.98px (not 575px) across
    // the branch's cascade bumps.
    expect(CSS).toMatch(/@media \(max-width: 575\.98px\) \{\s*\.admin-card-sort \{\s*--admin-card-sort-height:\s*2\.5rem\s*;/);
  });
});
