import { describe, it, expect } from 'vitest';

import { buildAnalyticsChartData } from '../analyticsChart';

// The bug DA-20 fixed: the axis was reconstructed in UTC while the backend
// bucketed clicks_by_day in the analytics zone, so a view counted just after
// local midnight fell on a date no bar looked up - the chart read empty while
// its header said "Total: 3". These pin that the axis is cut in the given zone.

describe('buildAnalyticsChartData - zone of the day axis', () => {
  // 23:30 UTC on the 15th is already 00:30 on the 16th in London (BST, +1):
  // the exact boundary the production default (Europe/London) hits every night.
  const now = new Date('2026-08-15T23:30:00Z');
  const clicksByDay = [{ date: '2026-08-16', count: 3, views: 3, actions: 0 }];

  it('places a click on the analytics-zone date it was counted under', () => {
    const data = buildAnalyticsChartData(clicksByDay, 7, 'Europe/London', now);
    const views = data.reduce((sum, d) => sum + d.views, 0);
    expect(views).toBe(3);
    // Today in London is the 16th, so it is the last (rightmost) bar.
    expect(data[data.length - 1].views).toBe(3);
    expect(data[data.length - 1].label).toBe('16 Aug');
  });

  // Control: the SAME data cut in UTC misses the click entirely (today in UTC
  // is still the 15th, so a 7-day window ends on the 15th and never reaches the
  // 16th). This is what the page used to do, and it proves the assertion above
  // can actually detect the zone - a revert to UTC keys turns 3 into 0 here.
  it('misses that same click when the axis is cut in UTC', () => {
    const data = buildAnalyticsChartData(clicksByDay, 7, 'UTC', now);
    const views = data.reduce((sum, d) => sum + d.views, 0);
    expect(views).toBe(0);
  });

  it('zero-fills exactly one entry per day in the period', () => {
    expect(buildAnalyticsChartData([], 7, 'Europe/London', now)).toHaveLength(7);
    expect(buildAnalyticsChartData([], 30, 'Europe/London', now)).toHaveLength(30);
  });

  it('returns nothing when there is no daily breakdown', () => {
    expect(buildAnalyticsChartData(undefined, 30, 'Europe/London', now)).toEqual([]);
    expect(buildAnalyticsChartData(null, 30, 'Europe/London', now)).toEqual([]);
  });
});
