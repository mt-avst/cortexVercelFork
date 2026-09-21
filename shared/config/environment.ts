// Shared Environment Configuration for Adaptalabs Application
// This file contains standardized environment variable definitions and validation

import { z } from 'zod';

// ============================================================================
// ENVIRONMENT SCHEMAS
// ============================================================================

/**
 * THE ENVIRONMENTS THIS APPLICATION HAS BEEN MODELLED FOR.
 *
 * Named rather than inlined so that adding a fourth is one visible edit, pinned as a
 * literal in backend/src/config/__tests__/environment.test.ts. See NODE_ENV below for
 * why anything outside this list stops the boot (#4).
 */
export const NODE_ENVS = ['development', 'production', 'test'] as const;

/**
 * Backend environment variables schema
 */
export const backendEnvSchema = z.object({
  // Application Configuration
  //
  // FAIL CLOSED on an unrecognised value (#4). This was `.catch(() => 'development')`,
  // which meant `staging`, `prod`, `Production` or a typo silently resolved to
  // 'development' - and every security control in backend/src/index.ts is keyed off
  // `config.NODE_ENV === 'production'`. A deployment that believed it was production
  // ran with helmet off, CSRF off, `secure: false` / `sameSite: 'lax'` /
  // `domain: 'localhost'` session cookies, `trust proxy` false (which also breaks
  // every rate limiter's keying) and raw error messages returned to clients. Verified
  // by running the real entry point with NODE_ENV=prod: it started and logged
  // `"environment":"development"`, `"csrfEnabled":false`, `Helmet disabled`.
  //
  // `.default` rather than `.catch`, so the three cases separate:
  //   UNSET          -> 'development'. `npm run dev` sets nothing and must keep working.
  //   RECOGNISED     -> itself.
  //   ANYTHING ELSE  -> ZodError, thrown by validateBackendEnvironment below. That runs
  //                     at module scope in backend/src/config/index.ts, so the process
  //                     dies on import - before it binds a port, and before the
  //                     migrate/seed initContainer touches the database. A pod that
  //                     cannot boot is a visible CrashLoopBackOff; a pod that boots
  //                     insecurely is not.
  //
  // The EMPTY STRING throws rather than being treated as unset. It is a variable
  // something deliberately wrote - most plausibly an unresolved `${...}` in a chart or
  // compose file - so it carries a failed intent, unlike a name that was never set.
  //
  // zod's own enum message already names the offending value and lists the permitted
  // ones ("Invalid enum value. Expected 'development' | 'production' | 'test',
  // received 'prod'"), which is the whole on-call value of this change. It is pinned as
  // a literal in backend/src/config/__tests__/environment.test.ts so a zod upgrade that
  // drops the received value fails a named test rather than degrading quietly.
  NODE_ENV: z.enum(NODE_ENVS).default('development'),

  // FAILS CLOSED on an unusable value (#48), for the same reason NODE_ENV does:
  // a value that quietly becomes something else at boot is invisible from the
  // logs and lands as a symptom somewhere unrelated.
  //
  // WHAT `.catch(() => 3001)` ACTUALLY DID. It never fired for a non-numeric
  // value at all, because `transform(Number)` RETURNS NaN rather than throwing -
  // there was nothing for the `.catch` to catch. Measured on this schema before
  // the change: `PORT=abc` parsed to NaN and `PORT=''` parsed to 0. Live consumer
  // is `app.listen(config.PORT)` in backend/src/index.ts, and `listen(NaN)` binds
  // an EPHEMERAL port, so on Kubera the readiness probe on 3001 fails, the pod
  // never goes Ready, and nothing in the logs names the cause.
  //
  // `z.coerce.number()` rather than `z.string().transform(Number)` because the
  // coercion is then INSIDE the schema, so `.int().positive()` runs against the
  // number and a failure is a ZodError - which validateBackendEnvironment below
  // turns into the boot-time throw. The three cases separate exactly as NODE_ENV's
  // do: UNSET -> 3001 (`npm run dev` sets nothing), a usable port -> itself,
  // anything else -> a named refusal at import. `PORT=''` throws with the rest,
  // for the reason spelled out above: a deliberately-written empty value carries a
  // failed intent that an absent name does not.
  //
  // `.max(65535)` IS THE REAL CEILING (#59). `.int().positive()` alone accepts
  // any positive integer, so `PORT=1e5` coerced to 100000 and passed validation
  // honestly - 100000 IS an integer - then failed inside `app.listen()`, which
  // is the wrong place for it. Measured on this schema before the change:
  // `PORT=1e5` -> 100000 accepted, `PORT=99999` -> 99999 accepted. A port is a
  // 16-bit field, so 65535 is not a policy number somebody picked; it is the
  // largest value `listen()` can bind. Pinned as a literal in
  // backend/src/config/__tests__/environment.test.ts, on both sides: 65535
  // boots and 65536 does not.
  //
  // ponytail: `z.coerce.number()` is `Number()`, so it still reads NUMERIC
  //   LITERALS rather than port strings - `PORT=0x10` becomes 16 and
  //   `PORT=' 3001 '` becomes 3001. Both land on a usable port so neither can
  //   reach the #48 failure mode, and every PORT setter in the tree is the
  //   literal 3001 (swept over all tracked files for #59). Upgrade path if a
  //   hex port ever does bite: `z.string().trim().regex(/^\d+$/).pipe(...)`,
  //   which refuses the shape rather than the value.
  PORT: z.coerce.number().int().positive().max(65535).default(3001),

  // Database Configuration
  DATABASE_URL: z.string().optional(),

  // Session Configuration
  SESSION_SECRET: z.string().min(32, 'Session secret must be at least 32 characters'),

  // OIDC Configuration
  OIDC_ISSUER: z.string().url('OIDC issuer must be a valid URL').optional(),
  OIDC_CLIENT_ID: z.string().min(1, 'OIDC client ID is required').optional(),
  OIDC_CLIENT_SECRET: z.string().min(1, 'OIDC client secret is required').optional(),
  OIDC_REDIRECT_URL: z.string().url('OIDC redirect URL must be a valid URL').optional(),

  // Admin Configuration
  ADMIN_EMAILS: z.string().optional().transform(val =>
    val ? val.split(',').map(email => email.trim()) : []
  ),

  // CORS Configuration
  //
  // `.default` rather than `.catch` (#48). A malformed URL used to become
  // http://localhost:3000 in SILENCE - measured on this schema - and the live
  // consumer is the cors() origin in backend/src/index.ts, so in production that
  // presented as browser CORS errors on every request rather than as a config
  // fault. It narrows access rather than widening it, so this is availability and
  // not security; it is still a value nobody chose. Unset still yields the
  // localhost default, which is what `npm run dev` relies on.
  // `.kubera/playground-backend.yaml` sets a valid absolute URL.
  //
  // AND IT MUST BE AN http(s) ORIGIN, TRIMMED (#59). `.url()` is `new URL()`,
  // which parses ANY scheme, so the validator was answering a much wider
  // question than the one being asked. Measured on this schema before the
  // change, all ACCEPTED: `localhost:3000` (read as the scheme `localhost:`
  // with the path `3000` - exactly what somebody types when they mean
  // `http://localhost:3000`), `htp://example.com`, `ftp://example.com`,
  // `javascript:alert(1)`, and `' https://x.com '` keeping its padding.
  //
  // A browser `Origin` header is always `scheme://host[:port]`, lower-cased
  // scheme, no padding, and the cors() middleware in backend/src/index.ts
  // compares it to this string. So every one of those boots happily and then
  // matches nothing, which reaches an operator as browser CORS errors on every
  // request rather than as a config fault - the same end state #48 fixed,
  // reached by a different route.
  //
  // `.trim()` because a trailing space in a chart value or an `.env` line is
  // invisible in review, and trimming is what the operator meant. It only ever
  // widens what boots.
  //
  // WHAT THE ORDER ACTUALLY BUYS, measured rather than assumed - an earlier
  // version of this comment claimed the order was load-bearing for ASCII
  // padding, and the refute gate showed it was not. Swapping to
  // `.url().trim()` passes all 47 arms of environment.test.ts, because
  // `new URL()` strips leading and trailing C0-and-space ITSELF, so `.url()`
  // never sees the padding as a problem under either order.
  //
  // They diverge only on whitespace `String.prototype.trim()` strips and the
  // WHATWG parser does not. Measured, both orders:
  //
  //   '\u00a0https://x.com\u00a0'  trim().url(): accepted   url().trim(): REFUSED
  //   '\u3000https://x.com'          trim().url(): accepted   url().trim(): REFUSED
  //
  // So THIS order is the more permissive one, and a non-breaking space pasted
  // out of a wiki page or a Slack message is the accident it forgives. Pinned
  // by a U+00A0 arm in environment.test.ts, which is what makes the order
  // load-bearing rather than decorative.
  //
  // The `.refine()` narrows, so it is the deploy-risk half: swept over
  // ALL tracked files for CORS_ORIGIN before merging, every value set anywhere
  // in the tree is http or https (`.kubera/playground-backend.yaml`,
  // `backend/env.example`, `backend/env.production.example`,
  // `docker.env.production.example`, and `docker-compose.prod.yml` which just
  // passes `${CORS_ORIGIN}` through from the operator's environment).
  //
  // Case-sensitive on purpose: `HTTP://x.com` is a URL no browser will ever
  // send as an Origin, so accepting it would leave the same hole through a
  // narrower door. `http:/x.com` with ONE slash goes the same way - `new URL()`
  // normalises it to `http://x.com/` but zod returns the string as written, so
  // it is refused rather than repaired. Both are pinned as literals in
  // backend/src/config/__tests__/environment.test.ts.
  //
  // THE ASYMMETRY WITH THE PATH IS STILL DELIBERATE, and #64 settled it rather
  // than removing it. An upper-cased scheme and a trailing slash are equally
  // broken config, but the right FIX differs: refusing an upper-cased scheme is
  // the whole answer, whereas a path is NORMALISED away by the transform below.
  // Refusing a scheme narrows what boots; normalising a path does not, which is
  // why only one of the two carried deploy risk.
  //
  // THE PATH IS NORMALISED AWAY RATHER THAN REFUSED (#64).
  //
  // Measured before the fix, against the schema as it then stood:
  //   `http://x.com/`          -> accepted as `http://x.com/`
  //   `https://x.com/app`      -> accepted as `https://x.com/app`
  //   `https://x.com/a/b?q=1#f` -> accepted as `https://x.com/a/b?q=1#f`
  // A browser `Origin` header is `scheme://host[:port]` with no path and no
  // trailing slash, so every one of those booted and matched nothing. The
  // trailing slash is the likeliest of the family, because it is the shape the
  // address bar shows and therefore the shape an operator copies.
  //
  // REFUSING WAS THE OTHER OPTION AND IS THE WRONG ONE. `docker-compose.prod.yml`
  // passes `${CORS_ORIGIN}` straight through from an operator environment this
  // repository cannot enumerate, so a no-path rule could refuse a boot that
  // succeeds today. `new URL(v).origin` is exactly the string a browser sends,
  // so the transform on its own refuses nothing. The allow-list further down
  // DOES narrow what boots, and says exactly what it narrows.
  //
  // WHAT NORMALISING ALSO CHANGES, named because it is not free. The write-back
  // in backend/src/config/index.ts puts this value into
  // `process.env.CORS_ORIGIN`, which eleven readers outside tests use as a
  // redirect target or an OAuth callback base built by concatenation. An
  // operator who set `https://x.com/app` gets `https://x.com/callback` after
  // this change where they got `https://x.com/app/callback` before. That is the
  // correct reading of a variable named for an ORIGIN, and their CORS was
  // broken either way, but it is a behaviour change on a value this repository
  // cannot see - so config/index.ts logs a warning naming both forms when the
  // normalisation actually drops something, rather than changing it silently.
  //
  // ORDER IS LOAD-BEARING. The refine runs BEFORE this transform, so
  // `http:/x.com` (one slash) and `HTTP://x.com` are still refused rather than
  // repaired - `new URL()` would happily normalise both. Pinned as literals in
  // backend/src/config/__tests__/environment.test.ts.
  CORS_ORIGIN: z
    .string()
    .trim()
    .url('CORS origin must be a valid URL')
    .refine((value) => /^https?:\/\//.test(value), 'CORS origin must be an http(s) URL')
    // USERINFO IS REFUSED, and this refine exists BECAUSE of the transform
    // below rather than alongside it (#64, raised by the security gate).
    //
    // MEASURED against the real schema with the transform and without this
    // arm - every one of these was accepted:
    //   `https://app.example.com@evil.com`       -> `https://evil.com`
    //   `https://app.example.com:8443@evil.com/` -> `https://evil.com`
    //   `https://x.com%2f@evil.com`              -> `https://evil.com`
    // Everything before the `@` is userinfo, so the host is what follows it.
    //
    // WHAT THIS REFINE CANNOT SEE. It asks the parser, and the parser reports
    // an EMPTY username for `https://@evil.com`, `https://:@evil.com` and a
    // backslash shape like `http://evil.com\@good.com` (the backslash reads as
    // `/`, so the `@` lands in the path). Those are refused by the allow-list
    // below, not here. This refine stays for the MESSAGE: a value that really
    // does carry a username or password is told so by name.
    //
    // WHY THAT IS WORSE AFTER THE TRANSFORM THAN BEFORE IT. index.ts passes
    // this to `cors()` as a STRING, and for a string the cors package emits it
    // as `Access-Control-Allow-Origin` verbatim without comparing it to the
    // request Origin - the browser does the comparing, and `credentials: true`
    // is set alongside. Un-normalised, `https://app.example.com@evil.com` is an
    // ACAO no browser ever matches, so the misconfiguration fails CLOSED.
    // Normalised, it becomes a well-formed origin a browser WILL match, so it
    // fails OPEN, granting credentialed cross-origin reads to the host after
    // the `@` rather than to the one the operator appears to have written.
    //
    // No attacker-controlled path exists today - swept every tracked file, and
    // CORS_ORIGIN is only ever set from deployment config, never composed from
    // a branch name or a request. This is defence in depth against a value the
    // transform would otherwise quietly repair into something dangerous, and
    // it narrows only values that are already broken, so it carries none of the
    // deploy risk that kept a no-path rule out of #59.
    // THE try/catch IS LOAD-BEARING, not defensive dressing. zod runs a
    // refinement even when an earlier STRING check on the same chain has
    // already failed, so this sees `not a url` and `` as well as the values it
    // is here to judge - and an unguarded `new URL()` then throws a raw
    // TypeError that escapes the ZodError handling entirely. Measured: it
    // turned four of #59's refusal arms from their own named message into
    // `Invalid URL`. Returning true on a parse failure is correct rather than
    // lenient: `.url()` owns that refusal and reports it with its own message.
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.username === '' && parsed.password === '';
      } catch {
        return true;
      }
    }, 'CORS origin must not contain userinfo')
    // THE SHAPE IS ALLOW-LISTED on the trimmed RAW text, before the parser
    // sees it (#64, raised by the security gate). The transform below does
    // more than drop a path: the WHATWG parser reads `\` as `/`, strips tab
    // and newline from anywhere, percent-decodes and case-folds the host and
    // maps fullwidth letters, ideographic dots and zero-width characters onto
    // ASCII. So a broken value can come out as a DIFFERENT, well-formed origin
    // - measured on this branch before this refine, all accepted:
    //   `http://evil.com\@good.com`       -> `http://evil.com`
    //   `https:///evil.com`               -> `https://evil.com`
    //   `https://good.com<LF>.evil.com`   -> `https://good.com.evil.com`
    //   `https://%65vil.com`              -> `https://evil.com`
    //   `https://a.com/,https://evil.com` -> `https://a.com`
    // and the userinfo refine above passed every one of them. A block-list
    // would stay one entry behind the parser, so this names the one shape an
    // operator means and refuses the rest: lower-case http or https, a host of
    // ASCII letters, digits, dots and hyphens, an optional numeric port, and
    // an optional path, query or fragment with no backslash, whitespace, `@`
    // or comma in it.
    //
    // It does NOT make the parser's output character-identical to what was
    // written: an IPv4 address in shorthand or hex still gets rewritten into
    // dotted form (measured: `https://127.1` and `https://0x7f000001` both
    // come out as `https://127.0.0.1`). That is the SAME host written another
    // way - a browser serialises its own Origin the same way - so it is not
    // the class of repair this refine exists to stop, which is a value coming
    // out as a DIFFERENT host from the one written between the slashes.
    //
    // WHAT THIS NARROWS, because unlike the transform it is not free. It
    // refuses some values origin/main booted: an IPv6 literal (`http://[::1]`),
    // an underscore in the host, and a non-ASCII host. None is a shape a
    // deployed CORS origin takes, and a non-ASCII host can still be written in
    // punycode. Swept every tracked file for a CORS_ORIGIN setter (git grep
    // -i, test files and the canary manifest excluded): all five literal
    // values match, and docker-compose.prod.yml passes `${CORS_ORIGIN}`
    // through from outside this repository, which no sweep can see.
    .refine(
      (value) => /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(?:[/?#][^\\\s@,]*)?$/.test(value),
      'CORS origin must be http(s)://host[:port] with an optional path - a host of ASCII letters, digits, dots and hyphens only, and no backslash, whitespace, @ or comma anywhere'
    )
    .transform((value) => new URL(value).origin)
    .default('http://localhost:3000'),

  // Security Configuration
  //
  // ponytail: ENABLE_CSRF and FRONTEND_URL still `.catch()`, and #48 left them
  //   there deliberately. Both are INERT: index.ts and every route read these two
  //   straight off `process.env`, so nothing consumes the parsed value and the
  //   coercion has no ceiling to hit. FRONTEND_URL in particular IS set in
  //   `.kubera/playground-backend.yaml`, so making it fail closed is a deploy-risk
  //   decision with no consumer to justify it today. Upgrade path: give either a
  //   real consumer and it takes `.default()` in the same edit.
  ENABLE_CSRF: z.string().transform(val => val === 'true').catch(() => false),

  // Email Configuration (Optional)
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.string().transform(Number).optional(),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),

  // Google Calendar Configuration (Optional)
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),

  // Google OAuth Configuration (Optional - for user calendar integration)
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url('OAuth redirect URI must be a valid URL').optional(),

  // Frontend URL
  FRONTEND_URL: z.string().url('Frontend URL must be a valid URL').catch(() => 'http://localhost:3000'),

  // FirstHand integration HMAC secret, still referenced by the internalised
  // runtime's integration-auth module. The outbound HMAC proxy (FIRSTHAND_BASE_URL)
  // and the inbound callback receiver were removed with the merge.
  FIRSTHAND_INTEGRATION_SECRET: z.string().min(32, 'FirstHand integration secret must be at least 32 characters').optional(),

  // S3 bucket + region for the internalised recording storage, reached via the
  // backend's IRSA role (default AWS credential chain — no static keys). Unset
  // FIRSTHAND_S3_BUCKET disables S3 storage; FIRSTHAND_S3_REGION falls back to
  // AWS_REGION and then us-east-1.
  FIRSTHAND_S3_BUCKET: z.string().optional(),
  FIRSTHAND_S3_REGION: z.string().optional(),
});

/**
 * Frontend environment variables schema (Vite uses VITE_ prefix)
 */
export const frontendEnvSchema = z.object({
  // API Configuration
  VITE_API_URL: z.string().url('API URL must be a valid URL').catch(() => 'http://localhost:3001'),
  VITE_API_BASE_URL: z.string().url('API base URL must be a valid URL').optional(),
  VITE_AUTH_BASE_URL: z.string().url('Auth base URL must be a valid URL').optional(),

  // Environment
  VITE_ENVIRONMENT: z.enum(['development', 'production', 'test']).catch(() => 'development' as const),

  // Feature Flags
  VITE_ENABLE_ANALYTICS: z.string().transform(val => val === 'true').catch(() => false),
  VITE_ENABLE_DEBUG: z.string().transform(val => val === 'true').catch(() => false),
});

// ============================================================================
// ENVIRONMENT TYPES
// ============================================================================

export type BackendEnvironment = z.infer<typeof backendEnvSchema>;
export type FrontendEnvironment = z.infer<typeof frontendEnvSchema>;

// ============================================================================
// ENVIRONMENT VALIDATION
// ============================================================================

/**
 * Validate backend environment variables
 */
export const validateBackendEnvironment = (): BackendEnvironment => {
  try {
    return backendEnvSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((err: any) =>
        `${err.path.join('.')}: ${err.message}`
      ).join('\n');

      throw new Error(`Environment validation failed:\n${errorMessages}`);
    }
    throw error;
  }
};

/**
 * Validate frontend environment variables
 * Note: This function is only called from the frontend (Vite) context
 * The actual import.meta.env access happens in the frontend's local copy
 */
export const validateFrontendEnvironment = (): FrontendEnvironment => {
  try {
    // Use process.env as fallback - frontend has its own copy with import.meta.env
    return frontendEnvSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((err: any) =>
        `${err.path.join('.')}: ${err.message}`
      ).join('\n');

      throw new Error(`Environment validation failed:\n${errorMessages}`);
    }
    throw error;
  }
};

// ============================================================================
// ENVIRONMENT CONFIGURATION OBJECTS
// ============================================================================

/**
 * Get validated backend environment configuration
 */
export const getBackendConfig = (): BackendEnvironment => {
  return validateBackendEnvironment();
};

/**
 * Get validated frontend environment configuration
 */
export const getFrontendConfig = (): FrontendEnvironment => {
  return validateFrontendEnvironment();
};
