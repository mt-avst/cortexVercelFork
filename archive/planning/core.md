# core.md

# Adaptalabs Recruitment App core

## Purpose
Recruit internal participants quickly and simply.

## User needs
- As a Researcher admin, I need to post simple opportunities so that employees can volunteer without friction.
- As an Employee, I need to browse and book a timeslot so that I can help testing with minimal effort.
- As an Admin, I need basic oversight so that only appropriate posts go live.

## Roles
- Visitor
- Authenticated employee
- Researcher admin

## Entities

### User
Fields
- id
- name
- email
- business_unit
- role_title
- created_at
Notes
- SSO source of truth for identity

### Opportunity
Fields
- id
- type  test or poll or survey
- title
- purpose_one_liner
- description_optional
- product_optional
- default_duration_minutes
- status  draft or published or closed
- owner_user_id
- external_link_optional
- created_at
- updated_at

### Session
Fields
- id
- opportunity_id
- start_time
- end_time
- capacity
- booked_count
- location_or_meet_link_optional

### Booking
Fields
- id
- session_id
- user_id
- status  booked or cancelled
- booked_at
- cancelled_at_optional
- gcal_event_id

### NotificationPreference
Fields
- id
- user_id
- on_book_email  bool
- on_cancel_email  bool

### Setting
Fields
- id
- key
- value_json

## Relationships
- User owns many Opportunities
- Opportunity has many Sessions
- Session has many Bookings
- User has many Bookings
- User has one NotificationPreference

## Behavioural rules
- Anyone can browse
- SSO required to book and for researcher admin
- Default duration 30 minutes configurable per opportunity
- Participants select a specific session
- Booking creates Google Calendar event on owner admin work calendar
- Confirmation and reminder emails sent to participant
- Participant can cancel or reschedule
- Auto close after end time or when capacity reached
- Polls and surveys open externally and record click only

## Minimal ERD
flowchart TB
User[User]
Opportunity[Opportunity]
Session[Session]
Booking[Booking]
NotifPref[NotificationPreference]
Setting[Setting]

User --> Opportunity
Opportunity --> Session
Session --> Booking
User --> Booking
User --> NotifPref

## API surface

Auth
- GET api me

Opportunities
- GET api opportunities  query type and q
- GET api opportunities id
- POST api opportunities  admin
- PATCH api opportunities id  admin
- DELETE api opportunities id  admin
- POST api opportunities id duplicate  admin

Sessions
- GET api opportunities id sessions
- POST api opportunities id sessions  admin
- PATCH api sessions id  admin
- DELETE api sessions id  admin

Bookings
- POST api sessions id book
- POST api bookings id cancel
- POST api bookings id reschedule
- GET api my bookings

Analytics
- POST api opportunities id click

Admin
- GET api dashboard  admin

## Calendar behaviour

On booking
- Create gcal event on owner admin calendar
- Title  Opportunity title with Employee name
- Description  purpose one liner and link back
- Attendees  participant email and owner email
- Reminder email before start  default 24h

On cancel
- Cancel event and notify attendee

On reschedule
- Move event to new session time

## Email events
- booked
- reminder
- cancelled
- admin notify on book  toggle per admin
- admin notify on cancel  toggle per admin

## Security and privacy
- SSO for booking and admin
- Role checks server side
- Minimal PII only
- Basic audit via server logs

## Non functional
- List renders under 1 second with 100 items
- WCAG 2.2 AA basics
- Internal VPC deploy
