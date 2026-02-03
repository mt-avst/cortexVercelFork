# E2E Test Coverage

**Short answer:** We have **not** completed all end-to-end tests. Several checklist flows are only manually verified or run once; a few are covered by automated tests.

---

## ✅ What *is* automated (Playwright)

| Test file | What it covers | Notes |
|-----------|----------------|-------|
| **production-smoke.test.ts** | Home load, opportunities list, opportunity detail link, feedback page, no console errors, perf, API health, demo hidden on prod | Runs vs prod; some tests skip when no data |
| **superadmin-create-study.test.ts** | Admin login → Create poll → Submit → See in admin list | Real API; `npm run test:admin-create-study` |
| **m6-poll-click-tracking.test.ts** | Admin create poll → Publish → Public detail → Click "Open Poll" → Verify POST /click returns 200 | Real API; 1 passed, 1 skips if no poll on home |
| **accessibility.test.ts** | Axe + a11y on Home, Opportunity detail, Admin, Create form, My Bookings, Feedback, Settings, skip link, keyboard, contrast, alt text, labels | Requires dev server |
| **light-mode-contrast.test.ts** | Create Opportunity form: input/select/placeholder contrast in light mode | Requires dev server |

---

## ⚠️ critical-flows.test.ts

- Uses **Jest-style** `describe` / `it` and **mocked API** (route interception), so it is **not** true E2E against the real backend.
- Selectors may be outdated (e.g. "Create Opportunity" vs "Create Research Study").
- May or may not run under `npx playwright test` depending on project config; treat as legacy unless updated to `test.describe`/`test()` and real API.

---

## ❌ Checklist flows with *no* automated test

From [END_TO_END_TESTING_CHECKLIST.md](END_TO_END_TESTING_CHECKLIST.md):

| Flow | Automated? | Notes |
|------|------------|--------|
| **1. New User (Browse → Book)** | No | Manual / one-off run in E2E_PLAYWRIGHT_RUN_2026-02-02.md |
| **2. Booking (authenticated)** | No | Same |
| **3. Cancel booking** | No | Same |
| **4. Reschedule booking** | No | Skipped in last run (button disabled) |
| **5. Poll/Survey click** | Yes | m6-poll-click-tracking.test.ts |
| **6. Create opportunity** | Yes | superadmin-create-study (poll path) |
| **7. Edit opportunity** | No (real API) | critical-flows has it with mocks only |
| **8. Duplicate opportunity** | No | Manual run only |
| **9. Dashboard and analytics** | No | Manual run only |
| **10. Settings and notifications** | No | Manual run only |
| **11–17. Edge cases** (full session, past session, multiple bookings, calendar conflict, email, error handling, mobile) | No | Manual / skip |

---

## Summary

- **Automated and reliable:** Smoke, M6 poll click tracking, admin create study (poll), accessibility, light-mode contrast.
- **Not automated:** Full booking flow (book → My Bookings), cancel, reschedule, edit opportunity, duplicate, dashboard, settings.
- **Manual verification:** Last full run documented in `E2E_PLAYWRIGHT_RUN_2026-02-02.md` (most core flows passed; some skipped).

To “complete” E2E in the sense of the checklist, you’d add automated tests for: **booking flow** (book + My Bookings), **cancel booking**, **edit opportunity**, and optionally **duplicate**, **dashboard**, and **settings**.
