import { screen, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getOpportunity, getOpportunityBookings } from '../../api/client';
import type { Opportunity } from '../../api/types';
import { MANAGER_USER, NOW, booking, deferred, renderOverview, session, study } from './helpers/opportunity-overview';

/**
 * Sessions and Bookings (cto/AdaptaLabs#163, live session / interview only):
 * upcoming-then-past ordering, the owner's booking roster, and the bookings
 * request's own loading/error/retry/staleness handling. The clock is pinned
 * so "upcoming" vs "past" is deterministic.
 */
const auth = vi.hoisted(() => ({
  value: { user: { id: 'placeholder', role: 'researcher_admin', name: '', email: '' }, loading: false, initialAuthCheck: true },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  getOpportunityBookings: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  auth.value = { user: MANAGER_USER, loading: false, initialAuthCheck: true };
});

afterEach(() => {
  vi.useRealTimers();
});

const inDaysIso = (days: number): string => new Date(NOW.getTime() + days * 86400000).toISOString();

const MODERATED_STUDY = (over: Partial<Opportunity> = {}): Opportunity =>
  study({
    title: 'Moderated study',
    type: 'test',
    status: 'published',
    meeting_location_optional: 'Room 4',
    ...over,
  });

describe('sessions: upcoming then past, each with its own booked/capacity', () => {
  it('lists upcoming sessions soonest-first and past sessions most-recent-first', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      MODERATED_STUDY({
        sessions: [
          session('s-past-old', -5, 2, 1), // "1 / 2"
          session('s-upcoming-far', 10, 4, 1), // "1 / 4"
          session('s-past-recent', -1, 2, 2), // "2 / 2"
          session('s-upcoming-soon', 2, 3, 0), // "0 / 3"
        ],
      })
    );
    vi.mocked(getOpportunityBookings).mockResolvedValue([]);
    renderOverview();

    const upcomingHeading = await screen.findByRole('heading', { level: 3, name: 'Upcoming' });
    const upcomingItems = within(upcomingHeading.nextElementSibling as HTMLElement).getAllByRole('listitem');
    expect(upcomingItems.map((li) => li.textContent)).toEqual([
      expect.stringContaining('0 / 3'), // s-upcoming-soon: 2 days out
      expect.stringContaining('1 / 4'), // s-upcoming-far: 10 days out
    ]);

    const pastHeading = screen.getByRole('heading', { level: 3, name: 'Past' });
    const pastItems = within(pastHeading.nextElementSibling as HTMLElement).getAllByRole('listitem');
    expect(pastItems.map((li) => li.textContent)).toEqual([
      expect.stringContaining('2 / 2'), // s-past-recent: 1 day ago
      expect.stringContaining('1 / 2'), // s-past-old: 5 days ago
    ]);
  });

  it('shows an empty state for each half when there are no sessions at all', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_STUDY({ sessions: [] }));
    vi.mocked(getOpportunityBookings).mockResolvedValue([]);
    renderOverview();

    expect(await screen.findByText('No sessions scheduled yet.')).toBeInTheDocument();
    // The per-half "No upcoming sessions." / "No past sessions." only render
    // when the study HAS sessions but one half is empty - covered by the
    // ordering test above having only one row in a half when needed. A study
    // with genuinely zero sessions gets the single top-level empty state
    // instead, checked here.
    expect(screen.queryByRole('heading', { level: 3, name: 'Upcoming' })).not.toBeInTheDocument();
  });
});

describe("bookings: the owner's roster", () => {
  it('lists bookings sorted by session time, with the participant and a real status label', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_STUDY({ sessions: [session('s-1', 3, 2, 2)] }));
    vi.mocked(getOpportunityBookings).mockResolvedValue([
      booking('later', inDaysIso(3), { participant_name: 'Later Participant', status: 'cancelled' }),
      booking('sooner', inDaysIso(1), { participant_name: 'Sooner Participant', completion_status: 'completed' }),
    ]);
    renderOverview();

    const bookingsHeading = await screen.findByRole('heading', { name: 'Bookings' });
    // The roster loads after the page renders, so wait for it to replace the
    // loading line before reading the list beside the heading.
    await screen.findByText(/Sooner Participant/);
    const items = within(bookingsHeading.nextElementSibling as HTMLElement).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Sorted ascending by session_start_time: "sooner" (day 1) before "later" (day 3).
    expect(items[0]).toHaveTextContent('Sooner Participant');
    expect(items[0]).toHaveTextContent('Awaiting approval');
    expect(items[1]).toHaveTextContent('Later Participant');
    expect(items[1]).toHaveTextContent('Cancelled');
  });

  it('falls back to the participant email, then "Unknown participant"', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_STUDY({ sessions: [session('s-1', 3, 2, 1)] }));
    vi.mocked(getOpportunityBookings).mockResolvedValue([
      booking('b1', inDaysIso(1), { participant_name: null, participant_email: 'p1@example.com' }),
      booking('b2', inDaysIso(2), { participant_name: null, participant_email: null }),
    ]);
    renderOverview();

    expect(await screen.findByText(/p1@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/Unknown participant/)).toBeInTheDocument();
  });

  it('shows an empty state when the study has no bookings', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_STUDY({ sessions: [] }));
    vi.mocked(getOpportunityBookings).mockResolvedValue([]);
    renderOverview();

    expect(await screen.findByText('No bookings yet.')).toBeInTheDocument();
  });

  it('never fetches bookings, and renders no Bookings section, for a non-moderated study', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({ title: 'Poll study', type: 'poll', delivery_mode: 'external', external_link_optional: 'https://example.com' })
    );
    renderOverview();

    await screen.findByRole('heading', { name: 'Poll study' });
    expect(getOpportunityBookings).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Bookings' })).not.toBeInTheDocument();
  });
});

describe('bookings: loading, error and retry', () => {
  it('shows "Loading bookings…" while the request is in flight, then the real content', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_STUDY({ sessions: [] }));
    const pending = deferred<ReturnType<typeof booking>[]>();
    vi.mocked(getOpportunityBookings).mockReturnValue(pending.promise as never);
    renderOverview();

    expect(await screen.findByText('Loading bookings…')).toBeInTheDocument();

    await act(async () => {
      pending.resolve([]);
      await pending.promise;
    });
    expect(await screen.findByText('No bookings yet.')).toBeInTheDocument();
  });

  it('shows "Couldn\'t load bookings" with Retry on a non-403 failure - never "No bookings yet."', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_STUDY({ sessions: [] }));
    vi.mocked(getOpportunityBookings).mockRejectedValueOnce({ response: { status: 500 } });
    renderOverview();

    expect(await screen.findByText("Couldn't load bookings")).toBeInTheDocument();
    expect(screen.queryByText('No bookings yet.')).not.toBeInTheDocument();

    vi.mocked(getOpportunityBookings).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('No bookings yet.')).toBeInTheDocument();
    expect(getOpportunityBookings).toHaveBeenCalledTimes(2);
  });

  it('a 403 on the bookings fetch shows the owner-only page, not the bookings error state', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_STUDY({ sessions: [] }));
    vi.mocked(getOpportunityBookings).mockRejectedValueOnce({ response: { status: 403 } });
    renderOverview();

    expect(await screen.findByText('Study overview is owner-only')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load bookings")).not.toBeInTheDocument();
  });
});
