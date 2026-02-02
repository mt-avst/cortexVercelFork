# Learnings

Project context and decisions for AdaptaLabs. Reference this in new chats to get up to speed.

---

## Project overview

- **Name**: AdaptaLabs (adaptalabs-root), **version**: 7.2.6
- **Purpose**: Internal recruitment app — researchers post opportunities (studies/sessions), employees browse and book sessions. Includes polls/surveys, dashboard, feedback, notifications.
- **Production**: https://adapta-labs-p62q.vercel.app  
- **Status**: Ready for alpha. Core flows (book, cancel, create/edit/duplicate opportunity, dashboard, settings, poll tracking) working; E2E doc: `E2E_PLAYWRIGHT_RUN_2026-02-02.md`.

---

## Tech stack

| Layer | Tech |
|-------|------|
| **Frontend** | React 18, TypeScript, Vite, React Router, Tailwind, Radix UI, Framer Motion, Three.js (react-three-fiber) for background effects |
| **API (production)** | Vercel serverless functions under `/api` — each file in `api/` is a route (e.g. `api/sessions/[id].ts` → `DELETE /api/sessions/:id`). Uses `@vercel/node`, `pg`, `nodemailer`, `zod`. **Root `package.json`** must list these so Vercel bundles them for serverless. |
| **Backend (local dev)** | Express in `backend/` — used for local development; production uses only `api/` on Vercel. |
| **Database** | PostgreSQL (e.g. Neon or Vercel Postgres). Connection via `DATABASE_URL` or `POSTGRES_URL`. |
| **Auth** | Cookie-based sessions (signed with `SESSION_SECRET`). Google OAuth + demo login. Roles: `employee`, `researcher_admin`, `superadmin`. |
| **Deployment** | Vercel. Root directory **must be repo root** (not `frontend`), so both frontend and `api/` are deployed. |

---

## Repo structure (key dirs)

```
/api          → Vercel serverless API routes (auth, bookings, opportunities, sessions, calendar, feedback, admin, health, run-migrations)
/backend      → Express server for local dev
/frontend     → React app (Vite build → frontend/dist)
/shared       → Shared TypeScript types/utils; referenced by api via vercel.json "includeFiles": "shared/**"
/e2e          → Playwright tests (production-smoke.test.ts, etc.)
/scripts      → set-superadmin, migrate-tokens, etc.
```

---

## Key flows

- **User**: Browse opportunities → Sign in (Google or demo) → Book session → My Bookings; cancel/reschedule.
- **Admin**: Create/Edit/Duplicate opportunities; manage sessions (calendar grid); dashboard analytics; settings (notifications); poll/survey click tracking.
- **Auth routes**: `/auth/demo-login`, `/auth/admin-login`, `/auth/google-login`, `/auth/google-callback`, `/auth/logout` (rewritten in vercel.json to `/api/auth/...`).

---

## Deployment (Vercel)

1. **Root Directory**: Project Settings → General → Root Directory = empty (repo root). If set to `frontend`, only the SPA deploys and `/api/*` returns HTML.
2. **Env vars (required)**: `DATABASE_URL` (or `POSTGRES_URL`), `SESSION_SECRET`, `CORS_ORIGIN`, `FRONTEND_URL`. See `VERCEL_ENV_VARS_NEEDED.md`.
3. **Optional**: Google OAuth (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`), email vars.
4. **After deploy**: Run migrations once: `GET https://<your-domain>/api/run-migrations`. Seed demo data if needed (admin/script).
5. **Deploy command**: From repo root, `vercel --prod`. Install command in vercel.json runs `npm install` at root plus in `api`, `frontend`, `backend`.

---

## Testing

- **Smoke**: `npm run test:smoke` (Playwright against production; config: `playwright.prod.config.ts`). Expect some tests skipped when no demo data (e.g. opportunity detail, demo login).
- **E2E checklist**: `END_TO_END_TESTING_CHECKLIST.md` — full flow list; results in `E2E_PLAYWRIGHT_RUN_2026-02-02.md`.
- **API health**: `GET /api/health` returns `{"ok":true}` when API is deployed.

---

## Key docs to reference

| Doc | Purpose |
|-----|---------|
| `README.md` | Setup, Docker, local dev |
| `VERCEL_ENV_VARS_NEEDED.md` | Env vars, root dir, migrations |
| `DEPLOYMENT_STATUS_FINAL.md` | Deployment status |
| `END_TO_END_TESTING_CHECKLIST.md` | E2E flow checklist |
| `E2E_PLAYWRIGHT_RUN_2026-02-02.md` | Latest E2E results, issues fixed |
| `KNOWN_ISSUES.md` | Known limitations, workarounds |
| `USER_GUIDE.md` / `ADMIN_GUIDE.md` | User and admin docs |
| `DATABASE_SETUP.md`, `VERCEL_POSTGRES_SETUP.md` | DB setup |
| `GOOGLE_OAUTH_PRODUCTION_SETUP.md` | Google OAuth in prod |

---

## Decisions

- **API dependencies in root**: Vercel serverless functions use root `node_modules`. So `pg`, `nodemailer`, `zod`, `@vercel/node` live in root `package.json` to avoid 502s/missing modules in production.
- **Superadmin bypass**: For delete session and duplicate opportunity, `superadmin` can act on any owner’s resources; other admins are restricted to resources they own.
- **Session delete 403**: DELETE `/api/sessions/:id` requires admin and (unless superadmin) ownership of the opportunity. Clear 403 messages (`ADMIN_REQUIRED` / `OWNER_ONLY`) and UI shows API error message on failure.
- **Duplicate opportunity**: Implemented as `POST /api/opportunities/:id/duplicate` (new draft with “(copy)” in title). Auth/ownership same as edit (owner or superadmin).

---

## Gotchas / workarounds

- **SlowNeuralBackground intercepts clicks**: Three.js canvas was capturing pointer events on admin Create/Edit. Fix: `.slow-neural-background` and `.slow-neural-background canvas { pointer-events: none !important; }` in `frontend/src/styles/_components.css`.
- **Booking confirm button intercepted**: Confirm button in calendar booking popover was behind sticky header (`.calendar-day-sessions`). Fix: when confirming a slot, the calendar grid container gets higher z-index (e.g. 101) in `frontend/src/components/CalendarGrid.tsx` so the popover stacks above the header.
- **Vercel root directory**: If set to `frontend`, `/api/*` serves the SPA and API calls get HTML; set Root Directory to repo root.
- **Migrations**: Must run `GET /api/run-migrations` after first deploy (or when schema changes); not automatic.
- **Demo login visibility**: Demo Access pills (User / Admin / Superadmin) on the landing page are **hidden** in production builds unless `VITE_SHOW_DEMO_LOGIN=true` is set. They are shown in development (`import.meta.env.DEV`). To show them in production (e.g. staging), add `VITE_SHOW_DEMO_LOGIN=true` in Vercel env vars and redeploy. The API routes (`/api/auth/demo-login`, etc.) remain; only the UI is conditional.
- **Reset DB to two users and blank studies**: `POST /api/admin/reset-keep-two-users` (superadmin only) deletes all bookings, sessions, and opportunities, then deletes all users except those named "Nick Fine" or "Greta Baisch". Or run locally: `DATABASE_URL="..." node scripts/reset-keep-two-users.js`.
- **Performance (lag)**: Neural backgrounds were tuned down: lower node counts (SlowNeural 350→180, Organic 500→250), `dpr` capped at 1.25, lighter Bloom. When `prefers-reduced-motion: reduce`, Three.js Canvas is skipped (static gradient only). SpotlightCard mousemove is throttled via requestAnimationFrame.
- **Light-mode contrast (WCAG AA)**: Admin/opportunity form descriptive text, placeholders, and selected values must meet 4.5:1 on white. The "TEXT READABILITY - Admin Panel" block in `_components.css` is scoped to `body.theme-dark` only; light mode uses `--text-muted` (#6B7280) from `_themes.css`. Additional light-mode overrides: leaderboard zero score, calendar hint text, ghost danger button, unmoderated/question badges use #6B7280 (Gray-500) in light theme.

---

## What we learned

- **Light-mode contrast**: Avoid #94A3B8 / #9CA3AF (Slate-400 / Gray-400) for body text, descriptions, placeholders, or selected values on white backgrounds—they fall below WCAG AA. Use #6B7280 (Gray-500) or darker for muted text in light theme; reserve lighter grays for dark theme only.

---

## Links

- Production: https://adapta-labs-p62q.vercel.app  
- Vercel project: (see VERCEL_ENV_VARS_NEEDED.md for dashboard link)
