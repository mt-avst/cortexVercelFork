import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * D7 step strip (row 23).
 *
 * Reads the stylesheets as text, in the shape of its neighbours - a policy
 * check on the declarations that caused each measured defect, not a layout
 * measurement (jsdom does not compute one).
 */

const STYLES_DIR = join(__dirname, '..');
const read = (name: string) => readFileSync(join(STYLES_DIR, name), 'utf8');

/** Slice the flat declaration block for `selector { ... }` (no nested braces). */
const blockFor = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const from = css.indexOf('{', start);
  const to = css.indexOf('\n}', from);
  return css.slice(from + 1, to);
};

describe('step strip - D7 (row 23)', () => {
  const components = read('_components.css');

  it('fixes the rag: .nav-tabs-form .nav-link no longer centres its content vertically', () => {
    const block = blockFor(components, '.nav-tabs-form .nav-link');
    expect(block).toMatch(/align-items\s*:\s*flex-start/);
    expect(block).not.toMatch(/align-items\s*:\s*center/);
  });

  it('fixes the jump: no rule gives the active tab a different font-size from its resting state', () => {
    // The exact pre-fix selectors/declarations. A regression that reintroduces
    // either the .nav-link.active / :not(.active) split or the
    // .tab-title-dynamic.active font-size bump re-wraps the active column and
    // reproduces the 16px strip-height jump.
    expect(components).not.toMatch(/\.nav-tabs-form \.nav-link\.active\s*\{[^}]*font-size/);
    expect(components).not.toMatch(/\.nav-tabs-form \.nav-link:not\(\.active\)\s*\{[^}]*font-size/);
    const activeTitle = blockFor(components, '.tab-title-dynamic.active');
    expect(activeTitle).not.toMatch(/font-size/);
    // Weight still carries the active state - this isn't "nothing changes".
    expect(activeTitle).toMatch(/font-weight\s*:\s*600/);
  });

  it('pins the strip to a compact fixed-ish height, down from up to 167px', () => {
    const block = blockFor(components, '.nav-tabs-form .nav-link');
    expect(block).toMatch(/min-height\s*:\s*56px/);
  });

  it('holds the title to one line regardless of length, so it cannot re-wrap the row', () => {
    const block = blockFor(components, '.step-tab__title');
    expect(block).toMatch(/white-space\s*:\s*nowrap/);
    expect(block).toMatch(/overflow\s*:\s*hidden/);
    expect(block).toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  it('the status row is left-aligned under the title, not centred as a lone stack', () => {
    const block = blockFor(components, '.step-tab__status');
    expect(block).toMatch(/justify-content\s*:\s*flex-start/);
  });

  it('the numeral dims when its step is not the active one, and is not text-hidden by aria', () => {
    const index = blockFor(components, '.step-tab__index');
    expect(index).toMatch(/opacity\s*:\s*0\.5/);
    const activeIndex = blockFor(components, '.nav-tabs-form .nav-link.active .step-tab__index');
    expect(activeIndex).toMatch(/opacity\s*:\s*1/);
  });

  it('drops the description styling entirely - .tab-description(-dynamic) no longer has rules', () => {
    expect(components).not.toMatch(/\.tab-description-dynamic\b/);
    const themes = read('_themes.css');
    expect(themes).not.toMatch(/\.tab-description\b/);
  });
});
