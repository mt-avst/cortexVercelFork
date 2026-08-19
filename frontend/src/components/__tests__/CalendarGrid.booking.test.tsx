import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import CalendarGrid from '../CalendarGrid';

/**
 * The grid marks a slot booked BEFORE the booking call returns, so the
 * participant gets immediate feedback. That optimistic mark has to come back
 * off when the call fails, because handleSlotClick refuses to reopen a slot it
 * believes is booked - leaving the participant looking at a slot that claims to
 * be theirs and will not respond to a click.
 */

/**
 * Any future day will do.
 *
 * It did not always: groupSessionsByDate built its columns from Monday to
 * Friday only, so a session on a Saturday or Sunday landed in no column and the
 * grid rendered its "No sessions available" empty state instead. Pinned to
 * "three days from now", this fixture therefore produced an empty grid - and
 * failed all three tests in this file - on every Wednesday and Thursday, and
 * passed the rest of the week. It was carrying a roll-forward past the weekend
 * to work around that.
 *
 * The grid now gives a weekend day its own column when a session falls on one,
 * so the workaround is gone and the day of the week no longer matters here.
 * That behaviour is pinned to fixed dates in CalendarGrid.weekend.test.tsx -
 * deliberately not left to depend on the day the suite happens to run, which is
 * how the original defect stayed hidden.
 */
const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
start.setHours(10, 0, 0, 0);
const end = new Date(start.getTime() + 60 * 60 * 1000);

const session = {
  id: 'sess-1',
  opportunity_id: 'opp-1',
  start_time: start.toISOString(),
  end_time: end.toISOString(),
  capacity: 3,
  remaining: 3,
};

vi.mock('../../api/client', () => ({
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
  getMyCalendarEvents: vi.fn(async () => []),
}));

/** The slot's title is the only user-visible statement of what it thinks it is. */
const AVAILABLE = /^Available: /;
const YOUR_BOOKING = /^Your booking: /;

const renderGrid = (onBookSession: (id: string) => void | Promise<unknown>) =>
  render(
    <MemoryRouter>
      <CalendarGrid
        sessions={[session] as never}
        onBookSession={onBookSession as never}
        bookingLoading={null}
      />
    </MemoryRouter>
  );

const confirmTheSlot = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByTitle(AVAILABLE));
  await user.click(await screen.findByRole('button', { name: 'Confirm' }));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CalendarGrid - the optimistic booking mark', () => {
  it('unwinds the mark when the booking call rejects', async () => {
    const user = userEvent.setup();
    const onBookSession = vi.fn(async () => {
      throw new Error('booking failed');
    });

    renderGrid(onBookSession);
    await confirmTheSlot(user);

    await waitFor(() => expect(onBookSession).toHaveBeenCalledWith('sess-1'));
    expect(screen.queryByTitle(YOUR_BOOKING)).not.toBeInTheDocument();
    expect(screen.getByTitle(AVAILABLE)).toBeInTheDocument();
  });

  it('leaves the slot clickable again after a failure', async () => {
    const user = userEvent.setup();
    const onBookSession = vi.fn(async () => {
      throw new Error('booking failed');
    });

    renderGrid(onBookSession);
    await confirmTheSlot(user);
    await waitFor(() => expect(onBookSession).toHaveBeenCalledTimes(1));

    // The dead end this guards: if the slot still counts as booked, canClick is
    // false, the confirmation popover never reopens and there is no way to
    // retry from the grid at all.
    await user.click(screen.getByTitle(AVAILABLE));
    expect(await screen.findByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('keeps the mark when the booking call resolves', async () => {
    const user = userEvent.setup();
    const onBookSession = vi.fn(async () => undefined);

    renderGrid(onBookSession);
    await confirmTheSlot(user);

    // Guards the over-correction: unwinding on every outcome would pass both
    // tests above and quietly undo every successful booking on screen.
    expect(await screen.findByTitle(YOUR_BOOKING)).toBeInTheDocument();
  });
});
