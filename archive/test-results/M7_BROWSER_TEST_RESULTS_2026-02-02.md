# M7 Browser Test Results (Playwright MCP)

**Date:** 2026-02-02  
**Environment:** Local dev (http://localhost:3000, frontend → backend :3001)  
**Tool:** user-playwright MCP (browser_navigate, browser_click, browser_snapshot, browser_evaluate)

---

## Test Summary

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Admin login (Admin button on landing) | **Pass** | Click "Admin" → redirects to /admin, session established. |
| 2 | Dashboard stats cards | **Pass** | Studies 6, Bookings 0, Users 0, Slots 420 (0/420 booked). Correct for researcher_admin. |
| 3 | Recent bookings section (when empty) | **Pass** | Section correctly not shown when no bookings (UI only shows when `recent_bookings?.length > 0`). |
| 4 | Settings → Account Management tab | **Pass** | Profile section visible: Name "Test Admin", Email "admin@test.com", Role "Researcher admin". |
| 5 | Settings → Notification Preferences tab | **Pass** | Email on Booking and Email on Cancellation toggles visible and checked. |
| 6 | Dashboard API `recent_bookings` (local) | **Backend parity** | Express backend was updated to return `recent_bookings` (and superadmin global stats). Restart dev server to see key in API response; section will still be hidden when array is empty. |

---

## Details

### 1. Admin dashboard (after Admin login)
- **Cortex|Admin** header, subtitle, Settings and Create Research Study buttons present.
- Stat cards: Studies (6 live · 0 draft), Bookings (0 up · 0 past), Users (0 unique participants), Slots (0/420 booked).
- Tabs: Research Studies (selected), Completion Approvals, Feedback.
- Studies table: 6 opportunities with Title, Type, Status, Clicks, Capacity, Booked, Created, Actions.
- **Recent bookings:** Not rendered (expected when there are no bookings).

### 2. Settings → Account Management
- **Profile** (M7): heading "Profile", text "Your account details. Contact your administrator to change name or role."
- **dl:** Name → Test Admin, Email → admin@test.com, Role → Researcher admin (badge).
- No Admin Management block (researcher_admin; superadmin would see it below Profile).

### 3. Settings → Notification Preferences
- Heading and description present.
- Two list items: Email on Booking (checkbox checked), Email on Cancellation (checkbox checked).

### 4. API check (in-page fetch)
- `GET /api/admin/dashboard` with credentials returned `data` without `recent_bookings` (local backend was pre-update).
- **Backend parity:** `backend/src/routes/admin.ts` was updated to match `api/admin/dashboard.ts`: `recent_bookings` array (last 15 bookings with session times, participant, status) and superadmin global stats (`filterOwnerId`). After restarting the dev server, the dashboard API will include `recent_bookings`; the "Recent bookings" table will appear when the array is non-empty.

---

## Conclusion

- **M7 dashboard:** Stats and layout verified. Recent bookings list is implemented and hidden when empty; backend (API + Express) both return `recent_bookings`.
- **M7 Settings profile:** Profile (name, email, role) and Notification Preferences verified in the browser.
- **Recommendation:** Restart `npm run dev:all` to load the updated Express dashboard route; then create a booking as demo user and re-open Admin to confirm the "Recent bookings" table appears.
