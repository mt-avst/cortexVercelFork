import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getMyCalendarEvents } from '../../api/client';

/**
 * BK-2 (table view): a slot that clashes with the participant's own diary used
 * to be HIDDEN, with only a "N conflicted slots hidden from view" banner - the
 * participant could neither see the slot nor learn what it clashed with. This
 * pins the new behaviour: the clashing slot is shown, disabled, and names the
 * clash ("Clashes with 'Team standup', ...") - and the hidden-count banner is
 * gone.
 *
 * Controls:
 *  - a non-clashing slot still renders its bookable Book button
 *  - the "hidden from view" banner must not appear
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN = 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const session = (id: string, startMs: number) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: iso(startMs),
  end_time: iso(startMs + HOUR),
  capacity: 3,
  booked_count: 0,
  remaining: 3,
});

const fixture = {
  id: 'opp-1',
  type: 'test',
  title: 'Checkout flow walkthrough',
  purpose_one_liner: 'Find out where people stall in the checkout flow',
  status: 'published',
  default_duration_minutes: 60,
  participant_type_required: 'any',
  sessions: [
    session('sess-clash', 3 * DAY),
    session('sess-clear', 3 * DAY + 5 * HOUR),
  ],
};

const clashingEvent = {
  id: 'evt-1',
  title: 'Team standup',
  start: iso(3 * DAY),
  end: iso(3 * DAY + 30 * MIN),
  startTime: new Date(Date.now() + 3 * DAY),
  endTime: new Date(Date.now() + 3 * DAY + 30 * MIN),
  status: 'confirmed',
  attendees: [],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false, initialAuthCheck: true }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/CalendarGrid', () => ({
  default: () => <div data-testid="calendar-grid" />,
  CALENDAR_LEGEND_ITEMS: [],
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(async () => ({ ...fixture })),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: true, connectedAt: null })),
  startRecordedStudySession: vi.fn(),
  startSurveySession: vi.fn(),
}));

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/opportunities/opp-1']}>
      <Routes>
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOpportunity).mockImplementation(async () => ({ ...fixture }) as never);
  vi.mocked(getMyCalendarEvents).mockResolvedValue([clashingEvent] as never);
});

describe('OpportunityDetail table view - BK-2 name the calendar clash', () => {
  it('shows the clashing slot disabled and names what it clashes with', async () => {
    renderDetail();
    await screen.findByText(fixture.title);

    // The clashing slot is now on screen, naming the clash rather than hidden.
    const clash = await screen.findByLabelText(/Clashes with 'Team standup'/i);
    expect(clash).toBeInTheDocument();
    // It is not bookable.
    expect(clash.tagName).not.toBe('BUTTON');
  });

  it('no longer hides conflicted slots behind a count banner', async () => {
    renderDetail();
    await screen.findByText(fixture.title);
    await screen.findByLabelText(/Clashes with 'Team standup'/i);

    expect(screen.queryByText(/hidden from view/i)).not.toBeInTheDocument();
  });

  it('leaves a non-clashing slot bookable', async () => {
    renderDetail();
    await screen.findByText(fixture.title);

    expect(await screen.findByRole('button', { name: /^Book session on/i })).toBeInTheDocument();
  });
});
