import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express, { type Express, Router } from 'express';
import { createAuthLimiter, shouldSkipAuthRateLimit, DEMO_AUTH_ROUTE_PATHS } from '../auth-rate-limit';

/**
 * Mounts the REAL limiter the way index.ts does - at both '/auth' and
 * '/api/auth' - because the defect these tests cover was precisely a mismatch
 * between the path the predicate expected and the path Express actually reports
 * under a mount. A test that asserted on a hand-built `{ path }` object would
 * have encoded the bug rather than caught it.
 */
const buildApp = (max: number): Express => {
  const app = express();
  const router = Router();
  for (const path of [...DEMO_AUTH_ROUTE_PATHS, '/login']) {
    router.get(path, (_req, res) => { res.json({ ok: true }); });
  }
  const limiter = createAuthLimiter({ max, windowMs: 60_000 });
  app.use('/auth', limiter, router);
  app.use('/api/auth', limiter, router);
  return app;
};

const ORIGINAL_ENV = process.env.NODE_ENV;

describe('auth rate limiter', () => {
  beforeEach(() => { process.env.NODE_ENV = 'development'; });
  afterEach(() => { process.env.NODE_ENV = ORIGINAL_ENV; });

  describe('in development', () => {
    // Both mounts, because the bug was invisible at one of them and the router
    // is genuinely mounted twice.
    for (const mount of ['/auth', '/api/auth']) {
      for (const route of DEMO_AUTH_ROUTE_PATHS) {
        it(`does not rate limit ${mount}${route}`, async () => {
          const app = buildApp(2);
          const statuses: number[] = [];
          for (let i = 0; i < 6; i++) {
            statuses.push((await request(app).get(`${mount}${route}`)).status);
          }
          expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
        });
      }

      it(`still rate limits a non-demo auth route at ${mount}`, async () => {
        const app = buildApp(2);
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) {
          statuses.push((await request(app).get(`${mount}/login`)).status);
        }
        // Exempting the demo routes must not disarm the limiter itself.
        expect(statuses.slice(0, 2)).toEqual([200, 200]);
        expect(statuses.slice(2)).toEqual([429, 429]);
      });
    }
  });

  describe('outside development', () => {
    it('rate limits demo routes too, since they do not exist there', async () => {
      process.env.NODE_ENV = 'production';
      const app = buildApp(2);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await request(app).get('/api/auth/demo-login')).status);
      }
      expect(statuses.slice(2)).toEqual([429, 429]);
    });

    it('shouldSkipAuthRateLimit is false for a demo path', () => {
      process.env.NODE_ENV = 'production';
      expect(shouldSkipAuthRateLimit({ path: '/demo-login' })).toBe(false);
    });
  });

  it('pins the demo route list, because the exemption tests are generated from it', () => {
    // A generated test cannot notice its own route being REMOVED from the list -
    // the test disappears along with it, and the suite still reports all green.
    // This pin is the only thing that makes a shrink fail. Keep it in step with
    // the development-only routes in routes/auth.ts.
    expect([...DEMO_AUTH_ROUTE_PATHS]).toEqual([
      '/demo-login',
      '/admin-login',
      '/superadmin-login',
      '/demo-user-2-login',
    ]);
  });

  it('does not skip an unrelated auth path', () => {
    expect(shouldSkipAuthRateLimit({ path: '/login' })).toBe(false);
    expect(shouldSkipAuthRateLimit({ path: '/callback' })).toBe(false);
  });
});
