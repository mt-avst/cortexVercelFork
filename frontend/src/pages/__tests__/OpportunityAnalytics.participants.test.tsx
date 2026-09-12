import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityAnalytics from '../OpportunityAnalytics';
import {
  getOpportunityAnalytics,
  getOpportunity,
  getOpportunitySessionEvents,
  getOpportunityBookings,
  updateBookingResearcherNotes,
} from '../../api/client';

/**
 * #79: the Participants tab - where a researcher running a MODERATED study
 * (Live session or Interview) sees who booked and keeps their notes on each
 * session. Everything here is wiring: which types offer the tab, what a click
 * fetches, and that a note typed on this page reaches the API with the right
 * booking id.
 */

const AUTH = {
  user: { id: 'a1', role: 'researcher_admin', name: 'A', email: 'a@example.com' },
  loading: false,
  initialAuthCheck: true,
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => AUTH,
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

// Named individually rather than spread from the real module: an incomplete
// factory leaves an import undefined, and a click test then passes by
// asserting the generic failure it caused itself.
vi.mock('../../api/client', () => ({
  getOpportunityAnalytics: vi.fn(),
  getOpportunity: vi.fn(),
  getOpportunitySessionEvents: vi.fn(),
  getOpportunitySurveyResults: vi.fn(),
  getOpportunityBookings: vi.fn(),
  updateBookingResearcherNotes: vi.fn(),
  opportunitySurveyResultsCsvUrl: vi.fn(),
}));

const OPPORTUNITY_TITLE = 'Checkout walk-through';

const liveSession = {
  id: 'opp-1',
  type: 'test',
  title: OPPORTUNITY_TITLE,
  status: 'published',
  delivery_mode: null,
  firsthand_study_id: null,
};

const booking = {
  id: 'b1',
  user_id: 'user-1',
  session_id: 's1',
  status: 'booked',
  completion_status: 'pending',
  session_start_time: '2026-09-01T10:00:00.000Z',
  session_end_time: '2026-09-01T11:00:00.000Z',
  participant_name: 'Jane Doe',
  participant_email: 'jane@example.com',
  business_unit: 'Ops',
  role_title: 'Analyst',
  researcher_notes: null,
  researcher_notes_updated_at: null,
  created_at: '2026-08-27T09:00:00.000Z',
  updated_at: '2026-08-27T09:00:00.000Z',
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/analytics']}>
      <Routes>
        <Route path="/admin/opportunities/:id/analytics" element={<OpportunityAnalytics />} />
      </Routes>
    </MemoryRouter>
  );

const settled = async () => {
  await screen.findByText(new RegExp(OPPORTUNITY_TITLE), {}, { timeout: 3000 });
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(getOpportunityAnalytics).mockResolvedValue({
    clicks_by_day: [],
    clicks_by_hour: [],
    clicks_by_weekday: [],
    week_over_week_change: null,
  } as never);
  vi.mocked(getOpportunitySessionEvents).mockResolvedValue([] as never);
  vi.mocked(getOpportunityBookings).mockResolvedValue([booking] as never);
  vi.mocked(getOpportunity).mockResolvedValue(liveSession as never);
});

describe('which opportunities offer a Participants tab', () => {
  // Both moderated types, not just `test` - the pair is the point of #79,
  // and a gate narrowed to one of them would leave half the feature missing
  // with every test here green if only one type were asserted.
  it.each(['test', 'interview'])('offers it for a %s opportunity', async (type) => {
    vi.mocked(getOpportunity).mockResolvedValue({ ...liveSession, type } as never);

    renderPage();
    await settled();

    expect(screen.getByRole('tab', { name: 'Participants' })).toBeTruthy();
  });

  it.each(['unmoderated', 'question'])('does not offer it for a %s opportunity', async (type) => {
    vi.mocked(getOpportunity).mockResolvedValue({ ...liveSession, type } as never);

    renderPage();
    await settled();

    expect(screen.queryByRole('tab', { name: 'Participants' })).toBeNull();
  });
});

describe('the Participants tab', () => {
  it('fetches the roster on click and renders who booked', async () => {
    const user = userEvent.setup();
    renderPage();
    await settled();

    await user.click(screen.getByRole('tab', { name: 'Participants' }));

    expect(getOpportunityBookings).toHaveBeenCalledWith('opp-1');
    expect(await screen.findByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('jane@example.com')).toBeTruthy();
  });

  it('sends a typed note to the API with the booking id', async () => {
    const user = userEvent.setup();
    vi.mocked(updateBookingResearcherNotes).mockResolvedValue({
      researcher_notes: 'sharp observations',
      researcher_notes_updated_at: '2026-08-27T12:00:00.000Z',
    } as never);

    renderPage();
    await settled();
    await user.click(screen.getByRole('tab', { name: 'Participants' }));
    await screen.findByText('Jane Doe');

    await user.type(
      screen.getByLabelText('Researcher notes for Jane Doe'),
      'sharp observations'
    );
    await user.click(screen.getByRole('button', { name: 'Save note' }));

    expect(updateBookingResearcherNotes).toHaveBeenCalledWith('b1', 'sharp observations');
    expect(await screen.findByText(/^Updated /)).toBeTruthy();
  });

  it('keeps an unsaved note when the researcher visits another tab and comes back', async () => {
    // A conditional render would unmount the tab and discard the note with
    // no warning - the same loss as the in-flight save bug, by a different
    // route, on the same field. Overview is always available, so this is one
    // click away at any moment.
    const user = userEvent.setup();
    renderPage();
    await settled();

    await user.click(screen.getByRole('tab', { name: 'Participants' }));
    await screen.findByText('Jane Doe');
    await user.type(screen.getByLabelText('Researcher notes for Jane Doe'), 'half a thought');

    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await user.click(screen.getByRole('tab', { name: 'Participants' }));

    expect(screen.getByLabelText('Researcher notes for Jane Doe')).toHaveValue('half a thought');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('says "not allowed" for a 403 rather than rendering the empty state', async () => {
    const user = userEvent.setup();
    vi.mocked(getOpportunityBookings).mockRejectedValue({
      response: { status: 403 },
    } as never);

    renderPage();
    await settled();
    await user.click(screen.getByRole('tab', { name: 'Participants' }));

    expect(
      await screen.findByText('Only the study owner can view its participants')
    ).toBeTruthy();
    expect(screen.queryByText('Nobody has booked a session yet.')).toBeNull();
  });
});
