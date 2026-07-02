# AdaptaLabs Remediation Plan — 2026-06-18

> **Status as of 2026-07-02: RESOLVED.** Workstream A (`fix/api-auth-hardening`, MR !6),
> Workstream B (B1/B3/B6/B4-partial, `feat/server-parity`, MR !7), and Workstream C all
> merged to `main` and deployed clean. Note: the Vercel `api/` surface this doc targets
> is a **retired** deployment target — real production is the Express `backend/` server
> via GitLab/Kubera/K8s (see `archive/code-reviews/` session notes or ask for details).
> A separate, unrelated live gap in `backend/src/routes/auth.ts` (Google OAuth demo-mode
> fallback not gated behind `NODE_ENV`, plus a `code=demo-code` bypass) was found and
> fixed independently via MR !8, merged 2026-07-02T14:31. The rest of this document is
> kept as a historical record of the original plan and is not being actively worked.

Follows the consistency & integrity review of v7.3.23. Covers three workstreams:
**A** ship the auth-hardening branch, **B** close the production/dev server-parity gap,
**C** clean up the medium/low consistency items.

Recommended order: **A → B → C** (A is committed and security-critical; B is the
biggest user-facing gap; C is hygiene). B and C can interleave once A ships.

---

## Workstream A — Ship the auth hardening (branch `fix/api-auth-hardening`)

Status: committed (98fc886), not pushed/merged/deployed.

### A0. Prerequisites (set in Vercel **before** deploy)
- `SETUP_SECRET` — long random string. Required to call `/api/run-migrations` and
  `/api/admin/set-superadmin` without an existing superadmin session.
- `ALLOW_DEMO_LOGIN` — leave **unset** in production (demo logins stay 404). Set to
  `true` only on a staging deployment that needs the demo buttons.
- Confirm a real superadmin exists (`nfine@adaptavist.com`) so admin flows keep working
  via Google OAuth after demo logins are disabled.

### A1. Pre-merge verification (local / preview)
1. `git push -u origin fix/api-auth-hardening`; open PR to `main`.
2. Deploy as a **Vercel preview** (not prod) with `ALLOW_DEMO_LOGIN=true` + `SETUP_SECRET`.
3. Manual checks on preview:
   - `/api/auth/superadmin-login` → 404 when `ALLOW_DEMO_LOGIN` unset; works when set.
   - `POST /api/opportunities` unauthenticated → 401; as non-owner admin → still creates
     own; as superadmin with `owner_user_id` → assigns owner.
   - `PATCH`/`DELETE /api/opportunities/:id` as a non-owner researcher_admin → 403 OWNER_ONLY.
   - `POST /api/sessions` + `POST /api/opportunities/:id/sessions` unauth → 401; non-owner → 403.
   - `/api/run-migrations` without secret/superadmin → 403; with `?secret=` → runs.
   - `/api/admin/reset-production-db` as researcher_admin → 403; as superadmin → works.
   - `GET /api/opportunities/:id/sessions` for a draft as anon → 404.
4. Run smoke + a11y prod suites against the preview URL.

### A2. Merge & deploy
- Merge PR, deploy to prod, re-run `npm run test:smoke`.
- Bump version (see C1) in the same release.

### A3. Rollback plan
- If admin access breaks, set `ALLOW_DEMO_LOGIN=true` temporarily, or revert the merge
  commit. No DB migration is involved, so rollback is config/redeploy only.

---

## Workstream B — Production/dev server parity

**Root problem (discovered during planning):** the Vercel `api/` tree is missing whole
service layers that `backend/` has. `api/services/` contains only `email.ts`; there is
**no gamification service** (`api/gamification/utils.ts` only has `generateDummyLeaderboard`)
and **no calendar service**. So several "existing" prod endpoints already serve stub/dummy
data, and porting the lifecycle endpoints means porting services, not just handlers.

### B0. Decision: piecemeal port vs. shared modules
Two options — pick before starting:
- **(Recommended) Port + extract shared service modules.** Move reusable logic
  (gamification, calendar, booking) into `shared/` or a co-located module that both
  `api/` and `backend/` import, so they stop diverging. Higher up-front cost, kills the
  root cause.
- **Quick port.** Copy each Express handler into a Vercel function inline. Faster, but
  re-creates the drift the review just flagged.

The phases below assume **port-with-extraction** for the service-heavy endpoints (B3–B4)
and inline ports for the pure-DB endpoints (B1).

### Endpoint inventory → target Vercel files
(Vercel auto-routes `api/**/*.ts`; no `vercel.json` change needed for new files.)

| Frontend call | Method/path | Express source | Target Vercel file | Phase |
|---|---|---|---|---|
| `updateSession` | PATCH /sessions/:id | sessions.ts:212 | add PATCH to `api/sessions/[id].ts` | B1 |
| `deleteAllSessions` | DELETE /opportunities/:id/sessions | opportunities.ts:911 | add DELETE to `api/opportunities/[id]/sessions.ts` | B1 |
| `closeOpportunityIfPast` | POST /opportunities/:id/close-if-past | sessions.ts:491 | `api/opportunities/[id]/close-if-past.ts` | B1 |
| `cleanupCancelledBookings` | POST /bookings/cleanup-cancelled | bookings.ts:731 | `api/bookings/cleanup-cancelled.ts` | B1 |
| `getOpportunityBookings` | GET /bookings/opportunities/:id/bookings | bookings.ts:881 | `api/bookings/opportunities/[id]/bookings.ts` | B1 |
| `getPlatformStats` | GET /stats/platform | stats.ts:14 | `api/stats/platform.ts` | B1 |
| `rescheduleBooking` | POST /bookings/:id/reschedule | bookings.ts:494 | `api/bookings/[id]/reschedule.ts` | B4 (calendar/email) |
| `completeSession` | POST /bookings/sessions/:id/complete | bookings.ts:943 | `api/bookings/sessions/[id]/complete.ts` | B4 |
| `getPendingApprovals` | GET /bookings/pending-approvals | bookings.ts:1024 | replace stub `api/bookings/pending-approvals.ts` | B4 |
| `approveSession` | POST /bookings/:id/approve | bookings.ts:1065 | `api/bookings/[id]/approve.ts` | B3+B4 (gamification) |
| `rejectSession` | POST /bookings/:id/reject | bookings.ts:1149 | `api/bookings/[id]/reject.ts` | B4 |
| `getFirstHandStudies` | GET /firsthand/studies | firsthand.ts:43 | `api/firsthand/studies.ts` | B5 |
| `startFirstHandSession` | POST /opportunities/:id/firsthand-handoff | opportunities.ts:501 | `api/opportunities/[id]/firsthand-handoff.ts` | B5 |
| `getOpportunitySessionEvents` | GET /opportunities/:id/session-events | opportunities.ts:553 | `api/opportunities/[id]/session-events.ts` | B5 |
| `getAchievements` | GET /gamification/achievements | gamification.ts:36 | `api/gamification/achievements.ts` | B3 |
| `getPointsHistory` | GET /gamification/points-history | gamification.ts:75 | `api/gamification/points-history.ts` | B3 |

### B1. Low-risk pure-DB endpoints (no service deps)
Port the 6 endpoints above marked B1. All use the new shared auth guards from Workstream A
(`requireAdmin`/`requireAuth`/`assertOwnerOrSuperadmin`). Each is a thin DB handler.
`deleteAllSessions` must refuse if any session has bookings (match Express).

### B2. Response-shape parity fixes (within already-shared endpoints)
- **Analytics:** Express `getOpportunityAnalytics` returns only `{clicks_total, clicks_24h,
  clicks_by_day}` while frontend `OpportunityAnalytics` (client.ts:451) + Vercel return the
  rich object. Bring Express up to the full shape (or accept Vercel as source of truth and
  document that local-dev analytics is partial).
- **`include_past` default:** Express excludes past sessions by default; Vercel includes
  them. Pick one (recommend: exclude past unless `include_past=true`) and align both
  servers + `getSessions` client default.
- **`booked_count`:** Vercel list/`[id]` recompute from bookings but `sessions.ts` /
  `[id]/sessions.ts` return the stored column — make all paths recompute.

### B3. Gamification service port (blocks approve + achievements + points-history)
- Port `backend/src/services/gamification.ts` (`awardPoints`, `awardPointsAfterApproval`,
  `getUserAchievements`, `getPointsHistory`, `getUserProfile`, real `getLeaderboard`/
  `getMonthlyLeaderboard`) into a module importable by `api/`.
- Replace the dummy `api/gamification/{profile,leaderboard,leaderboard/monthly}.ts` data
  paths with the real service. **Note:** prod gamification is currently dummy data — fixing
  this is a visible behaviour change; confirm desired.
- Verify the points/achievements DB tables exist in prod (add to `run-migrations` if not).

### B4. Booking lifecycle (complete / approve / reject / reschedule / pending-approvals)
- Depends on B3 (approve awards points) and on a **calendar service** for reschedule
  (api/ has none). Decide: port calendar logic, or have reschedule update DB + email only
  and document the calendar limitation (consistent with KNOWN_ISSUES calendar caveats).
- Reuse `api/services/email.ts` for notifications.
- Replace the `pending-approvals` stub with the real admin query (owner-filtered).

### B5. FirstHand integration (highest uncertainty)
- `firsthand-handoff`, `firsthand/studies`, `session-events`, plus the `firsthand/callbacks`
  webhook. Requires the external FirstHand config/secret and the `session_events` schema.
- Scope separately — verify external dependencies and env before committing to this phase.

### B6. Parity guard (prevent re-drift)
- Add a test that asserts every path the frontend `api/client.ts` calls resolves to an
  existing `api/**` file (static check), and a small contract test per endpoint.
- Document the api/↔backend parity expectation in `learnings.md`.

---

## Workstream C — Consistency cleanup

### C1. Version alignment (re-drifted since the v4.2 review)
- Set root, `frontend`, `backend`, `api` `package.json` all to one version (bump on the
  Workstream-A release).
- Update docs stuck at 3.12.0: `KNOWN_ISSUES.md`, `TESTING_GUIDE.md`, `USER_GUIDE.md`,
  `ADMIN_GUIDE.md`, `RESET_DATABASE_GUIDE.md`, and `learnings.md` (says 7.3.22).
- Consider a single source of truth (script that stamps version from root) to stop drift.

### C2. Stale type artifacts
- Regenerate or delete `shared/types/index.d.ts` / `index.js` / `index.d.ts.map` (missing
  `superadmin` + ~6 interfaces; nothing imports them but they mislead).
- Delete `shared/test-utils/index.ts.backup`.
- Fix inline `OpportunityType` unions missing `unmoderated` in
  `backend/src/services/gamification.ts:121,235,497` (import the shared type instead).

### C3. Dead code
- Delete `frontend/src/components/NeuralBackground.tsx` and `NeuralParticleField.tsx`
  (zero importers).
- Remove the `BackgroundAnimation` import/usage in `App.tsx:9,42` (component is hard `return
  null`) or delete the component.

### C4. Error-handling consistency (frontend)
- Route the ~12 copy-pasted `err as {response?...}` blocks through
  `mapAxiosError`/`formatErrorMessage` in `utils/errorHandler.ts` (currently mostly dead).
- Replace blocking `alert()` error/success in `AdminManagement.tsx`, `AdminFeedback.tsx`,
  `PendingApprovals.tsx` with the inline-banner pattern used elsewhere.
- Fix `utils/logger.ts:1` to import types from `../api/types` not `../shared/types`.

### C5. Adopt the dead constants (optional, larger)
- `shared/constants` (`USER_ROLES`, `OPPORTUNITY_TYPES`, …) are defined but never imported;
  ~100+ raw string-literal enum checks instead. Either adopt them or delete them. Adopting
  gives rename-safety but is a wide mechanical change — schedule on its own.

### C6. Color tokens (low)
- Replace hardcoded hex in `UnderDevelopment.tsx`, `ConfirmationModal.tsx:56-100`,
  `AdminManagement.tsx:450-464`, and the scattered danger/success hexes with CSS vars.

---

## Effort & sequencing summary

| Phase | Effort | Risk | Notes |
|---|---|---|---|
| A | S | low | Config + verify + merge; security-critical, do first |
| B1 | M | low | 6 thin DB endpoints |
| B2 | S | low | shape/default alignment |
| B3 | L | med | port gamification service; changes prod dummy→real |
| B4 | L | med | depends on B3 + calendar decision |
| B5 | L | high | external FirstHand deps; scope separately |
| B6 | S | low | parity guard test |
| C1 | S | low | version + docs |
| C2 | S | low | delete/regenerate artifacts |
| C3 | S | low | delete dead components |
| C4 | M | low | error-handling refactor |
| C5 | L | low | optional, wide mechanical change |
| C6 | S | low | color tokens |

Suggested path: **A** → **C1–C3** (quick wins, ship with A's release) → **B1–B2** →
**B6** → **B3–B4** → **B5** (only after confirming FirstHand deps) → **C4** → **C5/C6** as capacity allows.
