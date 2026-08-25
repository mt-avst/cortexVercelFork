import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

/**
 * GET /api/calendar/events TOOK calendar_id STRAIGHT FROM THE QUERY, guarded by
 * `requireAdmin` ALONE (#18). The response mapper emits `attendees[].email`,
 * `attendees[].name`, event `title` and `location`. It is inert only because
 * `calendarService.getCalendarEvents` is a stub returning `{ events: [] }` - the
 * same service class makes real Google calls elsewhere (`events.insert`), so
 * filling that read stub would immediately hand any researcher_admin the
 * attendee names + emails of any calendar id they name.
 *
 * The guard added in #18 is the ownership predicate that must exist BEFORE the
 * stub is filled: a caller may only name a calendar_id equal to their OWN
 * `user_calendar_tokens.calendar_id`. This file is the router's first test of
 * any kind (there was none), and it pins that predicate in both directions plus
 * a CONTROL proving the refusal arm can distinguish an owned id from an
 * arbitrary one rather than refusing everything.
 *
 * The auth double is the shared session-trusting mock (see
 * middleware/__mocks__/authenticate.ts): the real requireAdmin re-reads the DB
 * role (#14) and would consume the first queued pool.query result, shifting the
 * ownership lookup this suite queues. Auth liveness is covered elsewhere; this
 * suite tests the calendar-ownership gate.
 */

jest.mock('../../middleware/authenticate');

jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

// The service is a stub in production and MUST be a stub here too: the whole
// point of the gate is that it runs BEFORE the service, so a test proving the
// service was not reached for a non-owned id needs a spyable service that never
// actually talks to Google.
jest.mock('../../services/calendar', () => ({
  __esModule: true,
  default: {
    getCalendarEvents: jest.fn(async () => ({ success: true, events: [] })),
    checkTimeSlotAvailability: jest.fn(async () => ({ success: true, availableSlots: [] })),
  },
}));

import calendarRouter from '../calendar';
import { pool } from '../../config';
import calendarService from '../../services/calendar';

const mockQuery = pool.query as unknown as jest.Mock;
const mockGetEvents = calendarService.getCalendarEvents as unknown as jest.Mock;

type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (role: Role, id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: Role } } }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/calendar', calendarRouter);
  return app;
};

const RANGE = 'start_time=2026-01-01T00:00:00Z&end_time=2026-01-02T00:00:00Z';

/** The caller's OWN stored calendar id, in one place. */
const OWNED = 'owner-primary';

/** Make the ownership lookup return the caller's own calendar id. */
const tokenRow = (calendarId: string | null) =>
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes('FROM user_calendar_tokens')) {
      return { rows: calendarId === null ? [] : [{ calendar_id: calendarId }] };
    }
    return { rows: [] };
  });

describe('GET /api/calendar/events calendar ownership (#18)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // THE CONTROLS. Without them a handler that 403'd every calendar_id - or one
  // that never called the service at all - would satisfy every refusal below
  // while proving nothing about ownership. These show this exact fixture DOES
  // reach the service when the caller is entitled to.
  // ------------------------------------------------------------------

  it('lets an admin query a calendar_id they own', async () => {
    tokenRow(OWNED);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(`/api/calendar/events?${RANGE}&calendar_id=${OWNED}`)
      .expect(200);

    expect(mockGetEvents).toHaveBeenCalledTimes(1);
  });

  it('lets an admin query with no calendar_id (default calendar, no id to own)', async () => {
    // The only shape any current caller sends. The service uses its configured
    // default calendar, so the ownership lookup must not even run.
    tokenRow(OWNED);

    await request(listening(appAs('researcher_admin', 'admin-2')))
      .get(`/api/calendar/events?${RANGE}`)
      .expect(200);

    expect(mockGetEvents).toHaveBeenCalledTimes(1);
    const ranOwnershipLookup = mockQuery.mock.calls.some((c: unknown[]) =>
      String(c[0]).includes('FROM user_calendar_tokens')
    );
    expect(ranOwnershipLookup).toBe(false);
  });

  // ------------------------------------------------------------------
  // THE REFUSALS.
  // ------------------------------------------------------------------

  it('refuses an admin naming a calendar_id they do not own and never reaches the service', async () => {
    // The caller owns OWNED; they ask for someone else's calendar. This is the
    // arm the mutation control neuters - dropping the guard makes it 200 and
    // calls the service, which is exactly the leak #18 describes.
    tokenRow(OWNED);

    await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(`/api/calendar/events?${RANGE}&calendar_id=victim%40corp.com`)
      .expect(403);

    // The absence-assertion. Its presence arm is the first control above, which
    // reaches the service once with this same fixture - so a green here means
    // the guard stopped the call, not that the service simply never runs.
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('refuses fail-closed when the caller has no connected calendar', async () => {
    // No token row at all: there is no calendar the caller can be said to own,
    // so any named id is refused rather than allowed by default.
    tokenRow(null);

    await request(listening(appAs('researcher_admin', 'admin-9')))
      .get(`/api/calendar/events?${RANGE}&calendar_id=${OWNED}`)
      .expect(403);

    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('still refuses a non-admin outright (the requireAdmin gate is unchanged)', async () => {
    tokenRow(OWNED);

    await request(listening(appAs('employee', 'user-1')))
      .get(`/api/calendar/events?${RANGE}&calendar_id=${OWNED}`)
      .expect(403);

    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});
