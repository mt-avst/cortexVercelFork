# tasks_m3_sessions.md

# Milestone M3  Sessions
Add session blocks (timeslots) to opportunities. Show remaining slots. Admin session editor.

## Goal
Researcher admins can add one or many sessions to a published or draft opportunity. Employees can see sessions and remaining capacity (booking is M4). Opportunities auto-close when all sessions are in the past or capacity is exhausted.

## Deliverables
- DB table and migrations for `sessions`
- REST endpoints for list/create/update/delete sessions
- Remaining slots calculation on API
- Public list and detail pages show sessions summary and remaining slots
- Admin session editor UI on Create/Edit Opportunity
- Auto close opportunity when last session end_time is past (cron or on access)
- Validation for overlapping and invalid sessions

## Data model
Table  `sessions`
- id  uuid pk
- opportunity_id  uuid fk opportunities.id not null on delete cascade
- start_time  timestamptz not null
- end_time  timestamptz not null
- capacity  int not null default 1
- booked_count  int not null default 0
- location_or_meet_link_optional  text
- created_at  timestamptz default now
- updated_at  timestamptz default now

Indexes
- idx_sessions_opportunity  btree(opportunity_id)
- idx_sessions_time  btree(start_time, end_time)

Constraints
- end_time > start_time
- capacity >= 1
- booked_count >= 0 and booked_count <= capacity

## API
GET `/api/opportunities/:id/sessions`
- Auth  public
- Returns  list of sessions with `remaining = capacity - booked_count`
- Query params  
  - `from` ISO optional filter start_time >= from
  - `include_past` bool default false

POST `/api/opportunities/:id/sessions`  [admin owner or admin role]
- Body  array or single object
  - start_time ISO
  - end_time ISO
  - capacity number
  - location_or_meet_link_optional string
- Behaviour  
  - Validates array atomically (all or none)
  - Rejects overlaps **within the provided batch** and **against existing sessions** for the same opportunity
  - Creates records, returns created list

PATCH `/api/sessions/:id`  [admin owner or admin role]
- Body  any of start_time, end_time, capacity, location_or_meet_link_optional
- Guards  
  - Cannot reduce capacity below `booked_count`
  - Cannot set end_time <= start_time
  - Overlap check against other sessions of same opportunity

DELETE `/api/sessions/:id`  [admin owner or admin role]
- Guard  reject delete if `booked_count > 0` (will be possible after M4)
- On success  remove session

POST `/api/opportunities/:id/close-if-past`  [admin owner or admin role]
- Optional utility to close when last session is past

## Server-side logic
- **Remaining slots**  `capacity - booked_count`
- **Opportunity auto status**  
  - On any sessions GET for an opportunity, if all sessions end_time < now and status = published → set status = closed
- **Overlap definition**  
  - Two sessions overlap if `(a.start < b.end) and (b.start < a.end)`
- **Time handling**  
  - All times stored in UTC `timestamptz`; frontend displays in user’s local zone

## Front end
### Public
- **Home list**  
  - For type = test  show a small chip:  
    - `n sessions • m total slots • r remaining`
    - If all past or remaining = 0  show `Full or closed`
- **Opportunity detail**  
  - Table of sessions  
    - Start local time, end local time, remaining
    - For M3  Book button disabled with tooltip “Booking in next step”
  - Empty state  “Sessions will appear here”

### Admin
- **Opportunity Create/Edit**  
  - **Session editor**  
    - Add session: start, end, capacity, optional location/Meet link
    - Quick add multi-day: date picker with time, capacity, repeat N days (client batch create)
    - Inline validation and overlap warnings
    - Edit and delete rows
  - **Preview** shows the sessions table exactly as public page will display
- **My opportunities**  
  - Add columns: `Sessions`, `Total slots`, `Remaining`
  - Badge `Closed` when auto-closed

## Validation rules
- start_time required ISO; end_time required ISO; end > start
- capacity integer 1..500 (configurable limit)
- No overlaps within same opportunity
- For edits, capacity cannot go below booked_count (booking arrives in M4)
- Past sessions allowed to be created for historical completeness, but UI should warn

## Background job (optional but recommended)
- Cron every 10 minutes  close opportunities where all sessions ended
- Alternatively rely on on-access check (simpler MVP)

## Test checklist
API
- Create single session 201
- Create batch sessions 201 atomic
- Reject overlaps 409 with clear message
- Update capacity fails when < booked_count
- GET sessions returns remaining and sorted by start_time
- Auto close flips status to `closed` when all past

UI
- Admin can add, edit, delete sessions with inline validation
- Preview reflects table accurately
- Public list shows sessions summary chips
- Detail shows sessions table, properly sorted, past sessions greyed

Edge cases
- Sessions spanning midnight
- Repeated daily sessions via batch add
- DST changes in local display (store UTC; rely on client to format)

Performance
- Opportunity with 200 sessions lists under 500 ms server response

Accessibility
- Keyboard operable session editor
- Error text associated to fields

## Risks
- Overlap logic edge cases  covered by unit tests including equal boundaries
- Time zone confusion  store UTC and format with explicit zone on client
- Auto close timing drift  acceptable in MVP, human can set status Closed manually if needed

## Definition of Done
- Sessions table live with full CRUD (except booked_count constraints for M4)
- Remaining slots shown on API and UI
- Opportunities auto-close when appropriate
- Unit tests for overlap and capacity rules
- E2E path  create opportunity → add sessions → list/preview sessions on UI
