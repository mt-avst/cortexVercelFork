# Superadmin Create Study – Test Results

**Date:** 2026-02-03  
**Scope:** Test new functionality (diary fix, study visibility fix) in browser

## Fixes Under Test

1. **AdminSessionManager diary** – Uses `getMyCalendarEvents` instead of `getCalendarEvents` so the session management tab shows work calendar items.
2. **Admin refresh for superadmin** – List refresh after creating a study now runs for superadmin as well as researcher_admin.
3. **Backend LEFT JOIN** – Opportunities list uses `LEFT JOIN users` so studies owned by session-only users (e.g. superadmin) are returned.
4. **API owner assignment** – New opportunities use the authenticated user as owner when available.

## Automated Test (Playwright)

- **File:** `e2e/superadmin-create-study.test.ts`
- **Config:** `playwright.superadmin.config.ts` (no webServer; assumes `npm run dev:all` is running)
- **Status:** ✅ **Passing** – Uses `sessionStorage.setItem('loginRedirect', 'true')` before login so AuthContext fetches user on return. Uses admin-login (researcher_admin) since that user is seeded in DB. For superadmin testing, run backend seed to add superadmin user.

### Run Automated Test

```bash
# Terminal 1: Start dev servers
npm run dev:all

# Terminal 2: Run test (once servers are up)
npx playwright test e2e/superadmin-create-study.test.ts --config=playwright.superadmin.config.ts
```

## Manual Testing Checklist

### Prerequisites

- Dev stack running: `npm run dev:all` (frontend on 3000, backend on 3001)
- Or use production: https://adapta-labs-p62q.vercel.app

### Steps

1. **Login as superadmin**
   - Go to `/api/auth/superadmin-login` (or click Superadmin in the header dropdown if available)
   - Verify redirect to `/admin` and that the admin dashboard loads.

2. **Create new study**
   - Click "Create Research Study"
   - Basic Info: choose type (e.g. User Test or Poll), set title and purpose
   - Content & Details: fill required fields
   - For **test/interview**:
     - Open Session Management tab
     - Confirm the diary shows calendar items (not empty)
     - Select duration, pick slots, click "Confirm Selected Slots" or "Create Sessions"
   - For **poll/survey**:
     - Complete External Link tab
   - Save/create the study

3. **Verify study in list**
   - After submit, you should land on `/admin` with the research studies list
   - The new study should appear in the list (including when logged in as superadmin).

### Expected Outcomes

- Diary shows calendar events in the session management tab.
- Newly created study appears in the admin list after submit.
- Refresh or return-to-dashboard shows the new study.

## Browser MCP Testing

Browser MCP tools (`cursor-ide-browser`) were used to:

- Navigate to the app
- Verify superadmin login redirect
- Inspect the page after redirect

Production URL timed out during automated checks; local dev is the preferred environment for testing.
