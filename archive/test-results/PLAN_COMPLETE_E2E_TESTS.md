# Plan: Complete E2E Tests

**Saved locally in project.** (Cursor plan copy: Complete E2E Tests)

## Current state

- **Automated today**: Production smoke, M6 poll click tracking, admin create study (poll), accessibility, light-mode contrast ([E2E_COVERAGE.md](E2E_COVERAGE.md)).
- **Not automated**: Browse → Book, cancel booking, reschedule, edit opportunity, duplicate, dashboard, settings ([END_TO_END_TESTING_CHECKLIST.md](END_TO_END_TESTING_CHECKLIST.md)).
- **critical-flows.test.ts**: Jest-style + mocked API; not true E2E. Leave as-is; new tests will provide real-API coverage.

## Patterns to reuse

From [e2e/m6-poll-click-tracking.test.ts](e2e/m6-poll-click-tracking.test.ts) and [e2e/superadmin-create-study.test.ts](e2e/superadmin-create-study.test.ts):

- `test.describe` / `test()` from `@playwright/test`.
- `BASE_URL = process.env.BASE_URL || 'http://localhost:3000'`.
- Before any `page.goto()` to an admin or post-login page: `await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));` so AuthContext keeps the session.
- Admin login: `page.goto(\`${BASE_URL}/api/auth/admin-login)` then wait for `/admin` and admin UI.
- Demo user login: `page.goto(\`${BASE_URL}/api/auth/demo-login)` (or equivalent) then wait for redirect/home.
- Generous timeouts (e.g. 15–25s) for URL and selector waits; `scrollIntoViewIfNeeded()` for buttons that may be below the fold.
- Run with real backend + frontend (e.g. `PLAYWRIGHT_NO_WEBSERVER=1` when dev servers already run).

## Test data strategy

- **Booking flow**: Create data in-test. Admin creates a **test** or **interview** opportunity with one future session (start_time tomorrow, capacity ≥ 1), publishes it, then demo user books. No reliance on seed opportunities.
- **Cancel**: Same run as booking: after booking, go to My Bookings and cancel the booking we just created.
- **Edit / Duplicate / Dashboard / Settings**: Use the opportunity or data created in the same test file, or create a minimal opportunity (e.g. poll) and then edit/duplicate it.

## New test files and scope

### 1. [e2e/booking-flow.test.ts](e2e/booking-flow.test.ts) (new)

**Flow 1 – Book then verify in My Bookings**

1. Admin: login → create **test** opportunity (Basic Info + Session Management: one session tomorrow, capacity 2) → publish.
2. Get opportunity ID from admin list or redirect (e.g. from edit URL after create).
3. Demo user: set `loginRedirect`, `page.goto(\`${BASE_URL}/api/auth/demo-login)`, wait for redirect (e.g. home or `/`).
4. Navigate to `/opportunities/:id` (public detail).
5. Wait for calendar or table with a bookable slot (e.g. "Book" button or slot click). Click slot or "Book" for one session; confirm in modal if present (e.g. "Confirm" in [OpportunityDetail.tsx](frontend/src/pages/OpportunityDetail.tsx) ConfirmationModal).
6. Assert success message or no error; navigate to `/my-bookings`.
7. Assert the new booking appears in Upcoming (e.g. opportunity title or session time).

**Flow 2 – Cancel booking**

1. From same run: on My Bookings, find the booking we created, click Cancel, confirm in modal ([MyBookings.tsx](frontend/src/pages/MyBookings.tsx) uses `cancelBooking` and `cancelConfirm` state).
2. Assert booking moves to Past or disappears from Upcoming; optional: assert "Cancelled" or similar.

**Dependencies**: Backend and frontend running; demo user and admin exist (seed). Use unique opportunity title (e.g. `E2E Booking ${Date.now()}`) so the created opportunity is easy to find.

**Selectors**: Use `getByRole('button', { name: /Book|Confirm/i })`, `getByText(/My Bookings|Upcoming/)`, `getByRole('button', { name: /Cancel/i })`, and stable labels from the app (e.g. opportunity title in the booking card).

---

### 2. [e2e/admin-edit-duplicate.test.ts](e2e/admin-edit-duplicate.test.ts) (new)

**Edit opportunity**

1. Admin login (same pattern as M6).
2. Create a draft poll (or use an existing one from list). If creating, go to create page with `loginRedirect` and fill type, title, external link, submit.
3. On admin list, open row dropdown (⋮) for that opportunity → "Edit". Wait for `/admin/opportunities/:id/edit`.
4. Change title (e.g. append " - Edited") or another safe field; go to External Link tab if needed; click "Update Opportunity" (scroll into view if needed).
5. Wait for success; return to admin list and assert the updated title is visible.

**Duplicate opportunity**

1. Same admin session. On admin list, open dropdown for an opportunity → "Copy" (duplicate).
2. Assert a new row appears (or redirect to edit of new draft). Check that the new opportunity has "(copy)" in title or is draft (per [tasks_m6](tasks_m6_polls_surveys.md) / duplicate API behavior).
3. Optional: open the duplicated opportunity edit and assert it is draft and has copied data.

**Selectors**: Reuse admin list patterns from M6: `locator('tr').filter({ has: getByText(uniqueTitle) })`, `button[title="Actions"]`, "Edit", "Copy"; edit form "Update Opportunity" and `#title`, `#status`, etc.

---

### 3. [e2e/admin-dashboard-settings.test.ts](e2e/admin-dashboard-settings.test.ts) (new)

**Dashboard**

1. Admin login; land on `/admin`.
2. Assert at least one of: "Studies", "Bookings", "Users", "Slots" (stats cards from [Admin.tsx](frontend/src/pages/Admin.tsx)) or "Research Studies" tab content.
3. Optional: assert opportunities table is present; filter or search if selectors are stable.

**Settings**

1. From admin, open header profile dropdown → "Settings" (or navigate to `/admin/settings` with `loginRedirect` set).
2. Wait for Settings page (e.g. "Profile" or "Notification Preferences").
3. Assert at least one notification toggle or "Email on Booking" is visible; optional: toggle and assert no error (or assert saved state).

**Selectors**: Header dropdown (e.g. user name or avatar), `Link` or button to Settings; on Settings page use text like "Notification Preferences", "Profile", or labels from [Settings](frontend/src/pages/Settings.tsx).

---

## Reschedule and edge cases

- **Reschedule**: Not in initial scope. Manual run showed Reschedule button disabled in some states; add a dedicated test later if the UI/flow is standardized (e.g. multi-session opportunity and clear Reschedule UX).
- **Edge cases** (full session, past session, multiple bookings, calendar conflict, email, mobile): Remain manual or out of scope for this plan; can be added incrementally.

## critical-flows.test.ts

- **No change** in this plan. It uses Jest `describe`/`it` and mocks; Playwright may not run it by default. New tests above provide real-API coverage for the same flows. Optionally in a follow-up: remove or convert to Playwright style and real API.

## Config and docs

- **Playwright config**: No change. New files live under [e2e/](e2e/) and use existing [playwright.config.ts](playwright.config.ts) (baseURL, webServer, projects). Use `PLAYWRIGHT_NO_WEBSERVER=1` when running with existing dev servers.
- **Docs**: Update [E2E_COVERAGE.md](E2E_COVERAGE.md) to list the new files and which checklist items they cover. Optionally add one-line run commands to [README.md](README.md) or a testing doc (e.g. `playwright test e2e/booking-flow.test.ts --project=chromium`).

## Implementation order

1. **booking-flow.test.ts** – Book + My Bookings + Cancel (highest value, core user journey).
2. **admin-edit-duplicate.test.ts** – Edit and Duplicate (reuses M6/admin patterns).
3. **admin-dashboard-settings.test.ts** – Dashboard and Settings (quick wins, mostly visibility checks).
4. Update **E2E_COVERAGE.md** (and optionally README) to reflect new coverage.

## Risks and mitigations

- **Session loss on navigation**: Mitigated by setting `loginRedirect` before every `page.goto()` that hits an admin or post-login route.
- **No bookable opportunity**: Mitigated by creating a test/interview opportunity with one future session in the booking test.
- **Flaky selectors**: Use role and accessible name first; add short waits and `scrollIntoViewIfNeeded()` for buttons; use unique titles for created data.
- **Demo user vs admin**: Backend seed must provide at least one demo user and one admin (already required for superadmin-create-study and M6).
