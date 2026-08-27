import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability, getMyCalendarEvents } from '../../api/client';

/**
 * cto/AdaptaLabs#89.
 *
 * No production user has calendar tokens - `/api/calendar/auth/connect` was
 * deleted and login is Okta/OIDC - so `GET /api/calendar/my-events` answers
 * 404 `Calendar not connected` for everyone, permanently.
 *
 * `loadCalendarData` awaited that call and `getAvailability` in ONE
 * `Promise.all`, so the 404 rejected the pair and `setAvailableSlots` never
 * ran. `/api/calendar/availability` needs no connected calendar and had
 * returned a full working-hours grid; the researcher saw "No available slots"
 * on every column and could not create a bookable slot through the UI at all.
 *
 * The two calls are independent - busy events only DIM slots - so a failure to
 * read one researcher's calendar must not be able to empty the grid.
 */

const slot = (startIso: string, endIso: string) => ({
  start: startIso,
  end: endIso,
  duration_minutes: Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000
  ),
});

/**
 * The next WEEKDAY at this time, inside the component's own default date range
 * (startDate = tomorrow, endDate = +7 days). A fixed date would fall out of
 * range and pass for the wrong reason.
 *
 * Weekday, not simply tomorrow. `excludeWeekends` defaults TRUE, so the grid
 * gives a Saturday or Sunday no column at all and a slot placed there is never
 * drawn. A `tomorrow` fixture therefore passed Sunday to Thursday and FAILED
 * EVERY FRIDAY AND SATURDAY - measured on Friday 2026-08-28, three tests red on
 * a clean `main` for no reason but the day of the week.
 *
 * The sibling suite `AdminSessionManager.manual-slots.test.tsx` already had this
 * fix; it was not carried across to here, which is how the same defect shipped
 * twice.
 */
const tomorrowAt = (hour: number, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  d.setHours(hour, minute, 0, 0);
  return d;
};

const notConnected = () => {
  const error = new Error('Request failed with status code 404') as Error & {
    response?: { status: number; data: { error: string; connected: boolean } };
  };
  error.response = { status: 404, data: { error: 'Calendar not connected', connected: false } };
  return error;
};

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(),
  createSessions: vi.fn().mockResolvedValue([]),
  deleteAllSessions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

// Props are typed from the component rather than cast, so an override that
// stops matching the component's contract fails typecheck here instead of
// silently doing nothing at runtime.
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
});

describe('AdminSessionManager - an unconnected calendar cannot empty the grid (#89)', () => {
  it('renders availability when /my-events answers 404 Calendar not connected', async () => {
    const start = tomorrowAt(10);
    const end = tomorrowAt(10, 30);

    vi.mocked(getMyCalendarEvents).mockRejectedValue(notConnected());
    vi.mocked(getAvailability).mockImplementation(async () => ({
      available_slots: [slot(start.toISOString(), end.toISOString())],
      total_slots: 1,
      duration_minutes: 30,
      time_range: { start: start.toISOString(), end: end.toISOString() },
    }));

    renderManager();
    await settle();

    // The slot the availability endpoint returned is on screen, and the grid is
    // NOT claiming every column is empty. Asserting only the absence of the
    // empty-state message would pass on a grid that rendered nothing at all.
    // The slot the availability endpoint returned is drawn, and it is a live
    // control rather than a caption: before the fix the grid held no slot
    // elements at all. Asserting only the absence of the empty-state message
    // would pass on a grid that rendered nothing - and would be wrong anyway,
    // since the other four weekday columns legitimately have no slots.
    const label = await screen.findByText('10:00 - 10:30');
    expect(label).toBeInTheDocument();
    expect(label.closest('[class*="timeslot"]')).not.toBeNull();
  });

  it('says the calendar is not connected rather than reporting a failure', async () => {
    const start = tomorrowAt(10);
    const end = tomorrowAt(10, 30);

    vi.mocked(getMyCalendarEvents).mockRejectedValue(notConnected());
    vi.mocked(getAvailability).mockImplementation(async () => ({
      available_slots: [slot(start.toISOString(), end.toISOString())],
      total_slots: 1,
      duration_minutes: 30,
      time_range: { start: start.toISOString(), end: end.toISOString() },
    }));

    renderManager();
    await settle();

    // The researcher is told their own calendar is not being consulted - the
    // slots on screen are unchecked against their busy time. Silence here is
    // how "the calendar is connected" gets believed.
    expect(
      await screen.findByText(/calendar is not connected/i)
    ).toBeInTheDocument();
  });

  it('still surfaces a genuine availability failure', async () => {
    // The control for the two tests above: making /my-events non-fatal must not
    // make the grid silent when the call that actually produces slots fails.
    vi.mocked(getMyCalendarEvents).mockResolvedValue([]);
    vi.mocked(getAvailability).mockRejectedValue(
      Object.assign(new Error('boom'), {
        response: { data: { error: 'Availability lookup failed' } },
      })
    );

    renderManager();
    await settle();

    expect(await screen.findByText(/Availability lookup failed/)).toBeInTheDocument();
  });
});

describe('AdminSessionManager - "not connected" and "could not be read" are told apart (#89)', () => {
  const withSlots = () => {
    const start = tomorrowAt(11);
    const end = tomorrowAt(11, 30);
    vi.mocked(getAvailability).mockImplementation(async () => ({
      available_slots: [slot(start.toISOString(), end.toISOString())],
      total_slots: 1,
      duration_minutes: 30,
      time_range: { start: start.toISOString(), end: end.toISOString() },
    }));
  };

  it('reports a 500 as unreadable, not as unconnected', async () => {
    withSlots();
    const fault = new Error('Request failed with status code 500') as Error & {
      response?: { status: number };
    };
    fault.response = { status: 500 };
    vi.mocked(getMyCalendarEvents).mockRejectedValue(fault);

    renderManager();
    await settle();

    // The two states mean the same thing to the grid and very different things
    // to whoever has to diagnose it. Collapsing them - which is what a bare
    // `catch` here would do - is what this pins.
    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText(/is not connected/i)).not.toBeInTheDocument();
  });

  it('says nothing at all once the calendar reads cleanly', async () => {
    withSlots();
    vi.mocked(getMyCalendarEvents).mockResolvedValue([]);

    renderManager();
    await settle();

    // The control for both notices: a connected calendar must not be nagged
    // about. A notice that shows unconditionally is indistinguishable from a
    // correct one in the two tests above.
    expect(await screen.findByText('11:00 - 11:30')).toBeInTheDocument();
    expect(screen.queryByText(/is not connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
  });
});
