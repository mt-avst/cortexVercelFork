# FirstHand → Adaptavist ownership / Kubera: migration assessment

**Status:** decided, DevEx consult is the next step. Written 2026-07-15, settled 2026-07-16.

> **⚠️ §4's sizing and approach are WRONG in three places. Read
> `docs/FIRSTHAND-KUBERA-MIGRATION-PLAN.md` ("Corrections to the assessment") before acting on
> this document.** Verified against code 2026-07-16: (1) `storeRecordingObjectInVercelBlob` is
> unreachable dead code, so §4's reference implementation has never run; (2) real object keys are
> client-chosen `recordings/<ts>-<uuid>-<name>` with **no sessionId** — the `recordings/<sessionId>/`
> layout §4 assumes exists only in that dead branch, so any prefix-based migration inventory matches
> zero real objects; (3) "you add an `s3` provider — you don't refactor the callers" is unsafe: the
> branches are not exhaustive, so `s3` silently falls through to filesystem, and `deleteStoredObject`
> would report successful GDPR erasures that delete nothing. §4's ~1 week estimate is optimistic;
> the plan sizes it at ~8.5 eng-days.

**Decision (2026-07-16):** Nick decided to proceed with the migration now.
That is the whole justification — an explicit call made with the trade-off in view,
superseding the 2026-07-15 "defer" decision.

> **Correction (2026-07-16, same day):** an earlier version of this paragraph claimed the
> deferral's precondition had been met because native session review (transcript, responses,
> recording playback — Cortex MR !33/!34, FirstHand PR #10/#11/#12) shipped on 2026-07-15.
> That conflated two different things. The 07-15 gate was the **participant** user-journey/UX
> tidy-up; native session review is the **reviewer's** UX. Shipping the latter did not close
> the former. The participant UX work's status should be checked with Nick — if it is still
> outstanding, it remains a live priority alongside this migration, not something the
> migration replaced.

**Target: Option B (Kubera).** It is the only option that removes the third-party SaaS dependency
rather than relocating it, it consolidates onto the platform Cortex already runs on (one
CI/ArgoCD/secrets/on-call surface instead of two), and the code cost is modest because the storage
and DB layers are already abstracted (§4). **The only genuine platform dependency is one governance
question** — whether playground may host participant PII (§8); S3, IRSA and Okta all turned out to
be self-serve chart config (§5 correction, verified 2026-07-16). **Fallback: Option A
(Adaptavist-owned Vercel)** only if the whole Kubera route stalls — it is not the destination, just
a way to get participant data out of a personal account.

**Raises the stakes on this, checked 2026-07-16:** this is no longer a hypothetical. The
2026-07-15 E2E verification run captured a real screen+microphone recording (Nick as test
participant, native OS permission dialogs, not a fixture) that is sitting in the personal
Vercel Blob store right now, per the `firsthand-integration` memory. There is live captured
media in a personal account today, not just a future risk.

**What is actually left to do, and who does it:**
1. Send the DevEx ask in §8 (as-is, already drafted) to `#dep-internal-engineering`. This
   is the binding constraint — S3+IRSA provisioning and PII-in-playground guidance are not
   self-serve (§5), so no amount of further analysis substitutes for asking. **This has to
   be sent by Nick** — no chat connector is available to do it from here, and sending
   messages on someone's behalf needs their explicit action regardless.
2. In parallel, if Option A is wanted as an immediate stopgap: confirm whether an
   Adaptavist-owned Vercel team already exists (runbook §"Open questions", Q1) — that is
   the one blocking unknown for Option A and only Nick/IT can answer it.
3. Once DevEx responds: pick A or B per their turnaround and the PII-hosting answer (§7),
   execute the runbook (`~/.claude-work/plans/firsthand-containment-runbook.md`) for
   whichever is chosen.

This document exists so none of the analysis is lost in the meantime.

**TL;DR:** The code cost to move FirstHand off personal Vercel is **small** (~1 week) because
the storage layer is already provider-abstracted and Postgres is already first-class. The real
cost and risk is **operational dependence on the DevEx/platform team** (no self-serve cluster,
secret, bucket or ingress access) in a **playground** environment. The thing that actually
matters for containment is the **data** (participant recordings live in a *personal* Vercel Blob
store), not the git repo and not the compute. Move the data first; the repo move is a cheap
ride-along, not a driver.

---

## 1. Why this came up

Three related questions were asked, in order:

1. Is there value in moving the FirstHand **git repo** from personal GitHub to GitLab?
2. Should the whole thing **run within Kubera** (the Adaptavist K8s platform Cortex runs on)?
3. (Underlying) how do we get FirstHand off personal infrastructure — the "containment" goal
   already tracked in the `firsthand-containment` memory + runbook.

The honest framing that emerged: **separate three things** that tend to get lumped together.

| Concern | Where it lives today | Risk if left | Fixed by |
|---|---|---|---|
| **Participant data** (recordings, PII) | **Personal Vercel Blob store** | **High** — data ownership, GDPR/data-processing, one-person control | Move object storage to Adaptavist-owned (S3 or Adaptavist Vercel Blob) |
| **Compute / hosting** | Personal Vercel account/project | Medium — billing, availability, access tied to one person | Adaptavist-owned Vercel team, or Kubera |
| **Source code** | Personal GitHub (`nickfine/FirstHand`, private) | Low — code is cloned locally; bus-factor only | Transfer/mirror to Adaptavist GitLab org |

The data is the dog; repo and compute are the tail. Optimise accordingly.

---

## 2. Current architecture (both apps)

### Cortex / AdaptaLabs (this repo)
- GitLab `cto/AdaptaLabs` (`gitlab.adaptavist.net`), `/Volumes/Extreme Pro/Labs2`.
- Express + TS backend, React (Vite) SPA.
- Runs in **Kubera playground**, namespace `adaptalabs`, AWS account `270148732964`
  (role `AWSKuberaPlayground`).
- Deploy: GitLab CI (kaniko build + publish image) → downstream Kubera deploy pipeline →
  ArgoCD apps in `cloud-native-platform/kubera/kubera-argo-apps/playground-apps`.
- GitHub + Vercel deployment for Cortex is **retired** — GitLab + Kubera is the only live
  system (see `adaptalabs-architecture` memory).

### FirstHand (the other repo)
- GitHub `nickfine/FirstHand` (**private, personal**), `~/code/FirstHand`.
- Next.js 15 (App Router) on **personal Vercel** (`first-hand.vercel.app`).
- Recordings in **personal Vercel Blob** store (`@vercel/blob`, `access: "private"`).
- Postgres runtime supported (`pg`), with a filesystem fallback for local dev.
- Talks to Cortex server-to-server over HMAC-SHA256 (shared `FIRSTHAND_INTEGRATION_SECRET`).
- Contract: `docs/FIRSTHAND-INTEGRATION-CONTRACT.md` (this repo). Native in-Cortex session
  review (transcript + responses + recording playback) shipped 2026-07-15.

> **Note on reachability:** the Cortex backend is currently **private** (no public ingress).
> A public backend ingress was tried (MR !13) and later reverted; today FirstHand's webhook
> callbacks reach the backend via the **frontend nginx proxy** (`/api`, `/auth` forwarded to
> `adaptalabs-backend.adaptalabs.svc.cluster.local:3001`). See
> `docs/PLAYGROUND-BACKEND-INGRESS-PROBLEM.md` for the ingress saga (green pipeline, ingress
> not provisioned for hours, known fragile chart class).

---

## 3. The git repo move (GitHub → GitLab)

**Verdict: low standalone value; do it as a ride-along with the hosting move, to the
Adaptavist GitLab org (not a personal GitLab).**

- **What it buys:** source ownership / bus-factor (code under the company, not a personal
  account); one platform for both repos (unified RBAC/SSO, reviewers, CI, audit); it's the
  natural prerequisite if compute ever moves to the GitLab-CI→ArgoCD Kubera pipeline.
- **What it does *not* buy:** nothing for the actual data risk, nothing for hosting.
- **Cost / friction:** Vercel's integration is GitHub-first. If FirstHand *stays* on Vercel,
  moving the repo to GitLab makes the deploy wiring *worse*. Plus PR/issue history, secrets,
  CI all need re-pointing.
- **The one standalone case:** a near-term bus-factor worry about the source specifically
  (account risk, someone stepping away) → a quick transfer/mirror to the Adaptavist GitLab
  org is a cheap independent win.

---

## 4. FirstHand's Vercel-specific surface (audited 2026-07-15)

The coupling is **four call sites in three files, plus one cron line**. It is small and, for
storage, already behind an abstraction.

| Piece | Location | What it does | Migration |
|---|---|---|---|
| `@vercel/blob` `put` / `get` / `del` | `src/lib/runtime-object-storage.ts:3` (only file) | Server-side store/stream/delete of recordings + transcript artifacts | Add an `s3` provider under the existing `getObjectStorageMode()` switch (`runtime-object-storage.ts:20`) |
| `@vercel/blob/client` `handleUpload` | `src/app/api/session/[token]/recording/client-upload/route.ts:1` | Mints a short-lived Vercel Blob upload token so the browser uploads the recording **directly** to Blob (bypassing the app server; up to 2 GB) | Replace with a **presigned S3 PUT** URL (`@aws-sdk/s3-request-presigner`) |
| `@vercel/blob/client` `upload` | `src/lib/runtime-client.ts:1` | Browser-side call that performs the direct upload | Replace with `fetch(presignedUrl, { method: "PUT", body })` |
| Vercel cron (1 job) | `vercel.json` → `POST /api/internal/maintenance`, `0 3 * * *` | Daily maintenance (transcript jobs, pending-upload cleanup, callback-outbox retries) | K8s **CronJob** curling the endpoint. Already auth'd by `CRON_SECRET` (`src/lib/internal-job-auth.ts:9`) — **config-only**, no code change |
| `next/image` | `src/app/page.tsx:1` (landing page) | Image optimization | `images: { unoptimized: true }` in `next.config.ts`, or add `sharp`. Trivial |

**Package dep:** `@vercel/blob` `^2.3.3` (the only `@vercel/*` dependency).

### Why this is cheaper than a typical de-Vercel

- **Storage is already provider-abstracted.** `storageProvider` is an enum
  (`filesystem | vercel_blob`) in `src/lib/runtime-records.ts:68`; the runtime chooses via
  `getObjectStorageMode()`. You add `s3` — you don't refactor the callers. The Postgres
  column already persists `storage_provider` per asset.
- **Postgres is already first-class** (`pg`, `DATABASE_URL` / `POSTGRES_URL`,
  `isPostgresRuntimeConfigured()` in `src/lib/runtime-database.ts`). Kubera provisions
  **RDS Postgres** via the app chart (`database.postgresql.deploymentType: rds`, engine 17 —
  see `.kubera/playground-backend.yaml:66`). So the DB is a non-issue.
- **Phase 2 (recording playback) rides along for free.** The signed media route streams via
  `createRecordingAssetResponse` (`runtime-object-storage.ts:39`), which calls `get()`. Swap
  that for an S3 `GetObjectCommand` stream and the whole phase-2 signed-URL flow is
  storage-agnostic. No phase-2 rework.

### The one genuinely non-trivial piece: the client-upload flow

Today: browser → `upload()` → `client-upload` route mints a Blob token via `handleUpload`
(validates `recordings/` prefix, registers a *pending upload* with a 15-min `validUntil`,
sets allowed content-type + 2 GB max) → browser uploads **directly to Blob** → browser POSTs
`finalize` (`.../recording/finalize/route.ts`) with `{pathname, url, size, contentType,
duration}` → `resolvePendingRecordingUpload` + `saveUploadedRecordingAsset` (currently
hardcodes `storageProvider: "vercel_blob"`).

Off Vercel this becomes the equivalent S3 dance:
1. `client-upload` route → generate a **presigned PUT** for `recordings/<sessionId>/<file>`,
   keep the same pending-upload registration + validity window.
2. `runtime-client.upload()` → `fetch(PUT, presignedUrl)`.
3. `finalize` → drive `storageProvider` from `getObjectStorageMode()` instead of the hardcoded
   literal; **optionally HEAD the S3 object to verify size server-side** (a small security
   upgrade — today it trusts the browser-reported `fileSizeBytes`/`url`).

Hardcoded `"vercel_blob"` literals to make provider-driven:
`client-upload/route.ts` (pending-upload `storageProvider`), `finalize/route.ts`
(`resolvePendingRecordingUpload` + `saveUploadedRecordingAsset`).

### Code estimate (eng-days, someone who knows the code)

| Task | Est. |
|---|---|
| S3 storage provider (put / get-stream / del) + presign helper; extend `getObjectStorageMode()`; add `s3` to the enum + schema | ~1.0 d |
| Client-upload route: presigned-PUT minting | ~0.5 d |
| `runtime-client.upload()`: plain PUT | ~0.5 d |
| `finalize`: provider-driven + optional S3 HEAD verification | ~0.5 d |
| Dockerfile (`next start`, standalone output) + `.kubera/` app yaml (mirror `playground-backend`) + CI image build + ArgoCD app | ~1–2 d |
| Tests (existing suite mocks `@vercel/blob/client`; add S3 provider tests) + one-off Blob→S3 migration script for existing recordings | ~1 d |
| **Total** | **~4.5–5.5 d (~1 week)** |

Not a rewrite. The `next start` container is the easy part; the Vercel-specific bits above are
the actual work.

---

## 5. What Kubera actually provides (and doesn't)

From `.kubera/playground-backend.yaml` and the ingress post-mortem:

**Provides (good):**
- **AWS-backed** (account `270148732964`) — so **S3 is the natural, durable home** for
  recordings, in the same account. This is what makes Kubera a *coherent* target, not a
  compromise.
- **Managed RDS Postgres** via the chart (`database.postgresql.rds`, engine 17.6).
- **GitLab CI → ArgoCD** pipeline, `kubera-application-chart` (pinned `1.20.7`).
- **Okta OIDC** app auth, **secret store** (ESO) for app secrets, resource requests/limits,
  writable filesystem dirs, init container (runs `migrate && seed`), health probes.
- Public ingress pattern exists (`<app>.kubera-playground.adaptavist.net`) — though Cortex's
  backend currently runs **private** behind the frontend nginx proxy.

> **⚠️ CORRECTION (2026-07-16, verified against chart source).** The claim below that S3 is not
> self-serve was **wrong** — it was inferred from Cortex's own manifest (which stores no blobs, so
> of course has no S3 block), not checked against the chart. **S3 is a first-class, self-serve
> feature of the application-chart.** DevEx's Confluence "S3 bucket" page and the chart's own
> `values.yaml` (`cloud-native-platform/devex/devex-helm-charts`,
> `charts/application-chart/values.yaml`) both confirm it. Adding a private, encrypted bucket with
> read/write IAM is four lines in `.kubera/<env>.yaml`:
> ```yaml
> s3:
>   enabled: true
>   policies:
>     readAndWrite: true
> ```
> The bucket is auto-named `{appName}-{environment}`, region `us-east-1` (same as the cluster —
> nodepool AZs are `us-east-1a/b/c`, so co-located, no cross-region upload penalty), private by
> default with server-side encryption. Critically, **`irsa.enabled: true` is the chart default** —
> the workload identity is created automatically; there is nothing to hand-provision. The Confluence
> page is explicit: *"Your application will automatically receive the necessary IAM permissions."*
> Supported for `application` workloads only, which FirstHand is.
>
> Net effect: the S3+IRSA item below is **not a DevEx ask**. It collapses into ordinary
> self-serve config, folded into plan step 5. The genuinely-remaining platform question is the
> PII/governance one, plus possibly the RDS `walletRoleARN` (the chart has a default
> `...654654157235:role/csm-platform-kubera-sts-role`; verify whether Cortex relies on it before
> asking). One minor doc/chart discrepancy noted: the Confluence page says SSE-S3 encryption, the
> chart comment says default SSE-KMS — both fine for PII-at-rest, worth confirming which is live.

**Does NOT provide out of the box (the gaps):**
- ~~**No object-storage / S3 block in the app chart.**~~ **False — see the correction above. S3
  is self-serve chart config, IRSA is automatic.** This whole item was the linchpin of the
  "DevEx is the binding constraint" thesis, and it does not hold.
- **No self-serve cluster access** for *some* operations. Per the ingress doc: no kubectl / AWS SSO
  on Nick's machine, and adding a secret value to the store (e.g. `FIRSTHAND_INTEGRATION_SECRET`)
  did require escalating. But note this is about *runtime secret values*, not chart features —
  declaring S3, IRSA, RDS, Okta and ingress in the manifest is all self-serve via GitOps.

**Operational friction observed (real, documented):**
- ArgoCD reconciliation ran to **hours, not minutes** on at least one change.
- A documented fragile chart class: PushSecret hook running before its SecretStore exists
  aborts the *entire* sync (seen on chart 1.20.3).
- It is a **playground** environment. Fine for the current integration; a participant-facing
  app *capturing PII* wants a retention/backup story and arguably a prod-grade namespace.

---

## 6. Options spectrum

### Option A — Adaptavist-owned Vercel team + Adaptavist Blob store
- **Effort:** near-zero code. Move the Vercel project into an Adaptavist Vercel team; point
  `BLOB_READ_WRITE_TOKEN` at an Adaptavist-owned Blob store; migrate existing objects.
- **Solves:** the *actual* containment risk (data + billing + account ownership) — ~80% of the
  risk reduction, fast.
- **Keeps:** all Vercel conveniences (client uploads, cron, edge, image opt) and the
  GitHub-first flow. Client-upload path unchanged.
- **Leaves:** still a third-party SaaS dependency (now company-owned), still two stacks to run,
  no Kubera consolidation.

### Option B — Move to Kubera (S3 + RDS + container)
- **Effort:** the code lift dominates (see the plan, ~8.5 eng-days). S3, IRSA, RDS and Okta are
  self-serve chart config — **not** DevEx-provisioned, contrary to the earlier framing.
- **Solves:** full ownership on one platform; kills the third-party dependency; same
  CI/ArgoCD/secrets/observability/on-call as Cortex; co-located with the app it talks to. Repo
  move to GitLab rides along naturally at this point.
- **Cost/risk:** the real dependency is the **PII/governance answer** (is playground an acceptable
  home) plus setting a couple of secret values in the store; playground-grade env; ArgoCD/chart
  friction. Much smaller than "DevEx-dependent for every storage/secret/ingress change".

---

## 7. Recommendation

**Kubera is the right long-run home** — AWS/S3 makes it coherent and the code lift is modest
because the abstractions already exist. **The binding constraint is smaller than first thought:**
S3 and IRSA are self-serve chart config (see the §5 correction), so the only genuine platform
question is governance:

1. ~~Provision an S3 bucket + IRSA.~~ **Self-serve chart config, not a DevEx ask** — `s3.enabled`
   + `policies.readAndWrite` in the manifest, IRSA automatic. This is still the containment win; it
   just isn't blocked on anyone.
2. **Confirm the playground is an acceptable long-term home for participant PII** (retention,
   backup, data-processing posture), or provide a path to a prod-grade namespace. **This is now the
   one real gating question.**

**If the PII answer is "no, not in playground":** that constrains *where* the Kubera app lives, not
*whether* to go to Kubera — pursue a prod-grade namespace. **Option A (Adaptavist-owned Vercel)**
remains the fallback only if the whole Kubera route stalls for reasons beyond this. Either way:
**move the data first.** The repo and the compute can follow.

### Suggested sequencing (updated 2026-07-16)
1. **Participant user-journey / UX tidy-up** — the 2026-07-15 priority. **Still outstanding**
   (Nick confirmed 2026-07-16). Do not conflate with native session review, which is the
   *reviewer's* UX and did ship. This remains a live priority alongside the migration.
2. **The one DevEx question** (§8): PII-in-playground governance. S3/IRSA turned out self-serve,
   so there is nothing to consult about there.
3. **The code work** (plan steps 1-4) is DevEx-independent and can proceed in parallel with 1 and 2.
4. Repo → Adaptavist GitLab as a ride-along with the hosting move.

---

## 8. The one DevEx question

> **Superseded 2026-07-16.** The earlier draft here asked DevEx to provision an S3 bucket + IRSA
> and claimed "the app chart has an RDS block but no object-storage block". **That was wrong** —
> S3 and IRSA are self-serve chart config (see the §5 correction). Sending that ask would have told
> the platform owner her chart lacks a feature it has shipped for four months. Only the governance
> question survives, and it is genuinely hers to answer:

> **Context:** FirstHand is a Next.js app (currently on a personal Vercel account) that backs
> Cortex/AdaptaLabs "unmoderated" research sessions. It captures participant screen/audio
> **recordings** — consent-gated research data — plus a Postgres runtime. We're bringing it into
> Kubera alongside AdaptaLabs, storing recordings in a self-serve S3 bucket via the app chart.
>
> **The question:** is the **playground** an acceptable long-term home for participant recordings
> (retention, backup, data-processing posture), or should this target a prod-grade
> namespace/environment? If the latter, what's the path?
>
> (Everything technical — S3 bucket, IAM, Okta app for the reviewer surface — is self-serve chart
> config, so this governance call is the only thing we need from you. Possibly also: does the RDS
> path need a custom `walletRoleARN`, or does the chart default suffice?)

---

## 9. Key file references

**FirstHand (`~/code/FirstHand`):**
- `src/lib/runtime-object-storage.ts` — `getObjectStorageMode()` (~L20), `@vercel/blob`
  put/get/del (L3), `createRecordingAssetResponse` (L39, used by the phase-2 media route).
- `src/app/api/session/[token]/recording/client-upload/route.ts` — `handleUpload` (L1).
- `src/lib/runtime-client.ts` — client `upload` (L1).
- `src/app/api/session/[token]/recording/finalize/route.ts` — finalize + hardcoded
  `storageProvider: "vercel_blob"`.
- `src/lib/runtime-records.ts:68` — `assetStorageProviderSchema` (`filesystem | vercel_blob`).
- `src/lib/runtime-database.ts` — Postgres detection.
- `src/lib/internal-job-auth.ts:9` — `CRON_SECRET`.
- `vercel.json` — the single daily cron.
- `next.config.ts`, `src/app/page.tsx` — `next/image`.

**Cortex / Kubera (this repo):**
- `.kubera/playground-backend.yaml` — the chart config to mirror (RDS block, secret store,
  Okta, resources, init container, private-service pattern). No object-storage block.
- `.kubera/playground-frontend.yaml` — frontend/nginx proxy config.
- `docs/PLAYGROUND-BACKEND-INGRESS-PROBLEM.md` — ingress/ArgoCD/secret friction, cluster-access
  constraints, AWS account/role.
- `docs/FIRSTHAND-INTEGRATION-CONTRACT.md` — the Cortex↔FirstHand contract (HMAC, endpoints).

**Memory:**
- `firsthand-containment` — the containment plan + runbook pointer
  (`~/.claude-work/plans/firsthand-containment-runbook.md`).
- `firsthand-integration` — integration status (phases 1 & 2 shipped 2026-07-15).
- `adaptalabs-architecture` — GitLab+Kubera is the only live system.
</content>
