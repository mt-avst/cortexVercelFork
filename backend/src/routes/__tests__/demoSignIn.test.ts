import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';

const mockFindDemoAccount = jest.fn();
jest.mock('../../services/demoCredentials', () => ({
  findDemoAccount: (...args: unknown[]) => mockFindDemoAccount(...args),
}));
jest.mock('../../config', () => ({
  pool: { connect: async () => ({ release: () => undefined }) },
}));

import demoSignInRoutes from '../demoSignIn';

/**
 * The password sign-in form on Vercel previews. What it must never do: sign
 * anyone in without the seeded credentials, or accept a post from another site.
 */
const app = (() => {
  const a = express();
  a.use(session({ secret: 'x'.repeat(40), resave: false, saveUninitialized: false }));
  a.use(express.urlencoded({ extended: false }));
  a.use('/auth', demoSignInRoutes);
  a.get('/whoami', (req, res) => res.json({ user: req.session.user ?? null }));
  return a;
})();

const admin = {
  id: '633608bc-4b0e-4d60-a498-e680ee97c252',
  email: 'admin@test.com',
  name: 'Test Admin',
  business_unit: 'Research',
  role_title: 'Research Manager',
  role: 'researcher_admin',
};

const post = (fields: Record<string, string>, origin?: string) => {
  const req = request(listening(app)).post('/auth/demo-login').type('form').send(fields);
  return origin === undefined ? req : req.set('Origin', origin);
};

beforeEach(() => {
  mockFindDemoAccount.mockReset();
});

describe('demo password sign-in', () => {
  it('serves the sign-in form, and signs nobody in by visiting it', async () => {
    const res = await request(listening(app)).get('/auth/demo-login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post" action="/auth/demo-login">');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses wrong credentials with 401 and no session', async () => {
    mockFindDemoAccount.mockResolvedValue(null as never);
    const agent = request.agent(listening(app));
    const res = await agent
      .post('/auth/demo-login')
      .type('form')
      .set('Origin', 'http://placeholder')
      .set('Host', 'placeholder')
      .send({ email: 'admin@test.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Email or password is incorrect.');
    const who = await agent.get('/whoami');
    expect(who.body.user).toBeNull();
  });

  it('signs in with the seeded credentials and lands an admin on /admin (control)', async () => {
    mockFindDemoAccount.mockResolvedValue(admin as never);
    const agent = request.agent(listening(app));
    const res = await agent
      .post('/auth/demo-login')
      .type('form')
      .set('Origin', 'http://placeholder')
      .set('Host', 'placeholder')
      .send({ email: 'admin@test.com', password: 'the-seeded-password' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin');
    expect(mockFindDemoAccount).toHaveBeenCalledWith(expect.anything(), 'admin@test.com', 'the-seeded-password');
    const who = await agent.get('/whoami');
    expect(who.body.user).toMatchObject({ email: 'admin@test.com', role: 'researcher_admin' });
  });

  it('refuses a post from another site before reading any credential', async () => {
    mockFindDemoAccount.mockResolvedValue(admin as never);
    const res = await post({ email: 'admin@test.com', password: 'the-seeded-password' }, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(mockFindDemoAccount).not.toHaveBeenCalled();
  });

  it('refuses a post with no Origin header', async () => {
    mockFindDemoAccount.mockResolvedValue(admin as never);
    const res = await post({ email: 'admin@test.com', password: 'the-seeded-password' });
    expect(res.status).toBe(403);
    expect(mockFindDemoAccount).not.toHaveBeenCalled();
  });

  it('escapes the echoed email', async () => {
    mockFindDemoAccount.mockResolvedValue(null as never);
    const res = await request(listening(app))
      .post('/auth/demo-login')
      .type('form')
      .set('Origin', 'http://placeholder')
      .set('Host', 'placeholder')
      .send({ email: '"><script>x</script>', password: 'p' });
    expect(res.text).not.toContain('<script>x</script>');
  });
});

