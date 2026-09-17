import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { opportunityFormRoutes } from '../OpportunityForm.routes';
import { createOpportunity, deleteOpportunity, getOpportunity, updateOpportunity } from '../../api/client';
import { chooseStudyType } from './helpers/study-type-picker';

/**
 * Row 27: the header status region used to size itself to however many of
 * its three lines (the save-model note, the autosave state, Discard draft)
 * happened to be showing - one on a clean published study, three on an
 * autosaving draft mid-save - so the six-step strip 60px below it moved
 * every time a line appeared or disappeared, including at the exact moment
 * autosave silently mints a row.
 *
 * Also row 27: "Saved 12:36 AM" was the BROWSER's own locale, not the
 * product's - en-GB, 24-hour, everywhere else.
 *
 * Real timers for the autosave half, matching the convention in
 * OpportunityForm.autosave.test.tsx: the debounce is two seconds and this
 * waits it out rather than faking the clock.
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

const PAST_THE_DEBOUNCE = 3_500;

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

const renderCreateForm = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );

const renderEditForm = (opportunity: Record<string, unknown>) => {
  vi.mocked(getOpportunity).mockResolvedValue(opportunity as never);
  return render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );
};

const fillCreateThreshold = () => {
  chooseStudyType('survey');
  fireEvent.change(screen.getByLabelText(/^Title/i), {
    target: { value: 'Developer experience pulse' }
  });
  fireEvent.change(screen.getByLabelText(/^Purpose/i), {
    target: { value: 'Ten short questions about the tools you use' }
  });
};

const statusRegionMinHeight = () =>
  screen.getByTestId('header-status-region').style.minHeight;

/**
 * Pinned as a literal (testing.md: "pin policy constants as literals"), the
 * same value `HEADER_STATUS_REGION_MIN_HEIGHT` in OpportunityForm.tsx names.
 * A test that instead read the constant back out of the component could not
 * see it shrink towards `auto` - it would just be comparing the value with
 * itself.
 */
const RESERVED_HEIGHT = '7.5rem';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(createOpportunity).mockResolvedValue({ id: 'opp-new' } as never);
  vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-1' } as never);
  vi.mocked(deleteOpportunity).mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the header status region reserves a fixed height (row 27)', () => {
  it('reserves the pinned height when only one line (the save-model note) is showing', async () => {
    // A published study: no autosave state, no Discard draft, since
    // autosave does not apply to it.
    renderEditForm(publishedOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    expect(screen.queryByTestId('autosave-state')).not.toBeInTheDocument();
    expect(screen.queryByText(/Discard draft/i)).not.toBeInTheDocument();
    expect(statusRegionMinHeight()).toBe(RESERVED_HEIGHT);
  });

  it('reserves the SAME pinned height once autosave grows the region to three lines', async () => {
    // A freshly-autosaved draft carries the save-model note, the autosave
    // state ("Saved …"), AND Discard draft - the exact growth Mav's report
    // measured as a 60px drop in the strip beneath it.
    renderCreateForm();
    fillCreateThreshold();
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });
    await waitFor(() => expect(screen.getByTestId('autosave-state')).toBeInTheDocument());
    await screen.findByText(/Discard draft/i);

    expect(statusRegionMinHeight()).toBe(RESERVED_HEIGHT);
  }, 15_000);
});

describe('the saved timestamp is 24-hour en-GB, not the browser locale (row 27)', () => {
  it('never renders a 12-hour AM/PM clock', async () => {
    renderCreateForm();
    fillCreateThreshold();

    await waitFor(
      () =>
        expect(screen.getByTestId('autosave-state').textContent).toMatch(/^Saved /),
      { timeout: PAST_THE_DEBOUNCE }
    );

    const text = screen.getByTestId('autosave-state').textContent ?? '';
    expect(text).toMatch(/^Saved \d{2}:\d{2}$/);
    expect(text).not.toMatch(/AM|PM/i);
  }, 15_000);
});
