import { describe, it, expect } from 'vitest';

import {
  formatStudyDate,
  formatStudyDateShort,
  formatClockTime,
  formatTimeRange,
  formatTimeZoneLabel,
  formatDateTime,
} from '../datetime';

// A fixed instant, expressed in a fixed zone, so these assert on formatting
// rather than on wherever the test happens to run.
const INSTANT = '2026-08-18T20:00:00.000Z';
const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

describe('formatStudyDate', () => {
  // The app carried THREE formats: 18/08/2026 on My Bookings, "Aug 17 - Aug 31"
  // on the browse index, and "Jul 25, 12:13 PM" on the same card as the first.
  // DD/MM is also read as MM/DD by half of Adaptavist, and a booking is exactly
  // the thing you cannot afford to misread.
  it('names the month, so no one has to guess whether 08 is August or the 8th', () => {
    expect(formatStudyDate(INSTANT, LONDON)).toBe('Tue 18 Aug 2026');
  });

  it('never emits an all-numeric date', () => {
    expect(formatStudyDate(INSTANT, LONDON)).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('resolves the date in the given zone, not in UTC', () => {
    // 20:00 UTC is still the 18th in London and the 18th in New York; 23:30 UTC
    // is the 19th in London and still the 18th in New York.
    expect(formatStudyDate('2026-08-18T23:30:00.000Z', LONDON)).toBe('Wed 19 Aug 2026');
    expect(formatStudyDate('2026-08-18T23:30:00.000Z', NEW_YORK)).toBe('Tue 18 Aug 2026');
  });

  it('returns null for a missing or unparseable value rather than "Invalid Date"', () => {
    expect(formatStudyDate(null, LONDON)).toBeNull();
    expect(formatStudyDate(undefined, LONDON)).toBeNull();
    expect(formatStudyDate('not-a-date', LONDON)).toBeNull();
  });
});

describe('formatStudyDateShort', () => {
  it('drops the year and weekday for compact meta rows', () => {
    expect(formatStudyDateShort(INSTANT, LONDON)).toBe('18 Aug');
  });

  it('still names the month', () => {
    expect(formatStudyDateShort(INSTANT, LONDON)).not.toMatch(/\d+\/\d+/);
  });
});

describe('formatClockTime', () => {
  // 24-hour, because "8:00" with no meridiem is a missed session and a 12-hour
  // clock was one of the three formats in play.
  it('uses a 24-hour clock', () => {
    expect(formatClockTime(INSTANT, LONDON)).toBe('21:00');
    expect(formatClockTime(INSTANT, NEW_YORK)).toBe('16:00');
  });

  it('never emits am/pm', () => {
    expect(formatClockTime(INSTANT, NEW_YORK).toLowerCase()).not.toMatch(/[ap]m/);
  });
});

describe('formatTimeRange', () => {
  it('joins start and end with an en dash', () => {
    expect(formatTimeRange(INSTANT, '2026-08-18T20:45:00.000Z', LONDON)).toBe('21:00 – 21:45');
  });

  it('falls back to the start alone when the end is missing', () => {
    expect(formatTimeRange(INSTANT, null, LONDON)).toBe('21:00');
  });

  it('returns null when there is no start', () => {
    expect(formatTimeRange(null, INSTANT, LONDON)).toBeNull();
  });
});

describe('formatTimeZoneLabel', () => {
  // The page showed "21:00 - 21:45" and never said whose 21:00. Adaptavist is
  // spread across the UK and the US, and there is already a feedback item from
  // a participant who booked an hour out.
  // An offset, not an abbreviation. "BST" means nothing in Boston and "EDT"
  // means nothing in Bristol, and `timeZoneName: 'short'` hands out whichever
  // the READER's locale happens to know - so the same session would be labelled
  // two different ways for two colleagues looking at the same slot.
  it('names the zone as an offset, which reads the same everywhere', () => {
    expect(formatTimeZoneLabel(INSTANT, LONDON)).toBe('GMT+1');
    expect(formatTimeZoneLabel(INSTANT, NEW_YORK)).toBe('GMT-4');
  });

  it('handles a half-hour offset', () => {
    expect(formatTimeZoneLabel(INSTANT, 'Asia/Kolkata')).toBe('GMT+5:30');
  });

  it('tracks daylight saving rather than assuming a fixed offset', () => {
    expect(formatTimeZoneLabel('2026-01-15T12:00:00.000Z', LONDON)).toBe('GMT+0');
    expect(formatTimeZoneLabel('2026-01-15T12:00:00.000Z', NEW_YORK)).toBe('GMT-5');
  });

  it('never emits a locale-specific abbreviation', () => {
    for (const zone of [LONDON, NEW_YORK, 'Asia/Kolkata']) {
      expect(formatTimeZoneLabel(INSTANT, zone)).toMatch(/^GMT[+-]/);
    }
  });
});

describe('formatDateTime', () => {
  it('carries the date, the time and the zone in one string', () => {
    expect(formatDateTime(INSTANT, LONDON)).toBe('Tue 18 Aug 2026, 21:00 GMT+1');
  });

  it('returns null rather than a half-built string when the value is unusable', () => {
    expect(formatDateTime('nonsense', LONDON)).toBeNull();
  });
});
