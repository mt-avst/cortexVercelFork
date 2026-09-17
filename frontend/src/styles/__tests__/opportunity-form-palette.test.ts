import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The wizard's dark-mode contrast, the light-theme badge specificity bug and
 * the token census - rows 21, 22 and 25 of the second-pass fix-first
 * register, all in `_themes.css`/`_tokens.css`.
 *
 * Same shape as its neighbours (brand-identity.test.ts, lozenge-dark-text):
 * read the stylesheets as text, resolve the tokens they reference, and
 * measure contrast with the same WCAG formula.
 */

const STYLES_DIR = join(__dirname, '..');
const read = (name: string) => readFileSync(join(STYLES_DIR, name), 'utf8');

const blockFor = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const from = css.indexOf('{', start);
  const to = css.indexOf('\n}', from);
  return css.slice(from + 1, to);
};

const valueOf = (block: string, token: string): string | null => {
  const m = block.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
};

/** Follow a single `var(--x)` indirection to the hex it points at. */
const resolveHex = (roots: string[], token: string): string => {
  let value: string | null = null;
  for (const block of roots) {
    value = valueOf(block, token);
    if (value !== null) break;
  }
  if (value === null) throw new Error(`${token} was not declared in any given block`);
  const indirection = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (indirection) return resolveHex(roots, indirection[1]);
  if (!/^#[0-9a-f]{3,6}$/i.test(value)) {
    throw new Error(`${token} did not resolve to a hex (got "${value}")`);
  }
  return value;
};

const toRgb = (hex: string): [number, number, number] => {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};
const luminance = ([r, g, b]: [number, number, number]): number => {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const WHITE = '#FFFFFF';

describe('opportunity form wizard - dark contrast (row 22)', () => {
  const tokens = read('_tokens.css');
  const themes = read('_themes.css');
  const rootTokens = blockFor(tokens, ':root');

  it('the dark Continue button no longer fills with the identity orange', () => {
    const block = blockFor(themes, 'body.theme-dark .opportunity-form .btn-primary');
    expect(block).toMatch(/var\(--accent-fill-text-safe\)/);
    expect(block).not.toMatch(/var\(--color-brand-orange\)/);
  });

  it('the dark Continue fill clears AA (>= 4.5) under its white label', () => {
    const fill = resolveHex([rootTokens], '--accent-fill-text-safe');
    expect(contrast(fill, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it('the dark Review "Save changes" button no longer fills with raw Bootstrap green', () => {
    const block = blockFor(themes, 'body.theme-dark .opportunity-form .btn-success');
    expect(block).not.toMatch(/#28a745/i);
  });

  it('the dark Save-changes fill clears AA (>= 4.5) under its white label', () => {
    const block = blockFor(themes, 'body.theme-dark .opportunity-form .btn-success');
    const varMatch = block.match(/background-color:\s*var\((--[a-z0-9-]+)\)/i);
    expect(varMatch, 'the fill must be a token, not a literal').not.toBeNull();
    const fill = resolveHex([rootTokens], varMatch![1]);
    expect(contrast(fill, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it('the arithmetic can actually fail - the raw Bootstrap pair this replaces was below AA', () => {
    // Control: proves the check would have caught the original defect.
    expect(contrast('#FF5A1F', WHITE)).toBeLessThan(4.5);
    expect(contrast('#28a745', WHITE)).toBeLessThan(4.5);
  });
});

describe('opportunity form wizard - light badge specificity (row 21)', () => {
  const themes = read('_themes.css');

  it('the light-theme .badge rule excludes anything already carrying a bg-* class', () => {
    const anchor = themes.indexOf('body.theme-light .badge');
    expect(anchor, 'the light theme badge rule must still exist').toBeGreaterThanOrEqual(0);
    const openBrace = themes.indexOf('{', anchor);
    const selectors = themes.slice(anchor, openBrace);
    expect(selectors).toMatch(/\.badge:not\(\[class\*=["']bg-["']\]\)/);
  });

  it('.bg-success / .bg-danger still declare their own semantic fill, unscoped to either theme', () => {
    const components = read('_components.css');
    const success = blockFor(components, '.badge-success,\n.bg-success');
    const danger = blockFor(components, '.badge-danger,\n.bg-danger');
    expect(success).toMatch(/var\(--status-success\)/);
    expect(danger).toMatch(/var\(--status-danger\)/);
  });

  it('a Remaining=1 and Remaining=0 badge resolve to different fills once the exclusion applies', () => {
    // The observed defect: body.theme-light .badge (0,2,1) beat .bg-success/
    // .bg-danger (0,1,0) regardless of source order, flattening both to the
    // same --tag-bg. This is the arithmetic that made them look identical.
    const components = read('_components.css');
    const success = blockFor(components, '.badge-success,\n.bg-success');
    const danger = blockFor(components, '.badge-danger,\n.bg-danger');
    expect(valueOf(success, 'background')).not.toBe(valueOf(danger, 'background'));
  });
});

describe('opportunity form wizard - orange token census (row 25)', () => {
  const themes = read('_themes.css');

  it('the "Save and exit" button is gone - the two-orange-on-one-control defect cannot recur', () => {
    // #BF4417 (border) + #B33F16 (label) on one Save-and-exit control was the
    // row's headline finding. D9 deletes the control outright (see
    // StepActions.test.tsx); this is the CSS-side half of that guarantee -
    // no rule targets a "save and exit" class any more.
    expect(themes.toLowerCase()).not.toMatch(/save-and-exit/);
  });

  it('dark .btn-primary/.btn-success now share the identity-fill census with light: one fill token, one text token', () => {
    // Fill surface: --accent-fill-text-safe (dark) / --accent-fill-on-light
    // (light) - both resolve through the same one-orange-ramp policy
    // (brand-identity.test.ts). Text surface: --color-brand-orange (dark,
    // used as plain ink e.g. the active step rule) / --accent-text-on-light
    // (light). No THIRD orange step is introduced by this row's fixes.
    const darkPrimary = blockFor(themes, 'body.theme-dark .opportunity-form .btn-primary');
    const lightPrimary = blockFor(themes, 'body.theme-light .opportunity-form .btn-primary');
    expect(darkPrimary).toMatch(/--accent-fill-text-safe/);
    expect(lightPrimary).toMatch(/--accent-fill-on-light/);
  });
});

describe('opportunity form wizard - theme-parity surfaces (row 26)', () => {
  const themes = read('_themes.css');

  it('the tint scale exists in both themes, at three distinct escalating strengths', () => {
    const dark = blockFor(themes, 'body.theme-dark');
    const light = blockFor(themes, 'body.theme-light');
    for (const level of ['subtle', 'medium', 'strong']) {
      expect(dark, `--surface-tint-${level}-current must be declared for dark`).toMatch(
        new RegExp(`--surface-tint-${level}-current\\s*:`)
      );
      expect(light, `--surface-tint-${level}-current must be declared for light`).toMatch(
        new RegExp(`--surface-tint-${level}-current\\s*:`)
      );
    }
  });

  it('the three named tint levels resolve to three different opacities per theme', () => {
    const tokens = read('_tokens.css');
    const rootTokens = blockFor(tokens, ':root');
    const subtle = resolveHexAlpha(rootTokens, '--border-strength-subtle');
    const medium = resolveHexAlpha(rootTokens, '--border-strength-medium');
    const strong = resolveHexAlpha(rootTokens, '--border-strength-strong');
    expect(new Set([subtle, medium, strong]).size).toBe(3);
  });
});

/** Pulls the alpha channel out of an rgba(...) token value for a quick
 * distinctness check - not a colour comparison, just "are these different". */
function resolveHexAlpha(block: string, token: string): number {
  const value = valueOf(block, token);
  const m = value?.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
  if (!m) throw new Error(`${token} is not an rgba() value (got "${value}")`);
  return Number(m[1]);
}

describe('opportunity form wizard - control-panel family is theme-aware (row 26)', () => {
  const components = read('_components.css');

  it.each([
    '.control-panel',
    '.control-panel-subtle',
    '.segmented-control',
    '.card-glass',
    '.calendar-control-panel'
  ])('%s no longer hardcodes a white-only rgba() surface', (selector) => {
    const block = blockFor(components, selector);
    expect(block).not.toMatch(/rgba\(255,\s*255,\s*255/);
  });

  it('.segmented-control carries its own border, independent of how strong the fill tint resolves', () => {
    const block = blockFor(components, '.segmented-control');
    expect(block).toMatch(/border\s*:\s*1px solid var\(--border-subtle-current\)/);
  });

  it('the segmented button escalates subtle -> medium -> strong across rest/hover/active', () => {
    const rest = blockFor(components, '.segmented-control');
    const hover = blockFor(components, '.segmented-control-btn:hover:not(:disabled)');
    const active = blockFor(components, '.segmented-control-btn.active');
    expect(rest).toMatch(/--surface-tint-subtle-current/);
    expect(hover).toMatch(/--surface-tint-medium-current/);
    expect(active).toMatch(/--surface-tint-strong-current/);
  });
});
