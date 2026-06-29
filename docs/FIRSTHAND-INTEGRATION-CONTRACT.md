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

**Status codes:** `200`, `401` (bad/missing HMAC), `503` (persistence not configured → returns `{ studies: [] }`)

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

> **Note (2026-06-29):** The `return_url` redirect is not yet wired in the FirstHand participant
> UI. Until it is, participants are not automatically returned to Cortex after completing a study.
> Track this as an open item in the FirstHand repo.

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

## Assumptions / open items

- Callback delivery is best-effort from FirstHand. There is no retry, so transient Cortex downtime will result in missed events. A future improvement could add a retry queue on the FirstHand side.
- `return_url` redirect in the FirstHand participant UI is not yet implemented (see note above).
- The HMAC scheme is symmetric — the same secret and algorithm is used in both directions. Secret rotation requires a coordinated update to both deployments.
