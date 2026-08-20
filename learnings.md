# Learnings

Project context and decisions for AdaptaLabs. Reference this in new chats to get up to speed.

---

## Project overview

- **Name**: AdaptaLabs (adaptalabs-root), product name **Cortex**
- **Released version is the git tag, not `package.json`.** semantic-release cuts the tag on merge to `main` and does not write the version back, so `package.json` (7.4.0) lags the released version badly. Check `git tag --sort=-creatordate | head -1`, currently **7.36.0**.
- **Purpose**: Internal recruitment app — researchers post opportunities (studies/sessions), employees browse and book sessions. Includes polls/surveys, dashboard, feedback, notifications.
- **Production**: Kubera playground — https://adaptalabs.kubera-playground.adaptavist.net (the old Vercel deployment at adapta-labs-p62q.vercel.app is retired)  
- **Status**: Ready for alpha. Core flows (book, cancel, create/edit/duplicate opportunity, dashboard, settings, poll tracking) working; E2E results in `archive/test-results/`.

---

## Tech stack

| Layer | Tech |
|-------|------|
| **Frontend** | React 18, TypeScript, Vite, React Router, Tailwind, Radix UI, Framer Motion, Three.js (react-three-fiber) for background effects |
| **API (production and local)** | Express in `backend/` — the single API implementation, deployed as a container on Kubera. The old Vercel serverless `api/` tree was deleted 2026-07-05 (dual maintenance of every route on a retired deploy target). |
| **Database** | PostgreSQL. Connection resolved by `backend/src/config/databaseUrl.ts` across every convention we've run under - `DATABASE_URL`/`POSTGRES_URL`/`POSTGRESQL_URL` win if set, otherwise `DB_URL` or Kubera's individual `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` vars, generic `POSTGRES_*`/`PG*` vars as a last resort. **Gotcha (2026-07-13):** the code originally only checked `DATABASE_URL`/`POSTGRES_URL`/`POSTGRESQL_URL` - none of which Kubera actually injects (confirmed against the platform's own `kubera-config` docs: Kubera sets `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_URL`). The backend had silently fallen through to a hardcoded `localhost` dev URL on every Kubera deploy, which is why the migrate/seed init container hung with zero output - `pool.connect()` was targeting a database that doesn't exist in the container, with no connection timeout set (also fixed, MR !17: 10s timeout + explicit logging). On Kubera the RDS instance is provisioned from `.kubera/playground-backend.yaml`. |
| **Auth** | Cookie-based sessions (signed with `SESSION_SECRET`). Production login is **app-level Okta OIDC** (Kubera `auth.okta_app` provisions the Okta app + injects `clientID`/`clientSecret`; backend's `/auth/login`+`/auth/callback` run the flow). Google OAuth + demo login remain as fallbacks. Roles: `employee`, `researcher_admin`, `superadmin`; first login for `BOOTSTRAP_SUPERADMIN_EMAILS` is elevated to superadmin. |
| **Deployment** | Kubera via GitLab CI (`.gitlab-ci.yml` → docker build → ArgoCD GitOps). Manifests in `.kubera/`. |

---

## Repo structure (key dirs)

```
/backend      → Express server for local dev
/frontend     → React app (Vite build → frontend/dist)
/shared       → Shared TypeScript types/utils
/e2e          → Playwright tests (production-smoke.test.ts, etc.)
/scripts      → set-superadmin, migrate-tokens, etc.
```

---

## Key flows

- **User**: Browse opportunities → Sign in (Google or demo) → Book session → My Bookings; cancel/reschedule.
- **Admin**: Create/Edit/Duplicate opportunities; manage sessions (calendar grid); dashboard analytics; settings (notifications); poll/survey click tracking.
- **Auth routes**: `/auth/demo-login`, `/auth/admin-login`, `/auth/google-login`, `/auth/google-callback`, `/auth/logout` (Express mounts them under both `/auth` and `/api/auth`).

---

## Deployment (Kubera)

1. **Trigger**: merge to `main` — GitLab CI builds both docker images and a downstream pipeline pushes ArgoCD specs to the GitOps repo; the cluster reconciles asynchronously (CI green ≠ reconciled, check the app URL).
2. **Manifests**: `.kubera/playground-backend.yaml` and `.kubera/playground-frontend.yaml`. Non-secret env in `config.data`; secrets in the platform-side Kubera secret store.
3. **Migrations and seed**: run automatically in the backend initContainer (`npm run migrate && npm run seed`).
4. **URLs**: frontend `https://adaptalabs.kubera-playground.adaptavist.net` (public; app-level Okta OIDC enforced by the backend, not the ALB). Backend is **private** (cluster-internal only) - reached via the frontend nginx proxy; FirstHand webhooks hit the frontend host and are proxied in.

---

## Testing

- **Smoke**: `npm run test:smoke` (Playwright against production; config: `playwright.prod.config.ts`). Expect some tests skipped when no demo data (e.g. opportunity detail, demo login).
- **Browsers**: E2E runs on Chromium, Firefox, WebKit, Mobile Chrome, Mobile Safari, and Microsoft Edge. To run Edge tests, install Microsoft Edge or run `npx playwright install msedge`.
- **Accessibility**: Axe tests in `e2e/accessibility.test.ts` cover Home, Opportunity detail, Admin, Create opportunity, My Bookings, Feedback, Settings. Run with dev server up: `npx playwright test e2e/accessibility.test.ts --config=playwright.accessibility.config.ts`.
- **E2E checklist**: `archive/test-results/END_TO_END_TESTING_CHECKLIST.md` — full flow list; results in `archive/test-results/`.
- **M6 E2E**: `e2e/m6-poll-click-tracking.test.ts` — publish poll → click "Open Poll" → verify click tracked and analytics shows action. Run with ports 3000/3001 free.
- **API health**: `GET /api/health` returns `{"status":"ok","database":"up","databaseLatencyMs":N,"timestamp":...}`. Reach it on the **app origin** (`https://adaptalabs.kubera-playground.adaptavist.net/api/health`); the backend host is cluster-internal and refuses connections from outside. Note it is **not** a deploy check - Kubernetes keeps the old pod serving during a failed roll, so health stays green while the new pod crashloops.
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
| `plan.md` | Product scope, data model, booking rules |
| `archive/deployment-and-status/` | Vercel env vars, deployment status, alpha readiness |
| `archive/test-results/` | E2E checklists, test run results |
| `archive/summaries-and-fixes/` | Runbooks (e.g. SET_SUPERADMIN), M6 README, continuation prompts |

---

## Decisions

- **Root dependencies**: `pg` and `nodemailer` stay in the root `package.json` for the ops scripts in `scripts/` (e.g. `reset-keep-two-users.js`); the app itself resolves its own deps from `backend/` and `frontend/`.
- **Superadmin bypass**: For delete session and duplicate opportunity, `superadmin` can act on any owner’s resources; other admins are restricted to resources they own.
- **Session delete 403**: DELETE `/api/sessions/:id` requires admin and (unless superadmin) ownership of the opportunity. Clear 403 messages (`ADMIN_REQUIRED` / `OWNER_ONLY`) and UI shows API error message on failure.
- **Duplicate opportunity**: Implemented as `POST /api/opportunities/:id/duplicate` (new draft with “(copy)” in title). Auth/ownership same as edit (owner or superadmin).

---

## Gotchas / workarounds

- **SlowNeuralBackground intercepts clicks**: Three.js canvas was capturing pointer events on admin Create/Edit. Fix: `.slow-neural-background` and `.slow-neural-background canvas { pointer-events: none !important; }` in `frontend/src/styles/_components.css`.
- **Booking confirm button intercepted**: Confirm button in calendar booking popover was behind sticky header (`.calendar-day-sessions`). Fix: when confirming a slot, the calendar grid container gets higher z-index (e.g. 101) in `frontend/src/components/CalendarGrid.tsx` so the popover stacks above the header.
- **Migrations**: Must run `GET /api/run-migrations` after first deploy (or when schema changes); not automatic.
- **Email reminders**: In-process daily cron (node-cron, 09:00 UTC) inside the Express backend calls `sendDueReminders()` (`backend/src/services/reminders.ts`) — sessions starting in ~24h, one reminder per booking via `bookings.reminder_sent_at`. Manual trigger: `GET /api/cron/send-reminders` with `Authorization: Bearer <CRON_SECRET>`. Disable the scheduler with `REMINDER_CRON_DISABLED=true`.
- **Demo login visibility**: Demo Access pills (User / Admin / Superadmin) on the landing page are **hidden** in production builds unless `VITE_SHOW_DEMO_LOGIN=true` is set. They are shown in development (`import.meta.env.DEV`). To show them in production (e.g. staging), add `VITE_SHOW_DEMO_LOGIN=true` to the frontend build env and redeploy. The API routes (`/api/auth/demo-login`, etc.) remain; only the UI is conditional.
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

## Unmoderated studies and the deploy pipeline (2026-08-13)

- **A `refactor:`, `docs:` or `chore:` merge to main NEVER DEPLOYS, and the pipeline stays fully green**: Cortex ships by release tag - semantic-release cuts a version, that becomes the image tag, ArgoCD rolls it. semantic-release releases `feat`, `fix`, `perf`, `revert` and breaking changes only. A user-visible rename squashed as `refactor:` (MR !94) sat merged and undeployed for an hour, indistinguishable from a platform stall, with `trigger-deployment-prod` reporting success. **Verify with `git tag --points-at <merge-sha>`, never the pipeline** - an empty result means it will never ship. There is no repair commit needed: the image is built from main's whole tree, so a stranded change ships with the next `feat:`/`fix:` merge. Now detected automatically by the `check-release-will-deploy` job (MR !98) - it fails main when there is no release AND deployable paths changed, and passes docs-only merges
- **`firsthand.study_steps.id` is a GLOBAL `TEXT PRIMARY KEY`, not scoped per study**: `insertStudySteps` writes the client-supplied `step_id` straight into it, so positional ids like `step_001` are claimed deployment-wide by the first study that uses them and the second study to try fails on a unique violation - surfacing as a misleading 409 or a raw Postgres 400. Both authoring paths now namespace ids with the study id (MRs !91, !93). The proper fix is still a composite `PRIMARY KEY (study_id, id)`
- **A copy rename can silently disarm a test, and the suite stays green**: renaming a label widened a `findByLabelText(/Recorded study/i)` so it also matched a checkbox whose label contained the new phrase. `findBy*` returns the first match, so the test selected nothing and its assertion became trivially true - it passed against a build with the guarded bug reintroduced. **Query by role, not label text, when two controls can share a phrase, and re-verify by mutation after any copy change.** Also: `<option>`s load asynchronously, so setting a `<select>` to a value it does not yet carry is a silent no-op
- **`crypto.randomUUID` and `navigator.clipboard` are both secure-context only**: absent over plain http, so they throw or are undefined on a dev server reached by IP. `crypto.getRandomValues` is available in insecure contexts and is the correct fallback for a v4 uuid - never `Math.random()` for a value that becomes a primary key
- **Verifying a deploy: sample the served asset, but not mid-swap**: during a roll the served HTML briefly yields no `index-*.js` match, so every marker grep returns 0 and reads as "deployed but broken". Skip empty samples and wait ~20s after detecting a change. Also, back-to-back merges each cut their own release, so a bundle that rolled two minutes before your second merge does not contain it
- **Source-reading is not enough for UI documentation**: every label can be read correctly from source and the doc can still be wrong, because source tells you what strings exist rather than which one a person sees as a field label. The Basic Information field is "Research Study Type", not "Type" - only walking the real form caught it (MRs !99, !100)
- **Never edit a migration file that has already been applied**: `scripts/firsthand-migrate.mjs` hashes each file and stores the checksum in `firsthand.schema_migrations`, then throws `Migration X was already applied with a different checksum` on any mismatch. That runner is the deploy initContainer, so adding even a comment to `0004_firsthand_studies.sql` fails the deploy and CrashLoops the pod. To document or change an existing table, add a new migration (`COMMENT ON COLUMN`, `ALTER TABLE`) - never touch an applied file
- **Anything under `backend/`, `frontend/`, `shared/` or `.kubera/` counts as deployable**, including `backend/db/**` and a README placed there (`DEPLOY_PATHS` in `ci/check-release-will-deploy.sh`). A comments-only change in those trees still has to be squashed as a releasing type, or the `check-release-will-deploy` job fails main. Weigh that before starting a "quick comment": it costs a version bump and a real ArgoCD roll
- **Only the shared surface stops a recording, not the task window**: recording ends when the shared display track fires `ended` (`session-recorder.ts`); nothing watches the task window. So "closing it stops the recording" was false for anyone who shared their whole screen - which the launch step actively offers as the fallback - and told them their recording had ended while it was still running (MR !103). `displaySurface` is not a dependable way to condition that copy either: Firefox does not report it at all and is a supported browser, and `surfaceSwitching: "include"` lets the surface change after the single read
- **A prefix assertion lets the bug it guards come back**: the e2e for that warning asserted only "Keep the task window open until you finish", which the corrected copy still satisfies, so a straight revert to the false wording would have stayed green. Assert the part that actually distinguishes right from wrong, and anchor on `getByRole` plus the accessible name rather than raw text
- **Do not trust a zero from your own verification script**: a served-asset check reported every marker missing because the chunk filename had been mangled while extracting it, so curl fetched the SPA fallback instead of the bundle - indistinguishable from a failed deploy. Assert a sanity marker that must be present in a genuine fetch before believing an absence. Likewise, GitLab API timestamps are UTC while `git log` and the shell are local time; compare against the server's own `Date:` header rather than mixing the two


## The floating task pane (2026-08-14)

Shipped as 7.33.0 (MR !106) and hardened as 7.33.1 (MR !107). The current task now floats above the page under test in a Document Picture-in-Picture window, so a participant is not memorising the task across two windows.

- **`documentPictureInPicture.requestWindow()` is the method - `open()` does not exist and never has.** An embedded browser can also expose the object with the method stripped by permissions policy, so feature detection must test `typeof api?.requestWindow === "function"` rather than object truthiness, or you render a control that can never work. A wrong method name looks exactly like "the platform refuses" - dump the prototype (`Object.getOwnPropertyNames(Object.getPrototypeOf(api))`) before blaming the environment
- **Transient user activation SURVIVES the capture prompts.** A bare programmatic call is refused (`NotAllowedError: Document PiP requires user activation`), but the activation from the *Start recording* click is still valid after `getUserMedia` and `getDisplayMedia` resolve, so the pane can open by itself the moment recording starts. This was assumed impossible and the assumption was wrong; testing it took ten minutes and changed the design from a button to no button at all
- **Never await a browser API between "capture is live" and the phase flip.** `await openTaskPip()` suspended the start handler after `startCapture()` resolved but before `setPhase("running")`, so React painted the setup card with an **enabled Start button over a running recording**. `startCapture` has no re-entrancy guard: a second press resets `chunksRef` while the first `MediaRecorder` still holds it, interleaving two recorders into one blob. Call it with `void` - `requestWindow` is invoked synchronously either way, so the activation is unaffected
- **Everything after `requestWindow` must be inside the try.** The caller runs while capture is live, so a throw while styling the pane - an absent `body`, a stylesheet that misbehaves - propagates and strands a participant on the setup screen indefinitely while being recorded. `openTaskPip` resolves `true`/`false` and never rejects
- **A second window needs its own recording indicator.** The recording callout, the capture-stopped modal and the error banner all render in the Cortex tab, which is the exact tab the pane exists to stop the participant looking at. Without recording state inside the pane, someone whose share was stopped from Chrome's own bar can answer their way through an entire study that captured nothing. `getInterruptedRunRecovery` does not catch this: it unwinds only on `not_started`, and an external stop leaves phase `running` with status `stopped`
- **A chrome-less always-on-top window is a phishing surface.** The pane has no browser chrome, no nav and no study context, and the researcher-authored prompt was its only heading, in a window the OS attributes to Cortex. A one-step study rendered nothing but that sentence, a text input and a button - a credible frame for "re-enter your SSO password", whose answer lands in study responses and, under a whole-screen share, in the recording. The pane now carries a non-authorable header (wordmark, study title, live recording state) above any authored text
- **Close the pane on unmount, not only on completion.** The hook is owned by `ParticipantSessionFlow`, but an interrupted run unwinds by unmounting `StudyRunner` - so nothing closed the window, leaving an empty always-on-top pane over the recovery message the participant is meant to read
- **React 18 portals do work across documents.** `preparePortalMount` calls `listenToAllSupportedEvents` on the portal container, so delegated events fire correctly inside the PiP document. This was the biggest theoretical risk in the design and it is sound. RTL role queries against that document need a `defaultView`, so build test doubles from an iframe's `contentDocument`, not `createHTMLDocument`
- **React 18 batching makes "did this run before the state flip?" assertions vacuous.** A test that the runner had not yet mounted when the pane opened passed identically against the correct code and against the mutation that broke it, because `setPhase` had not flushed either way. Assert the behaviour that matters instead - here, that a never-resolving `openTaskPip` still lets the session proceed
- **A one-shot mock rejection lands on the wrong call.** A test for "the pane survives a failed completion" used `mockRejectedValueOnce`, which was consumed by the `step_exited` event preceding completion, so completion was never reached and the test proved nothing. Reject conditionally on the event you actually mean

## Database TLS, and three ways a test can lie (2026-08-15)

Every database connection in the repo that carries credentials now goes through
one TLS decision - `backend/src/config/dbTls.ts` for the backend,
`scripts/lib/pg-ssl.js` for the operator scripts. What made it hard was not the
crypto; it was that four separate assertions about it were false.

- **pg merges a parsed connection string OVER the explicit `ssl` option.**
  `connection-parameters.js` does `config = Object.assign({}, config,
  parse(config.connectionString))`, so `new Pool({connectionString, ssl})` lets
  the STRING win. Measured on pg 8.18.0: `?ssl=0` gives a plaintext connection
  and `?sslmode=verify-full` silently discards the CA you supplied. The first
  version of this fix carried a comment asserting the opposite. **If you pass
  both, strip the TLS parameters from the string, or the option is decoration.**
- **`URLSearchParams.get` returns the FIRST value; pg-connection-string keeps
  the LAST.** So `?sslmode=verify-full&sslmode=no-verify` shows an approving
  gate one value and hands the driver another. This bit the same fix twice -
  first on `sslmode`, then on `host`, where it is worse: `host` cannot be
  stripped because pg needs it, and a duplicate sends the credentials to a
  server the gate never judged, with no interception position required.
- **`?host=` beats the URL authority.** A `postgres://…@localhost/…?host=<remote>`
  string dials the remote one. Any gate reading `url.hostname` judges a
  different server from the one that gets connected to.
- **An empty CA file is falsy, so Node falls back to its DEFAULT PUBLIC ROOT
  STORE.** That is the shape a truncated `curl` leaves behind, and it is the one
  failure that degrades silently - garbage content fails closed on its own.
- **The RDS roots are private and self-signed** (verified: `Amazon RDS
  eu-west-1 Root CA RSA2048/RSA4096/ECC384`, expiring 2061/2121/2121, none of
  them in Node's store - the four "RDS" hits there are base64 coincidences). So
  `rejectUnauthorized: true` alone cannot work against RDS; a CA must be
  supplied. The bundle is committed at `backend/certs/` and ships in the image,
  which is what makes `DB_TLS_VERIFY=1` a one-variable change instead of
  cluster work.

**Verification is opt-in, behind `DB_TLS_VERIFY=1`, and that is deliberate.** A
certificate that fails to verify fails at connect time, and the same code runs
in the deploy initContainer, so a wrong guess CrashLoops the pod rather than
degrading quietly - and it cannot be tested from outside the cluster. The
residual risk is not the CA but **hostname verification**: `rejectUnauthorized`
also checks the certificate SAN against the host in `DB_URL`, so a CNAME,
private alias, RDS Proxy name or bare IP fails the handshake even with a correct
CA. `docs/PRODUCTION_HARDENING.md` has the enable-and-confirm procedure.

**A single-label hostname is treated as local** - no dot means no public DNS -
because docker-compose reaches postgres at `postgres` and `postgres-dev`, which
are plaintext containers. Forcing TLS on them breaks local development outright.
The exemption stops once verification is requested, because a name resolved
through a DNS search suffix IS remote; `DB_TLS_LOCAL_HOSTS` is the named escape
hatch, and it is bounded to single-label names so it cannot exempt the real
endpoint.

### The testing lesson, which generalises past TLS

**Three separate times, a test passed because it asserted on an intermediate
value rather than the outcome.** Assert on what the system actually does:

- Asserting on the object handed to `new Pool()` passes against a build where
  the connection is cleartext. Assert on
  `new Client(config).connectionParameters.ssl` - the config that reaches
  `tls.connect`.
- A test that drove a real TLS connection over a URL carrying
  `?sslmode=verify-full` proved only that pg-connection-string works:
  **pg-connection-string is secure by default**, so the library supplied the
  verification and the test passed with our own `ssl` option deleted entirely.
- Matching an error message on the offending value cannot distinguish two code
  paths when both messages echo that value. Match the phrase that only one path
  produces.

**A surviving mutation means an assertion is vacuous more often than it means a
layer is redundant.** Three survivors were written off as belt-and-braces; two
were vacuous assertions. The tell: mutate the layer AND the layer that backs it
up - if the pair dies but each alone survives, it is genuine redundancy.

**Test the wiring, not just the helper.** Mutating four call sites back to
`rejectUnauthorized: false` left the whole backend suite green, because the
helper was tested and nothing pinned that anything used it. At the application
pool the difference was invisible under jest specifically because `NODE_ENV` is
`test` and the resolved database is local, so old and new agreed - **check
whether your test environment is hiding the case that matters.**

**A test can be the dangerous thing.** The wiring test drove
`reset-production-db.ts` using `docker-compose.yml`'s `DATABASE_URL` verbatim -
same host, credentials and database. Inside the compose network that resolves,
and the assertion under test fires *before* the connection is attempted, so it
would have passed whether or not the deletes ran. No behavioural assertion can
catch that class; the guard has to be on the test itself, and there is now one
checking that no connection string in that file shares a host with any compose
database.

## The participant launch rework (2026-08-16)

The floating pane became the participant's whole control surface, the Cortex page became a status board behind it, and typed answers were removed from authoring and runtime alike.
Shipped on `feat/participant-welcome-expectations`.

### Browser platform rules, each verified live after a wrong assumption

- **One click carries ONE transient activation, and both `window.open` and `documentPictureInPicture.requestWindow` consume it.**
  Opening the pane and the task-page popup from a single click is therefore impossible in either order: pane first and the popup is blocked, popup first and the pane is refused.
  Both orders were tested in real Chrome after each was assumed to work.
  The pane is now opened by its own control, so every window has its own click.
- **A click INSIDE the Document PiP pane does carry activation for the OPENER's `window.open` and `getDisplayMedia`.**
  A code review argued from first principles that it could not, because the pane is an auxiliary top-level traversable rather than a same-origin descendant.
  That was wrong, and a stale comment of ours saying the popup "may be refused" is what led the reviewer there.
  Treat a review finding as a hypothesis: this is the second one on this project refuted by a ten-minute experiment.
- **`window.open` with the NAME of a window that already exists returns that window and silently ignores the requested position and size.**
  A task window surviving from an earlier session was being re-adopted, so a window-placement fix appeared to do nothing at all and looked like a stale build.
  The name is now unique per page load, and the window closes on unmount and on `pagehide`, so a survivor can never be adopted.

### CSS and component boundaries

- **A page-level element selector reaches into every small component that renders that element.**
  `.fh-recording h1 { max-width: 12ch }` styles the page's display headings, and the floating pane's task prompt is an `h1`, so the single most important sentence in the product was rendering at about a third of a 380px panel.
  The component's own rule set the font size and never the width, so nothing looked wrong in the file.
  When a component renders a bare `h1`, `h2` or `p`, check what the page already says about that element.
- **Do not claim a surface is non-authorable while rendering authored content inside it.**
  The pane's trust strip is an anti-phishing control, and its own comment said nothing in it could be authored - while it rendered the researcher-authored study title.
  The strip now carries only the wordmark and recorder state; the title sits below it, below every recorder alert, and clamped, so no title length can push a warning out of view.
- **Reserve the danger colour for danger.**
  The recording indicator had two states doing the work of three, so "nothing has started yet" rendered in the same red as "your recording stopped mid-session".
  After minutes of red on the resting state the colour stops meaning anything.
  Three states now: idle muted, live accent plus dot, stopped danger.

### Testing

- **A surviving mutation is nearly always a vacuous assertion rather than redundant code.**
  Four survived in this work and every one was a bad test.
  The shapes are worth recognising: `getByText` matches hidden elements, so assert `toBeVisible` when visibility is the point; an assertion that queries copy the same change deleted passes whether or not the code still runs; gating logic is unguarded when the test harness always satisfies the gate; a prop is untested when no fixture ever varies it.
- **A mutation that fails to compile proves nothing and reads exactly like a kill.**
  Watch for "no tests" in the vitest output rather than a failure count.
- **A mutation script whose pattern does not match prints a clean pass, which reads exactly like a survivor.**
  Print the mutated lines or count the marker before believing either result.
- **When a feature is removed, its tests fail because their premise is gone, not because their subject is wrong.**
  Rewrite them to the guarantee that survives instead of deleting them: an auto-open suite became a launch-ordering suite, and "shared response state" became "shared task position" once there were no responses to share.
- **Removing an input means removing the validation that guarded it.**
  A required-answer gate left in place after the answer field was removed would have wedged a participant on the task, being recorded, with nothing on screen able to satisfy it.

### Verifying a local change

- **Use the dev server for the inner loop; `vite preview` is for checking the built output.**
  `npx vite --port <port> --strictPort` from `frontend/` gives hot reload and no build step at all.
  It proxies `/api` and `/auth` to `localhost:3001`, so it is same-origin and CORS never enters it.
  This did not work until 7.48.2: `src/shared/config/environment.ts` calls `frontendEnvSchema.parse(process.env)` and `api.ts` calls it at module scope, so the dev server threw `process is not defined` before the app rendered, which is why local work ran through `vite preview` and paid a full rebuild per change.
- **When you do use `vite preview`, it serves `dist/`, and neither vitest nor a commit rebuilds it.**
  Two changes were reported as not working when the browser was simply showing the previous build.
  Always `npm run build` after committing, then confirm a new marker string in the served chunk.
  This is still the right tool for verifying what actually ships - code splitting and minification only exist in the built output.
- **If an edit to a config file appears to do nothing, look for a compiled twin before doubting the config.**
  `frontend/tsconfig.node.json` is `composite` with no `outDir`, so `tsc -b` emitted `vite.config.js` beside its own source - and Vite resolves `vite.config.js` **before** `vite.config.ts`.
  The dev server read a stale compiled copy for days, and the artefact is gitignored, so nothing surfaced it.
  Fixed in 7.48.2 by emitting to `node_modules/.tmp/tsconfig-node`.
- **Minifiers rewrite literals, so grep for marker copy rather than numbers.**
  `0.65` is served as `.65` and named constants disappear entirely.
- **The recording styles are code-split into their own `RecordingSession-*.css` chunk.**
  Grepping `index-*.css` for them returns zero for every marker, which is indistinguishable from a failed build.
  A sanity marker that must be present caught it.

## 2026-08-16 — UX pass: participant journey, admin surfaces, and a contrast audit

Branch `feat/participant-browse-cards`, merged 2026-08-17 and released as 7.35.0.

### The pattern that produced most of the real findings

**Judge what is on screen, then check the claim against the code that has to keep it.** Four separate defects this session were the product stating something untrue, and three of them were introduced *by me* while fixing the others:

- "You can stop at any time" — there is no stop control anywhere in the recording flow. The only exit is the browser's own Stop sharing, and the partial recording uploads anyway.
- "About 30 minutes" — unmoderated has **no duration field in the authoring form**, so every such study carries the `DEFAULT 30` column value. The figure was above a consent button.
- "You will need Google Chrome" — Chromium is required for the *floating pane* only. Firefox and Safari run the study with two windows.
- An "Activity Trend" sparkline in AdaptaBits that plotted **nothing**: seven points derived from one scalar, its own comments reading "simulating weekly activity", last point hardcoded higher "to show growth".

### Dates and time zones

36 formatting call sites across `en-US`, `en-GB` and the browser default produced **three formats, two of them on one booking card**. Now one utility, `frontend/src/utils/datetime.ts`. Month always named; zone always an **offset**, because `timeZoneName: 'short'` returns `BST` to a British reader and `GMT-4` to an American one from the same call.

🔥 **A global formatting sweep is unsafe wherever the LAYOUT encodes a zone.** `AdminSessionManager`'s calendar positions slots with `getUTCHours()` and bounds day columns with `setUTCHours()`. The sweep replaced its forced-UTC labels with local ones and left the explanatory comment behind — every caption an hour out of its own row in BST. The grid is now local end to end (geometry, weekday exclusion, default range, both date pickers). Note `toISOString().split('T')[0]` is **wrong** for a local-midnight date in a positive offset: it renders the previous day.

### Contrast: measure, do not read

A grep found 104 hard-coded `color: #FFFFFF`. **Almost none of them were the problem** — most sit on dark fills and `_themes.css` overrides the rest. The real defect was the brand colour: `#dd6e42` fails AA in **every** text role (white on it 3.29, as text on cream 2.95, on white 3.29). The ramp already contained passing steps; components were reaching for 500. Added `--accent-text-on-light` (800) and `--accent-fill-on-light` (700) — **no new colours**. The **skip link** was among the failures: an accessibility feature failing contrast.

The method: walk every element, composite the background up the ancestor chain, apply the large-text exemption, report anything under the floor. Guessing from CSS would have missed the orange and "fixed" 100 innocent whites.

### Traps

- **`npx eslint <changed files>` is not the lint gate.** The backlog is per-file-per-rule in `eslint-suppressions.json`, so four clean files can sit over a red repo. Run `npm run lint` from the root. A suppression also **hid code I thought I had deleted** — my regex removed only a comment line.
- **A mutation that fails to compile prints "Tests: 0" and reads exactly like a kill.** Re-run it in a form that compiles.
- **`git checkout --` inside a mutation script destroys uncommitted work.** Commit before mutating.
- **Do not edit a file another live branch rewrites.** `ResponsesSection.tsx` already carried its fix on `feat/participant-welcome-expectations`, so the `end`-step filter went into `SessionReview.tsx` instead. Check `git diff main..<branch> -- <file>` first. Both branches are merged now, but the rule holds whenever two branches are open at once.
- **Seed gaps read exactly like product bugs.** The reviewer 404'd ("the session may not have started yet") for want of `opportunity_session_events` rows; the leaderboard was empty because it reads `user_profiles`, not `points_transactions`.
- **A seed guard outside a transaction fails open** — psql's `ON_ERROR_STOP` is off by default, and two `BEGIN/COMMIT` pairs defeat `psql -1`. `SUM(...) FILTER` over zero rows is NULL into a `NOT NULL` column, which would have fired on the 1st of a month.
- **`SELECT b.*`** on `/bookings/my/bookings` sent `admin_notes` — a researcher's written judgement of a participant — to that participant.
- **A test comment recorded a decision I was reversing.** `Admin.test.tsx` said MR !77 renamed "Studies" to "Research Studies" *because the short form was ambiguous*; I had shortened it to fit five cards across. A layout constraint is not a reason to reverse a content decision.

## Admin surfaces, honest numbers, and one name per type (2026-08-16, later)

A second pass over `feat/participant-browse-cards`, walking the admin dashboard, the authoring form and the analytics tab rather than reading them.
Nine commits.
Every finding below started as something visible on screen and was only then checked against the code.

### The pattern, again: the product stating something untrue

- **The default consent text promised a control that does not exist.**
  `DEFAULT_CONSENT_TEXT` pre-fills the required Consent field on every new unmoderated study, and it ended "You can stop at any time."
  There is no stop, withdraw or exit control anywhere in the recording flow, and the partial recording uploads regardless.
  Creating a study without touching the field wrote that sentence into the database, which is how it was found.
  It also contradicted Cortex's own non-authorable "Before you start" panel on the same page, which already said it correctly.
- **The study page showed participants the admin type name.**
  The hero badge called `formatOpportunityType`, so a recorded study read "UNMODERATED" - the one word participant copy is not allowed to use.
  This page matters more than browse: the shareable link lands here, so for most participants it is the only page they see.
- **"PARTICIPANTS: Any" sat above a panel saying the study needs a Cortex account.**
  Every route to taking part requires a signed-in account, and a recorded study refuses external participants outright when it is saved.
  The browse row had already reasoned this out and said nothing for `any`; the detail page had reached the opposite conclusion because it was deciding separately.
  Both now call one `getEligibilityNote`.
- **Every recorded study claimed "about 30 minutes", chosen by nobody.**
  There was no duration field in the authoring form, so both write paths fell back to `opportunities.default_duration_minutes` - NOT NULL, DEFAULT 30 - and the figure was printed above a consent button.
  The form was doing the same thing on its side, sending `default_duration_minutes` as the study's duration.
  Fixed by adding an OPTIONAL field: `firsthand.studies.estimated_duration_minutes` was already nullable with no default, so null already meant "not stated" and no migration was needed.

### Analytics was reporting numbers that were not measurements

- 🔥 **`toISOString().split('T')[0]` on a Postgres `date` loses a day, and the backend was never swept for it.**
  The endpoint returned `clicks_by_day: ["2026-08-15"]` and `peak_day: 2026-08-15` for two clicks whose own `first_click` it returned as 16 August - one response contradicting itself.
  `SELECT DATE(clicked_at)` cuts the day in the DATABASE session's zone, then node-postgres hands JS a Date at LOCAL midnight, which reads back in UTC as the previous day in any positive offset.
  Days, hours and weekdays are now cut in SQL in one organisation zone and returned as TEXT, so nothing downstream can re-read a calendar day as an instant.
- **Peak Hour read 11:00 beside a First Click of 12:30**, from the same two clicks, because `EXTRACT(HOUR ...)` ran in UTC while the timeline rendered locally.
- **A percentage change from a zero baseline is not 100%.**
  `week_over_week_change` returned 100 whenever the previous week was empty, so every study announced "+100%" in green with an up arrow from its first click, and two clicks claimed exactly what two thousand would.
  It returns null now and the card says "no previous week to compare".
  Zero was not an option either: zero reads as flat, which is a measurement.
- **A chart titled "(30d)" carried a total labelled "(7d)".**
  The title tracked the period selector while the total was pinned to seven days; at 7d they agreed by coincidence, which is exactly when nobody notices.
- **The zone is a product decision, not a technical one.**
  Buckets are cut in one fixed organisation zone rather than the reader's, because analytics is quoted between people and a chart that reshapes itself per viewer is worse than one that is explicitly in UK time.
  The page says which zone it counted in.

### Two tables, two competing width systems

- 🔥 **A positional column-width block silently owned the layout and beat every semantic class.**
  `.admin-dashboard table.table-hover thead th:nth-child(N)` at (0,3,3) outranked `.admin-recent-session` at (0,1,0) in the same cascade layer, so the class-based fix could never have worked.
  Measuring the computed style found it; reading the diff never would have.
- **It addressed columns by POSITION on a selector matching every table in `.admin-dashboard`, and there are two.**
  Recent bookings has four columns in a different order, so its Session column inherited the Type column's geometry - `width: 10%; max-width: 10%; white-space: nowrap` - which is 186px that cannot wrap holding a 225px value, in a `table-layout: fixed` table that cannot scroll.
  The value was painted over the participant's name.
- **Positional widths are wrong by construction the moment a column moves.**
  Removing the duplicate Capacity column - which printed `sum(capacity)` one cell to the left of Booked, which renders that same sum as its own denominator - shifted every position after it.
- 🔥 **Renaming a type is a layout change.**
  "Recorded study" is wider than "Unmoderated" and overflowed the type column by 4px in the same fixed table.
  jsdom has no layout engine, so none of 528 tests could see it; only re-measuring in the browser did.

### One name per type

`test` was "User Test" in the authoring form, "APP TESTING" on the dashboard badge and "Usability test" on browse - three words for one thing, so a researcher and a participant could not discuss the same study without translating.
`getParticipantFacingType` is now the only place a type becomes words, on admin surfaces as well as participant ones, and `formatOpportunityType` is deleted rather than kept: a second formatter is exactly how three names happened.
The dashboard's STUDY TYPE filter also had **no `unmoderated` option at all**, so recorded studies could not be filtered for - found only because the test enumerates `OPPORTUNITY_TYPES` instead of listing types by hand.

### Traps that cost real time

- 🔥 **`frontend/src/shared/**` is a COMMITTED COPY of `shared/**` and NOTHING regenerates it.**
  Not `npm run build`, not CI - while the banner stamped into every one of those files claimed it was copied "during the build process".
  A corrected `shared/` constant passed all 177 backend specs and left the frontend still shipping the old one, with a green suite either side.
  The banner now says what actually happens, its generation timestamp is gone so a regeneration is a no-op unless content changed, and `shared-copies-are-current.test.ts` fails the moment a source and its copy disagree.
- 🔥 **`cmd | grep && echo OK` reports success on a failing command**, because the exit status is grep's.
  A failing test suite and 15 lint errors both passed a gate this way.
  Redirect to a file and echo `$?`.
- 🔥 **Resolving a cherry-pick conflict by taking the incoming side wholesale imported the SIBLING branch's tests onto this one.**
  The incoming commit had been made on the merged walk branch, so its hunk carried content that only exists there.
  Caught because the imported test failed against this branch's component.
  Reset and re-applied only the intended tests onto this branch's own file.
- **A new test file has NO suppression budget**, so a single `as any` copied from a neighbouring grandfathered file fails the repo lint.
- **RTL's `findBy*`/`waitFor` returned without the DOM having advanced** on the analytics page, resolving against a body holding nothing but "Loading...".
  Four real assertions looked like component bugs.
  A plain poll on the container the render owns is dull and correct.
- **Driving the analytics period selector in jsdom re-enters the load effect and the run never terminates** - it hangs rather than failing.
- **A mutation that fails to compile prints "Tests: 0" and reads exactly like a kill.**
  Hit three times in one session; re-run it in a form that compiles before believing it.
- **Two mutations survived and both were real gaps rather than redundant layers.**
  Reverting the form to send `default_duration_minutes`, and restoring the backend's `?? default_duration_minutes` fallback, each passed every existing test because nothing asserted what the form submits or what the create path stores.
- **Asserting a phrase appears "somewhere in the query" is not enough.**
  Stripping `AT TIME ZONE` from the daily SELECT survived, because the GROUP BY still carried it and the query still read as zone-aware.
  Pin the projected column.

### Also fixed

`GET /api/bookings/pending-approvals` gated on the admin role and nothing else, while approve and reject beside it both check ownership.
Any `researcher_admin` could read every other researcher's completed sessions - participant names, participant emails, and `admin_notes`.
It also listed rows the reader could not act on, since approving another researcher's session 403s.
Filtered in SQL, not after the fetch: filtering in JS still pulls the notes and emails across the wire, which is the disclosure rather than the rendering of it.

## Shipping a stack of five branches at once (2026-08-17)

`fix/public-opportunity-leak`, `fix/superadmin-script-tls`, `feat/participant-welcome-expectations`, `feat/participant-browse-cards` and `feat/native-poll-survey` went in as 7.33.7, 7.33.8, 7.34.0, 7.35.0 and 7.36.0.
All five had been finished and verified green independently. Landing them was still not mechanical.

### Merging a stack

- **"Conflicts with nothing" is a statement about a base, not about a branch.**
  All five were measured against `main` at `77a8c52` and genuinely conflicted with nothing *there*.
  Three of the four remaining branches then conflicted as soon as their predecessor landed.
  Squashing each branch separately does **not** avoid this - the second branch to reach `main` still meets the first one's code.
  Re-measure after every merge with `git merge-tree --write-tree --name-only origin/main origin/<branch>`, which needs no checkout and changes nothing.
- **GitLab reports this as a bare `405 Method Not Allowed` from the merge API**, which says nothing about the cause. Read `detailed_merge_status` on the MR before concluding the call failed.
- **Keeping both sides of a conflict in a test file can produce a file that will not parse.**
  In `OpportunityForm.test.tsx` both sides' final test was left unclosed, because they shared the single `});` that sat *after* the conflict marker.
  Concatenating the two sides gave two open tests and one closing brace.
  vitest reports that as `Test Files 1 failed` / `Tests no tests`, which reads almost exactly like a resolution that merely broke some assertions - the same misleading signature as a mutation that fails to compile.
  Check brace balance, and confirm a real test count, before believing a resolution.
- **Confirm a resolution with a number somebody predicted, not with "it compiles".**
  The resolved test file had 37 tests and the frontend suite totalled 548, both figures recorded in advance for exactly that combination.
  For prose conflicts, byte-compare each kept section against its source with `git show <ref>:<file>`.
- **Generated files: regenerate, never pick a side.**
  `frontend/src/shared/firsthand/{contract,inline-study}.ts` conflicted while their `shared/` sources merged cleanly, which is the tell that the clash is churn rather than disagreement.
  Clear the markers, then run `node copy-shared-types.js` from `frontend/` so the result is derived. `shared-copies-are-current.test.ts` passing is the proof.
- **Re-run the whole matrix on every merge.** Each branch was green alone and no two had ever been tested together, and CI ran lint only *at the time* (it now runs lint, typecheck and three test jobs - see the 2026-08-19 entry). The counts climbed as the stack landed: backend jest 470, 504, 517; frontend 388, 548, 631.
- **The matrix itself grew mid-stack.** `fix/superadmin-script-tls` added `npm run test:scripts` (111 tests) and widened root lint to cover `backend/scripts`. Read the merged `package.json` rather than trusting a list written before the merge.
- Resolve in a throwaway worktree (`git worktree add`) so no other checkout is disturbed. A fresh worktree needs its own `npm ci` at the root as well as in `backend/` and `frontend/`, root first, because `shared/` resolves zod from there.
- Wait for each release before merging the next. A tag that fails to cut is invisible on a green pipeline, and four merges stacked on top make it far harder to see which one broke it.

### Verifying the deploy, where two obvious checks both lie

- **Grepping `assets/index-*.js` for a marker proves nothing.**
  The frontend is code-split, so page code is not in the entry bundle, and a marker from a page component is absent whether or not the deploy landed.
  `index.html` is no help either - it references only the entry JS and CSS, with no modulepreload links.
  The chunk list is in `const __vite__mapDeps=(...)` at the very top of the entry bundle: read that, then fetch the chunk that owns the code you changed.
  A chunk whose *file* is new is proof on its own - `SurveyPreview-*.js` existed nowhere before 7.36.0.
- **`/api/health` is a false positive during a failed roll.**
  Kubernetes keeps the old pod serving, so health stays `{"status":"ok","database":"up"}` while the new pod crashloops.
  Use a route that only the new code answers. Unauthenticated, `/api/firsthand/studies/:id/results` returned `404 Cannot GET` before 7.36.0 and `401` after, while the pre-existing `/api/firsthand/studies` returned `401` throughout.
  That flip also proves a **migration** applied, because the initContainer gates the pod, and it is the only evidence available without kubectl or ArgoCD access.
- Both the app and its API answer on the app origin. The separate `adaptalabs-backend.…` host refused connections from a workstation, so use `adaptalabs.kubera-playground.adaptavist.net/api/…`.

### One security rule worth keeping

**Answer a 403 before `res.setHeader`, not merely before `res.send`.**
Express keeps an already-set `Content-Type`, so a refusal placed after the CSV download headers still carries `text/csv` and `Content-Disposition` and hands the file over.
Assert the *absence* of those headers in the test, not just the status code - a status-only assertion passes the broken ordering.

The related ownership rule for participant data, and the open study-versus-opportunity question behind it, are in [docs/PRODUCTION_HARDENING.md](docs/PRODUCTION_HARDENING.md) and the product description.

---

## Closing the task window on completion, and a masked 409 (2026-08-18)

Two small participant-facing fixes, `fix/close-task-window-on-complete` (MR !143) and `fix/survey-already-answered-message` (MR !144).

- **A "close it too" fix is not safe at the call site the first close lives at.** `StudyRunner.finishSession()` already closes the floating pane unconditionally once `onComplete` resolves - including on the recorder-failure/abandoned branch, which resets the session to setup without stopping capture. Adding the task-window close there too passed every test, but a code-reviewer gate traced the actual runtime wiring: if the participant had shared the task window itself, closing it there would end a still-live `MediaStream` track, firing the recorder's `ended` listener and re-triggering `stopCaptureAndUpload` for an attempt that had just been marked abandoned. **Moved to `ParticipantSessionFlow`'s `onComplete` success branch only**, ordered after `stopCaptureAndUpload()` - which sets its `stopInFlightRef` guard and calls `recorder.stop()` synchronously before its first `await` - so the guard is already set by the time the window closes. Confirmed by mutation: removing the call, reordering it before the stop, and adding it to the failure branch each broke a dedicated integration test (`ParticipantSessionFlow.completion-cleanup.test.tsx`).
- **A generic catch-all error message can hide a working refusal.** The native-survey start button showed "Could not open the survey. Please try again or contact support." for five distinct backend outcomes - a genuine 500, an unconfigured runtime, zero authored questions, a network failure, *and* the correctly-designed 409 a participant gets for re-answering a survey they already completed (one session per participant, by design - see the product description). Reported live against a real test survey; the fallback branch made a working refusal read as a bug. **Fixed by giving 409 its own branch**, same pattern as the existing 404/403 cases.
- **Diagnosing a live report is faster through the user's own logged-in browser than from code alone.** The `claude-in-chrome` MCP drove the reporter's real Chrome session (already authenticated) to the failing opportunity and read the actual network response - one click, one `409`, no guessing between five candidate causes.
- **Verifying a deploy for a lazily-loaded page**: same technique as the stack above - the page's code lives in its own chunk (`OpportunityDetail-<hash>.js`, found via `__vite__mapDeps` in the entry bundle, or just by grepping the entry bundle for the component name), not the entry bundle. Confirmed by grepping the deployed chunk directly for the new and old message strings, then reproducing the click in the browser to see the fixed copy render.

---

## The tests that were never running (2026-08-19)

Started as four hardcoded `localhost:3000` strings in Playwright specs. What it
actually uncovered was a class: **work that reports success while verifying
nothing.** None of it announced itself as broken - it presented as green,
skipped, flaky, or hung.

- **The whole e2e suite collected ZERO tests, and had since the initial commit.**
  `e2e/critical-flows.test.ts` throws while Playwright transforms it, which
  aborts collection for every spec in `testDir`. Four npm scripts were dead, not
  one. Filtering to a single spec hides it, which is why nobody saw it.
- **Two click-tracking tests passed with the button click deleted.** They matched
  any POST to `/click`, and the detail page fires a `view` track on mount - so
  the assertion was satisfied before the button was ever pressed. Proven by
  deleting the click, not by reading the code.
- **A test that had never executed once.** It browsed the home page anonymously
  looking for study cards; signed out, that page is a marketing page with three
  links. The count was always zero, so it skipped and reported green.
- **`npm run test:a11y:prod` graded a different application.** It read its own
  `BASE_URL` constant rather than the config's `baseURL`, so it tested whatever
  sat on `localhost:3000`. It returned ten confident accessibility failures in
  24 seconds about an unrelated app.
- **Nothing type-checked any test file, in either app.** Both `tsconfig.json`s
  exclude tests and no job ran `tsc`. That is how a fixture named
  `transferredBytes` (real field: `loadedBytes`) silently disarmed the exact
  assertion it was written for.

### Two product defects fell out of chasing them

- **The edit form was interactive before it hydrated.** `loadingOpportunity`
  started `false` and only became `true` inside the effect, so one painted frame
  showed a live, empty form. A value chosen in that frame was replaced when the
  load resolved - no error - and the save reported success while storing the
  loaded value. Same family as the A0/A1 silent-loss defects. Found as a ~50%
  e2e flake, proven by A/B against two frontend builds: unfixed 2 of 6 runs
  failed, fixed 0 of 6.
- **The auth limiter's demo-route exemption was dead code.** It compared
  `req.path` against `/auth/demo-login`, but Express reports `req.path` relative
  to the mount point, so it never matched. Demo logins were rate limited in
  development; a run of e2e specs exhausts 100 requests per 15 minutes and the
  429s look like broken auth.

### Rules worth keeping

- **A green suite is not evidence it ran.** Check the collected count.
- **Mutation-test the assertion, not the code.** Delete the action the test
  claims to verify. If it still passes, it was never testing that.
- **A fast, confident failure against a deployment is a smell** - check what it
  connected to before believing it.
- **`@testing-library`'s `render()` cannot see the first paint.** It wraps in
  `act()`, which flushes effects before any assertion runs. A "is it gated
  before load" test written that way passes with or without the fix - use
  `renderToStaticMarkup`.
- **Fix the generator, not the instance.** The suites are in CI now, and `tsc`
  runs over the tests, because otherwise this recurs.
- **Test files under `backend/` or `frontend/` are still deploy paths** to the
  stranded-merge detector unless they match its non-deployed patterns, and a
  `package.json` change always is. A test-only change there needs `test:` *and*
  !173's filter; anything touching a manifest needs a releasing type.

## Links

- Production (Kubera playground): https://adaptalabs.kubera-playground.adaptavist.net
- Backend (public ingress, server-to-server callbacks): https://adaptalabs-backend.kubera-playground.adaptavist.net
- Retired: adapta-labs-p62q.vercel.app (Vercel, pre-Kubera)

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

The M6 items that used to sit here are done - click tracking, poll analytics and the M6 production-readiness work all shipped. Current open items, as of 2026-08-17:

- **A real "Stop and end this session" control** in the recording flow. The copy now describes stopping truthfully, but there is still no stop, withdraw or exit control anywhere in it. Build it on top of the participant launch flow, which is where those files live.
- **A one-way "convert to instruction" control** for legacy `open_text` / `single_choice` steps. Typed answers are gone from authoring and runtime, so a legacy typed step currently has no way to be edited or converted.
- **Phase 4 of native polls and surveys** - the authoring toggle, the publish-guard change, CTA labels and `OpportunityDetail` routing. Settle the study-versus-opportunity ownership question for results first, see [docs/PRODUCTION_HARDENING.md](docs/PRODUCTION_HARDENING.md).
- **Server-side consent gating** (GDPR Art. 7(1)), tracked and deliberately deferred.
- **Never walked at all:** the superadmin surfaces (admin requests, admins list, feedback), AdaptaBits and gamification, My Bookings end to end, and the session review and playback surface.

**Short continuation prompt (copy for future sessions)**

```
When continuing work on this project:
MCPs available: cursor-ide-browser, cursor-browser-extension, user-chrome-devtools, user-playwright, user-vercel, user-figma, user-clerk, user-convex, user-supabase, user-atlassian, user-forge-knowledge
Learnings: Use learnings.md in the project root as a reference for prior discoveries, gotchas, and conventions. When you find something reusable (fixes, patterns, pitfalls), add it to learnings.md with a short, actionable note.
Suggested follow-ups: M6 End-to-End Click Tracking Test (publish poll → click "Open Poll" → verify click tracked); Analytics Dashboard Verification (confirm analytics for published polls); Production readiness for M6 (error handling, env vars, README for M6).
```

---
