import crypto from 'crypto';
import type { Request, Response } from 'express';

/**
 * Single-use, browser-bound OAuth `state` guards.
 *
 * Extracted verbatim from routes/auth.ts, where cto/AdaptaLabs#82 built it to
 * close a login-CSRF / session-fixation hole. It is here rather than there
 * because a SECOND OAuth flow now needs the same control (calendar connect,
 * cto/AdaptaLabs#89), and a security check that exists in two copies is a
 * security check that will eventually differ in two copies. The five tests in
 * `auth.google-callback-state.test.ts` are the equivalence oracle for the move.
 *
 * The property being defended, in full: a process-global store of issued states
 * proves only that SOME browser began a flow, not that THIS one did - any
 * caller can populate it by hitting the initiation route. So an attacker can
 * mint a state, capture their own authorization code, and lure a victim to the
 * callback carrying both. Binding the state to a nonce set on the initiating
 * browser closes that: the victim, who never began the flow, has no such
 * cookie.
 *
 * Each flow gets its OWN cookie name and its OWN store, so a state minted for
 * one flow is not even present for the other. Sharing either would make the
 * flows substitutable for each other, which is a hole of the same shape as the
 * one this exists to close.
 *
 * COOKIE TOSSING, and why the name carries a `__Host-` prefix (#94):
 *
 * Binding the state to a cookie moves the trust onto that cookie. A host-only
 * cookie is not sole-authority material: anything able to write a cookie for
 * this host can plant one. The attacker plants their own state and sends the
 * victim a provider consent URL carrying it. The callback consumes a state whose
 * payload names the ATTACKER, so the VICTIM's Google refresh token is stored
 * against the ATTACKER's row and is readable through `GET /api/calendar/my-events`.
 *
 * The calendar callback takes its user from the state's server-side payload
 * rather than from the session - correct, and what stops the callback 401ing
 * after consent, but it is what makes the cookie the authority.
 *
 * WHICH HALF IS LIVE, because it is easy to get backwards and the first version
 * of this comment did:
 *
 *   LATENT - the calendar half above. `calendarOAuthMode()` answers
 *     `unavailable` with no Google credentials configured, and both the connect
 *     route and the callback 503 before any state work happens.
 *
 *   LIVE - the LOGIN half. The same guard backs `adaptalabs_oauth_state` for the
 *     Okta/OIDC flow: `/auth/login` issues it, `/auth/callback` consumes it, and
 *     none of that touches Google. A tossed cookie there is #82's login CSRF
 *     reopened - an attacker's `code` minting a session in the victim's browser.
 *     That was reachable in production before the prefix landed.
 *
 * A `__Host-` cookie is accepted by the browser ONLY when it is `Secure`, has
 * `Path=/`, and carries NO `Domain` attribute.
 *
 * WHAT THAT CLOSES, and what it does NOT - the two vectors have different fates
 * and the first version of this comment wrongly claimed both were shut:
 *
 *   CLOSED - a sibling `*.adaptavist.net` host setting `Domain=.adaptavist.net`.
 *     A `__Host-` name forbids `Domain` outright, so a sibling has no way to
 *     express a cookie that lands here. Measured in Chrome across two hosts on
 *     one parent domain: the bare-named toss arrives, the `__Host-` one never
 *     enters the jar. This is the whole of the fix.
 *
 *   NOT CLOSED - XSS on this origin. The prefix constrains `Domain`, `Path` and
 *     `Secure`; it says nothing about `HttpOnly`, so same-origin script can
 *     still write a `__Host-` cookie and run the same flow. Measured: a
 *     `document.cookie` write of a `__Host-` name is accepted and comes back on
 *     the next request. Nothing here defends that, and nothing here should be
 *     read as doing so - the control for it is whatever stops the XSS.
 *
 * Shadowing is closed for these cookies rather than merely narrowed: `cookie`
 * parses a duplicate name first-wins, but a duplicate can no longer be PRODUCED
 * for a `__Host-` name - `Domain` is refused, `Path` is pinned to `/`, and a
 * same-host same-path write overwrites instead of duplicating.
 *
 * The prefix and the unconditional `secure` below are ONE change, not two. A
 * `__Host-` cookie without `Secure` is refused outright, so adding the prefix
 * while leaving `secure` conditional would not weaken the flow - it would break
 * it completely outside production.
 *
 * NO PROCESS STATE DECIDES A CALLBACK (cto/AdaptaLabs#92). The issued state used
 * to live in a per-process `Map`, so `store.has(state)` only ever succeeded on
 * the pod that issued it: at replicaCount > 1 a callback load-balanced anywhere
 * else answered `Invalid state parameter`, intermittently, for BOTH flows -
 * login included. Everything a callback needs now travels in the cookie,
 * AES-256-GCM sealed under a key derived from `SESSION_SECRET`, so any pod can
 * open it and no pod has to remember anything. See `sealEnvelope` below for what
 * is sealed and why it is sealed rather than merely signed.
 */
export interface OAuthStateGuardOptions {
  /**
   * Cookie the nonce is bound to, WITHOUT the `__Host-` prefix. MUST be
   * distinct per flow.
   *
   * Pass the bare name: the prefix is applied here rather than by each caller,
   * so a third flow added later cannot forget it and quietly reintroduce #94.
   * A name that already carries the prefix is REFUSED at construction - see
   * `HOST_COOKIE_PREFIX`.
   *
   * A SEPARATE cookie from the app session, because that one is
   * SameSite=Strict in production and would not ride a cross-site OAuth
   * callback; SameSite=Lax below IS sent on the provider's top-level GET
   * redirect back to us.
   */
  cookieName: string;
  /** How long an issued state stays valid. Defaults to ten minutes. */
  ttlMs?: number;
}

export type OAuthStateResult<P = undefined> =
  | { ok: true; state: string; payload?: P }
  | { ok: false; error: string };

export interface OAuthStateGuard<P = undefined> {
  /**
   * Mint a fresh single-use state, record it for expiry and replay tracking,
   * and bind it to this browser. Returns the state for the authorization URL.
   *
   * `payload` is stored SERVER-SIDE against the state and handed back by
   * `consume`. It never leaves this process, so a caller can bind facts to a
   * flow - which user began it, for instance - without trusting anything the
   * callback request carries.
   */
  issue(res: Response, payload?: P): string;
  /**
   * Validate a callback's state: it must equal the nonce set on THIS browser,
   * be present in the store, be unexpired, and be unused. On success it is
   * consumed - marked used and its cookie cleared - so it cannot drive a second
   * callback, and the payload issued with it is returned.
   */
  consume(req: Request, res: Response, state: unknown): OAuthStateResult<P>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Most CONSUMED nonces one guard remembers, so a replay can be named as one.
 *
 * A BOUND, not a budget, and it bounds a different thing than it used to. The
 * old store held every ISSUED state, which `issue` - reachable by any
 * authenticated caller - grew without limit. Nothing is stored at issue any
 * more; this set is written only by a SUCCESSFUL `consume`, and swept on age,
 * so under any normal load it holds one TTL's worth of completed logins.
 *
 * Oldest-first eviction rather than refusal, for the same reason as before:
 * dropping the oldest entry costs at most a replay going unnamed, whereas
 * refusing to consume would deny login to everyone once the set filled.
 */
const MAX_SPENT_STATES = 10_000;

/**
 * Domain separation for the key this module derives from `SESSION_SECRET`.
 *
 * The session secret already signs session cookies. Using it directly here
 * would put two different protocols under one key, where a confusion between
 * them is somebody's clever attack; an HMAC-as-PRF over a fixed label gives
 * this module a key of its own that shares only the secret's entropy. The `v1`
 * is deliberate: changing the construction means changing the label, which
 * invalidates in-flight states rather than silently accepting envelopes sealed
 * under the old rules.
 */
const STATE_KEY_LABEL = 'cortex.oauth-state.v1';

/** Cached per secret VALUE, so a rotated secret derives a new key rather than reusing a stale one. */
let derivedKey: { secret: string; key: Buffer } | null = null;

/**
 * The AES key, derived lazily.
 *
 * LAZILY, and this is not incidental: both guards are constructed at module
 * load, and `shared/config/environment.ts` validates `SESSION_SECRET` when
 * `src/config` is imported - which a util must not depend on. Deriving on first
 * use means the module imports cleanly and a missing secret surfaces on the
 * request that needs it, loudly, rather than as an import-time crash in
 * whatever happened to load this first.
 */
const stateKey = (): Buffer => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('oauthState: SESSION_SECRET is required to seal OAuth state');
  }
  if (derivedKey?.secret !== secret) {
    derivedKey = {
      secret,
      key: crypto.createHmac('sha256', secret).update(STATE_KEY_LABEL).digest(),
    };
  }
  return derivedKey.key;
};

interface StateEnvelope<P> {
  /** The nonce, which is also the `state` in the authorization URL. */
  n: string;
  /** Issued-at, epoch milliseconds. Expiry is decided from this, server-side. */
  t: number;
  /** Whatever the caller bound to the flow. */
  p?: P;
}

/**
 * SEALED, not merely signed, and the distinction is the whole reason this can
 * replace a server-side store.
 *
 * A signed envelope is readable by anyone holding the cookie, and the payload
 * this carries is a user id. The old store kept it server-side and
 * `oauthState.test.ts` pins that the payload never reaches the cookie - a
 * property worth keeping rather than trading away, so the envelope is
 * ENCRYPTED (AES-256-GCM) and the pin still holds against the ciphertext.
 * Signing alone would have made that assertion fail, correctly.
 *
 * GCM gives authenticity as well, which is what actually replaces the store's
 * membership check: an envelope this module did not seal cannot be opened, so
 * "did we issue this?" is answered by the cryptography rather than by a Map
 * only one pod has.
 *
 * The COOKIE NAME is the additional authenticated data, which is what makes the
 * two flows non-substitutable now that they no longer have separate stores. An
 * envelope sealed for `login_state` fails to open under `calendar_state` even
 * if someone copies it across, because the tag covers the name.
 */
const sealEnvelope = <P>(cookieName: string, envelope: StateEnvelope<P>): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', stateKey(), iv);
  cipher.setAAD(Buffer.from(cookieName, 'utf8'));
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(envelope), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
};

/** Opens a sealed envelope, or returns null for ANY reason it will not open. */
const openEnvelope = <P>(cookieName: string, sealed: string): StateEnvelope<P> | null => {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    // 12 IV + 16 tag, and at least one byte of ciphertext. A short buffer would
    // otherwise reach createDecipheriv as an IV of the wrong length and throw a
    // different error from every other rejection here.
    if (raw.length <= 28) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', stateKey(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(cookieName, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    const opened = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString('utf8');
    const envelope = JSON.parse(opened) as StateEnvelope<P>;
    // Shape checked rather than trusted: `JSON.parse` of authentic plaintext
    // still reaches here from an OLDER version of this module, and a `t` that
    // is not a number would make the expiry comparison silently false.
    if (typeof envelope?.n !== 'string' || typeof envelope?.t !== 'number') return null;
    return envelope;
  } catch {
    // A failed tag, a truncated cookie, a key rotated under an in-flight state:
    // all of them mean the same thing to a caller, and saying which would tell
    // an attacker which half of their forgery was wrong.
    return null;
  }
};

/**
 * Applied to every guard's cookie name, by the factory rather than by callers.
 *
 * Browsers accept a `__Host-` cookie only with `Secure`, `Path=/` and NO
 * `Domain`, which is what makes a sibling subdomain unable to toss one in
 * (#94). Because the browser enforces it, a violation is not a weaker cookie -
 * it is NO cookie, and the flow fails closed rather than open.
 *
 * Measured 2026-08-28 in Chrome/Chromium against a local HTTP server, because
 * the comment this replaces asserted the opposite and nobody had checked: over
 * plain `http://localhost` a `__Host-` cookie with `Secure` IS accepted
 * (localhost is a trustworthy origin), while the same cookie with a `Domain`,
 * with `Path=/sub`, or without `Secure` was refused in all three cases. A
 * bare-named `Secure` control WAS accepted, so those three refusals are the
 * prefix rules and not `Secure`-over-http.
 *
 * Two limits of that measurement, stated rather than left to be discovered.
 * It is ONE engine - Firefox and Safari were not tested, and trustworthy-origin
 * handling is exactly the sort of detail that differs between them. And it
 * covers `localhost` ONLY: a developer reaching the callback over
 * `http://192.168.x.x`, a LAN hostname or an http tunnel gets no cookie and an
 * OAuth flow that cannot complete. Both failure modes are fail-closed and loud -
 * the flow stops - never a silently weaker cookie.
 */
const HOST_COOKIE_PREFIX = '__Host-';

export function createOAuthStateGuard<P = undefined>(
  options: OAuthStateGuardOptions
): OAuthStateGuard<P> {
  // Refused at construction, not at request time. Both guards are built at
  // module load, so a double prefix is a startup failure rather than a cookie
  // named `__Host-__Host-...` that no browser sends and that would surface as
  // an OAuth flow mysteriously never completing.
  if (!options.cookieName) {
    throw new Error('createOAuthStateGuard: cookieName is required');
  }
  // Case-INSENSITIVE, because the browser's prefix rule is. Measured in Chrome:
  // `__host-lower` carrying a `Domain` is refused exactly as `__Host-` is, so a
  // caller passing `__host-foo` really has passed a prefix. A case-sensitive
  // check misses it and emits `__Host-__host-foo` - which Chrome accepts
  // happily, so it would NOT fail loudly; it would just be a cookie under a name
  // nothing else reads.
  if (options.cookieName.toLowerCase().startsWith(HOST_COOKIE_PREFIX.toLowerCase())) {
    throw new Error(
      `createOAuthStateGuard: pass the bare cookie name; ${HOST_COOKIE_PREFIX} is applied here ` +
        `(got "${options.cookieName}")`
    );
  }

  const cookieName = `${HOST_COOKIE_PREFIX}${options.cookieName}`;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  // Every attribute here is load-bearing for the `__Host-` prefix, not just
  // tidy: the browser refuses the cookie outright if any of them is wrong.
  //
  //   path '/'      - required by the prefix, and independently correct: a flow
  //                   starts under /api/... but the provider redirect can land
  //                   elsewhere (/auth/callback).
  //   secure        - required by the prefix, and UNCONDITIONAL. Not
  //                   `NODE_ENV === 'production'`: that would emit a prefixed
  //                   cookie with no `Secure` outside production, which browsers
  //                   drop entirely. Safe locally because `http://localhost` is
  //                   a trustworthy origin (measured; see HOST_COOKIE_PREFIX).
  //   no `domain`   - required by the prefix, and the actual control: a Domain
  //                   attribute is how a sibling subdomain would reach this
  //                   cookie. Do not add one.
  const cookieOptions = () => ({
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: true,
    path: '/',
  });

  /**
   * Nonces this pod has already consumed, insertion-ordered so the eviction
   * below is a single `keys().next()` rather than a scan.
   *
   * WHAT THIS IS AND IS NOT, because it is the one property that got weaker.
   * A real browser cannot replay at all: a successful consume clears the
   * cookie, and without the cookie the binding check refuses first. This set
   * exists for the client that KEEPS the cookie and sends it twice - and it is
   * per-pod, so at replicaCount > 1 a determined replay landing on another pod
   * is not named as one.
   *
   * That residual is accepted, and here is the arithmetic. A replay's prize is
   * a second exchange of the SAME authorization code, and codes are single-use
   * at the provider - Okta and Google both refuse the second exchange - so the
   * callback fails at the next step regardless. Against that, the property
   * being bought is that login WORKS at all above one replica, which today it
   * does not: (n-1)/n of callbacks currently answer `Invalid state parameter`.
   * A shared set (Redis) closes the residual, and is the same upgrade the old
   * store needed.
   */
  const spent = new Map<string, number>();

  // .unref() so this timer alone cannot keep the process (or a Jest worker)
  // alive. Removing it makes the suite HANG rather than fail with a name, which
  // is the hardest kind of regression to read.
  setInterval(() => {
    const now = Date.now();
    for (const [nonce, consumedAt] of spent.entries()) {
      // Nothing older than a TTL can be replayed anyway - the expiry check
      // below refuses it first - so remembering it buys nothing.
      if (now - consumedAt > ttlMs) {
        spent.delete(nonce);
      }
    }
  }, ttlMs).unref();

  return {
    issue(res: Response, payload?: P): string {
      // 32 bytes, as 64 hex characters. This is the value that travels in the
      // authorization URL, so it carries NOTHING but randomness: the provider,
      // its logs and the browser's history all see it.
      const state = crypto.randomBytes(32).toString('hex');
      // Everything a callback needs, sealed to this cookie name. No process
      // state is written here at all, which is the whole of cto/AdaptaLabs#92:
      // there is nothing for another pod to be missing.
      res.cookie(cookieName, sealEnvelope(cookieName, { n: state, t: Date.now(), p: payload }), {
        ...cookieOptions(),
        maxAge: ttlMs,
      });
      return state;
    },

    consume(req: Request, res: Response, state: unknown): OAuthStateResult<P> {
      const cookies = req.cookies as Record<string, string> | undefined;
      const sealed = cookies?.[cookieName];

      // Browser binding FIRST: no cookie means this callback did not begin on
      // this browser, whatever the state parameter claims.
      if (typeof state !== 'string' || !sealed) {
        return { ok: false, error: 'Invalid state parameter' };
      }

      // Opening the envelope IS the "did we issue this?" check the store used
      // to answer. An envelope this module did not seal, or one sealed for the
      // other flow, does not open.
      const envelope = openEnvelope<P>(cookieName, sealed);
      if (!envelope) {
        return { ok: false, error: 'Invalid state parameter' };
      }

      // The binding proper: the nonce in the URL must be the nonce in the
      // cookie. Constant-time, because this compares a caller-supplied string
      // against a secret-derived one. `timingSafeEqual` throws on a length
      // mismatch, so the lengths are compared first - and they are both 64 hex
      // characters, so a mismatch is already a refusal.
      const presented = Buffer.from(state, 'utf8');
      const expected = Buffer.from(envelope.n, 'utf8');
      if (
        presented.length !== expected.length ||
        !crypto.timingSafeEqual(presented, expected)
      ) {
        return { ok: false, error: 'Invalid state parameter' };
      }

      // Expiry decided from the SEALED timestamp, not from the cookie's maxAge.
      // A client can keep sending a cookie past its maxAge; a client cannot
      // change what is inside the envelope.
      if (Date.now() - envelope.t > ttlMs) {
        res.clearCookie(cookieName, cookieOptions());
        return { ok: false, error: 'State parameter expired' };
      }

      if (spent.has(envelope.n)) {
        return { ok: false, error: 'State parameter already used' };
      }

      // Evict before inserting, so the set can never exceed the bound even by
      // one. Sweeping on age alone is not enough: the sweeper runs once per
      // TTL, and a burst inside one window is exactly the abuse case.
      while (spent.size >= MAX_SPENT_STATES) {
        const oldest = spent.keys().next();
        if (oldest.done) break;
        spent.delete(oldest.value);
      }
      spent.set(envelope.n, Date.now());

      res.clearCookie(cookieName, cookieOptions());
      return { ok: true, state, payload: envelope.p };
    },
  };
}
