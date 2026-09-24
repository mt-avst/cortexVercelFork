# End-to-End Testing Guide

**Version**: 7.56.0  
**Date**: 2026-08-25

---

## 🎯 Testing Approach

For alpha readiness, we'll test against the **production deployment** to ensure everything works in the real environment.

> **Note:** the production host (`https://adaptalabs.kubera-playground.adaptavist.net`) is Okta-gated.
> Suites reach the host, but anonymous flows redirect to Okta login rather than passing cleanly; public endpoints such as `GET /api/csrf-token` and `GET /api/opportunities` still respond without a session.

### What actually runs against the deployment, measured 2026-08-19

Only two suites are meaningful here, and one of them cannot fully pass:

| Command | Result | Why |
|---|---|---|
| `npm run test:smoke` | 7 passed, 2 skipped | read-only, tolerates the signed-out view |
| `npm run test:a11y:prod` | 11 passed, **3 failed** | the three failures are the Okta-gated pages |

The three accessibility failures are **not** accessibility defects. Create &
Manage (the "Admin Dashboard" spec), Forms and My Bookings navigate to the Okta sign-in page mid-scan,
which destroys the axe execution context. Testing them needs a stored
authenticated storage state, which nobody has set up. `test:a11y:prod`
therefore exits non-zero by design until that exists.

Everything else is unusable against the deployment: six specs depend on the
demo-login routes, which return **404** outside development, and three create
and publish studies - real content in a shared environment reachable from the
Slack entry point. Do not point those at Kubera.

> Both of these suites reported confidently wrong results until 2026-08-19.
> `test:a11y:prod` read its own `BASE_URL` constant instead of the config's
> `baseURL`, so it graded whatever was on `localhost:3000` - on one machine an
> unrelated application, which it failed in 24 seconds with ten plausible-looking
> violations. The smoke suite asserted `{ok: true}` from `/api/health`, which has
> never returned an `ok` property. Neither was noticed because the whole e2e
> suite collected zero tests. If a run against a deployment fails fast and
> confidently, check what it actually connected to before believing it.

---

## 🚀 Quick Start

### Option 1: Automated Tests (Recommended First)

```bash
# Smoke tests against the deployed playground
npm run test:smoke

# The full e2e suite against production
npm run test:e2e:prod
```

### The CSV export's ingress check (the cto/AdaptaLabs#11 launch gate)

Run this **before the first real study collects responses**, because that is the first moment a
truncated export could reach a researcher:

```bash
node scripts/csv-stream-check.mjs \
  --url "https://adaptalabs.kubera-playground.adaptavist.net/api/opportunities/<id>/survey-results.csv" \
  --cookie "__Host-adaptalabs_session=<value from DevTools>"
```

This said `connect.sid`, which is the express-session default and is not what this app sets - the same mistake #11's own description makes.
The name also differs by environment, because #97 applies the `__Host-` prefix only where the cookie is actually `Secure`: `__Host-adaptalabs_session` against playground, bare `adaptalabs_session` locally.
Copy whatever DevTools shows rather than the string written here.

The streamed export destroys the socket on every failure path, so a failure part-way through cannot
become a short CSV that parses. Nothing local can check the other half: if a buffering proxy sits in
front, it collects the whole body first and a destroyed socket reaches the researcher as a
complete-looking truncated file with a `Content-Length` on it.

The script reports **STREAMED**, **BUFFERED** or **INCONCLUSIVE**, and exits 0 only when the verdict
is STREAMED *and* the interrupt broke the transfer. `INCONCLUSIVE` is the honest answer against a
small export - every signal it measures reads as buffered when there was nothing to buffer - so run
it against a study with a few hundred responses, enough to cross the 100-participant batch boundary.

It needs an admin session cookie and an opportunity with a linked study (`firsthand_study_id`);
that is the route's own requirement, and it does not check the opportunity type. The **Responses**
tab that offers the download in the UI is narrower - it appears only for a poll or survey - so a
`curl`-able URL may exist for an opportunity whose page shows no download button.

`run-alpha-tests.sh` was deleted on 2026-08-24. Its only job was running
`e2e/critical-flows.test.ts`, which no Playwright config could collect, so the
script could not do anything useful. The two commands above are what actually
run against a deployed environment.

### Option 2: Manual Testing (Most Comprehensive)

Follow the **`docs/END_TO_END_TESTING_CHECKLIST.md`** step-by-step.

---

## 📋 Testing Checklist

### Pre-Testing Setup

- [ ] Clear browser cache
- [ ] Use incognito/private window
- [ ] Have test accounts ready:
  - [ ] Admin account (or use demo admin login)
  - [ ] Regular user account (or use demo login)
- [ ] Have test email addresses ready
- [ ] Google Calendar account accessible

---

## 🔴 Critical Tests to Run

### 1. New User Journey (15 minutes)

**Goal**: Verify a new user can browse and book

1. Open https://adaptalabs.kubera-playground.adaptavist.net in incognito window
2. Verify opportunities list loads
3. Click on an opportunity
4. Verify details page loads
5. Click "Demo Login" or "Sign in with Google"
6. Complete login
7. Return to opportunity
8. Click "Book" on an available session
9. Verify booking confirmation
10. Go to "My Bookings"
11. Verify booking appears
12. Check email for confirmation
13. Check Google Calendar for event

**✅ Pass Criteria**: All steps complete without errors

---

### 2. Booking Flow (10 minutes)

**Goal**: Verify authenticated booking works

1. Sign in as regular user
2. Find opportunity with available sessions
3. Click on opportunity
4. View session list
5. Check for calendar conflict indicators
6. Click "Book" on available session
7. Verify success message
8. Check slot count decreased
9. Verify in "My Bookings"

**✅ Pass Criteria**: Booking succeeds, slot count updates, appears in My Bookings

---

### 3. Cancel Booking (5 minutes)

**Goal**: Verify cancellation works

1. Go to "My Bookings"
2. Find booking in "Upcoming"
3. Click "Cancel"
4. Confirm cancellation
5. Verify success message
6. Verify booking moved to "Past"
7. Check email for cancellation
8. Go back to opportunity
9. Verify slot is available again

**✅ Pass Criteria**: Cancellation succeeds, slot becomes available, email sent

---

### 4. Reschedule Booking (5 minutes)

**Goal**: Verify rescheduling works

1. Go to "My Bookings"
2. Find booking in "Upcoming"
3. Click "Reschedule"
4. Select new session time
5. Confirm reschedule
6. Verify old booking cancelled
7. Verify new booking created
8. Check both appear correctly

**✅ Pass Criteria**: Reschedule succeeds, both bookings handled correctly

---

### 5. Admin - Create Opportunity (10 minutes)

**Goal**: Verify admin can create opportunities

1. Sign in as admin
2. Go to Create & Manage
3. Click "Create New Opportunity"
4. Fill in:
   - Type: Test
   - Title: "E2E Test Opportunity"
   - Purpose: "Testing alpha readiness"
   - Duration: 30
5. Add a session:
   - Start time: Tomorrow, 2pm
   - Capacity: 5
6. Click "Publish"
7. Verify opportunity appears in public list
8. Verify it's visible to non-admin users

**✅ Pass Criteria**: Opportunity created and published successfully

---

### 6. Poll/Survey Click Tracking (5 minutes)

**Goal**: Verify poll/survey tracking works

1. Find a Poll or Survey opportunity
2. Click on it
3. Click "Open Poll" or "Open Survey"
4. Verify external link opens
5. Sign in as admin
6. Go to Create & Manage
7. Find the poll/survey
8. Check "Clicks" column shows 1
9. Click "Analytics"
10. Verify analytics show the click

**✅ Pass Criteria**: Click tracked, analytics show data

---

## 🐛 Error Scenarios to Test

### Network Errors
- [ ] Disconnect internet, try to book
- [ ] Verify user-friendly error message
- [ ] Reconnect, verify recovery

### Validation Errors
- [ ] Try to book past session (should fail)
- [ ] Try to book full session (should fail)
- [ ] Try to double-book (should fail)
- [ ] Verify clear error messages

### 404 Errors
- [ ] Navigate to non-existent opportunity
- [ ] Verify helpful error message

---

## 📧 Email Testing

### Booking Confirmation Email
- [ ] Book a session
- [ ] Check email inbox
- [ ] Verify email received within 2 minutes
- [ ] Check email content:
  - [ ] Correct opportunity title
  - [ ] Correct session time
  - [ ] Calendar link works
  - [ ] All information present

### Cancellation Email
- [ ] Cancel a booking
- [ ] Check email inbox
- [ ] Verify cancellation email received
- [ ] Check email content is correct

---

## 📱 Mobile Testing (Optional)

- [ ] Open on mobile device
- [ ] Test navigation
- [ ] Test booking flow
- [ ] Test Create & Manage
- [ ] Verify buttons are clickable
- [ ] Check text readability

---

## ✅ Test Results Template

### Test Session: [Date]

**Tester**: _________________________  
**Browser**: _________________________  
**Environment**: Production

| Test # | Test Name | Status | Notes |
|--------|-----------|--------|-------|
| 1 | New User Journey | ⬜ | |
| 2 | Booking Flow | ⬜ | |
| 3 | Cancel Booking | ⬜ | |
| 4 | Reschedule Booking | ⬜ | |
| 5 | Admin Create | ⬜ | |
| 6 | Poll/Survey Tracking | ⬜ | |

**Legend**: ✅ Pass | ❌ Fail | ⚠️ Partial | ⬜ Not Tested

### Issues Found

**Critical (Blocking)**:
1. _________________________________________

**Medium (Non-Blocking)**:
1. _________________________________________

**Low Priority**:
1. _________________________________________

---

## 🎯 Success Criteria

Alpha testing can proceed if:
- ✅ 90%+ of critical tests pass
- ✅ No critical bugs block user tasks
- ✅ Error messages are user-friendly
- ✅ Core flows work end-to-end

---

## 📝 Next Steps After Testing

1. **Document Issues**
   - File a GitLab issue (see `docs/agents/issue-tracker.md`)
   - Prioritize fixes

2. **Fix Critical Bugs**
   - Address blocking issues
   - Test fixes

3. **Update Documentation**
   - Update known issues
   - Add workarounds if needed

4. **Sign Off**
   - Review all test results
   - Make go/no-go decision

---

## Load testing

A minimal API load test runs against `/api/health` and `/api/opportunities` using [k6](https://k6.io/docs/get-started/installation/).

**Prerequisites:** Install k6 (e.g. `brew install k6` on macOS).

**Run against production (default URL, 10 VUs, 30s):**
```bash
k6 run load-test/api-smoke.js
```

**Custom base URL:**
```bash
k6 run -e BASE_URL=https://adaptalabs.kubera-playground.adaptavist.net load-test/api-smoke.js
```

**Shorter run (10s, 5 VUs):**
```bash
k6 run -e DURATION=10s -e VUS=5 load-test/api-smoke.js
```

Thresholds: &lt;5% failed requests, p95 latency &lt;3s. See `load-test/api-smoke.js` for details.

---

## Survey CSV interrupt probe (cto/AdaptaLabs#11)

`backend/probe/csv-interrupt.ts` seeds a multi-batch survey export and then interrupts downloading it, to answer one question: does a broken export arrive as a broken download, or as a tidy short file a researcher would compute a mean over?

**#11 is a launch gate and this does not close it.** The gate is a run of this against the deployed environment, before the first real study collects responses.
What this removes is the reason it was unrunnable - there was no data to interrupt.

Three commands, and `probe` needs no database:

```bash
# 1. Seed. 301 participants, sized from CSV_PARTICIPANT_BATCH so the export
#    drains four batches. Idempotent: re-running tops up only what is missing.
DATABASE_URL=postgres://postgres:postgres@localhost:5432/adaptalabs_dev \
  npx tsx backend/probe/csv-interrupt.ts seed

# 2. Probe. Signs itself in via /api/auth/admin-login when the target is local.
npx tsx backend/probe/csv-interrupt.ts probe --target http://localhost:5000

# 3. Remove everything it created.
DATABASE_URL=postgres://postgres:postgres@localhost:5432/adaptalabs_dev \
  npx tsx backend/probe/csv-interrupt.ts clean
```

Against playground, seeding needs a port-forward (the guard only ever writes to loopback) and the probe needs a real admin cookie for the account that owns the seeded opportunity:

```bash
npx tsx backend/probe/csv-interrupt.ts probe \
  --target https://adaptalabs.kubera-playground.adaptavist.net \
  --cookie "__Host-adaptalabs_session=<value from DevTools>"
```

The cookie is not `connect.sid`: #11's description names the express-session default and `backend/src/index.ts` renames it.
Its name then differs by environment, and copying the wrong one is an auth failure the probe cannot diagnose for you: `__Host-adaptalabs_session` against playground, bare `adaptalabs_session` locally.
#97 applies that prefix only where the cookie is `Secure`, because express-session refuses it over http.

The probe sends whatever `--cookie` you give it, verbatim.
Its own jar parser matches the bare name only, and that is correct rather than an oversight - it reads a jar minted by `/api/auth/admin-login`, a route that exists only when `NODE_ENV` is development, which is exactly where the prefix does not apply.

`probe` exits 0 only when all three arms pass, so it is usable as a gate rather than as output somebody has to interpret:

| arm | what it does | pass |
|---|---|---|
| `control` | complete, unthrottled download | exit 0, 302 rows, and it supplies the byte count the other two are compared against |
| `interrupt` | #11's own `--limit-rate` + `--max-time` cancellation | a non-zero curl exit over a short body |
| `stall` | a raw socket that reads nothing until past `SURVEY_CSV_DRAIN_TIMEOUT_MS`, then looks at how the body ended | the **connection** ended with no terminating 0-chunk, i.e. the destroyed socket reached the client |

`stall` distinguishes the connection ending from its own read deadline expiring.
Only the first is evidence about the server: a host that sends headers and then goes silent is reported INCONCLUSIVE, not as a destruction nobody observed.

Nothing downloaded is kept.
Each body is counted and then unlinked, and the scratch directory holding the session cookie goes with it - what the export contains is every answer a study collected, and against playground those belong to real people.

`stall` is the arm that can see a buffering ingress, which is the half of #11 no local test can reach: a tidy 0-chunk over a short body means something converted a destroyed socket into a complete-looking truncated file.
The refusal design is then defeated in production, silently, and the fix is at the ingress rather than in the application.

**A failing `control` invalidates the other two and the probe stops there.** "The transfer broke" passes just as well when the URL is wrong, the cookie has expired, the opportunity belongs to somebody else or the study collected nothing.

Measured locally 2026-08-25, against a real Postgres and the real backend: control 3,633,701 bytes and 302 rows in 77ms; interrupt curl 28 over 131,113 bytes and 12 rows; stall 839,438 bytes with no 0-chunk after 40s, with `reason: drain_timeout` in the server log.
Changing `writeSurveyCsv`'s closing `res.destroy()` to `res.end()` flips `stall` to FAIL and leaves the other two arms untouched, so the arm demonstrably fails by name.

The two guards - which database may be written to, and which host may receive an admin session cookie - are unit-tested in `backend/probe/__tests__/csv-interrupt-guards.test.ts`, which jest runs.
Both had a hole a hand-check would not find: `?host=` in a connection string overrides the address `pg` dials, and a substring test for the playground name admitted `kubera-playground.evil.example`.
Each hole is pinned by the exact string that opened it, and each refusal has an acceptance beside it so a guard that refused everything would fail too.

`?hostaddr=` is refused as well.
It is latent rather than live - node-postgres parses it and does not currently dial it - but libpq does, so it is one release away from being the same bypass, and it is one word in an array.

An IPv6 literal such as `postgres://…@[::1]:5432/db` is **refused**, deliberately.
`pg-connection-string` keeps the brackets and neither `pg` nor `net.connect` will dial `"[::1]"` - both give `ENOTFOUND` - so admitting it produced a guard that said yes to a command that then died.
Use `localhost`, which reaches IPv6 loopback wherever the resolver prefers it.

---

**Last Updated**: 2026-08-25

