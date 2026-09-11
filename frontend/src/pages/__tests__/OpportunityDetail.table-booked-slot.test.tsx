import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getMyBookings } from '../../api/client';

/**
 * BK-3: the table (list) view's slot chips collapsed a session the
 * participant had already booked into the same generic "Full" chip as a slot
 * that is full for capacity reasons - there was no "you booked this" state,
 * unlike the calendar view (CalendarGrid's isBooked branch, checked before
 * isFull). This pins the table view doing the same isBooked-first check.
 *
 * Three sessions, three controls in one render:
 *  - sess-booked: remaining 0 AND matches a `status: 'booked'` booking -> must
 *    render the new Booked chip, not Full.
 *  - sess-full: remaining 0, no matching booking -> must still render Full
 *    (proves the Full branch still fires for a genuinely full slot).
 *  - sess-open: remaining > 0 -> must still render the bookable button
 *    (proves the isBooked check does not swallow the ordinary case).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const session = (id: string, startMs: number, remaining: number) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: iso(startMs),
  end_time: iso(startMs + HOUR),
  capacity: 3,
  booked_count: remaining === 0 ? 3 : 3 - remaining,
  remaining,
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
    session('sess-booked', 3 * DAY, 0),
    session('sess-full', 3 * DAY + 2 * HOUR, 0),
    session('sess-open', 3 * DAY + 4 * HOUR, 2),
  ],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false, initialAuthCheck: true }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));

// Table view is the default, so CalendarGrid never mounts here - it is
// stubbed only so importing it does not pull in framer-motion machinery.
vi.mock('../../components/CalendarGrid', () => ({
  default: () => <div data-testid="calendar-grid" />,
  CALENDAR_LEGEND_ITEMS: [],
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(async () => ({ ...fixture })),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
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
  vi.mocked(getMyBookings).mockResolvedValue({
    upcoming: [
      { session_id: 'sess-booked', status: 'booked' },
    ],
    past: [],
  } as never);
});

describe('OpportunityDetail table view - BK-3 booked slot state', () => {
  it('shows the participant\'s own booked slot as Booked, not Full', async () => {
    renderDetail();
    await screen.findByText(fixture.title);

    const booked = await screen.findByLabelText(/— your booking/i);
    expect(booked).toHaveTextContent(/Booked/i);
    expect(booked.className).toContain('slot-chip-booked');

    // Control: a genuinely full, unbooked slot still renders Full.
    const full = screen.getByLabelText(/is full/i);
    expect(full).toHaveTextContent(/Full/i);
    expect(full.className).toContain('slot-chip-full');

    // Control: a bookable slot still renders its book button.
    expect(screen.getByRole('button', { name: /^Book session on/i })).toBeInTheDocument();
  });
});
