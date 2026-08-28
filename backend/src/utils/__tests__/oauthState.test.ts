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
    expect(cookies[0].name).toBe('__Host-flow_a');
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

  it('marks the cookie secure UNCONDITIONALLY, in every environment', () => {
    // This test used to assert the opposite - `secure` false outside production
    // - on the stated grounds that hardcoding `true` "would break every
    // developer's http://localhost flow". That was never measured, and it is
    // wrong: localhost is a trustworthy origin and Chromium accepts a `Secure`
    // `__Host-` cookie over plain http there (probed 2026-08-28, with a
    // no-Secure arm confirming the probe could still detect a refusal).
    //
    // It has to be unconditional, because a `__Host-` cookie WITHOUT `Secure`
    // is refused by the browser outright. Conditional `secure` would not make
    // the cookie weaker outside production - it would make it absent, and the
    // OAuth flow would fail closed everywhere but production.
    const original = process.env.NODE_ENV;
    try {
      const guard = createOAuthStateGuard({ cookieName: 'flow_secure' });

      for (const env of ['production', 'development', 'test', undefined]) {
        if (env === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = env;
        }
        const { res, cookies } = fakeRes();
        guard.issue(res);
        expect(cookies[0].options.secure).toBe(true);
      }
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('prefixes the cookie name with __Host-, so a subdomain cannot toss one in', () => {
    // The literal, not `HOST_COOKIE_PREFIX` read back from the module: an
    // expectation derived from the code it guards cannot notice that code
    // changing. Dropping the prefix is exactly #94 reopening.
    const guard = createOAuthStateGuard({ cookieName: 'adaptalabs_oauth_state' });
    const { res, cookies } = fakeRes();

    guard.issue(res);

    expect(cookies[0].name).toBe('__Host-adaptalabs_oauth_state');
  });

  it('sets NO domain attribute, which is what the prefix actually buys', () => {
    // A Domain attribute is the mechanism of the attack - it is how a sibling
    // `*.adaptavist.net` host would write a cookie that lands here. The browser
    // would refuse a `__Host-` cookie carrying one, so this asserts we never
    // ask: a Domain here means no cookie at all, and a flow that never
    // completes.
    const guard = createOAuthStateGuard({ cookieName: 'flow_no_domain' });
    const { res, cookies, cleared } = fakeRes();

    const state = guard.issue(res);
    guard.consume(fakeReq({ '__Host-flow_no_domain': state }), res, state);

    expect(cookies[0].options).not.toHaveProperty('domain');
    // The clear path too - it is a second place the attributes are written.
    expect(cleared[0].options).not.toHaveProperty('domain');
  });

  it('reads the callback cookie under the PREFIXED name, not the bare one', () => {
    // The control for the rename: a guard that emitted the prefixed name but
    // still read the bare one would set a cookie it could never consume, and
    // every OAuth flow would fail. Both arms, because only the pair
    // distinguishes "reads the right name" from "accepts anything".
    const guard = createOAuthStateGuard({ cookieName: 'flow_read' });
    const { res } = fakeRes();
    const state = guard.issue(res);

    expect(guard.consume(fakeReq({ '__Host-flow_read': state }), res, state)).toMatchObject({
      ok: true,
    });

    const second = createOAuthStateGuard({ cookieName: 'flow_read_2' });
    const two = fakeRes();
    const state2 = second.issue(two.res);
    expect(second.consume(fakeReq({ flow_read_2: state2 }), two.res, state2)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
  });

  it('refuses a caller that passes an already-prefixed name, at construction', () => {
    // Fail fast rather than emitting `__Host-__Host-...` - a cookie under a name
    // nothing else reads, which would surface only as a flow that never
    // completes.
    expect(() => createOAuthStateGuard({ cookieName: '__Host-already' })).toThrow(
      /pass the bare cookie name/
    );
    // Case-insensitively, because the browser's own prefix rule is: `__host-foo`
    // really has a prefix. Without this arm the check could regress to
    // `startsWith(HOST_COOKIE_PREFIX)` and stay green.
    expect(() => createOAuthStateGuard({ cookieName: '__host-lower' })).toThrow(
      /pass the bare cookie name/
    );
    expect(() => createOAuthStateGuard({ cookieName: '__HOST-UPPER' })).toThrow(
      /pass the bare cookie name/
    );
    // The control: the bare equivalent must still be accepted, so the refusal
    // is about the prefix and not about the name.
    expect(() => createOAuthStateGuard({ cookieName: 'already' })).not.toThrow();
  });

  it('refuses an empty cookie name, at construction', () => {
    // Its own arm rather than folded into the test above: deleting this refusal
    // left all five OAuth suites green (69/69, measured), so the pair of
    // construction guards read as covered when only one of them was. An empty
    // name would emit a bare `__Host-` cookie shared by every flow that made the
    // same mistake, which is precisely the flow-substitutability hole this
    // module exists to prevent.
    expect(() => createOAuthStateGuard({ cookieName: '' })).toThrow(/cookieName is required/);
    // Ordered before the prefix check, so a falsy name gives this named message
    // rather than a TypeError from `.toLowerCase()` on undefined.
    expect(() =>
      createOAuthStateGuard({ cookieName: undefined as unknown as string })
    ).toThrow(/cookieName is required/);
  });

  it('clears the cookie with options matching the ones it was set with', () => {
    // A clearCookie whose path or sameSite differs leaves the cookie alive in
    // the browser. Not exploitable while the `used` flag refuses a replay, but
    // it makes the state look live to anyone reading the jar.
    const guard = createOAuthStateGuard({ cookieName: 'flow_clear' });
    const { res, cookies, cleared } = fakeRes();

    const state = guard.issue(res);
    guard.consume(fakeReq({ '__Host-flow_clear': state }), res, state);

    expect(cleared).toHaveLength(1);
    expect(cleared[0].name).toBe('__Host-flow_clear');
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

      const result = guard.consume(fakeReq({ '__Host-flow_ttl': state }), res, state);

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
    const result = guard.consume(fakeReq({ '__Host-flow_ttl_ok': state }), res, state);

    expect(result.ok).toBe(true);
  });
});

describe('createOAuthStateGuard - the payload', () => {
  it('returns what was issued with the state, and nothing when none was', () => {
    const guard = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_payload' });
    const { res } = fakeRes();

    const state = guard.issue(res, { userId: 'researcher-7' });
    const result = guard.consume(fakeReq({ '__Host-flow_payload': state }), res, state);

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

    expect(login.consume(fakeReq({ '__Host-login_state': calendarState }), res, calendarState)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
    expect(login.consume(fakeReq({ '__Host-calendar_state': calendarState }), res, calendarState)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });

    // And the control: the guard that DID mint it still accepts it, so the two
    // refusals above are about provenance rather than a broken guard.
    expect(
      calendar.consume(fakeReq({ '__Host-calendar_state': calendarState }), res, calendarState).ok
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

    expect(guard.consume(fakeReq({ '__Host-flow_bound': first }), res, first)).toEqual({
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

    expect(guard.consume(fakeReq({ '__Host-flow_bound_recent': newest }), res, newest).ok).toBe(true);
  });
});
