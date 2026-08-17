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
5. [x] **RDS backups declared** – `database.postgresql.rds.backupRetentionPeriod: 14` is set in `.kubera/playground-backend.yaml` rather than left to the chart default. See [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md).
6. [ ] **RDS backups applied** – Confirm the running instance actually reports `BackupRetentionPeriod: 14`. Declared is not applied: Helm ignores unrecognised values keys silently, so a wrong key name would leave retention at the default while the line above still reads as done. Needs AWS RDS read access.
7. [x] **RDS deletion protection declared** – `database.postgresql.rds.deletionProtection: true` is set in `.kubera/playground-backend.yaml`, matching FirstHand's own production manifest. See [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md).
8. [ ] **RDS deletion protection applied** – Confirm the running instance actually reports `DeletionProtection: true`. Same declared-vs-applied caveat as retention. Needs AWS RDS read access.
9. [x] **RDS Multi-AZ declared** – `database.postgresql.rds.multiAz: true` is set in `.kubera/playground-backend.yaml`, matching the chart reference recorded in [docs/FIRSTHAND-KUBERA-MIGRATION-PLAN.md](FIRSTHAND-KUBERA-MIGRATION-PLAN.md) and FirstHand's own production manifest. Availability, not backup – see [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md).
10. [ ] **RDS Multi-AZ applied** – Confirm the running instance actually reports `MultiAZ: true`. Same declared-vs-applied caveat as retention. Read `PendingModifiedValues` and `DBInstanceStatus` in the same call and follow the four-state rule in [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) before concluding anything: a `false` reading is only evidence of a wrong key name once the deploy has demonstrably reconciled, and reading inside the 15–30 minute ArgoCD lag will mislead you. Needs AWS RDS read access.

## Environment and config

- [ ] **Config vs secrets split** – Non-secret env in `.kubera/playground-backend.yaml` `config.data`; secrets in the Kubera secret store. Changing either requires a redeploy (push to trigger a pipeline) for the pod to pick it up.
- [ ] **DB_URL** – Chart-injected from the provisioned RDS instance; never hardcoded in the repo.
- [ ] **CORS_ORIGIN** – Matches the production frontend URL (`https://adaptalabs.kubera-playground.adaptavist.net`).

## Security

- [x] **Auth rate limiting** – Auth routes use an `express-rate-limit` limiter (`authLimiter` in `backend/src/index.ts`, configured from `RATE_LIMITS`); demo login routes are skipped in development only.
- [x] **Per-user rate limiting on the participant and results routes** – Both session-mint routes (`/:id/recorded-study-session`, `/:id/survey-session`) at **20/minute**, and both results reads (`/:id/survey-results`, `.csv`) sharing **60/minute**, in `backend/src/routes/opportunities.ts`.
  **Keyed on `req.user.id`, not on `req.ip`, and that is the point.** Behind two proxy hops `trust proxy: 1` resolves `req.ip` to the ingress, so an IP-keyed bucket is shared by every external caller — which is why the anonymous limiters here (`recordedStudyBriefLimiter`, `healthLimiter`) sit at 600, generous enough that one participant cannot 429 the estate. These four routes all run after `requireAuth`/`requireAdmin`, so the session's user id is a genuine per-caller key that no proxy collapses and no header spoofs, and the ceiling can be tight enough to matter.
  **Mounted after the auth middleware, deliberately.** Mounted before, an unauthenticated flood would fill the bucket and lock out the real caller; pinned by a test that fires 70 unauthenticated requests and then shows the authenticated caller unaffected.
  The two results routes share one bucket on purpose: they read the same rows off the same pool, so separate ceilings would double the exposure the limit exists to cap.
  Proved by execution against the local stack, not by reading: request 61 to the results read answers 429 with `RateLimit-Remaining: 0`, the CSV export immediately after it also 429s, a **different** researcher is unaffected (they get their usual 403, not a 429), request 21 to the mint route 429s, and 60 concurrent mints in 108 ms created **no** new session rows.
  **Known and accepted:** the counter store is in-process, so with more than one backend pod the effective ceiling is the limit times the pod count and a caller can be balanced onto a fresh bucket. These are backstops against runaway loops, not quotas.
- [x] **CSRF protection** – Double-submit cookie via `csrf-csrf`; on by default under `NODE_ENV=production`. Tokens are issued by `GET /api/csrf-token` and echoed in the `x-csrf-token` header on mutating requests. `ENABLE_CSRF=false` disables it in an emergency.
- [x] **Session cookies** – `httpOnly`, `secure` and `sameSite: strict` under `NODE_ENV=production` (`backend/src/index.ts`).
- [x] **Security headers** – Served by nginx in the frontend image, see [frontend/nginx.conf](../frontend/nginx.conf): X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy. CSP is optional (report-only first if added later). Permissions-Policy is not currently set.
- [x] **Ownership gating on participant data** – No route returning participants' own answers, events or recordings is satisfied by `requireAdmin` alone.
  Recording playback and transcripts (`backend/src/routes/session-outputs.ts`), per-session events (`GET /api/opportunities/:id/session-events`) and pending approvals all require the **opportunity owner** or a superadmin.
  Survey results are read per opportunity (`GET /api/opportunities/:id/survey-results` and `.../survey-results.csv`) and require the **opportunity owner** or a superadmin; the study-wide pair (`GET /api/firsthand/studies/:studyId/results` and `.../results.csv`, via `mayReadStudyResults`) requires a **superadmin**, because it spans every opportunity that reused the study.
  The survey results pair was the last gap: before 7.36.0 any `researcher_admin` could read and CSV-export another researcher's participants' answers, and that was reachable in practice, because `participant_responses` is populated today by the recorded-session runtime rather than waiting on native surveys.
  Study *copy* is deliberately readable by every admin (an opportunity may reuse a study it did not author) - the boundary is participant data, so gate new routes accordingly.
- [x] **Survey results are scoped to the opportunity (phase 4e, the last outstanding piece)** – A researcher reads the answers their own opportunity collected, and only those.
  `GET /api/opportunities/:id/survey-results` and `.../survey-results.csv` are gated on the **opportunity owner or a superadmin**, exactly like `GET /api/opportunities/:id/session-events`, and the refusal is answered before any response is read. They are reached from a **Responses** tab on `/admin/opportunities/:id/analytics`, which finally gives the `SurveyResults` component built in phase 3 a route.
  The study-wide pair (`GET /api/firsthand/studies/:studyId/results` and `.../results.csv`) **stays superadmin-only**, and that is the intended end state rather than a leftover: those routes aggregate a study across **every opportunity that used it**, and reusing a study you did not author is a designed feature, so the study's owner would otherwise be handed answers from participants another researcher recruited under that researcher's consent wording.
  The filter is `study_id AND opportunity_id`, on the id **Postgres parsed** rather than the raw path segment - `opportunities.id` is `uuid` and `runtime_sessions.opportunity_id` is TEXT, so a URL written with different casing or braces would otherwise return an empty result rather than a refusal.
  Sessions minted before 7.37.0 have a NULL `opportunity_id` and are excluded by that equality, so they stay readable only through the superadmin route. **Not backfilled by heuristic**: migration `0007` attributed studies to the earliest referencing opportunity and documents that it can be wrong, and mis-attributing participants' answers is a worse error than mis-attributing a study.
  Proved by execution against the local stack, not by reading: a plain `researcher_admin` who does not own the opportunity gets a 403 carrying `application/json` and **no `Content-Disposition`**; the owner gets 3 respondents at a mean of 4.3; and a NULL-opportunity session added to the same study moved the study-wide read to 4 respondents at 3.5 while the per-opportunity read stayed at 3 and 4.3.
- [x] **Native poll and survey are reachable end to end (phases 4a-4d, releases 7.37.0 to 7.39.0 plus 4d)** – A researcher chooses "Where participants answer" on a poll or survey; native delivery collects the questions on the form and a participant answers them at `/survey/:token`.
  The guards that matter, each proved by execution rather than by reading: the mint route requires BOTH `delivery_mode = 'native'` AND a survey-kind study AND that study being `launched`, re-checked at mint rather than trusted from link time (the studies API accepts a client-supplied id, so a study can be planted at a dangling id or replaced at the same one); a study's steps must match the vocabulary its `kind` declares, at create from the payload and at update from the stored kind inside the row lock; and minting is idempotent per participant per opportunity, because every mint is a row the results count as a respondent and unlimited minting was demonstrated to move a rating question from 3 respondents to 6.
- [x] **Survey answers survive the write path, and only answers the UI could produce are accepted** – The runtime mutation boundary parses `responsePayload` strictly against the shared `surveyAnswerSchema` (an unknown key is a 422, never silently stripped - the pre-fix behaviour discarded every `multi_choice`, `rating` and `nps` answer as `{}`), and `POST /:token/runtime` revalidates a response server-side with the same shared rules the participant UI uses: the stepId must exist in the session, the stepType must agree with it, options must have been offered, scores must be on the scale.
- [ ] **Native poll and survey deferrals (recorded 2026-08-17, phases 4a-4d security reviews)** – Found by the gates, judged not to block the phase they were found in:
  - ~~**No rate limit on either participant session-mint route**~~ **Fixed** — see *Per-user rate limiting* below. **Opportunity WRITE routes are still unlimited**, and each `inline_survey` write inserts a study plus up to 51 step rows on the 5-connection FirstHand runtime pool shared with live participant sessions. That half of this item stands.
  - **A survey token drives recorded-runtime machinery.** A survey session is an ordinary runtime session, so nothing narrows what its token can do: it can set recording state and reach the recording upload routes, which in the deployed environment means a presigned S3 PUT, an asset row and a transcript job. Bounded to the participant's own session, so this is storage and compute plus a session record claiming a recording on a survey - not a data breach. Wants the study kind carried on the session payload and checked at those routes.
  - ~~**`SurveyRunner` sends no `link_opened` or `session_started`**~~ **Fixed for the half that was real.** `SurveyRunner` now emits `session_started` when the participant agrees and the questions appear, so the funnel records a start. `link_opened` was never missing and was never the runner's job: the server emits it when it seeds the session row (`source: "server_seed"`), and it is a runtime status rather than an analytics event - `resolveLifecycleEvent` returns null for it, so it never reaches `opportunity_session_events` from any path. Verified against the local stack: the funnel went from **no rows at all** to one `session_started`, and re-firing it three times (a refresh returns to the consent gate, and this runner keeps no local state) left it at one row, because the write is `ON CONFLICT (firsthand_session_id, event_type) DO NOTHING` backed by `uq_session_event_dedup`.
  - **The two mint routes are ~115 lines of near-duplicate.** The route separation is right - one mints screen and microphone capture, the other records nothing - but the shared shape wants a `mintParticipantSession` helper. The security rationale for id canonicalisation has already drifted between the two copies.
  - **A linked survey study survives a switch to external delivery.** No participant-facing impact: the mint route requires both native delivery and a survey-kind study.
  - ~~**`/dev/survey-preview` and its `VITE_SURVEY_PREVIEW` flag are dead**~~ **Removed.** The harness existed to preview the runner and the results view before either had a route; both now have one (`/survey/:token` and the Responses tab), so its own docblock's condition for deletion was met. Gone along with its three CSS rules and the stale comments that pointed at it.
- [x] **A CSV export survives a title Node cannot put in a header** – A study title containing a non-latin1 character (a curly apostrophe pasted from Word is enough) made `res.setHeader('Content-Disposition', ...)` **throw**, so that study's export 500d until somebody guessed the title was at fault. Both exports now build the header through `toCsvContentDisposition`: the quoted `filename` is reduced to ASCII as the fallback and the real title is carried in RFC 5987 `filename*=UTF-8''...`. Fixed in 4e rather than deferred again, because the new per-opportunity export would otherwise have been a second copy of the same 500.
- [ ] **Phase 4e gate deferrals (recorded 2026-08-17, code review + security review, both at Opus)** – Raised against the per-opportunity results routes, judged not to block them. Neither gate found a CRITICAL, and the security gate could not break the authorisation boundary: it proved all four design constraints by mutation and by live queries against the database.
  - ~~**No rate limit on either results route**~~ **Fixed** — see *Per-user rate limiting* below. **No `LIMIT` on the projection** still stands: `listResponsesForOpportunity` returns every answer the opportunity collected in one query, so a study with many thousands of responses is a single large read on the 5-connection pool. The limiter caps how often that happens, not how big it is.
  - **Answers are re-identifiable by the opportunity owner. The copy that implied otherwise is gone.** The results projection carries `session_id` (it is also the CSV's Participant column), and `GET /api/opportunities/:id/session-events` — same owner gate — carries `firsthand_session_id` beside `participant_name` and `participant_email`, so the join from an answer to a named employee is exact. The owner is entitled to both sets, so this is not a leak; the problem was that two pieces of participant-facing demo copy promised anonymity we do not provide. **Decision taken 2026-08-17: drop the word.** Removed from `backend/src/db/reset-demo-data.ts` ("Your anonymous responses") and from `backend/scripts/seed-local-ux.sql` ("Anonymous. Results go to the platform team"), with a note at each site saying why, because this is the kind of phrase that gets written again. Cortex still makes no anonymity claim anywhere. If real anonymity is ever wanted it is a **salted per-opportunity digest** of the session id in the results projection, not a wording change.
  - **A non-UUID `:id` answers 500 rather than 404**, because `opportunities.id` is `uuid` and Postgres raises `22P02`. Pre-existing pattern shared with `/:id/session-events`; noise, not an oracle — `GET /api/opportunities` already lists every opportunity to any admin.
  - **The two results routes answer four different envelopes for one logical resource.** The study-wide pair returns `{ study: { id, title }, results }` with hand-rolled `403 {error:'forbidden'}` / `404 {error:'not_found'}` bodies; the per-opportunity pair returns `{ title, results }` and throws `NotFoundError`/`ForbiddenError` through `errorHandler`. Nothing consumes the study-wide envelope from the frontend today, which is exactly what the two mint routes looked like before their rationale drifted. Aligning it is a contract change to a live route and was left out of 4e deliberately.
  - **The results heading can disagree with the page heading.** The route returns the *study's* title and the analytics page header shows the *opportunity's*. They are equal for an inline-authored survey (the study title is copied from the opportunity) and can differ for a reused study. Left as-is because the study title is the more informative of the two when they differ, and the layout could not be judged locally (the browser pane reports a 0x0 viewport).
- [ ] **Survey runtime deferrals (low, recorded 2026-08-17 security review)** – Two known-and-accepted gaps on the survey runtime, neither reachable as an attack on another user's data:
  - No rate limiting on `/api/firsthand/session/*`, and each runtime POST deletes and reinserts the session's full event/response/asset set, so a looping participant makes their own writes progressively more expensive. Wants a per-user limiter, a cap on retained events per session and an incremental upsert.
  - Answers stay rewritable after `session_completed` with no history: the prior value is deleted, not superseded, so a results view read twice can differ with nothing recording the change. Refuse response mutations once the session status is terminal, or version the rows.

## Database TLS verification

The backend connects to RDS over TLS but does **not** verify the server's
certificate until this is switched on. Until then, anything able to answer as
the database can read the credentials on that connection and alter what it
returns.

The code for verification is shipped and tested; only the switch is off. The AWS
RDS trust store is committed at `backend/certs/rds-global-bundle.pem` and copied
into the image, so **no cluster or AWS access is needed** - the RDS roots are
private and self-signed, so Node cannot verify RDS without them.

- [x] **Enable verification** - `DB_TLS_VERIFY: "1"` is set in `.kubera/playground-backend.yaml`
      `config.data`. It is not a secret.
- [ ] **If `DB_URL` reaches the pod as a bare single-label hostname**, verification
      will refuse to treat it as local and will try to verify it. That is
      deliberate - a name resolved through a DNS search suffix is a remote host -
      but if it genuinely is a plaintext in-cluster database, name it in
      `DB_TLS_LOCAL_HOSTS` (comma-separated) rather than turning verification off.
- [ ] **Confirm from the pod log**, which is the evidence that matters. Every
      pool logs one line at startup, prefixed `[db-tls:<pool>]`:
      - `verified TLS to <host> against <path>` - working.
      - `UNVERIFIED TLS to <host> ...` - the variable did not reach the pod.
      - `local host (<host>); no TLS` - the resolver thinks the database is
        local. On the deployment that would be wrong; check `DB_URL`.
      - `<host> is exempted from verification by DB_TLS_LOCAL_HOSTS` - warned,
        not informational: verification is on but this host was deliberately
        excluded from it, so that connection has no TLS at all.
      Expect one line each for `backend`, `firsthand-runtime` and
      `firsthand-migrate` (the last from the initContainer).

**The residual risk is hostname verification**, and nothing in this repo can
rule it out: `rejectUnauthorized: true` makes Node check the certificate's SAN
against the host in `DB_URL`, so a CNAME, a private alias, an RDS Proxy under a
custom name or a bare IP would fail the handshake even though the CA is correct.
If you have cluster access, the cheap way to settle it before anything
long-lived depends on it is a one-off Job on the same image that does nothing
but connect with `DB_TLS_VERIFY=1` - proving the handshake rather than flipping
the switch and watching. Neither Nick nor this repo's CI has that access today,
which is why the procedure below is "flip and read the log" instead.

**Why it is not on by default.** Turning it on decides whether the application
can reach its database at all: a certificate that fails to verify fails at
connect time, and the same code runs in the deploy initContainer, so a bad
outcome CrashLoops the pod rather than degrading quietly. That cannot be tested
from outside the cluster. Rolling back is unsetting the variable and
redeploying - no code change.

**Expected to work**, on this reasoning: the initContainer succeeds on every
rollout today, and its previous code only enabled TLS for a host ending
`.rds.amazonaws.com` with no `sslmode` in the URL. Since pg does not negotiate
TLS on its own and RDS forces it, `DB_URL` must already be exactly that shape.

If it does fail, the likely causes in order: the CA bundle missing from the
image (the log names the path it looked for), `DB_URL` reaching the pod as
something other than an RDS hostname, or an `sslmode` having been added to
`DB_URL` - which is now stripped rather than honoured, deliberately, because
the connection string used to be able to override the ssl option and quietly
weaken the connection.

## Reliability and errors

- [x] **Error boundary** – Frontend `App` wrapped in `ErrorBoundary` (`frontend/src/components/ErrorBoundary.tsx`).
- [x] **API logging** – Routes use `logger` (not `console`) for errors.
- [x] **Health check** – The backend serves `GET /health` (used by the Kubera liveness/readiness probes on port 3001); the frontend serves its own `/health` probe. These are internal probes, not a public JSON status page.
- [x] **DB connectivity** – After deploy, verify `GET /api/opportunities` returns 200 (confirms DB + env through the nginx proxy).
- [x] **RDS Multi-AZ declared** – `multiAz: true` in `.kubera/playground-backend.yaml`: a synchronous standby in a second AZ with automatic failover. Change it there, not in the AWS console, to avoid manifest/instance drift – it is the likeliest of the three to get toggled off to trim spend. Listed here rather than under Data and backups because it is an availability control, not a backup – it replicates mistakes as faithfully as it replicates good writes. See [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md).
- [ ] **RDS Multi-AZ applied** – Unverified: confirming the live instance reports `MultiAZ: true` needs AWS RDS read access.

## Data and backups

- [x] **RDS backups declared** – Retention is declared as 14 days in `.kubera/playground-backend.yaml`; see [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md). Change it there, not in the AWS console, to avoid manifest/instance drift.
- [ ] **RDS backups applied** – Unverified: confirming the live instance reports 14 needs AWS RDS read access.
- [x] **RDS deletion protection declared** – `deletionProtection: true` in `.kubera/playground-backend.yaml`. Change it there, not in the AWS console, to avoid manifest/instance drift. Deleting the instance deliberately means flipping the flag off in the manifest first.
- [ ] **RDS deletion protection applied** – Unverified: confirming the live instance reports it needs AWS RDS read access.
- [x] **Migrations** – Run automatically on every deploy by the backend init container (`npm run migrate && npm run seed && npm run migrate:firsthand` against `DB_URL`); idempotent and checksum-guarded. There is no manual `run-migrations` endpoint.

## Performance and monitoring

- [ ] **Cluster metrics** – Optional. Use the Kubera/cluster observability stack for request and resource metrics.
- [ ] **Logs** – Backend and frontend pod logs in the cluster (via Kubera or `kubectl logs`) are the source for errors and request logs.
- [x] **Load testing** – k6 script in `load-test/api-smoke.js`; see [TESTING_GUIDE.md](../TESTING_GUIDE.md#load-testing).

## Accessibility (M8)

- [x] **WCAG 2.2 AA** – Contrast fixes (CTA, power button, Settings tab), heading order, page h1s. See `e2e/accessibility.test.ts`.
- [ ] **Re-run a11y tests** – After deploy run `npm run test:a11y:prod`. Uses the production URL and Chromium; use `load` not `networkidle` for production. Note the host is Okta-gated, so anonymous flows redirect to login rather than passing cleanly.

## Residual decommission hygiene

- [ ] **Delete the inert `FIRSTHAND_DATABASE_URL` entry from the backend secret store** - nothing reads it since the Phase C cutover, and the host it names was decommissioned on 2026-08-11 (see [FIRSTHAND-PHASE-C-ROLLBACK.md](FIRSTHAND-PHASE-C-ROLLBACK.md)). AWS-side action; requires AWS access.

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
