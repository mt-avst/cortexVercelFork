# tasks_m2_opportunities.md

# Milestone M2  Opportunities
List, detail, and researcher admin CRUD for Opportunities. Public browse without login.

## Goal
Enable anyone inside the firewall to browse a unified list of opportunities. Allow researcher admins to create, publish, delete, and duplicate opportunities. Sessions come in M3, so use a placeholder on the detail page.

## Deliverables
- DB tables and migrations for `opportunities`
- REST endpoints for list, detail, create, update, delete, duplicate
- Public landing page with unified list and basic filters
- Opportunity detail page (sessions placeholder for M3)
- Admin create/edit form with preview and publish
- Delete and duplicate actions
- Basic empty states and error states
- Server-side validation

## Data model
Table  `opportunities`
- id  uuid pk
- type  enum test|poll|survey  not null
- title  text not null
- purpose_one_liner  text not null
- description_optional  text
- product_optional  text
- default_duration_minutes  int not null default 30
- status  enum draft|published|closed not null default draft
- owner_user_id  uuid fk users.id not null
- external_link_optional  text  (for poll or survey)
- created_at  timestamptz default now
- updated_at  timestamptz default now

Indexes
- idx_opportunities_status_type_title  btree(status, type, title)
- idx_opportunities_owner  btree(owner_user_id)

Notes
- Status transitions  draft→published, published→closed, closed not editable except reopen in later milestone if needed.

## API
All JSON. Errors return structured `{error: code, message}`.

GET `/api/opportunities`
- Query params  `type` in [test|poll|survey] optional, `q` text optional, `status` optional (defaults to published for unauth)
- Auth  public for `status=published`; admins can request any status
- Returns  array of public fields

GET `/api/opportunities/:id`
- Auth  public if published; admins can view any
- Returns  full public fields plus owner metadata for admins
- Note  include `sessions: []` placeholder for forward compatibility

POST `/api/opportunities`  [admin]
- Auth  researcher admin only
- Body  
  - type, title, purpose_one_liner
  - description_optional, product_optional
  - default_duration_minutes
  - external_link_optional
  - status initial  draft or published
- Validations  
  - type required; title 4..140; purpose 10..180; duration 5..240
  - If type is poll or survey and status is published, `external_link_optional` must be a valid URL
- Side effects  set owner_user_id from session user

PATCH `/api/opportunities/:id`  [admin owner or admin role]
- Auth  researcher admin; only owner or global admin
- Body  any mutable fields; status allowed draft↔published↔closed
- Guard  cannot publish if required fields missing

DELETE `/api/opportunities/:id`  [admin owner or admin role]
- Auth  researcher admin; only owner or global admin
- Behaviour  hard delete for MVP

POST `/api/opportunities/:id/duplicate`  [admin owner or admin role]
- Auth  researcher admin; only owner or global admin
- Behaviour  clones record as `draft` with “(copy)” suffix and new id

## Server-side validation rules
- title  required, trimmed, length 4..140
- purpose_one_liner  required, trimmed, length 10..180
- type  in enum
- default_duration_minutes  integer between 5 and 240
- external_link_optional  
  - required when type in [poll, survey] AND status=published
  - must be valid absolute URL (http or https)
- status transitions  enforce allowed graph

## Front end
### Public pages
1) **Home list**
- Unified list of all `published` opportunities
- Filters  Type [All, Test, Poll, Survey], text search
- Card layout fields  
  - Title
  - Purpose one-liner
  - Type badge
  - Duration minutes
  - For poll/survey  show “Opens externally”
- Empty state  “No opportunities right now”
- Error state  retry

2) **Opportunity detail**
- Show title, type, purpose, description, product, duration
- If test  show sessions placeholder block  
  - “Timeslots available soon” until M3
- If poll/survey  show button “Open survey” (disabled until M6 click tracking)
- CTA logic  
  - Test  show “Sign in to book” (disabled until M4)
  - Poll/Survey  “Open survey” link when published and URL present
- Footer  Contact owner name and email when signed in admin only

### Admin pages (SSO researcher admin only)
3) **Create/Edit form**
- Fields  type, title, purpose_one_liner, description_optional, product_optional, default_duration_minutes, external_link_optional, status
- Live validation
- Preview mode  shows read-only card and detail page preview
- Actions  Save draft, Publish, Update, Close

4) **My opportunities**
- Table of owned opportunities with actions  Edit, Delete, Duplicate, Status pill
- Filters  status

5) **Delete confirm**
- Modal with title and irreversible warning

## UI copy guidelines
- Plain, short labels
- Buttons  “Publish”, “Save draft”, “Duplicate”, “Delete”
- Validation hints inline under field

## Security
- Public GETs only return `published`
- Admin routes guarded with `requireAdmin`
- Ownership check on edit/delete/duplicate
- Input sanitisation and output escaping

## Migrations
- Create `opportunities` table and enums
- Add updated_at trigger

## Test checklist
API
- Create draft 201
- Publish with valid fields 200
- Publish with missing mandatory fields 400
- List public only shows published for unauth
- Admin list shows draft/published/closed with `status=*`
- Duplicate creates draft copy owned by caller
- Delete removes record; subsequent GET 404
- Search `q` matches title and purpose

UI
- Home list renders and filters by type
- Detail renders correct fields by type
- Create form validates and prevents publish when invalid
- Edit updates fields and status transitions respected
- Delete flow works and returns to My opportunities
- Duplicate produces a new draft visible in My opportunities

Performance
- List of 100 published items loads under 1s on corp Wi-Fi

Accessibility
- Form fields labelled, error text announced
- Buttons reachable by keyboard, focus order logical

## Risks
- Publishing polls/surveys without URL  blocked by validation
- Confusion about sessions not present yet  mitigate with placeholder text
- Search performance  add composite index and limit result size

## Definition of Done
- All endpoints implemented with validation and guards
- Migrations applied and rolled back cleanly
- Public list and detail work unauthenticated
- Admin CRUD flows complete with ownership checks
- Unit tests for validation and status transitions
- Basic e2e for create→publish→view→duplicate→delete
