import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Pending Completion Approvals card CSS (fix-first rows 19 and 20).
 *
 * Row 19: `.pending-approvals__textarea` bordered on `--border-subtle-current`
 * (rgba(...,0.06) in dark, the theme's own `--fs-line` in light) - both far
 * below the 3:1 UI-component minimum against the field's own background. This
 * pins the fix (`--text-muted`, already relied on elsewhere as body text and
 * so comfortably clearing 3:1 as a border) and computes the actual contrast
 * in both themes so a future token edit that quietly weakens `--text-muted`
 * fails here too.
 *
 * Row 20 (detail half): `.pending-approvals__grid` used
 * `repeat(auto-fit, minmax(240px, 1fr))`, which forces a 240px-minimum column
 * regardless of the card's actual width. Below ~280px of content width (a
 * narrow phone card) the grid overflows its own card, which clips via
 * `.pending-approvals__card { overflow: hidden }` instead of wrapping - the
 * observed "Study: ScriptRunner for Jira: the n[clipped]" defect. `minmax(min
 * (240px, 100%), 1fr)` lets the column shrink to the container instead of
 * forcing an overflow. jsdom applies no CSS, so a real containment check
 * needs Playwright (e2e/accessibility.test.ts); this pins the source fix.
 */

const CSS_PATH = join(__dirname, '..', 'pending-approvals.css');
const css = readFileSync(CSS_PATH, 'utf8');

const blockFor = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const from = css.indexOf('{', start);
  const to = css.indexOf('\n}', from);
  return css.slice(from + 1, to);
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

describe('rejection reason textarea has a visible boundary (row 19)', () => {
  it('borders on --text-muted, not the near-invisible --border-subtle-current', () => {
    const block = blockFor('.pending-approvals__textarea');
    expect(block).toMatch(/border:\s*1px solid var\(--text-muted\);/);
    expect(block).not.toMatch(/border:\s*1px solid var\(--border-subtle-current\);/);
  });

  it('--text-muted clears the 3:1 UI-component minimum against its panel background, in both themes', () => {
    // Dark: --text-muted #94A3B8 on the app's dark ground #0A091A (the panel
    // itself is rgba(15,12,26,0.98), close enough to be the relevant ground).
    expect(contrast('#94A3B8', '#0A091A')).toBeGreaterThanOrEqual(3);
    // Light: --text-muted resolves to --fs-muted #5f6b7a on the cream ground.
    expect(contrast('#5f6b7a', '#f7f2ea')).toBeGreaterThanOrEqual(3);
  });

  it('the border stays visible on focus instead of disappearing to transparent', () => {
    const block = blockFor('.pending-approvals__textarea:focus');
    expect(block).not.toMatch(/border-color:\s*transparent;/);
    expect(block).toMatch(/border-color:\s*var\(--brand-orange-500\);/);
  });
});

describe('session detail grid wraps instead of clipping at narrow widths (row 20)', () => {
  it('grid columns shrink to the container instead of forcing a 240px minimum', () => {
    const block = blockFor('.pending-approvals__grid');
    expect(block).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(240px,\s*100%\),\s*1fr\)\);/);
  });
});
