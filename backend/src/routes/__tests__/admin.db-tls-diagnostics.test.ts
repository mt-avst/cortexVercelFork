import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() }
}));

import adminRouter from '../admin';
import { errorHandler } from '../../utils/errorHandler';

/**
 * The report that replaced `kubectl logs`.
 *
 * Whether a database link verifies its certificate is a security posture
 * detail: on an unauthenticated endpoint it would tell a stranger that a
 * man-in-the-middle on that link is worth attempting. The people who need the
 * answer are the ones who can already read the configuration.
 */
function appAs(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = user ? { user } : {};
    next();
  });
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

const PATH = '/api/admin/diagnostics/db-tls';

describe('GET /api/admin/diagnostics/db-tls', () => {
  it('answers a superadmin', async () => {
    const res = await request(
      appAs({ id: 'root', name: 'R', email: 'r@x.com', role: 'superadmin' })
    ).get(PATH).expect(200);

    expect(res.body).toHaveProperty('pools');
    expect(res.body).toHaveProperty('allVerified');
  });

  it('refuses a researcher_admin, who can already read plenty else here', async () => {
    await request(
      appAs({ id: 'a1', name: 'A', email: 'a@x.com', role: 'researcher_admin' })
    ).get(PATH).expect(403);
  });

  it('refuses an unauthenticated caller', async () => {
    await request(appAs(null)).get(PATH).expect(401);
  });

  it('reports no host and no filesystem path', async () => {
    const res = await request(
      appAs({ id: 'root', name: 'R', email: 'r@x.com', role: 'superadmin' })
    ).get(PATH).expect(200);

    // The underlying description names the database host and the CA bundle
    // path. Only the mode is meant to travel.
    expect(JSON.stringify(res.body.pools)).not.toMatch(/\//);
  });
});
