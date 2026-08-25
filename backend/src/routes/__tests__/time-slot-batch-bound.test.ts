import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express, { Router } from 'express';

// The shared session-trusting auth double, for the same reason every other
// route suite here uses it (#14): the real requireAdmin re-reads the role from
// the database and would consume a queued pool.query result.
jest.mock('../../middleware/authenticate');

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

jest.mock('../../services/calendar', () => ({
  __esModule: true,
  default: {
    getCalendarEvents: jest.fn(async () => ({ success: true, events: [] })),
    checkTimeSlotAvailability: jest.fn(async () => ({ success: true, availableSlots: [] })),
  },
}));

import opportunitiesRouter from '../opportunities';
import sessionsRouter from '../sessions';
import calendarRouter from '../calendar';
import calendarService from '../../services/calendar';
import { MAX_TIME_SLOTS_PER_REQUEST } from '../../validation/schemas';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;
const mockGetEvents = calendarService.getCalendarEvents as unknown as jest.Mock;

/**
 * THREE ROUTES TAKING AN ARRAY OF TIME WINDOWS, NONE OF THEM BOUNDED.
 * cto/AdaptaLabs#22.
 *
 *   POST /api/sessions                      `sessions`
 *   POST /api/opportunities/:id/sessions    the body itself, array or single
 *   POST /api/calendar/check-conflicts      `time_slots`
 *
 * WHAT WAS ACTUALLY HOLDING THEM UP was `express.json()`'s 100 kB default,
 * called in `backend/src/index.ts` with no explicit `limit`. That is an
 * accident of the framework rather than a control anybody chose, and it moves
 * the instant somebody raises the body limit for an unrelated route. So the
 * bound now belongs to the payload and `index.ts` names its limit out loud.
 *
 * ONE TABLE FOR THREE ROUTES, deliberately, and it is the same argument
 * `sessions.write-ownership.test.ts` makes one directory over: these are
 * near-duplicate handlers in three routers, and a per-route file cannot fail
 * for the route nobody wrote a file for. `/points-history` was missed exactly
 * that way. A FOURTH route accepting a batch of slots should be a row here.
 *
 * EVERY REFUSAL HAS A CONTROL. An assertion that 201 slots are refused passes
 * just as well against a handler that refuses every batch, so each row also
 * proves that exactly 200 is accepted and reaches the work behind it.
 *
 * The ceiling is asserted as a LITERAL, not read from
 * `MAX_TIME_SLOTS_PER_REQUEST`.
 */

type Role = 'researcher_admin' | 'superadmin';

const appAs = (mount: string, router: Router, role: Role = 'researcher_admin', id = 'u1') => {
  const app = express();
  // Generous body limit on purpose: these suites POST arrays deliberately
  // larger than production's 100 kB, and the point of the ticket is that the
  // ARRAY bound must hold on its own rather than leaning on the body bound.
  app.use(express.json({ limit: '50mb' }));
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use(mount, router);
  app.use(errorHandler);
  return app;
};

const sessionsApp = appAs('/api/sessions', sessionsRouter);
const opportunitiesApp = appAs('/api/opportunities', opportunitiesRouter);
const calendarApp = appAs('/api/calendar', calendarRouter);

const START = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

/**
 * `n` NON-OVERLAPPING one-hour windows, an hour apart.
 *
 * Non-overlapping matters: `/opportunities/:id/sessions` runs an O(N^2) scan
 * and returns 409 on the first pair that touches, so a lazier fixture of
 * identical slots would make the control arm fail for a reason that has
 * nothing to do with the ceiling.
 */
const slots = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const start = new Date(START.getTime() + i * 2 * 60 * 60 * 1000);
    return {
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
      capacity: 1,
    };
  });

const INSERTED = (start: Date) => ({
  id: 'sess-1',
  opportunity_id: 'opp-1',
  capacity: 1,
  booked_count: 0,
  remaining: 1,
  start_time: start,
  end_time: new Date(start.getTime() + 60 * 60 * 1000),
  created_at: start,
  updated_at: start,
});

/** One dispatcher on the SQL text rather than a call-order queue. */
const answering = async (sql: unknown) => {
  const q = String(sql);
  if (q.includes('SELECT owner_user_id FROM opportunities')) {
    return { rows: [{ owner_user_id: 'u1' }] };
  }
  if (q.includes('overlap_count')) return { rows: [{ overlap_count: '0' }] };
  if (q.includes('INSERT INTO sessions')) return { rows: [INSERTED(START)] };
  if (q.includes('FROM user_calendar_tokens')) return { rows: [] };
  return { rows: [] };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDatabaseAvailable.mockResolvedValue(true as never);
  mockQuery.mockImplementation(answering);
  mockConnect.mockResolvedValue({
    query: jest.fn(answering),
    release: jest.fn(),
  } as never);
  mockGetEvents.mockResolvedValue({ success: true, events: [] } as never);
});

describe('the batch ceiling on a request full of time slots', () => {
  it('holds the time-slot batch ceiling at the number that was decided', () => {
    expect(MAX_TIME_SLOTS_PER_REQUEST).toBe(200);
  });
});

describe('POST /api/sessions bounds its sessions array', () => {
  it('refuses a sessions array over the batch ceiling', async () => {
    const res = await request(listening(sessionsApp))
      .post('/api/sessions')
      .send({ opportunity_id: 'opp-1', sessions: slots(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('200');
  });

  it('accepts a sessions array of exactly the batch ceiling', async () => {
    const res = await request(listening(sessionsApp))
      .post('/api/sessions')
      .send({ opportunity_id: 'opp-1', sessions: slots(200) });

    expect(res.status).toBe(201);
  });

  it('refuses before running one overlap query or one insert', async () => {
    await request(listening(sessionsApp))
      .post('/api/sessions')
      .send({ opportunity_id: 'opp-1', sessions: slots(201) });

    // The per-element cost this bound exists for: one query AND one INSERT each,
    // sequentially, outside a transaction.
    const touched = mockQuery.mock.calls.some((c) => {
      const q = String(c[0]);
      return q.includes('overlap_count') || q.includes('INSERT INTO sessions');
    });
    expect(touched).toBe(false);
  });
});

describe('POST /api/opportunities/:id/sessions bounds its sessions array', () => {
  it('refuses a session batch over the batch ceiling', async () => {
    const res = await request(listening(opportunitiesApp))
      .post('/api/opportunities/opp-1/sessions')
      .send(slots(201));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('200');
  });

  it('accepts a session batch of exactly the batch ceiling', async () => {
    const res = await request(listening(opportunitiesApp))
      .post('/api/opportunities/opp-1/sessions')
      .send(slots(200));

    expect(res.status).toBe(201);
  });

  it('refuses before the quadratic overlap scan opens a transaction', async () => {
    await request(listening(opportunitiesApp))
      .post('/api/opportunities/opp-1/sessions')
      .send(slots(201));

    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe('POST /api/calendar/check-conflicts bounds its time_slots array', () => {
  it('refuses a time_slots array over the batch ceiling', async () => {
    const res = await request(listening(calendarApp))
      .post('/api/calendar/check-conflicts')
      .send({ time_slots: slots(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('200');
  });

  it('accepts a time_slots array of exactly the batch ceiling', async () => {
    const res = await request(listening(calendarApp))
      .post('/api/calendar/check-conflicts')
      .send({ time_slots: slots(200) });

    expect(res.status).toBe(200);
    expect(res.body.total_slots_checked).toBe(200);
  });

  it('refuses before spreading the array into an argument list', async () => {
    await request(listening(calendarApp))
      .post('/api/calendar/check-conflicts')
      .send({ time_slots: slots(201) });

    // `Math.min(...allStartTimes.map(...))` is an argument list, so its ceiling
    // is the engine's rather than the heap's. The calendar read that follows it
    // must not be reached either.
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});
