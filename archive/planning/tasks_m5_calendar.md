# tasks_m5_calendar.md

# Milestone M5  Calendar integration
Create, update, and cancel Google Calendar events for bookings and reschedules. Uses the researcher admin owner’s work calendar.

## Goal
On booking, create a calendar event in the owner admin’s work calendar and invite the participant. On cancel and reschedule, keep the event in sync. Handle failures without blocking a successful booking.

## Deliverables
- Google Calendar client module
- Service account or per user OAuth integration (configurable)
- Event create, update, delete functions with robust error handling and retries
- Wiring into M4 booking flows
- Configuration flags and environment variables
- Observability logs and basic metrics

## Integration options
### Option A  Service account with domain wide delegation
- Pros  single credential, simpler ops
- Cons  needs central IT approval and scopes
- Use if permitted by org policy

### Option B  Per user OAuth for researcher admins
- Pros  least-privilege per owner
- Cons  extra OAuth flow and token storage

Support both behind a config flag.

## Environment
- `CALENDAR_PROVIDER=google`
- `GOOGLE_SA_JSON`  base64 or file path for service account JSON (Option A)
- `GOOGLE_DELEGATED_USER_DOMAIN`  required for domain wide delegation
- `OAUTH_GOOGLE_CLIENT_ID` and `OAUTH_GOOGLE_CLIENT_SECRET` (Option B)
- `CALENDAR_DEFAULT_REMINDER_HOURS=24`
- `APP_BASE_URL`

## Data contract
Booking
- `gcal_event_id` string nullable
- on success set to the provider event id

Opportunity
- `title`, `purpose_one_liner`, `owner_user_id`

Session
- `start_time`, `end_time`, `location_or_meet_link_optional`

Owner user
- must have a resolvable work email address

## Calendar client module
File  `services/calendar/googleCalendar.ts`
Exports
- `createEvent({ ownerEmail, participantEmail, title, description, start, end, locationOrMeet, reminderHours }): Promise<{ eventId: string }>`
- `updateEvent({ ownerEmail, eventId, start, end, locationOrMeet, reminderHours }): Promise<void>`
- `deleteEvent({ ownerEmail, eventId }): Promise<void>`

Behaviour
- Title `"{Opportunity title} with {Employee name}"`
- Description contains purpose and canonical link back to opportunity detail `APP_BASE_URL/opportunity/:id`
- Attendees  owner and participant as required attendees
- If `location_or_meet_link_optional` is empty, allow Google to attach a Meet link when the owner’s calendar is configured to do so
- Reminder  email at `CALENDAR_DEFAULT_REMINDER_HOURS` if set

## Booking flow wiring
### On book (M4 POST /api/sessions/:id/book)
- After DB transaction success, call `createEvent`
- If success  persist `eventId` to `booking.gcal_event_id`
- If failure  return 207 style body `{ booked: true, calendar: 'error' }` and log error

### On cancel (M4 POST /api/bookings/:id/cancel)
- If `gcal_event_id` present  call `deleteEvent`
- Ignore 404 from provider as success
- Always mark booking cancelled in DB

### On reschedule (M4 POST /api/bookings/:id/reschedule)
- Prefer `updateEvent` to change start and end
- If provider rejects patch  delete then create new event and update `gcal_event_id`

## Error handling
- All calendar calls wrapped in try/catch
- Map provider errors to internal codes
  - 401 or 403  configuration or permission error
  - 404  event not found  treat delete as success
  - 409  conflict  retry with jitter
  - 5xx  retry up to 3 times with exponential backoff
- Never roll back the successful booking due to calendar failure
- Emit structured logs with `booking_id`, `opportunity_id`, `owner_email`, `participant_email`, `provider_status`

## Security
- If using service account  restrict scopes to `https://www.googleapis.com/auth/calendar`
- If using domain wide delegation  restrict to owner’s calendar by impersonation
- If using OAuth  store tokens encrypted at rest with rotation
- Do not log token contents

## Tests
Unit
- `createEvent` returns event id
- `updateEvent` changes time and returns ok
- `deleteEvent` swallows 404
- Retries kick in on 5xx

Integration (mock provider)
- Book → create called once and `gcal_event_id` set
- Cancel → delete called when `gcal_event_id` present
- Reschedule → update called, or delete+create fallback when update fails

API e2e
- Booking still succeeds when provider down  returns partial status, UI shows non-blocking warning
- Reschedule keeps capacity consistent and updates event time
- Cancel removes booking and event

## Observability
- Add counters
  - `calendar.create.success`, `calendar.create.error`
  - `calendar.update.success`, `calendar.update.error`
  - `calendar.delete.success`, `calendar.delete.error`
- Add histogram for provider latency
- Dashboard widget in admin can show last 24h calendar error count (optional)

## Admin copy
- When a calendar error occurs, show a dismissible banner on the owner’s admin dashboard
  - “Calendar could not be updated for one or more bookings. Your bookings are confirmed. Please check your calendar settings or contact IT.”

## Acceptance criteria
- On booking, a calendar event is created in the owner admin’s work calendar with correct title, time, attendees, and reminder
- On cancel, the event is removed
- On reschedule, the event time updates
- Booking flow is never blocked by calendar downtime
- Logs and metrics record outcomes for create, update, delete
- All tests pass for happy paths and failure paths

## Definition of done
- Calendar client implemented and wired to M4 flows
- Environment configured for chosen auth mode
- Unit and integration tests passing
- Manual smoke test with a real calendar completes book → reschedule → cancel
