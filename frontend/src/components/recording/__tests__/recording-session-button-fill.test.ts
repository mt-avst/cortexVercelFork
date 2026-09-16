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

/**
 * Base primary button fill - the rule the FLOATING PANEL actually gets.
 *
 * PipStandbyCard and StudyRunner's in-pane task card are portalled into the
 * Document PiP window's own document, OUTSIDE `.journey-frame`, so the orange
 * `.journey-frame .button` fill never reaches them - only this base rule does.
 * It filled with `var(--ink)` (the light surface foreground, ~#f0f0f0) under
 * white text, so the pane's "Open the task page" / "Start recording" CTAs
 * rendered white-on-near-white: present and clickable, but invisible. The
 * journey-frame test above cannot see this - it reads a different selector -
 * which is exactly how the pane regressed while that test stayed green.
 */
describe('recording base primary button fill (PiP panel)', () => {
  it('fills with --accent-fill-text-safe, never the invisible var(--ink)', () => {
    const block = blockFor('.fh-recording .button');
    expect(block).toMatch(/background:\s*var\(--accent-fill-text-safe\);/);
    expect(block).not.toMatch(/background:\s*var\(--ink\);/);
  });

  it('keeps white text on the fill', () => {
    const block = blockFor('.fh-recording .button');
    expect(block).toMatch(/color:\s*white;/);
  });
});
