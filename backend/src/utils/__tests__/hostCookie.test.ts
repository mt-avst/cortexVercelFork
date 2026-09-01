import { describe, expect, it } from '@jest/globals';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';

import {
  SESSION_COOKIE_BASENAME,
  CSRF_COOKIE_BASENAME,
  sessionCookieName,
  csrfCookieName,
  sessionCookieClearOptions,
} from '../hostCookie';

/**
 * These are the DIRECT unit pins for cto/AdaptaLabs#97 - the property is
 * "the name carries the __Host- prefix in the secure (production) environment",
 * and it is asserted here rather than through an integration flow because a
 * mutation that drops the prefix must fail BY NAME. See the two mutation-canary
 * entries anchored on hostCookie.ts.
 */
describe('host-cookie naming (#97)', () => {
  describe('sessionCookieName', () => {
    it('prefixes the session cookie with __Host- in production so a sibling subdomain cannot toss one in', () => {
      expect(sessionCookieName('production')).toBe('__Host-adaptalabs_session');
    });

    it('leaves the session cookie bare outside production, where express-session cannot set a Secure cookie over http', () => {
      expect(sessionCookieName('development')).toBe('adaptalabs_session');
      expect(sessionCookieName('test')).toBe('adaptalabs_session');
      // Anything that is not exactly 'production' is treated as non-secure,
      // matching how every other cookie control in index.ts is keyed.
      expect(sessionCookieName('Production')).toBe('adaptalabs_session');
    });

    it('builds the prefixed name from the shared basename, so a rename cannot drift the prefix off', () => {
      expect(sessionCookieName('production')).toBe(`__Host-${SESSION_COOKIE_BASENAME}`);
    });
  });

  describe('csrfCookieName', () => {
    it('prefixes the CSRF cookie with __Host- when cookies are secure so a sibling subdomain cannot toss one in', () => {
      expect(csrfCookieName(true)).toBe('__Host-adaptalabs_csrf');
    });

    it('leaves the CSRF cookie bare when cookies are not secure, so the double-submit contract survives http tests', () => {
      expect(csrfCookieName(false)).toBe('adaptalabs_csrf');
      expect(csrfCookieName(false)).toBe(CSRF_COOKIE_BASENAME);
    });
  });

  describe('sessionCookieClearOptions', () => {
    it('clears with a valid __Host- shape in production: Secure, Path=/, no Domain', () => {
      const opts = sessionCookieClearOptions('production');
      expect(opts.secure).toBe(true);
      expect(opts.path).toBe('/');
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('strict');
      // A __Host- cookie forbids Domain; a clear carrying one would be refused
      // and the cookie would never be removed.
      expect('domain' in opts).toBe(false);
    });

    it('matches the dev set-cookie (bare name, Domain=localhost) so dev logout actually clears it', () => {
      const opts = sessionCookieClearOptions('development');
      expect(opts.secure).toBe(false);
      expect(opts.path).toBe('/');
      expect(opts.domain).toBe('localhost');
    });
  });

  /**
   * The mechanism the unit pins assume: express-session will only EMIT a Secure
   * cookie when it believes the connection is secure. This proves the prefixed
   * name is one express-session actually puts on the wire (given trust proxy +
   * X-Forwarded-Proto), not merely a string the helper returns.
   */
  describe('express-session emits the prefixed name over a secure connection', () => {
    it('sets __Host-adaptalabs_session when the proxy reports https', async () => {
      const app = express();
      app.set('trust proxy', 1);
      app.use(
        session({
          secret: 'test-session-secret',
          name: sessionCookieName('production'),
          resave: false,
          saveUninitialized: true,
          cookie: { secure: true, httpOnly: true, sameSite: 'strict', path: '/' },
        })
      );
      app.get('/touch', (_req, res) => res.json({ ok: true }));

      const res = await request(listening(app))
        .get('/touch')
        .set('X-Forwarded-Proto', 'https');

      const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
      expect(setCookie).toBeDefined();
      const header = (setCookie ?? []).join('\n');
      expect(header).toContain('__Host-adaptalabs_session=');
      expect(header).toMatch(/Secure/i);
      expect(header).not.toMatch(/Domain=/i);
    });

    it('emits NOTHING when the same secure cookie is requested over plain http (the reason dev keeps the bare name)', async () => {
      const app = express();
      app.set('trust proxy', false);
      app.use(
        session({
          secret: 'test-session-secret',
          name: sessionCookieName('production'),
          resave: false,
          saveUninitialized: true,
          cookie: { secure: true, httpOnly: true, sameSite: 'strict', path: '/' },
        })
      );
      app.get('/touch', (_req, res) => res.json({ ok: true }));

      const res = await request(listening(app)).get('/touch');
      const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
      expect(setCookie).toBeUndefined();
    });
  });
});
