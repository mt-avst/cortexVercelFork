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
