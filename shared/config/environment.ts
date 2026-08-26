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
  // THE ASYMMETRY WITH #64 IS DELIBERATE AND WORTH NAMING, because the
  // deploy-risk argument below applies to both. An upper-cased scheme and a
  // trailing slash are equally broken config, and equally unsweepable in the
  // `${CORS_ORIGIN}` that `docker-compose.prod.yml` takes from an operator.
  // They are treated differently because the right FIX differs: refusing an
  // upper-cased scheme is the whole answer, whereas for a path the likely
  // answer is to NORMALISE (`new URL(v).origin` is exactly what a browser
  // sends) rather than refuse - and choosing between refusing and normalising
  // is a design decision, not a line to bolt onto somebody else's MR.
  //
  // ponytail: the scheme is checked, the PATH is not - `http://x.com/` and
  //   `http://x.com/app` still boot and still match no Origin header
  //   -> #64, same family.
  CORS_ORIGIN: z
    .string()
    .trim()
    .url('CORS origin must be a valid URL')
    .refine((value) => /^https?:\/\//.test(value), 'CORS origin must be an http(s) URL')
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
