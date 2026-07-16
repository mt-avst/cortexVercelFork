# Cortex ↔ FirstHand Integration Contract

Authoritative specification for the integration between Cortex (this repo) and FirstHand
(`~/code/FirstHand`). Both apps must satisfy this contract. Update both when the contract
changes.

---

## Overview

Cortex exposes "unmoderated" research opportunities that are backed by FirstHand studies.
When a participant clicks "Start Test", Cortex creates a FirstHand session (via a signed
API call), redirects the participant into FirstHand, and receives lifecycle webhook callbacks
as the session progresses. Researchers see session events and deep links in the Cortex
analytics UI.

## Authentication — HMAC-SHA256

All server-to-server calls between Cortex and FirstHand are authenticated with a shared
HMAC-SHA256 secret. **The same secret and scheme is used in both directions.**

### Shared env var

Both apps must have the same value for:

```
FIRSTHAND_INTEGRATION_SECRET=<min-32-char random string>
```

Cortex: read by `backend/src/utils/firsthand-client.ts` and `backend/src/routes/firsthand.ts`.
FirstHand: read by `src/lib/integration-auth.ts`.

### Signature scheme

```
timestamp  = String(Date.now())           // unix milliseconds as a string
body       = JSON string of request body  // "" (empty string) for GET requests
signature  = HMAC-SHA256(secret, `${timestamp}\n${body}`).digest("hex")
```

Headers sent with every authenticated request:

| Header | Value |
|---|---|
| `x-firsthand-signature` | hex-encoded HMAC |
| `x-firsthand-timestamp` | unix ms timestamp |

### Verification

- Both apps verify using `timingSafeEqual`.
- Timestamp must be within **±5 minutes** of the receiving server's clock.
- Requests with a missing signature, missing timestamp, or stale/future timestamp are rejected with `401`.

---

## Endpoints

### 1. GET /api/studies (FirstHand → Cortex proxies this)

Cortex backend calls this to populate the study picker for researchers.

**Caller:** `backend/src/routes/firsthand.ts` via `firsthand-client.ts:firstHandGet('/api/studies')`
**Auth:** HMAC (Cortex signs an empty body)

**Response 200:**
```json
{
  "studies": [
    {
      "id": "study_abc",
      "title": "Homepage navigation test",
      "intro_text": "...",
      "consent_text": "...",
      "brand_name": "Acme",
      "estimated_duration_minutes": 15,
      "locale": "en-GB",
      "status": "launched",
      "created_at": "2026-06-01T10:00:00.000Z",
      "updated_at": "2026-06-10T12:00:00.000Z"
    }
  ]
}
```

**Status codes:** `200` (including when persistence is not configured, in which case FirstHand returns `200 { studies: [] }` rather than `503`), `401` (bad/missing HMAC)

**Cortex type:** `FirstHandStudy` in `shared/types/index.ts` — flat object matching the above shape. The study list does **not** include step details.

**Filtering:** Cortex shows only studies with `status === 'launched'` in the study picker (`FirstHandStudyTab.tsx`).

---

### 2. POST /api/sessions (Cortex → FirstHand)

Cortex calls this to create a participant session when "Start Test" is clicked.

**Caller:** `backend/src/routes/opportunities.ts` via `firsthand-client.ts:firstHandPost('/api/sessions', ...)`
**Auth:** HMAC (Cortex signs the JSON body)

**Request body:**
```json
{
  "study_id": "study_abc",
  "participant": {
    "participant_id": "<cortex-user-uuid>",
    "display_name": "Jane Smith",
    "email": "jane@example.com",
    "external_ref": "<cortex-opportunity-uuid>"
  },
  "callback_url": "https://cortex.example.com/api/firsthand/callbacks",
  "return_url": "https://cortex.example.com/opportunities/<id>?completed=1",
  "expires_in_minutes": 1440
}
```

| Field | Required | Notes |
|---|---|---|
| `study_id` | yes | must exist in FirstHand |
| `participant.participant_id` | yes | Cortex user UUID |
| `participant.display_name` | no | shown in FirstHand reviewer |
| `participant.email` | no | valid email |
| `participant.external_ref` | no | Cortex opportunity UUID; FirstHand echoes this back in callbacks |
| `callback_url` | no | URL to send lifecycle events to; must be reachable by FirstHand |
| `return_url` | no | redirect URL after session completion |
| `expires_in_minutes` | no | default 1440 (24 hours), max 20160 (14 days) |

**Response 201:**
```json
{
  "session_id": "session_<uuid>",
  "session_token": "fh_<base64url>",
  "session_url": "https://firsthand.example.com/session/fh_<base64url>",
  "expires_at": "2026-06-30T10:00:00.000Z"
}
```

Cortex uses only `session_url` and redirects the participant to it (`window.location.assign`).

**Error codes:** `400` (invalid payload / study has no steps), `401` (HMAC failure), `404` (study not found), `503` (persistence not configured)

---

### 3. POST /api/firsthand/callbacks (FirstHand → Cortex)

FirstHand POSTs this to Cortex when a participant session transitions state.

**Receiver:** `backend/src/routes/firsthand.ts:POST /callbacks`
**Auth:** HMAC (FirstHand signs the JSON body using the shared secret)

**Request body:**
```json
{
  "event": "session_completed",
  "session_id": "session_<uuid>",
  "participant_id": "<cortex-user-uuid>",
  "external_ref": "<cortex-opportunity-uuid>",
  "occurred_at": "2026-06-29T11:45:30.000Z",
  "session_status": "completed"
}
```

| Field | Notes |
|---|---|
| `event` | one of `session_started`, `session_completed`, `session_abandoned`, `session_failed` |
| `session_id` | FirstHand logical session ID |
| `participant_id` | echoes back `participant.participant_id` from session creation |
| `external_ref` | echoes back `participant.external_ref` (Cortex opportunity UUID); used to key the DB insert |
| `occurred_at` | ISO 8601 |
| `session_status` | current status at time of event — informational, not stored by Cortex |

**Delivery:** best-effort, no retry. Cortex always responds `200 { "received": true }` to prevent FirstHand from retrying. Dedup is enforced server-side via `UNIQUE (firsthand_session_id, event_type)`.

**Cortex validation:**
- Rejects unknown `event` values with `400 { error: "unknown_event_type" }`.
- Skips DB insert (but still returns 200) if `external_ref` is absent.
- DB errors are logged and swallowed to preserve the 200 response.

---

### 4. GET /api/sessions/:sessionId/outputs (Cortex → FirstHand)

Cortex calls this to fetch a session's outputs — transcript, per-step participant responses,
attempt history and recording asset metadata — for native display in the Cortex Session Review
UI.

**Caller:** `backend/src/routes/session-outputs.ts` via `firsthand-client.ts:firstHandGet(...)`
**Receiver:** FirstHand `src/app/api/sessions/[sessionId]/outputs/route.ts`
**Auth:** HMAC (Cortex signs an empty body, same as `GET /api/studies`)

> Note: the HMAC scheme signs `${timestamp}\n${body}` only — the URL path and query string
> are not signature-bound. This matches the existing `GET /api/studies` contract; TLS, the
> shared secret and the ±5 minute timestamp tolerance are the mitigations.

**Path parameter:** the **logical session id** — the same `session_id` value delivered in
lifecycle callbacks (endpoint 3). Resolves to the latest attempt by default.

**Query parameters:** `attempt=N` (optional, positive integer) selects a specific attempt.

**Response 200:**
```json
{
  "contract_version": "1.0",
  "session": {
    "session_id": "session_abc--attempt-002",
    "logical_session_id": "session_abc",
    "attempt_number": 2,
    "study_id": "study_123",
    "study_title": "Checkout flow study",
    "participant": { "participant_id": "<cortex-user-uuid>", "display_name": "Jane Smith" },
    "session_status": "completed",
    "started_at": "2026-07-15T10:00:00.000Z",
    "completed_at": "2026-07-15T10:14:30.000Z",
    "transcript_status": "complete",
    "transcript_failure_message": null
  },
  "attempts": [
    {
      "attempt_number": 2,
      "session_id": "session_abc--attempt-002",
      "session_status": "completed",
      "started_at": "2026-07-15T10:00:00.000Z",
      "completed_at": "2026-07-15T10:14:30.000Z",
      "transcript_status": "complete"
    }
  ],
  "steps": [
    {
      "step_id": "step_1",
      "order": 1,
      "type": "open_text",
      "prompt": "How did you find the checkout?",
      "response": {
        "text": "It was straightforward.",
        "selected_option": null,
        "saved_at": "2026-07-15T10:05:00.000Z"
      }
    }
  ],
  "transcript": {
    "body": "Full transcript text...",
    "created_at": "2026-07-15T10:14:35.000Z",
    "source": "prototype_generated",
    "segments": [
      {
        "id": "seg_1",
        "step_id": "step_1",
        "speaker": "participant",
        "speaker_label": "Jane Smith",
        "text": "It was straightforward.",
        "timestamp": "2026-07-15T10:05:00.000Z"
      }
    ]
  },
  "assets": [
    {
      "asset_id": "asset_1",
      "file_name": "recording.webm",
      "mime_type": "video/webm",
      "file_size_bytes": 10485760,
      "duration_seconds": 870,
      "uploaded_at": "2026-07-15T10:14:20.000Z",
      "media_url": "https://firsthand.example.com/api/sessions/session_abc--attempt-002/assets/asset_1/media?exp=1752573600000&sig=<hmac>"
    }
  ]
}
```

**Semantics:**

- Steps are returned in authored order with the participant's response merged in;
  `response: null` means the step was not answered (e.g. abandoned mid-session).
- A transcript that is not ready is **not** an error: the response is `200` with
  `transcript: null` and the live `transcript_status`
  (`not_requested | queued | processing | complete | failed`).
- `assets[].media_url` carries a short-lived **signed media URL** (see endpoint 5) that lets
  the reviewer's browser play the recording inline, bypassing reviewer OIDC. It is populated
  for audio/video assets when FirstHand's integration secret is configured, and `null`
  otherwise (or for non-playable assets). `contract_version` remains `1.0` — the field was
  reserved from the outset, so populating it is additive.

**Status codes:** `200`, `400` (invalid `attempt`), `401` (HMAC failure), `404`
(`session_not_found`), `503` (integration not configured)

**Cortex proxy:** `GET /api/opportunities/:id/sessions/:sessionId/outputs` — restricted to
the opportunity owner or a superadmin, and verifies the session id appears in
`opportunity_session_events` for that opportunity before proxying.

**Cortex types:** `FirstHandSessionOutputs` and friends in `shared/types/index.ts`
(mirrored in `frontend/src/shared/types.ts`).

---

### 5. GET /api/sessions/:sessionId/assets/:assetId/media (browser → FirstHand)

The signed media route referenced by `assets[].media_url` in endpoint 4. It streams a
session recording directly to the reviewer's browser (via a `<video>`/`<audio>` element in
the Cortex Session Review page) **without a FirstHand reviewer OIDC session**.

**Receiver:** FirstHand `src/app/api/sessions/[sessionId]/assets/[assetId]/media/route.ts`
**Caller:** the reviewer's browser (URL minted by endpoint 4 and proxied through Cortex).
**Auth:** short-lived HMAC signature bound to the asset (**not** the `${timestamp}\n${body}`
request-auth scheme).

**Path parameters:** `sessionId` is the **physical** attempt session id (the asset's own
`session_id`, as embedded in the minted URL); `assetId` is the asset id.

> **Attempt-1 collision (important).** Attempt 1's physical `session_id` *is* the
> `logical_session_id` — they are the same string. Resolving that id alone returns the **latest**
> attempt, so an older attempt's recordings are not reachable by a naive per-session lookup. The
> route therefore resolves the asset across **all attempts of the logical session**. Fixed in
> FirstHand PR #12 (2026-07-16); before that, every non-latest attempt's `media_url` was minted
> and advertised but 404'd on fetch. Filesystem mode only — the Postgres repository matched
> `recording_assets` on the concrete `session_id` and was unaffected.

**Query parameters:**

| Param | Notes |
|---|---|
| `exp` | absolute expiry, unix ms. TTL ~15 minutes from minting — deliberately longer than the ±5 min request-auth tolerance so the URL stays valid across playback of a full recording. |
| `sig` | `HMAC-SHA256(FIRSTHAND_INTEGRATION_SECRET, ` `` `${assetId}\n${exp}` `` `).digest("hex")`. Binds the asset id and expiry so a URL cannot be retargeted to another asset. |

**Behaviour:** verifies `sig`/`exp`, resolves the asset, then **streams** the bytes with the
asset's `Content-Type` (works for both private Vercel Blob and filesystem storage). It does
**not** redirect to the raw Blob URL — recordings are stored with `access: "private"`, so the
Blob URL is not publicly fetchable; streaming through this route both works and hides it.

**Status codes:** `200` (streamed media), `401` (missing/expired/tampered signature), `404`
(asset or session not found, or unreadable), `503` (integration secret not configured).

**Security:** the OIDC bypass is intentional and scoped — the route is reachable only with a
valid short-lived signature that Cortex (already owner/superadmin gated on endpoint 4) hands
to the browser. `sig` binds the **asset id**, so a leaked URL grants time-boxed access to exactly
one recording and nothing else: altering `assetId` invalidates the signature and returns `401`
before any lookup runs. The asset search is scoped to the attempts of the **logical session**
named in the path (see the attempt-1 note above) — all of which belong to the same participant
and study, and all of which endpoint 4 already exposes to the same reviewer, so this does not
widen reach.

**Cortex UI:** `frontend/src/components/session-review/AssetsSection.tsx` renders a
`<video>`/`<audio>` player from `media_url`. Because the URL is short-lived, a playback error
re-fetches the outputs once (minting a fresh URL) before offering a manual reload.

---

## Reviewer deep links

Cortex synthesises review URLs from `FIRSTHAND_BASE_URL`:

| Purpose | URL pattern |
|---|---|
| Review a specific session | `${FIRSTHAND_BASE_URL}/review/session/${firsthand_session_id}` |
| Review all sessions for a study | `${FIRSTHAND_BASE_URL}/review/study/${study_id}` |

These are shown in the `OpportunityAnalytics` Sessions tab.

---

## Return flow

After a session completes, FirstHand redirects the participant to the `return_url` provided
at session creation. Cortex sets `return_url = ${FRONTEND_URL}/opportunities/<id>?completed=1`.
`OpportunityDetail.tsx` reads `?completed=1` and shows a completion banner.

> **Note (2026-07-02):** Confirmed implemented on the FirstHand side. FirstHand's
> `participant-session-flow.tsx` redirects via `window.location.assign(returnUrl)` after a
> 3-second countdown when the session reaches `completed`/`declined` (added FirstHand-side
> commit `3135d6e`, 2026-06-09). Participants are automatically returned to Cortex after
> completing a study.

---

## Environment variables

### Cortex (this repo)

| Variable | Required | Description |
|---|---|---|
| `FIRSTHAND_BASE_URL` | no (disables integration when absent) | Base URL of the FirstHand deployment |
| `FIRSTHAND_INTEGRATION_SECRET` | no (disables integration when absent) | Shared HMAC secret (min 32 chars) |
| `BACKEND_URL` | no (defaults to `http://localhost:3001`) | Used to build `callback_url` |
| `FRONTEND_URL` | no (defaults to `http://localhost:3000`) | Used to build `return_url` |

### FirstHand (other repo)

| Variable | Required | Description |
|---|---|---|
| `FIRSTHAND_INTEGRATION_SECRET` | yes (for integration) | Must match Cortex's value |

---

## Verification history

- **2026-07-16 (endpoint 5 fix):** Recordings from any attempt **other than the latest** were
  advertised with a `media_url` that 404'd — Cortex rendered a player that could never load.
  Root cause: `getRuntimeAsset` resolved the session by id alone, and attempt 1's physical
  `session_id` is also the `logical_session_id`, so the lookup landed on the latest attempt (which
  does not own the older attempt's asset ids). Fixed by resolving the asset across every attempt of
  the logical session; this also fixes the pre-existing reviewer route
  `/api/review/session/:sessionId/asset/:assetId`, which shares the same resolver.
  **Filesystem mode only — production (Postgres) was never affected**, because the Postgres
  repository matches `recording_assets` on the concrete `session_id`. The two backends had
  silently disagreed on the same call. FirstHand PR #12. Found by an end-to-end run against a
  real two-attempt session; the unit suite missed it because it mocked the repository.
- **2026-07-15 (phase 2):** Populated `assets[].media_url` and added endpoint 5
  (`GET /api/sessions/:sessionId/assets/:assetId/media`) — a signed, streaming media route so
  reviewers play recordings inside Cortex without opening FirstHand. HMAC binds `assetId`+`exp`,
  ~15 min TTL; streams private Blob or filesystem via the existing `createRecordingAssetResponse`.
  FirstHand PR #11, Cortex MR (this change). `contract_version` unchanged (`1.0`, additive).
- **2026-07-15:** Added endpoint 4 (`GET /api/sessions/:sessionId/outputs`) for native session
  review in Cortex — transcript and responses in phase 1, `media_url` reserved for phase 2 video.
  Cortex `GET /:id/session-events` tightened from any-authenticated to owner-or-superadmin to
  match the analytics endpoint.
- **2026-07-03:** Full audit of this contract against actual FirstHand source (not the FirstHand-side `CORTEX_INTEGRATION_PLAN.md`, which is historical/pre-implementation). All six areas — HMAC auth, `GET /api/studies`, `POST /api/sessions` (including `callback_url`/`return_url`, confirmed read and used), FirstHand → Cortex callbacks, return-flow redirect, and env var naming — confirmed matching. Two doc-only corrections applied from this pass: the `/api/studies` status-code claim above, and a missing `.env.example` entry on the FirstHand side.

## Assumptions / open items

- ~~Callback delivery is best-effort from FirstHand. There is no retry, so transient Cortex downtime will result in missed events. A future improvement could add a retry queue on the FirstHand side.~~
  **Resolved 2026-07-05:** FirstHand PR #9 adds a `callback_outbox` retry queue.
  Failed deliveries (thrown or non-2xx) are persisted and retried by the maintenance cron with exponential backoff (1m base, x4, 24h cap, abandoned after 8 attempts), re-signing the HMAC timestamp per attempt.
  Cortex's `(firsthand_session_id, event_type)` unique index makes redelivery idempotent.
  Deploy order: run FirstHand migration 0006 before deploying the PR.
- `return_url` redirect in the FirstHand participant UI is implemented (see note above).
- The HMAC scheme is symmetric — the same secret and algorithm is used in both directions. Secret rotation requires a coordinated update to both deployments.
