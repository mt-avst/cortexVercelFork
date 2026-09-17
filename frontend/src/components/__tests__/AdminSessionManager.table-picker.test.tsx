import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability } from '../../api/client';

/**
 * The Table view is a slot PICKER, not a read-only list (Mav & Petra: table
 * first, calendar optional). The researcher chooses slots from day-grouped
 * chips here and never has to switch to the calendar to select.
 *
 * These assertions fail by name on the pre-change component, where the default
 * Table view rendered the existing-sessions list and drew no pickable slot.
 */

// The contiguous :00/:30 grid /api/calendar/availability actually returns,
// for one weekday.
const generatedGridFor = (day: Date, durationMinutes = 30) => {
  const slots = [];
  for (let hour = 8; hour < 18; hour++) {
    for (let minute = 0; minute < 60; minute += durationMinutes) {
      const start = new Date(day);
      start.setHours(hour, minute, 0, 0);
      const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
      slots.push({
        start: start.toISOString(),
        end: end.toISOString(),
        duration_minutes: durationMinutes,
      });
    }
  }
  return slots;
};

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  createSessions: vi.fn(async () => []),
  deleteAllSessions: vi.fn(async () => undefined),
  calendarConnectUrl: vi.fn(() => '/connect'),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

type ManagerProps = React.ComponentProps<typeof AdminSessionManager>;

// A weekday at least `minDaysAhead` out - weekend columns are suppressed by
// default, so a weekend fixture would flake by day of week.
const futureWeekday = (minDaysAhead = 3) => {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
};

// An existing session at the generated 10:00 slot on the same future weekday,
// so getSessionForSlot (±1s) marks that candidate as an existing session.
const existingSessionAt10 = () => {
  const start = futureWeekday(3);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    id: 'sess-10',
    opportunity_id: 'opp-1',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    capacity: 1,
    booked_count: 0,
    remaining: 1,
    location_or_meet_link_optional: '',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
};

// Renders and switches to the chip Table view - the picker under test. Since
// D11 the default surface is the time-axis grid; the day-grouped chip table is
// reachable through the segmented control, and this suite exercises it there.
const renderPicker = (props: Partial<ManagerProps> = {}) => {
  const utils = render(
    <MemoryRouter>
      <AdminSessionManager
        opportunityId="opp-1"
        sessions={[]}
        onSessionsChange={vi.fn()}
        defaultDurationMinutes={30}
        {...props}
      />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  return utils;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(getAvailability).mockImplementation(async () => {
    const slots = generatedGridFor(futureWeekday(3));
    return {
      available_slots: slots,
      total_slots: slots.length,
      duration_minutes: 30,
      time_range: { start: slots[0].start, end: slots[slots.length - 1].end },
    };
  });
});

describe('AdminSessionManager - Table view is the slot picker', () => {
  it('draws pickable slots as buttons with an accessible name carrying time, state and zone', async () => {
    renderPicker();

    // A free slot is a real button (not the grid's role-less div), and its
    // accessible name states what it is - the a11y gap the calendar had.
    const freeChips = await screen.findAllByRole('button', { name: /available time slot/i });
    expect(freeChips.length).toBeGreaterThan(0);
    // Zone stated once per day header.
    expect(screen.getByText(/·\s*times\s+/i)).toBeInTheDocument();
    // Each is a toggle, unpressed to begin with.
    expect(freeChips[0]).toHaveAttribute('aria-pressed', 'false');
  });

  it('selects a slot on click, from the table, without switching to the calendar', async () => {
    renderPicker();

    const freeChips = await screen.findAllByRole('button', { name: /available time slot/i });
    fireEvent.click(freeChips[0]);

    // The shared selection bar counts it, and the chip reads as pressed.
    await waitFor(() => expect(screen.getByText(/slot selected/i)).toBeInTheDocument());
    expect(screen.getByText('1')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /selected for session creation/i })
      ).toHaveAttribute('aria-pressed', 'true')
    );
  });

  it('select-all picks every free slot in the day, then clears it', async () => {
    renderPicker();

    const selectAll = await screen.findByRole('button', { name: /^select all \(\d+\)$/i });
    const offered = Number(selectAll.textContent!.match(/\((\d+)\)/)![1]);
    expect(offered).toBeGreaterThan(1);

    fireEvent.click(selectAll);
    // Count and label are separate nodes (<strong>N</strong> slots selected),
    // so assert on the summary element's whole text.
    const summary = await screen.findByText(/slots? selected/i);
    expect(summary).toHaveTextContent(new RegExp(`^\\s*${offered}\\s*slots? selected\\s*$`));

    // The same control now clears the day.
    const clear = await screen.findByRole('button', { name: /clear day/i });
    fireEvent.click(clear);
    await waitFor(() =>
      expect(screen.queryByText(/slots? selected/i)).not.toBeInTheDocument()
    );
  });

  it('states an empty range instead of drawing nothing', async () => {
    vi.mocked(getAvailability).mockImplementation(async () => ({
      available_slots: [],
      total_slots: 0,
      duration_minutes: 30,
      time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
    }));
    renderPicker();

    expect(await screen.findByText(/no slots in this date range/i)).toBeInTheDocument();
  });

  it('asks for a duration before it can offer slots', async () => {
    renderPicker();
    // Clear the duration - the picker cannot generate candidates without one.
    fireEvent.change(screen.getByLabelText(/Timeslot \(mins\)/i), { target: { value: '' } });
    expect(await screen.findByText(/choose a timeslot duration/i)).toBeInTheDocument();
  });

  it('shows an existing session as a non-interactive chip, not a delete button', async () => {
    renderPicker({ sessions: [existingSessionAt10()] as never });

    // The 10:00 slot is now an existing session. It appears in the picker, but
    // NOT as a togglable button whose click would delete it - removal lives in
    // the list beneath, which carries the booked-count guard.
    const chip = await screen.findByText('10:00 - 10:30');
    expect(chip.closest('button')).toBeNull();
    // and it is not offered as a pickable "available" slot either.
    expect(
      screen.queryByRole('button', { name: /10:00 to 10:30 - Available/i })
    ).not.toBeInTheDocument();
  });

  it('exposes a non-interactive state chip as role="img" with a name, not aria-label on a bare span (V-6)', async () => {
    renderPicker({ sessions: [existingSessionAt10()] as never });

    // Wait on the created chip's TEXT - the same settle the sibling test above
    // uses, which is stable under a loaded CI runner - then assert synchronously.
    // (A `findByRole('img', ...)` here raced the sessions-sync effect under load
    // and timed out at its default 1s; the text wait does not.)
    const label = await screen.findByText('10:00 - 10:30');
    const chip = label.closest('[role="img"]');

    // A bare <span aria-label=...> is the anti-pattern V-6 removes: a generic
    // element with an accessible name is exposed inconsistently by assistive
    // tech. role="img" makes the name a first-class label, and the name still
    // carries the slot's STATE (here, that it is an existing session).
    expect(chip).not.toBeNull();
    expect(chip).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/10:00 to 10:30 - Session:/i)
    );
  });

  it('keeps the calendar reachable as the optional view', async () => {
    renderPicker();
    // Default is Table; the toggle swaps to the calendar and back.
    expect(await screen.findByRole('button', { name: /^select all \(\d+\)$/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^select all \(\d+\)$/i })).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(await screen.findByRole('button', { name: /^select all \(\d+\)$/i })).toBeInTheDocument();
  });
});
