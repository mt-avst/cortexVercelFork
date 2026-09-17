/**
 * TZ pinned BEFORE any import (vitest runs each file in its own module context,
 * so this has to be the very first statement). W2's merge pipeline failed on a
 * hardcoded GMT+1 assertion measured on a UTC CI runner - the band's summary
 * and the grid's labels are time-bearing, so this suite pins Europe/London and
 * restores it in afterAll, and every date fixture is either fully explicit or
 * derived from `Date.now()` (never a bare hour that drifts across zones).
 */
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Europe/London';

import React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability, getMyCalendarEvents } from '../../api/client';

/**
 * D11 - the Session Management redraw (approved wireframe PNM41RsfTkKJiQW48KoPtv).
 *
 * Summary-first: a status band; the chip wall becomes a time-axis grid (days as
 * rows, hours as columns) with distinct available / booked / calendar-conflict /
 * past states and a legend; the generator moves into a side panel defaulting to
 * working hours. Built ON TOP of W2's truth fixes - those are guarded by their
 * own suites and must stay green.
 */

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  createSessions: vi.fn(async () => []),
  deleteSession: vi.fn(async () => undefined),
  deleteAllSessions: vi.fn(async () => undefined),
  calendarConnectUrl: vi.fn(() => '/connect'),
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

/** A weekday, so it lands in a drawn grid row (weekends are suppressed). */
const futureWeekday = (minDaysAhead = 3) => {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
};

/** A 30-minute availability slot at hour:minute on a future weekday. */
const slotAt = (hour: number, minute = 0) => {
  const start = futureWeekday(3);
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), duration_minutes: 30 };
};

const sessionRow = (
  id: string,
  startIso: string,
  endIso: string,
  overrides: Partial<{ booked_count: number; remaining: number; capacity: number }> = {}
) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: startIso,
  end_time: endIso,
  capacity: overrides.capacity ?? 1,
  booked_count: overrides.booked_count ?? 0,
  remaining: overrides.remaining ?? 1,
  location_or_meet_link_optional: '',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
});

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};
const daysAhead = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(getAvailability).mockResolvedValue({
    available_slots: [slotAt(10)],
    total_slots: 1,
    duration_minutes: 30,
    time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
  } as never);
  vi.mocked(getMyCalendarEvents).mockResolvedValue([] as never);
});

describe('D11 - summary-first status band', () => {
  it('reads "No slots yet" when the study has no sessions', async () => {
    renderManager({ sessions: [] });
    await settle();

    const band = await screen.findByTestId('session-status-band');
    expect(band).toHaveTextContent(/no slots yet/i);
  });

  it('summarises total, bookable, booked and past across sessions', async () => {
    // 1 upcoming open (bookable), 1 upcoming fully booked (booked, not bookable),
    // 1 past (out of both). Total 3.
    const openStart = daysAhead(6);
    const openEnd = new Date(openStart.getTime() + 60 * 60 * 1000);
    const bookedStart = daysAhead(7);
    const bookedEnd = new Date(bookedStart.getTime() + 60 * 60 * 1000);
    const pastStart = daysAgo(6);
    const pastEnd = new Date(pastStart.getTime() + 60 * 60 * 1000);

    renderManager({
      sessions: [
        sessionRow('open', openStart.toISOString(), openEnd.toISOString(), {
          capacity: 1,
          booked_count: 0,
          remaining: 1,
        }),
        sessionRow('booked', bookedStart.toISOString(), bookedEnd.toISOString(), {
          capacity: 1,
          booked_count: 1,
          remaining: 0,
        }),
        sessionRow('past', pastStart.toISOString(), pastEnd.toISOString(), {
          capacity: 1,
          booked_count: 0,
          remaining: 1,
        }),
      ] as never,
    });
    await settle();

    const band = await screen.findByTestId('session-status-band');
    const text = band.textContent ?? '';
    expect(band).not.toHaveTextContent(/no slots yet/i);
    expect(text).toMatch(/3\s*slots total/i);
    expect(text).toMatch(/1\s*bookable/i);
    expect(text).toMatch(/1\s*booked/i);
    expect(text).toMatch(/1\s*past/i);
  });
});

describe('D11 - the time-axis grid (days as rows, hours as columns)', () => {
  it('lays days out as rows and hours as columns', async () => {
    renderManager();
    await settle();

    const grid = await screen.findByRole('grid', { name: /days as rows/i });
    // Hours are the columns: the 10:00 slot's hour has a column header.
    const columnHeaders = within(grid)
      .getAllByRole('columnheader')
      .map((h) => h.textContent?.trim());
    expect(columnHeaders).toContain('10');
    // Days are the rows: at least one day row header is present.
    expect(within(grid).getAllByRole('rowheader').length).toBeGreaterThan(0);
  });

  it('draws an available slot as an enabled, pickable button', async () => {
    renderManager();
    await settle();

    const grid = await screen.findByRole('grid', { name: /days as rows/i });
    const available = within(grid).getByRole('button', { name: /available time slot/i });
    expect(available).toBeEnabled();
    expect(available).toHaveAttribute('aria-pressed', 'false');
  });

  it('draws a calendar-conflict slot as a disabled button, never an image', async () => {
    const day = futureWeekday(3);
    const conflictStart = new Date(day);
    conflictStart.setHours(10, 0, 0, 0);
    const conflictEnd = new Date(conflictStart.getTime() + 30 * 60 * 1000);
    vi.mocked(getMyCalendarEvents).mockResolvedValue([
      {
        id: 'evt-1',
        title: 'Standup',
        start: conflictStart.toISOString(),
        end: conflictEnd.toISOString(),
        startTime: conflictStart,
        endTime: conflictEnd,
        status: 'confirmed',
        attendees: [],
      },
    ] as never);

    renderManager();
    await settle();

    const conflict = await screen.findByTitle(
      /conflicts with existing calendar events/i
    );
    // A real disabled control, not a role="img" tile - the a11y fix W2 shipped
    // for the chip table, carried into the grid.
    expect(conflict.closest('[role="img"]')).toBeNull();
    const button = conflict.closest('button');
    expect(button).not.toBeNull();
    expect(button).toBeDisabled();
  });

  it('names the four cell states in a legend', async () => {
    renderManager();
    await settle();

    const legend = await screen.findByTestId('session-grid-legend');
    expect(legend).toHaveTextContent(/available/i);
    expect(legend).toHaveTextContent(/booked/i);
    expect(legend).toHaveTextContent(/conflict/i);
    expect(legend).toHaveTextContent(/past/i);
  });
});

describe('D11 - past sessions stay out of the count', () => {
  it('keeps a past session out of the band bookable figure and groups it apart', async () => {
    const pastStart = daysAgo(6);
    const pastEnd = new Date(pastStart.getTime() + 60 * 60 * 1000);
    const futureStart = daysAhead(6);
    const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000);

    renderManager({
      sessions: [
        sessionRow('past', pastStart.toISOString(), pastEnd.toISOString()),
        sessionRow('future', futureStart.toISOString(), futureEnd.toISOString()),
      ] as never,
    });
    await settle();

    const band = await screen.findByTestId('session-status-band');
    // 2 total, 1 bookable (the future one), 1 past.
    expect(band.textContent ?? '').toMatch(/2\s*slots total/i);
    expect(band.textContent ?? '').toMatch(/1\s*bookable/i);
    expect(band.textContent ?? '').toMatch(/1\s*past/i);
    // And the past group is still shown apart (W2's ListView grouping).
    expect(screen.getByText('Past sessions')).toBeInTheDocument();
  });
});

describe('D11 - the generator lives in a side panel', () => {
  it('defaults the working hours to 09:00 and 17:00', async () => {
    renderManager();
    await settle();

    const start = (await screen.findByLabelText(/working hours start/i)) as HTMLSelectElement;
    const end = (await screen.findByLabelText(/working hours end/i)) as HTMLSelectElement;
    expect(start.value).toBe('9');
    expect(end.value).toBe('17');
  });

  it('keeps the add-a-single-slot control and the slot-length and weekend controls', async () => {
    renderManager();
    await settle();

    expect(screen.getByLabelText('Add a slot: date')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add slot/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Timeslot \(mins\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/include weekends/i)).toBeInTheDocument();
  });

  it('states that slots save as they are added or removed', async () => {
    renderManager();
    await settle();

    await waitFor(() =>
      expect(screen.getByText(/slots save as you add or remove/i)).toBeInTheDocument()
    );
  });
});
