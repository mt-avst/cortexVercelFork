import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import MyBookings from '../MyBookings';
import { getMyBookings } from '../../api/client';

// What this page told a participant, before:
//   - "Reschedule", greyed out, on every card, forever
//   - "Time 21:00 - 21:45" with no zone, for a company across the UK and US
//   - three date formats, two of them on the SAME card
//   - "Join via Google Meet" on sessions that finished weeks ago, and on a
//     cancelled one
//   - nothing about whether you actually took part

const upcoming = {
  id: 'bk-1',
  status: 'booked',
  opportunity_id: 'opp-1',
  opportunity_title: 'ScriptRunner for Jira: the new script editor',
  opportunity_purpose: 'Watch engineers debug a script',
  opportunity_type: 'test',
  session_start_time: '2026-08-18T20:00:00.000Z',
  session_end_time: '2026-08-18T20:45:00.000Z',
  session_location: 'https://meet.google.com/abc-defg-hij',
  owner_name: 'Test Admin',
  completion_status: 'pending',
};

const past = {
  ...upcoming,
  id: 'bk-2',
  session_start_time: '2026-07-11T06:00:00.000Z',
  session_end_time: '2026-07-11T06:45:00.000Z',
  completion_status: 'approved',
};

const cancelled = {
  ...past,
  id: 'bk-3',
  status: 'cancelled',
  cancelled_at: '2026-07-25T11:13:00.000Z',
  completion_status: 'pending',
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

vi.mock('../../api/client', () => ({
  getMyBookings: vi.fn(),
  cancelBooking: vi.fn(),
  rescheduleBooking: vi.fn(),
  getMySessionEvents: vi.fn(async () => []),
}));

const renderPage = () => render(<MemoryRouter><MyBookings /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMyBookings).mockResolvedValue({
    upcoming: [upcoming],
    past: [past, cancelled],
  } as never);
});

describe('MyBookings presentation', () => {
  it('offers no reschedule control, because there is no reschedule', async () => {
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    // It shipped `disabled` with title="Reschedule functionality coming soon" -
    // a permanent promise of a feature that does not exist, on every card.
    expect(screen.queryByRole('button', { name: /reschedule/i })).toBeNull();
    expect(screen.queryByTitle(/coming soon/i)).toBeNull();
  });

  it('says how to change a booking, since the control is gone', async () => {
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    expect(screen.getByText(/cancel.*book another/i)).toBeVisible();
  });

  it('names the timezone ON the session time, not merely somewhere on the page', async () => {
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    // Asserting only that /GMT[+-]/ appears SOMEWHERE passed with the zone
    // stripped off the session time, because the cancellation timestamp on
    // another card carries one too. The zone has to be adjacent to the time it
    // qualifies, so this pins the range and the offset in one string.
    // The exact offset depends on the runner's zone, hence the pattern.
    const upcoming = screen.getByTestId('upcoming-bookings');
    expect(upcoming.textContent).toMatch(/\d{2}:\d{2}\s*–\s*\d{2}:\d{2}\s*GMT[+-]/);

    const past = screen.getByTestId('past-bookings');
    expect(past.textContent).toMatch(/\d{2}:\d{2}\s*–\s*\d{2}:\d{2}\s*GMT[+-]/);
  });

  it('writes every date with a named month, never as DD/MM/YYYY', async () => {
    const { container } = renderPage();
    await screen.findAllByText(/ScriptRunner/);

    expect(container.textContent).toMatch(/\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/);
    expect(container.textContent).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('uses one date format, including for a cancellation', async () => {
    const { container } = renderPage();
    await screen.findAllByText(/ScriptRunner/);

    // The cancelled card carried "27/07/2026" and "Jul 25, 12:13 PM" together.
    expect(container.textContent).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
  });

  it('offers a join link on an upcoming booking', async () => {
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    const upcomingSection = screen.getByTestId('upcoming-bookings');
    expect(
      within(upcomingSection).getByRole('link', { name: /join via google meet/i })
    ).toBeVisible();
  });

  it('offers no join link on a session that has already happened', async () => {
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    const pastSection = screen.getByTestId('past-bookings');
    expect(within(pastSection).queryByRole('link', { name: /join/i })).toBeNull();
  });

  it('shows the meeting link once, not as both a field and a button', async () => {
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    const upcomingSection = screen.getByTestId('upcoming-bookings');
    expect(
      within(upcomingSection).getAllByRole('link', { name: /join via google meet/i })
    ).toHaveLength(1);
  });

  it('says whether a past session was confirmed', async () => {
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    const pastSection = screen.getByTestId('past-bookings');
    // The EXACT words. /confirmed/i matched both "Attendance confirmed" and
    // "Not confirmed", so approved and rejected could be swapped with the
    // suite still green.
    expect(within(pastSection).getByText('Attendance confirmed')).toBeVisible();
  });

  // A cancelled booking has no attendance to confirm. Without the guard it
  // rendered "Awaiting confirmation", telling someone who cancelled that their
  // attendance was pending review - and no assertion caught it, because
  // "Awaiting confirmation" does not contain the word "confirmed".
  it('says nothing about an outcome for a booking that was cancelled', async () => {
    vi.mocked(getMyBookings).mockResolvedValue({ upcoming: [], past: [cancelled] } as never);
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    const pastSection = screen.getByTestId('past-bookings');
    expect(within(pastSection).queryByText(/awaiting confirmation/i)).toBeNull();
    expect(within(pastSection).queryByText(/attendance confirmed/i)).toBeNull();
    expect(within(pastSection).queryByText(/^Outcome$/)).toBeNull();
  });

  it('labels the study type in participant vocabulary', async () => {
    renderPage();
    await screen.findAllByText(/ScriptRunner/);

    expect(screen.getAllByText('Live session').length).toBeGreaterThan(0);
    // (a /^TEST$/ check here was vacuous - the raw type renders lowercase,
    // so it could never match either way. The assertion above does the work.)
  });
});

describe('MyBookings names the participant page Participate (#169)', () => {
  it('goes back to Participate', async () => {
    renderPage();
    const back = await screen.findByRole('button', { name: /^Back to Participate$/ });
    expect(back).toHaveAttribute('title', 'Back to Participate');
  });

  it('points an empty list at Participate, not at a dashboard', async () => {
    vi.mocked(getMyBookings).mockResolvedValue({ upcoming: [], past: [] } as never);
    renderPage();
    expect(await screen.findByText('No upcoming sessions')).toBeInTheDocument();
    expect(screen.getByText('Find a study to take part in on Participate.')).toBeInTheDocument();
    expect(screen.queryByText(/dashboard/i)).not.toBeInTheDocument();
  });
});
