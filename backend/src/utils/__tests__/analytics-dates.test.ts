import {
  ANALYTICS_TIME_ZONE,
  toAnalyticsDateString,
  weekOverWeekChange,
} from '../analytics-dates';

/**
 * Two defects, both reproduced here before they were fixed.
 *
 * A DAY EARLY. The analytics endpoint reported `clicks_by_day: ["2026-08-15"]`
 * and `peak_day: 2026-08-15` for two clicks whose own `first_click` it reported
 * as 16 August - the same response contradicting itself. `SELECT DATE(...)`
 * gives Postgres the right calendar day; node-postgres then hands JS a Date at
 * LOCAL midnight, and `toISOString().split('T')[0]` reads that back in UTC. In
 * any positive offset that is the previous day, so every bucket, every chart
 * axis and the peak-day card shifted by one for every deployment.
 *
 * A PERCENTAGE FROM NOTHING. Week-over-week was `prev > 0 ? real : (now > 0 ?
 * 100 : 0)`, so a study's first week of traffic always reported "+100%" in
 * green with an up arrow, and two clicks claimed exactly what two thousand
 * would. There is no percentage change from zero; the honest answer is that
 * there is no answer, and the card should say so.
 */

describe('toAnalyticsDateString', () => {
  it('passes a calendar day straight through when Postgres already returned text', () => {
    expect(toAnalyticsDateString('2026-08-16')).toBe('2026-08-16');
    expect(toAnalyticsDateString('2026-08-16T00:00:00.000Z')).toBe('2026-08-16');
  });

  it('reads a Date at local midnight as the day it represents, not the day before', () => {
    // Exactly what node-postgres produces for a `date` column in BST, and
    // exactly what `toISOString().split('T')[0]` used to turn into 2026-08-15.
    const localMidnight = new Date(2026, 7, 16, 0, 0, 0);
    expect(toAnalyticsDateString(localMidnight)).toBe('2026-08-16');
  });

  it('holds for a date whose UTC instant is already the previous day', () => {
    // 2026-08-16T23:30Z is the 17th in London: the bucket belongs to the day
    // the organisation was living in, which is the whole point of pinning one.
    expect(toAnalyticsDateString(new Date('2026-08-16T23:30:00.000Z'))).toBe('2026-08-17');
  });

  it('reports the day in the analytics zone rather than in UTC', () => {
    // 00:30 UTC on the 17th is still the 16th in New York, so the two zones
    // genuinely disagree and the result must follow the configured one.
    expect(toAnalyticsDateString(new Date('2026-08-17T00:30:00.000Z'), 'America/New_York')).toBe(
      '2026-08-16'
    );
    expect(toAnalyticsDateString(new Date('2026-08-17T00:30:00.000Z'), 'Europe/London')).toBe(
      '2026-08-17'
    );
  });

  it('returns null for a value it cannot read, rather than a wrong day', () => {
    expect(toAnalyticsDateString(null)).toBeNull();
    expect(toAnalyticsDateString(undefined)).toBeNull();
    expect(toAnalyticsDateString('not a date')).toBeNull();
    expect(toAnalyticsDateString(new Date('nonsense'))).toBeNull();
  });

  it('defaults to one fixed organisation zone, so a chart is the same artefact for everyone', () => {
    expect(ANALYTICS_TIME_ZONE).toBe('Europe/London');
  });
});

describe('weekOverWeekChange', () => {
  it('computes a real change when there is a previous week to compare against', () => {
    expect(weekOverWeekChange(6, 4)).toBe(50);
    expect(weekOverWeekChange(2, 4)).toBe(-50);
    expect(weekOverWeekChange(4, 4)).toBe(0);
  });

  it('has no answer when the previous week was zero, and says so', () => {
    // Not 100. Not any number: the denominator is zero, and the old code's
    // "+100%" was the same claim for two clicks as for two thousand.
    expect(weekOverWeekChange(2, 0)).toBeNull();
    expect(weekOverWeekChange(2000, 0)).toBeNull();
  });

  it('has no answer when neither week had anything either', () => {
    // The old code returned 0 here, which reads as "flat" - a measurement -
    // when nothing has ever been measured.
    expect(weekOverWeekChange(0, 0)).toBeNull();
  });

  it('rounds to a whole percent', () => {
    expect(weekOverWeekChange(1, 3)).toBe(-67);
  });
});
