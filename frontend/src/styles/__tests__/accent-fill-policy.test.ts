import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * A fill that carries text may not use an identity colour.
 *
 * The brand ramp's identity steps exist to be seen, not read off. Measured with
 * white text on them: 500 is 2.60, 700 is 3.87 in dark and 3.29 in light. None
 * of them reach the 4.5 that AA asks for small text, and `--brand-primary`
 * carried a comment in _tokens.css asserting the opposite for long enough that
 * nine separate rules put white text on it.
 *
 * Two things let that spread. The token said it was safe, and nothing could
 * contradict it: axe scans a resting DOM, so it never evaluates a `:hover`
 * fill, and it only judges what a scanned route actually renders - which the
 * leaderboard's active tab and the period buttons are not. Six of the nine were
 * invisible to every accessibility run this project has.
 *
 * So this reads the stylesheets instead of the page. It is a policy check, not
 * a contrast measurement: the measurement lives in e2e/accessibility.test.ts,
 * which resolves --accent-fill-text-safe in a real browser in both themes. This
 * one exists to catch the NEXT rule that pairs a light text colour with an
 * identity fill, in a state no scan can reach.
 */

const STYLES_DIR = join(__dirname, '..');

/** Ramp steps and aliases that must never sit behind text. */
const IDENTITY_FILLS = [
  '--brand-primary',
  '--brand-secondary',
  '--brand-headline',
  '--brand-orange-400',
  '--brand-orange-500',
  '--brand-orange-600',
  '--brand-orange-700',
  '--brand-orange-vibrant',
  '--fs-accent',
];

/**
 * Text colours light enough that an identity fill behind them fails AA. Kept
 * deliberately loose - #fff, #FFFFFF, white, and the CTA text tokens, which all
 * resolve to white.
 */
const LIGHT_TEXT = /(^|[^-\w])color\s*:\s*(#fff(fff)?\b|white\b|var\(--cta-text[\w-]*\))/i;

const declaresIdentityFill = (block: string): string | null => {
  const backgrounds = block.match(/(?:^|[;{\s])background(?:-color)?\s*:[^;]*/gi) || [];
  for (const declaration of backgrounds) {
    for (const token of IDENTITY_FILLS) {
      if (declaration.includes(`var(${token})`)) return token;
    }
  }
  return null;
};

/** Split a stylesheet into `selector { declarations }` blocks. */
const ruleBlocks = (css: string): Array<{ selector: string; body: string }> => {
  const blocks: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    blocks.push({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2] });
  }
  return blocks;
};

const cssFiles = readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css'));

describe('accent fill policy', () => {
  it('finds the stylesheets it is supposed to be checking', () => {
    // A policy test that silently reads nothing passes forever.
    expect(cssFiles).toContain('_tokens.css');
    expect(cssFiles).toContain('_themes.css');
    expect(cssFiles).toContain('_components.css');
    expect(cssFiles).toContain('_utilities.css');
    expect(cssFiles.length).toBeGreaterThanOrEqual(6);
  });

  it.each(cssFiles)('%s puts no light text on an identity fill', (file) => {
    const css = readFileSync(join(STYLES_DIR, file), 'utf8');
    const offenders = ruleBlocks(css)
      .map(({ selector, body }) => {
        const token = declaresIdentityFill(body);
        if (!token || !LIGHT_TEXT.test(body)) return null;
        return `${selector} fills with var(${token}) and sets a near-white color`;
      })
      .filter((entry): entry is string => entry !== null);

    expect(
      offenders,
      `Use var(--accent-fill-text-safe) for a fill that carries text; it is defined in both themes and measures 4.77 light / 4.70 dark.\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('the safe fill is defined in BOTH themes, not just light', () => {
    /* The bug underneath the skip link: --accent-fill-on-light is declared only
       under body.theme-light, so `var(--accent-fill-on-light, var(--brand-primary))`
       silently took the fallback arm in dark and landed on 3.87. A token used by
       unscoped rules has to exist wherever those rules apply. */
    const tokens = readFileSync(join(STYLES_DIR, '_tokens.css'), 'utf8');
    const themes = readFileSync(join(STYLES_DIR, '_themes.css'), 'utf8');

    expect(tokens, '--accent-fill-text-safe must have a base (dark) value in _tokens.css')
      .toMatch(/--accent-fill-text-safe\s*:/);

    const lightBlock = themes.slice(themes.indexOf('body.theme-light {'));
    expect(lightBlock.slice(0, lightBlock.indexOf('\n}')), '--accent-fill-text-safe must be redefined for the light theme')
      .toMatch(/--accent-fill-text-safe\s*:/);
  });
});
