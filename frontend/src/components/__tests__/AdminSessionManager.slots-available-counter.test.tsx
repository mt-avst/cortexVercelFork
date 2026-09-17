import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability, getMyCalendarEvents } from '../../api/client';

/**
 * Row 8 of the 2026-09-17 study-setup redesign (verifier claim 12).
 *
 * "159 slots available" counted every generated grid cell, including 30 that
 * clash with the researcher's own calendar and cannot be selected - so
 * "Select all" across every day summed to 129, not 159. The counter has to
 * report what a researcher can actually pick, not what the generator drew.
 *
 * The conflict cells were also `role="img"`, telling a screen-reader user an
 * image sits where a slot should be, rather than a disabled control.
 */

const futureWeekday = (minDaysAhead = 3) => {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
};

// One weekday, 09:00-12:00 in 30-minute slots: 6 generated cells.
const generatedGridFor = (day: Date) => {
  const slots = [];
  for (let hour = 9; hour < 12; hour++) {
    for (const minute of [0, 30]) {
      const start = new Date(day);
      start.setHours(hour, minute, 0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      slots.push({ start: start.toISOString(), end: end.toISOString(), duration_minutes: 30 });
    }
  }
  return slots;
};

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(),
  createSessions: vi.fn(async () => []),
  deleteSession: vi.fn(async () => undefined),
  deleteAllSessions: vi.fn(async () => undefined),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

type ManagerProps = React.ComponentProps<typeof AdminSessionManager>;

const renderManager = (props: Partial<ManagerProps> = {}) =>
  render(
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  const day = futureWeekday(3);
  const slots = generatedGridFor(day);
  vi.mocked(getAvailability).mockResolvedValue({
    available_slots: slots,
    total_slots: slots.length,
    duration_minutes: 30,
    time_range: { start: slots[0].start, end: slots[slots.length - 1].end },
  } as never);
  // Two of the six generated slots (09:00 and 10:30) clash with a diary event.
  const conflictStart = new Date(day);
  conflictStart.setHours(9, 0, 0, 0);
  const conflictEnd = new Date(conflictStart.getTime() + 30 * 60 * 1000);
  const secondStart = new Date(day);
  secondStart.setHours(10, 30, 0, 0);
  const secondEnd = new Date(secondStart.getTime() + 30 * 60 * 1000);
  vi.mocked(getMyCalendarEvents).mockResolvedValue([
    {
      id: 'evt-1',
      title: 'Team standup',
      start: conflictStart.toISOString(),
      end: conflictEnd.toISOString(),
      startTime: conflictStart,
      endTime: conflictEnd,
      status: 'confirmed',
      attendees: [],
    },
    {
      id: 'evt-2',
      title: '1:1',
      start: secondStart.toISOString(),
      end: secondEnd.toISOString(),
      startTime: secondStart,
      endTime: secondEnd,
      status: 'confirmed',
      attendees: [],
    },
  ] as never);
});

describe('AdminSessionManager - the slots-available counter equals the selectable slots (row 8)', () => {
  it('counts only the slots a researcher can actually pick, not the calendar-conflict cells', async () => {
    renderManager();
    await settle();

    // Since D11 the default surface is the time-axis grid: pickable slots are
    // its enabled "available time slot" cell buttons, and the readout counts
    // the same set.
    const pickable = await screen.findAllByRole('button', { name: /available time slot/i });
    const headline = await screen.findByText(/\d+ slots available/i);
    const headlineCount = Number(headline.textContent!.match(/(\d+) slots available/i)![1]);

    // 6 generated, 2 in conflict: 4 pickable, and the headline must say 4, not 6.
    expect(pickable).toHaveLength(4);
    expect(headlineCount).toBe(4);
    // Every pickable cell is a real, enabled button (not a conflict/past one).
    pickable.forEach((cell) => expect(cell).toBeEnabled());
  });

  it('agrees with the Table view counter on the Calendar (grid) view too (follow-up)', async () => {
    // The Table view fix (`tableSlotCount`) excluded conflict cells; the grid
    // view's own counter (`drawnSlots.length`) did not, so switching views
    // re-inflated "4 slots available" back to "6 slots available" on the
    // exact same underlying data - same fixture as the test above.
    renderManager();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await settle();

    const headline = await screen.findByText(/\d+ slots available/i);
    const headlineCount = Number(headline.textContent!.match(/(\d+) slots available/i)![1]);
    expect(headlineCount).toBe(4);
  });

  it('does not announce a calendar-conflict cell as an image', async () => {
    renderManager();
    await settle();

    const conflictChip = await screen.findByTitle(
      /09:00 to 09:30 - This time slot conflicts with existing calendar events/i
    );
    expect(conflictChip.closest('[role="img"]')).toBeNull();
    expect(conflictChip.closest('button')).not.toBeNull();
    expect(conflictChip.closest('button')).toBeDisabled();
  });
});
