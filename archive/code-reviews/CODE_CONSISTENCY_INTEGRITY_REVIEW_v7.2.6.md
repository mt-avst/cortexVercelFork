# Code Consistency & Integrity Review v7.2.6

**Date:** February 2, 2026  
**Version Reviewed:** 7.2.6 (root); backend 7.1.7; frontend 7.1.7; api 7.1.6  
**Status:** Critical issues identified; fixes applied below

---

## Executive Summary

This review assessed consistency and integrity across the AdaptaLabs codebase (api/, backend/, frontend/, shared/). **Role authorization is consistent** (researcher_admin and superadmin checked in both backend and API). **Version numbers are out of sync** and one **type assertion in the API omits superadmin**. Recommended fixes: align package versions to 7.2.6, correct the Google callback SessionUser role type, and optionally add `reminder_sent_at` to the shared Booking type.

---

## Critical Issues

### 1. Version Number Inconsistency

| Location | Current | Recommended |
|----------|--------|-------------|
| `package.json` (root) | 7.2.6 | 7.2.6 ✓ |
| `backend/package.json` | 7.1.7 | 7.2.6 |
| `frontend/package.json` | 7.1.7 | 7.2.6 |
| `api/package.json` | 7.1.6 | 7.2.6 |

**Action:** Align backend, frontend, and api package.json `version` to 7.2.6.

---

### 2. Google OAuth Callback – SessionUser Role Type Omits superadmin

**File:** `api/auth/google-callback.ts`

**Problem:** SessionUser is built with `role: userRole as 'employee' | 'researcher_admin'`. The database can return `userRole === 'superadmin'`; the redirect logic correctly checks `sessionUser.role === 'superadmin'`, but the type assertion excludes it, which is inconsistent and can confuse tooling.

**Fix:**
```typescript
role: userRole as 'employee' | 'researcher_admin' | 'superadmin',
```

---

### 3. Shared Booking Type Missing reminder_sent_at (Low)

**File:** `shared/types/index.ts`

**Problem:** The API and migrations use a `reminder_sent_at` column on bookings (cron send-reminders, run-migrations). The shared `Booking` interface does not declare this optional field, so type integrity between API responses and shared types is incomplete.

**Fix:** Add to `Booking`:
```typescript
reminder_sent_at?: string; // ISO timestamp when reminder email was sent
```

---

## Medium / Low Priority

### 4. Duplicate API Implementations (Known)

- **Express backend** (`backend/src/routes/`) – local development.
- **Vercel API** (`api/`) – production.

**Status:** Both correctly enforce researcher_admin and superadmin. Parity is maintained; continue to verify on changes.

---

### 5. Frontend Shared Constants vs Root shared/

- **Root:** `shared/constants/index.ts` – includes deprecated `API_CONFIG.TIMEOUT`.
- **Frontend:** `frontend/src/shared/constants.ts` – marked AUTO-GENERATED; uses `TIMEOUT_MS` only.

**Recommendation:** Treat root `shared/constants` as source of truth. Ensure any build/copy step keeps frontend in sync, or have frontend import from shared via build config. Remove deprecated `TIMEOUT` from shared when no longer referenced.

---

### 6. Use of `any` (Ongoing)

- **Acceptable:** Test utilities, demo mocks, Express middleware signatures, type guards `(obj: any)`.
- **Tighten over time:** API row serialization (`as any`), error handlers (`error: any`), backend calendar service (`auth: any`, `calendar: any`). Prefer `unknown` and type narrowing where practical.

---

### 7. Vercel Auth Rewrites

`vercel.json` rewrites map `/auth/demo-login`, `/auth/admin-login`, `/auth/logout`, `/auth/google-login`, `/auth/google-callback`. Frontend uses `/api/auth/superadmin-login` directly; no rewrite needed. If you later add a route like `/auth/superadmin-login`, add a matching rewrite.

---

## Positive Observations

- **Role authorization:** Backend and API consistently require `researcher_admin` or `superadmin` for admin-only routes; superadmin-only routes are clearly separated.
- **Shared types:** User, SessionUser, Opportunity, Session, Booking, ErrorResponse, etc. are centralized in `shared/types` and used by api and frontend (frontend copy kept in sync).
- **Constants:** USER_ROLES, OPPORTUNITY_TYPES, BOOKING_STATUSES, etc. include all required values (superadmin, interview, etc.) in `shared/constants`.
- **Error handling:** API uses `createErrorResponse` and shared `ErrorResponse`; backend uses AppError and compatible patterns.
- **Security:** Session cookie signing (HMAC), CRON_SECRET for cron, role validation in parseSessionCookie.

---

## Fixes Applied This Review

1. Align `backend/package.json`, `frontend/package.json`, and `api/package.json` version to **7.2.6**.
2. In `api/auth/google-callback.ts`, set SessionUser `role` type to `'employee' | 'researcher_admin' | 'superadmin'`.
3. In `shared/types/index.ts`, add optional `reminder_sent_at?: string` to `Booking`.

---

## Recommended Next Steps

1. Re-run E2E and smoke tests after version and type changes.
2. Document or automate the frontend “copy shared types/constants” step so drift is visible.
3. Consider adding `reminder_sent_at` to any frontend type that mirrors Booking (e.g. BookingWithDetails) if the API starts returning it in list/detail responses.

---

## Conclusion

The codebase is consistent on auth, roles, and shared types. The main corrections are **version alignment**, **Google callback role type**, and **Booking type completeness** for `reminder_sent_at`. After applying the fixes above, integrity and consistency are in good shape for v7.2.6.
