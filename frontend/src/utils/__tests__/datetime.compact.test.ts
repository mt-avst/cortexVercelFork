import { describe, it, expect } from 'vitest';

import { formatStudyDateCompact } from '../datetime';

/**
 * `formatStudyDateCompact` - the Admin Research Studies table's date (Mav 3.5,
 * Admin table Step 2): "Thu 24 Sept" in the current year, the year added
 * otherwise. `now` is always passed in, never read from the wall clock, and
 * the zone is fixed, so these assert formatting rather than where or when the
 * suite runs.
 */

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

// Thursday 24 September 2026, midday in London.
const THU_24_SEPT_2026 = '2026-09-24T11:00:00.000Z';

describe('formatStudyDateCompact', () => {
  it('drops the year for a date in the same year as now: "Thu 24 Sept"', () => {
    const now = new Date('2026-01-10T09:00:00.000Z');
    expect(formatStudyDateCompact(THU_24_SEPT_2026, now, LONDON)).toBe('Thu 24 Sept');
  });

  it('adds the year for a date in another year: "Thu 24 Sept 2026" seen from 2027', () => {
    const now = new Date('2027-03-01T09:00:00.000Z');
    expect(formatStudyDateCompact(THU_24_SEPT_2026, now, LONDON)).toBe('Thu 24 Sept 2026');
  });

  it('adds the year for a later year too: "Thu 23 Sept 2027" seen from 2026', () => {
    const now = new Date('2026-06-01T09:00:00.000Z');
    expect(formatStudyDateCompact('2027-09-23T11:00:00.000Z', now, LONDON)).toBe('Thu 23 Sept 2027');
  });

  it('has no comma, which Intl puts after the weekday once a year is present', () => {
    const now = new Date('2027-03-01T09:00:00.000Z');
    expect(formatStudyDateCompact(THU_24_SEPT_2026, now, LONDON)).not.toContain(',');
  });

  it('accepts a Date as well as a string', () => {
    const now = new Date('2026-01-10T09:00:00.000Z');
    expect(formatStudyDateCompact(new Date(THU_24_SEPT_2026), now, LONDON)).toBe('Thu 24 Sept');
  });

  it('compares the year in the zone the date is shown in, not in UTC', () => {
    // 02:00 UTC on 1 Jan 2027 is still 21:00 on Thu 31 Dec 2026 in New York,
    // so seen from mid-2026 it is this year there - on a UTC reading it would
    // be "Fri 1 Jan 2027".
    const now = new Date('2026-06-01T12:00:00.000Z');
    expect(formatStudyDateCompact('2027-01-01T02:00:00.000Z', now, NEW_YORK)).toBe('Thu 31 Dec');
    // Control: the same instant in London is the new year, so it shows one.
    expect(formatStudyDateCompact('2027-01-01T02:00:00.000Z', now, LONDON)).toBe('Fri 1 Jan 2027');
  });

  it('returns null for a missing or unparseable value rather than "Invalid Date"', () => {
    const now = new Date('2026-01-10T09:00:00.000Z');
    expect(formatStudyDateCompact(null, now, LONDON)).toBeNull();
    expect(formatStudyDateCompact(undefined, now, LONDON)).toBeNull();
    expect(formatStudyDateCompact('not a date', now, LONDON)).toBeNull();
  });
});
