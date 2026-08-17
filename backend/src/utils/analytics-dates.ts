/**
 * Calendar arithmetic for the analytics endpoint.
 *
 * Analytics is a shared artefact - a number someone quotes in a review - so a
 * chart that reshapes itself depending on who opened it is worse than one that
 * is explicitly in a single zone. Buckets are therefore cut in ONE
 * organisation zone rather than in the viewer's, and the surface says which.
 *
 * Override with ANALYTICS_TIME_ZONE if the organisation's centre of gravity
 * moves. It must be an IANA name; anything Intl refuses falls back to the
 * default rather than throwing a request.
 */

const DEFAULT_ANALYTICS_TIME_ZONE = 'Europe/London';

const isUsableZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const configured = process.env.ANALYTICS_TIME_ZONE?.trim();

export const ANALYTICS_TIME_ZONE =
  configured && isUsableZone(configured) ? configured : DEFAULT_ANALYTICS_TIME_ZONE;

/** `YYYY-MM-DD` in the analytics zone, or null for anything unreadable. */
export const toAnalyticsDateString = (
  value: string | Date | null | undefined,
  timeZone: string = ANALYTICS_TIME_ZONE
): string | null => {
  if (value === null || value === undefined) return null;

  // Postgres returns a `date` as text once the query casts it, and text needs
  // no interpretation at all - reinterpreting it is precisely how it used to
  // lose a day.
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }

  if (isNaN(value.getTime())) return null;

  // NEVER toISOString().split('T')[0] here. node-postgres hands back a `date`
  // as local midnight, and reading local midnight in UTC is the previous day
  // in every positive offset - which is what shifted every chart axis, every
  // bucket and the peak-day card by one.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);

  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : null;
};

/**
 * Percentage change between two counts, or null when there is no answer.
 *
 * A zero previous week has no percentage change - not 100, not 0. The old code
 * returned 100 whenever the current week had anything at all, so every study
 * announced "+100%" in green from its very first click, and two clicks made
 * exactly the claim two thousand would have. Null lets the surface say "no
 * previous week to compare" instead of inventing a magnitude.
 */
export const weekOverWeekChange = (current: number, previous: number): number | null => {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
};
