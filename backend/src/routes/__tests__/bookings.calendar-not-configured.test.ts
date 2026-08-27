import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

import { listening } from '../../__tests__/helpers/listening';

/**
 * THE ROUTE-LEVEL HALF OF cto/AdaptaLabs#89, WHICH NO TEST COULD FAIL ON.
 *
 * `calendar.unconfigured-is-honest.test.ts` pins the SERVICE: writes refuse
 * rather than answering `{ success: true, eventId: 'demo-event-<now>' }`. It
 * says nothing about what the routes then do with that refusal, and a re-gate
 * proved the gap by reverting every route-level change in turn - the
 * three-state response, and both not-configured log branches - and watching
 * all 1548 backend tests pass each time.
 *
 * So this file pins the contract a caller and an operator actually see:
 *
 *   1. the booking response says `not_configured`, not `success` and not
 *      `error`, and carries NO event id
 *   2. no fabricated id is written to `bookings.gcal_event_id`
 *   3. an unconfigured calendar is INFO, not WARN - production rows still hold
 *      `demo-event-*` ids from before the migration, so a WARN here fires on
 *      every cancellation of every legacy booking, and a warning that always
 *      fires means nothing
 *
 * ponytail: the RESCHEDULE path's not-configured short-circuit is not covered
 *   here -> cto/AdaptaLabs#93. Deleting it passes the whole backend suite, and the cost is
 *   three false WARNs per reschedule of any legacy booking rather than any
 *   incorrect behaviour. An attempt to cover it stalled on the fixture: the
 *   handler loads both the booking and the target session from the TRANSACTION
 *   client and then 500s in this harness with nothing reaching the mocked
 *   logger, so the mock is missing something the route needs and finding it is
 *   its own task rather than a line in this one.
 *
 * The calendar service is deliberately NOT mocked: the point is the real
 * refusal reaching the real mapping.
 */

jest.mock('../../middleware/authenticate');

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(async () => true),
}));

jest.mock('../../services/email', () => ({
  __esModule: true,
  default: { sendEmail: jest.fn(async () => ({ success: true, messageId: 'test' })) },
  EmailService: {
    getBookingConfirmationTemplate: jest.fn(() => ({})),
    getBookingCancellationTemplate: jest.fn(() => ({})),
    getAdminNotificationTemplate: jest.fn(() => ({})),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { logger } from '../../utils/logger';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockInfo = logger.info as unknown as jest.Mock;
const mockWarn = logger.warn as unknown as jest.Mock;

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const appAs = (role: string, id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: string } } }).session = {
      user: { id, name: 'Ada', email: 'ada@example.com', role },
    };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/** Statements a mock client saw, as strings. */
const statementsOn = (client: { query: jest.Mock }) =>
  client.query.mock.calls.map((call: unknown[]) => String(call[0]));

const messages = (spy: jest.Mock) => spy.mock.calls.map((call: unknown[]) => String(call[0]));

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

describe('POST /api/bookings/sessions/:id/book with no calendar configured (#89)', () => {
  const bookingClient = () => ({
    query: jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('FROM sessions')) {
        return {
          rows: [
            {
              id: 's1',
              opportunity_id: 'opp-1',
              start_time: FUTURE,
              end_time: FUTURE,
              capacity: 5,
              booked_count: 0,
              opportunity_status: 'published',
              opportunity_title: 'Checkout usability study',
              owner_user_id: null,
              purpose_one_liner: 'A study',
              location_or_meet_link_optional: 'Room 3B',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO bookings')) {
        return { rows: [{ id: 'b1', session_id: 's1', status: 'booked' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  });

  it('answers not_configured with no event id, rather than claiming success', async () => {
    const client = bookingClient();
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('employee', 'u1'))).post(
      '/api/bookings/sessions/s1/book'
    );

    expect(res.status).toBe(201);
    // The exact three states, pinned as literals. `success` was returned on
    // every booking ever made; `error` would be a new falsehood in place of the
    // old one, because nothing failed - there was never a calendar to write to.
    expect(res.body.calendar).toBe('not_configured');
    expect(res.body.calendarEventId).toBeUndefined();
    // And the fabricated id that used to be returned must not appear anywhere.
    expect(JSON.stringify(res.body)).not.toMatch(/demo-event-/);
  });

  it('writes no gcal_event_id at all', async () => {
    const client = bookingClient();
    mockConnect.mockImplementation(async () => client);

    await request(listening(appAs('employee', 'u1'))).post('/api/bookings/sessions/s1/book');

    // The fabricated id was written HERE, which is why production rows record
    // Google events that never existed - and why cancel and reschedule, both
    // gated on this column being truthy, then chase phantoms.
    const wrote = [...statementsOn(client), ...mockQuery.mock.calls.map((c: unknown[]) => String(c[0]))];
    expect(wrote.filter((sql) => sql.includes('gcal_event_id'))).toEqual([]);
  });

  it('records the condition at INFO, not as a warning on every booking', async () => {
    const client = bookingClient();
    mockConnect.mockImplementation(async () => client);

    await request(listening(appAs('employee', 'u1'))).post('/api/bookings/sessions/s1/book');

    expect(messages(mockInfo)).toContainEqual(
      expect.stringContaining('calendar is not configured')
    );
    expect(messages(mockWarn)).not.toContainEqual(
      expect.stringContaining('Calendar event creation failed')
    );
  });
});

describe('POST /api/bookings/:id/cancel on a booking holding a fabricated id (#89)', () => {
  const cancelClient = () => ({
    query: jest.fn(async (sql: unknown) =>
      String(sql).toUpperCase().includes('UPDATE BOOKINGS')
        ? { rows: [{ session_id: 's1' }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    ),
    release: jest.fn(),
  });

  const bookingLoads = (gcalEventId: string | null) => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM bookings b')) {
        return {
          rows: [
            {
              id: 'b1',
              user_id: 'u1',
              session_id: 's1',
              status: 'booked',
              gcal_event_id: gcalEventId,
              start_time: FUTURE,
              end_time: FUTURE,
              opportunity_id: 'opp-1',
              owner_user_id: 'owner-1',
              opportunity_title: 'A study',
              owner_name: 'Owner',
              owner_email: 'owner@example.com',
              participant_name: 'Ada',
              participant_email: 'ada@example.com',
            },
          ],
        };
      }
      return { rows: [] };
    });
  };

  it('does not warn about a deletion that was never possible', async () => {
    bookingLoads('demo-event-1787829699354');
    mockConnect.mockImplementation(async () => cancelClient());

    const res = await request(listening(appAs('employee', 'u1'))).post('/api/bookings/b1/cancel');

    expect(res.status).toBe(200);
    expect(messages(mockInfo)).toContainEqual(
      expect.stringContaining('No calendar event deleted')
    );
    // Every pre-existing production booking holds one of these ids, so a WARN
    // here fires on every cancellation, permanently.
    expect(messages(mockWarn)).not.toContainEqual(
      expect.stringContaining('Calendar event deletion failed')
    );
  });

  it('says nothing at all when there was no event id to begin with', async () => {
    // The control. The branch above must be reached BECAUSE the calendar is
    // unconfigured, not because this handler logs that line unconditionally.
    bookingLoads(null);
    mockConnect.mockImplementation(async () => cancelClient());

    await request(listening(appAs('employee', 'u1'))).post('/api/bookings/b1/cancel');

    expect(messages(mockInfo)).not.toContainEqual(
      expect.stringContaining('No calendar event deleted')
    );
  });
});
