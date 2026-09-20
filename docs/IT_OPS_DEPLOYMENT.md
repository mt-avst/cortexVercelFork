# IT / Ops deployment guide

**For Lilly** – Quick reference for running AdaptaLabs (Cortex) on Kubernetes or other infrastructure, with external database and Okta (or other OIDC) SSO.

---

## Is this “vibe coded”? Kubernetes + external DB

The app was built with AI-assisted tooling but is a standard stack: **React frontend**, **Node API**, **PostgreSQL**. It already uses an **external database only** (no embedded DB): connection via `DATABASE_URL`, `POSTGRES_URL`, `DB_URL`, or individual `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` vars (Kubera's own convention - see backend/src/config/databaseUrl.ts for the full resolution order). So it's compatible with external Postgres by design.

For **Kubernetes**:

- The repo deploys to **Kubera** (Adaptavist's internal Kubernetes): the **Express backend** (`backend/`) runs as a Node service and nginx serves the built frontend, proxying `/api` and `/auth` to the backend. Manifests live in `.kubera/`; the old Vercel serverless `api/` tree was removed in July 2026.
- The app doesn't assume any particular platform; all config is via environment variables (containers, ingress and env injection are the only platform-specific parts).

---

## Auth and Okta

**Yes, the app has its own auth.** The README “SSO” means:

- **OpenID Connect (OIDC)** – The backend supports any OIDC provider via: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL`. **Okta can be used as the app’s OIDC provider**: create an Okta application, set the Okta issuer URL and client credentials in these env vars, and the app handles the login/callback flow. No need for Okta on the load balancer for that.
- **Cookie-based sessions** – After login, the app uses a signed cookie (`SESSION_SECRET`).
- **App-level Okta OIDC (production)** – On Kubera, `auth.okta_app` in the backend manifest provisions an Okta OIDC app and injects `clientID`/`clientSecret`; the backend's `/auth/login`+`/auth/callback` run the flow. Cannot be combined with `auth.okta_alb`. First login for an email in `BOOTSTRAP_SUPERADMIN_EMAILS` is elevated to superadmin.
- **Google OAuth** – Legacy/alternative login; the generic `OIDC_*` vars can also point at any OIDC IdP directly.

**If you put Okta on the load balancer:** The app would need to trust identity headers from the LB (and we’d add code to create a session from those). The simpler approach is to **use Okta as the OIDC provider** (set the four OIDC env vars) and let the app do the redirect/callback flow; then you don’t need Okta at the LB.

---

## Environment variables (runtime)

### Required (app won’t work correctly without these)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL`, `POSTGRES_URL`, `DB_URL`, or `DB_HOST`+`DB_PORT`+`DB_NAME`+`DB_USER`+`DB_PASSWORD` | PostgreSQL connection (e.g. Neon, your own Postgres, or Kubera's injected `DB_*` vars). |
| `SESSION_SECRET` | Secret for signing session cookies (min 32 characters). |
| `CORS_ORIGIN` | Allowed frontend origin (e.g. `https://your-app.example.com`). |
| `FRONTEND_URL` | Base URL of the frontend (e.g. same as `CORS_ORIGIN`). |

**`PORT` and `CORS_ORIGIN` fail closed.**
An unusable value for either throws at boot rather than being quietly coerced, so the pod CrashLoops with the offending value named in the log instead of starting up misconfigured.
`CORS_ORIGIN` must be an absolute `http://` or `https://` URL, and surrounding whitespace is trimmed; `PORT` must be an integer no greater than 65535.
Leaving either unset is fine and gives the defaults (3001 and `http://localhost:3000`), but setting either to an empty string is refused.

**A path on `CORS_ORIGIN` is normalised away, and this can move your OAuth callback base.**
A browser `Origin` header is `scheme://host[:port]` and carries no path, so a value like `https://your-app.example.com/app` matched no origin and CORS was broken.
That value is now reduced to its bare origin, `https://your-app.example.com`, which fixes the matching.
It also changes what the backend builds redirect targets and OAuth callback URLs from, because those are concatenated onto `CORS_ORIGIN` - so `https://your-app.example.com/app/auth/google-callback` becomes `https://your-app.example.com/auth/google-callback`.
If you had a path there and your identity provider has the longer callback registered, either register the new one or set `GOOGLE_OAUTH_REDIRECT_URI` explicitly, which overrides the concatenation entirely.
The backend logs both the written value and the normalised one at boot whenever it actually drops something, so this never happens silently.
The value must have the shape `http(s)://host[:port]` with an optional path, query or fragment, and anything else is refused at boot rather than normalised.
The scheme must be lower-case `http` or `https`, the host may contain only ASCII letters, digits, dots and hyphens, and the port, if present, must be numeric.
No backslash, whitespace, `@` or comma may appear inside the value (surrounding whitespace is still trimmed), so a value carrying userinfo or a comma-separated list of origins is refused, and the host rule refuses a wildcard such as `https://*.example.com`.
This is deliberate: the URL parser would otherwise silently repair such a value into a different, well-formed origin - `http://evil.com\@good.com` would become `http://evil.com` - and the backend sends that origin to browsers with credentials allowed.
An IPv6 literal, an underscore in the host and a non-ASCII host are refused too; write a non-ASCII host in its punycode (`xn--`) form.

### Required for real SSO (e.g. Okta)

| Variable | Purpose |
|----------|---------|
| `OIDC_ISSUER` | OIDC discovery URL (e.g. `https://your-org.okta.com/oauth2/default`). |
| `OIDC_CLIENT_ID` | OIDC client ID from the IdP (Okta application). |
| `OIDC_CLIENT_SECRET` | OIDC client secret from the IdP. |
| `OIDC_REDIRECT_URL` | Callback URL (e.g. `https://your-app.example.com/api/auth/callback` or whatever path the backend uses for the OIDC callback). |

### Optional (depending on features)

| Variable | Purpose |
|----------|---------|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | Only if using Google OAuth instead of (or in addition to) Okta. |
| `CRON_SECRET` | If you run the scheduled reminder cron; the caller sends `Authorization: Bearer <CRON_SECRET>`. |
| `EMAIL_*` (e.g. SMTP) | If you send booking/reminder emails. |

### After first deploy

Migrations run automatically in the backend initContainer (`npm run migrate && npm run seed`) on every deploy.

A migration that genuinely fails now aborts the initContainer, so the deploy stops rather than the pod coming up against a half-applied schema.
Only "the schema is already in this shape" errors (SQLSTATE class 42) are tolerated.
A cancelled statement, a lost connection or a constraint violation used to be logged as "may already exist" and skipped, which could report a successful deploy with a schema change silently absent.

### Confirming a deploy actually landed

Both halves of the app report the commit their image was built from, so this needs no cluster access and no login:

```bash
npm run verify:prod                                  # or against another host: BASE_URL=<url>
EXPECTED_REVISION=<merge-commit-sha> npm run verify:prod
```

Or by hand: `GET /api/health` (backend) and `GET /version.json` (frontend) each return a `revision`.

A green pipeline is not evidence a deploy happened, and neither is a green `semantic-release` job - it can succeed while publishing nothing. See [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md#quick-verification-after-deploy) for the failure modes that look like success.

---

## See also

- [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) – Pre-production verification and post-deploy checks.
