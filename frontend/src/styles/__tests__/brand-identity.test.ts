import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * One brand across both themes (audit fix-first #12).
 *
 * Two defects the audit measured off the pixels:
 *
 *   1. The UI typeface changed with the theme. `--font-family-base` was Inter at
 *      :root (so, in dark) and Manrope only under `body.theme-light`, and
 *      `--font-family-display` was declared only under the light theme. The
 *      product's own wordmark was therefore a different typeface in each theme.
 *      The fix binds Manrope (UI) and Fraunces (display) at :root, so both
 *      themes inherit one identity and the theme blocks carry colour only.
 *
 *   2. `--brand-orange-500` - the identity colour - was a different HUE in each
 *      theme: #FF7A33 (vibrant) at :root and #dd6e42 (terracotta) under
 *      `body.theme-light`, with a third orange (#FF5A1F, "Adaptavist Orange")
 *      hardcoded in components. The decision (Nick, 2026-09-08) is one hue,
 *      #FF5A1F, tuned per theme only for contrast. The ramp lives at :root; the
 *      light theme no longer re-anchors it.
 *
 * This reads the stylesheets as text - a policy check, in the shape of its
 * neighbour accent-fill-policy.test.ts - so a mutation that flips either
 * decision back fails here BY NAME rather than silently changing the brand.
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

const valueOf = (block: string, token: string): string | null => {
  const m = block.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
};

/** Follow a single `var(--x)` indirection to the hex it points at. */
const resolveHex = (block: string, token: string): string => {
  let value = valueOf(block, token);
  const indirection = value?.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (indirection) value = valueOf(block, indirection[1]);
  if (!value || !/^#[0-9a-f]{3,6}$/i.test(value)) {
    throw new Error(`${token} did not resolve to a hex (got "${value}")`);
  }
  return value;
};

// WCAG relative luminance + contrast, identical maths to accent-fill-policy.test.ts.
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
const CREAM = '#f7f2ea'; // --fs-bg, the lightest ground orange text sits on

describe('brand identity is one system across themes (#12)', () => {
  const tokens = read('_tokens.css');
  const themes = read('_themes.css');
  const rootTokens = blockFor(tokens, ':root');
  const lightBlock = blockFor(themes, 'body.theme-light');

  describe('typefaces are bound at :root, not per theme', () => {
    it('--font-family-base is Manrope at :root, not Inter', () => {
      const base = valueOf(rootTokens, '--font-family-base');
      expect(base, '--font-family-base must exist at :root').not.toBeNull();
      expect(base).toMatch(/^'Manrope'/);
      expect(base).not.toMatch(/Inter/);
    });

    it('--font-family-display (Fraunces) is defined at :root', () => {
      const display = valueOf(rootTokens, '--font-family-display');
      expect(display, '--font-family-display must be defined at :root, not only in the light theme').not.toBeNull();
      expect(display).toMatch(/Fraunces/);
    });

    it('the light theme does not re-declare the UI or display typeface', () => {
      // The whole point: theme blocks carry colour, not typography.
      expect(lightBlock).not.toMatch(/--font-family-base\s*:/);
      expect(lightBlock).not.toMatch(/--font-family-display\s*:/);
    });

    it('no component rule hardcodes font-family: Inter, bypassing the token (#115)', () => {
      // #12 rebound the token, but component rules still hardcoded
      // `font-family: 'Inter'` (some as `'Clash Grotesk', 'Inter'`), so those
      // surfaces rendered Inter in both themes regardless. #115 pointed them at
      // var(--font-family-base). A new hardcoded Inter face fails here by name.
      // Matches the quoted font in either quote style, so words like
      // "Interview"/"Interactive" in comments or class names are not caught
      // but `font-family: "Inter"` cannot slip past the single-quote form.
      for (const name of ['_components.css', '_themes.css', '_base.css']) {
        const offending = read(name)
          .split('\n')
          .filter((line) => /font-family\s*:[^;]*["']Inter["']/i.test(line));
        expect(offending, `${name} must bind font-family to a token, not hardcode 'Inter'`).toEqual([]);
      }
    });

    it('the display face binds to headings in BOTH themes, not gated on body.theme-light (#12)', () => {
      // The residual after the token rebind: the generic heading rule still hung
      // off `body.theme-light h1/h2/h3`, so dark-theme headings fell back to
      // Manrope. Bind Fraunces to the elements, not the theme. A re-gate fails here.
      const base = read('_base.css');
      expect(
        base,
        'no generic heading font-family rule may be gated on body.theme-light',
      ).not.toMatch(/body\.theme-light\s+\.?h[1-6]\b/);
      const headingBlock = blockFor(base, 'h1, .h1, h2, .h2, h3, .h3');
      expect(
        valueOf(headingBlock, 'font-family'),
        'the unconditional heading rule must carry the display face',
      ).toMatch(/--font-family-display/);
    });
  });

  describe('one orange hue, tuned per theme only for contrast', () => {
    it('--brand-orange-500 is #FF5A1F (Adaptavist orange) at :root', () => {
      expect(valueOf(rootTokens, '--brand-orange-500')?.toUpperCase()).toBe('#FF5A1F');
    });

    it('the light theme does not re-anchor the orange ramp to a second hue', () => {
      expect(lightBlock).not.toMatch(/--brand-orange-500\s*:/);
      expect(lightBlock).not.toMatch(/--brand-orange-700\s*:/);
    });

    it('no pre-#12 orange (terracotta or the old vibrant ramp) survives in the theme layer', () => {
      // The old light ramp + FirstHand accent were terracotta; the old :root
      // ramp was the #FF7A33 vibrant family. Neither may return as a hex - not
      // in a declaration, not in a comment that could be copied into one. This
      // is the exact stale-value class row 12 set out to delete.
      const lower = themes.toLowerCase();
      for (const hex of ['#dd6e42', '#b9552d', '#9a4524', '#d46032', '#f0b49a', '#e89572',
                         '#ff7a33', '#ff8f4d', '#ffb380', '#e86c24', '#d35f1d', '#c54e12']) {
        expect(lower, `${hex} is a pre-#12 orange and must not appear in _themes.css`).not.toContain(hex);
      }
    });

    it('the fill step carries white text at AA (>= 4.5)', () => {
      const fill = valueOf(rootTokens, '--brand-orange-700');
      expect(fill, '--brand-orange-700 must be a hex').toMatch(/^#/);
      expect(contrast(fill as string, WHITE)).toBeGreaterThanOrEqual(4.5);
    });

    it('the text step reads on the lightest ground at AA (>= 4.5)', () => {
      const text = valueOf(rootTokens, '--brand-orange-800');
      expect(text, '--brand-orange-800 must be a hex').toMatch(/^#/);
      expect(contrast(text as string, CREAM)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text as string, WHITE)).toBeGreaterThanOrEqual(4.5);
    });

    it('--brand-primary is an identity step that FAILS white text at AA (teeth)', () => {
      // e2e/accessibility.test.ts asserts --brand-primary resolves below 4.5
      // under white in BOTH themes, so identity and text-safe can never collapse
      // into one token. Pin it here too - a token edit that points --brand-primary
      // at the text-safe step (as row 12 first did, tripping the CI axe job) must
      // fail in the fast suite, not only in CI. Light resolves it via --fs-accent
      // (also < 4.5), so :root is the arm that regressed.
      const primary = resolveHex(rootTokens, '--brand-primary');
      expect(contrast(primary, WHITE)).toBeLessThan(4.5);
    });
  });

  describe('the signed-out landing wordmark follows the theme, not a flat white override (row 1)', () => {
    // The override used to fire on `.landing-page`/`.cortex-landing` alone, so
    // it painted the ink wordmark white even on the LIGHT landing (near-white
    // on white: ~1.1:1). The header itself is transparent in both themes;
    // .landing-page-wrapper is the real ground, and only the DARK landing
    // paints it near-black - so the fix scopes the override to
    // `body.theme-dark`, not deletes it. A regression that drops the
    // `theme-dark` qualifier (restoring the old blanket rule) fails here by
    // name before it ever reaches a browser.
    const components = read('_components.css');

    it('every `.logo-word` white override is qualified on body.theme-dark', () => {
      // Locate the anchor comment, then the /*...*/ that immediately follows
      // it, then the rule that follows THAT - so the comment's own prose
      // (which may contain commas) never leaks into the selector list below.
      const anchorAt = components.search(/the landing header itself is transparent/i);
      expect(anchorAt, 'the dark-landing wordmark override comment must still exist').toBeGreaterThanOrEqual(0);
      const commentEnd = components.indexOf('*/', anchorAt);
      expect(commentEnd, 'the anchor comment must be closed').toBeGreaterThan(anchorAt);
      const ruleText = components.slice(commentEnd + 2);
      const ruleOpenBrace = ruleText.indexOf('{');
      const selectors = ruleText.slice(0, ruleOpenBrace);
      const lines = selectors.split(',').map((s) => s.trim()).filter(Boolean);
      expect(lines.length, 'expected at least one .logo-word override selector').toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `selector "${line}" must require body.theme-dark`).toMatch(/body\.theme-dark/);
        expect(line, `selector "${line}" must target .logo-word`).toMatch(/\.logo-word$/);
      }
    });

    it('no unqualified `.landing-page .header .logo-word` or `:has(.cortex-landing)` rule survives', () => {
      // The exact pre-fix selectors, so a re-introduction elsewhere in the file
      // (not just an edit of the block above) still fails.
      expect(components).not.toMatch(/(?<!theme-dark[^\n{]*)\.landing-page \.header \.logo-word\s*\{/);
      expect(components).not.toMatch(/body:has\(\.cortex-landing\) \.header \.logo-word\s*\{/);
    });
  });

  describe('status colors are one set shared by both themes, not a dark-only Bootstrap default (row 27)', () => {
    // Dark shipped the raw Bootstrap trio (#28a745/#ffc107/#dc3545) while light
    // already carried deliberate, AA-checked replacements. #28a745 + the
    // Approve button's white text measured 3.13:1 - below AA - in dark only.
    // Promoting light's values to :root (mirroring the row-12 orange
    // unification) fixes dark without light re-declaring them.
    it('--fs-success and --fs-danger are bound at :root', () => {
      expect(valueOf(rootTokens, '--fs-success')?.toUpperCase()).toBe('#2F6F5E');
      expect(valueOf(rootTokens, '--fs-danger')?.toUpperCase()).toBe('#A63D40');
    });

    it('--fs-warning is defined at :root from the AA-checked literal (black text 6.12:1, not white 3.43:1)', () => {
      expect(valueOf(rootTokens, '--fs-warning')?.toUpperCase()).toBe('#C27A2D');
    });

    it('--status-success/-warning/-danger resolve to the fs-* tokens at :root', () => {
      expect(valueOf(rootTokens, '--status-success')).toBe('var(--fs-success)');
      expect(valueOf(rootTokens, '--status-warning')).toBe('var(--fs-warning)');
      expect(valueOf(rootTokens, '--status-danger')).toBe('var(--fs-danger)');
    });

    it('the Approve button fill (--status-success + white text) clears AA in dark', () => {
      const success = resolveHex(rootTokens, '--status-success');
      expect(contrast(success, WHITE)).toBeGreaterThanOrEqual(4.5);
    });

    it('the old Bootstrap trio literals are gone from _tokens.css', () => {
      const lower = tokens.toLowerCase();
      for (const hex of ['#28a745', '#ffc107', '#dc3545']) {
        expect(lower, `${hex} is a pre-row-27 Bootstrap default and must not appear in _tokens.css`).not.toContain(hex);
      }
    });

    it('the light theme no longer re-anchors success/warning/danger (one brand, not a per-theme re-declaration)', () => {
      expect(lightBlock).not.toMatch(/--fs-success\s*:/);
      expect(lightBlock).not.toMatch(/--fs-danger\s*:/);
      expect(lightBlock).not.toMatch(/--status-success\s*:/);
      expect(lightBlock).not.toMatch(/--status-warning\s*:/);
      expect(lightBlock).not.toMatch(/--status-danger\s*:/);
    });

    it('--status-info is deliberately left split per theme, not folded into the trio deletion', () => {
      // info is used BOTH as a white-on-fill badge (badge-info) and as bare text
      // on the alert-info tint (alert-info, on a still-dark composited
      // background in dark theme). Dark's Bootstrap teal (#17a2b8) already
      // clears AA as text (6.46:1) though not as a fill (3.04:1); light's navy
      // (#1e5a8a) clears AA as a fill (7.28:1) though not as text on a dark
      // ground. Unifying either direction trades a passing role for a failing
      // one, so unlike success/warning/danger this token is NOT promoted to
      // :root in row 27 - each theme keeps its own value.
      expect(valueOf(rootTokens, '--status-info')?.toUpperCase()).toBe('#17A2B8');
      expect(valueOf(lightBlock, '--status-info')?.toUpperCase()).toBe('#1E5A8A');
    });
  });
});
