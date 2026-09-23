import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The dark page ground under Browse studies and every `.admin-page-bg` page
 * (Admin, My bookings, AdaptaBits, the study form): a near-black body with a
 * warm bloom at the top and a faint 24px orange grid, painted on the body
 * since the Admin table Step 1 fix (search "painted on the BODY" in
 * `_themes.css`).
 *
 * The e2e contrast measurement for text on that ground assumes a premise: the
 * lightest colour the gradient can put behind text is the 12% orange bloom
 * stop over #030305. That premise lives in these literals, so they are pinned
 * here AS LITERALS - a test that read them back from the stylesheet and
 * compared the stylesheet with itself could not see one change. Change a stop
 * and this fails by name; re-measure the contrast before updating it.
 */

const THEMES = readFileSync(join(__dirname, '..', '_themes.css'), 'utf8');
const TOKENS = readFileSync(join(__dirname, '..', '_tokens.css'), 'utf8');

const GROUND_SELECTOR = 'body.theme-dark:has(.study-listing-page),\nbody.theme-dark:has(.admin-page-bg) {';

/** The ground rule's declaration block, or a thrown error: an empty string
 * would let every `toContain` below fail for the wrong reason. */
const groundRule = (): string => {
  const start = THEMES.indexOf(GROUND_SELECTOR);
  if (start === -1) throw new Error('dark ground rule not found in _themes.css');
  const end = THEMES.indexOf('\n}', start);
  return THEMES.slice(start + GROUND_SELECTOR.length, end);
};

/** Whitespace-insensitive: the gradient spans several lines. */
const squash = (css: string): string => css.replace(/\s+/g, ' ').trim();

describe('dark page ground (Admin table Step 1)', () => {
  it('is declared once, on the body, keyed to both page markers', () => {
    expect(THEMES.split(GROUND_SELECTOR).length - 1).toBe(1);
  });

  it('paints the near-black base #030305', () => {
    expect(groundRule()).toMatch(/\n\s*background-color:\s*#030305;/);
  });

  it('keeps the bloom stops at 12% / 4% of the brand orange, fading out by 66%', () => {
    expect(squash(groundRule())).toContain(
      squash(`radial-gradient(
        120% 74% at 50% -12%,
        color-mix(in srgb, var(--brand-orange-500) 12%, transparent) 0%,
        color-mix(in srgb, var(--brand-orange-500) 4%, transparent) 36%,
        transparent 66%
      )`)
    );
  });

  it('keeps both grid lines at 5% of the brand orange, 1px on a 24px pitch', () => {
    const rule = squash(groundRule());
    expect(rule).toContain(
      'linear-gradient(to right, color-mix(in srgb, var(--brand-orange-500) 5%, transparent) 1px, transparent 1px)'
    );
    expect(rule).toContain(
      'linear-gradient(to bottom, color-mix(in srgb, var(--brand-orange-500) 5%, transparent) 1px, transparent 1px)'
    );
    expect(rule).toContain('background-size: 100% 100vh, 24px 24px, 24px 24px;');
  });

  it('mixes those stops from the brand orange #FF5A1F', () => {
    // The stops are percentages OF this token, so the token is part of the
    // premise: a new orange moves every stop without touching the rule above.
    expect(TOKENS).toMatch(/--brand-orange-500:\s*#FF5A1F;/);
  });
});
