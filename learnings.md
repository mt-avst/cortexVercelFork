# Learnings

Project context and decisions for AdaptaLabs. Reference this in new chats to get up to speed.

---

## Project overview

- **Name**: AdaptaLabs (adaptalabs-root), **version**: 7.3.12
- **Purpose**: Internal recruitment app — researchers post opportunities (studies/sessions), employees browse and book sessions. Includes polls/surveys, dashboard, feedback, notifications.
- **Production**: https://adapta-labs-p62q.vercel.app  
- **Status**: Ready for alpha. Core flows (book, cancel, create/edit/duplicate opportunity, dashboard, settings, poll tracking) working; E2E results in `archive/test-results/`.

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
2. **Env vars (required)**: `DATABASE_URL` (or `POSTGRES_URL`), `SESSION_SECRET`, `CORS_ORIGIN`, `FRONTEND_URL`. See `archive/deployment-and-status/VERCEL_ENV_VARS_NEEDED.md`.
3. **Optional**: Google OAuth (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`), email vars.
4. **After deploy**: Run migrations once: `GET https://<your-domain>/api/run-migrations`. Seed demo data if needed (admin/script).
5. **Deploy command**: From repo root, `vercel --prod`. Install command in vercel.json runs `npm install` at root plus in `api`, `frontend`, `backend`.

---

## Testing

- **Smoke**: `npm run test:smoke` (Playwright against production; config: `playwright.prod.config.ts`). Expect some tests skipped when no demo data (e.g. opportunity detail, demo login).
- **Browsers**: E2E runs on Chromium, Firefox, WebKit, Mobile Chrome, Mobile Safari, and Microsoft Edge. To run Edge tests, install Microsoft Edge or run `npx playwright install msedge`.
- **Accessibility**: Axe tests in `e2e/accessibility.test.ts` cover Home, Opportunity detail, Admin, Create opportunity, My Bookings, Feedback, Settings. Run with dev server up: `npx playwright test e2e/accessibility.test.ts --config=playwright.accessibility.config.ts`.
- **E2E checklist**: `archive/test-results/END_TO_END_TESTING_CHECKLIST.md` — full flow list; results in `archive/test-results/`.
- **M6 E2E**: `e2e/m6-poll-click-tracking.test.ts` — publish poll → click "Open Poll" → verify click tracked and analytics shows action. Run with ports 3000/3001 free.
- **API health**: `GET /api/health` returns `{"ok":true}` when API is deployed.
- **Feedback footer (Playwright MCP, 2026-02-02)**: Slim footer strip on every page — single row: prompt "Tell us how to improve Cortex for you!", half-width textarea (4 lines), "Send feedback" button; distinct top border and background; dark-mode overrides so prompt + textarea + button visible. Verified: (1) footer (contentinfo) with all three elements on `/` and `/feedback` in light and dark mode; (2) textarea accepts input, button enables when text present; (3) submit calls `POST /api/feedback`; (4) on API 500, UI shows "Failed to send. Please try again." and keeps textarea content. Success path not verified in run because backend returned 500.
- **Admin / User view toggle (Playwright MCP, 2026-02-03)**: Admins and superadmins can switch between Admin Dashboard (`/admin`) and User View (`/`) without auto-redirect. Admin dashboard has "Browse Studies" button (navigates to `/`); when on user view, header shows "Admin" link (navigates to `/admin`). Verified with user-playwright MCP: Admin login → /admin → "Browse Studies" → / (study cards) → "Admin" → /admin.
- **Feedback footer above neural background (Playwright MCP, 2026-02-03)**: `.feedback-footer` has `position: relative` and `z-index: 10` so it renders above the full-screen fixed neural canvas (z-index 0) on the user dashboard. Verified: landing and user dashboard (dark mode, User login) show full footer (prompt, textarea, Send feedback); textarea focusable and button enables when text entered.
- **Production hardening / safe errors (Playwright MCP, 2026-03-03)**: Against production (https://adapta-labs-p62q.vercel.app): (1) `GET /api/health` returns `{"ok":true}`; (2) `GET /api/opportunities` returns 200 and JSON array (load-test targets for k6 script). Feedback form: landing shows textbox + Send feedback (button enables when text present); "Send feedback" click can be intercepted by canvas. `POST /api/feedback` with invalid category returns 500 with user-facing `error`; once deploy uses `createSafeErrorResponse`, production 500s will omit internal `details`. Access Cortex triggers Google OAuth as expected.
- **Track C – Bookings CSV export (Playwright MCP, 2026-03-03)**: (1) **API**: `GET /api/admin/export/bookings` (admin-only) returns CSV with columns Opportunity, Type, Session start/end, Participant name/email, Status, Booked at. Unauthenticated request returns 401. Backend (Express) and Vercel API both implement the route; Express dashboard also returns `sessions_completed` for admin UI. (2) **UI**: Admin dashboard “Recent bookings” card has “Export CSV” button; click triggers download via redirect. (3) **Browser test**: Cursor IDE browser MCP used; Admin page sometimes failed to load (“Failed to fetch dynamically imported module: Admin.tsx” — Vite dev). Direct navigation to export URL returned 401 without cookie. Admin.tsx syntax fix (extra `)` in ternary) resolved "Failed to fetch dynamically imported module". E2E: `e2e/admin-bookings-export.test.ts` — two tests (export API 200+CSV; Export CSV button visible). Run: `PLAYWRIGHT_NO_WEBSERVER=1 npx playwright test e2e/admin-bookings-export.test.ts --project=chromium`. Both pass.

---

## Key docs to reference

| Doc | Purpose |
|-----|---------|
| `README.md` | Setup, Docker, local dev |
| `TESTING_GUIDE.md` | How to run tests, E2E/smoke/accessibility |
| `KNOWN_ISSUES.md` | Known limitations, workarounds |
| `USER_GUIDE.md` / `ADMIN_GUIDE.md` | User and admin docs |
| `DATABASE_SETUP.md` | DB setup |
| `plan.md` | Product scope, data model, booking rules |
| `archive/deployment-and-status/` | Vercel env vars, deployment status, alpha readiness |
| `archive/test-results/` | E2E checklists, test run results |
| `archive/summaries-and-fixes/` | Runbooks (e.g. SET_SUPERADMIN), M6 README, continuation prompts |

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
- **Email reminders**: Automated via Vercel Cron. Daily at 9:00 AM UTC, `GET /api/cron/send-reminders` runs (secured by `CRON_SECRET`). Sends reminder emails for bookings whose session starts in ~24 hours; records `reminder_sent_at` on bookings. Requires migrations run (adds `reminder_sent_at` column). Set `CRON_SECRET` in Vercel env.
- **Demo login visibility**: Demo Access pills (User / Admin / Superadmin) on the landing page are **hidden** in production builds unless `VITE_SHOW_DEMO_LOGIN=true` is set. They are shown in development (`import.meta.env.DEV`). To show them in production (e.g. staging), add `VITE_SHOW_DEMO_LOGIN=true` in Vercel env vars and redeploy. The API routes (`/api/auth/demo-login`, etc.) remain; only the UI is conditional.
- **Reset DB to two users and blank studies**: `POST /api/admin/reset-keep-two-users` (superadmin only) deletes all bookings, sessions, and opportunities, then deletes all users except those named "Nick Fine" or "Greta Baisch". Or run locally: `DATABASE_URL="..." node scripts/reset-keep-two-users.js`.
- **Performance (lag)**: Neural backgrounds were tuned down: lower node counts (SlowNeural 350→180, Organic 500→250), `dpr` capped at 1.25, lighter Bloom. When `prefers-reduced-motion: reduce`, Three.js Canvas is skipped (static gradient only). SpotlightCard mousemove is throttled via requestAnimationFrame.
- **Light-mode contrast (WCAG AA)**: Admin/opportunity form descriptive text, placeholders, and selected values must meet 4.5:1 on white. The "TEXT READABILITY - Admin Panel" block in `_components.css` is scoped to `body.theme-dark` only; light mode uses `--text-muted` (#6B7280) from `_themes.css`. Additional light-mode overrides: leaderboard zero score, calendar hint text, ghost danger button, unmoderated/question badges use #6B7280 (Gray-500) in light theme.

---

## What we learned

- **Light-mode contrast**: Avoid #94A3B8 / #9CA3AF (Slate-400 / Gray-400) for body text, descriptions, placeholders, or selected values on white backgrounds—they fall below WCAG AA. Use #6B7280 (Gray-500) or darker for muted text in light theme; reserve lighter grays for dark theme only.
- **M6 E2E**: Playwright starts backend (3001) and frontend (3000) by default. If either port is in use, use `PLAYWRIGHT_NO_WEBSERVER=1` and run backend + frontend yourself, then run the test.
- **New study not appearing in admin list after creation (2026-03-18)**: Two bugs combined to cause this. (1) `OpportunityForm.tsx` — for `poll/survey/question/unmoderated` types, `handleSubmit` returned early after creating the study (to show a success message) but never called `navigate`. The navigation code lower in the function is dead code for CREATE mode — it is only reachable in EDIT mode. The user was left on the form page needing to manually click "Return to Dashboard". If they navigated away via the browser back button or the header link instead, the Admin page would remount without `{ state: { refresh: true } }`, and in some timing scenarios the forced-reload would not fire. **Fix**: added a `setTimeout(() => navigate('/admin', { state: { refresh: true } }), 1500)` immediately after `setSuccessMessage`, so the admin is auto-redirected after seeing the confirmation. (2) `api/opportunities.ts` GET handler — the non-admin published-only filter had a logic bug: `if (!isAdmin && (!status || status !== 'draft'))`. If a non-admin passed `?status=draft`, the condition evaluated to `false` and drafts were returned; if they passed `?status=closed`, two contradictory `AND o.status = ...` clauses were added, returning zero results. **Fix**: simplified to `if (!isAdmin) { sql += " AND o.status = 'published'" }` — non-admins always get the published filter, unconditionally.

---

## Links

- Production: https://adapta-labs-p62q.vercel.app  
- Vercel project: (see `archive/deployment-and-status/VERCEL_ENV_VARS_NEEDED.md` for dashboard link)

---

## Continuation (for new sessions)

When continuing work on this project, use the following in new chats.

**MCPs available**

| MCP | Use |
|-----|-----|
| **cursor-ide-browser** | Navigate and interact with the app for frontend dev and manual testing |
| **cursor-browser-extension** | Similar browser automation; prefer for frontend/webapp work |
| **user-chrome-devtools** | Inspect browser console, network, and DOM |
| **user-playwright** | Playwright-based E2E tests |
| **user-vercel** | Vercel deployment and config |
| **user-figma** | Figma design integration |
| **user-clerk** | Clerk auth (if used) |
| **user-convex** | Convex backend (if used) |
| **user-supabase** | Supabase backend (if used) |
| **user-atlassian** | Atlassian (Jira, etc.) |
| **user-forge-knowledge** | Forge Knowledge base queries |

**Learnings**

- Use `learnings.md` (this file) in the project root as a reference for prior discoveries, gotchas, and conventions.
- When you find something reusable (fixes, patterns, pitfalls), add it to `learnings.md` with a short, actionable note.

**Suggested follow-ups**

- **M6 End-to-End Click Tracking Test** – Publish poll → click "Open Poll" → verify click is tracked.
- **Analytics Dashboard Verification** – Confirm analytics for published polls.
- **Production readiness (M6)** – Error handling, env vars, README for M6.

**Short continuation prompt (copy for future sessions)**

```
When continuing work on this project:
MCPs available: cursor-ide-browser, cursor-browser-extension, user-chrome-devtools, user-playwright, user-vercel, user-figma, user-clerk, user-convex, user-supabase, user-atlassian, user-forge-knowledge
Learnings: Use learnings.md in the project root as a reference for prior discoveries, gotchas, and conventions. When you find something reusable (fixes, patterns, pitfalls), add it to learnings.md with a short, actionable note.
Suggested follow-ups: M6 End-to-End Click Tracking Test (publish poll → click "Open Poll" → verify click tracked); Analytics Dashboard Verification (confirm analytics for published polls); Production readiness for M6 (error handling, env vars, README for M6).
```
