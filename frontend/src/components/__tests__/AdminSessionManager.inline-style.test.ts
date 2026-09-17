import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

/**
 * Row 3 - the unconditional dark `<style>` block.
 *
 * `AdminSessionManager` carried a third inline `<style>` block (the two others,
 * the slot-picker and the momentum-table blocks, are theme-aware and stay) that
 * forced dark-theme values on every surface it could reach - REGARDLESS of the
 * active theme:
 *   - `.text-muted` pinned to `rgba(224, 224, 224, 0.7)` (near-white),
 *   - form controls painted with white ink `#E0E0E0` on a translucent dark fill,
 *   - a `#FF4E50` focus border,
 *   - `.card` given a translucent-white fill,
 * all with `!important`. On the light theme this rendered near-white text on a
 * light ground - the three ghost strings the author could not read.
 *
 * A source assertion because the failure is invisibility, not structure: a
 * jsdom render has no layout or contrast, and the RTL role queries pass on main.
 * The block's three signatures are pinned as literals so a partial deletion
 * cannot pass.
 */

const source = readFileSync(
  join(__dirname, '..', 'AdminSessionManager.tsx'),
  'utf8'
);

describe('AdminSessionManager has no unconditional dark-theme override (row 3)', () => {
  it('uses no `!important`, which the override block relied on to beat the theme', () => {
    expect(source).not.toContain('!important');
  });

  it('hard-codes neither the near-white muted colour nor the red focus border', () => {
    expect(source).not.toContain('rgba(224, 224, 224');
    expect(source).not.toContain('#FF4E50');
  });
});

/**
 * D11 - the time-axis grid's accent cells must stay AA.
 *
 * The default grid draws every selected and every booked slot as an accent
 * cell with white text. `var(--brand-orange-500)` (#FF5A1F) under white is only
 * 3.12:1 - below AA 4.5 for the .62rem cell label - which the project's
 * accent-fill-policy records; the semantic aliases resolve to the same sub-AA
 * ramp (`--brand-primary` = orange-600 ~3.78:1, `--brand-headline` = orange-500).
 * Text on accent has to fill with `--accent-fill-text-safe` (>= 5.18:1 under
 * white in both themes) instead.
 *
 * A source assertion because jsdom has no contrast. Deliberately broad so the
 * "inline style escapes a scoped guard" class cannot regress: it flags the
 * `background` shorthand AND `background-color`, the raw ramp AND the semantic
 * aliases, and a near-white text colour (not only `#fff`). Scoped to the
 * `.session-*` block, so the pre-existing chip-picker/momentum CSS - which has
 * its own guards and allow-listed accent usage - is left alone.
 */
describe('AdminSessionManager grid accent cells keep white text off raw brand-orange (D11 AA)', () => {
  it('has no D11 grid rule pairing near-white text with a sub-AA orange background', () => {
    const blockStart = source.indexOf('.session-status-band');
    const blockEnd = source.indexOf('`}</style>', blockStart);
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const d11Block = source.slice(blockStart, blockEnd);

    // A near-white text colour: white/#fff/#ffffff, or a hex or rgb that reads
    // as near-white (starts with f, or an rgb with high channels) - anything
    // that would fail against a sub-AA orange fill.
    const nearWhiteText =
      /color:\s*(#fff\b|#ffffff\b|white\b|#f[0-9a-f]{2}\b|#f[0-9a-f]{5}\b|rgba?\(\s*2[45][0-9])/i;
    // A sub-AA orange FILL, via the shorthand or background-color, and via the
    // raw ramp (--brand-orange-N / #ff5a1f) or the semantic aliases that resolve
    // to it (--brand-primary, --brand-headline). --accent-fill-text-safe is the
    // AA-safe fill and is deliberately NOT matched, so it keeps passing.
    const subAaOrangeFill =
      /background(?:-color)?:[^;]*(--brand-orange-\d|--brand-primary\b|--brand-headline\b|#ff5a1f)/i;

    const offenders = d11Block
      .split('}')
      .map((rule) => rule.trim())
      .filter((rule) => nearWhiteText.test(rule) && subAaOrangeFill.test(rule));

    expect(offenders).toEqual([]);
  });
});
