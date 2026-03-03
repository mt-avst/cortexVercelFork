# Production hardening checklist

Use this checklist to verify and improve production readiness for AdaptaLabs (Cortex).

## Environment and config

- [ ] **Vercel env vars** – All required variables set for Production (and Preview if used). See `archive/deployment-and-status/VERCEL_ENV_VARS_NEEDED.md`.
- [ ] **DATABASE_URL** – Neon (or Postgres) URL with rotated password; no secrets in repo or chat.
- [ ] **CORS_ORIGIN** – Matches production frontend URL (e.g. `https://adapta-labs-p62q.vercel.app`).
- [ ] **Google OAuth** – `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` set for production.

## Security

- [x] **Auth rate limiting** – Login endpoints use `authRateLimit` (10 attempts per 15 min per IP). See `api/utils/rateLimit.ts`.
- [x] **Feedback rate limiting** – `POST /api/feedback` uses `feedbackRateLimit` (20 per 15 min per IP).
- [x] **Sensitive admin routes** – Destructive admin endpoints (e.g. reset DB, set-superadmin) use `adminRateLimit`.
- [ ] **Security headers** – Optional: add CSP, X-Frame-Options, etc. via Vercel config or middleware.

## Reliability and errors

- [x] **Error boundary** – Frontend `App` wrapped in `ErrorBoundary`.
- [x] **API logging** – Main routes use `logger` (not `console`) for errors.
- [x] **Health check** – `GET /api/health` returns `{"ok":true}`; use for uptime checks.
- [x] **DB connectivity** – After deploy, verify `GET /api/opportunities` returns 200 (confirms DB + env).

## Data and backups

- [ ] **Neon backups** – Complete the pre-flight checklist in [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) (confirm PITR/backups on, note retention).
- [x] **Run migrations** – After schema changes, run `GET /api/run-migrations` once (or via script with `DATABASE_URL`).

## Performance and monitoring

- [ ] **Vercel analytics** – Enable in project settings if desired.
- [ ] **Logs** – Use Vercel Functions logs or external logging for errors.
- [x] **Load testing** – k6 script in `load-test/api-smoke.js`; see [TESTING_GUIDE.md](../TESTING_GUIDE.md#load-testing).

## Accessibility (M8)

- [x] **WCAG 2.2 AA** – Contrast fixes (CTA, power button, Settings tab), heading order, page h1s. See `e2e/accessibility.test.ts`.
- [ ] **Re-run a11y tests** – After deploy: `BASE_URL=https://adapta-labs-p62q.vercel.app npx playwright test e2e/accessibility.test.ts --config=playwright.prod.config.ts --project=chromium` (use `load` in tests; production may timeout on `networkidle`).

## Quick verification after deploy

1. `curl -s https://adapta-labs-p62q.vercel.app/api/health` → `{"ok":true}`
2. `curl -s https://adapta-labs-p62q.vercel.app/api/opportunities` → JSON (200)
3. Open site in browser; log in; submit feedback once to confirm rate limit and DB.
