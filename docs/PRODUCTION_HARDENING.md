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
- [x] **CSRF protection** – Double-submit cookie via `csrf-csrf`; on by default under `NODE_ENV=production`. Tokens are issued by `GET /api/csrf-token` and echoed in the `x-csrf-token` header on mutating requests. `ENABLE_CSRF=false` disables it in an emergency.
- [x] **Session cookies** – `httpOnly`, `secure` and `sameSite: strict` under `NODE_ENV=production` (`backend/src/index.ts`).
- [x] **Security headers** – Served by nginx in the frontend image, see [frontend/nginx.conf](../frontend/nginx.conf): X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy. CSP is optional (report-only first if added later). Permissions-Policy is not currently set.
- [x] **Ownership gating on participant data** – No route returning participants' own answers, events or recordings is satisfied by `requireAdmin` alone.
  Recording playback and transcripts (`backend/src/routes/session-outputs.ts`), per-session events (`GET /api/opportunities/:id/session-events`) and pending approvals all require the **opportunity owner** or a superadmin.
  Survey results (`GET /api/firsthand/studies/:studyId/results` and `.../results.csv`, via `mayReadStudyResults`) require a **superadmin**.
  The survey results pair was the last gap: before 7.36.0 any `researcher_admin` could read and CSV-export another researcher's participants' answers, and that was reachable in practice, because `participant_responses` is populated today by the recorded-session runtime rather than waiting on native surveys.
  Study *copy* is deliberately readable by every admin (an opportunity may reuse a study it did not author) - the boundary is participant data, so gate new routes accordingly.
- [ ] **Scope survey results to an opportunity (phase 4)** – Superadmin-only is an interim position, not the intended model.
  These routes aggregate every response for a study across **every opportunity that used it**, and a study is reusable by an opportunity its author did not create, so granting the study's owner would hand them answers from participants another researcher recruited.
  Opportunity ownership is the right model and is what the surfaces above already use, but it is not implementable yet: `firsthand.runtime_sessions` records `study_id` and **no `opportunity_id`**, so a response cannot be attributed to an opportunity at all.
  The work: a migration adding `opportunity_id` (nullable, indexed), populating it where a session is created from an opportunity (`POST /api/opportunities/:id/recorded-study-session`), then per-opportunity routes gated exactly like `/:id/session-events`.
  Leave pre-existing rows with a `NULL` opportunity as superadmin-only rather than backfilling by heuristic - migration `0007` did attribute studies to the earliest referencing opportunity and documents that it can be wrong, and mis-attributing participants' answers is a worse error than mis-attributing a study.
  Nothing is blocked meanwhile: the results view is mounted only under `VITE_SURVEY_PREVIEW` and is absent from every real build.
- [x] **Survey answers survive the write path, and only answers the UI could produce are accepted** – The runtime mutation boundary parses `responsePayload` strictly against the shared `surveyAnswerSchema` (an unknown key is a 422, never silently stripped - the pre-fix behaviour discarded every `multi_choice`, `rating` and `nps` answer as `{}`), and `POST /:token/runtime` revalidates a response server-side with the same shared rules the participant UI uses: the stepId must exist in the session, the stepType must agree with it, options must have been offered, scores must be on the scale.
- [ ] **Survey runtime deferrals (low, recorded 2026-08-17 security review)** – Three known-and-accepted gaps on the survey runtime, none reachable as an attack on another user's data:
  - A study title containing a non-latin1 character (a curly apostrophe pasted from Word is enough) makes `res.setHeader('Content-Disposition', ...)` throw, so that study's CSV export 500s until the title is edited. Fix is RFC 5987 `filename*=UTF-8''...` encoding in `backend/src/routes/firsthand.ts`.
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
