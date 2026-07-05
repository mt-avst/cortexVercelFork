# Learnings

Project context and decisions for AdaptaLabs. Reference this in new chats to get up to speed.

---

## Project overview

- **Name**: AdaptaLabs (adaptalabs-root), **version**: 7.3.23
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

- **FirstHand integration enablement on Kubera playground (2026-07-05)**: Playground URLs follow `https://{app_name}.kubera-playground.adaptavist.net` (production would be `{app_name}.platform.adaptavist.net`) — pattern documented in `to-be-continuous/kubera` templates on gitlab.adaptavist.net. The frontend's `okta_alb` auth intercepts **all** unauthenticated requests including server-to-server webhooks (verified: `POST /api/firsthand/callbacks` through the frontend 302s to Okta), so the backend got its own public ingress in `.kubera/playground-backend.yaml` — safe because backend enforces its own auth (cookie sessions; demo routes only compiled in under `NODE_ENV=development`; callbacks HMAC-verified). App-level Kubera secrets (`secret.enabled: true`) are provisioned platform-side, not from the repo — the shared `FIRSTHAND_INTEGRATION_SECRET` value lives on the FirstHand Vercel project (retrieve with `vercel env pull` from `~/code/FirstHand`; local copy at `~/.firsthand-integration-secret`). GitLab MRs can be created without API access via git push options (`-o merge_request.create`).

- **Google Fonts variable font weight inconsistency (localhost vs prod, 2026-04-05)**: When using a variable font like Fraunces via Google Fonts, loading only discrete weights (e.g. `wght@400;700`) and then setting `font-weight: 900` in CSS causes the browser to synthesise the weight — which looks different depending on whether the font is cached (prod) or being fetched fresh (localhost). Two fixes required: (1) load the full weight axis range in the Google Fonts URL (`wght@300..900`); (2) always set an **explicit `font-weight`** in the scoped CSS rule rather than relying on cascade from a base rule — this guarantees identical rendering everywhere regardless of font cache state. If a Google Fonts external request doesn't appear at all in network logs on localhost, the font may be blocked by network conditions; fallback rendering will then differ from prod. Pin `font-weight` explicitly to eliminate the variable.
- **`vercel deploy --prod --yes` from repo root deploys the current working tree directly** — does not require a git push. This means changes can be live on production before they're committed, so always commit first to keep git and prod in sync.



- **Light-mode contrast**: Avoid #94A3B8 / #9CA3AF (Slate-400 / Gray-400) for body text, descriptions, placeholders, or selected values on white backgrounds—they fall below WCAG AA. Use #6B7280 (Gray-500) or darker for muted text in light theme; reserve lighter grays for dark theme only.
- **Avoid hardcoded colors**: Always use Bootstrap utility classes (`text-warning`, `text-danger`, etc.) or CSS variables instead of hardcoded hex colors. Hardcoded colors break theme consistency, don't respond to accessibility settings, and create maintenance burden. Example: Use `className="text-warning"` instead of `style={{ color: '#d97706' }}`.
- **UX fixes require comprehensive code review**: When fixing UX issues, check all code paths. In draft warning fix, initial implementation missed test/interview types because they use a different navigation flow (AdminSessionManager). Always trace through all possible user flows and consider how different opportunity types might behave differently.
- **M6 E2E**: Playwright starts backend (3001) and frontend (3000) by default. If either port is in use, use `PLAYWRIGHT_NO_WEBSERVER=1` and run backend + frontend yourself, then run the test.
- **Study period date picker wrong / “can’t pick future dates” (2026-03-18)**: `BasicInfoTab` used `new Date(yyyy-mm-dd + 'T00:00:00')` (local midnight) then `toISOString()`, and displayed with `toISOString().split('T')[0]`. In timezones ahead of UTC, local midnight becomes the **previous calendar day** in UTC, so the field showed the wrong day and felt broken for future dates. **Fix**: calendar-only semantics — store with `Date.UTC(y, m-1, d, 12, 0, 0)` and format with `getUTCFullYear` / `getUTCMonth` / `getUTCDate` (`BasicInfoTab.tsx`).
- **Production `429` on `/api/auth/admin-login` (and other auth routes)**: `authRateLimit` used **one PostgreSQL-backed bucket per IP** for **every** `/api/auth/*` handler (`admin-login`, `demo-login`, `google-login`, `google-callback`, `superadmin-login`, …) with only **10 requests / 15 min**. OAuth + retries + dev testing exhausted it quickly. **Fix**: default raised to **35** (clamped 5–200), optional env **`AUTH_RATE_LIMIT_MAX`**; `Retry-After` header on 429 responses (`api/utils/rateLimit.ts`).
- **Booking calendar: 30m slots looked as tall as 1h / misaligned (2026-03-20–21)**: (1) Inline `max(%, 40px)` removed; (2) `.calendar-hud .calendar-slot { min-height: 44px }` overridden for `.calendar-timeline-container .calendar-slot`. (3) **Main accuracy bug**: `CalendarGrid` positioned slots with **`getUTCHours()`** while the axis, “NOW” line, and labels used **local** time (`getHours()`). Slots and grid lines disagreed; duration could look like a full hour. **Fix**: `getHourFromSlot` + `formatTime` / `formatTimeRange` use **local** wall time; `groupSessionsByDate` uses **local** midnight/day iteration; NOW line uses `top: ${pct}%` (removed invalid `calc(% * 900)`). **(2026-03-18 follow-up)** If the issue “still looks wrong” after the above: slots were positioned with **fixed px** from a 900px scale while grid lines used **%** of the timeline — any mismatch inflates or misaligns blocks. **Fix**: slot `top`/`height` also use **%** of `.calendar-timeline-container` (same as grid); class `calendar-slot-booking-timeline` + higher-specificity CSS `min-height: 0 !important`; **half-hour dashed grid lines** so 30m slots aren’t read as “full hour” between two solid hour lines only; booking popover weekday uses **local** date (removed `timeZone: 'UTC'`).
- **New study not appearing in admin list after creation (2026-03-18, fixed & deployed)**: Two bugs combined to cause this. (1) `OpportunityForm.tsx` — for `poll/survey/question/unmoderated` types, `handleSubmit` returned early after creating the study (to show a success message) but never called `navigate`. **Fix**: added `setTimeout(() => navigate('/admin', { state: { refresh: true } }), 1500)` after `setSuccessMessage`, so the admin is auto-redirected after seeing the confirmation. (2) API GET handler — the non-admin published-only filter had a logic bug allowing non-admins to see drafts if they passed `?status=draft`. **Fix**: simplified to unconditionally add `AND o.status = 'published'` for non-admins. Applied to both `api/opportunities.ts` (Vercel) and `backend/src/routes/opportunities.ts` (Express). E2E test updated to verify auto-navigate behavior.
- **New studies not visible to users - UX fix (2026-03-19, v7.3.13)**: Studies created with status='draft' are not visible to non-admin users (API filters by status), but admins were missing the status dropdown or not understanding its importance, leading to confusion when newly created studies didn't appear in the user-facing list. **Root cause**: UX problem - status field not prominent enough, no warnings when saving as draft. **Initial fix (commit a46c3aa)**: (1) Status dropdown help text dynamically shows orange "⚠️ DRAFT - Not visible to users" warning when draft is selected (`BasicInfoTab.tsx`); (2) Success messages after save show yellow warning banner with AlertTriangle icon when saving as draft: "⚠️ Study created as DRAFT - Not visible to users yet. Change status to Published to make it visible." (`OpportunityForm.tsx`); (3) Alert styling changes from green `alert-success` to yellow `alert-warning` for draft saves; (4) Longer display time (3s vs 1.5s) for draft warnings. **Code review fixes (commit 402360a)**: (1) **CRITICAL**: Added draft warnings for test/interview types - these use AdminSessionManager for session creation which bypassed the success message flow; fixed by passing `isDraft` prop to AdminSessionManager and including warning message in navigation state, Admin.tsx now displays warnings from `location.state.message`; (2) Made warning messages consistent across all flows - removed confusing "successfully!" from draft warnings, all now use format "⚠️ Study [action] as DRAFT - Not visible to users yet..."; (3) Replaced hardcoded color `#d97706` with Bootstrap `text-warning` class for theme consistency and accessibility; (4) Made edit mode timeout conditional (3s for draft, 1.5s for published) to match create mode. **Result**: All opportunity types (poll/survey/question/unmoderated/test/interview) now show clear, consistent draft warnings in create and edit modes with proper styling and timing. **Implementation notes**: Success message detection uses string matching `successMessage.includes('DRAFT')` to determine alert styling; Admin.tsx timeout is longer (5s draft, 3s published) to account for page navigation. Files modified: `OpportunityForm.tsx`, `BasicInfoTab.tsx`, `AdminSessionManager.tsx`, `Admin.tsx`.

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
