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
- **Google OAuth** – Supported as an alternative login; for company SSO use the generic OIDC vars above and point them at Okta.

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

---

## See also

- [VERCEL_ENV_VARS_NEEDED.md](../archive/deployment-and-status/VERCEL_ENV_VARS_NEEDED.md) – Same env list in Vercel context.
- [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) – Pre-production verification and post-deploy checks.
