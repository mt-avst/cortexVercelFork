import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityAnalytics from '../OpportunityAnalytics';
import {
  getOpportunityAnalytics,
  getOpportunity,
  getOpportunitySessionEvents,
} from '../../api/client';

/**
 * A 403 on the analytics fetch is a permission ANSWER, not a transport failure
 * (row 8). It must render its own state: no Retry (retrying cannot grant
 * access), Back still live, and it names the owner so the reader knows whom to
 * ask - not the generic "Failed to load / Try Again".
 */
const AUTH_VALUE = {
  user: { id: 'viewer-1', role: 'researcher_admin', name: 'Viewer', email: 'v@example.com' },
  loading: false,
  initialAuthCheck: true,
};
vi.mock('../../contexts/AuthContext', () => ({
  // A stable reference: the page's load effect depends on `user`, so a fresh
  // object per render would re-trigger the load and never settle.
  useAuth: () => AUTH_VALUE,
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

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(getOpportunitySessionEvents).mockResolvedValue([] as never);
  // The opportunity read succeeds for an admin and carries owner_name; only the
  // analytics read is refused.
  vi.mocked(getOpportunity).mockResolvedValue({
    id: 'opp-1',
    type: 'test',
    title: 'A colleague\'s study',
    status: 'published',
    owner_user_id: 'someone-else',
    owner_name: 'Dana Owner',
  } as never);
  vi.mocked(getOpportunityAnalytics).mockRejectedValue({ response: { status: 403 } });
});

describe('OpportunityAnalytics permission state (row 8)', () => {
  it('names the owner and offers no Retry when analytics are refused', async () => {
    renderPage();

    expect(await screen.findByText(/Dana Owner/)).toBeInTheDocument();
    // No Retry: the generic error state's button must not be present.
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try Again/i })).not.toBeInTheDocument();
    // Back stays live.
    expect(screen.getByRole('button', { name: /Back to Admin Dashboard/i })).toBeInTheDocument();
  });

  it('renders the transport-error state (with Retry) for a non-permission failure', async () => {
    vi.mocked(getOpportunity).mockRejectedValue({ response: { status: 500 } });
    renderPage();

    expect(await screen.findByRole('button', { name: /Retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/Dana Owner/)).not.toBeInTheDocument();
  });
});
