import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import CalendarGrid from '../CalendarGrid';

/**
 * BK-4: the grid draws every slot time in the reader's OWN zone (formatTime
 * uses Date#getHours), and named that zone nowhere. The table view labels each
 * row with its offset; the grid left the reader to assume the times were
 * theirs, which is how a booking once landed "an hour out". The grid now
 * carries a single zone caption. These pin that it is present - and present
 * whether or not the legend is - so a slot time can no longer float unlabelled.
 */

vi.mock('../../api/client', () => ({
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
  getMyCalendarEvents: vi.fn(async () => []),
}));

const sessionOn = (day: string, id = `sess-${day}`) => {
  const start = new Date(`${day}T10:00:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    id,
    opportunity_id: 'opp-1',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    capacity: 3,
    remaining: 3,
  };
};

const renderGrid = (sessions: ReturnType<typeof sessionOn>[], hideLegend = false) =>
  render(
    <MemoryRouter>
      <CalendarGrid
        sessions={sessions as never}
        onBookSession={vi.fn() as never}
        bookingLoading={null}
        hideLegend={hideLegend}
      />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  // A future week so no fixture reads as past and the grid renders its slots.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-01T09:00:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

// The parenthesised offset is runner-zone-dependent (and correctly absent on a
// DST-straddling week), so these assert the caption prose. The offset-collapse
// logic itself is pinned deterministically in datetime.test.ts (sharedZoneOffset).
const zoneCaption = /Times shown in your time zone/;

describe('CalendarGrid - time zone caption (BK-4)', () => {
  it('labels the zone the grid times are drawn in', () => {
    renderGrid([sessionOn('2026-09-07')]);
    expect(screen.getByText(zoneCaption)).toBeInTheDocument();
  });

  it('still shows the zone when the legend is hidden (parent renders it elsewhere)', () => {
    renderGrid([sessionOn('2026-09-07')], true);
    // The legend is suppressed...
    expect(screen.queryByText('Available')).not.toBeInTheDocument();
    // ...but the zone caption is not part of the legend and must survive.
    expect(screen.getByText(zoneCaption)).toBeInTheDocument();
  });
});
