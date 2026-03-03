# tasks_m4_booking.md

# Milestone M4  Booking
Employee booking, reschedule, cancel. Calendar and email flows. My bookings page. Capacity enforcement.

## Goal
Authenticated employees can book a specific session, receive confirmation and invite, and manage their booking. Researcher admins get optional notifications. Capacity is enforced with concurrency safety.

## Deliverables
- Booking REST endpoints with server side validation and transactions
- Capacity checks and race condition protection
- Google Calendar create, update, cancel hooks
- Email sends for booked, reminder, cancelled
- My bookings page for employees
- Booking status display on Opportunity detail
- Admin toggle for notifications already defined in M1

## Data model changes
Booking
- add unique constraint `(user_id, session_id)` to prevent duplicates
- ensure `status` enum `booked|cancelled`
- keep `gcal_event_id` nullable

Session
- `booked_count` updated transactionally on book/reschedule/cancel

Setting (optional)
- default_reminder_hours_before number default 24

## API

### POST `/api/sessions/:id/book`  [auth employee]
Body
- none (user from session)

Process
1. Load session and parent opportunity
2. Guardrails
   - opportunity.status must be `published`
   - session.end_time > now
3. Transaction
   - lock session row `FOR UPDATE`
   - if `booked_count >= capacity` → 409 Full
   - upsert booking for `(user_id, session_id)` as `booked`
   - increment `booked_count`
4. Calendar
   - create Google Calendar event on owner admin work calendar
   - attendees: participant, owner
   - store `gcal_event_id` on booking
5. Email
   - send confirmation email to participant
6. Admin notification
   - if owner has on_book_email → send notification
7. Return booking object `{ id, session_id, status: 'booked' }`

Errors
- 401 unauth
- 404 session not found or not published
- 409 full or already booked

### POST `/api/bookings/:id/cancel`  [auth employee or admin owner]
Body
- none

Process
1. Load booking with join to session and opportunity
2. Authorisation
   - participant can cancel own booking
   - researcher admin owner can cancel any on their opportunity
3. State checks
   - if already cancelled → 200 idempotent
   - if session.end_time <= now → 400 cannot cancel past
4. Transaction
   - set booking.status = cancelled, set `cancelled_at`
   - decrement session.booked_count
5. Calendar
   - cancel corresponding gcal event if present
6. Email
   - send cancellation email to participant
7. Admin notification
   - if owner on_cancel_email → send notification

### POST `/api/bookings/:id/reschedule`  [auth employee]
Body
- `target_session_id` string

Process
1. Load booking, current session, target session, opportunity
2. Guardrails
   - same opportunity
   - target session.end_time > now
3. Transaction
   - lock both sessions `FOR UPDATE`
   - capacity check on target
   - move booking to target_session_id
   - decrement old.booked_count, increment new.booked_count
4. Calendar
   - update event time or recreate event if provider requires
5. Email
   - send updated confirmation to participant

### GET `/api/my/bookings`  [auth employee]
Returns
- list of user bookings split into `upcoming` and `past` with joined opportunity and session fields

### GET `/api/opportunities/:id/bookings`  [admin owner]
Returns
- list with participant name, email, business_unit, role_title, session time, status

## Google Calendar integration
- Use a service account with domain wide delegation or per user OAuth, based on IT policy
- Event fields
  - Title  `"{Opportunity title} with {Employee name}"`
  - Start/end from session
  - Description  purpose one liner, link back to opportunity detail
  - Attendees  participant, owner
  - Meet link  allow Google to attach if enabled
  - Reminder  email at `default_reminder_hours_before` (24 by default)
- On cancel  delete event
- On reschedule  patch start/end or delete then create

Failure handling
- If calendar call fails, keep booking but return 207 style payload `{ booked: true, calendar: 'error', message }`
- Add retry job with backoff (optional)

## Emails
1. Confirmation
   - Subject  `Booking confirmed: {Opportunity title}`
   - Body  session time local, duration, manage booking link
   - iCal event optional as attachment if needed
2. Reminder (scheduled)
   - Subject  `Reminder: {Opportunity title} in {n} hours`
3. Cancellation
   - Subject  `Booking cancelled: {Opportunity title}`
4. Admin notifications (toggle per owner)
   - Book and Cancel summaries

## Front end

### Opportunity detail (public and authed)
- Sessions table now includes actionable buttons
  - If not signed in  show Sign in to book
  - If signed in and remaining > 0  show Book
  - If full  show Full
- After booking
  - Show success toast and inline badge `You are booked for {date time}`
  - Provide buttons `Reschedule` and `Cancel`

### My bookings (new page)
- Upcoming tab
  - card per booking  title, date time, manage actions
- Past tab
  - read only list

### Reschedule flow
- Modal shows other sessions for the same opportunity with remaining slots
- Select one and confirm

### Cancel flow
- Confirm modal with short consequences copy

## Validation and rules
- One active booking per user per session enforced by unique constraint
- Do not allow booking or reschedule into past sessions
- Respect capacity and use row locking in all mutations
- Prevent reschedule to same session no op

## Background reminders
- Queue a reminder send at `session.start_time - default_reminder_hours_before`
- Simple cron that scans upcoming bookings in the next 10 minutes and sends if not yet sent
- Mark reminder sent flag on booking metadata if you add it

## Security
- Employee must be authenticated
- Admin owner can cancel on behalf of participants
- All IDs validated as UUIDs, ownership checked server side
- Rate limit booking endpoints

## Tests

API unit
- Book success increments booked_count and creates booking
- Book when full returns 409 and does not increment
- Duplicate book by same user returns 409
- Cancel returns 200 and decrements booked_count
- Reschedule moves counts atomically between sessions
- Calendar failures do not roll back booking but return partial status

Race conditions
- Two concurrent books on last slot → one 200, one 409
- Concurrent reschedule and cancel paths safe

Permissions
- Non owner admin cannot cancel other opportunities
- Unauth calls return 401

Dates
- Booking into past session blocked
- Reschedule to past blocked

Email
- Confirmation sent on book
- Cancellation sent on cancel
- Reminder scheduler picks up booking at correct window

UI e2e
- Sign in → open opportunity → book → see success → My bookings displays item
- Reschedule to another slot
- Cancel and see it removed from Upcoming

## Definition of Done
- Full book, reschedule, cancel flow works end to end
- Calendar and email flows triggered appropriately
- Capacity accurate with race safety
- My bookings page live
- Tests passing for core rules and races
