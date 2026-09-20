import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability, getMyCalendarEvents } from '../../api/client';

/**
 * cto/AdaptaLabs#135. `drawnSlots` (Calendar view) and `tableSlotCount`
 * (Table view) excluded only a calendar-conflict cell, not an allocated,
 * confirmed or past one - so a researcher on either view could see an
 * inflated "N slots available" that counted cells the grid would refuse to
 * hand out. Both counters now route through the shared `isSlotPickable`
 * predicate, which also backs `describeSlot`'s per-cell `isBlocked`/`isPast`.
 *
 * System time is pinned (`Date` only - real timers stay real) so a slot's
 * past/future-ness does not depend on the wall-clock hour the suite runs at.
 */

const toDateInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A weekday, well clear of "today" so the default Start/End Date range never
// interferes, and never itself a weekend (the picker excludes weekends by
// default).
const fixedWeekday = () => {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
};

const at = (day: Date, hour: number, minute = 0) => {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
};

const sessionRow = (id: string, startIso: string, endIso: string, capacity = 2) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: startIso,
  end_time: endIso,
  capacity,
  booked_count: 0,
  remaining: capacity,
  location_or_meet_link_optional: '',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
});

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

const day = fixedWeekday();
const now = at(day, 11, 0); // 11:00 on the fixed day: 09:00/09:30 are already past.

// Six generated 30-minute cells, 09:00-12:00 on `day`:
//   09:00 - PAST (before "now")
//   09:30 - PAST
//   10:00 - ALLOCATED (overlapped by a session for another study, not an exact match)
//   10:30 - existing SESSION / CONFIRMED (exact match with a live session)
//   11:00 - pickable (control: proves the predicate can still say yes)
//   11:30 - pickable (control)
const slots = Array.from({ length: 6 }, (_, i) => {
  const start = at(day, 9 + Math.floor(i / 2), (i % 2) * 30);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), duration_minutes: 30 };
});

const allocatedSession = sessionRow(
  'alloc-1',
  at(day, 10, 0).toISOString(),
  new Date(at(day, 10, 0).getTime() + 15 * 60 * 1000).toISOString()
);
const confirmedSession = sessionRow('conf-1', at(day, 10, 30).toISOString(), at(day, 11, 0).toISOString());

const setStartDateToFixedDay = async () => {
  const input = (await screen.findByLabelText('Start Date')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: toDateInput(day) } });
};

const readHeadlineCount = async () => {
  const headline = await screen.findByText(/\d+ slots available/i);
  return Number(headline.textContent!.match(/(\d+) slots available/i)![1]);
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);

  vi.mocked(getAvailability).mockResolvedValue({
    available_slots: slots,
    total_slots: slots.length,
    duration_minutes: 30,
    time_range: { start: slots[0].start, end: slots[slots.length - 1].end },
  } as never);
  vi.mocked(getMyCalendarEvents).mockResolvedValue([] as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AdminSessionManager - slot counters exclude allocated/confirmed/past cells, not just conflicts (#135)', () => {
  it('Table view: counts only the two truly pickable cells', async () => {
    renderManager({ sessions: [allocatedSession, confirmedSession] });
    await settle();
    await setStartDateToFixedDay();
    await settle();

    // 6 generated: 2 past, 1 allocated, 1 confirmed/existing session, 2 pickable.
    expect(await readHeadlineCount()).toBe(2);
  });

  it('Calendar (grid) view: same exclusions, same count', async () => {
    renderManager({ sessions: [allocatedSession, confirmedSession] });
    await settle();
    await setStartDateToFixedDay();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await settle();

    expect(await readHeadlineCount()).toBe(2);
  });
});
