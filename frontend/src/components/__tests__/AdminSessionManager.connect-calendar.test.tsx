import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability, getMyCalendarEvents } from '../../api/client';

/**
 * cto/AdaptaLabs#89 - the "not connected" notice offers a way OUT of that state,
 * but only where one exists.
 *
 * On a deployment with no Google OAuth client, `/api/calendar/auth/connect`
 * answers 503, and the consent URL it would otherwise build points back at our
 * own callback with `code=demo` and mints FABRICATED tokens. So a Connect
 * button that appeared unconditionally would either dead-end on an error page
 * or, worse, succeed and leave the researcher trusting invented busy time.
 *
 * The deployment's answer arrives on the my-events 404 body as `available`.
 */

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(),
  createSessions: vi.fn(async () => []),
  deleteAllSessions: vi.fn(async () => undefined),
  calendarConnectUrl: () => 'https://app.example.test/api/calendar/auth/connect',
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

/**
 * The next WEEKDAY at this time, inside the component's default date range.
 *
 * Weekday, not simply tomorrow: `excludeWeekends` defaults TRUE, so the grid
 * gives a Saturday or Sunday no column and a slot placed there is never drawn.
 * A `tomorrow` fixture passed Sunday to Thursday and FAILED EVERY FRIDAY AND
 * SATURDAY - measured on Friday 2026-08-28, red on a clean `main` for no reason
 * but the day of the week.
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

const notConnected = (available: boolean) => {
  const error = new Error('Request failed with status code 404') as Error & {
    response?: { status: number; data: { error: string; connected: boolean; available: boolean } };
  };
  error.response = {
    status: 404,
    data: { error: 'Calendar not connected', connected: false, available },
  };
  return error;
};

const withOneSlot = () => {
  const start = tomorrowAt(10);
  const end = tomorrowAt(10, 30);
  vi.mocked(getAvailability).mockImplementation(async () => ({
    available_slots: [
      {
        start: start.toISOString(),
        end: end.toISOString(),
        duration_minutes: 30,
      },
    ],
    total_slots: 1,
    duration_minutes: 30,
    time_range: { start: start.toISOString(), end: end.toISOString() },
  }));
};

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

describe('AdminSessionManager - a way to connect the calendar (#89)', () => {
  it('offers a Connect link where the deployment can start the flow', async () => {
    withOneSlot();
    vi.mocked(getMyCalendarEvents).mockRejectedValue(notConnected(true));

    renderManager();
    await settle();

    const link = await screen.findByRole('link', { name: /Connect your calendar/i });
    // A real navigation target, not a button that swallows the click: the route
    // answers a 302 to Google's consent screen, which XHR cannot follow.
    expect(link).toHaveAttribute('href', 'https://app.example.test/api/calendar/auth/connect');
  });

  it('offers nothing where the deployment cannot start the flow', async () => {
    withOneSlot();
    vi.mocked(getMyCalendarEvents).mockRejectedValue(notConnected(false));

    renderManager();
    await settle();

    // The notice still appears - the researcher is still told - but the control
    // that would dead-end on a 503 does not.
    expect(await screen.findByText(/calendar is not connected/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Connect your calendar/i })).not.toBeInTheDocument();
  });

  it('offers nothing when the flag is absent entirely', async () => {
    // An older backend, or a 404 body that never grew the field. Defaulting to
    // "offer it" would put the dead-end button on exactly the deployments that
    // cannot support it.
    withOneSlot();
    const bare = new Error('404') as Error & { response?: { status: number; data: unknown } };
    bare.response = { status: 404, data: { error: 'Calendar not connected' } };
    vi.mocked(getMyCalendarEvents).mockRejectedValue(bare);

    renderManager();
    await settle();

    expect(await screen.findByText(/calendar is not connected/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Connect your calendar/i })).not.toBeInTheDocument();
  });

  it('offers nothing once the calendar reads cleanly', async () => {
    // The control for all three above: a connected researcher must not be asked
    // to connect. A link rendered unconditionally satisfies the first test.
    withOneSlot();
    vi.mocked(getMyCalendarEvents).mockResolvedValue([]);

    renderManager();
    await settle();

    expect(await screen.findByText('10:00 - 10:30')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Connect your calendar/i })).not.toBeInTheDocument();
  });
});
