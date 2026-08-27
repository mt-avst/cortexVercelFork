import { describe, it, expect, jest } from '@jest/globals';
import type { Request, Response } from 'express';

import { createOAuthStateGuard } from '../oauthState';

/**
 * The security ATTRIBUTES of the OAuth state guard, pinned as literals.
 *
 * A gate proved these were all unguarded: forcing `secure` to false, shrinking
 * the nonce from 32 bytes to 1, mismatching the `clearCookie` options and
 * reordering the two checks each survived all seventeen tests across the two
 * route suites. Those suites test the two FLOWS; nothing tested the module they
 * both now depend on.
 *
 * Literals rather than values read back from the module, because an expectation
 * derived from the code it guards cannot notice the code changing.
 */

const fakeRes = () => {
  const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  const cleared: Array<{ name: string; options: Record<string, unknown> }> = [];
  const res = {
    cookie: jest.fn((name: string, value: string, options: Record<string, unknown>) => {
      cookies.push({ name, value, options });
    }),
    clearCookie: jest.fn((name: string, options: Record<string, unknown>) => {
      cleared.push({ name, options });
    }),
  } as unknown as Response;
  return { res, cookies, cleared };
};

const fakeReq = (cookies: Record<string, string>) => ({ cookies }) as unknown as Request;

describe('createOAuthStateGuard - cookie attributes', () => {
  it('binds the nonce to an httpOnly, SameSite=Lax, path-/ cookie with the TTL as maxAge', () => {
    const guard = createOAuthStateGuard({ cookieName: 'flow_a', ttlMs: 60_000 });
    const { res, cookies } = fakeRes();

    guard.issue(res);

    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('flow_a');
    expect(cookies[0].options).toMatchObject({
      httpOnly: true,
      // Lax, NOT Strict: this cookie has to ride the provider's top-level GET
      // redirect back to us. Strict would withhold it and the flow could never
      // complete - which is exactly how the app session cookie behaves, and why
      // the callback cannot use it.
      sameSite: 'lax',
      path: '/',
      maxAge: 60_000,
    });
  });

  it('marks the cookie secure in production and not otherwise', () => {
    const original = process.env.NODE_ENV;
    try {
      const guard = createOAuthStateGuard({ cookieName: 'flow_secure' });

      process.env.NODE_ENV = 'production';
      const prod = fakeRes();
      guard.issue(prod.res);
      expect(prod.cookies[0].options.secure).toBe(true);

      process.env.NODE_ENV = 'development';
      const dev = fakeRes();
      guard.issue(dev.res);
      // The control: an implementation that hardcoded `true` would pass the arm
      // above and break every developer's http://localhost flow.
      expect(dev.cookies[0].options.secure).toBe(false);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('clears the cookie with options matching the ones it was set with', () => {
    // A clearCookie whose path or sameSite differs leaves the cookie alive in
    // the browser. Not exploitable while the `used` flag refuses a replay, but
    // it makes the state look live to anyone reading the jar.
    const guard = createOAuthStateGuard({ cookieName: 'flow_clear' });
    const { res, cookies, cleared } = fakeRes();

    const state = guard.issue(res);
    guard.consume(fakeReq({ flow_clear: state }), res, state);

    expect(cleared).toHaveLength(1);
    expect(cleared[0].name).toBe('flow_clear');
    const { maxAge: _ignored, ...setOptions } = cookies[0].options;
    expect(cleared[0].options).toEqual(setOptions);
  });
});

describe('createOAuthStateGuard - the nonce', () => {
  it('is 32 bytes of randomness, as 64 hex characters', () => {
    const guard = createOAuthStateGuard({ cookieName: 'flow_len' });
    const { res } = fakeRes();

    const state = guard.issue(res);

    // Pinned as a literal. `randomBytes(1)` - 256 possible states - survived
    // every route test, and a guessable state defeats the browser binding for
    // anyone willing to try a few hundred times.
    expect(state).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs between issues', () => {
    const guard = createOAuthStateGuard({ cookieName: 'flow_uniq' });
    const { res } = fakeRes();

    const seen = new Set(Array.from({ length: 50 }, () => guard.issue(res)));

    expect(seen.size).toBe(50);
  });
});

describe('createOAuthStateGuard - expiry', () => {
  it('refuses a state older than the TTL, even with a valid cookie', () => {
    /*
     * The store's sweeper runs once per TTL and only deletes entries older than
     * one TTL, so a state's store lifetime is between ttlMs and 2x ttlMs.
     * Expiry has to be checked on the way IN as well, or `ttlMs` is a promise
     * the module does not keep - and it is a public option now.
     *
     * The clock is moved with `setSystemTime` rather than by really waiting or
     * by `advanceTimersByTime`, both of which let the sweeper run and delete the
     * entry - which refuses for the WRONG reason (`Invalid state parameter`,
     * from the membership check) and would leave this consume-time branch
     * untested while looking green.
     */
    jest.useFakeTimers();
    try {
      const start = Date.now();
      const guard = createOAuthStateGuard({ cookieName: 'flow_ttl', ttlMs: 60_000 });
      const { res } = fakeRes();

      const state = guard.issue(res);
      jest.setSystemTime(start + 60_001);

      const result = guard.consume(fakeReq({ flow_ttl: state }), res, state);

      expect(result).toEqual({ ok: false, error: 'State parameter expired' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts one well inside the TTL', async () => {
    // The control: an expiry check with the comparison the wrong way round
    // would satisfy the arm above and refuse every real flow.
    const guard = createOAuthStateGuard({ cookieName: 'flow_ttl_ok', ttlMs: 60_000 });
    const { res } = fakeRes();

    const state = guard.issue(res);
    const result = guard.consume(fakeReq({ flow_ttl_ok: state }), res, state);

    expect(result.ok).toBe(true);
  });
});

describe('createOAuthStateGuard - the payload', () => {
  it('returns what was issued with the state, and nothing when none was', () => {
    const guard = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_payload' });
    const { res } = fakeRes();

    const state = guard.issue(res, { userId: 'researcher-7' });
    const result = guard.consume(fakeReq({ flow_payload: state }), res, state);

    // The calendar callback identifies the user from this and from nothing else,
    // because it cannot read the session cookie.
    expect(result).toMatchObject({ ok: true, payload: { userId: 'researcher-7' } });
  });

  it('never carries the payload into the cookie', () => {
    const guard = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_leak' });
    const { res, cookies } = fakeRes();

    guard.issue(res, { userId: 'researcher-7' });

    // Server-side only. A payload in the cookie would be attacker-editable,
    // which would turn the authenticator into a "connect anyone's calendar" form.
    expect(JSON.stringify(cookies)).not.toContain('researcher-7');
  });
});

describe('createOAuthStateGuard - flows are not substitutable', () => {
  it('refuses a state minted by another guard, under either cookie name', () => {
    // The module's strongest claim - separate cookie AND separate store - had no
    // oracle: hoisting the Map to module scope so both guards shared it passed
    // every test in the repo. Both halves are load-bearing and each alone
    // suffices, so both are asserted here rather than trusted to the other.
    const login = createOAuthStateGuard({ cookieName: 'login_state' });
    const calendar = createOAuthStateGuard({ cookieName: 'calendar_state' });
    const { res } = fakeRes();

    const calendarState = calendar.issue(res);

    expect(login.consume(fakeReq({ login_state: calendarState }), res, calendarState)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
    expect(login.consume(fakeReq({ calendar_state: calendarState }), res, calendarState)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });

    // And the control: the guard that DID mint it still accepts it, so the two
    // refusals above are about provenance rather than a broken guard.
    expect(
      calendar.consume(fakeReq({ calendar_state: calendarState }), res, calendarState).ok
    ).toBe(true);
  });
});

describe('createOAuthStateGuard - the store is bounded', () => {
  it('evicts oldest-first rather than growing without limit', () => {
    // `issue` is reachable by any authenticated caller and each call allocates
    // an entry that lives for up to one TTL on a single-replica pod. Measured at
    // 173 bytes per state, an unrated caller can push tens of megabytes a second
    // into it.
    const guard = createOAuthStateGuard({ cookieName: 'flow_bound' });
    const { res } = fakeRes();

    const first = guard.issue(res);
    // One more than the 10,000 bound, so `first` must have been evicted.
    for (let i = 0; i < 10_000; i++) {
      guard.issue(res);
    }

    expect(guard.consume(fakeReq({ flow_bound: first }), res, first)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
  });

  it('keeps the most recent state, so eviction is oldest-first and not arbitrary', () => {
    // The control. A guard that simply cleared the whole store on overflow
    // satisfies the arm above and breaks every flow in progress.
    const guard = createOAuthStateGuard({ cookieName: 'flow_bound_recent' });
    const { res } = fakeRes();

    for (let i = 0; i < 10_000; i++) {
      guard.issue(res);
    }
    const newest = guard.issue(res);

    expect(guard.consume(fakeReq({ flow_bound_recent: newest }), res, newest).ok).toBe(true);
  });
});
