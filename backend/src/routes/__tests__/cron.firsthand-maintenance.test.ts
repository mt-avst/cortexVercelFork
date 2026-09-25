import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { listening } from '../../__tests__/helpers/listening';

jest.mock('../../services/reminders', () => ({
  sendDueReminders: jest.fn(),
}));
jest.mock('../../firsthand/maintenance', () => ({
  runFirstHandMaintenance: jest.fn(),
}));

import cronRouter from '../cron';
import { runFirstHandMaintenance } from '../../firsthand/maintenance';
import { errorHandler } from '../../utils/errorHandler';

const mockMaintenance = runFirstHandMaintenance as unknown as jest.Mock;

/**
 * `GET /api/cron/firsthand-maintenance` is the HTTP face of the 03:00 UTC
 * in-process job, for Vercel, which has no long-lived process to host
 * node-cron. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` itself,
 * so the route shares send-reminders' constant-time check - pinned for both
 * routes in cron.constant-time-secret.test.ts; this file pins that the new
 * route is wired to it at all.
 */
const app = (() => {
  const a = express();
  a.use('/api/cron', cronRouter);
  a.use(errorHandler);
  return a;
})();

const PATH = '/api/cron/firsthand-maintenance';
const SECRET = 'a-cron-secret-of-a-particular-length';
const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  mockMaintenance.mockResolvedValue({ transcriptsProcessed: 2 } as never);
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  }
});

describe('GET /api/cron/firsthand-maintenance', () => {
  it('runs maintenance for the correct bearer token and returns its summary', async () => {
    const res = await request(listening(app)).get(PATH).set('Authorization', `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, transcriptsProcessed: 2 });
    expect(mockMaintenance).toHaveBeenCalledTimes(1);
  });

  it('refuses a wrong bearer token', async () => {
    const res = await request(listening(app)).get(PATH).set('Authorization', 'Bearer nope');

    expect(res.status).toBe(401);
    expect(mockMaintenance).not.toHaveBeenCalled();
  });

  it('refuses everything when CRON_SECRET is unset, even a bare "Bearer "', async () => {
    delete process.env.CRON_SECRET;

    const res = await request(listening(app)).get(PATH).set('Authorization', 'Bearer ');

    expect(res.status).toBe(401);
    expect(mockMaintenance).not.toHaveBeenCalled();
  });
});
