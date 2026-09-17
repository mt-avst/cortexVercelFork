/**
 * TZ pinned BEFORE any import (vitest runs each file in its own module
 * context, so this must be the very first statement): the assertion below
 * checks the exact rendered string "Fri 11 Sept, 19:00-19:45 GMT+1", which is
 * only what a Europe/London (BST) reader sees. A UTC CI runner rendered
 * "18:00-18:45 GMT+0" for the identical fixture and failed by finding
 * nothing - this test passed locally only because the author's machine is in
 * Europe/London. Pinning makes the string deterministic on ANY runner rather
 * than switching to a looser, TZ-tolerant matcher that would prove the
 * format less precisely.
 *
 * Restored in `afterAll` because `process.env` is a real process-level
 * global, not scoped per test file - vitest's module isolation does not
 * protect against a worker thread running a LATER file with the mutated TZ
 * still set, if that worker is reused across files.
 */
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Europe/London';

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability } from '../../api/client';

/**
 * Row 33 of the 2026-09-17 study-setup redesign (verifier claim 19).
 *
 * Two FULL `formatDateTime` calls - one per column - each repeated the
 * weekday, year and zone, wrapping a 29-character string over five lines in
 * an 84px-wide "Start Time" column while the single-digit Capacity and Booked
 * columns sat at 77-102px next to it. The fix is one line per session
 * ("Fri 11 Sept, 19:00-19:45 GMT+1") and one combined booked/capacity reading
 * ("1 of 1 booked").
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
  vi.mocked(getAvailability).mockResolvedValue({
    available_slots: [],
    total_slots: 0,
    duration_minutes: 30,
    time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
  } as never);
});

describe('AdminSessionManager - the Existing Sessions row reads in one line (row 33)', () => {
  it('renders the session date and time range as a single string, not two full-length columns', async () => {
    // Fri 11 Sept 2026, a fixed BST date so the zone offset in the assertion
    // is stable regardless of when this suite runs.
    const start = new Date('2026-09-11T18:00:00.000Z'); // 19:00 BST (GMT+1)
    const end = new Date('2026-09-11T18:45:00.000Z'); // 19:45 BST

    renderManager({
      sessions: [
        {
          id: 's1',
          opportunity_id: 'opp-1',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          capacity: 1,
          booked_count: 1,
          remaining: 0,
          location_or_meet_link_optional: '',
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ] as never,
    });
    await settle();

    const table = await screen.findByRole('table');
    // One node, one line: date, time range and zone together, no separate
    // Start Time / End Time columns repeating the weekday and year twice.
    expect(within(table).getByText(/Fri 11 Sept, 19:00-19:45 GMT\+1/)).toBeInTheDocument();
    expect(within(table).queryByText('Start Time')).not.toBeInTheDocument();
    expect(within(table).queryByText('End Time')).not.toBeInTheDocument();
  });

  it('combines Capacity and Booked into one "N of M booked" reading', async () => {
    const start = new Date('2026-09-11T18:00:00.000Z');
    const end = new Date('2026-09-11T18:45:00.000Z');

    renderManager({
      sessions: [
        {
          id: 's1',
          opportunity_id: 'opp-1',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          capacity: 1,
          booked_count: 1,
          remaining: 0,
          location_or_meet_link_optional: '',
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ] as never,
    });
    await settle();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('1 of 1 booked')).toBeInTheDocument();
    expect(within(table).queryByText('Capacity')).not.toBeInTheDocument();
  });
});
