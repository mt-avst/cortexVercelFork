import { describe, it, expect } from '@jest/globals';
import { hasOpportunityClosed } from '../opportunityClosed';

/**
 * THE OPERATOR, PINNED AS A LITERAL (cto/AdaptaLabs#143).
 *
 * `<=`, not `<` - matching the mint gate's `has_closed` comparison
 * (cto/AdaptaLabs#129), deliberately against the hourly sweep's `<`. The
 * boundary of exact equality cannot be hit through the route under a real
 * clock (nothing can seed a row to equal `NOW()` at the instant the handler
 * reads it) - `now` is an explicit parameter here precisely so this exact
 * instant is reachable in a plain unit test rather than only in prose.
 */
describe('hasOpportunityClosed', () => {
  it('is closed at the exact instant end_date equals now (<=, not <)', () => {
    const instant = new Date('2026-01-01T00:00:00.000Z');
    expect(hasOpportunityClosed(instant, instant)).toBe(true);
  });

  it('is closed a millisecond after end_date', () => {
    const endDate = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T00:00:00.001Z');
    expect(hasOpportunityClosed(endDate, now)).toBe(true);
  });

  it('is not closed a millisecond before end_date', () => {
    const endDate = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2025-12-31T23:59:59.999Z');
    expect(hasOpportunityClosed(endDate, now)).toBe(false);
  });

  it('accepts a string end_date, as a pg row hands one back unparsed in some drivers', () => {
    expect(hasOpportunityClosed('2020-01-01T00:00:00.000Z', new Date('2026-01-01T00:00:00.000Z'))).toBe(
      true
    );
  });

  it('is never closed when end_date is null - no stated deadline', () => {
    expect(hasOpportunityClosed(null, new Date('2100-01-01T00:00:00.000Z'))).toBe(false);
  });
});
