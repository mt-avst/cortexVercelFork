import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// Factories use only inline jest.fn() to avoid TDZ, matching opportunities.test.ts.
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler, AppError } from '../../utils/errorHandler';

const mockQuery = pool.query as jest.MockedFunction<any>;
const mockIsDatabaseAvailable = isDatabaseAvailable as jest.MockedFunction<any>;

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.session = {
    user: {
      id: 'test-user-id',
      name: 'Test User',
      email: 'test@example.com',
      role: 'researcher_admin',
    },
  };
  next();
});
app.use('/api/bookings', bookingsRouter);
app.use(errorHandler);

const outage = () =>
  new AppError('Service temporarily unavailable', 503, 'DB_CONNECTION_FAILED');

describe('Bookings API', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clear leaves queued
    // mockResolvedValueOnce implementations in place, so an unconsumed queue
    // entry leaks into the next test and fails it for reasons that look
    // nothing like the cause.
    jest.resetAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    mockIsDatabaseAvailable.mockResolvedValue(true);
  });

  describe('GET /my/bookings', () => {
    // Regression pin for the removed `if (!process.env.DATABASE_URL) return empty`
    // guard. Kubera injects DB_URL, never DATABASE_URL, so that check emptied
    // every user's bookings against a perfectly healthy database.
    it('returns real bookings when DATABASE_URL is unset but the database is available', async () => {
      const originalDatabaseUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      const start = new Date('2026-08-01T10:00:00Z');
      const end = new Date('2026-08-01T11:00:00Z');
      // The route runs an upcoming query then a past query; only the first
      // returns a row so the total is unambiguous.
      mockQuery.mockResolvedValue({ rows: [] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'booking-1',
            user_id: 'test-user-id',
            session_id: 'session-1',
            status: 'booked',
            session_start_time: start,
            session_end_time: end,
            created_at: start,
            updated_at: start,
          },
        ],
      });

      try {
        const response = await request(listening(app)).get('/api/bookings/my/bookings');

        expect(response.status).toBe(200);
        expect(mockQuery).toHaveBeenCalled();
        expect(response.body.upcoming.length + response.body.past.length).toBe(1);
      } finally {
        if (originalDatabaseUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = originalDatabaseUrl;
        }
      }
    });

    // A bare `async` handler swallows a rethrow into an unhandled rejection and
    // the request hangs, so this also pins the asyncHandler wrap.
    it('answers 503 during a database outage instead of an empty list', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(listening(app)).get('/api/bookings/my/bookings');

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });
  });

  describe('GET /opportunities/:id/bookings', () => {
    it('answers 503 during a database outage', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(listening(app)).get(
        '/api/bookings/opportunities/opp-1/bookings'
      );

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    // The listing selected `s.start_time` unaliased then read
    // `booking.session_start_time`, so it threw a TypeError and 500'd for any
    // opportunity that actually had a booking.
    //
    // This has to assert on the SQL text: pool.query is mocked, so the mock
    // returns whatever shape the test hands it no matter what the query says.
    // Asserting only on the serialised output passes with the alias removed,
    // which makes it a test of the .toISOString() mapping, not of the fix.
    it('aliases the session time columns the serialiser reads', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] })
        .mockResolvedValueOnce({ rows: [] });

      await request(listening(app)).get('/api/bookings/opportunities/opp-1/bookings');

      const bookingsSql = mockQuery.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .find((sql: string) => /FROM\s+bookings\s+b/i.test(sql));

      expect(bookingsSql).toBeDefined();
      expect(bookingsSql).toMatch(/s\.start_time\s+as\s+session_start_time/i);
      expect(bookingsSql).toMatch(/s\.end_time\s+as\s+session_end_time/i);
    });

    it('serialises session times for an opportunity that has bookings', async () => {
      const start = new Date('2026-08-01T10:00:00Z');
      const end = new Date('2026-08-01T11:00:00Z');
      mockQuery
        .mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'booking-1',
              user_id: 'participant-1',
              session_id: 'session-1',
              status: 'booked',
              session_start_time: start,
              session_end_time: end,
              participant_name: 'Participant',
              participant_email: 'participant@example.com',
              created_at: start,
              updated_at: start,
            },
          ],
        });

      const response = await request(listening(app)).get(
        '/api/bookings/opportunities/opp-1/bookings'
      );

      expect(response.status).toBe(200);
      expect(response.body[0].session_start_time).toBe(start.toISOString());
      expect(response.body[0].session_end_time).toBe(end.toISOString());
    });
  });
});
