import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import request from 'supertest';

// Controls the verdict without needing a database. Factory uses only inline
// jest.fn() to avoid TDZ, per the house pattern.
jest.mock('../utils/deepHealth', () => ({
  createDatabaseHealthProbe: jest.fn(),
  DEEP_HEALTH_TIMEOUT_MS: 2000,
  DEEP_HEALTH_CACHE_MS: 1000,
}));

import { createDatabaseHealthProbe } from '../utils/deepHealth';

const mockCreateProbe = createDatabaseHealthProbe as jest.MockedFunction<any>;
const probe = jest.fn() as jest.MockedFunction<any>;
mockCreateProbe.mockReturnValue(probe);

// Imports the REAL app - its real middleware chain and its real route order.
// index.ts guards app.listen behind NODE_ENV !== 'test' so this binds no port.
// Testing a hand-built copy of the app would not pin what this file exists to
// pin: that /api/health is registered before the /api router.
import app from '../index';

describe('GET /api/health', () => {
  beforeEach(() => {
    probe.mockReset();
  });

  it('answers 200 ok/up when the database responds', async () => {
    probe.mockResolvedValue({ healthy: true, latencyMs: 12 });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', database: 'up', databaseLatencyMs: 12 });
  });

  it('answers 503 degraded/down when the database does not', async () => {
    probe.mockResolvedValue({ healthy: false, reason: 'timeout', latencyMs: 2000 });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'degraded', database: 'down' });
  });

  // On the failure path the latency distinguishes an immediate refusal from a
  // blackholed connection sitting at the timeout. That is recon detail with no
  // monitoring value, since status already carries the verdict.
  it('omits the latency oracle on the failure path', async () => {
    probe.mockResolvedValue({ healthy: false, reason: 'error', latencyMs: 4 });

    const response = await request(app).get('/api/health');

    expect(response.body.databaseLatencyMs).toBeUndefined();
  });

  it('never leaks the coarse reason or any driver detail to the caller', async () => {
    probe.mockResolvedValue({ healthy: false, reason: 'error', latencyMs: 4 });

    const response = await request(app).get('/api/health');

    expect(JSON.stringify(response.body)).not.toMatch(/reason|password|ECONNREFUSED|postgres/i);
  });

  it('marks the response no-store', async () => {
    probe.mockResolvedValue({ healthy: true, latencyMs: 5 });

    const response = await request(app).get('/api/health');

    expect(response.headers['cache-control']).toBe('no-store');
  });

  // THE ORDERING PIN, and it has to be structural. Asserting only that
  // GET /api/health returns 200 does NOT pin the order: the api router
  // currently has no /health route and no catch-all, so Express falls through
  // to a later registration and the request succeeds either way - verified by
  // moving the route below the router and watching a behavioural test stay
  // green. Reading the router stack is what actually fails on a reorder, and
  // the order is what protects the endpoint the day a catch-all or a
  // conflicting /health appears inside the api router.
  it('is registered before the /api router, so it cannot be shadowed', () => {
    const stack = (app as unknown as { _router: { stack: any[] } })._router.stack;

    const healthIndex = stack.findIndex((layer) => layer.route?.path === '/api/health');
    // `name === 'router'` is what narrows this to a mounted router: app-level
    // middleware (query, cors, session, ...) carries the catch-all regexp
    // /^\/?(?=\/|$)/i, which matches /api/opportunities too and would
    // otherwise match at index 0 and make this assertion meaningless. Among
    // the mounted routers, only the /api one matches /api/opportunities -
    // /auth, /api/auth and /api/cron do not.
    const apiRouterIndex = stack.findIndex(
      (layer) => layer.name === 'router' && layer.regexp?.test?.('/api/opportunities')
    );

    expect(healthIndex).toBeGreaterThanOrEqual(0);
    expect(apiRouterIndex).toBeGreaterThanOrEqual(0);
    expect(healthIndex).toBeLessThan(apiRouterIndex);
  });

  // Guards the .catch(next): Express 4 does not forward a rejected promise on
  // its own, and an unhandled rejection terminates the process under Node 22.
  it('does not hang or crash if the probe rejects', async () => {
    probe.mockRejectedValue(new Error('probe exploded'));

    const response = await request(app).get('/api/health');

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
