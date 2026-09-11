/**
 * One way to write a date, and one way to write a time, for the whole app.
 *
 * Before this there were 36 formatting call sites across the frontend, split
 * between `en-US`, `en-GB` and the browser default. The visible result was
 * three formats in one product and TWO on a single booking card: the session
 * as `27/07/2026` and its cancellation as `Jul 25, 12:13 PM`.
 *
 * Two decisions are load-bearing:
 *
 * 1. **The month is always named.** `08/07` is the 8th of July to most of
 *    Adaptavist and the 7th of August to the rest, and a booking is precisely
 *    the thing nobody can afford to misread.
 * 2. **The time zone is always available.** Times were rendered with no zone at
 *    all for a company spread across the UK and the US, and there is a
 *    participant complaint on file that says "I booked an hour out".
 *
 * Every function takes an optional `timeZone` so tests can pin one; left out,
 * they format in the reader's own zone, which is the behaviour that matters.
 * Every function returns `null` rather than "Invalid Date" for an unusable
 * input, so a bad value renders as nothing instead of as a word.
 */

const toDate = (value: string | Date | null | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date;
};

/** `Tue 18 Aug 2026` */
export const formatStudyDate = (
  value: string | Date | null | undefined,
  timeZone?: string
): string | null => {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  })
    .format(date)
    // en-GB gives "Tue, 18 Aug 2026"; the comma adds nothing at this length.
    .replace(',', '');
};

/** `18 Aug` - for meta rows where the year is noise. */
export const formatStudyDateShort = (
  value: string | Date | null | undefined,
  timeZone?: string
): string | null => {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(date);
};

/** `21:00` - 24-hour, because a meridiem-less 12-hour time is a missed session. */
export const formatClockTime = (
  value: string | Date | null | undefined,
  timeZone?: string
): string | null => {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(date);
};

/** `21:00 – 21:45`, or just the start when there is no end. */
export const formatTimeRange = (
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
  timeZone?: string
): string | null => {
  const from = formatClockTime(start, timeZone);
  if (!from) return null;
  const to = formatClockTime(end, timeZone);
  return to ? `${from} – ${to}` : from;
};

/**
 * `GMT+1`, `GMT-4`, `GMT+5:30` - the zone at that instant, so it follows
 * daylight saving rather than assuming a fixed offset.
 *
 * An OFFSET, not an abbreviation. `timeZoneName: 'short'` gives "BST" to a
 * British reader and "GMT-4" to an American one from the same call, because
 * abbreviations are locale knowledge: "EDT" means nothing in Bristol and "BST"
 * means nothing in Boston. An offset is read the same way by everyone, which is
 * the whole requirement for a company spread across both.
 */
export const formatTimeZoneLabel = (
  value: string | Date | null | undefined,
  timeZone?: string
): string | null => {
  const date = toDate(value);
  if (!date) return null;
  const part = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? null;
};

/** `Tue 18 Aug 2026, 21:00 BST` */
export const formatDateTime = (
  value: string | Date | null | undefined,
  timeZone?: string
): string | null => {
  const date = formatStudyDate(value, timeZone);
  const time = formatClockTime(value, timeZone);
  if (!date || !time) return null;
  const zone = formatTimeZoneLabel(value, timeZone);
  return zone ? `${date}, ${time} ${zone}` : `${date}, ${time}`;
};

/** The reader's own zone, for labelling a column of times once rather than per row. */
export const readerTimeZoneLabel = (at: string | Date = new Date()): string | null =>
  formatTimeZoneLabel(at);

/**
 * One offset label for a set of instants, but ONLY if they all share it.
 *
 * For a surface that draws many times under a SINGLE zone caption (the booking
 * grid) rather than labelling each row. Returns the shared offset (e.g. `GMT+1`)
 * when every readable instant lands on the same offset in `timeZone`, and `null`
 * when they do not - which happens when the range straddles a daylight-saving
 * transition. A caption must then name no offset rather than a wrong one: the
 * grid draws each row in its own true offset, so a single "GMT-4" printed over a
 * row that is really GMT-5 is the "booked an hour out" error wearing a label.
 * `null` also covers the empty / all-unreadable case, where there is nothing to
 * name. `timeZone` defaults to the reader's own zone.
 */
export const sharedZoneOffset = (
  instants: ReadonlyArray<string | Date | null | undefined>,
  timeZone?: string
): string | null => {
  const offsets = new Set(
    instants
      .map((instant) => formatTimeZoneLabel(instant, timeZone))
      .filter((label): label is string => label !== null)
  );
  return offsets.size === 1 ? [...offsets][0] : null;
};
