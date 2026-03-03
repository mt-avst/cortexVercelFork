# Production hardening checklist

Use this checklist to verify and improve production readiness for AdaptaLabs (Cortex).

## Pre-production verification

Before go-live, confirm each item (ops / project owner):

1. [ ] **Vercel env vars** – All required variables set for Production. See [archive/deployment-and-status/VERCEL_ENV_VARS_NEEDED.md](../archive/deployment-and-status/VERCEL_ENV_VARS_NEEDED.md).
2. [ ] **DATABASE_URL** – Neon (or Postgres) URL with a strong or rotated password; no secrets in repo or chat.
3. [ ] **CORS_ORIGIN** – Matches production frontend URL (e.g. `https://adapta-labs-p62q.vercel.app`).
4. [ ] **Google OAuth** – `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` set for production.
5. [ ] **Neon backups** – Backups or PITR enabled; retention noted. See [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) (including “Current setup” and pre-flight checklist).

## Environment and config

- [ ] **Vercel env vars** – All required variables set for Production (and Preview if used). See `archive/deployment-and-status/VERCEL_ENV_VARS_NEEDED.md`.
- [ ] **DATABASE_URL** – Neon (or Postgres) URL with rotated password; no secrets in repo or chat.
- [ ] **CORS_ORIGIN** – Matches production frontend URL (e.g. `https://adapta-labs-p62q.vercel.app`).
- [ ] **Google OAuth** – `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` set for production.

## Security

- [x] **Auth rate limiting** – Login endpoints use `authRateLimit` (10 attempts per 15 min per IP). See `api/utils/rateLimit.ts`.
- [x] **Feedback rate limiting** – `POST /api/feedback` uses `feedbackRateLimit` (20 per 15 min per IP).
- [x] **Sensitive admin routes** – Destructive admin endpoints (e.g. reset DB, set-superadmin) use `adminRateLimit`.
- [x] **Security headers** – Implemented in [vercel.json](../vercel.json) (`headers`): X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy. CSP is optional (report-only first if added later).

## Reliability and errors

- [x] **Error boundary** – Frontend `App` wrapped in `ErrorBoundary`.
- [x] **API logging** – Main routes use `logger` (not `console`) for errors.
- [x] **Health check** – `GET /api/health` returns `{"ok":true}`; use for uptime checks.
- [x] **DB connectivity** – After deploy, verify `GET /api/opportunities` returns 200 (confirms DB + env).

## Data and backups

- [ ] **Neon backups** – Complete the pre-flight checklist in [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) (confirm PITR/backups on, note retention).
- [x] **Run migrations** – After schema changes, run `GET /api/run-migrations` once (or via script with `DATABASE_URL`).

## Performance and monitoring

- [ ] **Vercel analytics** – Optional. Enable in Vercel project settings if desired (no code change).
- [ ] **Logs** – Optional. Use Vercel Functions logs or an external logging service for errors (dashboard or third-party config).
- [x] **Load testing** – k6 script in `load-test/api-smoke.js`; see [TESTING_GUIDE.md](../TESTING_GUIDE.md#load-testing).

## Accessibility (M8)

- [x] **WCAG 2.2 AA** – Contrast fixes (CTA, power button, Settings tab), heading order, page h1s. See `e2e/accessibility.test.ts`.
- [ ] **Re-run a11y tests** – After deploy run `npm run test:a11y:prod` (or see [Pre-production sign-off](#pre-production-sign-off)). Uses production URL and Chromium; use `load` not `networkidle` for production.

## Quick verification after deploy

1. `curl -s https://adapta-labs-p62q.vercel.app/api/health` → `{"ok":true}`
2. `curl -s https://adapta-labs-p62q.vercel.app/api/opportunities` → JSON (200)
3. Open site in browser; log in; submit feedback once to confirm rate limit and DB.

Or run the verification script: `node scripts/verify-production.mjs` (or `npm run verify:prod`). Optional: `BASE_URL=<url>`.

## Pre-production sign-off

One-place summary for go-live and after each deploy:

**Before go-live:** Complete the [Pre-production verification](#pre-production-verification) list above. Details: [VERCEL_ENV_VARS_NEEDED.md](../archive/deployment-and-status/VERCEL_ENV_VARS_NEEDED.md) (env, CORS, OAuth), [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) (backups/PITR, retention).

**After deploy:** Run [Quick verification after deploy](#quick-verification-after-deploy) (or `npm run verify:prod`). Optionally re-run a11y: `npm run test:a11y:prod` (see [Accessibility (M8)](#accessibility-m8)).
