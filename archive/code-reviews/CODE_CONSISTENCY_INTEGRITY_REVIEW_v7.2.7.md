# Code Consistency & Integrity Review v7.2.7

**Date:** February 2, 2026  
**Version Reviewed:** 7.2.7 (root, api, frontend, backend)  
**Scope:** api/, backend/, frontend/, shared/ — including M7 dashboard and settings changes

---

## Executive Summary

Consistency and integrity were reviewed across the AdaptaLabs codebase. **Version numbers are aligned** at 7.2.7. **API and Express backend dashboard logic are in parity** (M7: recent_bookings, superadmin global stats). **Role authorization remains consistent** (researcher_admin and superadmin in both API and backend). **Shared types** (User, SessionUser, Booking with reminder_sent_at, ErrorResponse) are in good shape. No critical issues; a few low-priority improvements are noted below.

---

## 1. Version Numbers ✅

| Location            | Version |
|---------------------|--------|
| package.json (root) | 7.2.7  |
| api/package.json    | 7.2.7  |
| frontend/package.json | 7.2.7 |
| backend/package.json  | 7.2.7 |

**Status:** All aligned. No action.

---

## 2. M7 Dashboard — API vs Backend Parity ✅

| Aspect | api/admin/dashboard.ts | backend/src/routes/admin.ts |
|--------|------------------------|-----------------------------|
| Auth   | requireAuth, researcher_admin \|\| superadmin | requireAuth, same role check |
| Filter | filterOwnerId = superadmin ? null : userId | Same |
| SQL    | WHERE ($1::uuid IS NULL OR owner_user_id = $1) | Same |
| recent_bookings | Last 15, same SELECT (b.id, o.title, s.start_time, u.name, u.email, b.status, b.booked_at) | Same |
| Response | { success: true, data: stats } with recent_bookings[] | Same |
| Error  | logger.error + createErrorResponse | asyncHandler (central error handler) |

**Status:** Parity maintained. Backend was updated for M7 (recent_bookings + superadmin global stats) to match API.

---

## 3. Dashboard Types — Consistency ✅

| Location | DashboardStats | RecentBookingItem | recent_bookings |
|----------|----------------|-------------------|------------------|
| api/admin/dashboard.ts | Internal interface | Exported interface | Required in stats |
| backend/src/routes/admin.ts | Internal interface | Internal interface | Required in stats |
| frontend/src/api/client.ts | Exported interface | Exported interface | Optional (backwards compat) |

**Status:** API and backend both return `recent_bookings`; frontend treats it as optional so older API responses still work. No shared type for dashboard (API-specific); duplication is acceptable.

---

## 4. Role Authorization ✅

- **Admin routes:** Both API and backend require `user.role === 'researcher_admin' || user.role === 'superadmin'` for dashboard, opportunities, sessions, etc.
- **Superadmin-only:** reset-keep-two-users, set-superadmin, admin requests (list/approve/deny), admins (list/revoke) use `user.role === 'superadmin'` (or parseSessionCookie + superadmin check).
- **Google callback:** SessionUser role type includes `'superadmin'` (fixed in v7.2.6).

**Status:** Consistent. No action.

---

## 5. Shared Types ✅

- **User / SessionUser:** role is `'employee' | 'researcher_admin' | 'superadmin'` in shared/types and frontend copy.
- **Booking:** includes `reminder_sent_at?: string` in shared/types/index.ts.
- **ErrorResponse:** error, details?, code?, timestamp, requestId? — used by API createErrorResponse; backend imports type but often returns minimal `{ error: string }` (see §6).
- **Opportunity:** includes display_width, start_date, end_date, clicks_total; type union includes unmoderated.

**Status:** Consistent. No action.

---

## 6. Error Response Shape (Known Difference)

| Layer | Shape | Notes |
|-------|--------|--------|
| API (Vercel) | createErrorResponse → ErrorResponse (error, timestamp, details?, code?, requestId?) | Full shape |
| Backend (Express) | res.status(x).json({ error: string }) | Minimal shape |

Frontend handles both (e.g. `response.data.error` as string). Backend could adopt createErrorResponse/ErrorResponse for consistency; not required for correctness.

**Recommendation:** (Low) Optionally align backend admin/auth error responses to ErrorResponse shape over time.

---

## 7. Logging — Console vs Logger ✅ (Partial)

- **User-facing API routes** (feedback, sessions, click, feedback export/delete, dashboard): use `logger` (info/error). ✅
- **Admin / operational scripts** (reset-demo-data*, reset-keep-two-users, reset-production-db, run-migrations): use console for operational visibility. ✅ Acceptable.
- **Other API handlers** still using console in catch blocks: set-superadmin, admins, requests, request, requests/[id]/approve, requests/[id]/deny, notification-preferences, calendar/availability, calendar/events, gamification/leaderboard/monthly, seed-demo-user-2.

**Recommendation:** (Low) Use logger in api/admin/set-superadmin.ts, api/admin/admins.ts, api/admin/requests.ts, api/admin/request.ts, api/admin/requests/[id]/approve.ts, api/admin/requests/[id]/deny.ts for catch-block errors so all non-script API routes use logger. Leave reset/migration scripts as-is.

---

## 8. Settings Profile (M7) ✅

- **Settings.tsx:** Account tab shows Profile (name, email, role) for all authenticated users; Admin Management only for superadmin. Uses `user` from AuthContext (SessionUser); no new types.
- **Notification Preferences:** Existing toggles (on_book_email, on_cancel_email) unchanged.

**Status:** Consistent with shared User/SessionUser. No action.

---

## 9. Frontend API Client ✅

- getDashboardStats: `api.get('/admin/dashboard')` → `response.data.data` (matches API and backend response shape).
- DashboardStats and RecentBookingItem defined in client; recent_bookings optional.

**Status:** Correct. No action.

---

## 10. Vercel and Auth ✅

- vercel.json: rewrites for /auth/demo-login, admin-login, logout, google-login, google-callback. Logout accepts GET and POST (api/auth/logout.ts).
- Auth routes use parseSessionCookie or requireAuth; role checks as above.

**Status:** No issues.

---

## Positive Observations

- **M7 parity:** Dashboard API and Express backend implement the same stats and recent_bookings logic and superadmin global filter.
- **Versions:** All packages at 7.2.7.
- **Types:** Shared types (User, SessionUser, Booking, ErrorResponse, Opportunity) are consistent; Booking includes reminder_sent_at.
- **Security:** Session cookie signing, role validation, CRON_SECRET for cron; admin/superadmin separation clear.
- **Frontend:** Single source for dashboard types in client; optional recent_bookings avoids breakage with older backends.

---

## Recommended Next Steps (Optional)

1. **Logger in admin API routes:** Replace console.error in catch blocks in set-superadmin, admins, requests, request, requests/[id]/approve, requests/[id]/deny with logger.error (same pattern as feedback/sessions/dashboard).
2. **Backend error shape:** Optionally use ErrorResponse/createErrorResponse in Express admin/auth routes for consistency with API.
3. **Shared dashboard types:** If desired, move DashboardStats and RecentBookingItem to shared/types and import from api and frontend to avoid drift (low priority).

---

## Conclusion

The codebase is **consistent and intact** for v7.2.7. Version alignment, M7 dashboard parity (API + backend), role checks, and shared types are in good shape. Remaining items are optional improvements (logger in a few admin routes, backend error shape, shared dashboard types). No blocking issues.
