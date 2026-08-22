import { describe, expect, it } from '@jest/globals';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';

import { buildCsrfProtection, CSRF_ERROR_CODE } from '../csrf';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    session({
      secret: 'test-session-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false, sameSite: 'lax' },
    })
  );

  const { doubleCsrfProtection, generateCsrfToken } = buildCsrfProtection({
    secret: 'test-csrf-secret',
    secureCookies: false,
  });

  app.get('/api/csrf-token', (req, res) => {
    req.session.csrfSeeded = true;
    res.json({ csrfToken: generateCsrfToken(req, res) });
  });

  app.use(doubleCsrfProtection);
  app.use((err: Error & { code?: string }, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.code === CSRF_ERROR_CODE) {
      return res.status(403).json({ error: 'Invalid CSRF token', code: CSRF_ERROR_CODE });
    }
    return next(err);
  });

  app.get('/api/thing', (_req, res) => res.json({ ok: true }));
  app.post('/api/thing', (_req, res) => res.json({ ok: true }));
  app.post('/api/firsthand/studies', (_req, res) => res.json({ ok: 'studies' }));
  app.post('/api/firsthand/callbacks', (_req, res) => res.json({ ok: 'webhook' }));
  app.post('/api/cron/send-reminders', (_req, res) => res.json({ ok: 'cron' }));
  app.post('/api/auth/logout', (_req, res) => res.json({ ok: 'logout' }));

  return app;
}

describe('CSRF protection', () => {
  it('lets GET requests through without a token', async () => {
    const app = buildApp();
    const response = await request(listening(app)).get('/api/thing');
    expect(response.status).toBe(200);
  });

  it('rejects a mutating request without a token', async () => {
    const app = buildApp();
    const response = await request(listening(app)).post('/api/thing').send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe(CSRF_ERROR_CODE);
  });

  it('accepts a mutating request carrying the issued token and cookie', async () => {
    const app = buildApp();
    const agent = request.agent(listening(app));

    const tokenResponse = await agent.get('/api/csrf-token');
    expect(tokenResponse.status).toBe(200);
    const csrfToken = tokenResponse.body.csrfToken;
    expect(typeof csrfToken).toBe('string');

    const response = await agent
      .post('/api/thing')
      .set('x-csrf-token', csrfToken)
      .send({});
    expect(response.status).toBe(200);
  });

  it('rejects a token presented without its pairing cookie', async () => {
    const app = buildApp();
    const tokenResponse = await request(listening(app)).get('/api/csrf-token');
    const csrfToken = tokenResponse.body.csrfToken;

    // Fresh client: no CSRF cookie, no session cookie
    const response = await request(listening(app))
      .post('/api/thing')
      .set('x-csrf-token', csrfToken)
      .send({});
    expect(response.status).toBe(403);
  });

  it('no longer exempts the deleted webhook path (exemption stays gone)', async () => {
    const app = buildApp();
    const response = await request(listening(app)).post('/api/firsthand/callbacks').send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe(CSRF_ERROR_CODE);
  });

  it('protects live /api/firsthand/* routes like any other mutating route', async () => {
    const app = buildApp();
    const response = await request(listening(app)).post('/api/firsthand/studies').send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe(CSRF_ERROR_CODE);
  });

  it('exempts the cron trigger routes', async () => {
    const app = buildApp();
    const response = await request(listening(app)).post('/api/cron/send-reminders').send({});
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe('cron');
  });

  it('exempts logout so the SPA silent cleanup works without a token', async () => {
    const app = buildApp();
    const response = await request(listening(app)).post('/api/auth/logout').send({});
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe('logout');
  });
});
