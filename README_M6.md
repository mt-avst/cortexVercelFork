# M6 – Polls, Surveys & Click Tracking

Reference for Milestone 6: polls/surveys, external link opens, and click analytics.

## Summary

- **Opportunity types**: `poll`, `survey`, `unmoderated` use an external link; no sessions. `test` and `interview` use bookable sessions.
- **Click tracking**: `POST /api/opportunities/[id]/click` with body `{ "click_type": "view" | "action" }`. Fired when user views the study (view) or clicks the action button (Open Poll/Survey or Book). Auth is optional.
- **Analytics**: `GET /api/opportunities/[id]/analytics?period=7|14|30` (admin/owner only). Returns views/actions totals, time series, conversion rate.

## Environment

- **SESSION_SECRET**: Used to hash IPs before storing in `opportunity_clicks`. No separate M6 env vars; same as auth.
- **Database**: Table `opportunity_clicks` (and indexes) are created by `api/run-migrations` (see `api/run-migrations.ts`).

## Error handling

- **Click endpoint**: 400 for invalid `click_type` or non–poll/survey/unmoderated/test/interview; 404 if opportunity not found or not published; 500 on DB errors (logged).
- **Analytics endpoint**: 401 if not authenticated; 403 if not admin or not owner; 404 if opportunity not found; 500 on errors (logged).
- **Frontend**: `trackOpportunityClick` catches errors and logs; it does not block navigation (open-in-new-tab still happens).

## E2E tests

- **File**: `e2e/m6-poll-click-tracking.test.ts`
- **Test 1**: Full flow – login as admin → create poll → publish → open public detail → click “Open Poll” → assert `POST /api/opportunities/:id/click` is sent and returns 200.
- **Test 2**: If any poll/survey exists on the list, open it and click “Open Poll”/“Open Survey”, assert click request returns 200 (skips if none).

Run with Playwright starting backend + frontend (ports 3000 and 3001 must be free):

```bash
npx playwright test e2e/m6-poll-click-tracking.test.ts --project=chromium
```

If you already have backend and frontend running (e.g. in other terminals), skip the built-in servers and run tests only:

```bash
PLAYWRIGHT_NO_WEBSERVER=1 npx playwright test e2e/m6-poll-click-tracking.test.ts --project=chromium
```

**If the test fails with “expected /admin but got http://localhost:3000/”**  
The backend must redirect to the frontend after login. Ensure the backend has `CORS_ORIGIN` or `FRONTEND_URL` set to the frontend origin (e.g. `http://localhost:3000`) in `backend/.env`. The test waits for `/api/me` to complete before asserting the URL so auth has time to settle.

## Analytics dashboard verification

- **Admin → My opportunities**: “Clicks” column shows total clicks for poll/survey/unmoderated rows.
- **Admin → row ⋮ → Analytics** (or Edit → Analytics): Full analytics page with views, actions, conversion, sparklines, and time series (see `frontend/src/pages/OpportunityAnalytics.tsx`).
- **Manual check**: Publish a poll → open public detail → click “Open Poll” → as admin open that opportunity’s Analytics and confirm “Actions taken” (and total clicks) increase.

## See also

- `tasks_m6_polls_surveys.md` – Full spec and definition of done
- `CODE_REVIEW_M6.md` – Code review notes
- `learnings.md` – Project conventions and gotchas
