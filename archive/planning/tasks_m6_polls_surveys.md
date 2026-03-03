# tasks_m6_polls_surveys.md

# Milestone M6  Polls and surveys
List polls and surveys alongside tests. Open externally. Track clicks. Simple admin UX.

## Goal
Researchers can post polls and surveys that open on external tools. Employees can see them in the unified list and open them. The system records click counts for basic analytics.

## Deliverables
- Complete support for `type = poll | survey` in list and detail
- External link open with click tracking endpoint
- Admin create/edit validation for external links
- UI badges and CTA logic for polls and surveys
- Basic analytics surfaced to owner in Admin

## Data model
Re-use `opportunities` table fields already defined:
- `type` enum includes `poll` and `survey`
- `external_link_optional` used as target URL when type is `poll` or `survey`

New table  `opportunity_clicks`
- id  uuid pk
- opportunity_id  uuid fk opportunities.id on delete cascade
- user_id  uuid nullable  (null for unauthenticated opens before login)
- clicked_at  timestamptz default now
- user_agent  text nullable
- ip_hash  text nullable  (hash with server secret to avoid storing raw IP)

Indexes
- idx_clicks_opportunity  btree(opportunity_id, clicked_at)

Notes
- Only count opens via the CTA button. Do not attempt to count external tool completions.

## API

### GET `/api/opportunities`
- Already returns published items. Ensure cards for poll and survey include fields required by UI badges.

### GET `/api/opportunities/:id`
- For `poll` or `survey`, return `external_link_present: boolean` for simple client logic.

### POST `/api/opportunities/:id/click`
- Auth  optional (allow both unauthenticated and authenticated)
- Body  none
- Behaviour
  - Write row to `opportunity_clicks`
  - If authenticated, store `user_id`
  - Store hashed IP if available and user agent for rough dedupe analysis
- Returns `{ ok: true }`

Validation
- 404 if opportunity not found or not published
- 400 if type is `test` (click tracking only valid for poll or survey)

### GET `/api/opportunities/:id/analytics`  [admin owner or admin role]
- Returns
  - `clicks_total`
  - `clicks_24h`
  - `clicks_by_day` last 30 days  array of `{ date, count }`

## Server-side validation
- On create or publish for `poll` or `survey`, require a valid absolute `external_link_optional` (http or https)
- Prevent `sessions` creation for `poll` or `survey` (guard in M3 endpoints)

## Front end

### Public list (unauth and authed)
- Cards show a badge `Poll` or `Survey`
- Duration field hidden for polls and surveys
- CTA
  - Button text `Open survey` for both poll and survey to keep language consistent
  - Clicking CTA calls POST `/api/opportunities/:id/click` then navigates to `external_link_optional`
  - If missing link and status is published, show disabled button with tooltip `Link not available`

### Opportunity detail
- For `poll` or `survey`
  - Show title, purpose one liner, description, product
  - Prominent CTA `Open survey`
  - Secondary note `Opens in a new tab`
  - No sessions table

### Admin create/edit
- When `type` is `poll` or `survey`
  - Show `External link` field required on publish
  - Hide sessions editor
  - Live validation for URL format
- Preview shows the same CTA and badges as public detail view

### Admin analytics section (owner only)
- In `My opportunities` table add columns:
  - `Clicks` total
- Detail admin pane:
  - Show clicks total and 30-day sparkline using `/api/opportunities/:id/analytics`
- Empty state: `No clicks yet`

## Tracking and privacy
- Record click server-side only when users press CTA
- If unauthenticated, store no PII
- If authenticated, storing `user_id` is acceptable per internal use
- Hash IP with server secret to avoid storing raw IP
- Provide config flag to disable user agent capture if required

## Tests

API unit
- Create poll with valid link 201
- Publish poll without link 400
- Click tracking 200 for both authed and unauth
- Analytics returns totals and by-day series
- Click on `type = test` returns 400

UI e2e
- Poll and survey cards render with badges
- CTA posts click then opens external link
- Admin cannot publish poll or survey without link
- Admin analytics shows rising counts after multiple clicks

Edge cases
- External link 404 on the remote site  still record click
- Multiple rapid clicks  count each since user intent is to open

Performance
- Click endpoint p99 under 50 ms
- Analytics query for 30-day series under 200 ms with indexes

Accessibility
- CTA has clear accessible name `Open survey`
- Focus remains predictable when link opens in new tab

## Definition of done
- Polls and surveys fully supported end to end
- External opens tracked
- Admin can see basic click analytics
- Validation prevents publishing without a link
- Tests green and e2e happy path confirms open and count
