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
 * ~2.60:1 - below AA 4.5 for the .62rem cell label - which the project's
 * accent-fill-policy records. Text on accent has to fill with
 * `--accent-fill-text-safe` (>= 5.18:1 under white in both themes) instead.
 *
 * A source assertion because jsdom has no contrast: this fails BY NAME if any
 * rule ever pairs white text with a raw brand-orange background again.
 */
describe('AdminSessionManager grid accent cells keep white text off raw brand-orange (D11 AA)', () => {
  it('has no D11 grid rule pairing white text with a brand-orange background', () => {
    // Scope to the D11 `<style>` block (the `.session-*` rules), not the
    // pre-existing chip-picker/momentum-table blocks, which have their own
    // guards and their own allow-listed accent usage.
    const blockStart = source.indexOf('.session-status-band');
    const blockEnd = source.indexOf('`}</style>', blockStart);
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const d11Block = source.slice(blockStart, blockEnd);

    // Rule bodies, split on the closing brace. A rule that sets a near-white
    // text colour AND a brand-orange (ramp step or #FF5A1F) background is the
    // sub-AA pairing this guards - accent cells must fill with
    // --accent-fill-text-safe instead.
    const offenders = d11Block
      .split('}')
      .map((rule) => rule.trim())
      .filter((rule) => {
        const whiteText = /color:\s*(#fff\b|#ffffff\b|white\b)/i.test(rule);
        const orangeBackground = /background:[^;]*(--brand-orange-\d|#ff5a1f)/i.test(rule);
        return whiteText && orangeBackground;
      });

    expect(offenders).toEqual([]);
  });
});
