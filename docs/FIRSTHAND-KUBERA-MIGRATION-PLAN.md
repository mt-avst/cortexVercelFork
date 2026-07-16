# FirstHand → Kubera migration: construction plan (Option B)

**Created:** 2026-07-16. **Status:** ready to execute, Step 0 not yet sent.
**Decision it implements:** `docs/FIRSTHAND-KUBERA-MIGRATION-ASSESSMENT.md` (Option B, settled 2026-07-16).
**Runbook (secrets, rollback, ownership transfer):** `~/.claude-work/plans/firsthand-containment-runbook.md`.
**Reviewed:** adversarially, 2026-07-16. Six critical findings folded in - see "Corrections to the
assessment" below. **The assessment doc is wrong in three places; this plan supersedes it.**

## Objective

Move FirstHand off Nick's personal Vercel account onto Adaptavist-owned Kubera: replace Vercel
Blob with S3 behind the existing storage abstraction, containerise, migrate existing participant
recordings, and decommission the personal stack.

## Why (read this before touching anything)

Participant screen+audio recordings - consent-gated research data, and **real captured recordings
exist today** from the 2026-07-15 E2E run - live in a Vercel Blob store on a **personal** account
(`nick@nickster.com`). Data ownership is the driver. The repo and the compute are the tail, not
the dog. If you only ever do one thing from this plan, move the data.

## Repos

| | Path | Host | CI |
|---|---|---|---|
| FirstHand | `~/code/FirstHand` | GitHub `nickfine/FirstHand` (personal), Vercel | Vercel GitHub integration |
| Cortex | `/Volumes/Extreme Pro/Labs2` | GitLab `cto/AdaptaLabs` | GitLab CI → Kubera → ArgoCD |

---

## Corrections to the assessment (verified against code 2026-07-16)

The assessment's §4 sizing is optimistic because it describes code that **has never run**. Three
corrections, all verified:

1. **`storeRecordingObjectInVercelBlob` (`runtime-object-storage.ts:163`) is unreachable dead
   code.** `storeRecordingObject` is called only from `src/app/api/session/[token]/recording/route.ts`
   (the server-upload path), and `src/app/session/[token]/page.tsx:43` disables the server path
   whenever mode is `vercel_blob`. So in production the server-side Blob writer never executes.
   **Do not treat it as a proven reference implementation.**
2. **Real object keys have no `sessionId` in them.** The client picks the key:
   `runtime-client.ts:220` → `` `recordings/${Date.now()}-${crypto.randomUUID()}-${safeFileName}` ``.
   The server only validates the `recordings/` prefix (`client-upload/route.ts:59`). The
   `recordings/<sessionId>/<file>` layout exists **only** in the dead branch above. Filesystem mode
   uses a **third** layout (`uploads/<sessionId>/...`). Three incompatible historical layouts exist;
   any prefix-based inventory matches zero real objects.
3. **"Add a provider, don't refactor the callers" is unsafe.** All five branch sites are
   `if (x === "vercel_blob") {...} return <filesystem>` - not exhaustive switches. Adding `s3` to
   the enum compiles clean and **silently routes S3 assets to the filesystem branch**. Worst case is
   `deleteStoredObject:128`, where `rm(..., {force: true})` suppresses ENOENT and reports a
   successful deletion that deleted nothing - a GDPR erasure that silently no-ops on participant PII.

## The binding constraint

**The code is the bottleneck, not DevEx** — corrected 2026-07-16 against the chart source. An
earlier version of this plan claimed S3+IRSA had to be DevEx-provisioned and that
`kubera-application-chart` "has an RDS block but no object-storage block". **Both wrong**, verified
against `cloud-native-platform/devex/devex-helm-charts`, `charts/application-chart/values.yaml`:

- **S3 is self-serve chart config.** `s3.enabled: true` + `policies.readAndWrite: true` in
  `.kubera/<env>.yaml` creates a private, encrypted bucket auto-named `{app}-{env}` in `us-east-1`
  (same region as the cluster — no cross-region penalty). DevEx's "S3 bucket" Confluence page
  documents it; it has existed for ~4 months.
- **IRSA is automatic.** `irsa.enabled: true` is the chart default; the workload identity is
  created for you. The Confluence page: *"Your application will automatically receive the necessary
  IAM permissions."*
- **Okta for the reviewer surface is self-serve too** — `auth.okta_app` in the chart, declared in
  the manifest with `customRedirectUris`.

**So the only genuine DevEx dependency is one governance question:** may playground host participant
PII long-term, or is a prod-grade namespace needed (§8 of the assessment). Possibly also whether
RDS needs a custom `secret.walletRoleARN` (the chart has a default; verify Cortex doesn't override
it). Neither blocks the code.

Step 0 sends that one question. **Steps 1-5 are all effectively DevEx-independent now** — the S3
config in step 5 is self-serve. Only step 6 (cutover) genuinely waits on the PII answer, and only
if the answer is "not playground".

**Abort/pivot:** the PII answer constrains *where* the Kubera app lives, not *whether* to proceed.
If it's "not playground", target a prod-grade namespace rather than abandoning Kubera. Only fall
back to **Option A** (Adaptavist-owned Vercel, runbook Option A) if the whole route stalls. The code
in S1-S4 is not wasted in that case unless Option A becomes *permanent* (then S1/S3/S4 are sunk,
~3.5 eng-days).

---

## Dependency graph

```
S0 (DevEx ask) ─────────────────────────────┐
                                            │
S1 (S3 provider) ──┬── S3 (presigned PUT) ──┤
                   └── S4 (migration script)┤
                                            ├── S5 (Kubera manifest) ── S6 (cutover) ── S7 (repo move)
S2 (containerise) ──────────────────────────┘                              │
                                                                           └── S8 (decommission)
```

**Parallel:** S0 ∥ S1 ∥ S2. S3 ∥ S4 after S1.
**Serial:** S5 needs S2 (S5's S3 config is self-serve, so it does **not** wait on S0). S6 needs
S3+S4+S5 **and** the S0 governance answer (only if that answer forces a non-playground home). S7
and S8 need S6 verified.
**S3 (presigned PUT) is mandatory before S6** - not conditional. See S3.
> Graph note: the `S0 → S5` edge from the earlier version is dropped — S5 no longer waits on DevEx
> now that S3/IRSA are known self-serve. S0 only gates S6, and only conditionally.

## Invariants (verify after every step)

- FirstHand vitest green (**163 passing / 29 files** at plan time)
- FirstHand Playwright e2e green (`e2e/reviewer-flows.spec.ts`; needs `FIRSTHAND_DATA_DIR` +
  filesystem mode + `FIRSTHAND_PLAYWRIGHT_BUILD=1`, and `next.config.ts` already switches `distDir`
  to `.next-playwright` under that flag - **S2's `output: "standalone"` interacts with this**)
- Cortex untouched until S6 (backend jest 187, frontend vitest 97)
- **Phase 2 signed-media playback keeps working** - `signAssetMedia` / `verifyAssetMediaSignature` /
  `buildSignedAssetMediaUrl` in `src/lib/integration-auth.ts`, streaming via
  `createRecordingAssetResponse`
- Filesystem mode keeps working - it is the local-dev path and the entire test suite depends on it
- No secret values in any transcript, commit, or PR body

## House rules

TDD (test first, watch it fail, then implement). Files <800 lines, functions <50. British English,
hyphens not emdashes, no emojis, no co-author trailers. `env -u GITHUB_TOKEN gh ...` for FirstHand
(an invalid `GITHUB_TOKEN` shadows the good keyring token). GitLab: push with
`-o merge_request.create`, then **merge in the UI** (token 403s on API MR create, 401s on merge).

---

## Step 0 — Ask DevEx the one governance question (human)

**Owner:** Nick. Not a PR. **Blocks:** only S6, and only if the answer forces a non-playground
home. **Parallel with:** everything.

### Context brief
DevEx/platform own Kubera. Contact: **Lilly Holden** (owns Kubera + Okta, responsive, keep asks
tight). Channel `#dep-internal-engineering`. An agent cannot send this - no Slack connector is
authorised, and it must come from Nick regardless.

**This is now a single governance question, not a provisioning request.** The earlier draft asked
DevEx to provision S3 + IRSA and stated the chart has "no object-storage block" — verified wrong
2026-07-16 (see "The binding constraint" above). S3, IRSA and Okta are all self-serve chart config.
Sending the old ask would have told the platform owner her chart lacks a feature it has shipped for
months. The only thing genuinely hers to answer: **may the playground host consent-gated
participant recordings long-term, or does this need a prod-grade namespace?** See §8 of the
assessment for the phrasing.

**Do not ask about ingress body-size limits.** The playground fronts apps with an **AWS ALB**
(`docs/PLAYGROUND-BACKEND-INGRESS-PROBLEM.md`), which imposes no request body cap. The answer would
be "no limit", which would falsely imply the server-upload path is viable. The real constraints on
that path are pod memory (2Gi), ALB idle timeout, and pod restarts mid-upload. Presigned PUT is
mandatory regardless - see S3.

### Tasks
- [ ] Send the §8 governance question to `#dep-internal-engineering`, @-mentioning Lilly
- [ ] Decide whether to include the "real recording already in a personal account" urgency line
      (true, justifies priority, but surfaces a live data-handling issue in a semi-public channel;
      keep it in reserve as an escalation lever rather than leading with it)
- [ ] Optionally fold in the small `walletRoleARN` verification (does RDS need a custom one, or does
      the chart default `...654654157235:role/csm-platform-kubera-sts-role` suffice) - one line
- [ ] ~~Okta app registration ask~~ **not needed** - `auth.okta_app` is self-serve chart config with
      `customRedirectUris` in the manifest

### Exit criteria
DevEx has answered the PII verdict: playground acceptable, or the path to a compliant environment.
(No provisioning to wait on - S3, IRSA, Okta are all self-serve.)

### Rollback
n/a. If no answer within a timebox Nick sets, proceed with the code (S1-S5) anyway and hold only S6.

---

## Step 1 — S3 storage provider

**Repo:** FirstHand. **Branch:** `feat/s3-storage-provider`. **Model tier:** strongest.
**Depends on:** nothing. **Parallel with:** S0, S2. **Est:** ~1.5 d (was 1.0 - task 0 is new).

### Context brief
`src/lib/runtime-object-storage.ts` is the **only** file importing `@vercel/blob`. Provider switch:
`getObjectStorageMode()` (~line 20) returns `vercel_blob` when `BLOB_READ_WRITE_TOKEN` is set, else
`filesystem`. Provider is persisted per-asset via `assetStorageProviderSchema`
(`runtime-records.ts:68`) into `recording_assets.storage_provider`.

**Read "Corrections to the assessment" above before starting.** In particular: the callers are
**not** exhaustive, and the Blob writer you might be tempted to copy is dead code.

**Critical gotcha:** recordings are `access: "private"`. Playback **streams through FirstHand** via
`createRecordingAssetResponse` - it does not redirect to a blob URL. S3 must preserve streaming
(`GetObjectCommand` → `Body` stream), **not** switch to a presigned-GET redirect. The assessment's
Options A and B both proposed redirects; both are wrong for private objects.

**Mixed-provider reality:** existing rows say `vercel_blob`. Until S6 migrates them, reads must
branch on `asset.storageProvider` per-asset. `getObjectStorageMode()` governs **writes only**.

### Tasks
- [ ] **Task 0, do this first:** convert all five provider branch sites to exhaustive `switch` with
      a `const _exhaustive: never = provider` default - `createRecordingAssetResponse:41`,
      `createTranscriptArtifactResponse:91`, `deleteStoredObject:123`, plus the two write switches.
      **Then** add `s3` to the enum, so the compiler enumerates the work instead of a reviewer.
      Also drop `force: true` from `deleteStoredObject:128` - it converts a missing object into a
      silent success
- [ ] Confirm no CHECK constraint in `db/migrations/` rejects `'s3'` in `storage_provider`
- [ ] Extend `getObjectStorageMode()` to return `s3`. Precedence must be explicit and logged at
      startup, secret-free. **A stale `BLOB_READ_WRITE_TOKEN` must not silently win** - that exact
      failure class (stale value shadowing the intended one) has already caused two production
      incidents here: the `DATABASE_URL` outage and the `OIDC_CLIENT_ID` login failure. Mirror
      Cortex MR !19's `[db] connection source:` diagnostic
- [ ] Add `FIRSTHAND_PUBLIC_BASE_URL` config and use it in
      `src/app/api/sessions/[sessionId]/outputs/route.ts:79` instead of
      `new URL(request.url).origin`. **See finding below** - this is not optional
- [ ] Add `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`
- [ ] Implement the S3 branches: streaming upload (`Upload` from `lib-storage`, which does multipart
      properly), streaming read (`GetObjectCommand`), delete, transcript write/read
- [ ] **Do not use `stream.tee()` for byte counting.** The dead Blob branch does
      (`runtime-object-storage.ts:171-172`) and it is a latent OOM: `tee()` does not propagate
      backpressure, so draining the counting branch at full speed buffers the entire object in the
      upload branch's queue. At 2GB against a 2Gi pod limit that is an OOMKill. Count via an inline
      `TransformStream` on the single stream, or take the size from `HeadObject` after upload
- [ ] Keep **`Range` request support** in mind: `createRecordingAssetResponse:50-56` returns a bare
      stream with `Content-Length` from the stored `fileSizeBytes`. Video seeking does not work today.
      S3 `GetObjectCommand` supports `Range` - wiring it is a cheap win, but scope it explicitly
      rather than letting it sprawl

### Why `FIRSTHAND_PUBLIC_BASE_URL` is mandatory
`outputs/route.ts:79` currently mints `media_url` from `new URL(request.url).origin`, and
`grep -rn "x-forwarded" src/` returns **nothing** - there is no proxy-header handling anywhere. On
Vercel, `request.url` is the correct public `https://` origin. Behind a TLS-terminating ALB with
`next start`, the scheme/host come from what reaches Node - i.e. plain `http://`.
`sessionOutputsSchema` validates it as `z.string().url()`, so `http://...` passes cleanly. Cortex is
served over `https://`, so the browser blocks the `media_url` as **mixed content and every recording
silently fails to play** - the exact capability the assessment names as this migration's unblocking
gate. It passes CI and health probes and only fails in a real browser. The signature covers
`assetId` + `exp` only (`integration-auth.ts:127-147`), so rebasing the URL needs no re-signing.

### Verification
```bash
cd ~/code/FirstHand
npx vitest run     # 163+ green; filesystem and vercel_blob paths unchanged
# S3 tests MUST run against a real object store (MinIO/LocalStack in docker), not an SDK mock.
# The existing suite mocks @vercel/blob/client, which is exactly why the client-upload path
# has no real coverage and why its dead branch went unnoticed. Do not repeat that.
```

### Exit criteria
Exhaustive switches in place. S3 round-trip (put → stream get → delete) green against
MinIO/LocalStack. Filesystem mode green. Startup logs the resolved storage mode. `media_url` comes
from config, not the request origin.

### Rollback
Additive; inert until the S3 env is set. Revert the branch. No data touched.

---

## Step 2 — Containerise for Kubera

**Repo:** FirstHand. **Branch:** `feat/containerise`. **Model tier:** default.
**Depends on:** nothing. **Parallel with:** S0, S1. **Est:** ~1.5 d (was 1.0 - see the traps).

### Context brief
Next.js 15.5.14 (App Router), scripts `build` / `start`. Mirror Cortex's `backend/Dockerfile`:
`node:20.20.2-alpine3.22`, explicit `apk upgrade` (Cortex patches an openssl CVE the base image had
not picked up), `npm ci`, build, `npm prune --production`, non-root uid 1001, `CMD ["npm","start"]`.

Vercel surface to neutralise: `next/image` on `src/app/page.tsx`, and `vercel.json`'s single cron
(`POST /api/internal/maintenance`, `0 3 * * *`) which becomes a K8s CronJob in S5 (already authed by
`CRON_SECRET`, `src/lib/internal-job-auth.ts:9` - config-only).

**Verified traps:**
- **There is no health endpoint.** `find src/app -ipath "*health*"` returns nothing. Kubera's probes
  need a path (Cortex uses `/health`). You must **create** one - the earlier draft of this plan said
  "check whether one exists", which wasted a step
- **`sharp` is not a dependency.** Adding it to a `node:20-alpine` standalone build is a known
  libvips/musl footgun needing the platform-specific optional dep in the builder stage. If the
  landing page tolerates it, `images: { unoptimized: true }` is far cheaper - prefer that and only
  reach for `sharp` if image quality actually regresses
- **`output: "standalone"` interacts with the existing conditional `distDir`** in `next.config.ts`
  (`.next-playwright` under `FIRSTHAND_PLAYWRIGHT_BUILD=1`). Verify the Playwright suite still runs

### Tasks
- [ ] Create a `/health` route (trivial, no DB dependency - probes must not fail on a slow DB)
- [ ] `output: "standalone"` in `next.config.ts`; verify against the conditional `distDir`
- [ ] Handle `next/image` (prefer `unoptimized`; `sharp` only if needed)
- [ ] Write `Dockerfile`; non-root; verify boot in filesystem and stubbed-S3 modes
- [ ] Run the Playwright suite against the built image
- [ ] Do **not** delete `vercel.json` - Vercel stays live until S8

### Verification
```bash
cd ~/code/FirstHand
docker build -t firsthand:local .
docker run --rm -p 4000:3000 -e DATABASE_URL=... firsthand:local
curl -f localhost:4000/health
npx vitest run && npx playwright test
```

### Exit criteria
Image builds, boots, serves the participant flow, answers `/health`. Playwright green. No Vercel
runtime dependency remains except the Blob calls (S1) and the cron declaration.

### Rollback
Revert branch. Vercel deploy unaffected (it ignores the Dockerfile).

---

## Step 3 — Presigned S3 uploads + provider-driven finalize (MANDATORY before S6)

**Repo:** FirstHand. **Branch:** `feat/s3-presigned-upload`. **Model tier:** strongest.
**Depends on:** S1. **Parallel with:** S4. **Est:** ~2.0 d (was 1.5 - server-side keys are new).

### Context brief — the subtlest step, read fully

Today the browser uploads **directly to Blob**, bypassing the app server, for files up to 2GB:
1. `runtime-client.ts` → `upload()` from `@vercel/blob/client` (multipart above 5MB, automatically)
2. → `client-upload/route.ts` → `handleUpload()` mints a scoped token (validates the `recordings/`
   prefix, registers a pending upload with 15-min `validUntil`, pins content-type, caps at 2GB)
3. browser PUTs straight to Blob
4. → `finalize/route.ts` with `{pathname, url, size, contentType, duration}` →
   `resolvePendingRecordingUpload` + `saveUploadedRecordingAsset`

**Why this is mandatory, not an optimisation.** `page.tsx:43` reads
`getObjectStorageMode() === "vercel_blob"`, so the moment S1 makes the mode `s3`, direct upload
switches itself off and recordings fall to the server-upload path. **Do not mistake that fallback
for a working migration.** That path in Blob mode is dead code that has never run in production
(see "Corrections"), and routing 2GB through a 2Gi pod is an OOM and a lost session on any pod
restart. Vercel's 4.5MB serverless body cap is precisely why direct upload exists. The ALB imposes
no body cap, so nothing will *stop* you shipping the bad path - which is why this step is
unconditional rather than gated on an ingress answer.

**Fix the key-authority hole rather than porting it.** The client currently chooses the object key
(`runtime-client.ts:220`) and the server validates only the prefix. With Blob's `addRandomSuffix:
false` that is already weak; with a presigned `PutObjectCommand` it becomes a **raw write capability
for whatever key you sign**, so any participant with a valid session token could request a presigned
PUT for another participant's key and overwrite their recording. The earlier draft of this plan said
"preserve every existing guard", which would have ported the hole. Derive the key **server-side**.

Also: `finalize/route.ts:89` persists `objectUrl` straight from the browser-supplied payload, and
`fileSizeBytes` likewise comes from the browser (`runtime-client.ts:159`). `HeadObject` fixes size;
drop `objectUrl` from the client payload entirely.

### Tasks
- [ ] **Derive the object key server-side** in `client-upload/route.ts` from `sessionId` + a server
      UUID. Return it with the presigned URL. `finalize` must ignore the client's `pathname` and
      trust only the pending-upload row
- [ ] Replace `handleUpload` with a presigned `PutObjectCommand`
      (`@aws-sdk/s3-request-presigner`), preserving the real guards: pending-upload registration +
      15-min validity, content-type pinning, size cap
- [ ] Replace `upload()` in `runtime-client.ts` with a PUT. **Note `@vercel/blob/client` did
      multipart automatically above 5MB and a plain PUT does not.** Either accept single-PUT (S3's
      hard limit is 5GB, above the 2GB cap - workable) or implement multipart. **Decide and record**
- [ ] Make `directRecordingUploadEnabled` (`page.tsx:43`) provider-driven, not `=== "vercel_blob"`
- [ ] Drive `storageProvider` from `getObjectStorageMode()` in `client-upload/route.ts` and
      `finalize/route.ts`; remove both hardcoded `"vercel_blob"` literals
- [ ] Replace the `BLOB_READ_WRITE_TOKEN` 503 guards in both routes with a provider-agnostic check
- [ ] `HeadObject` verification in `finalize`: reject on missing object or size mismatch; take
      `fileSizeBytes` from S3, not the browser. Drop `objectUrl` from the payload
- [ ] Tests against MinIO/LocalStack incl. the tampered-size and foreign-key rejection paths
- [ ] Check `autoGenerateTranscriptForSession` is still `await`ed on the finalize path
      (`finalize/route.ts:95`) and that its latency is acceptable

### Verification
```bash
cd ~/code/FirstHand && npx vitest run
# Manual, and it must be: record a real session locally in S3 mode, confirm the object lands at
# the server-derived key, finalize verifies it, playback streams back. Screen+mic capture needs
# native permission dialogs - a human clicks Allow. Not automatable.
```

### Exit criteria
Direct-to-S3 upload works end-to-end; keys are server-authored; `finalize` rejects a falsified size
and a foreign key; no hardcoded `vercel_blob` literals outside read branches; filesystem mode green.

### Rollback
Revert branch → falls back to the server-upload path, which is **not production-safe at 2GB**. So
revert only in dev; do not cut over on the fallback.

---

## Step 4 — Blob → S3 migration script

**Repo:** FirstHand. **Branch:** `feat/blob-to-s3-migration`. **Model tier:** strongest.
**Depends on:** S1. **Parallel with:** S3. **Est:** ~1.5 d (was 1.0 - DB-driven inventory is new).

### Context brief
Copy every existing object from the personal Blob store to S3, then flip each asset's
`storage_provider` / `relativePath` in Postgres.

**Inventory from the database, never from a key prefix.** `recording_assets.relative_path` is the
only source of truth. Three incompatible historical key layouts exist (see "Corrections"): real
Blob objects are at `recordings/<ts>-<uuid>-<name>` with **no sessionId**; the
`recordings/<sessionId>/` layout appears only in dead code; filesystem mode uses
`uploads/<sessionId>/`. A prefix-based inventory would match **zero** real objects and cheerfully
report "nothing to migrate" against the store holding the one recording you must not lose.

Transcripts are **not** in `recording_assets` - they are an inline JSON column on `runtime_sessions`
carrying optional `artifactPath` / `artifactUrl` / `storageProvider`. Easy to miss; migrate both.

**This step moves real participant PII between accounts.** Consent/GDPR check **before** it runs
(runbook, "Open questions" Q4), not after.

### Tasks
- [ ] `scripts/migrate-blob-to-s3.mjs`: enumerate from `recording_assets` + `runtime_sessions`,
      stream each object Blob → S3 **at its existing key**, verify with `HeadObject`, update the row
- [ ] **Correct `file_size_bytes` from `HeadObject` while you are there.** Existing rows carry a
      **browser-reported** size (`finalize/route.ts:87` ← `runtime-client.ts:159`). A wrong size
      produces a truncated or hung playback stream, since `createRecordingAssetResponse` sets
      `Content-Length` from it
- [ ] **Idempotent and resumable** (skip objects already present with matching size). It will be
      interrupted; assume so
- [ ] `--dry-run` default; refuse to run without explicit `--confirm`
- [ ] Reconcile both directions: rows with no object, and objects with no row (orphans)
- [ ] Byte-verify a sample, not just size
- [ ] Do **not** delete from Blob - deletion is S8, after verification
- [ ] Record the cutover timestamp; S6's rollback needs it (see below)

### Verification
```bash
cd ~/code/FirstHand
node scripts/migrate-blob-to-s3.mjs --dry-run   # accurate inventory, changes nothing
# Rehearse against a copy/staging DB + bucket before touching the real store.
npx vitest run
```

### Exit criteria
Dry-run inventory matches the real store (verify the count by hand against the Vercel dashboard -
do not trust the script's own model). Rehearsal migrates a test corpus with byte-verified integrity
and is provably resumable. Rollback documented and rehearsed.

### Rollback
**Not a global flip.** Reverting `storage_provider` to `vercel_blob` is only valid for rows migrated
from Blob. Any recording captured **after** cutover exists only in S3; flipping those points at a
Blob object that never existed → `get()` returns null → throw → the media route returns a silent
**404** on a recording that does exist. **Scope the revert by `uploaded_at < <cutover timestamp>`**
and decide explicitly what happens to post-cutover recordings during a rollback (accept unplayable,
or reverse-migrate).

---

## Step 5 — Kubera manifest, CI, CronJob

**Repo:** FirstHand (+ ArgoCD app registration via the DevEx pipeline). **Model tier:** strongest.
**Depends on:** S2 (not S0 — the S3 config here is self-serve). **Est:** ~2.0 d.

### Context brief
Mirror `/Volumes/Extreme Pro/Labs2/.kubera/playground-backend.yaml`: `teamName`, `environment`,
`service.port`, `config.data`, `auth.okta_app`, `secret.enabled` (ESO), `resources` (2Gi/1000m),
`database.postgresql` `deploymentType: rds` (17.6), `filesystem.writable`, probes, `initContainer`.
CI uses `to-be-continuous` Kubera components; deploy is GitLab CI → Kubera pipeline → ArgoCD.

**Differences from Cortex that matter:**
- FirstHand needs a **public** ingress (participants arrive from the open internet). Cortex's
  backend deliberately runs **private** behind the frontend nginx proxy - that pattern does **not**
  transfer.
- **Known risk:** the last public-ingress attempt (Cortex MR !13) took 10-14 hours to provision and
  was later reverted (`docs/PLAYGROUND-BACKEND-INGRESS-PROBLEM.md`). A green pipeline is **not** a
  provisioned ingress. Budget for it.
- **`initContainer`: do not copy Cortex's verbatim.** Cortex runs `npm run migrate && npm run seed`.
  FirstHand's script is **`db:migrate`** (→ `scripts/postgres-migrate.mjs`) and **there is no seed
  script at all** - `scripts/` contains exactly one file. Copying verbatim CrashLoopBackOffs before
  the app ever starts. Also confirm the runner is idempotent across restarts:
  `0002_firsthand_schema_migrations.sql` tracks migrations by **checksum**, and the initContainer
  re-runs on every deploy.
- **Reviewer auth.** The `/review/*` surface needs auth; participants must stay anonymous
  (token-authed). `auth.okta_app` provisions an Okta app and injects `clientID`/`clientSecret`, and
  the app decides which routes enforce it - so `okta_app` **is** compatible with a public
  participant ingress (`okta_alb` is not - the manifest comment says the two cannot be combined, and
  `okta_alb` would gate the whole host). Either adopt `okta_app` for `/review/*` or keep FirstHand's
  own `FIRSTHAND_REVIEWER_OIDC_*`. The redirect URIs are set in the manifest
  (`auth.okta_app.customRedirectUris`) - **self-serve, no DevEx round-trip.**
- **S3 is a chart block, and it's self-serve** (verified against `values.yaml` 2026-07-16 - the
  earlier "no chart block, wire it per DevEx" note was wrong):
  ```yaml
  s3:
    enabled: true
    policies:
      readAndWrite: true      # s3:List*/Describe*/*Object - upload, download, delete
    # bucketName defaults to {app}-{environment}; region us-east-1 (= cluster region)
    # deletionPolicy: Orphan (default) - keep the bucket if the app is torn down
    versioning:
      enabled: true           # recommended for participant recordings - recover overwrites/deletes
  ```
  `irsa.enabled: true` is the chart default, so the pod gets the IAM role automatically - nothing to
  request. Confirm live encryption mode (Confluence page says SSE-S3, chart comment says SSE-KMS;
  both fine for PII, but state which in the manifest if it matters for compliance). The S3 code in
  S1/S3 must read the injected bucket name + region from config/env, not hardcode them.

### Tasks
- [ ] `.kubera/playground.yaml` in FirstHand's **own namespace** (not under `adaptalabs` -
      FirstHand is intended to stand alone commercially)
- [ ] initContainer → `npm run db:migrate` only; no seed
- [ ] `.gitlab-ci.yml` mirroring Cortex's kubera components. **Ordering:** CI wants the repo on
      GitLab (S7). Resolvable via a GitLab pull-mirror of the GitHub repo in the interim - prefer
      that over dragging S7 forward
- [ ] K8s CronJob → `POST /api/internal/maintenance` daily, `CRON_SECRET` from the secret store
- [ ] Secret store entries per the runbook's rotation list - **rotated, not copied**
- [ ] Set `FIRSTHAND_PUBLIC_BASE_URL` to the new public host (S1 added it)
- [ ] Deploy pointing at the **new empty S3 bucket**; Blob still live and untouched

### Exit criteria
FirstHand runs on Kubera, probes green, a **fresh** session records to S3 end-to-end, the reviewer
surface authenticates, the CronJob fires. Vercel still live and serving production.

### Rollback
Vercel remains authoritative until S6. Scale the Kubera deployment to zero.

---

## Step 6 — Cutover (GATED)

**Repos:** FirstHand + **Cortex**. **Model tier:** strongest. **Depends on:** S0, S3, S4, S5.

### Context brief
The only step touching Cortex. `.kubera/playground-backend.yaml` pins
`FIRSTHAND_BASE_URL: https://first-hand.vercel.app` → becomes the Kubera host. Cortex MR: push with
`-o merge_request.create`, merge in the UI.

`FIRSTHAND_INTEGRATION_SECRET` must be **identical on both sides** - rotation is a coordinated,
simultaneous change across Cortex's GitLab CI/CD variable and FirstHand's secret store. Get it wrong
and the integration 401s.

**The dual-runtime hazard the earlier draft missed.** "Keep Vercel warm as rollback" is not free:
- If Vercel and Kubera point at the **same** Postgres, **both** maintenance crons drain the same
  `callback_outbox` (`0006_firsthand_callback_outbox.sql`, `processDueCallbackDeliveries` via
  `api/internal/maintenance/route.ts`) → **duplicate callbacks to Cortex**. Cortex's
  `(firsthand_session_id, event_type)` unique index makes redelivery idempotent, which limits the
  blast radius - but the duplicate work and racing outbox rows are real.
- If they point at **different** databases, in-flight sessions are stranded.

Disable the Vercel cron at cutover. That step did not exist in the earlier draft.

### Tasks
- [ ] GDPR/consent sign-off **before** real participant data moves accounts
- [ ] Final dry-run, then run S4's migration for real. **Record the cutover timestamp**
- [ ] **Disable the Vercel cron** (remove `crons` from `vercel.json` or pause the project's cron) so
      only Kubera's CronJob drains the outbox
- [ ] Decide and document the Vercel-warm posture: same DB (duplicate cron risk, handled by the
      above) or drained-and-frozen
- [ ] Rotate `FIRSTHAND_INTEGRATION_SECRET` on both sides in one coordinated change
- [ ] Point Cortex's `FIRSTHAND_BASE_URL` at the Kubera host (Cortex MR)
- [ ] Repoint FirstHand DNS/host; keep Vercel warm as rollback
- [ ] Full E2E on **migrated** data, not just fresh: opportunity → handoff → record → callback →
      Sessions tab → native review with transcript, responses and **recording playback**
- [ ] **Test a multi-attempt session.** The attempt-resolution bug (FirstHand PR #12, 2026-07-16)
      proves this path is easy to get wrong, and it was invisible to mocked tests
- [ ] Verify `media_url` is `https://` in a real browser (the mixed-content trap from S1)

### Exit criteria
Production traffic on Kubera+S3. **Migrated** recordings play back in Cortex over https. Integration
green E2E. Vercel standing by, cron disabled.

### Rollback
Revert Cortex's `FIRSTHAND_BASE_URL`, revert the DB provider flip **scoped by `uploaded_at <
cutover`** (see S4), re-enable the Vercel cron, point DNS back. Rehearse before starting.

---

## Step 7 — Repo → Adaptavist GitLab (ride-along)

**Model tier:** default. **Depends on:** S6 (or a pull-mirror earlier for S5's CI).

### Context brief
Cheap ride-along, not a driver. FirstHand keeps its **own namespace/group** - not under
`cto/AdaptaLabs`. Vercel's GitHub-first binding is what made a repo move expensive *before*; after
S6 that objection dies.

### Tasks
- [ ] `git clone --mirror` backup to cold storage first
- [ ] Create the GitLab project in its own namespace; push all branches and tags
- [ ] Move CI to GitLab; re-point local remotes
- [ ] Decide the fate of GitHub PR/issue history and the `codex/*` automation branches
- [ ] Archive the GitHub repo (do not delete)

### Rollback
GitHub repo stays archived-but-intact.

---

## Step 8 — Decommission the personal stack

**Model tier:** default. **Depends on:** S6 verified and soaked.

### Context brief
**Last step, deliberately.** Everything before this is reversible precisely because the personal
Blob store still holds the objects. Do not run until migrated data has been verified in production
and soaked long enough to trust.

### Tasks
- [ ] Verify every object exists in S3, byte-verified, before deleting anything
- [ ] Cold backup of the Blob contents **outside both accounts**
- [ ] Delete the Vercel project, Blob store, personal Postgres
- [ ] Revoke old tokens/secrets (`BLOB_READ_WRITE_TOKEN`, old `CRON_SECRET`, old integration
      secret). Close out the two secrets exposed in a transcript on 2026-07-02/03 that Nick chose not
      to rotate at the time - see the runbook's security note
- [ ] Remove `@vercel/blob` and the `vercel_blob` branches **only once no asset row references
      them**. Note `runtime-client.ts:1` imports `@vercel/blob/client` at client-bundle top level -
      this is a code change with bundle implications, not a `package.json` edit
- [ ] Update `.env.example` - it documents only `BLOB_READ_WRITE_TOKEN` under "Object storage", and
      after this step local dev has no documented storage config path
- [ ] Delete `vercel.json`
- [ ] Update `docs/FIRSTHAND-INTEGRATION-CONTRACT.md` and the assessment doc to final state

### Exit criteria
No participant data on any personal account. `@vercel/blob` gone from `package.json`.

### Rollback
None. This is the irreversible one - hence the soak and the cold backup.

---

## Open questions this plan cannot answer

1. **Playground vs prod-grade for PII** - the one governance question. Constrains *where* the Kubera
   app lives, not *whether* to proceed. S0.
2. **Reviewer auth**: chart `auth.okta_app` vs FirstHand's own `FIRSTHAND_REVIEWER_OIDC_*`. Both are
   viable and both self-serve (`okta_alb` is not). Redirect URIs are set in the manifest, no DevEx
   round-trip. Decide in S5.
4. **Multipart upload**: accept single PUT ≤5GB, or implement multipart. Decide in S3.
5. **Observability, rate limiting, egress cost** - unscoped. Private objects mean **no CDN**, so
   every playback streams 2GB through the pod and out via S3 egress. That is a real bandwidth
   constraint and a real line item. Size it before S6.
6. **`Range` request support** - seeking is broken today. S1 notes it; decide whether it is in scope.
