# Phase 2 — FirstHand session recording playback inside Cortex

> **STATUS: SHIPPED 2026-07-15. This document is now HISTORICAL — a pre-build spec, retained for
> its reasoning, not a description of what exists.** For current behaviour see
> `docs/FIRSTHAND-INTEGRATION-CONTRACT.md` endpoints 4 and 5, which are authoritative.
>
> **Shipped as:** FirstHand PR #11 (merge `88ed846`) + Cortex MR !34 (merge `7563f5d`), both on
> `main`. Follow-up fix: FirstHand PR #12 (2026-07-16) — non-latest attempts' recordings 404'd.
>
> **⚠️ This spec's central design recommendation was WRONG.** It proposed Option A ("302-redirect
> to the Blob `objectUrl`") and Option B ("return `objectUrl` directly"). **Both are unworkable:**
> recordings are stored `access: "private"`, so the Blob URL is not publicly fetchable and either
> approach 403s. The shipped design is a third option the spec did not consider — an HMAC-signed
> route that **streams** through FirstHand via the existing `createRecordingAssetResponse`, which
> both works for private objects and hides the underlying storage URL. Do not resurrect Options A
> or B from this document.
>
> **Also superseded:** the "Work breakdown" below sizes work that is done, and the containment
> caveat is now answered — see `docs/FIRSTHAND-KUBERA-MIGRATION-PLAN.md` (decision: move to
> Kubera + S3).

**Original goal (achieved):** let a reviewer watch/listen to a FirstHand session recording
**inside the Cortex Session Review page**, so there is no remaining reason to open FirstHand.

This is the last gap in "native session review". Phase 1 (transcript, per-step responses,
attempt history, recording *metadata*) already shipped — Cortex MR !33 (`f7da840`) +
FirstHand PR #10 (`e293ab6`), both on `main`. Only the actual media playback is stubbed.

---

## Two repos

- **Cortex** (this repo): GitLab `cto/AdaptaLabs`, `/Volumes/Extreme Pro/Labs2`.
  Express+TS backend, React (Vite) SPA. Deployed on Kubera via GitLab CI → ArgoCD.
- **FirstHand**: GitHub `nickfine/FirstHand`, `~/code/FirstHand`. Next.js on Vercel
  (`first-hand.vercel.app`). Use `env -u GITHUB_TOKEN gh …` — an invalid `GITHUB_TOKEN`
  env var shadows the good keyring token.

The contract between them is documented in `docs/FIRSTHAND-INTEGRATION-CONTRACT.md`
(this repo). Recording playback is "endpoint 4"'s reserved `assets[].media_url` field.

---

## Current state (what's already there to build on)

**The field is already reserved end-to-end and returns `null`:**

- FirstHand `src/lib/session-outputs.ts:159` — `buildAssets()` hardcodes `media_url: null`.
- FirstHand `src/app/api/sessions/[sessionId]/outputs/route.ts` — HMAC-authed
  (`verifyIntegrationRequest`, empty-body signature over `${timestamp}\n${body}`), returns
  the assembled outputs incl. the `assets[]` array.
- Cortex proxy `GET /api/opportunities/:id/sessions/:sessionId/outputs`
  (`backend/src/routes/session-outputs.ts`) — owner-or-superadmin, scope-checks the session
  against `opportunity_session_events`, then proxies the FirstHand JSON verbatim.
  **`media_url` passes through automatically** — no backend change needed for passthrough.
- Cortex UI `frontend/src/components/session-review/AssetsSection.tsx` — currently lists each
  asset's filename/size/duration and renders the stub text *"Playback in Cortex is coming in
  a future release."* (line ~45). This is the component to turn into a player.
- Cortex type `FirstHandAssetMeta` (frontend `src/api/types.ts`, mirrored from
  `shared/types/index.ts`) already has `media_url: string | null`.

**FirstHand's asset storage model** (`src/lib/runtime-records.ts`,
`recordingAssetRecordSchema` ~line 73):

```
id, sessionId, fileName, mimeType, fileSizeBytes,
durationSeconds (nullable),
storageProvider: "filesystem" | "vercel_blob",   // prod = vercel_blob
relativePath: string,                            // path/key within the provider
uploadedAt,
objectUrl?: string                               // present for vercel_blob (the Blob URL)
```

There is already a **token + expiry precedent** to mirror for download signing:
`pendingRecordingUploadRecordSchema` (same file) uses `{ token, validUntil }` for upload URLs.

---

## The design decision to make first

`media_url` must let the browser fetch the media **without a reviewer OIDC session on
FirstHand** (reviewers are authenticated in Cortex, not FirstHand). Options:

**Option A — dedicated signed media route on FirstHand (recommended).**
New route e.g. `GET /api/sessions/[sessionId]/assets/[assetId]/media?exp=<ts>&sig=<hmac>`.
The `outputs` endpoint mints `media_url` pointing at this route with a short-lived
HMAC signature (sign `${assetId}\n${exp}` with `FIRSTHAND_INTEGRATION_SECRET`, ~5 min TTL).
The route verifies `sig`+`exp`, then **302-redirects to the Blob** (`objectUrl`) for
`vercel_blob`, or streams the file for `filesystem`.
- Pros: uniform interface across storage providers; expiring + revocable; hides the raw Blob
  URL; symmetric with the existing HMAC scheme.
- Cons: one extra route; a redirect hop (fine for `<video>`).

**Option B — return `objectUrl` directly** (Vercel Blob URLs are public-but-unguessable).
- Pros: zero new routes.
- Cons: leaks the personal Blob store URL to the client, non-expiring, can't revoke, and
  doesn't cover `filesystem`/local dev. Not recommended.

Recommendation: **Option A**. It matches the contract's stated intent ("short-lived signed
URL, HMAC-derived, ~5 min expiry, bypasses reviewer OIDC") and keeps `contract_version: 1.0`
(purely additive — `media_url` goes from `null` to a string).

---

## Work breakdown

### FirstHand (the real work)
1. Add a signing helper (mirror the upload token/expiry pattern) that produces and verifies
   `exp`+`sig` for an asset, keyed on `FIRSTHAND_INTEGRATION_SECRET`.
2. New route `GET /api/sessions/[sessionId]/assets/[assetId]/media` — verify sig/exp (401 on
   bad/expired), resolve the asset, then redirect (vercel_blob) or stream (filesystem).
   404 if asset/session not found; 410 or 401 on expiry.
3. `buildAssets()` in `session-outputs.ts`: replace `media_url: null` with the signed URL
   (absolute, built from the app's base URL). Keep `null` if the asset isn't playable/ready.
4. Tests: signing round-trip, route auth (valid/expired/tampered sig), redirect vs stream,
   and `buildAssets` now emitting a URL. (`session-outputs.test.ts`, plus a route test.)

### Cortex
5. `AssetsSection.tsx`: when `media_url` is present, render a `<video controls>` (or `<audio>`
   for audio mime types) using `media_url`; keep the metadata line; drop the "coming soon"
   text. Fall back to the current metadata-only view when `media_url` is `null`.
6. **Expiry UX**: the signed URL is ~5 min TTL but the review page may sit open longer. Decide:
   simplest is that each page load / outputs fetch returns a fresh URL (good enough for
   click-to-play). If deep linking / long sessions matter, add a "refresh link" affordance or
   re-fetch outputs on play error. Note this as a planning question, don't over-build.
7. Tests: `AssetsSection` renders a player when `media_url` set, metadata-only when `null`;
   correct element for video vs audio mime type.

### Contract + docs
8. Update `docs/FIRSTHAND-INTEGRATION-CONTRACT.md` endpoint 4: `media_url` now populated,
   document the signed media route, its params, TTL, and status codes. Keep
   `contract_version: 1.0`. Add a verification-history entry.

---

## Security / risk notes
- **OIDC bypass is intentional and scoped**: the media route is reachable without a FirstHand
  session, but only via a short-lived HMAC signature that Cortex (owner-or-superadmin, already
  gated in the proxy) hands out. Do not make the media route guessable without a valid sig.
- **Timestamp/expiry**: reuse the ±tolerance discipline from `integration-auth.ts`; keep TTL
  tight (~5 min) since the browser only needs it to start playback.
- **⚠️ Containment**: recordings live in a **personal Vercel Blob store** (see the
  `firsthand-containment` memory + `~/.claude-work/plans/firsthand-containment-runbook.md`).
  Phase 2 deepens reliance on personal infra. Decide whether to ship phase 2 as-is or sequence
  it relative to moving FirstHand to Adaptavist ownership. Flag to Nick during planning.
- HMAC scheme signs `${timestamp}\n${body}` only — path/query are NOT signature-bound on the
  existing endpoints. The new media route MUST bind the assetId+exp into its own signature.

## Key file references
- FirstHand: `src/lib/session-outputs.ts` (`buildAssets`, `media_url`),
  `src/app/api/sessions/[sessionId]/outputs/route.ts`, `src/lib/integration-auth.ts`,
  `src/lib/runtime-records.ts` (`recordingAssetRecordSchema`, `pendingRecordingUploadRecordSchema`),
  `src/lib/runtime-repository.ts`.
- Cortex: `frontend/src/components/session-review/AssetsSection.tsx`,
  `frontend/src/pages/SessionReview.tsx`, `backend/src/routes/session-outputs.ts`,
  `shared/types/index.ts` + `frontend/src/api/types.ts` (`FirstHandAssetMeta`),
  `docs/FIRSTHAND-INTEGRATION-CONTRACT.md`.

## Tests to run
- FirstHand: `cd ~/code/FirstHand && npx vitest run`
- Cortex backend: `cd backend && npm test` (Jest; 187 passing as of 2026-07-15)
- Cortex frontend: `cd frontend && npx vitest run` (92 passing) + `npm run build`

## Ship workflow (both repos, per house rules)
- FirstHand: branch → push (`env -u GITHUB_TOKEN git push`) → `env -u GITHUB_TOKEN gh pr create`.
  Merge FirstHand **first** so the media route is live before Cortex calls it.
- Cortex: branch off `main` → `git push -o merge_request.create -o merge_request.target=main
  -o merge_request.title="…"`. The GitLab token can push+create-via-push-option but 403s on
  API MR create/update and 401s on API merge → set auto-merge in the UI. Trivy on the backend
  image is `allow_failure` — "passed with warnings" is normal.
