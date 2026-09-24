import React from 'react';
import { render, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityAnalytics from '../OpportunityAnalytics';
import {
  getOpportunityAnalytics,
  getOpportunity,
  getOpportunitySessionEvents,
} from '../../api/client';

// Three numbers on this page were not measurements.
//
//  - "Week change: +100%" appeared whenever the previous week was empty, which
//    is every study's first week. Two clicks made the same claim two thousand
//    would have, and it rendered in green with an up arrow beside a conversion
//    rate of 0%.
//  - "Total: 2 (7d)" sat in the header of a chart titled "(30d)". The title
//    followed the period selector; the total was pinned to seven days.
//  - Days and hours were cut in whatever zone the database session happened to
//    be in, and nothing said so.

const analytics = {
  clicks_total: 2,
  clicks_24h: 2,
  clicks_7d: 2,
  unique_users: 1,
  avg_clicks_per_day: 0.1,
  week_over_week_change: null,
  views_total: 2,
  views_24h: 2,
  views_7d: 2,
  unique_viewers: 1,
  actions_total: 0,
  actions_24h: 0,
  actions_7d: 0,
  unique_actors: 0,
  conversion_rate: 0,
  first_click: '2026-08-16T11:30:49.172Z',
  last_click: '2026-08-16T11:58:59.827Z',
  opportunity_created: '2026-08-10T11:14:48.034Z',
  peak_day: { date: '2026-08-16', count: 2, views: 2, actions: 0 },
  peak_hour: { hour: 12, hour_label: '12:00', count: 2 },
  clicks_by_day: [{ date: '2026-08-16', count: 2, views: 2, actions: 0 }],
  clicks_by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hour === 12 ? 2 : 0 })),
  clicks_by_weekday: [
    { weekday: 'Sunday', weekday_num: 0, count: 2 },
    { weekday: 'Monday', weekday_num: 1, count: 0 },
    { weekday: 'Tuesday', weekday_num: 2, count: 0 },
    { weekday: 'Wednesday', weekday_num: 3, count: 0 },
    { weekday: 'Thursday', weekday_num: 4, count: 0 },
    { weekday: 'Friday', weekday_num: 5, count: 0 },
    { weekday: 'Saturday', weekday_num: 6, count: 0 },
  ],
  period: 30,
  period_clicks_total: 2,
  period_views_total: 2,
  period_actions_total: 0,
  time_zone: 'Europe/London',
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'a1', role: 'researcher_admin', name: 'A', email: 'a@example.com' },
    loading: false,
    initialAuthCheck: true,
  }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

// Every export the page imports has to be here. A factory that omits one
// leaves that import `undefined`, and the page then fails for a reason no
// assertion in this file names.
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
  vi.mocked(getOpportunityAnalytics).mockResolvedValue({ ...analytics, ...overrides } as never);
};

beforeEach(() => {
  // Explicit, because without it a render from an earlier test stays mounted
  // and `screen` answers from it - which is how the first three assertions in
  // this file could pass while the page under test was still showing a spinner.
  cleanup();
  vi.clearAllMocks();
  // Every mock is re-established here. One of them used to be set once at
  // module scope, and the page hung on its spinner in every test after the
  // first - which read exactly like a component bug.
  vi.mocked(getOpportunitySessionEvents).mockResolvedValue([] as never);
  load();
  vi.mocked(getOpportunity).mockResolvedValue({
    id: 'opp-1',
    type: 'unmoderated',
    title: 'Triage a failing Bitbucket pipeline',
    status: 'published',
    firsthand_study_id: 'study_x',
  } as never);
});

describe('the way back (#169)', () => {
  it('names the researcher workspace Create & Manage on the loaded page', async () => {
    const { container } = renderPage();
    await settled(container);
    expect(within(container).getByRole('button', { name: /^Back to Create & Manage$/ })).toBeInTheDocument();
  });
});

describe('week-over-week with no previous week', () => {
  it('says there is nothing to compare against instead of inventing +100%', async () => {
    const { container } = renderPage();
    expect(await settled(container)).toMatch(/no previous week to compare/i);
  });

  it('shows no percentage at all when there is no answer', async () => {
    const { container } = renderPage();
    expect(await settled(container)).not.toMatch(/\+100%/);
  });

  it('still states a real change when there is a previous week', async () => {
    load({ week_over_week_change: -25 });
    const { container } = renderPage();

    const text = await settled(container);
    expect(text).toContain('-25%');
    expect(text).not.toMatch(/no previous week to compare/i);
  });
});

// Both of these read whole sentences whose values are interpolated, so they
// span several text nodes and no single-node matcher sees them. Waiting on the
// study title first guarantees the page has finished loading before the assert.
/**
 * Wait for the page to leave its spinner, reading the container THIS render
 * owns rather than the whole document.
 *
 * Polled rather than `findBy*`/`waitFor`: this page resolves two requests
 * before it renders anything, and RTL's async helpers returned here without the
 * DOM having advanced - `findByText` resolved against a body holding nothing
 * but "Loading...", which made four real assertions look like component bugs.
 * A plain poll is dull and it is correct.
 */
const settled = async (container: HTMLElement): Promise<string> => {
  const loaded = () => container.textContent?.includes('Triage a failing Bitbucket pipeline');
  for (let i = 0; i < 150 && !loaded(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(container.textContent).toContain('Triage a failing Bitbucket pipeline');
  return container.textContent ?? '';
};

describe('chart totals', () => {
  it('quotes the selected period, not a fixed seven days', async () => {
    // DA-22: the header sums the drawn `period` days, so the fixture puts nine
    // views on a day inside the 30-day window (keyed the way
    // buildAnalyticsChartData keys its axis, so the row lands on a bar whenever
    // the suite runs). The regression that mattered - a total pinned to seven
    // days beside a 30-day chart - would still read "Total: 2 (7d)".
    const zone = 'Europe/London';
    const anchorKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const anchor = new Date(`${anchorKey}T00:00:00Z`);
    const twoDaysAgo = new Date(anchor);
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
    const inWindow = twoDaysAgo.toISOString().split('T')[0];

    load({
      period: 30,
      period_views_total: 9,
      views_7d: 2,
      time_zone: zone,
      clicks_by_day: [{ date: inWindow, count: 9, views: 9, actions: 0 }],
    });
    const { container } = renderPage();

    const text = await settled(container);
    expect(text).toContain('Total: 9 (30d)');
    // The exact string the header used to carry beside a 30-day chart.
    expect(text).not.toContain('Total: 2 (7d)');
  });

  // NOT tested by clicking the period buttons: driving the selector in jsdom
  // re-enters the load effect and the run never terminates. The regression that
  // mattered is the hard-coded seven, and the assertion above catches it.
});

describe('what an "action" was', () => {
  it('describes a recorded study by what a participant actually did', async () => {
    const { container } = renderPage();
    const text = await settled(container);

    expect(text).toContain('Started the study');
    // The card said this for every type, including one with no link and
    // nothing to book.
    expect(text).not.toContain('Clicked link / Booked');
  });

  it('describes a bookable study by its own action', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-1',
      type: 'test',
      title: 'Triage a failing Bitbucket pipeline',
      status: 'published',
      firsthand_study_id: null,
    } as never);
    const { container } = renderPage();

    expect(await settled(container)).toContain('Booked a time');
  });
});

describe('the zone the buckets were cut in', () => {
  it('tells the reader, because it is not necessarily theirs', async () => {
    const { container } = renderPage();
    expect(await settled(container)).toMatch(/counted in Europe\/London time/i);
  });

  it('names the configured zone rather than hard-coding one in the page', async () => {
    load({ time_zone: 'America/New_York' });
    const { container } = renderPage();
    expect(await settled(container)).toMatch(/counted in America\/New York time/i);
  });
});
