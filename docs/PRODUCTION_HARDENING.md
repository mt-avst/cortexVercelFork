# Production hardening checklist

> **Production is the Express backend on Kubera** (`https://adaptalabs.kubera-playground.adaptavist.net`).
> Configuration lives in the `.kubera/` manifests (non-secret config in `config.data`) and the Kubera secret store (secrets); security headers are in `frontend/nginx.conf` and helmet; logs are the backend/frontend pod logs in the cluster.
> The retired standalone-Vercel deployment (`adapta-labs-p62q.vercel.app`) no longer exists; its mechanics are gone, kept here only as history where noted.

Use this checklist to verify and improve production readiness for AdaptaLabs (Cortex).

## Pre-production verification

Before go-live, confirm each item (ops / project owner):

1. [ ] **Config values** – Non-secret config (`NODE_ENV`, `OIDC_*`, `CORS_ORIGIN`, `FRONTEND_URL`, `FIRSTHAND_S3_*`) set in `.kubera/playground-backend.yaml` `config.data`.
2. [ ] **Secrets** – `SESSION_SECRET` and `FIRSTHAND_INTEGRATION_SECRET` (min 32 chars) present in the Kubera secret store; Okta `clientID`/`clientSecret` come from the chart-provisioned `<app>-okta-secret`. No secrets in the repo or in chat.
3. [ ] **Database** – RDS PostgreSQL provisioned by the chart (`database.postgresql`); the backend reads its connection string from `DB_URL`, injected by the chart (the resolver also accepts `DATABASE_URL`/`POSTGRES_URL`/`POSTGRESQL_URL`, but only `DB_URL` is set here).
4. [ ] **CORS_ORIGIN** – Matches the production frontend URL (`https://adaptalabs.kubera-playground.adaptavist.net`).
5. [ ] **RDS backups** – Automated-backup retention confirmed non-zero. See [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) (retention must be verified in the AWS RDS console, not assumed).

## Environment and config

- [ ] **Config vs secrets split** – Non-secret env in `.kubera/playground-backend.yaml` `config.data`; secrets in the Kubera secret store. Changing either requires a redeploy (push to trigger a pipeline) for the pod to pick it up.
- [ ] **DB_URL** – Chart-injected from the provisioned RDS instance; never hardcoded in the repo.
- [ ] **CORS_ORIGIN** – Matches the production frontend URL (`https://adaptalabs.kubera-playground.adaptavist.net`).

## Security

- [x] **Auth rate limiting** – Auth routes use an `express-rate-limit` limiter (`authLimiter` in `backend/src/index.ts`, configured from `RATE_LIMITS`); demo login routes are skipped in development only.
- [x] **CSRF protection** – Double-submit cookie via `csrf-csrf`; on by default under `NODE_ENV=production`. Tokens are issued by `GET /api/csrf-token` and echoed in the `x-csrf-token` header on mutating requests. `ENABLE_CSRF=false` disables it in an emergency.
- [x] **Session cookies** – `httpOnly`, `secure` and `sameSite: strict` under `NODE_ENV=production` (`backend/src/index.ts`).
- [x] **Security headers** – Served by nginx in the frontend image, see [frontend/nginx.conf](../frontend/nginx.conf): X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy. CSP is optional (report-only first if added later). Permissions-Policy is not currently set.

## Reliability and errors

- [x] **Error boundary** – Frontend `App` wrapped in `ErrorBoundary` (`frontend/src/components/ErrorBoundary.tsx`).
- [x] **API logging** – Routes use `logger` (not `console`) for errors.
- [x] **Health check** – The backend serves `GET /health` (used by the Kubera liveness/readiness probes on port 3001); the frontend serves its own `/health` probe. These are internal probes, not a public JSON status page.
- [x] **DB connectivity** – After deploy, verify `GET /api/opportunities` returns 200 (confirms DB + env through the nginx proxy).

## Data and backups

- [ ] **RDS backups** – Confirm automated-backup retention is non-zero; see [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md).
- [x] **Migrations** – Run automatically on every deploy by the backend init container (`npm run migrate && npm run seed && npm run migrate:firsthand` against `DB_URL`); idempotent and checksum-guarded. There is no manual `run-migrations` endpoint.

## Performance and monitoring

- [ ] **Cluster metrics** – Optional. Use the Kubera/cluster observability stack for request and resource metrics.
- [ ] **Logs** – Backend and frontend pod logs in the cluster (via Kubera or `kubectl logs`) are the source for errors and request logs.
- [x] **Load testing** – k6 script in `load-test/api-smoke.js`; see [TESTING_GUIDE.md](../TESTING_GUIDE.md#load-testing).

## Accessibility (M8)

- [x] **WCAG 2.2 AA** – Contrast fixes (CTA, power button, Settings tab), heading order, page h1s. See `e2e/accessibility.test.ts`.
- [ ] **Re-run a11y tests** – After deploy run `npm run test:a11y:prod`. Uses the production URL and Chromium; use `load` not `networkidle` for production. Note the host is Okta-gated, so anonymous flows redirect to login rather than passing cleanly.

## Quick verification after deploy

1. `curl -s https://adaptalabs.kubera-playground.adaptavist.net/api/csrf-token` → `{"csrfToken":"..."}` (200) — backend reachable through the nginx proxy
2. `curl -s https://adaptalabs.kubera-playground.adaptavist.net/api/opportunities` → JSON (200) — confirms DB + env (`GET /` is `optionalAuth`, so this works without a session)
3. Open the site in a browser; log in via Okta; submit feedback once to confirm auth and DB end to end.

Or run the verification script: `node scripts/verify-production.mjs` (or `npm run verify:prod`). Optional: `BASE_URL=<url>`.

Budget 15–30 minutes of ArgoCD lag after a green `trigger-deployment-prod` before concluding a deploy is stuck; verify by the served asset, not by job status.

## Pre-production sign-off

One-place summary for go-live and after each deploy:

**Before go-live:** Complete the [Pre-production verification](#pre-production-verification) list above. Details: [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) (backups/retention).

**After deploy:** Run [Quick verification after deploy](#quick-verification-after-deploy) (or `npm run verify:prod`). Optionally re-run a11y: `npm run test:a11y:prod` (see [Accessibility (M8)](#accessibility-m8)).
