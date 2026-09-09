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
      `Use var(--accent-fill-text-safe) for a fill that carries text; it is defined in both themes and measures 5.77 under white on the unified #FF5A1F ramp.\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  /**
   * A hardcoded fill must declare its own text colour, and the pair must pass.
   *
   * The token checks above cannot see a raw hex, and the admin role badges were
   * exactly that: four Bootstrap 4 fills written inline in a component with
   * `!important` and no text colour, so the label fell through to `.badge`'s
   * --tag-text - white in dark, navy in light. A fixed fill under a colour that
   * flips per theme fails on one side or the other, and all four did.
   *
   * So this measures every rule that declares a hex background and a hex text
   * colour together, and requires 4.5.
   *
   * Two things it cannot see, stated so nobody reads a green run as more than
   * it is. It compares declarations WITHIN one rule, so a fill on a parent and
   * a colour on a child are invisible to it - that is exactly how
   * .calendar-slot-booked held white text on a 3.12 fill, and it was found only
   * by following .calendar-slot-selected, which happened to declare both, to
   * the sibling states that had to match it. And it does not resolve `var()`,
   * so a token-valued fill is checked by the browser test instead.
   *
   * It deliberately does NOT flag a hex background with no text colour. That
   * shape is what the badges had, but it is also what every page background and
   * every hover-fill-only rule has, and there are dozens of them - the first
   * version of this check produced twenty-odd false positives, which is a check
   * that gets deleted rather than one that gets fixed. The badges are pinned by
   * being declared as pairs now; the general case is caught where it is
   * measurable.
   */
  const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i;

  const toRgb = (hex: string): [number, number, number] => {
    const raw = hex.replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  };

  const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
    const channel = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [relativeLuminance(toRgb(a)), relativeLuminance(toRgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const declaration = (block: string, property: RegExp): string | null => {
    const match = block.match(property);
    return match ? match[0] : null;
  };

  /* Components carry CSS in template literals, which is where the badges lived.
     Walk for them rather than listing them: a hand-maintained list of files to
     check is a list somebody forgets to add the next one to, and the next one
     is precisely the case this exists to catch. */
  const SRC_DIR = join(STYLES_DIR, '..');

  const collectComponentStyles = (dir: string, found: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        collectComponentStyles(path, found);
      } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
        const contents = readFileSync(path, 'utf8');
        if (/background(-color)?\s*:\s*#[0-9a-fA-F]{3,6}/.test(contents)) found.push(path);
      }
    }
    return found;
  };

  const componentStyleFiles = collectComponentStyles(SRC_DIR);

  const sourcesToScan = [
    ...cssFiles.map((name) => ({ label: name, css: readFileSync(join(STYLES_DIR, name), 'utf8') })),
    ...componentStyleFiles.map((path) => ({
      label: path.slice(path.indexOf('src/')),
      css: readFileSync(path, 'utf8'),
    })),
  ];

  it.each(sourcesToScan.map((s) => [s.label, s.css]))(
    '%s pairs every hardcoded fill with a text colour that passes AA',
    (_label, css) => {
      const failures: string[] = [];
      for (const { selector, body } of ruleBlocks(css as string)) {
        const bg = declaration(body, /background(?:-color)?\s*:\s*#[0-9a-fA-F]{3,6}/);
        if (!bg) continue;
        const bgHex = bg.match(HEX)?.[0];
        if (!bgHex) continue;

        const fg = declaration(body, /(?:^|[;{\s])color\s*:\s*#[0-9a-fA-F]{3,6}/);
        const fgHex = fg?.match(HEX)?.[0];
        if (!fgHex) continue;

        const ratio = contrast(bgHex, fgHex);
        if (ratio < 4.5) {
          failures.push(`${selector} pairs ${fgHex} on ${bgHex} at ${ratio.toFixed(2)}, below 4.5`);
        }
      }
      expect(failures, failures.join('\n  ')).toEqual([]);
    }
  );

  it('the hex check can actually fail', () => {
    /* The measurement above is only worth having if it rejects something. This
       pins the arithmetic against the exact pair that started this: Bootstrap
       blue under white, which reads as obviously fine and is not. */
    expect(contrast('#007bff', '#ffffff')).toBeLessThan(4.5);
    expect(contrast('#E0F2FE', '#075985')).toBeGreaterThanOrEqual(4.5);
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
