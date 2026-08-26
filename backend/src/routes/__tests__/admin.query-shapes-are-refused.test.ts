import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

/**
 * THE TWO admin.ts QUERY READS REFUSE A NON-STRING SHAPE, AND A WELL-FORMED
 * VALUE STILL WORKS. cto/AdaptaLabs#43.
 *
 * Before this, `GET /requests` guarded `status` with `typeof === 'string'`, so
 * `?status=a&status=b` did not fail - it SILENTLY DROPPED the WHERE filter and
 * answered the unfiltered list. Triaged as not an authorisation widening (the
 * route is superadmin-only and the filter is cosmetic), but a behaviour nobody
 * chose. And `DELETE /admins?id=a&id=b` pushed a string array into a `uuid`
 * parameter, which is a 500.
 *
 * Both routes now mount `validateQuery`, which zod-parses the whole query
 * before the handler runs. Every refusal arm asserts the database was never
 * queried - a 400 that still ran the SQL would be a validator mounted after
 * the work it exists to prevent.
 *
 * The auth double is the shared session-trusting mock (see
 * middleware/__mocks__/authenticate.ts) - auth liveness is covered by
 * admin.dashboard-and-request-read-live-role.test.ts; this suite tests query
 * shape only.
 */

jest.mock('../../middleware/authenticate');

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import adminRouter from '../admin';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;

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
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
};

/**
 * No session injected: the request reaches the router unauthenticated. Used to
 * pin MOUNT ORDER - the authz gate must run BEFORE `validateQuery`, so a
 * hostile shape from an anonymous caller answers 401 (the gate), not 400 (the
 * validator). A 400 here is a pre-auth oracle confirming the route exists and
 * naming its parameters to a caller with no admin role.
 */
const anonymousApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async () => ({ rows: [] }));
});

/**
 * The four query-string shapes the guard must survive, from the issue: a
 * repeat, a repeated empty, bracket notation, and nested-object notation -
 * the last parses to an OBJECT and walks straight past `Array.isArray`.
 * Prose case names because the mutation canary's `-t` is a regex and its
 * validator refuses metacharacters in a referenced test name.
 */
const HOSTILE_SHAPES = (name: string): Array<[string, string]> => [
  [`a repeated ${name}`, `?${name}=a&${name}=b`],
  [`a repeated empty ${name}`, `?${name}=&${name}=`],
  [`a bracket-notation ${name}`, `?${name}[]=a&${name}[]=b`],
  [`a nested-object ${name}`, `?${name}[foo]=bar`],
];

describe('GET /api/admin/requests refuses a non-string status', () => {
  it.each(HOSTILE_SHAPES('status'))('refuses %s without touching the database', async (_name, shape) => {
    const res = await request(listening(appAs('superadmin', 'sa-1')))
      .get(`/api/admin/requests${shape}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still applies the WHERE filter for a single well-formed status', async () => {
    const res = await request(listening(appAs('superadmin', 'sa-1')))
      .get('/api/admin/requests?status=pending');

    expect(res.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(sql).toContain('WHERE ar.status = $1');
    expect(params).toEqual(['pending']);
  });

  it('still answers the unfiltered list when status is absent', async () => {
    const res = await request(listening(appAs('superadmin', 'sa-1')))
      .get('/api/admin/requests');

    expect(res.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });
});

describe('DELETE /api/admin/admins refuses a non-string id', () => {
  it.each(HOSTILE_SHAPES('id'))('refuses %s without touching the database', async (_name, shape) => {
    const res = await request(listening(appAs('superadmin', 'sa-1')))
      .delete(`/api/admin/admins${shape}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keeps the route-owned message for an absent id', async () => {
    const res = await request(listening(appAs('superadmin', 'sa-1')))
      .delete('/api/admin/admins');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Admin ID is required');
  });

  it('carries a single well-formed id through to the user lookup', async () => {
    const res = await request(listening(appAs('superadmin', 'sa-1')))
      .delete('/api/admin/admins?id=11111111-1111-4111-8111-111111111111');

    // Empty rows from the mock: the handler got past validation and answered
    // its own 404, with the id bound as a parameter.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
    const [, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(params).toEqual(['11111111-1111-4111-8111-111111111111']);
  });
});

describe('the authz gate runs before the validator (mount order)', () => {
  it('answers 401, not the validator 400, for an anonymous hostile-shaped GET /requests', async () => {
    const res = await request(listening(anonymousApp())).get('/api/admin/requests?status[]=a&status[]=b');

    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe('Invalid query parameters');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('answers 401, not the validator 400, for an anonymous hostile-shaped DELETE /admins', async () => {
    const res = await request(listening(anonymousApp())).delete('/api/admin/admins?id[]=a&id[]=b');

    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe('Invalid query parameters');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
