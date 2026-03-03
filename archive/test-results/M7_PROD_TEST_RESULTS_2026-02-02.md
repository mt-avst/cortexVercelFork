# M7 Production Test Results

**Date:** 2026-02-02  
**Target:** https://adapta-labs-p62q.vercel.app  
**Tool:** user-playwright MCP (browser_navigate, browser_evaluate)

---

## Summary

Production was tested without an authenticated session (no demo Admin button on prod landing; login requires Google OAuth or configured demo). **API behaviour and auth guards are correct.** Logout GET works on prod.

---

## Tests Run

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Unauthenticated /admin | **Pass** | Redirects to home (/) after loading. |
| 2 | GET /api/health | **Pass** | 200, body `{ "ok": true }`. |
| 3 | GET /api/me (no cookie) | **Pass** | 401 — auth required. |
| 4 | GET /api/admin/dashboard (no cookie) | **Pass** | 401 — admin access required. |
| 5 | GET /api/auth/logout | **Pass** | 200, body `{ "success": true }` — logout GET works on prod. |

---

## M7 UI on Prod (requires login)

- **Dashboard (recent bookings, stats):** Not exercised — requires admin session. Once logged in as admin, expect same behaviour as local: stats cards and “Recent bookings” section when there are bookings.
- **Settings → Profile:** Not exercised — requires authenticated user. Once logged in, Account tab should show Profile (name, email, role) and Notification Preferences.

To fully verify M7 UI on prod: log in (Google OAuth or enable demo login on prod), then open /admin and /admin/settings and confirm dashboard stats, Recent bookings (if any), and Profile section.

---

## Conclusion

- Production API is up (health 200).
- Auth guards behave correctly (401 for /api/me and /api/admin/dashboard when not logged in).
- Unauthenticated /admin redirects to home.
- **Logout GET works on production** (200, `{ success: true }`).

No issues found. M7 backend behaviour is consistent with expectations; full M7 UI check on prod requires an authenticated session.

---

## Full M7 UI Test (after login)

User logged in via Google OAuth (nfine@adaptavist.com). Tests run:

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Admin page load (logged in) | **Partial** | Page loads; dashboard API returned 500 (see fix below). |
| 2 | Settings → Profile | **Pass** | Name Nick Fine, Email nfine@adaptavist.com, Role Superadmin. |
| 3 | Settings → Admin Management | **Pass** | All Admins (1), table with Nick Fine. |
| 4 | Settings → Notification Preferences | **Pass** | Email on Booking and Email on Cancellation toggles visible and checked. |
| 5 | GET /api/admin/dashboard (with cookie) | **500 → Fixed** | Error: `column b.booked_at does not exist`. Bookings table uses `created_at`. |

**Fix applied:** Dashboard query used `b.booked_at`; prod `bookings` table has `created_at` only. Updated `api/admin/dashboard.ts` and `backend/src/routes/admin.ts` to use `b.created_at as booked_at` and `ORDER BY b.created_at DESC`. **Redeploy** for dashboard to work on prod.
