import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { opportunityFormRoutes } from '../OpportunityForm.routes';
import { getOpportunity } from '../../api/client';

/**
 * Row 10: "Analytics" used to navigate with a bare `navigate(...)` call while
 * "Exit to dashboard" went through `requestExit`'s unsaved-work guard -
 * neither backstop caught it, because `runGuard` is consulted only by
 * `GuardedLink` and `beforeunload` covers only refresh/close/back. A dirty
 * author could lose everything by clicking the one exit that looked least
 * like leaving.
 *
 * The docblock immediately above the `beforeunload` handler
 * (`OpportunityForm.tsx`, "Warn before the BROWSER takes the page away")
 * asserted the opposite - "every control on this form that leaves goes
 * through it" - which this test also defends: Analytics is exactly the
 * control that falsified it.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false })
}));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  deleteOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn()
}));

const LocationProbe: React.FC = () => (
  <span data-testid="location">{useLocation().pathname}</span>
);

const publishedOpportunity = {
  id: 'opp-1',
  type: 'survey',
  title: 'Developer experience pulse',
  purpose_one_liner: 'Ten short questions about the tools you use every day',
  description_optional: '',
  product_optional: '',
  meeting_location_optional: '',
  default_duration_minutes: 30,
  status: 'published',
  delivery_mode: 'external',
  participant_type_required: 'any',
  owner_user_id: 'admin-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  sessions: []
};

const renderEditForm = () => {
  vi.mocked(getOpportunity).mockResolvedValue(publishedOpportunity as never);
  return render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <LocationProbe />
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Analytics goes through the same unsaved-work guard as Exit (row 10)', () => {
  it('confirms before leaving a dirty form, and does not navigate, when Analytics is clicked', async () => {
    renderEditForm();
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse, revised' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Analytics/i }));

    expect(await screen.findByText(/Leave without saving\?/i)).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/admin/opportunities/opp-1/edit'
    );
  });

  it('navigates straight to Analytics with no confirmation when the form is clean', async () => {
    renderEditForm();
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.click(screen.getByRole('button', { name: /Analytics/i }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/admin/opportunities/opp-1/analytics'
      )
    );
    expect(screen.queryByText(/Leave without saving\?/i)).not.toBeInTheDocument();
  });

  it('discards and leaves for Analytics exactly as it does for Exit to dashboard', async () => {
    renderEditForm();
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse, revised' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Analytics/i }));

    fireEvent.click(await screen.findByRole('button', { name: /Discard and leave/i }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/admin/opportunities/opp-1/analytics'
      )
    );
  });
});
