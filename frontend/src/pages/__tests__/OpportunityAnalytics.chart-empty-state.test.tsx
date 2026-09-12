import { render, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityAnalytics from '../OpportunityAnalytics';
import { getOpportunityAnalytics, getOpportunity, getOpportunitySessionEvents } from '../../api/client';

// DA-22 (closing cto/AdaptaLabs#124): each period chart header now sums the
// PLOTTED series - the same zero-filled `period` calendar days the bars are
// drawn from - rather than the backend's period_*_total. The backend counts a
// rolling period*24h window spanning period+1 in-zone dates, so a click on the
// oldest boundary day was totalled into the header yet had no bar to sit in: a
// flat chart under a positive "Total: N". Summing the drawn days makes
// header == bars by construction, and the empty state is gated on that same
// sum, so header and body can no longer disagree in either direction.
//
// DA-20 had gated the empty TEXT on period_*_total so the false "No X recorded"
// could not sit under a positive total; the residual it left (a positive total
// over undrawn boundary-day clicks) is what this now closes.

// clicks_by_day is keyed by the same in-zone date arithmetic
// buildAnalyticsChartData uses to build the axis, so a row lands on (or misses)
// a bar deterministically regardless of when the suite runs.
const ZONE = 'Europe/London';
const anchorKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const anchor = new Date(`${anchorKey}T00:00:00Z`);
const dayAgo = (n: number): string => {
  const d = new Date(anchor);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
};

const base = {
  clicks_total: 0,
  clicks_24h: 0,
  clicks_7d: 0,
  unique_users: 0,
  avg_clicks_per_day: 0,
  week_over_week_change: null,
  views_total: 0,
  views_24h: 0,
  views_7d: 0,
  unique_viewers: 0,
  actions_total: 0,
  actions_24h: 0,
  actions_7d: 0,
  unique_actors: 0,
  conversion_rate: 0,
  first_click: '2026-08-16T11:30:49.172Z',
  last_click: '2026-08-16T11:58:59.827Z',
  opportunity_created: '2026-08-10T11:14:48.034Z',
  peak_day: null,
  peak_hour: null,
  clicks_by_day: [] as Array<{ date: string; count: number; views: number; actions: number }>,
  clicks_by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
  clicks_by_weekday: [] as Array<{ weekday: string; weekday_num: number; count: number }>,
  period: 30,
  // Deliberately larger than the in-window bars sum below: the header must NOT
  // read these any more.
  period_clicks_total: 99,
  period_views_total: 99,
  period_actions_total: 99,
  time_zone: ZONE,
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'a1', role: 'researcher_admin', name: 'A', email: 'a@example.com' },
    loading: false,
    initialAuthCheck: true,
  }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

vi.mock('../../api/client', () => ({
  getOpportunityAnalytics: vi.fn(),
  getOpportunity: vi.fn(),
  getOpportunitySessionEvents: vi.fn(),
  getOpportunitySurveyResults: vi.fn(),
  opportunitySurveyResultsCsvUrl: vi.fn(() => '/api/opportunities/opp-1/survey-results.csv'),
}));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/analytics']}>
      <Routes>
        <Route path="/admin/opportunities/:id/analytics" element={<OpportunityAnalytics />} />
      </Routes>
    </MemoryRouter>
  );

const load = (overrides: Record<string, unknown> = {}) => {
  vi.mocked(getOpportunityAnalytics).mockResolvedValue({ ...base, ...overrides } as never);
};

const TITLE = 'A study whose clicks land on known days';

// Interpolated sentences span several text nodes; waiting on the title
// guarantees the page has left its spinner before we read it.
const settled = async (container: HTMLElement): Promise<string> => {
  const loaded = () => container.textContent?.includes(TITLE);
  for (let i = 0; i < 150 && !loaded(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(container.textContent).toContain(TITLE);
  return container.textContent ?? '';
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(getOpportunitySessionEvents).mockResolvedValue([] as never);
  load();
  vi.mocked(getOpportunity).mockResolvedValue({
    id: 'opp-1',
    type: 'survey',
    title: TITLE,
    status: 'published',
    firsthand_study_id: null,
  } as never);
});

describe('a chart header sums the bars it draws, not the rolling backend total', () => {
  it('quotes the in-window bar sum and excludes an undrawn boundary day (#124)', async () => {
    // Two days of data inside the 30-day window plus one 45 days ago, which the
    // backend rolling total (period_*_total: 99) would count but the chart does
    // not draw. The header must read the in-window sum: 2 views, 1 action.
    load({
      clicks_by_day: [
        { date: dayAgo(2), count: 3, views: 2, actions: 1 },
        { date: dayAgo(5), count: 0, views: 0, actions: 0 },
        { date: dayAgo(45), count: 5, views: 5, actions: 0 },
      ],
    });
    const { container } = renderPage();
    const text = await settled(container);

    expect(text).toContain('Total: 2 (30d)'); // views inside the window
    expect(text).toContain('Total: 1 (30d)'); // actions inside the window
    // The rolling backend totals must not surface anywhere.
    expect(text).not.toContain('Total: 99');
    // Combined avg = 3 drawn clicks / 30 days.
    expect(text).toContain('Avg: 0.1/day');
    // The chart actually rendered rather than an empty node: BarChart titles
    // every bar "<label>: <n> clicks".
    expect(container.querySelector('[title$="clicks"]')).not.toBeNull();
    expect(text).not.toContain('No views recorded');
    expect(text).not.toContain('No actions recorded');
  });
});

describe('the snapshot tile and the chart header show ONE figure for a metric', () => {
  it('renders the Study Views bento tile equal to the chart header total', async () => {
    // A CONSISTENT backend response, the way the real endpoint now returns it:
    // the calendar-aligned tile total (views_total) equals the sum of the
    // in-window daily series the chart draws. period_views_total stays 99 (the
    // base fixture's trap), so a header that regressed to reading it would show
    // "Total: 99" and diverge from the tile.
    load({
      clicks_by_day: [
        { date: dayAgo(2), count: 3, views: 2, actions: 1 },
        { date: dayAgo(4), count: 1, views: 1, actions: 0 },
      ],
      views_total: 3,
      actions_total: 1,
      clicks_total: 4,
    });
    const { container } = renderPage();
    await settled(container);

    // The bento tile: the card whose title is exactly "Study Views" (the chart
    // card's title carries the "(30d)" suffix).
    const tileCard = Array.from(container.querySelectorAll('.cortex-analytics-card')).find(
      (card) => card.querySelector('.cortex-analytics-card-title')?.textContent === 'Study Views'
    );
    const tileValue = tileCard?.querySelector('.cortex-stat-value')?.textContent?.trim();

    // The chart header, derived independently from the drawn bars.
    const chartCard = Array.from(container.querySelectorAll('.cortex-analytics-card')).find((card) =>
      card.querySelector('.cortex-chart-title')?.textContent?.startsWith('Study Views')
    );
    const headerTotal = chartCard
      ?.querySelector('.cortex-chart-subtitle')
      ?.textContent?.match(/Total: (\d+)/)?.[1];

    // Two independent derivations (backend tile SQL vs frontend sum of the
    // series) must agree on one render, or the page shows two "Study Views"
    // numbers - the DA-20/#124 bug class in a new spot.
    expect(tileValue).toBe('3');
    expect(headerTotal).toBe(tileValue);
  });
});

describe('the empty state appears exactly when the drawn series is empty', () => {
  it('shows Total: 0 and the empty message when every click is outside the window', async () => {
    // A real, positive rolling total (99) but nothing drawable: the study has
    // no activity in the last 30 days, so "No X recorded" is now the truth.
    load({
      clicks_by_day: [{ date: dayAgo(400), count: 18, views: 9, actions: 9 }],
    });
    const { container } = renderPage();
    const text = await settled(container);

    expect(text).toContain('Total: 0 (30d)');
    expect(text).toContain('No views recorded');
    expect(text).toContain('No actions recorded');
    expect(text).toContain('No interactions recorded in this period');
    // No bar rendered, because the truthy branch is not taken.
    expect(container.querySelector('[title$="clicks"]')).toBeNull();
  });

  it('shows every empty message when there is genuinely no data at all', async () => {
    load({ clicks_by_day: [] });
    const { container } = renderPage();
    const text = await settled(container);

    expect(text).toContain('No views recorded');
    expect(text).toContain('No actions recorded');
    expect(text).toContain('No interactions recorded in this period');
  });
});
