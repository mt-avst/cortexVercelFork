import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The header's inline toolbar and its collapsed menu are switched purely by a
 * CSS breakpoint (Header.tsx has no matchMedia). #165 put My bookings in every
 * signed-in bar, so every signed-in toolbar carries four labelled controls,
 * and between 768 and 991px they ran into the logo (measured: 0px gap at 768).
 * The collapse moved from 768px to 992px. This pins that breakpoint as a
 * literal, so a change to it fails here by name rather than silently letting
 * the toolbar crowd the logo again. jsdom applies no CSS, so layout itself is
 * checked in the browser; this pins the source.
 */

const css = readFileSync(join(__dirname, '..', '_components.css'), 'utf8');

/** The max-width of the @media block whose body hides `.header-actions--desktop`. */
function collapseBreakpoint(): string | null {
  const re = /@media\s*\(max-width:\s*([\d.]+px)\)\s*\{\s*\.header-actions--desktop\s*\{\s*display:\s*none;/g;
  const found = [...css.matchAll(re)].map((m) => m[1]);
  return found.length === 1 ? found[0] : found.length === 0 ? null : `ambiguous: ${found.join(', ')}`;
}

describe('header collapse breakpoint (#165)', () => {
  it('hides the inline toolbar below 992px, and only there', () => {
    expect(collapseBreakpoint()).toBe('991.98px');
  });

  it('shows the collapsed menu across the same range', () => {
    const block = css.match(/@media\s*\(max-width:\s*991\.98px\)\s*\{\s*\.header-actions--desktop\s*\{[^}]*\}\s*\.header-actions--mobile\s*\{\s*display:\s*flex;/);
    expect(block, 'the 991.98px block also shows .header-actions--mobile').not.toBeNull();
  });
});
