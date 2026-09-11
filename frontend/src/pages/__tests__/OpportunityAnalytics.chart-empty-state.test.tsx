import { render, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityAnalytics from '../OpportunityAnalytics';
import { getOpportunityAnalytics, getOpportunity, getOpportunitySessionEvents } from '../../api/client';

// DA-20: the analytics page printed "Total: 3 (30d)" in a chart header and
// "No views recorded" in the body of the same chart, and "Unique: 0" beside a
// positive action count. The header total and the empty state read from two
// different places and disagreed. These pin that the empty state is now driven
// by the same period total the header prints, so the two cannot contradict -
// whatever the daily breakdown happens to line up with.

const base = {
  clicks_total: 3,
  clicks_24h: 0,
  clicks_7d: 0,
  unique_users: 0,
  avg_clicks_per_day: 0.1,
  week_over_week_change: null,
  views_total: 3,
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
  // Dated outside any recent window on purpose: the daily breakdown lines up
  // with nothing, which is exactly the state that used to force the empty
  // message under a non-zero header total.
  clicks_by_day: [{ date: '2020-01-01', count: 3, views: 3, actions: 0 }],
  clicks_by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
  clicks_by_weekday: [] as Array<{ weekday: string; weekday_num: number; count: number }>,
  period: 30,
  period_clicks_total: 3,
  period_views_total: 3,
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
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));

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

// Interpolated sentences span several text nodes; waiting on the title
// guarantees the page has left its spinner before we read it.
const settled = async (container: HTMLElement): Promise<string> => {
  const loaded = () => container.textContent?.includes('A study with clicks but no recent day');
  for (let i = 0; i < 150 && !loaded(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(container.textContent).toContain('A study with clicks but no recent day');
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
    title: 'A study with clicks but no recent day',
    status: 'published',
    firsthand_study_id: null,
  } as never);
});

describe('chart empty state cannot contradict its own total', () => {
  it('does not say "No views recorded" while the header says Total: 3', async () => {
    const { container } = renderPage();
    const text = await settled(container);
    expect(text).toContain('Total: 3 (30d)');
    expect(text).not.toContain('No views recorded');
  });

  it('does not say "No actions recorded" while the header shows a positive total', async () => {
    load({ period_actions_total: 5, actions_total: 5 });
    const { container } = renderPage();
    const text = await settled(container);
    expect(text).not.toContain('No actions recorded');
  });

  it('does not say "No interactions recorded" while the combined total is positive', async () => {
    const { container } = renderPage();
    const text = await settled(container);
    expect(text).not.toContain('No interactions recorded in this period');
  });
});

describe('the empty state still appears when it is the truth', () => {
  it('shows every empty message when the period genuinely has no data', async () => {
    load({
      period_clicks_total: 0,
      period_views_total: 0,
      period_actions_total: 0,
      views_total: 0,
      actions_total: 0,
      clicks_total: 0,
      clicks_by_day: [],
    });
    const { container } = renderPage();
    const text = await settled(container);
    expect(text).toContain('No views recorded');
    expect(text).toContain('No actions recorded');
    expect(text).toContain('No interactions recorded in this period');
  });
});
