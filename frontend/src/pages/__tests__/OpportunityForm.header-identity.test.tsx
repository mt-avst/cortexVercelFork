import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { opportunityFormRoutes } from '../OpportunityForm.routes';
import { createOpportunity, deleteOpportunity, getOpportunity, updateOpportunity } from '../../api/client';
import { chooseStudyType } from './helpers/study-type-picker';

/**
 * Row 1 / D8: the header used to rename itself - "Create new study" to "Edit
 * study", with Analytics and Discard draft appearing - the moment autosave
 * silently minted a row and rewrote the URL to `/:id/edit`. Nothing the
 * author did caused it: the same draft, the same sitting, no navigation.
 *
 * D8 deletes the word pair entirely rather than fixing when it flips, so
 * there is nothing left to key a rename off. This defends that: it drives
 * the exact event the old header used to react to (autosave mints a row,
 * `isEdit` flips true) and asserts neither the old wording nor Analytics
 * ever appears, for a study that has never been published.
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

/** Long enough for the 2s debounce plus a render. */
const PAST_THE_DEBOUNCE = 3_500;

const LocationProbe: React.FC = () => (
  <span data-testid="location">{useLocation().pathname}</span>
);

const renderCreateForm = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <LocationProbe />
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );

/** Neither of the two words the old header used to flip between. */
const assertNoRenameChrome = () => {
  expect(screen.queryByText(/^Create new study$/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/^Edit study$/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Analytics/i })).not.toBeInTheDocument();
};

const fillCreateThreshold = (type = 'survey') => {
  chooseStudyType(type);
  fireEvent.change(screen.getByLabelText(/^Title/i), {
    target: { value: 'Developer experience pulse' }
  });
  fireEvent.change(screen.getByLabelText(/^Purpose/i), {
    target: { value: 'Ten short questions about the tools you use' }
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(createOpportunity).mockResolvedValue({ id: 'opp-new' } as never);
  vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-new' } as never);
  vi.mocked(deleteOpportunity).mockResolvedValue(undefined as never);
  vi.mocked(getOpportunity).mockResolvedValue({
    id: 'opp-new',
    type: 'survey',
    title: 'Developer experience pulse',
    purpose_one_liner: 'Ten short questions about the tools you use',
    description_optional: '',
    product_optional: '',
    meeting_location_optional: '',
    default_duration_minutes: 30,
    status: 'draft',
    delivery_mode: 'external',
    participant_type_required: 'any',
    owner_user_id: 'admin-1',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    sessions: []
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the header does not rename itself (row 1 / D8)', () => {
  it.each([['survey'], ['test']])(
    'never says Create/Edit and never grows an Analytics button once autosave mints a %s row',
    async (type) => {
      renderCreateForm();
      assertNoRenameChrome();

      fillCreateThreshold(type);
      // Still below the debounce: nothing has autosaved yet, same assertion.
      assertNoRenameChrome();

      await waitFor(() => expect(createOpportunity).toHaveBeenCalled(), {
        timeout: PAST_THE_DEBOUNCE
      });
      // The exact event the OLD header keyed its rename off - confirm it
      // actually happened, so a passing assertion below is not vacuous.
      await waitFor(() =>
        expect(screen.getByTestId('location')).toHaveTextContent(/\/edit$/)
      );

      assertNoRenameChrome();
    },
    15_000
  );

  it('shows the study title once typed, in place of the deleted mode word', async () => {
    renderCreateForm();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Untitled study');

    fillCreateThreshold();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Developer experience pulse'
    );
  });
});
