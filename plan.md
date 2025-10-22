# Adaptalabs Recruitment App — plan.md

## 0. Purpose
Recruit internal participants quickly and simply.

## 1. User needs
- As a Researcher admin, I need to post simple opportunities so that employees can volunteer without friction.
- As an Employee, I need to browse and book a timeslot so that I can help testing with minimal effort.
- As an Admin, I need basic oversight so that only appropriate posts go live.

## 2. Scope
In scope
- Public browse inside firewall
- SSO to book
- Unified list of opportunities
- Types: Test, Poll, Survey
- Slot selection and automatic calendar invite
- Self-serve cancel and reschedule
- Researcher admin CRUD and duplicate
- Multi-day sessions
- Email confirmations and reminders
- Toggleable notifications to researcher on book or cancel
- External links for polls and surveys
- Basic dashboard counts
- Auto close on max capacity and after end time
- Branding header: Adaptalabs

Out of scope for MVP
- Targeting by segment
- CSV exports or advanced reporting
- Screeners
- Incentives management

## 3. Non-functional
- Fast: list renders under 1 second with 100 items on corp Wi-Fi
- Accessible: WCAG 2.2 AA basics
- Secure: SSO only for booking and admin
- Minimal PII: name, email, business unit, role/title
- Data retention: default 12 months for bookings

## 4. Roles
- Visitor: can browse
- Authenticated employee: can book, cancel, reschedule, view My bookings
- Researcher admin: create, edit, delete, duplicate opportunities, manage slots, view dashboard

## 5. Data model
User
- id, name, email, business_unit, role_title, created_at

Opportunity
- id, type [test|poll|survey], title, purpose_one_liner, description_optional, product_optional, default_duration_minutes, status [draft|published|closed], owner_user_id, created_at, updated_at, external_link_optional

Session
- id, opportunity_id, start_time, end_time, capacity, booked_count, location_or_meet_link_optional

Booking
- id, session_id, user_id, status [booked|cancelled], booked_at, cancelled_at_optional, gcal_event_id

Setting
- id, key, value_json  (store default duration, branding, email templates)

NotificationPreference
- id, user_id, on_book_email [bool], on_cancel_email [bool]

## 6. Integrations
SSO
- Company provider via OpenID Connect. Auth required for booking, admin pages, dashboard.

Google Calendar
- Create, update, delete events on the researcher admin’s work calendar who owns the opportunity.
- Store gcal_event_id on Booking.

Email
- Transactional: confirmation, reschedule, cancel, reminder.

## 7. Booking rules
- Default duration 30 minutes, configurable per opportunity
- Participants select a specific available session time
- Auto create calendar event on researcher admin’s work calendar and send invite to participant
- Participant can cancel or reschedule from My bookings
- Auto close when session time has passed or capacity reached
- Show remaining slots count on list and detail

## 8. Pages and UX
Public
- Home list: all opportunities in one list. Filters: Type, Text search.
- Opportunity detail:
  - Core fields, sessions table with remaining slots, Book button
  - Polls and surveys: prominent external link + click tracking

Authenticated
- My bookings: upcoming and past, actions to cancel or reschedule

Researcher admin
- New opportunity: type, title, purpose, description, default duration, sessions table editor, external link if poll or survey, preview, publish
- Edit opportunity
- Delete opportunity
- Duplicate opportunity
- Dashboard: counts per opportunity, bookings list with session times
- Settings: notification toggles

## 9. API surface (REST)
Auth
- GET /api/me  → current user and role

Opportunities
- GET /api/opportunities  → list with query params: type, q
- GET /api/opportunities/:id
- POST /api/opportunities  [admin]
- PATCH /api/opportunities/:id  [admin]
- DELETE /api/opportunities/:id  [admin]
- POST /api/opportunities/:id/duplicate  [admin]

Sessions
- GET /api/opportunities/:id/sessions
- POST /api/opportunities/:id/sessions  [admin]
- PATCH /api/sessions/:id  [admin]
- DELETE /api/sessions/:id  [admin]

Bookings
- POST /api/sessions/:id/book  → creates booking, creates Google Calendar event, sends email
- POST /api/bookings/:id/cancel  → cancels booking, deletes or updates event, sends email
- POST /api/bookings/:id/reschedule  → to another session, updates event, sends email
- GET /api/my/bookings  → current user bookings

Analytics
- POST /api/opportunities/:id/click  → record external poll or survey click

Admin
- GET /api/dashboard  [admin] → simple counts by opportunity

## 10. Calendar behaviour
On booking
- Create gcal event on owner_admin calendar
- Title: "{Opportunity title} with {Employee name}"
- Description: purpose one liner, link back to opportunity
- Attendees: participant email, owner email
- Meet link: let Google add if configured
- Reminder: email before start, configurable default 24h

On cancel
- Cancel event and notify attendee

On reschedule
- Move event to new session timeslot

## 11. Email flows
- Booked: summary, iCal included, link to manage booking
- Reminder: 24h before start
- Cancelled: confirmation
- Admin notifications: book and cancel, each toggleable per admin

## 12. Security and privacy
- SSO for any booking or admin action
- Only researcher admins can CRUD opportunities
- Do not store sensitive data beyond minimal PII
- Server-side checks on role and ownership
- Basic audit log via server logs

## 13. Tech notes
- Front end: React
- Back end: Node with minimal framework
- DB: Postgres
- Auth: OIDC
- Calendar: Google Calendar API
- Email: SMTP or transactional provider
- Deploy: internal VPC

Env
- OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URL
- GOOGLE_SERVICE_ACCOUNT_JSON
- EMAIL_SMTP_HOST, EMAIL_SMTP_USER, EMAIL_SMTP_PASS, EMAIL_FROM
- APP_BASE_URL, SESSION_SECRET, DATABASE_URL

## 14. Milestones
M1 Auth and roles
- OIDC login, role seeding for researcher admins
- Me endpoint and guard rails

M2 Opportunities
- List, detail, admin create, publish, delete, duplicate
- Public browse without login

M3 Sessions
- Session editor on admin, remaining slots on UI

M4 Booking
- Slot selection, My bookings, cancel, reschedule
- Email confirmations and reminders

M5 Calendar
- Google Calendar create, cancel, reschedule

M6 Polls and surveys
- External link, click tracking

M7 Dashboard and settings
- Basic counts, admin notification toggles

M8 Branding and accessibility pass
- Adaptalabs header, WCAG basics

## 15. Acceptance criteria
- Browse without login. Booking requires SSO.
- End to end: create opportunity, add sessions, book, invite created, reminder sent, reschedule, cancel.
- Auto close when capacity reached or end time passed.
- Polls and surveys open externally and record clicks.
- Admin can delete and duplicate opportunities.
- Multiple researcher admins supported.

## 16. Risks and mitigations
- Calendar API failures → retry with backoff and surface clear error to user
- Double booking race → transaction on booking and capacity check server side
- Email deliverability → domain verified sender, fallback on UI notifications
- Access confusion → clear banner: browse open, booking requires login

## 17. Definition of done
- All acceptance criteria met
- Security review on auth and role checks
- Basic accessibility review
- Unit tests on booking capacity and calendar sync
- Smoke test on staging with a live Google Calendar
