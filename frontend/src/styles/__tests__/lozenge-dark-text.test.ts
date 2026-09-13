import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Dark-mode lozenge text (fix-first row 23).
 *
 * All six `--lozenge-<type>-text` tokens were `#FFFFFF` at `:root` (dark),
 * against backgrounds that are each a distinct hue at 20% opacity over the
 * dark app ground (#0A091A) - so every lozenge type read as the same flat
 * white instead of carrying its own identity, unlike the light theme, which
 * already gives each type a distinct, bolder text color.
 *
 * The fix reuses each type's own bg hue as its solid text color (the same
 * value already used at 20% opacity for the fill), which already clears AA
 * against the composited dark background with no further tuning.
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
const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const DARK_APP_BG: [number, number, number] = [10, 9, 26]; // #0A091A

const parseRgba = (value: string): { rgb: [number, number, number]; alpha: number } => {
  const m = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\)/);
  if (!m) throw new Error(`not an rgba() value: ${value}`);
  return {
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
    alpha: m[4] !== undefined ? Number(m[4]) : 1,
  };
};

const composite = (fg: [number, number, number], alpha: number, bg: [number, number, number]): [number, number, number] =>
  bg.map((c, i) => c * (1 - alpha) + fg[i] * alpha) as [number, number, number];

// The six pinned expected literals: each type's own bg hue, at full opacity.
// A revert to #FFFFFF (or to a different, undifferentiated value) fails here
// by name, independent of the contrast math below.
const EXPECTED_DARK_TEXT: Record<string, string> = {
  usertest: '#4DD0E1',
  unmoderated: '#CE93D8',
  survey: '#69F0AE',
  poll: '#FFAB91',
  interview: '#F48FB1',
  question: '#FFE082',
};

describe('dark-mode lozenge text carries each type\'s own identity (row 23)', () => {
  const tokens = read('_tokens.css');
  const rootTokens = blockFor(tokens, ':root');

  it('the six dark text values match the pinned per-type literals', () => {
    for (const [type, expected] of Object.entries(EXPECTED_DARK_TEXT)) {
      const actual = valueOf(rootTokens, `--lozenge-${type}-text`);
      expect(actual?.toUpperCase(), `--lozenge-${type}-text`).toBe(expected);
    }
  });

  it('none of the six dark text values is #FFFFFF', () => {
    for (const type of Object.keys(EXPECTED_DARK_TEXT)) {
      const actual = valueOf(rootTokens, `--lozenge-${type}-text`);
      expect(actual?.toUpperCase(), `--lozenge-${type}-text must not be flat white`).not.toBe('#FFFFFF');
    }
  });

  it('all six dark text values are distinct from each other', () => {
    const values = Object.keys(EXPECTED_DARK_TEXT).map(
      (type) => valueOf(rootTokens, `--lozenge-${type}-text`)?.toUpperCase()
    );
    expect(new Set(values).size).toBe(values.length);
  });

  it('each dark text value clears AA (>= 4.5) against its own composited dark background', () => {
    for (const type of Object.keys(EXPECTED_DARK_TEXT)) {
      const textHex = valueOf(rootTokens, `--lozenge-${type}-text`)!;
      const bgValue = valueOf(rootTokens, `--lozenge-${type}-bg`)!;
      const { rgb: bgRgb, alpha } = parseRgba(bgValue);
      const composited = composite(bgRgb, alpha, DARK_APP_BG);
      const ratio = contrast(toRgb(textHex), composited);
      expect(ratio, `${type}: ${textHex} on composited bg ${composited.map(Math.round)} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
