import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import CalendarGrid from '../CalendarGrid';
import { getMyCalendarEvents } from '../../api/client';

/**
 * BK-2 (calendar view): a slot that clashes with the participant's own diary
 * showed a generic "Calendar conflict: ..." tooltip, naming nothing. This pins
 * the tooltip naming the clashing event instead ("Clashes with 'Team standup',
 * ...").
 */

const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
start.setHours(10, 0, 0, 0);
const end = new Date(start.getTime() + 60 * 60 * 1000);
const eventEnd = new Date(start.getTime() + 30 * 60 * 1000);

const session = {
  id: 'sess-1',
  opportunity_id: 'opp-1',
  start_time: start.toISOString(),
  end_time: end.toISOString(),
  capacity: 3,
  remaining: 3,
};

const clashingEvent = {
  id: 'evt-1',
  title: 'Team standup',
  start: start.toISOString(),
  end: eventEnd.toISOString(),
  startTime: start,
  endTime: eventEnd,
  status: 'confirmed',
  attendees: [],
};

vi.mock('../../api/client', () => ({
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: true, connectedAt: null })),
  getMyCalendarEvents: vi.fn(async () => []),
}));

const renderGrid = () =>
  render(
    <MemoryRouter>
      <CalendarGrid
        sessions={[session] as never}
        onBookSession={(vi.fn() as never)}
        bookingLoading={null}
      />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMyCalendarEvents).mockResolvedValue([clashingEvent] as never);
});

describe('CalendarGrid - BK-2 name the calendar clash', () => {
  it('names the clashing event in the slot tooltip', async () => {
    renderGrid();

    expect(await screen.findByTitle(/Clashes with 'Team standup'/i)).toBeInTheDocument();
    // The old generic wording is gone.
    expect(screen.queryByTitle(/^Calendar conflict:/i)).not.toBeInTheDocument();
  });
});
