# Learnings

Project context and decisions for AdaptaLabs. Reference this in new chats to get up to speed.

---

## Project overview

- **Name**: AdaptaLabs (adaptalabs-root), **version**: 7.3.23
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
