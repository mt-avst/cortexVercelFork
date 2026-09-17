import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability } from '../../api/client';

/**
 * Row 9 of the 2026-09-17 study-setup redesign.
 *
 * The Existing Sessions summary ("Total slots: N / Remaining: N") summed
 * EVERY session's capacity and remaining count, including ones whose end time
 * has already passed - so a study with one future session and one that ran six
 * days ago read "Total slots: 4" (2 + 2) instead of 2. Past sessions must be
 * grouped, visibly tagged, and left out of the count.
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
    available_slots: [],
    total_slots: 0,
    duration_minutes: 30,
    time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
  } as never);
});

describe('AdminSessionManager - past sessions are grouped and excluded from the count (row 9)', () => {
  it('counts only the future session in Total slots / Remaining', async () => {
    const past = daysAgo(6);
    const pastEnd = new Date(past.getTime() + 60 * 60 * 1000);
    const future = daysAhead(6);
    const futureEnd = new Date(future.getTime() + 60 * 60 * 1000);

    renderManager({
      sessions: [
        sessionRow('past', past.toISOString(), pastEnd.toISOString()),
        sessionRow('future', future.toISOString(), futureEnd.toISOString()),
      ] as never,
    });
    await settle();

    expect(await screen.findByText(/Total slots: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Remaining: 2/)).toBeInTheDocument();
  });

  it('tags a past session and keeps it visually apart from upcoming ones', async () => {
    const past = daysAgo(6);
    const pastEnd = new Date(past.getTime() + 60 * 60 * 1000);

    renderManager({ sessions: [sessionRow('past', past.toISOString(), pastEnd.toISOString())] as never });
    await settle();

    expect(await screen.findByText('Past sessions')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Past')).toBeInTheDocument();
  });
});
