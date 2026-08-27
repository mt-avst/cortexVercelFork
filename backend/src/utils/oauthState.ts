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
 * ponytail: the nonce cookie has no `__Host-` prefix, so a sibling subdomain
 *   setting `Domain=.adaptavist.net` could toss one in
 *   -> #94, latent until Google OAuth credentials are provisioned. Since the
 *   calendar callback takes its user from the state's payload rather than the
 *   session, a tossed state would write the VICTIM's Google tokens onto the
 *   ATTACKER's row. The prefix makes that structurally impossible, and it needs
 *   `secure: true` unconditionally - which touches the LOGIN flow's cookie too,
 *   which is why it is not being changed in the same MR as the flow it protects.
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
   * Cookie the nonce is bound to. MUST be distinct per flow.
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

export function createOAuthStateGuard<P = undefined>(
  options: OAuthStateGuardOptions
): OAuthStateGuard<P> {
  const { cookieName } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  // Path '/' because a flow starts under /api/... but the provider redirect can
  // land elsewhere (/auth/callback).
  const cookieOptions = () => ({
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
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
