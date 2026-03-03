# Cortex: What to Share with ClaudeL for Unmoderated Planning

This doc answers ClaudeL’s questions and provides the artifacts to pull from Cursor so ClaudeL can plan the unmoderated integration without guessing.

---

## 1. Tech stack (direct answers)

- **Cortex is not Next.js.**  
  - **Frontend:** React + Vite + TypeScript.  
  - **Backend:** Express.js (Node).  
  - **Database:** PostgreSQL.  
  - **ORM:** None — raw `pg` and SQL. Schema is defined in **migrations**, not Prisma.

- **There is no `schema.prisma`.**  
  The single source of truth for the DB schema is **`backend/src/db/migrate.ts`** (and any additive logic in **`api/run-migrations.ts`** for Vercel). Use that file as the “schema” for planning.

- **Deployment:** The repo can run as (1) Express server (e.g. Docker/local), or (2) Vercel serverless. On Vercel, the **`api/`** folder is the serverless API (mirrors Express routes). So there are two API “shapes”: **`backend/src/routes/`** (Express) and **`api/`** (Vercel serverless).

- **Testing platform (separate app vs inside Cortex):**  
  That’s a product/architecture choice only you can make. From the codebase we can say: Cortex already supports **unmoderated** as an **opportunity type** (external link + click tracking). If “unmoderated functionality” means a **dedicated testing platform** (e.g. task-based unmoderated tool), it could be either:
  - A **separate Vercel (or other) app** that talks to Cortex via API (e.g. create opportunity, record completion, trigger AdaptaBits), or  
  - A **module inside the Cortex repo** (e.g. new routes under `/api`, new frontend pages) that reuses Cortex auth and opportunities.  
  Sharing this doc with ClaudeL gives them the schema and API shape so they can propose both options clearly.

---

## 2. Database schema (for ClaudeL)

Below is the schema derived from **`backend/src/db/migrate.ts`**. This is the canonical structure; there is no Prisma file.

### Enums

- **opportunity_type:** `'test' | 'poll' | 'survey' | 'question' | 'interview' | 'unmoderated'`
- **opportunity_status:** `'draft' | 'published' | 'closed'`
- **participant_type:** `'any' | 'internal' | 'external' | 'specific'`
- **booking_status:** `'booked' | 'cancelled'`

### Core tables

**users**  
- `id` UUID PK  
- `name` TEXT NOT NULL  
- `email` TEXT UNIQUE NOT NULL  
- `business_unit` TEXT, `role_title` TEXT  
- `role` TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'researcher_admin', 'superadmin'))  
- `created_at` TIMESTAMPTZ  

**opportunities**  
- `id` UUID PK  
- `type` opportunity_type NOT NULL  
- `title` TEXT NOT NULL (length 4–140)  
- `purpose_one_liner` TEXT NOT NULL (length 10–180)  
- `description_optional` TEXT, `product_optional` TEXT  
- `default_duration_minutes` INT DEFAULT 30 (5–240)  
- `status` opportunity_status NOT NULL DEFAULT 'draft'  
- `owner_user_id` UUID FK → users(id) ON DELETE CASCADE  
- `external_link_optional` TEXT  
- `meeting_location_optional` TEXT  
- `participant_type_required` participant_type DEFAULT 'any'  
- `participant_type_specific_details` TEXT  
- `start_date` TIMESTAMPTZ, `end_date` TIMESTAMPTZ  
- `display_width` TEXT DEFAULT 'single' CHECK (display_width IN ('single', 'double'))  
- `created_at`, `updated_at` TIMESTAMPTZ  

**sessions**  
- `id` UUID PK  
- `opportunity_id` UUID FK → opportunities(id) ON DELETE CASCADE  
- `start_time`, `end_time` TIMESTAMPTZ NOT NULL  
- `capacity` INT DEFAULT 1, `booked_count` INT DEFAULT 0  
- `location_or_meet_link_optional` TEXT  
- `created_at`, `updated_at` TIMESTAMPTZ  
- CHECK (end_time > start_time), CHECK (booked_count <= capacity)  

**bookings**  
- `id` UUID PK  
- `user_id` UUID FK → users(id), `session_id` UUID FK → sessions(id)  
- `status` booking_status NOT NULL DEFAULT 'booked'  
- `gcal_event_id` TEXT  
- `cancelled_at` TIMESTAMPTZ  
- `completion_status` TEXT DEFAULT 'pending' CHECK (completion_status IN ('pending', 'completed', 'approved', 'rejected'))  
- `completed_at`, `approved_at` TIMESTAMPTZ  
- `approved_by` UUID FK → users(id), `admin_notes` TEXT  
- `created_at`, `updated_at` TIMESTAMPTZ  
- UNIQUE (user_id, session_id) WHERE status = 'booked'  

**opportunity_clicks** (M6 – click tracking for poll/survey/unmoderated and action tracking)  
- `id` UUID PK  
- `opportunity_id` UUID FK → opportunities(id) ON DELETE CASCADE  
- `user_id` UUID FK → users(id) ON DELETE SET NULL (optional auth)  
- `click_type` TEXT NOT NULL DEFAULT 'action'  — `'view'` = viewed detail, `'action'` = clicked button (open link / book)  
- `clicked_at` TIMESTAMPTZ DEFAULT NOW()  
- `user_agent` TEXT, `ip_hash` TEXT  

### Supporting tables (short)

- **notification_preferences** — user_id, on_book_email, on_cancel_email  
- **settings** — key, value_json  
- **user_profiles** — AdaptaBits: user_id, total_points, monthly_points, level, sessions_completed, surveys_completed, polls_completed, questions_completed, last_activity_date  
- **achievements**, **user_achievements** — gamification  
- **user_calendar_tokens** — Google Calendar (admin)  
- **points_transactions** — user_id, points, reason, opportunity_id, session_id  
- **admin_requests** — user_id, requested_role ('researcher_admin'|'superadmin'), status ('pending'|'approved'|'denied'), reviewed_by, reviewed_at, notes  

### Where “unmoderated” sits

- **opportunities.type** can be `'unmoderated'`.  
- Unmoderated opportunities are **external-link-only** (like poll/survey): no sessions; they use **opportunity_clicks** for view/action tracking and the same analytics as poll/survey.  
- Validation: when `status === 'published'` and `type` is poll, survey, or unmoderated, **external_link_optional** is required.

---

## 3. API route structure

### 3.1 Express backend (`backend/src/routes/`)

Mount point: **`/api`** (see `backend/src/index.ts`: `app.use('/api', apiRoutes)`).

From **`backend/src/routes/api.ts`**:

| Mount | Router / file | Purpose |
|-------|----------------|--------|
| GET `/api/me` | api.ts | Current user (requireAuth) |
| `/api/opportunities` | opportunities.ts | CRUD, list, get by id, sessions, click, analytics |
| `/api/sessions` | sessions.ts | Create, patch, delete sessions; duplicate opportunity; close-if-past; sync-booked-counts |
| `/api/bookings` | bookings.ts | book, cancel, reschedule, my/bookings, complete, approve, reject, pending-approvals |
| `/api/calendar` | calendar.ts + userCalendar.ts | events, availability, check-conflicts; user calendar auth/callback, my-events, connection-status, disconnect |
| `/api/gamification` | gamification.ts | profile, achievements, leaderboard, leaderboard/monthly, points-history |
| `/api/admin` | admin.ts | dashboard, request, requests, requests/:id/approve|deny, admins (GET/DELETE) |
| `/api/notification-preferences` | notificationPreferences.ts | GET, PATCH |
| `/api/feedback` | feedback.ts | POST, GET (admin), DELETE (superadmin), export |
| `/api/stats` | stats.ts | GET platform (public) |

**Relevant for unmoderated:**

- **GET /api/opportunities** — list (optional auth); query params e.g. type, q (search).  
- **GET /api/opportunities/:id** — detail; for poll/survey/unmoderated, admin can see click count.  
- **POST /api/opportunities/:id/click** — body `{ "click_type": "view" | "action" }`. Optional auth. Used when user views detail or clicks “Open Poll/Survey” or “Start unmoderated test.”  
- **GET /api/opportunities/:id/analytics** — admin/owner only; views/actions, time series, period 7|14|30.  
- **POST /api/opportunities** — admin create (type can be `unmoderated`).  
- **PATCH /api/opportunities/:id** — admin update.

### 3.2 Vercel serverless API (`api/` directory)

Same logical surface, implemented as serverless functions. Key paths:

- **api/me.ts**  
- **api/opportunities.ts** (list)  
- **api/opportunities/[id].ts** (get one; click count for poll/survey/unmoderated for admin)  
- **api/opportunities/[id]/click.ts** (POST click)  
- **api/opportunities/[id]/analytics.ts**  
- **api/opportunities/[id]/sessions.ts**  
- **api/opportunities/[id]/duplicate.ts**  
- **api/bookings/…** (my/bookings, book, cancel, etc.)  
- **api/sessions.ts**, **api/sessions/[id].ts**  
- **api/admin/** (dashboard, requests, admins, reset-demo-data, etc.)  
- **api/feedback.ts**, **api/feedback/[id].ts**, **api/feedback/export.ts**  
- **api/gamification/** (profile, leaderboard, leaderboard/monthly)  
- **api/calendar/** (events, availability, connection-status, etc.)  
- **api/notification-preferences.ts**  
- **api/run-migrations.ts**  
- **api/cron/send-reminders.ts**  
- **api/auth/** (google-login, google-callback, demo-login, admin-login, superadmin-login, logout)

So: **no `/app/api` or `/pages/api`** — it’s either Express under `backend/src/routes` or Vercel under `api/`.

---

## 4. Existing “unmoderated” behaviour (no separate handler)

Unmoderated is already implemented as an **opportunity type**, not a separate service:

- **Create:** Admin creates an opportunity with `type: 'unmoderated'` and sets **external_link_optional** (required when published).  
- **Display:** Same as poll/survey: opportunity card and detail page show a CTA (e.g. “Start unmoderated test in new tab”) that opens the external link.  
- **Tracking:** Frontend calls **POST /api/opportunities/:id/click** with `click_type: 'view'` (detail opened) or `'action'` (button clicked). Same as poll/survey.  
- **Analytics:** **GET /api/opportunities/:id/analytics** (admin/owner) returns views/actions and time series for unmoderated like for poll/survey.  
- **No sessions:** Unmoderated has no sessions; no booking. Completion/rewards are not automatically tied to the external tool (e.g. no “mark complete” in Cortex today from an external testing platform).

So for “unmoderated functionality” to grow (e.g. integrate a testing platform, mark completion, award AdaptaBits), ClaudeL will need to consider:

- How completion is reported (e.g. new API: “record unmoderated completion” with user + opportunity id, optional payload).  
- Whether that lives in Cortex (new route + maybe new table or reuse of existing) or in a separate app that calls Cortex.

---

## 5. What to give ClaudeL from Cursor

- **This file** — `docs/CORTEX-FOR-CLAUDEL-UNMODERATED-PLANNING.md` (you can copy or link it).  
- **Schema source** — `backend/src/db/migrate.ts` (full file; it’s the only “schema” file).  
- **API shape** — either:
  - This doc’s section 3, or  
  - A directory listing: `backend/src/routes/` and `api/` (no need to send full code).  
- **Unmoderated** — this doc’s section 4; plus if useful: `api/opportunities/[id]/click.ts` and `backend/src/routes/opportunities.ts` (click + analytics + create/update validation).  
- **HackDay / HackDay Central** — not in this repo. Use **`docs/HDC-OVERVIEW-TEMPLATE-FOR-CLAUDEL.md`**: fill it from the HDC codebase (schema, identity, APIs, testing trigger), then share the filled overview with ClaudeL so they can map the three-product architecture and build sequence.

---

## 5a. What’s still unknown (for ClaudeL) — HDC

Until the HDC overview is filled and shared:

1. **HDC identity:** Does HackDay Central have its own user identity or defer to Cortex (e.g. same SSO, or HDC calls Cortex `/api/me`)? Need a one-sentence answer from the HDC codebase.
2. **Who triggers the testing tool:** Is the testing tool something HDC triggers directly (e.g. “Run a usability test on this HackDay submission”) or is that integration planned for later? Need product/code confirmation.
3. **HDC data model:** Main entities (events, submissions, etc.) and any existing link to tests/Cortex. Use the template in **`docs/HDC-OVERVIEW-TEMPLATE-FOR-CLAUDEL.md`** and fill it from the HDC repo; then share with ClaudeL for the full three-product map and build sequence.

---

## 6. Quick answers to ClaudeL’s questions (copy-paste friendly)

1. **Database schema**  
   There is no Prisma. The schema is in **`backend/src/db/migrate.ts`**. Share that file (or the “Database schema” section above). Relationships: User → Opportunities (owner); Opportunity → Sessions; Session → Bookings; User → Bookings; Opportunity → opportunity_clicks. Unmoderated is an **opportunity type** and uses **opportunity_clicks** like poll/survey.

2. **API route structure**  
   No `/app/api` or `/pages/api`. Cortex uses **Express** under **`backend/src/routes/`** (mounted at `/api`) and/or **Vercel serverless** under **`api/`**. Directory listing of **`backend/src/routes/`** and **`api/`** is enough for “shape”; key for unmoderated: opportunities (list, get, create, patch), **opportunities/:id/click**, **opportunities/:id/analytics**.

3. **Existing unmoderated handler**  
   There is no separate unmoderated handler. Unmoderated is an opportunity type; create/update in opportunities routes; tracking via **POST /api/opportunities/:id/click**; analytics via **GET /api/opportunities/:id/analytics**. See section 4 above.

4. **Tech stack**  
   **Not Next.js.** React (Vite) + Express + PostgreSQL (raw `pg`, no Prisma). Optional Vercel serverless in `api/`.

5. **Testing platform: separate app vs inside Cortex**  
   Product decision. Cortex already has unmoderated as external-link + click tracking. A full “testing platform” could be a separate app calling Cortex APIs or a module inside this repo; the schema and API layout in this doc are enough for ClaudeL to propose both.

---

*Generated from the Cortex (Labs2) codebase for ClaudeL unmoderated integration planning.*
