import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * "Then" bundle, row 5 group (second-pass review, BK-5). Join and Cancel sat
 * side by side on the left of `.booking-actions` with no separation - a
 * primary action (Join via Google Meet) and a destructive one (Cancel)
 * touching, with nothing telling them apart but colour. Pushing Cancel to the
 * far end of the flex row is the fix, but ONLY when there is something to be
 * separated from: `.booking-actions .btn-booking-cancel { margin-left: auto }`
 * unconditionally also strands a LONE Cancel (a booking with no meeting
 * link, `MyBookings.tsx` renders Join conditionally) at the far right, out
 * of line with the note beneath it and every card that does have a Join
 * link - a general descendant selector cannot tell the two cases apart, so
 * the fix has to key off Join actually being present as a preceding sibling.
 */

const CSS_PATH = join(__dirname, '..', '_components.css');
const css = readFileSync(CSS_PATH, 'utf8');

describe('booking card Cancel sits apart from Join, but only when Join exists (BK-5)', () => {
  it('pins margin-left: auto on .btn-booking-cancel ONLY as a sibling of .btn-booking-join', () => {
    expect(css).toMatch(/\.btn-booking-join\s*~\s*\.btn-booking-cancel\s*\{[^}]*margin-left:\s*auto;/);
  });

  it('does not pin the unconditional (Join-agnostic) form, which strands a lone Cancel', () => {
    expect(css).not.toMatch(/\.booking-actions\s+\.btn-booking-cancel\s*\{[^}]*margin-left:\s*auto;/);
  });
});
