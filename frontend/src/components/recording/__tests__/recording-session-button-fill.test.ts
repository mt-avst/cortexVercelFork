import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Recording primary button fill (fix-first row 4).
 *
 * `.fh-recording .journey-frame .button` filled with the LOCAL `--accent`
 * (#dd6e42, terracotta) under white text - a fill never checked against the
 * global AA-safe fill step. `--accent-fill-text-safe` (resolves to
 * `--brand-orange-800`, #B33F16) is already proven >= 4.5:1 under white in
 * both themes by the accent-fill loop in e2e/accessibility.test.ts, so
 * pointing the button at it (border keeps `--accent-strong`, unchanged) fixes
 * the fill without re-deriving the contrast math here.
 */

const CSS_PATH = join(__dirname, '..', 'recording-session.css');
const css = readFileSync(CSS_PATH, 'utf8');

const blockFor = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const from = css.indexOf('{', start);
  const to = css.indexOf('\n}', from);
  return css.slice(from + 1, to);
};

describe('recording journey-frame primary button fill (row 4)', () => {
  it('fills with --accent-fill-text-safe, not the raw --accent', () => {
    const block = blockFor('.fh-recording .journey-frame .button');
    expect(block).toMatch(/background:\s*var\(--accent-fill-text-safe\);/);
    expect(block).not.toMatch(/background:\s*var\(--accent\);/);
  });

  it('keeps the border on --accent-strong (unchanged)', () => {
    const block = blockFor('.fh-recording .journey-frame .button');
    expect(block).toMatch(/border:\s*1\.5px solid var\(--accent-strong\);/);
  });
});
