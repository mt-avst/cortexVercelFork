/**
 * The day axis for the study-analytics charts.
 *
 * The backend buckets and LABELS clicks_by_day in one organisation zone
 * (`analytics.time_zone`, Europe/London by default) with
 * `to_char(clicked_at AT TIME ZONE zone, 'YYYY-MM-DD')`. Reconstructing the
 * axis here with `toISOString().split('T')[0]` cut the day in UTC instead,
 * which reads one day earlier in every positive offset - so the date a view
 * was counted under never matched a bar, and the chart read "No views
 * recorded" while its own header still said "Total: 3".
 *
 * This mirrors backend/src/utils/analytics-dates.ts, whose header warns in as
 * many words never to cut these days in UTC. Kept pure and injectable (`now`)
 * so the zone arithmetic can be pinned by a test rather than the wall clock.
 */

export interface DailyClicks {
  date: string;
  count: number;
  views: number;
  actions: number;
}

export interface ChartDatum {
  label: string;
  value: number;
  views: number;
  actions: number;
}

/**
 * Every day in the last `period` days, zero-filled, keyed and labelled in the
 * analytics zone so each entry lines up with the backend's clicks_by_day dates.
 *
 * @param timeZone IANA zone the backend bucketed in; `undefined` falls back to
 *   the reader's own zone (the backend always sends one in practice).
 * @param now injectable clock, defaults to the current instant.
 */
export const buildAnalyticsChartData = (
  clicksByDay: DailyClicks[] | undefined | null,
  period: number,
  timeZone: string | undefined,
  now: Date = new Date()
): ChartDatum[] => {
  if (!clicksByDay || !Array.isArray(clicksByDay)) return [];

  const dayKey = (d: Date): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);

  const clicksMap = new Map(
    clicksByDay.map((d) => [d.date, { count: d.count, views: d.views || 0, actions: d.actions || 0 }])
  );

  // Anchor on today's date IN THE ANALYTICS ZONE, held at UTC midnight so the
  // day-by-day arithmetic stays clear of DST edges and reads back the same
  // calendar dates the backend keyed clicks_by_day with.
  const anchor = new Date(`${dayKey(now)}T00:00:00Z`);

  const data: ChartDatum[] = [];
  for (let i = period - 1; i >= 0; i--) {
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const label = date.toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
    });
    const dayData = clicksMap.get(dateStr) || { count: 0, views: 0, actions: 0 };
    data.push({ label, value: dayData.count, views: dayData.views, actions: dayData.actions });
  }

  return data;
};
