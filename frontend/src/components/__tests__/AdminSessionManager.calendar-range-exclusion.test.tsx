import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability } from '../../api/client';

/**
 * Row 39 of the 2026-09-17 study-setup redesign (verifier claim 25, Calendar
 * view section).
 *
 * The Calendar view's date-range picker defaults to tomorrow..+7 days. A
 * session's OWN date is never checked against that range before deciding
 * whether to draw it: `allDays` is bounded by the range, the render loop only
 * ever visits days in `allDays`, and a session dated outside it is never
 * looked up - not drawn, not counted, and nothing on screen says so. The Table
 * view's own list shows every session regardless of date, which is exactly why
 * this defect is Calendar-view-only.
 */

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
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

// Well before the default tomorrow..+7 window, same shape as the sibling
// out-of-range-hours fixture in AdminSessionManager.out-of-range-sessions.test.tsx.
const sessionOutsideRange = (id: string) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: '2026-08-18T18:00:00.000Z',
  end_time: '2026-08-18T19:00:00.000Z',
  capacity: 1,
  booked_count: 0,
  remaining: 1,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(getAvailability).mockResolvedValue({
    available_slots: [],
    total_slots: 0,
    duration_minutes: 30,
    time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
  } as never);
});

describe('AdminSessionManager - Calendar view states sessions it cannot draw (row 39)', () => {
  it('names an existing session outside the drawn date range, on the Calendar view', async () => {
    renderManager({ sessions: [sessionOutsideRange('out-of-range')] as never });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await settle();

    expect(
      screen.getByText(/1 existing session.*(falls|is) outside/i)
    ).toBeInTheDocument();
  });

  it('says nothing is excluded when every session falls inside the drawn range', async () => {
    const start = new Date();
    start.setDate(start.getDate() + 2);
    while (start.getDay() === 0 || start.getDay() === 6) {
      start.setDate(start.getDate() + 1);
    }
    start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    renderManager({
      sessions: [
        {
          id: 'in-range',
          opportunity_id: 'opp-1',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          capacity: 1,
          booked_count: 0,
          remaining: 1,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ] as never,
    });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await settle();

    expect(screen.queryByText(/existing session.*(falls|is) outside/i)).not.toBeInTheDocument();
  });

  it('names the weekend toggle, not "outside the range", for a weekend session INSIDE the window (follow-up)', async () => {
    // Follow-up to the Opus review: `daysInRange(startDate, endDate,
    // excludeWeekends)` was used to decide "drawn", which bakes the weekend
    // toggle into "in range" - a Saturday inside the picked dates was reported
    // as "falls outside" them, which is false. It is inside the dates and
    // hidden by "Include weekends" being off.
    //
    // The default window is tomorrow..+7 days - 7 consecutive days, which is
    // guaranteed to contain a Saturday and a Sunday - so this finds the first
    // one rather than hard-coding a date that would eventually roll out of
    // range.
    const day = new Date();
    day.setDate(day.getDate() + 1);
    while (day.getDay() !== 0 && day.getDay() !== 6) {
      day.setDate(day.getDate() + 1);
    }
    day.setHours(10, 0, 0, 0);
    const end = new Date(day.getTime() + 30 * 60 * 1000);

    renderManager({
      sessions: [
        {
          id: 'weekend-in-range',
          opportunity_id: 'opp-1',
          start_time: day.toISOString(),
          end_time: end.toISOString(),
          capacity: 1,
          booked_count: 0,
          remaining: 1,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ] as never,
    });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await settle();

    expect(
      screen.getByText(/1 existing session on a weekend is hidden while weekends are excluded/i)
    ).toBeInTheDocument();
    // Not the out-of-range wording: this session IS inside the picked dates.
    expect(screen.queryByText(/falls outside/i)).not.toBeInTheDocument();
  });
});
