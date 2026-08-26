import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

/**
 * GET /api/calendar/events AND /availability REFUSE A NON-STRING QUERY SHAPE.
 * cto/AdaptaLabs#43.
 *
 * Before this, the routes cast after truthiness checks. The coincidences that
 * mostly saved them are worth recording because none of them was a decision:
 * a multi-value array died as `Invalid Date` (a 400 by accident of `new Date`
 * semantics), a SINGLE-element array parsed successfully by accident of
 * `toString`, and an array `calendar_id` failed closed only because the
 * ownership helper catches the pg type error and answers false. `validateQuery`
 * replaces all three coincidences with one rule at the boundary.
 *
 * Refusal arms assert the calendar service was never reached. The auth double
 * is the shared session-trusting mock; the ownership gate itself is covered by
 * calendar.events-ownership.test.ts.
 */

jest.mock('../../middleware/authenticate');

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../services/calendar', () => ({
  __esModule: true,
  default: {
    getCalendarEvents: jest.fn(async () => ({ success: true, events: [] })),
    checkTimeSlotAvailability: jest.fn(async () => ({ success: true, availableSlots: [] })),
  },
}));

import calendarRouter from '../calendar';
import calendarService from '../../services/calendar';

const mockGetEvents = calendarService.getCalendarEvents as unknown as jest.Mock;
const mockAvailability = calendarService.checkTimeSlotAvailability as unknown as jest.Mock;

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

/** No session: pins that `requireAdmin` runs before `validateQuery`. */
const anonymousApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', calendarRouter);
  return app;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the admin gate runs before the validator (mount order)', () => {
  it('answers 401, not the validator 400, for an anonymous hostile-shaped GET /events', async () => {
    const res = await request(listening(anonymousApp())).get('/api/calendar/events?start_time[]=a&start_time[]=b');

    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe('Invalid query parameters');
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('answers 401, not the validator 400, for an anonymous hostile-shaped GET /availability', async () => {
    const res = await request(listening(anonymousApp())).get('/api/calendar/availability?duration_minutes[]=a&duration_minutes[]=b');

    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe('Invalid query parameters');
    expect(mockAvailability).not.toHaveBeenCalled();
  });
});

const WINDOW = 'start_time=2026-01-01T00:00:00Z&end_time=2026-01-02T00:00:00Z';

describe('GET /api/calendar/events query shapes', () => {
  it.each([
    ['a repeated start_time', '?start_time=a&start_time=b&end_time=2026-01-02T00:00:00Z'],
    ['a nested-object start_time', '?start_time[foo]=bar&end_time=2026-01-02T00:00:00Z'],
    ['a repeated calendar_id', `?${WINDOW}&calendar_id=a&calendar_id=b`],
    ['a bracket-notation calendar_id', `?${WINDOW}&calendar_id[]=a&calendar_id[]=b`],
  ])('refuses %s without reaching the service', async (_name, shape) => {
    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(`/api/calendar/events${shape}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('still serves a single well-formed window', async () => {
    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(`/api/calendar/events?${WINDOW}`);

    expect(res.status).toBe(200);
    expect(mockGetEvents).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/calendar/availability query shapes', () => {
  it.each([
    // The repeated duration_minutes used to answer 200 - parseInt read the
    // comma-join '30,60' as 30, a value nobody sent. Measured before the fix.
    ['a repeated duration_minutes', `?${WINDOW}&duration_minutes=30&duration_minutes=60`],
    ['a nested-object duration_minutes', `?${WINDOW}&duration_minutes[foo]=30`],
    ['a repeated empty start_time', '?start_time=&start_time=&end_time=2026-01-02T00:00:00Z&duration_minutes=30'],
  ])('refuses %s without reaching the service', async (_name, shape) => {
    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(`/api/calendar/availability${shape}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockAvailability).not.toHaveBeenCalled();
  });

  it('still serves a single well-formed request', async () => {
    const res = await request(listening(appAs('researcher_admin', 'admin-1')))
      .get(`/api/calendar/availability?${WINDOW}&duration_minutes=30`);

    expect(res.status).toBe(200);
    expect(mockAvailability).toHaveBeenCalledTimes(1);
  });
});
