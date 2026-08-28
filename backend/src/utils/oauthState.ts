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
 * ponytail: in-process store, so this is single-replica only
 *   -> #92, both OAuth flows break intermittently at replicaCount > 1 because a
 *   callback landing on another pod fails the membership check. The deployment
 *   is single-replica today (.kubera/playground-backend.yaml). Upgrade path is
 *   Redis, or a stateless signed state (HMAC over nonce+timestamp+payload with
 *   SESSION_SECRET), which removes the store entirely.
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
 * Most unconsumed states one guard will hold.
 *
 * A BOUND, not a budget. `issue` is reachable by any authenticated caller and
 * every call adds a permanent-for-one-TTL entry, so without this the store is
 * an unbounded allocator on a single-replica pod. Measured on this module: 173
 * bytes per state, so 200k entries is ~33MB and 10M would be ~1.6GB.
 *
 * Oldest-first eviction rather than refusal: dropping the oldest pending state
 * costs whoever owns it one retry, whereas refusing to issue would let an
 * attacker deny calendar connection to everyone else.
 */
const MAX_PENDING_STATES = 10_000;

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

  // Insertion-ordered, which is what makes the oldest-first eviction below a
  // single `keys().next()` rather than a scan.
  const store = new Map<string, { timestamp: number; used: boolean; payload?: P }>();

  // .unref() so this timer alone cannot keep the process (or a Jest worker)
  // alive. Removing it makes the suite HANG rather than fail with a name, which
  // is the hardest kind of regression to read.
  setInterval(() => {
    const now = Date.now();
    for (const [state, data] of store.entries()) {
      if (now - data.timestamp > ttlMs) {
        store.delete(state);
      }
    }
  }, ttlMs).unref();

  return {
    issue(res: Response, payload?: P): string {
      // Evict before inserting, so the store can never exceed the bound even
      // by one. Sweeping on age alone is not enough: the sweeper only runs once
      // per TTL, and a burst inside one window is exactly the abuse case.
      while (store.size >= MAX_PENDING_STATES) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }

      const state = crypto.randomBytes(32).toString('hex');
      store.set(state, { timestamp: Date.now(), used: false, payload });
      res.cookie(cookieName, state, { ...cookieOptions(), maxAge: ttlMs });
      return state;
    },

    consume(req: Request, res: Response, state: unknown): OAuthStateResult<P> {
      const cookies = req.cookies as Record<string, string> | undefined;
      const bound = cookies?.[cookieName];

      // Browser binding FIRST: no valid cookie means this callback did not begin
      // on this browser, whatever the store holds.
      if (typeof state !== 'string' || !bound || state !== bound) {
        return { ok: false, error: 'Invalid state parameter' };
      }
      if (!store.has(state)) {
        return { ok: false, error: 'Invalid state parameter' };
      }
      const stateData = store.get(state);
      if (!stateData || stateData.used) {
        return { ok: false, error: 'State parameter already used' };
      }
      // Expiry checked HERE, not only by the cookie's maxAge. The sweeper runs
      // once per TTL and only deletes entries older than one TTL, so a state's
      // store lifetime is between ttlMs and 2x ttlMs - and `ttlMs` is a public
      // option on a shared module now, so a caller passing a short one has to
      // actually get a short one.
      if (Date.now() - stateData.timestamp > ttlMs) {
        store.delete(state);
        res.clearCookie(cookieName, cookieOptions());
        return { ok: false, error: 'State parameter expired' };
      }
      stateData.used = true;
      res.clearCookie(cookieName, cookieOptions());
      return { ok: true, state, payload: stateData.payload };
    },
  };
}
