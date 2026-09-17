import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability } from '../../api/client';

/**
 * Row 2 of the 2026-09-17 study-setup redesign (verifier claim 13).
 *
 * `ListView`'s "No sessions yet" branch (the `sessions.length === 0` arm) had
 * exactly one call site, wrapped in `{sessions.length > 0 && (...)}` - two
 * complementary conditions, so the branch could never run. A study with zero
 * sessions said nothing at all about having zero sessions.
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

/** A weekday, so it lands in a drawn column (weekends are suppressed). */
const futureWeekday = (minDaysAhead = 3) => {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
};

/** One 30-minute slot, so the picker actually draws something to pick. */
const oneSlotAt = (hour: number) => {
  const start = futureWeekday(3);
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), duration_minutes: 30 };
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(getAvailability).mockResolvedValue({
    available_slots: [oneSlotAt(10)],
    total_slots: 1,
    duration_minutes: 30,
    time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
  } as never);
});

describe('AdminSessionManager - a study with zero sessions renders "No sessions yet" (row 2)', () => {
  it('states there are no sessions yet, alongside the still-visible picker', async () => {
    renderManager({ sessions: [] });
    await settle();

    // The picker is still the thing on screen at rest (row 6): this is not a
    // dead end, it is a status statement alongside it. Since D11 the picker is
    // the time-axis grid (days as rows, hours as columns), not the chip table.
    expect(await screen.findByRole('grid', { name: /days as rows/i })).toBeInTheDocument();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });

  it('does not duplicate the "Add slots" call to action the picker above already gives', async () => {
    // Embedded beneath the table picker, the empty-state CTA would be a second,
    // redundant way to reach the same picker that is already on screen.
    renderManager({ sessions: [] });
    await settle();

    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add slots' })).not.toBeInTheDocument();
  });
});
