import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The opportunity form shell: field widths (row 29), one card width (row 37)
 * and form-check alignment (row 28).
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

describe('field width system (row 29)', () => {
  const components = read('_components.css');

  it('defines the three named widths, not a fourth ad hoc one', () => {
    expect(blockFor(components, '.field-width-full')).toMatch(/width\s*:\s*100%/);
    expect(blockFor(components, '.field-width-half')).toMatch(/width\s*:\s*50%/);
    expect(blockFor(components, '.field-width-short')).toMatch(/width\s*:\s*25%/);
  });

  it('collapses every width to full on a phone viewport', () => {
    const start = components.indexOf('@media (max-width: 767px) {\n  .field-width-full');
    expect(start, 'a mobile collapse rule for the field widths must exist').toBeGreaterThan(-1);
    const end = components.indexOf('\n}', start);
    const block = components.slice(start, end);
    expect(block).toMatch(/width\s*:\s*100%/);
  });

  it('defines one stack order: label, then field, then help text', () => {
    const labelOrder = blockFor(components, '.field-stack > label,\n.field-stack > .form-label');
    expect(labelOrder).toMatch(/order\s*:\s*0/);
    const helpOrder = blockFor(components, '.field-stack > .form-text,\n.field-stack > .field-help');
    expect(helpOrder).toMatch(/order\s*:\s*2/);
  });
});

describe('one card width (row 37)', () => {
  it('pins the wizard card to one fixed width, overriding the responsive .col-xl-10 percentage', () => {
    const components = read('_components.css');
    const block = blockFor(
      components,
      '.opportunity-form.container-fluid .row.justify-content-center > .col-12.col-xl-10'
    );
    expect(block).toMatch(/max-width\s*:\s*926px/);
  });

  it('does not touch .col-xl-10 itself, which other pages still use as a plain percentage column', () => {
    const components = read('_components.css');
    const block = blockFor(components, '.col-xl-10');
    expect(block).toMatch(/width\s*:\s*83\.333333%/);
    expect(block).not.toMatch(/max-width/);
  });
});

describe('form-check radio/checkbox alignment (row 28)', () => {
  const components = read('_components.css');

  it('aligns to the top of a (possibly multi-line) label, not the vertical centre', () => {
    const block = blockFor(components, '.form-check');
    expect(block).toMatch(/align-items\s*:\s*flex-start/);
    expect(block).not.toMatch(/align-items\s*:\s*center/);
  });

  it('gives the input a top offset, so a single-line label still looks centred', () => {
    const block = blockFor(components, '.form-check-input');
    expect(block).toMatch(/margin-top\s*:\s*0\.15rem/);
  });
});

describe('sticky step actions have an opaque fill (row 24 / D9, coordinator LOW)', () => {
  const components = read('_components.css');

  it('does not use --bg-card, which is a 5%-alpha glass tint in dark theme', () => {
    const block = blockFor(components, '.step-actions');
    expect(block).not.toMatch(/var\(--bg-card\)/);
  });

  it('uses --surface-card-current, this codebase\'s existing 90%+-opaque "solid card" surface', () => {
    const block = blockFor(components, '.step-actions');
    expect(block).toMatch(/background\s*:\s*var\(--surface-card-current\)/);
  });

  it('--surface-card-current itself resolves to a near-opaque fill in both themes (alpha >= 0.9)', () => {
    const tokens = read('_tokens.css');
    const themes = read('_themes.css');

    // Dark: --surface-card-current -> --surface-card (a rgba() literal).
    const darkSurfaceCard = tokens.match(/--surface-card:\s*rgba\([^)]*,\s*([\d.]+)\s*\)/);
    expect(darkSurfaceCard, '--surface-card must be an rgba() literal').not.toBeNull();
    expect(Number(darkSurfaceCard![1])).toBeGreaterThanOrEqual(0.9);

    // Light: --surface-card-current -> --surface-card-light, redefined in
    // _themes.css to an rgba() literal (the _tokens.css base is #FFFFFF,
    // fully opaque, but the theme file's own redefinition is what actually
    // applies under body.theme-light).
    const lightSurfaceCard = themes.match(/--surface-card-light:\s*rgba\([^)]*,\s*([\d.]+)\s*\)/);
    expect(lightSurfaceCard, '--surface-card-light must be an rgba() literal in _themes.css').not.toBeNull();
    expect(Number(lightSurfaceCard![1])).toBeGreaterThanOrEqual(0.9);
  });
});
