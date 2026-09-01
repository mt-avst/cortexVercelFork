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
6. [ ] ⛔ BLOCKED (needs AWS RDS read access, which Nick does not have) **RDS backups applied** – Confirm the running instance actually reports `BackupRetentionPeriod: 14`. Declared is not applied: Helm ignores unrecognised values keys silently, so a wrong key name would leave retention at the default while the line above still reads as done. Needs AWS RDS read access.
7. [x] **RDS deletion protection declared** – `database.postgresql.rds.deletionProtection: true` is set in `.kubera/playground-backend.yaml`, matching FirstHand's own production manifest. See [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md).
8. [ ] ⛔ BLOCKED (needs AWS RDS read access, which Nick does not have) **RDS deletion protection applied** – Confirm the running instance actually reports `DeletionProtection: true`. Same declared-vs-applied caveat as retention. Needs AWS RDS read access.
9. [x] **RDS Multi-AZ declared** – `database.postgresql.rds.multiAz: true` is set in `.kubera/playground-backend.yaml`, matching the chart reference recorded in [docs/FIRSTHAND-KUBERA-MIGRATION-PLAN.md](FIRSTHAND-KUBERA-MIGRATION-PLAN.md) and FirstHand's own production manifest. Availability, not backup – see [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md).
10. [ ] ⛔ BLOCKED (needs AWS RDS read access, which Nick does not have) **RDS Multi-AZ applied** – Confirm the running instance actually reports `MultiAZ: true`. Same declared-vs-applied caveat as retention. Read `PendingModifiedValues` and `DBInstanceStatus` in the same call and follow the four-state rule in [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) before concluding anything: a `false` reading is only evidence of a wrong key name once the deploy has demonstrably reconciled, and reading inside the 15–30 minute ArgoCD lag will mislead you. Needs AWS RDS read access.

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
- [x] **OAuth callbacks bind `state` to the initiating browser (login CSRF closed, #82)** – Both OAuth callbacks (`GET /auth/callback` OIDC/Okta and `GET /auth/google-callback`) previously validated `state` only against a process-global `stateStore` Map that any caller of `/login` or `/google-login` could populate, so an attacker could mint a valid state, capture their own `code`, and lure a victim to the callback — logging the victim into the **attacker's** identity (login CSRF / session fixation), demonstrated end to end. Fixed by binding the state to a dedicated `__Host-adaptalabs_oauth_state` cookie set on the initiating browser (the `__Host-` prefix arrived later with #94, below) (`issueOAuthState`/`consumeOAuthState` in `backend/src/routes/auth.ts`): a victim who never began a login carries no such cookie. It is a **separate** cookie because the session cookie above is `SameSite=Strict` and cannot ride the cross-site provider callback; the state cookie is `SameSite=Lax`, `httpOnly`, `secure` (unconditionally, see the `__Host-` entry below), `path=/`. `cookie-parser` is now mounted unconditionally so the callback can read it. **Kubera-verified 2026-08-27:** a real Okta login still completes, so the Lax cookie rides the callback in production. Also: the OIDC `/callback` now runs `validateQuery(oauthCallbackQuerySchema)` (refuses an array `code`/`state` shape before the token exchange, #84), and the dead calendar-callback state check was removed (#83, with follow-up #87 to delete that orphaned route). Reviewed by two independent Opus refute-gates per fix.
- [x] **OAuth state cookies carry a `__Host-` prefix, so a sibling subdomain cannot toss one in (#94)** – Since !299 the calendar callback takes its `userId` from the state's **server-side payload** rather than from the session, which makes the state cookie the sole authenticator. A host-only cookie is not sole-authority material: XSS on the origin, or **any** `*.adaptavist.net` host setting `Domain=.adaptavist.net`, could plant a state, after which a victim completing consent would have **their** Google refresh token (`calendar.readonly` + `userinfo.email`) stored against the **attacker's** `user_calendar_tokens` row and readable via `GET /api/calendar/my-events`. Closed by renaming both guard cookies to `__Host-adaptalabs_oauth_state` and `__Host-adaptalabs_calendar_oauth_state`: browsers accept a `__Host-` cookie only with `Secure`, `Path=/` and **no** `Domain`, and it is the absent `Domain` that makes the **sibling-subdomain** toss structurally impossible rather than merely unlikely. The prefix is applied inside `createOAuthStateGuard` (`backend/src/utils/oauthState.ts`) rather than by each call site, and a pre-prefixed name is refused at construction, so a third OAuth flow cannot silently opt out. **`secure` is now unconditional**, not `NODE_ENV === 'production'` - a `__Host-` cookie without `Secure` is refused outright, so the two are one change. **Measured, not assumed:** the prior code comment claimed hardcoding `secure` "would break every developer's http://localhost flow"; probed in Chrome/Chromium against a local HTTP server, a `Secure` `__Host-` cookie **is** accepted over `http://localhost` (a trustworthy origin), while the same cookie with a `Domain`, with `Path=/sub`, or without `Secure` was refused in all three cases, and a bare-named `Secure` control was accepted so those refusals are the prefix rules rather than `Secure`-over-http. One engine only, and `localhost` only - a non-localhost http dev origin now gets no cookie and a flow that cannot complete, which is fail-closed and loud. **Exposure, corrected:** the first version of this entry called the whole thing latent. That is true of the **calendar** half only, which cannot fire until Google OAuth credentials are provisioned. The **login** half was live: `__Host-adaptalabs_oauth_state` backs the Okta/OIDC flow recorded as Kubera-verified above (that verification ran against the **bare** name, so a real Okta login is the one post-deploy check worth doing by hand - this branch renames a cookie the live login depends on), `/auth/login` issues it and `/auth/callback` consumes it before minting a session, and none of that touches Google. A tossed cookie there reopened #82's login CSRF directly, in production. **What this closes and what it does not:** the sibling-subdomain vector is shut, because `__Host-` forbids `Domain` outright. **XSS on the origin is not** - the prefix says nothing about `HttpOnly`, so same-origin script can still write a `__Host-` cookie and run the same flow (measured). That residual belongs to whatever control stops the XSS, not to this one. Adjacent and still open: `adaptalabs_session` and `adaptalabs_csrf` carry no prefix and are tossable by the same mechanism - **cto/AdaptaLabs#97**, deferred rather than folded in because the session cookie sets `domain: 'localhost'` in development (`index.ts:137`), which `__Host-` forbids, so it needs its own decision and its own measurement. Not a takeover: `req.session.regenerate()` on both login paths mitigates the fixation, leaving persistent shadowing of the post-login cookie.
- [x] **One admin can no longer occupy the only results-read permit (availability, #9)** – A `researcher_admin` staying inside the rate limits could hold the single `MAX_CONCURRENT_RESULTS_READS = 1` permit indefinitely and refuse another admin 86–93% of their results reads (measured). Closed on all four results routes by releasing the permit before the client-paced phase: CSV routes at the preflight-to-stream boundary (!260), aggregate routes right before `res.json` (!292/#85) once the body was bounded (`MAX_AGGREGATE_RESPONSE_CHARS`, !288/#51), with a per-caller in-flight limit (`MAX_IN_FLIGHT_RESULTS_READS_PER_USER = 2`) bounding queue depth. Re-measured with `backend/probe/occupancy.ts` (interleaved, null control): aggregate victim success **0.00 → 1.00**.
- [x] **Security headers** – Served by nginx in the frontend image, see [frontend/nginx.conf](../frontend/nginx.conf): X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy. CSP is optional (report-only first if added later). Permissions-Policy is not currently set.
- [x] **Ownership gating on participant data** – No route returning participants' own answers, events or recordings is satisfied by `requireAdmin` alone.
  Recording playback and transcripts (`backend/src/routes/session-outputs.ts`), per-session events (`GET /api/opportunities/:id/session-events`) and pending approvals all require the **opportunity owner** or a superadmin.
  Survey results are read per opportunity (`GET /api/opportunities/:id/survey-results` and `.../survey-results.csv`) and require the **opportunity owner** or a superadmin; the study-wide pair (`GET /api/firsthand/studies/:studyId/results` and `.../results.csv`, via `mayReadStudyResults`) requires a **superadmin**, because it spans every opportunity that reused the study. (Reuse-by-link is gone as of B3, `!179`, released **7.45.0**, but the route stays superadmin-only: the rows it aggregates predate the change, and migration `0012` moved a converted opportunity's sessions to its copy, so a study-wide read can legitimately return fewer respondents than it did before.)
  The survey results pair was the last gap: before 7.36.0 any `researcher_admin` could read and CSV-export another researcher's participants' answers, and that was reachable in practice, because `participant_responses` is populated today by the recorded-session runtime rather than waiting on native surveys.
  Study *copy* is deliberately readable by every admin - the boundary is participant data, so gate new routes accordingly.
  **Updated by B3 (`!179`, 7.45.0).** The reason used to be "an opportunity may reuse a study it did not author". Reuse-by-link is gone: choosing an existing study now takes a COPY, and `PATCH`/`POST` refuse a `firsthand_study_id` owned by somebody else (`assertLinkedStudyKindMatches`, gated on the link actually changing so an unauthorable linked study can still be re-saved). The open READ is unchanged and still deliberate - the copy picker lists every launched study, which is exactly what the old picker did. It was confirmed under B3's security gate that copy grants **no new read capability**: `GET /api/firsthand/studies/:studyId` is `requireAdmin` with no owner check and is byte-identical to its pre-B3 form, and edit-mode hydration already fetched a linked study's full content.
  **Recorded rather than fixed:** `requireAdmin` does not distinguish `researcher_admin` from `superadmin`, so any researcher-admin can read every study in full, including every colleague's `consent_text`, via an unbounded unpaginated list. Pre-existing; B3 does not widen it.
  **Updated by C1 (`!181`, 7.46.0).** C1 governs consent and its security gate answered the WRITING half of the same question, which is the sharper one and is **still open**:
  - `canWriteStudy` (`backend/src/firsthand/studies-repository.ts`) returns true when `owner_user_id IS NULL` — it **fails open** on an unowned study.
  - `consent_text` sits in `updateStudy`'s dynamic push list, so it counts toward `fieldChangeCount`, and `claimsOwnership` adopts an unowned study whenever that count is above zero.
  - **Therefore any `researcher_admin` can rewrite the consent wording of any study with a NULL owner — via `PUT /api/firsthand/studies/:id` or via `PATCH` on an opportunity they own — and doing so transfers ownership to them.** A study that *has* an owner is 403 to everyone but that owner and a superadmin, on every write path.
  - **C1 does not widen it.** A consent edit went from pushing one column to pushing three; the check is `> 0`, so the decision is unchanged for every input. The new fields alone cannot claim a study or write anything: `updateStudy` pushes them only inside `if (input.consent_text !== undefined)`, and `updateStudyRequestSchema` now answers 400 to a classification sent without the wording it describes.
  - **It is now detectable where it was not.** Such an edit records `consent_template_id = 'custom'` against the row, and the Task Lists list and the copy picker both flag it.
  - **The open decision:** the fail-open was justified as protecting legacy authors of pre-ownership rows. Consent is now a governed artefact with a compliance record attached, which changes what is behind that door. The gate's recommendation is to keep failing open for `title`/`intro_text`/`steps` and fail **closed** for `consent_text` on an unowned study — a stranded legacy author is a support ticket, rewritten consent under recording is an incident. That is a product call; it belongs to a later plan step, not to C1.
  - **Adjacent, and also recorded rather than fixed:** `claimsOwnership` counts fields that were *set*, not fields that *changed*, so `PUT {title: <the study's existing title>}` claims an unowned study with no visible diff. The docblock's stated defence — that an attacker cannot loop empty `PUT`s over the study list — holds only for the literal `PUT {}`.
- [x] **Survey results are scoped to the opportunity (phase 4e, the last outstanding piece)** – A researcher reads the answers their own opportunity collected, and only those.
  `GET /api/opportunities/:id/survey-results` and `.../survey-results.csv` are gated on the **opportunity owner or a superadmin**, exactly like `GET /api/opportunities/:id/session-events`, and the refusal is answered before any response is read. They are reached from a **Responses** tab on `/admin/opportunities/:id/analytics`, which finally gives the `SurveyResults` component built in phase 3 a route.
  The study-wide pair (`GET /api/firsthand/studies/:studyId/results` and `.../results.csv`) **stays superadmin-only**, and that is the intended end state rather than a leftover: those routes aggregate a study across **every opportunity that used it**, and reusing a study you did not author is a designed feature, so the study's owner would otherwise be handed answers from participants another researcher recruited under that researcher's consent wording.
  The filter is `study_id AND opportunity_id`, on the id **Postgres parsed** rather than the raw path segment - `opportunities.id` is `uuid` and `runtime_sessions.opportunity_id` is TEXT, so a URL written with different casing or braces would otherwise return an empty result rather than a refusal.
  Sessions minted before 7.37.0 have a NULL `opportunity_id` and are excluded by that equality, so they stay readable only through the superadmin route. **Not backfilled by heuristic**: migration `0007` attributed studies to the earliest referencing opportunity and documents that it can be wrong, and mis-attributing participants' answers is a worse error than mis-attributing a study.
  Proved by execution against the local stack, not by reading: a plain `researcher_admin` who does not own the opportunity gets a 403 carrying `application/json` and **no `Content-Disposition`**; the owner gets 3 respondents at a mean of 4.3; and a NULL-opportunity session added to the same study moved the study-wide read to 4 respondents at 3.5 while the per-opportunity read stayed at 3 and 4.3.
- [x] **Native poll and survey are reachable end to end (phases 4a-4d, releases 7.37.0 to 7.39.0 plus 4d)** – A researcher chooses "Where participants answer" on a poll or survey; native delivery collects the questions on the form and a participant answers them at `/survey/:token`.
  The guards that matter, each proved by execution rather than by reading: the mint route requires BOTH `delivery_mode = 'native'` AND a survey-kind study AND that study being `launched`, re-checked at mint rather than trusted from link time (the studies API accepts a client-supplied id, so a study can be planted at a dangling id or replaced at the same one); a study's steps must match the vocabulary its `kind` declares, at create from the payload and at update from the stored kind inside the row lock; and minting is idempotent per participant per opportunity, because every mint is a row the results count as a respondent and unlimited minting was demonstrated to move a rating question from 3 respondents to 6.
- [x] **Survey answers survive the write path, and only answers the UI could produce are accepted** – The runtime mutation boundary parses `responsePayload` strictly against the shared `surveyAnswerSchema` (an unknown key is a 422, never silently stripped - the pre-fix behaviour discarded every `multi_choice`, `rating` and `nps` answer as `{}`), and `POST /:token/runtime` revalidates a response server-side with the same shared rules the participant UI uses: the stepId must exist in the session, the stepType must agree with it, options must have been offered, scores must be on the scale.
- [x] **Native poll and survey deferrals (recorded 2026-08-17, phases 4a-4d security reviews)** – Found by the gates, judged not to block the phase they were found in:
  - ~~**No rate limit on either participant session-mint route**~~ **Fixed** — see *Per-user rate limiting* below. **Opportunity WRITE routes are still unlimited**, and each `inline_survey` write inserts a study plus up to 51 step rows on the 5-connection FirstHand runtime pool shared with live participant sessions. That half of this item stands.
  - ~~**A survey token drives recorded-runtime machinery**~~ **Fixed.** The session payload now carries the study's `kind`, and a session that says `survey` is refused the three recording upload routes and the `recording_state` runtime mutation (404, before anything is written). Events and responses stay open, because they are what a survey session is for. Snapshotting `kind` is safe where snapshotting steps or status would not be: it is fixed at create and absent from `UpdateStudyInput`, so it cannot drift under a live session. **Residue, deliberately left:** an absent `kind` means "minted before this field existed", not "survey", so those payloads keep today's behaviour rather than having a live recording refused mid-upload. That is a window for sessions that expire, and `isExpired` used to return false when `expires_at` was absent - so a payload of that shape would never have aged out. **Now fixed:** an absent expiry is refused. **Correcting the earlier note here:** it claimed three local rows were such tokens; they are not. Those three have no `session_payload` at all and were already refused as `not_found`, and the query behind the claim could not tell that apart from a payload missing its expiry. No row has the second shape - the defect was real in the code and absent from the data.
  - ~~**`SurveyRunner` sends no `link_opened` or `session_started`**~~ **Fixed for the half that was real.** `SurveyRunner` now emits `session_started` when the participant agrees and the questions appear, so the funnel records a start. `link_opened` was never missing and was never the runner's job: the server emits it when it seeds the session row (`source: "server_seed"`), and it is a runtime status rather than an analytics event - `resolveLifecycleEvent` returns null for it, so it never reaches `opportunity_session_events` from any path. Verified against the local stack: the funnel went from **no rows at all** to one `session_started`, and re-firing it three times (a refresh returns to the consent gate, and this runner keeps no local state) left it at one row, because the write is `ON CONFLICT (firsthand_session_id, event_type) DO NOTHING` backed by `uq_session_event_dedup`.
  - ~~**The two mint routes are ~115 lines of near-duplicate**~~ **Fixed.** `loadMintableOpportunity` and `mintParticipant` now hold the lookup, the id canonicalisation and the `external_ref` rule once each - the canonicalisation expression went from 2 copies to 1 and the duplicated `SELECT` is gone. The route separation is deliberately kept: one mints screen and microphone capture, the other records nothing, and their preconditions genuinely differ. The file got LONGER, because the shared rationale is now one docblock instead of two diverging ones - the drift was the problem, not the length. Original note: The route separation is right - one mints screen and microphone capture, the other records nothing - but the shared shape wants a `mintParticipantSession` helper. The security rationale for id canonicalisation has already drifted between the two copies.
  - **A linked survey study survives a switch to external delivery** - and as of 4e that is **deliberate rather than a gap**: the Responses tab is gated on a linked study, not on delivery mode, because answers already collected are still the researcher's data and gating on the mode lost them the only route to it. The mint route still requires both native delivery and a survey-kind study, so no stale link can run. Original note: No participant-facing impact: the mint route requires both native delivery and a survey-kind study.
  - ~~**`/dev/survey-preview` and its `VITE_SURVEY_PREVIEW` flag are dead**~~ **Removed.** The harness existed to preview the runner and the results view before either had a route; both now have one (`/survey/:token` and the Responses tab), so its own docblock's condition for deletion was met. Gone along with its three CSS rules and the stale comments that pointed at it.
- [x] **A CSV export survives a title Node cannot put in a header** – A study title containing a non-latin1 character (a curly apostrophe pasted from Word is enough) made `res.setHeader('Content-Disposition', ...)` **throw**, so that study's export 500d until somebody guessed the title was at fault. Both exports now build the header through `toCsvContentDisposition`: the quoted `filename` is reduced to ASCII as the fallback and the real title is carried in RFC 5987 `filename*=UTF-8''...`. Fixed in 4e rather than deferred again, because the new per-opportunity export would otherwise have been a second copy of the same 500.
- [x] **Phase 4e gate deferrals (recorded 2026-08-17, code review + security review, both at Opus)** – Raised against the per-opportunity results routes, judged not to block them. Neither gate found a CRITICAL, and the security gate could not break the authorisation boundary: it proved all four design constraints by mutation and by live queries against the database.
  - ~~**No rate limit on either results route**~~ **Fixed** — see *Per-user rate limiting* below. **No `LIMIT` on the projection** still stands: `listResponsesForOpportunity` returns every answer the opportunity collected in one query, so a study with many thousands of responses is a single large read on the 5-connection pool. The limiter caps how often that happens, not how big it is.
  - **Answers are re-identifiable by the opportunity owner. The copy that implied otherwise is gone.** The results projection carries `session_id` (it is also the CSV's Participant column), and `GET /api/opportunities/:id/session-events` — same owner gate — carries `firsthand_session_id` beside `participant_name` and `participant_email`, so the join from an answer to a named employee is exact. The owner is entitled to both sets, so this is not a leak; the problem was that two pieces of participant-facing demo copy promised anonymity we do not provide. **Decision taken 2026-08-17: drop the word.** Removed from `backend/src/db/reset-demo-data.ts` ("Your anonymous responses") and from `backend/scripts/seed-local-ux.sql` ("Anonymous. Results go to the platform team"), with a note at each site saying why, because this is the kind of phrase that gets written again. Cortex still makes no anonymity claim anywhere. If real anonymity is ever wanted it is a **salted per-opportunity digest** of the session id in the results projection, not a wording change.
  - ~~**A non-UUID `:id` answers 500**~~ **Fixed, as a 400.** Postgres raises `22P02` for any unparseable literal, which now maps to `ValidationError` in `mapDatabaseError` - one case covering `GET /:id`, `/:id/analytics`, `/:id/session-events` and both survey-results routes. 400 rather than 404 deliberately: 22P02 can also come from a value this codebase passed itself, and calling that "not found" would hide a real bug. Original note:, because `opportunities.id` is `uuid` and Postgres raises `22P02`. Pre-existing pattern shared with `/:id/session-events`; noise, not an oracle — `GET /api/opportunities` already lists every opportunity to any admin.
  - ~~**The two results routes answer four different envelopes**~~ **Fixed.** Both return `{ title, results }`, and both refuse through `errorHandler`. Original note: The study-wide pair returns `{ study: { id, title }, results }` with hand-rolled `403 {error:'forbidden'}` / `404 {error:'not_found'}` bodies; the per-opportunity pair returns `{ title, results }` and throws `NotFoundError`/`ForbiddenError` through `errorHandler`. Nothing consumes the study-wide envelope from the frontend today, which is exactly what the two mint routes looked like before their rationale drifted. Aligning it is a contract change to a live route and was left out of 4e deliberately.
  - ~~**The results heading can disagree with the page heading**~~ **Fixed.** The results view no longer prints the study's title at all: it heads the section "Responses", and the analytics page's context line names the opportunity, once. Checked against the real data first - every linked study locally shares its opportunity's title exactly, so the old heading was a pure duplicate in every real case and would only have differed on a study reused by another researcher. The heading itself stays rather than being dropped, because the page is `h1` and the questions are `h3` and removing it would skip a level.
- [x] **Survey runtime deferrals (low, recorded 2026-08-17 security review)** – Two known-and-accepted gaps on the survey runtime, neither reachable as an attack on another user's data:
  - ~~No rate limiting on `/api/firsthand/session/*`~~ **Fixed.** All four mutating runtime routes sit at 120/minute per participant, keyed on the session's user id; the two GETs are deliberately unlimited because they write nothing and the participant surface fetches its payload on load. The delete-and-reinsert write shape is unchanged and is still why the ceiling exists. Original note: each runtime POST deletes and reinserts the session's full event/response/asset set, so a looping participant makes their own writes progressively more expensive. Wants a per-user limiter, a cap on retained events per session and an incremental upsert.
  - ~~Answers stay rewritable after `session_completed` with no history~~ **Fixed by refusing, not by versioning.** A response mutation against a session in `completed`, `abandoned` or `failed` is refused with **409**. `uploading` is deliberately excluded: for a survey it does mean finished, but for a recorded session it means the tasks are done and the video is still going up, and refusing writes during it would be a new failure mode on a live recording. Enforced inside `applyRuntimeMutationPostgres`, **after the row is locked `FOR UPDATE`**, not at the route - a route-level check reads the status in a separate statement, so two submissions arriving together would both read "not finished" and both write. Events are still accepted after the end, or the terminal states would be unreachable: `session_completed` is itself an event. Proved end to end: answer stored as 2, session completed, rewrite to 5 refused with 409, stored answer still 2. **Versioning the rows was not done** - the answers remain a single current value per step, so this makes the value final rather than making its history readable.

## Database TLS verification

**This is on, and confirmed applied.** `DB_TLS_VERIFY` shipped in 7.36.3 and the `backend` pool verifies the server's certificate; the reads that establish that are below.
Without verification anything able to answer as the database could read the credentials on that connection and alter what it returns, so the switch is the whole control.

The AWS RDS trust store is committed at `backend/certs/rds-global-bundle.pem` and copied into the image, so **no cluster or AWS access is needed** - the RDS roots are private and self-signed, so Node cannot verify RDS without them.

- [x] **Enable verification** - `DB_TLS_VERIFY: "1"` is set in `.kubera/playground-backend.yaml`
      `config.data`. It is not a secret.
- [ ] **If `DB_URL` reaches the pod as a bare single-label hostname**, verification
      will refuse to treat it as local and will try to verify it. That is
      deliberate - a name resolved through a DNS search suffix is a remote host -
      but if it genuinely is a plaintext in-cluster database, name it in
      `DB_TLS_LOCAL_HOSTS` (comma-separated) rather than turning verification off.
- [x] **Confirm the TLS mode WITHOUT a pod log** - `GET /api/admin/diagnostics/db-tls`, superadmin only, reports what each pool resolved (`disabled` / `unverified` / `verified`).
      Added because the decision was previously observable only on stdout, so nobody without cluster access could confirm it - and `DB_TLS_VERIFY` shipping inert would have looked identical to it working.
      Modes only: `description` names the database host and the CA bundle path and neither is needed.
      Not on `/api/health` - whether a link verifies its certificate tells a stranger whether a man-in-the-middle is worth attempting.
      **The FirstHand runtime pool is built lazily, so it is absent until something uses it; the response says so.**
      The report is per-process in-memory state, so **a deploy resets it**: immediately after a roll it shows `backend` only, and `firsthand-runtime` reappears the first time anything uses it. A short list after a deploy is normal, not a regression.
- [x] **Read against the deployment, 2026-08-18**: both pools report `verified` - `{"pools":{"backend":"verified","firsthand-runtime":"verified"},"allVerified":true}`.
      `DB_TLS_VERIFY` is therefore not inert, and it reaches both pools.
      That matters for `firsthand-runtime` specifically because it takes its URL from `DATABASE_URL`, then `POSTGRES_URL`, then `DB_URL`, rather than `DB_URL` alone - a different URL in the pod would have been a different host, and this is the declared-vs-applied gap the endpoint exists to close.
      `firsthand-runtime` is absent until something uses it: it is built on first use, and a bogus participant token 404s at the session guard before the pool is ever built, so it cannot be triggered by probing from outside.
- [x] **`firsthand-runtime` handshake PROVED, 2026-08-18** - `GET /api/firsthand/studies` as an admin returned three studies.
      `listStudies()` goes through `withRuntimeDatabaseClient`, so that is a completed query on the runtime pool, and re-reading the diagnostics endpoint immediately afterwards showed `firsthand-runtime` back in the report.
      A `verified` mode alone would NOT have settled it, and this pool is the sharper illustration of why: `verifyRuntimeDatabase()` calls `getRuntimeDatabasePool()` - which records the mode - and only then calls `pool.connect()`, so a pool whose handshake fails is recorded `verified`, appears in the report, and 500s every FirstHand request.
      `GET /api/opportunities/:id/survey-results` was the first candidate and is a worse one: it 404s from the MAIN pool when the opportunity has no linked study, without ever reaching the runtime pool, so a 404 there proves nothing either way.
- [ ] **Confirm from the pod log** - still the only way to see `firsthand-migrate`, and still blocked: that runs in the deploy initContainer, a separate process whose recorded modes die with it, so the endpoint structurally cannot report it.
      Every pool logs one line at startup, prefixed `[db-tls:<pool>]`:
      - `verified TLS to <host> against <path>` - working.
      - `UNVERIFIED TLS to <host> ...` - the variable did not reach the pod.
      - `local host (<host>); no TLS` - the resolver thinks the database is
        local. On the deployment that would be wrong; check `DB_URL`.
      - `<host> is exempted from verification by DB_TLS_LOCAL_HOSTS` - warned,
        not informational: verification is on but this host was deliberately
        excluded from it, so that connection has no TLS at all.
      Expect one line each for `backend`, `firsthand-runtime` and
      `firsthand-migrate` (the last from the initContainer).

**Hostname verification was the residual risk, and it is settled for the `backend` pool** as of 2026-08-18, without cluster access.
`rejectUnauthorized: true` makes Node check the certificate's SAN against the host in `DB_URL`, so a CNAME, a private alias, an RDS Proxy under a custom name or a bare IP would fail the handshake even though the CA is correct.
That needed a one-off cluster Job to prove, which neither Nick nor this repo's CI can run.
Two reads settle it instead, and neither needs a pod:

- `GET /api/admin/diagnostics/db-tls` reports `backend: verified`, so that pool was built with `rejectUnauthorized: true` and the RDS bundle.
- `GET /api/health` runs `SELECT 1` through that same exported pool - `createDatabaseHealthProbe(pool)` in `backend/src/index.ts` takes the pool from `backend/src/config/index.ts`, the one labelled `backend` - and returned `{"status":"ok","database":"up","databaseLatencyMs":97}`.

A query cannot succeed on that pool without a completed TLS handshake, and a handshake cannot complete under `rejectUnauthorized: true` with a SAN that does not match the host.
So the certificate verifies and the hostname matches.

Neither read alone is sufficient, which is the point: the diagnostics endpoint knows only what was applied, and health knows only that a query worked.
It is also an observation rather than a guarantee - it says the handshake worked when it was read, not that it always will.
The same pairing settles `firsthand-runtime`: `verified` in the report, and `GET /api/firsthand/studies` returning rows through `withRuntimeDatabaseClient`. **Both database links are confirmed verified and confirmed connected.**

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
- [x] **DB connectivity** – After deploy, verify `GET /api/opportunities` returns 200 (confirms DB + env through the nginx proxy). A **413** from this route is not a connectivity fault: it is the ceiling on embedded sessions (`MAX_SESSIONS_RETURNED = 5000` in `backend/src/routes/opportunities.ts`), which refuses rather than silently truncating, and it applies to anonymous callers too.
  Since `!323`/#103 both callers are time-bounded, but to different windows: an anonymous or
  non-admin request embeds only sessions that can still be acted on (`end_time > NOW()`), tracking
  the live schedule; an admin request embeds the live schedule plus a recent 14-day tail
  (`end_time > NOW() - INTERVAL '14 days'`, cto/AdaptaLabs#103), so its slot totals and "this week"
  counts have recent context without carrying the whole archive. Both counts now track the schedule
  rather than growing for ever, so a 413 here means a genuinely large live schedule, not the passage
  of time.
- [x] **RDS Multi-AZ declared** – `multiAz: true` in `.kubera/playground-backend.yaml`: a synchronous standby in a second AZ with automatic failover. Change it there, not in the AWS console, to avoid manifest/instance drift – it is the likeliest of the three to get toggled off to trim spend. Listed here rather than under Data and backups because it is an availability control, not a backup – it replicates mistakes as faithfully as it replicates good writes. See [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md).
- [ ] ⛔ BLOCKED (needs AWS RDS read access, which Nick does not have) **RDS Multi-AZ applied** – Unverified: confirming the live instance reports `MultiAZ: true` needs AWS RDS read access.

## Data and backups

- [x] **RDS backups declared** – Retention is declared as 14 days in `.kubera/playground-backend.yaml`; see [docs/BACKUP_STRATEGY.md](BACKUP_STRATEGY.md). Change it there, not in the AWS console, to avoid manifest/instance drift.
- [ ] ⛔ BLOCKED (needs AWS RDS read access, which Nick does not have) **RDS backups applied** – Unverified: confirming the live instance reports 14 needs AWS RDS read access.
- [x] **RDS deletion protection declared** – `deletionProtection: true` in `.kubera/playground-backend.yaml`. Change it there, not in the AWS console, to avoid manifest/instance drift. Deleting the instance deliberately means flipping the flag off in the manifest first.
- [ ] ⛔ BLOCKED (needs AWS RDS read access, which Nick does not have) **RDS deletion protection applied** – Unverified: confirming the live instance reports it needs AWS RDS read access.
- [x] **Migrations** – Run automatically on every deploy by the backend init container (`npm run migrate && npm run seed && npm run migrate:firsthand` against `DB_URL`); idempotent and checksum-guarded. There is no manual `run-migrations` endpoint.
  **They now fail the deploy rather than the schema.** Only SQLSTATE class 42 ("the schema is already in this shape") is tolerated; a cancelled statement, a lost connection or a constraint violation rethrows and aborts the init container. Twelve blocks previously swallowed every error class, so a statement cancelled by the pool's 120s `statement_timeout` was logged as "may already exist" and the deploy reported success with the schema change absent. `backend/src/db/migrate.ts` has no `BEGIN`, so a rethrow still leaves a partially applied schema - it says so now instead of claiming success.

## Performance and monitoring

- [ ] **Cluster metrics** – Optional. Use the Kubera/cluster observability stack for request and resource metrics.
- [ ] **Logs** – Backend and frontend pod logs in the cluster (via Kubera or `kubectl logs`) are the source for errors and request logs.
- [x] **Load testing** – k6 script in `load-test/api-smoke.js`; see [TESTING_GUIDE.md](../TESTING_GUIDE.md#load-testing).

## Accessibility (M8)

- [x] **WCAG 2.2 AA** – Contrast fixes (CTA, power button, Settings tab), heading order, page h1s. See `e2e/accessibility.test.ts`.
- [ ] **Re-run a11y tests** – After deploy run `npm run test:a11y:prod`. Uses the production URL and Chromium; use `load` not `networkidle` for production. Note the host is Okta-gated, so anonymous flows redirect to login rather than passing cleanly.

## Residual decommission hygiene

- [ ] ⛔ BLOCKED (needs AWS access, which Nick does not have) **Delete the inert `FIRSTHAND_DATABASE_URL` entry from the backend secret store** - nothing reads it since the Phase C cutover, and the host it names was decommissioned on 2026-08-11 (see [FIRSTHAND-PHASE-C-ROLLBACK.md](FIRSTHAND-PHASE-C-ROLLBACK.md)). AWS-side action; requires AWS access.

## Quick verification after deploy

Run the script. It answers the only question that matters - is the change I merged actually being served - and it fails on the cases that otherwise read as success:

```bash
npm run verify:prod
```

```
OK   backend        up (89ms)
OK   frontend      version.json served as JSON
OK   opportunities  database and environment reachable

     backend  revision: 096898d5b98042cb88f3f476b531a4fd151e84a3
     frontend revision: 096898d5b98042cb88f3f476b531a4fd151e84a3
```

To assert a SPECIFIC commit is live, which is usually what you want after merging something:

```bash
EXPECTED_REVISION=<merge-commit-sha> npm run verify:prod
```

`BASE_URL=<url>` targets another host.

By hand, the same two facts:

```bash
curl -s https://adaptalabs.kubera-playground.adaptavist.net/api/health
curl -s https://adaptalabs.kubera-playground.adaptavist.net/version.json
```

Both report `revision`, the commit their image was built from. Then `git merge-base --is-ancestor <your-commit> <reported-revision>` settles whether your change is in it, and `git tag --contains <reported-revision>` recovers the release.

### Four ways this looks fine and is not

Each of these produced a wrong reading in practice, which is why the script checks for them:

- **A green `semantic-release` job can publish nothing.** If main moves between your merge and the job running, it logs `The local branch main is behind the remote one, therefore a new version won't be published` and exits **successfully**. Two merges three minutes apart published neither. The job status is not evidence of a release - the tag list is
- **`/version.json` returns HTTP 200 with `index.html`** on any frontend pod that predates the file, because nginx falls back to the SPA. A status-code check reports success against a frontend that has not rolled at all. Check the content type, or pipe it through a JSON parse so the HTML case fails loudly
- **`revision: "unknown"` is not a deploy failure.** It means the pod rolled but the `APP_COMMIT_SHA` build argument never reached the image, so the deploy cannot be verified. Both endpoints always emit the field rather than omitting it, so this case is visible rather than silent
- **The two halves report different commits mid-roll.** Frontend and backend roll independently. That is a deploy in progress, not a fault - re-run in a few minutes

### Comparing against the right commit

MRs here are squashed, so **the commit you pushed to your branch never lands on main**. What lands is a new commit under a merge commit, and the images are stamped with the merge commit's sha. Checking your branch tip will report "not deployed" for a change that shipped an hour ago. Use the merge commit, or work backwards from the reported revision with `git tag --contains`.

### ArgoCD lag

Measured at **5-10 minutes** after a green `trigger-deployment-prod` (5 min at 7.51.0, 7-8 min at 7.52.0), not the 15-30 minutes previously recorded here. Poll the endpoints rather than waiting a fixed period, and never conclude a deploy is stuck from job status alone.

## Pre-production sign-off

One-place summary for go-live and after each deploy:

**Before go-live:** Complete the [Pre-production verification](#pre-production-verification) list above. Details: [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) (backups/retention).

**After deploy:** Run [Quick verification after deploy](#quick-verification-after-deploy) (or `npm run verify:prod`). Optionally re-run a11y: `npm run test:a11y:prod` (see [Accessibility (M8)](#accessibility-m8)).
