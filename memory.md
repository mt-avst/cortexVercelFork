# Cortex / AdaptaLabs — Session Memory (updated 2026-07-16)

Working memory for continuing the Cortex work in a new chat.
Covers a two-day session (2026-07-13 to 2026-07-15) that shipped FirstHand end-to-end, resolved a week-long backend outage, got real Okta SSO fully working, fixed the GitLab MCP server, and completed a verified browser E2E run of the FirstHand integration against real Postgres — with three real bugs found and fixed along the way.

> **Update 2026-07-16** — see the "2026-07-16" section at the bottom for current state. In short:
> phase 2 recording playback is **shipped and merged** (the "Immediate next steps" list further
> down is stale on that point); a real bug in it was found and fixed (FirstHand PR #12); the
> FirstHand containment question is **decided** (move to Kubera + S3) with a construction plan
> written; the DevEx question was **sent and answered same day** (deploy to both clusters, real
> participant data to production, everything self-serve — see the 2026-07-16 section); and the
> participant UX tidy-up is **still outstanding**. Next actions: plan step 1, and the UX work.

---

## Project basics

- **Product**: Cortex (internal research-participant recruitment app; formerly "AdaptaLabs")
- **Repo**: GitLab `cto/AdaptaLabs` at `gitlab.adaptavist.net`. Local working dir: `/Volumes/Extreme Pro/Labs2`
- **Stack**: React (Vite) SPA frontend + Express/TypeScript backend + PostgreSQL (raw `pg`). Monorepo: `frontend/`, `backend/`, `shared/`.
- **Deployment**: **Kubera** (Adaptavist internal k8s) via GitLab CI → ArgoCD GitOps. Manifests in `.kubera/`. The old Vercel deployment is retired.
- **Playground URLs**:
  - Frontend (public): `https://adaptalabs.kubera-playground.adaptavist.net`
  - Backend: **private** (cluster-internal only) — reached via the frontend nginx proxy
- **GitLab MRs**: created via `git push -o merge_request.create -o merge_request.target=main -o merge_request.title="..."` (the API token can push but 403s on direct MR-create, and also 401s on programmatic merge — API merges aren't possible with this token; merge in the GitLab UI).
  Merges require the pipeline to pass, so clicking merge sets **auto-merge-when-pipeline-succeeds** (shows "open" until CI is green — not a bug).
- **Trivy scan** on the backend image is `allow_failure` — "passed with warnings" is normal, ignore it.
- **GitLab MCP is working** as of 2026-07-15 — see the fix note below. Use it for MR/pipeline status instead of the browser where possible.

## Platform contact

- **Lilly Holden** — platform/DevEx engineer. Owns Kubera + Okta. Wrote the Kubera Okta docs. Uses an agent ("Fable") that reads the actual Helm chart source. Responsive; keep asks tight and specific.
- Kubera docs live in Confluence: `adaptavist-group.atlassian.net/wiki/spaces/Platform/folder/1102184452/Kubera`.

---

## What shipped this session (all merged to `main`, deployed & verified live)

| MR | What |
|----|------|
| !13 | FirstHand integration config on Kubera |
| !14 | Docs: FirstHand enablement learnings |
| !15 | Deleted the retired Vercel `api/` surface; ported reminder cron to in-process node-cron; added missing `bookings.reminder_sent_at` migration |
| !16 | Replaced deprecated `csurf` with `csrf-csrf` double-submit; wired the SPA to send tokens; hardened `validateUrl` to http/https |
| !17 | DB init container: 10s connection timeout + explicit logging |
| !18 | DB connection resolution reads Kubera's actual injected env vars, not just `DATABASE_URL`/`POSTGRES_URL` |
| !19 | Trim whitespace/newlines from injected DB credentials + secret-free `[db] connection source:` diagnostic log |
| !20 | App-level Okta OIDC (`auth.okta_app`), backend made private, superadmin bootstrap |
| ~~!21~~ | CLOSED, NOT MERGED — key-gated demo login backdoor. Nick correctly rejected it. Do NOT resurrect it. |
| !22 | `isDatabaseAvailable()` checked only `DATABASE_URL`; added `hasDatabaseConfig()` covering every source `resolveDatabaseUrl()` accepts. Deleting the stale `DATABASE_URL` (see outage below) had silently flipped this to false, sending the whole backend into mock-data mode |
| !23 | `firsthand-handoff` and `session-events` routes checked `req.user` but had **no auth middleware mounted** — guaranteed 401 for every user, found on the first real E2E run once login worked. Added `requireAuth` + regression tests |
| !24 | Frontend 401s redirected to dead routes (`/api/auth/admin-login` doesn't exist; `/api/auth/google-login` is blocked/deprecated). `toLogin` now sends all production roles to `/api/auth/login` (Okta OIDC); `isAdminRoute()` narrowed to actual `/admin` paths |

FirstHand PR #9 (callback retry queue) also merged in the FirstHand repo (`~/code/FirstHand`, Vercel `first-hand.vercel.app`) earlier in this session.

## The week-long backend outage — RESOLVED (2026-07-13)

Root cause: a stale, manually-set `DATABASE_URL` in the Kubera secret store, which our resolution order preferred over Kubera's injected `DB_URL`/`DB_HOST`.
Lilly deleted it and restarted → fixed.
MRs !17–!19 are the durable hardening.

## Okta login — RESOLVED (2026-07-14)

Root cause was **not** Okta app configuration, despite an extensive earlier diagnosis pointing there.
Hand-added `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` sat in the Kubera secret store, outside our GitOps manifests, carrying client `0oaw330m1lzLlY4G74x7`.
Backend code (`auth.ts`) prefers `OIDC_CLIENT_ID` over the chart-injected `clientID`.
The chart's actually-provisioned app is **`0oay3hbmshTHtvW4I4x7`** — a different client — so every authorize request used a client ID Okta rejected with a 400.
Lilly spotted the overlapping vars, deleted both, pods restarted onto the chart credentials, login worked.
Second occurrence of the stale-manual-secret-shadows-injected-value failure class (first: the `DATABASE_URL` outage).
The earlier "redirect URI is registered" evidence was screenshotted against the wrong (`0oaw330...`) app, which is why the diagnosis initially pointed at group-assignment/grant-type — a lesson in double-checking which app a screenshot is actually of.

**Agreed follow-up, not yet built**: secret-free startup log of the OIDC credential source + loud warning when `OIDC_CLIENT_ID` and `clientID` are both present and differ, mirroring !19's `[db] connection source:` pattern.
Do NOT flip precedence — `OIDC_*` is the documented interface for self-hosted deploys (`docs/IT_OPS_DEPLOYMENT.md`).

**Superadmin bootstrap confirmed working**: `nfine@adaptavist.com` elevated to superadmin on first real OIDC login, full admin UI visible.

## GitLab MCP — FIXED (2026-07-14)

Two separate faults, both in `~/.claude.json` under `mcpServers.gitlab`:
1. `GITLAB_API_URL` pointed at `gitlab.com` — the configured PAT is an `adaptavist.net` token, so every call 401'd. Fixed to `https://gitlab.adaptavist.net/api/v4`.
2. The archived `@modelcontextprotocol/server-gitlab` (0.5.1) emits tool `inputSchema`s missing `"type": "object"`, which current Claude Code's `tools/list` validation rejects — the server showed `✔ Connected` in `claude mcp list` but exposed zero tools, silently, with no error surfaced to the session.

Replaced with `@zereight/mcp-gitlab` (134 valid tools including pipelines, with `USE_PIPELINE=true`).
Verified working: `mcp__gitlab__*` tools are live and were used successfully for MR/pipeline status.
If gitlab tools vanish again: check `claude mcp list` first, then the JSONL logs in `~/Library/Caches/claude-cli-nodejs/*/mcp-logs-gitlab/` — they show the exact handshake failure.
**Also confirmed**: an app *window reload* (Cmd+R equivalent) does not relaunch MCP servers and does not pick up config changes — only a full app quit-and-reopen does.

## FirstHand integration — DONE, verified end-to-end (2026-07-15)

Full browser E2E run against **real Postgres** (not mock data), driven via the Chrome extension in Nick's real browser:

1. Created an Unmoderated opportunity in Admin, linked to a launched FirstHand study (`Cortex E2E Verification Study`)
2. Published it, viewed it as a participant, clicked "Start Test" — this is where !23's missing-`requireAuth` bug was found and fixed
3. FirstHand session created via the handoff endpoint, full consent → setup → recording flow completed with a real mic+screen recording (native permission dialogs — Nick had to click Allow himself, not automatable)
4. Session finished, uploaded, redirected back to Cortex via `return_url` with `?completed=1` — "Session complete" banner shown
5. **Admin Sessions tab** (`/admin/opportunities/:id/analytics`, Sessions sub-tab) correctly shows both `Started` and `Completed` events for the participant, each with a working "Review in FirstHand" deep link

This is the callback pipeline proven live: FirstHand → `POST /api/firsthand/callbacks` → `opportunity_session_events` table → rendered in the Sessions tab.
Task #7 is complete.

**Known UI navigation quirk found along the way**: the admin study list's row-click and the "Actions" dropdown's "Analytics" item can both target the same screen coordinates across a re-render if you click via raw pixel coordinates on a stale screenshot — always re-`find`/re-read the DOM ref right before clicking rather than reusing coordinates from an earlier screenshot. Not a product bug, a browser-automation gotcha.

**Real bug found (not yet fixed) — analytics dashboard fields are unimplemented on the backend**: the Overview tab showed Study Views: 0, Actions Taken: 0, Conversion Rate: 0%, Unique Users: 0, alongside a genuine Total Interactions: 8 — internally inconsistent, and the Clicks-by-Hour / Clicks-by-Day-of-Week charts always say "No data yet".
Root cause: `GET /api/opportunities/:id/analytics` (`backend/src/routes/opportunities.ts:1196`) only ever returns `{ clicks_total, clicks_24h, clicks_by_day }`, while the frontend's `OpportunityAnalytics` type (`frontend/src/api/client.ts:497`) expects `views_total`, `actions_total`, `unique_users`, `conversion_rate`, `peak_day`, `peak_hour`, `clicks_by_hour`, `clicks_by_weekday`, and a views/actions split per day.
Every missing field silently defaults to 0/[] via `??` in the UI — no crash, just wrong numbers everywhere except the raw total.
The `opportunity_clicks` table already has the `click_type` column needed ('view'/'action') to build this properly; it's just never been aggregated on.
**Spawned as a follow-up task** (not built this session) — real backend work: `click_type`-filtered aggregations, `COUNT(DISTINCT user_id)`, hour/weekday extraction, peak-day/hour picks.

---

## Current auth architecture (post !20, !23, !24)

- **Frontend**: public ingress, no auth block (static SPA + nginx proxy).
- **Backend**: private ingress. `auth.okta_app` declared here (runs the token exchange).
- OIDC code (`backend/src/routes/auth.ts`) reads `OIDC_CLIENT_ID || clientID` and `OIDC_CLIENT_SECRET || clientSecret` — chart-injected `clientID`/`clientSecret` are now the only values actually set (the stale overrides were deleted 2026-07-14).
- **Superadmin bootstrap**: `BOOTSTRAP_SUPERADMIN_EMAILS=nfine@adaptavist.com` → elevated on first OIDC login. **Confirmed working live.**
- **401 redirects**: fixed in !24 — all production 401s now go to `/api/auth/login` (real Okta OIDC), not the dead demo/Google routes.
- **Direct-URL-load auth gap — FIXED (2026-07-15)**: `AuthContext.tsx` used to only validate the session on mount when a sessionStorage `loginRedirect` flag (set by `redirectToAuth`) was present.
  Any other mount — a direct URL load, bookmark, or full-page refresh — skipped the `/api/me` check entirely and rendered logged-out even when the session cookie was still valid server-side, and the effect's fallback path actively called `/api/auth/logout` on every such mount, silently killing the still-valid session cookie (masked in testing because Okta's own SSO session let "Access Cortex" silently round-trip back in).
  Fixed: the mount effect now always calls `fetchUser(true)` (`/api/me`) regardless of the flag; the flag is kept only to trigger one extra retry for the OIDC-callback cookie-timing race, as originally intended. `AuthProvider` wraps `Router` in `App.tsx`, so this only runs on real mounts, not on every React Router navigation.
  Along the way, fixed a related latent bug in `handleLogout`: it only cleared `user`/`error` state on the success path, so a failed `logout()` API call left stale user state in memory (comment said "still redirect even if logout fails" but the code didn't clear state) — moved the clearing into a `finally` block.
  Un-skipped and rewrote the `describe.skip`'d `AuthContext.test.tsx` suite (was skipped since MR !16, described pre-redesign behaviour) — 12 tests now covering mount-time session validation (with/without the flag), StrictMode double-mount guarding, login/logout/refreshAuth/clearSessionCookies.
- **Known latent risk, unchanged**: OIDC `state` is an in-memory `Map`, and express-session uses MemoryStore.
  If the backend ever runs >1 replica, OIDC state validation AND sessions break across replicas.
  Worth hardening (cookie-based state + shared session store) before scaling beyond 1 replica.

---

## Native FirstHand session review — MERGED / SHIPPED (2026-07-15)

Two-repo feature so reviewers read a FirstHand session **inside Cortex** (transcript, per-step responses, attempt history, recording metadata) instead of ejecting to FirstHand. All three MRs/PRs merged; both repos on `main`, branches auto-deleted. Cortex redeploys via ArgoCD, FirstHand via Vercel.

- **FirstHand PR #10** — MERGED `e293ab6` (15:22Z). HMAC-authed `GET /api/sessions/[sessionId]/outputs` (`src/app/api/sessions/[sessionId]/outputs/route.ts` + `src/lib/session-outputs.ts`), 27 tests.
- **Cortex MR !33** — MERGED `f7da840` (15:21Z). Proxy `GET /api/opportunities/:id/sessions/:sessionId/outputs` (owner-or-superadmin, scoped against `opportunity_session_events`) + `/admin/opportunities/:id/sessions/:sessionId/review` UI + `SessionsTab` extracted/deduped. Also tightened `GET /:id/session-events` to owner-or-superadmin. Auto-merged on pipeline #337424; the earlier #337420 "failed" was a stale duplicate pipeline that lost a race in `generate-environment-jobs` — GitLab judges auto-merge on the latest pipeline, so it didn't block.
- **Cortex MR !32** — MERGED `2532edf` (15:18Z). Cleared 11 production npm CVEs (dropped unused `googleapis`; bumped express/nodemailer/node-cron). Disjoint file set from !33 → no conflict.
- Contract: `docs/FIRSTHAND-INTEGRATION-CONTRACT.md` endpoint 4. `assets[].media_url` reserved for **phase 2** (short-lived HMAC-signed URL to FirstHand asset route bypassing reviewer OIDC); `contract_version` stays `1.0` (additive).
- **gotcha**: an invalid `GITHUB_TOKEN` env var shadows the good `gh` keyring token (`nickfine`, has `repo` scope). Use `env -u GITHUB_TOKEN gh ...` / `... git push ...` for FirstHand. Also: `git ls-remote origin <branch>` exits 0 even when the branch doesn't exist — don't treat a 0 exit as "pushed"; check for actual ref output. GitLab token: can push (incl. `-o merge_request.create`) but 403s on API MR create/update and 401s on API merge → merge in UI.

## Immediate next steps (in order)

> **STALE as of 2026-07-16 — item 2 is done.** See the 2026-07-16 section at the bottom.

1. **Post-deploy sanity check**: once Cortex (ArgoCD) and FirstHand (Vercel) redeploy, hit the live `/api/sessions/:sessionId/outputs` path and open a session in the Cortex review UI to confirm the wired-up feature works against prod, not just tests. **Still outstanding.**
2. ~~**Phase 2 — session recording video**~~ **DONE 2026-07-15** (FirstHand PR #11 + Cortex MR !34, both merged to main). Plus PR #12 fix, 2026-07-16.
3. Backlog / nice-to-haves: harden OIDC state + session store if backend goes multi-replica; medium-term KNOWN_ISSUES items (WCAG AA, in-app notifications, analytics CSV export).

_(Done since this file was last written: OIDC credential-source warning — merged `feat/oidc-credential-source-diagnostics`; analytics breakdown fields — merged `feat/opportunity-analytics-aggregation` + `click_type` persistence; direct-URL-load auth gap — fixed in `AuthContext.tsx` 2026-07-15.)_

## Handy facts

- Okta clients: **live/working app-level OIDC = `0oay3hbmshTHtvW4I4x7`**; `0oaw330m1lzLlY4G74x7` was the stale hand-added `OIDC_CLIENT_ID` (deleted 2026-07-14); old ALB app = `0oawidx7szAMhnJcq4x7`.
- Access group: `adaptavist-staff`.
- GitLab MCP config lives in `~/.claude.json` under `mcpServers.gitlab` — correct location; an earlier note pointing at `~/.claude-rd/.claude.json` was wrong/stale.
- Backend tests: `cd backend && npm test` (Jest, **187 passing** as of 2026-07-15 — grows with each fix, check current count before relying on the number). Frontend: `cd frontend && npx vitest run` (**92 passing**) + `npm run build`. FirstHand: `cd ~/code/FirstHand && npx vitest run`.
- Test opportunity used for the E2E run: id `324854ac-90f3-40b5-a9d6-895c4716ba29`, "FirstHand E2E Test Study", linked to FirstHand study `study_5803aa7e-939f-4d3e-ac82-2be4bb13e028` ("Cortex E2E Verification Study"). Safe to leave live or delete — it's real proof-of-work, not throwaway junk.

---

# 2026-07-16 — current state (read this first)

A separate chat session (this account; the 2026-07-15 work above was done on the work API CLI).
It had **no context of the 07-15 work** and initially planned features that already existed —
see "Lesson" below. Nothing was double-built; the redundant plan file was deleted.

## What shipped today

- **FirstHand PR #13** — `feat(storage): S3 provider behind the storage abstraction` — **migration plan
  step 1, OPEN, awaiting Nick's merge.** https://github.com/nickfine/FirstHand/pull/13
  Branch `feat/s3-storage-provider`. Delivered exactly per the plan: exhaustive provider switches
  first (task 0, `force: true` dropped from deleteStoredObject), then `s3` in the enum; streaming
  S3 upload via lib-storage (no `tee()` byte counting), HeadObject size, HeadObject-before-delete;
  mode resolution `FIRSTHAND_STORAGE_MODE` > `FIRSTHAND_S3_BUCKET` > `BLOB_READ_WRITE_TOKEN` >
  filesystem, logged once secret-free (stale blob token cannot silently win);
  `FIRSTHAND_PUBLIC_BASE_URL` used for `media_url` (mixed-content trap); S3 tests run against real
  MinIO in docker, not SDK mocks. Suite now **176 passing / 30 files** (was 163/29). Range support
  explicitly deferred. New S3 keys: `recordings/<sessionId>/<ts>-<uuid>-<name>`.
  **Also fixed along the way:** the Playwright e2e suite was failing on `main` — the test server
  inherited `FIRSTHAND_REVIEWER_OIDC_*` and `DATABASE_URL` from `.env.local`, and OIDC outranks
  password auth, so reviewer sign-in 401ed. `playwright.config.ts` now pins the interfering
  variables to empty strings. e2e green (2/2).
- **FirstHand PR #12** — `fix(api): serve recordings from non-latest session attempts`.
  **MERGED** 2026-07-16, merge commit `ff75c94`. https://github.com/nickfine/FirstHand/pull/12
  (Branch `fix/attempt-media-404` was **not** auto-deleted — GitHub does not by default. Safe to
  delete; its content is on `main`.)
  Recordings from any attempt other than the latest were advertised with a `media_url` that
  **404'd**, so Cortex rendered a player that could never load. Root cause: `getRuntimeAsset`
  resolved the session by id alone, and **attempt 1's physical `session_id` is also the
  `logical_session_id`**, so the lookup returned the latest attempt, which doesn't own the older
  attempt's asset ids. Fixed by searching all attempts of the logical session — which also fixes
  the pre-existing reviewer asset route, same resolver.
  **Filesystem mode only. Production (Postgres) was never broken** — the Postgres repo matches
  `recording_assets` on the concrete `session_id`. The two backends silently disagreed.
  Found by a real E2E run (local FirstHand on :4000, filesystem mode, `session_demo_001` which has
  2 attempts); the unit suite missed it entirely because it **mocks the repository**.
  FirstHand suite now **163 passing / 29 files** (was 160).

## Branch/merge state (verified today)

- FirstHand `main` = **`ff75c94`** (PR #12 merge). Phase 2 (PR #11, `88ed846`) merged before it.
  `feat/asset-media-playback` deleted; **`fix/attempt-media-404` still on the remote**, safe to delete.
- Cortex `main` = `7563f5d` (MR !34 merge). `feat/firsthand-media-playback` deleted (local + remote).
  Local `main` fast-forwarded.
- **Cortex MR !35** (`docs/firsthand-migration-plan`) — the docs commit that first tracked this file.
  https://gitlab.adaptavist.net/cto/AdaptaLabs/-/merge_requests/35
- Both native-session-review phases are live on `main` in both repos.

## FirstHand containment — DECIDED (was "defer")

**Decision: Option B, move to Kubera + S3.** Nick decided this explicitly on 07-16, knowing the
trade-off — that decision supersedes the 07-15 "defer", and is the whole justification.
Fallback stays Option A (Adaptavist-owned Vercel) if DevEx stalls.
**Correction (07-16, caught by cross-session reconciliation):** an earlier version of this note
claimed the deferral's gate ("finish the participant UX work first") closed when phase 2 shipped.
Wrong — phase 2 is the **reviewer's** UX (session review), not the **participant's** journey.
**Nick confirmed (2026-07-16): the participant UX work is STILL OUTSTANDING.** It remains a live
priority alongside the migration — the migration did not replace it. So the open work is now:
(1) participant user-journey/UX tidy-up, (2) the migration plan (Nick's DevEx ask first).
**Urgency is real, not hypothetical:** the 07-15 E2E run captured an actual screen+mic recording
that is sitting in the **personal** Vercel Blob store right now.

- Assessment: `docs/FIRSTHAND-KUBERA-MIGRATION-ASSESSMENT.md` (now carries a warning banner)
- **Construction plan: `docs/FIRSTHAND-KUBERA-MIGRATION-PLAN.md`** — 9 steps, adversarially
  reviewed, ~8.5 eng-days. **This supersedes the assessment where they conflict.**

### ⚠️ The assessment doc is WRONG in three verified places

All three because it describes code that **has never executed**:

1. `storeRecordingObjectInVercelBlob` is **unreachable dead code** — in `vercel_blob` mode the
   browser uploads direct to Blob, so the server-side writer never runs.
2. **Real object keys have no `sessionId`**: `recordings/<ts>-<uuid>-<name>`, chosen client-side
   (`runtime-client.ts:220`). The `recordings/<sessionId>/` layout exists only in that dead branch.
   A prefix-based migration inventory matches **zero real objects**.
3. "Add an `s3` provider, don't refactor the callers" is **unsafe** — the branches aren't
   exhaustive, so `s3` falls through to the filesystem branch, and `deleteStoredObject`'s
   `force: true` would report **successful GDPR erasures that delete nothing**.

Also found: `media_url` infers its origin from `request.url` with no forwarded-header handling
anywhere — behind Kubera's TLS-terminating ALB that mints `http://`, which Cortex's https page
blocks as mixed content. Needs `FIRSTHAND_PUBLIC_BASE_URL`. And presigned S3 upload is
**mandatory** before cutover (the server-upload fallback OOMs a 2Gi pod at 2GB).

### Next action (Nick's — but it no longer blocks the code)

~~**Send DevEx ONE governance question**~~ **SENT AND ANSWERED (Lilly Holden, 2026-07-16):**
deploy to **both** playground and prod clusters — playground for testing, promote to prod. Another
`.kubera/` config file + `environments` list in `.gitlab-ci.yml` (Confluence "Initial setup" Step
3). **No custom `walletRoleARN` needed.** Real participant recordings therefore target
**production** (`<app>.platform.adaptavist.net`, bucket `{app}-production`); playground = test data
only, so the PII question dissolves. **The migration plan is now blocked on nothing** — ~~next action
is simply to start plan step 1 (S3 storage provider) whenever Nick chooses~~ **step 1 is DONE
(FirstHand PR #13, open, awaiting merge — see "What shipped today")**. Next: merge PR #13, then
steps 2 (containerise), 3 (presigned uploads) and 4 (migration script) — S2 is parallel-safe now,
S3/S4 unblock once #13 merges.

**MAJOR CORRECTION 2026-07-16 (verified against chart source):** the earlier "three-item DevEx ask"
(S3 bucket + IRSA + Okta app registration) was **wrong**. Checked against
`cloud-native-platform/devex/devex-helm-charts` → `charts/application-chart/values.yaml` and DevEx's
"S3 bucket" Confluence page:
- **S3 is self-serve chart config** — `s3.enabled: true` + `policies.readAndWrite: true` in
  `.kubera/<env>.yaml`. Bucket auto-named `{app}-{env}`, region us-east-1 (= cluster region),
  private + encrypted by default.
- **IRSA is automatic** — `irsa.enabled: true` is the chart default. Nothing to provision.
- **Okta is self-serve** — `auth.okta_app.customRedirectUris` in the manifest.
So the DevEx ask collapses from three provisioning requests to one governance question. Sending the
old ask would have told the platform owner (Lilly) her chart lacks a feature it's shipped for ~4
months. **This is the FIFTH time today the "assert from apparent structure, not the source" failure
bit us** — the S3 claim was inferred from Cortex's manifest (which stores no blobs). Nick caught it.
Lesson reinforced: verify against the actual chart/docs, never infer.
**Do not ask about ingress body-size limits** — playground fronts with an ALB, no body cap; the
answer would falsely green-light the OOM-prone server-upload path.
**Steps 1-5 of the plan are all effectively DevEx-independent now.** Only step 6 (cutover) waits on
the PII answer, and only if it's "not playground".

## Doc status (all updated 2026-07-16)

| Doc | State |
|---|---|
| `FIRSTHAND-INTEGRATION-CONTRACT.md` | **Authoritative.** Endpoints 4+5 current; PR #12 fix + attempt-1 collision documented |
| `FIRSTHAND-KUBERA-MIGRATION-PLAN.md` | **Authoritative** for the migration. New today |
| `FIRSTHAND-KUBERA-MIGRATION-ASSESSMENT.md` | Decision updated; **warning banner** — §4 wrong, defer to the plan |
| `FIRSTHAND-RECORDING-PLAYBACK-PHASE2.md` | **HISTORICAL.** Marked shipped; its Options A/B were both wrong (private blobs can't be redirected to) |
| `PLAYGROUND-BACKEND-INGRESS-PROBLEM.md` | Historical, unchanged |

**All five of these + this file are now TRACKED in git** (Cortex MR !35, 2026-07-16) — 1,452 lines
that previously existed only on one machine, which is how the two parallel sessions diverged.
Both sessions now share one source of truth. **Keep it that way: commit changes to this file rather
than leaving them in the working tree.**

## Lesson (the reason this section exists)

This session spent significant effort planning phase 1 + phase 2 features **that were already
built and merged**, because it had no context of the 07-15 work and an Explore sub-agent reported
the codebase as "greenfield" — which was flatly wrong. The git log was visible from the first
message and would have caught it in seconds.
**Check `git log` and this file before planning anything FirstHand-related.** And note the same
trap bit the code twice today: mocked tests hid the attempt-resolution bug, and the assessment's
dead-code reading produced three wrong claims. **Verify against a real run or a real key, not
against the code's apparent structure.**
