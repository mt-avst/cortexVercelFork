import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #131: the card-view sort control (`Admin.tsx`, `.admin-card-sort`) must be
 * invisible above the ROW 14 reflow breakpoint and visible below it - jsdom
 * applies no layout, so this pins the two states as literal text in
 * `_components.css` rather than trying to measure them.
 *
 * The breakpoint is pinned as a literal (`1219.98px`), matching the ROW 14
 * comment it sits beside; a test that derived it from the media query itself
 * could not see the media query drift.
 */

const CSS = readFileSync(join(__dirname, '..', '_components.css'), 'utf8');

/** One `selector { declarations }` block, matched on the FIRST occurrence of
 * `${selector} {` at any indentation. Assumes flat declarations (no nested
 * braces) - true of every plain rule in this file. */
const blockFor = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
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

describe('.admin-card-sort visibility (#131)', () => {
  it('finds the stylesheet it is supposed to be checking', () => {
    // Control: an empty read would make every assertion below vacuous.
    expect(CSS.length).toBeGreaterThan(1000);
  });

  it('is display:none outside the media query, by default', () => {
    // The FIRST occurrence of the selector is its base rule, declared before
    // the ROW 14 media query in the file (checked below) - not the "shown"
    // override inside it.
    const base = blockFor(CSS, '.admin-card-sort');
    expect(base).toMatch(/display:\s*none\s*;/);

    const baseIndex = CSS.indexOf('.admin-card-sort {');
    const mediaIndex = CSS.indexOf('@media (max-width: 1219.98px) {');
    expect(baseIndex).toBeGreaterThan(-1);
    expect(mediaIndex).toBeGreaterThan(-1);
    expect(baseIndex).toBeLessThan(mediaIndex);
  });

  it('is shown inside the @media (max-width: 1219.98px) block, where <thead> disappears', () => {
    const mediaStart = CSS.indexOf('@media (max-width: 1219.98px) {');
    expect(mediaStart, 'the ROW 14 breakpoint must exist as this literal').toBeGreaterThan(-1);
    const braceOpen = CSS.indexOf('{', mediaStart);
    const mediaEnd = CSS.indexOf('\n}', braceOpen);
    expect(mediaEnd, 'the media block must close at a top-level "}"').toBeGreaterThan(braceOpen);
    const mediaBlock = CSS.slice(braceOpen + 1, mediaEnd);

    // Control arm: prove the parser can actually find a rule in this exact
    // block, so an empty/wrong slice cannot pass the assertion below by
    // finding nothing at all. This is the rule the ROW 14 fix itself added.
    expect(mediaBlock).toMatch(/\.admin-data-table thead\s*\{[^}]*display:\s*none/);

    // The control this fix adds, shown in the same block.
    expect(mediaBlock).toMatch(/\.admin-card-sort\s*\{[^}]*display:\s*flex/);
  });

  it('lets each card cell use the full card width, cancelling the tablet/phone 35%/40% first-cell clamp', () => {
    const mediaStart = CSS.indexOf('@media (max-width: 1219.98px) {');
    const braceOpen = CSS.indexOf('{', mediaStart);
    const mediaBlock = CSS.slice(braceOpen + 1, CSS.indexOf('\n}', braceOpen));
    // Control: the clamp being cancelled must still exist, or this test is
    // guarding against nothing.
    expect(CSS).toMatch(/tbody td:nth-child\(1\)\s*\{[^}]*max-width:\s*40%/);
    expect(mediaBlock).toMatch(/\.admin-data-table td\s*\{[^}]*max-width:\s*none\s*!important/);
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
  it('keeps the select and direction pill one height, 2rem, and out-specifies the phone select rule', () => {
    const mediaStart = CSS.indexOf('@media (max-width: 1219.98px) {');
    const braceOpen = CSS.indexOf('{', mediaStart);
    const mediaBlock = CSS.slice(braceOpen + 1, CSS.indexOf('\n}', braceOpen));
    expect(mediaBlock).toMatch(/--admin-card-sort-height:\s*2rem\s*;/);
    // The `.admin-dashboard` prefix is load-bearing: without it the phone
    // `.admin-dashboard .form-select` rule wins, and its side padding sits
    // over the chevron and clips the selected field's name.
    const shared = blockFor(CSS, '.admin-dashboard .admin-card-sort .form-select,\n  .admin-dashboard .admin-card-sort-dir');
    expect(shared).toMatch(/height:\s*var\(--admin-card-sort-height\)\s*;/);
    expect(shared).toMatch(/min-height:\s*0\s*;/);
  });

  it('grows both controls to 2.5rem on a phone, matching every other admin select there', () => {
    // Control: the phone rule it matches still sets 2.5rem.
    expect(CSS).toMatch(/\.admin-dashboard \.form-select \{[^}]*min-height:\s*2\.5rem/);
    expect(CSS).toMatch(/@media \(max-width: 575px\) \{\s*\.admin-card-sort \{\s*--admin-card-sort-height:\s*2\.5rem\s*;/);
  });
});
