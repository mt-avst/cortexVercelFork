import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getMyBookings } from '../../api/client';
import { formatStudyDate, formatClockTime } from '../../utils/datetime';

/**
 * BK-1: session-level double booking is already blocked (a 409 plus a partial
 * unique index), but a participant who holds a slot in this study is not
 * warned when they open the page and could book a SECOND, different slot. This
 * pins the soft warning: a notice naming the slot they already hold and a link
 * to My Bookings - while still allowing another booking (the warn is not a
 * block).
 *
 * Controls in the same file:
 *  - no booking for this study -> the notice must not render (proves the
 *    notice is gated on an actual held booking, not always on)
 *  - a bookable slot still renders its Book button (proves the warn does not
 *    disable booking)
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
    session('sess-held', 3 * DAY, 2),
    session('sess-open', 3 * DAY + 4 * HOUR, 2),
    session('sess-held-late', 5 * DAY, 2),
    // Already happened - end_time is in the past too, not merely start_time.
    session('sess-held-past', -5 * DAY, 0),
  ],
};

const sessionById = (id: string) => fixture.sessions.find((s) => s.id === id)!;
// Format from the fixture's own frozen ISO string (not a fresh Date.now()) so
// the expected text cannot drift across a minute boundary mid-test.
const namedFor = (id: string) => {
  const s = sessionById(id);
  return `${formatStudyDate(s.start_time)} at ${formatClockTime(new Date(s.start_time))}`;
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
});

describe('OpportunityDetail - BK-1 already-booked-for-this-study notice', () => {
  it('warns and links to My Bookings when the participant already holds a slot, but still allows another', async () => {
    vi.mocked(getMyBookings).mockResolvedValue({
      upcoming: [{ session_id: 'sess-held', status: 'booked' }],
      past: [],
    } as never);

    renderDetail();
    await screen.findByText(fixture.title);

    const notice = await screen.findByTestId('already-booked-notice');
    // Name the held slot's own date and time - the whole point of the notice.
    // A wrong slot, wrong sort or a broken formatter would fail here by name.
    expect(notice).toHaveTextContent(`already booked for this study on ${namedFor('sess-held')}`);

    // The notice must offer a route to the existing booking.
    const link = screen.getByRole('link', { name: /bookings/i });
    expect(link).toHaveAttribute('href', '/my-bookings');

    // The warn is soft: the other, unheld slots are still bookable.
    expect((await screen.findAllByRole('button', { name: /^Book session on/i })).length).toBeGreaterThan(0);
  });

  it('names the earliest held slot when the participant holds more than one', async () => {
    vi.mocked(getMyBookings).mockResolvedValue({
      // Deliberately later-first, to prove the notice sorts rather than taking
      // the first booking the API happens to return.
      upcoming: [
        { session_id: 'sess-held-late', status: 'booked' },
        { session_id: 'sess-held', status: 'booked' },
      ],
      past: [],
    } as never);

    renderDetail();
    await screen.findByText(fixture.title);

    const notice = await screen.findByTestId('already-booked-notice');
    expect(notice).toHaveTextContent(`already booked for this study on ${namedFor('sess-held')}`);
    // The later held slot's date must not be the one named.
    expect(notice).not.toHaveTextContent(formatStudyDate(sessionById('sess-held-late').start_time) as string);
  });

  // Fix-first row 11 (second-pass review). `bookedSlots` is sourced from
  // BOTH `bookings.upcoming` and `bookings.past` (loadBookedSlots above), and
  // the notice took the chronologically-EARLIEST held session with no regard
  // for whether it had already happened - a participant whose only held
  // session in this study was five days ago was told "You are already booked
  // for this study" on a date that had already passed.
  it('says nothing about a session that has already happened', async () => {
    vi.mocked(getMyBookings).mockResolvedValue({
      upcoming: [],
      past: [{ session_id: 'sess-held-past', status: 'booked' }],
    } as never);

    renderDetail();
    await screen.findByText(fixture.title);
    await screen.findAllByRole('button', { name: /^Book session on/i });

    expect(screen.queryByTestId('already-booked-notice')).not.toBeInTheDocument();
  });

  it('names the earliest FUTURE held slot, skipping one that has already happened', async () => {
    vi.mocked(getMyBookings).mockResolvedValue({
      upcoming: [{ session_id: 'sess-held', status: 'booked' }],
      past: [{ session_id: 'sess-held-past', status: 'booked' }],
    } as never);

    renderDetail();
    await screen.findByText(fixture.title);

    const notice = await screen.findByTestId('already-booked-notice');
    expect(notice).toHaveTextContent(`already booked for this study on ${namedFor('sess-held')}`);
  });

  it('does not warn when the participant holds no slot in this study', async () => {
    vi.mocked(getMyBookings).mockResolvedValue({ upcoming: [], past: [] } as never);

    renderDetail();
    await screen.findByText(fixture.title);
    // Let the bookings effect settle: a bookable slot proves the render is live.
    await screen.findAllByRole('button', { name: /^Book session on/i });

    expect(screen.queryByTestId('already-booked-notice')).not.toBeInTheDocument();
  });
});
