import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { bookSession, getOpportunity } from '../../api/client';

/**
 * A failed booking must reach the caller, not just the screen.
 *
 * handleBookSession catches every failure, picks a message and sets it - and
 * used to return normally, so CalendarGrid's await resolved as though the
 * booking had worked and its optimistic "booked" mark was never unwound. The
 * child cannot unwind what it is never told about.
 *
 * CalendarGrid is stubbed here so the assertion is on the seam itself: what the
 * child observes when it awaits onBookSession. The unwind that depends on it is
 * pinned in CalendarGrid.booking.test.tsx.
 */

const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const end = new Date(start.getTime() + 60 * 60 * 1000);

const fixture = {
  id: 'opp-1',
  type: 'test',
  title: 'Checkout flow walkthrough',
  purpose_one_liner: 'Find out where people stall in the checkout flow',
  status: 'published',
  default_duration_minutes: 60,
  participant_type_required: 'any',
  // The grid only renders at all once there is something to book.
  sessions: [
    {
      id: 'sess-1',
      opportunity_id: 'opp-1',
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: 3,
      remaining: 3,
    },
  ],
};

/** Set by the CalendarGrid stub: what the child saw when it awaited the call. */
let bookOutcome: 'resolved' | 'rejected' | null = null;

/** Swapped per test so the signed-out guard clause can be exercised. */
let mockUser: { id: string; role: string; name: string } | null = null;

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, loading: false, initialAuthCheck: true }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));

vi.mock('../../components/CalendarGrid', () => ({
  CALENDAR_LEGEND_ITEMS: [],
  default: ({ onBookSession }: { onBookSession: (id: string) => void }) => (
    <button
      type="button"
      onClick={async () => {
        try {
          await onBookSession('sess-1');
          bookOutcome = 'resolved';
        } catch {
          bookOutcome = 'rejected';
        }
      }}
    >
      stub book
    </button>
  ),
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(async () => ({ ...fixture })),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
  startRecordedStudySession: vi.fn(),
}));

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/opportunities/opp-1']}>
      <Routes>
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
      </Routes>
    </MemoryRouter>
  );

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.clearAllMocks();
  bookOutcome = null;
  mockUser = { id: 'u1', role: 'employee', name: 'E' };
  vi.mocked(getOpportunity).mockImplementation(async () => ({ ...fixture }) as never);
  // Rather than a raw .click(): userEvent wraps in act(), so the state updates
  // the click triggers are flushed instead of producing a wall of warnings.
  user = userEvent.setup();
});

describe('OpportunityDetail - reporting a booking failure to the grid', () => {
  it('rejects to the caller, as well as showing the participant a message', async () => {
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 500, data: { error: 'boom' } },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'stub book' }));

    await waitFor(() => expect(bookOutcome).toBe('rejected'));
    expect(screen.getByText(/Server error occurred/i)).toBeInTheDocument();
  });

  it('resolves to the caller when the booking works', async () => {
    vi.mocked(bookSession).mockResolvedValue({ id: 'booking-1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'stub book' }));

    // Guards the lazy over-correction: rethrowing unconditionally would satisfy
    // the test above while telling the grid to unwind every successful booking.
    await waitFor(() => expect(bookOutcome).toBe('resolved'));
  });

  it('rejects on a 409, the failure the participant actually hits', async () => {
    // Worth its own case rather than trusting the 500 above: the catch fans out
    // into eight status branches, and a rethrow placed inside one of them
    // passes a single-status test while leaving every other failure silent. 409
    // is the common one - two participants racing for the last slot - and the
    // only path where the page survives to show the unwind.
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 409, data: { error: 'Session is full' } },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'stub book' }));

    await waitFor(() => expect(bookOutcome).toBe('rejected'));
    // And the message survives the reload that a capacity failure triggers,
    // which opens with setError('').
    expect(await screen.findByText(/Session is full/i)).toBeInTheDocument();
  });

  it('rejects when the guard clauses refuse the booking', async () => {
    // The guards return before bookSession is ever called. They still have to
    // reject, or the grid keeps an optimistic mark for a booking that was
    // never attempted.
    vi.mocked(bookSession).mockResolvedValue({ id: 'booking-1' } as never);
    mockUser = null;

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'stub book' }));

    await waitFor(() => expect(bookOutcome).toBe('rejected'));
    expect(bookSession).not.toHaveBeenCalled();
  });
});
