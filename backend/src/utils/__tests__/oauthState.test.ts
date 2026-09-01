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

/**
 * The request a real browser would send to the callback: the cookie the guard
 * just set, under the name it set it under.
 *
 * These tests used to hand `consume` the STATE as the cookie value, which was
 * exactly what the old cookie held. Since cto/AdaptaLabs#92 the cookie carries a
 * sealed envelope and the state is only the nonce inside it, so a fixture that
 * builds the cookie itself is a fixture that can no longer round-trip. Reading
 * the value back off `res.cookie` also makes these arms stricter than they were:
 * they now exercise the real seal/open pair rather than a string the test chose.
 */
const boundReq = (cookies: Array<{ name: string; value: string }>, index = -1) => {
  const cookie = cookies.at(index);
  if (!cookie) throw new Error('boundReq: the guard set no cookie to bind to');
  return fakeReq({ [cookie.name]: cookie.value });
};

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
    guard.consume(boundReq(cookies), res, state);

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
    const { res, cookies } = fakeRes();
    const state = guard.issue(res);

    expect(cookies[0].name).toBe('__Host-flow_read');
    expect(guard.consume(boundReq(cookies), res, state)).toMatchObject({
      ok: true,
    });

    // The same cookie VALUE under the bare name is not read at all.
    const second = createOAuthStateGuard({ cookieName: 'flow_read_2' });
    const two = fakeRes();
    const state2 = second.issue(two.res);
    expect(
      second.consume(fakeReq({ flow_read_2: two.cookies[0].value }), two.res, state2)
    ).toEqual({
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
    guard.consume(boundReq(cookies), res, state);

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
      const { res, cookies } = fakeRes();

      const state = guard.issue(res);
      jest.setSystemTime(start + 60_001);

      const result = guard.consume(boundReq(cookies), res, state);

      expect(result).toEqual({ ok: false, error: 'State parameter expired' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts one well inside the TTL', async () => {
    // The control: an expiry check with the comparison the wrong way round
    // would satisfy the arm above and refuse every real flow.
    const guard = createOAuthStateGuard({ cookieName: 'flow_ttl_ok', ttlMs: 60_000 });
    const { res, cookies } = fakeRes();

    const state = guard.issue(res);
    const result = guard.consume(boundReq(cookies), res, state);

    expect(result.ok).toBe(true);
  });
});

describe('createOAuthStateGuard - the payload', () => {
  it('returns what was issued with the state, and nothing when none was', () => {
    const guard = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_payload' });
    const { res, cookies } = fakeRes();

    const state = guard.issue(res, { userId: 'researcher-7' });
    const result = guard.consume(boundReq(cookies), res, state);

    // The calendar callback identifies the user from this and from nothing else,
    // because it cannot read the session cookie.
    expect(result).toMatchObject({ ok: true, payload: { userId: 'researcher-7' } });
  });

  it('never carries the payload into the cookie', () => {
    const guard = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_leak' });
    const { res, cookies } = fakeRes();

    guard.issue(res, { userId: 'researcher-7' });

    // The property survives cto/AdaptaLabs#92 unchanged, by a different
    // mechanism: the payload IS in the cookie now, sealed with AES-256-GCM, so
    // it is neither readable nor editable by whoever holds it. A merely SIGNED
    // envelope would have left it readable and failed this line, correctly -
    // which is why the envelope is encrypted rather than signed.
    expect(JSON.stringify(cookies)).not.toContain('researcher-7');
  });
});

describe('createOAuthStateGuard - flows are not substitutable', () => {
  it('refuses a state minted by another guard, under either cookie name', () => {
    // The module's strongest claim. It used to rest on a separate cookie AND a
    // separate store - and had no oracle: hoisting the Map to module scope so
    // both guards shared it passed every test in the repo. There is no store
    // now (cto/AdaptaLabs#92), so the second half is carried by the GCM
    // additional authenticated data: the cookie name is sealed into the tag, so
    // an envelope minted for one flow does not open under the other's name.
    // Both halves are still load-bearing and each alone suffices, so both are
    // asserted here rather than trusted to the other.
    const login = createOAuthStateGuard({ cookieName: 'login_state' });
    const calendar = createOAuthStateGuard({ cookieName: 'calendar_state' });
    const { res, cookies } = fakeRes();

    const calendarState = calendar.issue(res);
    const calendarCookie = cookies[0].value;

    // The calendar's sealed cookie, presented to the login guard under the
    // login guard's OWN name - the shape a copy-paste between flows takes.
    expect(
      login.consume(fakeReq({ '__Host-login_state': calendarCookie }), res, calendarState)
    ).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
    // And under the name it was sealed for, which the login guard does not read.
    expect(
      login.consume(fakeReq({ '__Host-calendar_state': calendarCookie }), res, calendarState)
    ).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });

    // And the control: the guard that DID mint it still accepts it, so the two
    // refusals above are about provenance rather than a broken guard.
    expect(
      calendar.consume(fakeReq({ '__Host-calendar_state': calendarCookie }), res, calendarState).ok
    ).toBe(true);
  });
});

describe('createOAuthStateGuard - a consumed state cannot be consumed again', () => {
  it('refuses the second consume even when the same cookie is re-presented', () => {
    // The property the two route suites pin end to end, pinned here on the
    // module they both depend on. A real browser cannot get here at all - the
    // successful consume cleared its cookie - so this is the client that KEEPS
    // the cookie and sends it twice.
    const guard = createOAuthStateGuard({ cookieName: 'flow_once' });
    const { res, cookies } = fakeRes();

    const state = guard.issue(res);

    expect(guard.consume(boundReq(cookies), res, state).ok).toBe(true);
    expect(guard.consume(boundReq(cookies), res, state)).toEqual({
      ok: false,
      error: 'State parameter already used',
    });
  });

  it('clears the cookie on the way out, which is what stops a real browser replaying', () => {
    // The other half of single use, and the half that works across pods. The
    // spent set below is per-process; this is not.
    const guard = createOAuthStateGuard({ cookieName: 'flow_once_clear' });
    const { res, cookies, cleared } = fakeRes();

    const state = guard.issue(res);
    guard.consume(boundReq(cookies), res, state);

    expect(cleared.map((c) => c.name)).toEqual(['__Host-flow_once_clear']);
  });
});

describe('createOAuthStateGuard - the spent set is bounded', () => {
  /*
   * WHAT IS BOUNDED CHANGED WITH cto/AdaptaLabs#92, and so did these two arms.
   *
   * The old bound was on ISSUED states, because `issue` wrote to a Map and is
   * reachable by any authenticated caller. Nothing is written at issue any more.
   * What grows now is the set of CONSUMED nonces, which exists so a replay can
   * be named as one, and it needs the same bound for the same reason.
   *
   * The observable consequence of eviction is that the oldest spent nonce is
   * forgotten and could be replayed - inside its TTL, by a client that kept the
   * cookie, against an authorization code the provider has already spent. That
   * is the accepted ceiling and it is asserted rather than described, because a
   * bound nobody can observe is a bound nobody can test.
   */
  it('forgets the oldest spent nonce rather than growing without limit', () => {
    const guard = createOAuthStateGuard({ cookieName: 'flow_spent_bound' });
    const { res, cookies } = fakeRes();

    const first = guard.issue(res);
    const firstReq = boundReq(cookies);
    expect(guard.consume(firstReq, res, first).ok).toBe(true);

    // One more than the 10,000 bound, so `first`'s nonce must have been evicted.
    for (let i = 0; i < 10_000; i++) {
      const state = guard.issue(res);
      guard.consume(boundReq(cookies), res, state);
    }

    // Replayable again: the guard has forgotten it. Named as the ceiling it is.
    expect(guard.consume(firstReq, res, first).ok).toBe(true);
  });

  it('still remembers the most recent spent nonce, so eviction is oldest-first and not arbitrary', () => {
    // The control. A guard that simply cleared the whole set on overflow
    // satisfies the arm above and stops naming any replay at all.
    const guard = createOAuthStateGuard({ cookieName: 'flow_spent_recent' });
    const { res, cookies } = fakeRes();

    for (let i = 0; i < 10_000; i++) {
      const state = guard.issue(res);
      guard.consume(boundReq(cookies), res, state);
    }
    const newest = guard.issue(res);
    const newestReq = boundReq(cookies);
    expect(guard.consume(newestReq, res, newest).ok).toBe(true);

    expect(guard.consume(newestReq, res, newest)).toEqual({
      ok: false,
      error: 'State parameter already used',
    });
  });
});

describe('createOAuthStateGuard - no process state decides a callback (#92)', () => {
  /**
   * THE WHOLE POINT OF cto/AdaptaLabs#92, as an executable arm.
   *
   * A second guard object with the same cookie name stands in for a second pod:
   * separate module instance, separate everything, same `SESSION_SECRET`. Under
   * the old in-process Map this consume answered `Invalid state parameter`,
   * which at replicaCount > 1 is `(n-1)/n` of every login attempt.
   */
  it('lets a DIFFERENT guard instance consume a state this one issued', () => {
    const podA = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_pods' });
    const podB = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_pods' });
    const { res, cookies } = fakeRes();

    const state = podA.issue(res, { userId: 'researcher-7' });

    // Including the payload, which used to exist only in pod A's memory.
    expect(podB.consume(boundReq(cookies), res, state)).toMatchObject({
      ok: true,
      payload: { userId: 'researcher-7' },
    });
  });

  it('still refuses, on the other pod, a state that was never issued at all', () => {
    // The control on the arm above: "another pod accepts it" must not mean
    // "another pod accepts anything". A guard with no memory that trusted the
    // state parameter would satisfy the multi-pod arm and reopen #82.
    const podB = createOAuthStateGuard({ cookieName: 'flow_pods_forged' });
    const { res } = fakeRes();
    const forged = 'f'.repeat(64);

    expect(podB.consume(fakeReq({ '__Host-flow_pods_forged': forged }), res, forged)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
  });
});

describe('createOAuthStateGuard - the sealed cookie', () => {
  it('refuses a cookie whose ciphertext has been edited', () => {
    // The tag is what replaced the store's membership check, so this arm is the
    // one standing where `store.has(state)` used to.
    const guard = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_tamper' });
    const { res, cookies } = fakeRes();

    const state = guard.issue(res, { userId: 'researcher-7' });
    const sealed = cookies[0].value;
    // Flipped on the BYTES, then re-encoded. Editing the last base64url
    // CHARACTER is not reliably an edit at all: when the length is not a
    // multiple of four the final character carries unused padding bits, so
    // several characters decode to identical bytes - which made the first
    // version of this arm pass alone and fail in a full run, at random.
    const raw = Buffer.from(sealed, 'base64url');
    raw[raw.length - 1] ^= 1;
    const edited = raw.toString('base64url');

    expect(guard.consume(fakeReq({ '__Host-flow_tamper': edited }), res, state)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
    // The control: unedited, the same cookie opens.
    expect(guard.consume(fakeReq({ '__Host-flow_tamper': sealed }), res, state).ok).toBe(true);
  });

  it('refuses a state that is not the nonce inside the cookie', () => {
    /*
     * THE BROWSER BINDING ITSELF, and nothing else in this repository could see
     * it. Deleting the nonce comparison passed all 55 tests across this file and
     * both route suites: every other arm either presents the matching state or
     * presents no cookie at all, and the no-cookie arms are refused one check
     * earlier.
     *
     * What it defends is cto/AdaptaLabs#82 in full. Without it, `consume`
     * accepts ANY state string as long as some envelope of ours opens - so a
     * victim who has begun their own flow, and therefore holds a valid cookie,
     * can be lured to the callback carrying the ATTACKER's code and any state at
     * all, and the callback would honour it.
     */
    const guard = createOAuthStateGuard({ cookieName: 'flow_binding' });
    const { res, cookies } = fakeRes();

    guard.issue(res);
    const somebodyElsesState = 'c'.repeat(64);

    expect(guard.consume(boundReq(cookies), res, somebodyElsesState)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
  });

  it('refuses a state of the right shape that is off by one character', () => {
    // The control on the arm above, and on the comparison being a comparison
    // rather than a length check: same 64 hex characters, one of them different.
    const guard = createOAuthStateGuard({ cookieName: 'flow_binding_near' });
    const { res, cookies } = fakeRes();

    const state = guard.issue(res);
    const nearMiss = (state[0] === '0' ? '1' : '0') + state.slice(1);

    expect(guard.consume(boundReq(cookies), res, nearMiss)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
    // And the control: the real one still opens the same cookie.
    expect(guard.consume(boundReq(cookies), res, state).ok).toBe(true);
  });

  it('refuses a cookie sealed under a different SESSION_SECRET', () => {
    // Rotating the secret invalidates in-flight states rather than accepting
    // them, and the key cache must notice the rotation - a cache keyed on
    // anything but the secret's value would keep using the old key.
    const original = process.env.SESSION_SECRET;
    try {
      process.env.SESSION_SECRET = 'first-secret-for-this-test-at-least-32-chars'; // gitleaks:allow
      const guard = createOAuthStateGuard({ cookieName: 'flow_rotate' });
      const { res, cookies } = fakeRes();
      const state = guard.issue(res);

      process.env.SESSION_SECRET = 'second-secret-for-this-test-at-least-32-chars'; // gitleaks:allow

      expect(guard.consume(boundReq(cookies), res, state)).toEqual({
        ok: false,
        error: 'Invalid state parameter',
      });
    } finally {
      process.env.SESSION_SECRET = original;
    }
  });

  it('refuses a cookie that is not base64url at all, rather than throwing', () => {
    // An express handler that throws out of `consume` is a 500 on the callback
    // path, where every other refusal is a 400 with a message.
    const guard = createOAuthStateGuard({ cookieName: 'flow_garbage' });
    const { res } = fakeRes();
    const state = 'a'.repeat(64);

    expect(guard.consume(fakeReq({ '__Host-flow_garbage': '!!!' }), res, state)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
    expect(guard.consume(fakeReq({ '__Host-flow_garbage': '' }), res, state)).toEqual({
      ok: false,
      error: 'Invalid state parameter',
    });
  });

  it('sends nothing but the nonce to the provider', () => {
    // The state travels in the authorization URL, so the provider, its logs and
    // the browser's history all see it. A design that put the payload THERE -
    // the obvious way to make this stateless - would have leaked the user id to
    // Okta and Google on every flow. It goes in the sealed cookie instead.
    const guard = createOAuthStateGuard<{ userId: string }>({ cookieName: 'flow_url' });
    const { res } = fakeRes();

    const state = guard.issue(res, { userId: 'researcher-7' });

    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(state).not.toContain('researcher-7');
  });
});
