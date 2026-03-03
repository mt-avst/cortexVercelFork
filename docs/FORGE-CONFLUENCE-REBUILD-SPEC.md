# Adaptalabs → Forge Confluence Custom UI Rebuild Specification

**Purpose:** Exact specification for an agent (or developer) to rebuild the Adaptalabs recruitment webapp as a Forge Custom UI app on Confluence from scratch. Follow this document step-by-step; do not use the existing React/Express codebase as copy-paste—reimplement using Forge UI Kit, resolvers, and storage only.

**Reference codebase:** `/Volumes/Extreme Pro/Labs2` (frontend: React + Vite + Tailwind; backend: Express + PostgreSQL).

---

## 1. Overview and scope

### 1.1 Product name and purpose

- **App name:** Adaptalabs (or “Cortex” / “Adaptavist Cortex” as branding).
- **Purpose:** Recruitment/research participation app. Researchers (employees) discover opportunities (tests, polls, surveys, etc.), book sessions, complete activities, and earn AdaptaBits (gamification). Admins create opportunities and sessions; superadmins manage admin requests and feedback.

### 1.2 Target platform

- **Product:** Confluence (cloud).
- **Surface:** Custom UI (UI Kit) — either **Confluence custom page(s)** or **Confluence macro(s)**. No full SPA routing; use **Tabs** or **multiple modules** to approximate “pages”.
- **Auth:** Confluence user only. Identity = `view.getContext()` → `accountId` (and optional Confluence space/page context). No Google OAuth or demo logins unless reimplemented via Forge OAuth provider + storage.

### 1.3 In-scope features (must implement)

| Feature area | Description |
|-------------|-------------|
| **Opportunities** | List (filter by type, search, status); detail view; create/edit/delete/duplicate (admin); sessions CRUD per opportunity; status draft/published/closed. |
| **Sessions** | Per opportunity: start_time, end_time, capacity, location; booked_count; create/patch/delete; “close if past” and “sync booked counts”. |
| **Bookings** | User books a session; cancel; reschedule to another session; “my bookings” (upcoming + past); admin: list bookings for opportunity; complete session → approve/reject (AdaptaBits). |
| **User identity** | Current user = Confluence accountId; store display name/email from Confluence or from first feedback/book. |
| **Roles** | employee (default), researcher_admin (admin), superadmin. Store in Forge storage (e.g. `users` entity or KVS by accountId). Admin = create/edit opportunities and sessions; superadmin = admin requests, revoke admin, feedback list/delete. |
| **Admin dashboard** | Stats (counts: opportunities, bookings, sessions, slots); recent bookings list. |
| **Admin requests** | User can request researcher_admin or superadmin; superadmin approves/denies; list admins and revoke. |
| **Gamification (AdaptaBits)** | User profile (points, level); achievements; leaderboard (all-time + monthly); points history; award points on session approval. |
| **Feedback** | Submit feedback (category, text, url, user_agent); admin list; superadmin delete; export (CSV) optional. |
| **Notification preferences** | Per user: on_book_email, on_cancel_email (stored only; email sending out of scope unless using Forge + external provider). |
| **Analytics (per opportunity)** | Clicks (view/action); totals and time-series; conversion rate. Admin only. |
| **Click tracking** | On view detail / action button: record click with type view | action. |
| **Platform stats (public)** | Counts for homepage: active studies, participants, rewards (e.g. total points). |

### 1.4 Out of scope / simplified

- **Landing page:** No standalone marketing landing; Confluence page or macro config provides context.
- **Google Calendar:** No calendar sync; no “availability” or “check-conflicts” against Google. Optional later: store “calendar busy” in Forge if needed.
- **Email:** No nodemailer; store notification prefs only, or add later via Forge + external API.
- **Poll/Survey external links:** Opportunity can have `external_link_optional`; user opens in new tab. No embedded poll widget.
- **Theme (dark/light):** Use Confluence/UI Kit defaults (or macro config for “appearance” if desired).
- **Three.js / Framer Motion / Radix:** Not available; use only UI Kit components and xcss.

---

## 2. Forge app structure

### 2.1 Module strategy

Use **one Confluence module** that hosts the whole app UI (custom page or macro). Navigation inside the app via **Tabs** (e.g. Home, My Bookings, Admin, Settings, Gamification, Feedback).

- **Option A – Single custom page:** `confluence:globalPage` or product-specific custom page module; one resource, one resolver.
- **Option B – Macro:** `confluence:macro` with `config: true`; config = title, default tab, filters. Main UI in one resource.

**Recommended for spec:** One `confluence:macro` module (key: `adaptalabs-macro`) so the app can be embedded in any Confluence page. If custom page is preferred, swap module type; resolver and frontend contract stay the same.

### 2.2 Manifest (minimal)

```yaml
app:
  id: 'ari:cloud:ecosystem::app/YOUR-APP-ID'   # From forge create
  runtime:
    name: nodejs22.x

modules:
  macro:
    - key: adaptalabs-macro
      resource: main
      render: native
      resolver:
        function: resolver
      title: Adaptalabs
      description: Research opportunities and bookings
      config: true

  function:
    - key: resolver
      handler: index.handler

resources:
  - key: main
    path: src/frontend/index.tsx

permissions:
  scopes:
    - read:confluence-content.summary
    - read:confluence-user
    # Add storage scope if using Forge storage (see Forge docs)
  # external fetch if you call external APIs later
```

- **Scopes:** Add only what you need (e.g. `read:confluence-user` for current user). Use `search-forge-docs` for storage scopes.
- **Config:** Macro config UI uses only: Label, Textfield, Select, CheckboxGroup, DatePicker, TextArea, UserPicker (see confluence-macro-developer-guide).

### 2.3 Directory layout

```
src/
├── index.ts                    # Resolver export (handler)
├── types/                      # Shared types (frontend + resolvers)
│   └── index.ts
├── resolvers/
│   └── index.ts                # Resolver definitions (invoke names)
├── storage/                    # Forge storage helpers (KVS / custom entities / SQL)
│   └── ...
├── frontend/
│   ├── index.tsx               # Entry: ForgeReconciler.render(<App />); ForgeReconciler.addConfig(<Config />);
│   ├── App.tsx                 # Tabs: Home | My Bookings | Admin | Settings | Gamification | Feedback
│   ├── components/             # UI Kit only
│   └── ...
└── ...
```

No `backend/` Express app; no `frontend/src/api/client` axios. Data flow: frontend `invoke('resolverName', payload)` → resolver → storage or Confluence API.

---

## 3. Data model and storage

### 3.1 Entity definitions (source of truth)

Map current PostgreSQL schema to Forge storage. Prefer **Forge Custom Entities** (or Forge SQL) for relational data; use **KVS** only for simple key-value (e.g. settings, feature flags).

**Users (Confluence-backed + app roles)**

- **Identity:** Confluence `accountId` (and optionally display name from Confluence API).
- **App storage:** Store per `accountId`: role (`employee` | `researcher_admin` | `superadmin`), display_name, email (if fetched), created_at. Use KVS key `user:{accountId}` or custom entity `users` with key = accountId.

**Opportunities**

- id (UUID), type, title, purpose_one_liner, description_optional, product_optional, default_duration_minutes, status (draft | published | closed), owner_user_id (accountId), external_link_optional, meeting_location_optional, participant_type_required, participant_type_specific_details, start_date, end_date, display_width (optional), created_at, updated_at.
- Same fields as current `Opportunity` type in `frontend/src/shared/types.ts` (and backend migrate.ts).

**Sessions**

- id, opportunity_id, start_time, end_time, capacity, booked_count, location_or_meet_link_optional, created_at, updated_at. Constraint: end_time > start_time, booked_count <= capacity.

**Bookings**

- id, user_id (accountId), session_id, status (booked | cancelled), completion_status (pending | completed | approved | rejected), completed_at, approved_at, approved_by, admin_notes, gcal_event_id (optional), cancelled_at, created_at, updated_at.
- Unique active booking: (user_id, session_id) where status = 'booked'.

**Notification preferences**

- user_id (accountId), on_book_email, on_cancel_email. One per user (KVS or entity).

**Admin requests**

- id, user_id, requested_role (researcher_admin | superadmin), status (pending | approved | denied), reviewed_by, reviewed_at, notes, requested_at, created_at, updated_at.

**Feedback**

- id, user_id (nullable), user_name, user_email, category (bug | feature | question | other), feedback, url, user_agent, created_at.

**Gamification**

- **user_profiles:** user_id, total_points, monthly_points, level, sessions_completed, surveys_completed, polls_completed, questions_completed, last_activity_date, created_at, updated_at.
- **achievements:** id, name, description, icon, points_required, category, badge_color, created_at.
- **user_achievements:** user_id, achievement_id, earned_at.
- **points_transactions:** id, user_id, points, reason, opportunity_id (optional), session_id (optional), created_at.

**Analytics (clicks)**

- **opportunity_clicks:** id, opportunity_id, user_id (accountId), click_type (view | action), clicked_at.

**Settings (global)**

- key-value; e.g. key `platform_stats_cache` with JSON. Use KVS.

### 3.2 Storage implementation choice

- **Forge Custom Entities:** Use for opportunities, sessions, bookings, user_profiles, achievements, user_achievements, points_transactions, opportunity_clicks, admin_requests, feedback. Define entities and relationships per Forge docs (e.g. opportunity has many sessions; session has many bookings).
- **Forge KVS:** Use for users (by accountId), notification_preferences, settings.
- **Forge SQL:** Alternative if you need complex queries (e.g. leaderboard, analytics); same schema concepts apply.

**Important:** Forge has no PostgreSQL. You must implement all reads/writes via Forge Storage API or Forge SQL. Document exact entity names and key patterns in `src/storage/README.md` (e.g. `opportunity:{id}`, `session:{id}`).

### 3.3 Shared types (TypeScript)

Define in `src/types/index.ts` (and reuse in frontend):

- **User, SessionUser, Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest**
- **Session, CreateSessionRequest, UpdateSessionRequest**
- **Booking, BookingWithDetails, UserBookings, RescheduleBookingRequest**
- **AdminRequest, NotificationPreference, FeedbackItem**
- **UserProfile, Achievement, UserAchievement, LeaderboardEntry, PointsTransaction** (gamification)
- **OpportunityAnalytics, DashboardStats, PlatformStats**
- **MacroConfig** (from useConfig(): title, defaultTab, etc.)

All enums (opportunity type, status, booking status, etc.) must match the tables above. No `any` or `unknown` in resolver payloads/returns.

---

## 4. Resolver specification

Every current REST endpoint becomes a resolver function. Frontend calls `invoke('functionName', payload)`. Resolver receives `payload` and optional `context`; returns JSON-serializable data.

**Naming:** Use camelCase resolver names. Map 1:1 from current API where possible.

### 4.1 Auth / user

| Resolver | Payload | Returns | Notes |
|----------|---------|--------|--------|
| `getMe` | — | `User` | Current Confluence user + app role from storage; create user row if missing. |
| `logout` | — | — | No-op or clear app session in storage if you add one. |

### 4.2 Opportunities

| Resolver | Payload | Returns | Notes |
|----------|---------|--------|--------|
| `getOpportunities` | `{ type?, q?, status? }` | `Opportunity[]` | Filter by type, search q on title/purpose, status. Non-admin: only published. |
| `getOpportunity` | `{ id: string }` | `Opportunity` | By id; include sessions. 404 if not found. |
| `createOpportunity` | `CreateOpportunityRequest` | `Opportunity` | requireAdmin. |
| `updateOpportunity` | `{ id: string }` + `UpdateOpportunityRequest` | `Opportunity` | requireAdmin. |
| `deleteOpportunity` | `{ id: string }` | — | requireAdmin. |
| `duplicateOpportunity` | `{ id: string }` | `Opportunity` | requireAdmin; copy opportunity + sessions. |
| `getSessions` | `{ opportunityId: string, from?, include_past? }` | `Session[]` | |
| `createSessions` | `{ opportunity_id: string, sessions: CreateSessionRequest[] }` | `Session[]` | requireAdmin. |
| `updateSession` | `{ sessionId: string }` + `UpdateSessionRequest` | `Session` | requireAdmin. |
| `deleteSession` | `{ sessionId: string }` | — | requireAdmin. |
| `closeOpportunityIfPast` | `{ opportunityId: string }` | — | requireAdmin. |
| `syncBookedCounts` | — | — | requireAdmin; recalc booked_count for all sessions. |
| `trackOpportunityClick` | `{ opportunityId: string, clickType: 'view' \| 'action' }` | `{ ok: boolean }` | optionalAuth; record in opportunity_clicks. |
| `getOpportunityAnalytics` | `{ opportunityId: string, period?: 7 \| 14 \| 30 }` | `OpportunityAnalytics` | requireAdmin. |

### 4.3 Bookings

| Resolver | Payload | Returns | Notes |
|----------|---------|--------|--------|
| `bookSession` | `{ sessionId: string }` | `Booking` | requireAuth; validations as current backend. |
| `cancelBooking` | `{ bookingId: string }` | — | requireAuth; own booking. |
| `rescheduleBooking` | `{ bookingId: string, target_session_id: string }` | — | requireAuth; own booking. |
| `getMyBookings` | — | `UserBookings` | requireAuth; { upcoming, past }. |
| `getOpportunityBookings` | `{ opportunityId: string }` | `BookingWithDetails[]` | requireAdmin. |
| `completeSession` | `{ sessionId: string }` | `{ message, status, awaitingApproval }` | requireAdmin; mark session complete; pending approvals. |
| `getPendingApprovals` | — | `BookingWithDetails[]` or similar | requireAdmin; bookings needing approve/reject. |
| `approveBooking` | `{ bookingId: string, adminNotes?: string }` | `{ message, pointsAwarded, newLevel, levelUp, totalPoints }` | requireAdmin; award AdaptaBits. |
| `rejectBooking` | `{ bookingId: string, adminNotes?: string }` | `{ message, status }` | requireAdmin. |
| `cleanupCancelledBookings` | — | — | requireAuth; optional. |

### 4.4 Admin

| Resolver | Payload | Returns | Notes |
|----------|---------|--------|--------|
| `getDashboardStats` | — | `DashboardStats` | requireAdmin. |
| `requestAdminAccess` | — | `{ success, request: AdminRequest, message }` | requireAuth. |
| `getAdminRequests` | `{ status? }` | `{ success, requests: AdminRequest[] }` | requireSuperadmin. |
| `approveAdminRequest` | `{ requestId: string }` | `{ success, message }` | requireSuperadmin. |
| `denyAdminRequest` | `{ requestId: string, notes? }` | `{ success, message }` | requireSuperadmin. |
| `getAdmins` | — | `{ success, admins: User[] }` | requireSuperadmin. |
| `revokeAdminAccess` | `{ adminId: string }` | `{ success, message }` | requireSuperadmin. |

### 4.5 Gamification

| Resolver | Payload | Returns | Notes |
|----------|---------|--------|--------|
| `getGamificationProfile` | — | `UserProfile` | requireAuth; create profile if missing. |
| `getAchievements` | — | `UserAchievement[]` | requireAuth. |
| `getLeaderboard` | `{ limit?: number }` | `LeaderboardEntry[]` | Public. |
| `getMonthlyLeaderboard` | `{ limit?: number }` | `LeaderboardEntry[]` | Public. |
| `getPointsHistory` | `{ limit?: number }` | `PointsTransaction[]` | requireAuth. |

### 4.6 Feedback

| Resolver | Payload | Returns | Notes |
|----------|---------|--------|--------|
| `submitFeedback` | `{ category, feedback, userAgent, url }` | `{ success: boolean }` | Store; user from context. |
| `getFeedback` | — | `FeedbackItem[]` | requireAdmin. |
| `deleteFeedback` | `{ id: string }` | `{ success }` | requireSuperadmin. |
| `exportFeedbackCsv` | — | CSV content or signed URL | requireAdmin; if Forge allows file download pattern. |

### 4.7 Notification preferences

| Resolver | Payload | Returns | Notes |
|----------|---------|--------|--------|
| `getNotificationPreferences` | — | `NotificationPreferenceResponse` | requireAuth. |
| `updateNotificationPreferences` | `{ on_book_email, on_cancel_email }` | `NotificationPreferenceResponse` | requireAuth. |

### 4.8 Stats (public)

| Resolver | Payload | Returns | Notes |
|----------|---------|--------|--------|
| `getPlatformStats` | — | `PlatformStats` | No auth; counts for homepage. |

### 4.9 Resolver implementation rules

- **Authorization:** At start of each resolver: get current user from context; load role from storage; if requireAdmin/requireSuperadmin and role insufficient, throw (e.g. Forbidden).
- **Validation:** Validate payload (required fields, types). Use shared types; no `any`.
- **Idempotency:** Book: one active booking per (user, session). Create user/profile if not exists where specified.
- **Errors:** Return clear message; frontend shows SectionMessage or showFlag.

---

## 5. Frontend (UI Kit) specification

### 5.1 Allowed stack

- **React:** Only for component tree and hooks (useState, useEffect, useCallback, useMemo, etc.).
- **UI:** Only `@forge/react` components (Box, Stack, Inline, Text, Heading, Button, Link, Tabs, TabList, Tab, TabPanel, DynamicTable, Form, Textfield, TextArea, Select, CheckboxGroup, DatePicker, Label, Spinner, SectionMessage, EmptyState, Modal, Lozenge, Tag, User, UserGroup, etc.). See forge-ui-kit-developer-guide.
- **Styling:** xcss and design tokens only (e.g. space.100, color.text). No className, no Tailwind, no raw CSS files.
- **Data:** `invoke(resolverName, payload)` and `view.getContext()` from `@forge/bridge`. No axios.

### 5.2 App shell and navigation

- **Entry:** `src/frontend/index.tsx` renders `<App />` and registers config: `ForgeReconciler.addConfig(<Config />)`.
- **App:** Single root with **Tabs**: id e.g. `main-tabs`, TabList with Tab labels: **Home** | **My Bookings** | **Admin** | **Settings** | **Gamification** | **Feedback**. TabPanels in order. Use Tabs structure from forge-ui-kit-developer-guide (no selection props on Tab; TabPanels as direct children of Tabs).
- **Config (macro):** If macro: Config component with Label + Textfield for “Title”, Select for “Default tab”, etc. Main app reads `useConfig()` and uses e.g. config.title in Heading. Default config when null.

### 5.3 Tab: Home

- **Content:** List of opportunities (published only for non-admin; admin sees filter or all).
- **UI:** Filters: Select for type (all | test | poll | survey | question | interview | unmoderated); Textfield for search (q); optional Select for status (admin). “Apply” or live filter.
- **List:** DynamicTable or list of Box “cards”: title, purpose_one_liner, type (Lozenge), status, dates, “View” Link/Button. Link to opportunity detail (see below). EmptyState when no results.
- **Platform stats:** Optional Inline/Stack at top: active studies, participants, rewards (from getPlatformStats).
- **Data:** invoke('getOpportunities', { type, q, status }); invoke('getPlatformStats').

### 5.4 Opportunity detail (nested view or modal)

- **Entry:** From Home row click: show detail in same tab (state: selectedOpportunityId) or open in Modal. No separate route.
- **Detail UI:** Heading (title), Text (purpose, description, product, duration, dates, external link, location). Sessions: DynamicTable or list (start, end, capacity, booked_count, remaining, “Book” Button). If external_link_optional: Button “Open poll/survey” etc.
- **Actions:** Book session → invoke('bookSession', { sessionId }); then showFlag success; refresh sessions/my bookings. Track click: invoke('trackOpportunityClick', { opportunityId, clickType: 'view' }) on load; clickType: 'action' on action button.
- **Data:** invoke('getOpportunity', { id }); getSessions if not embedded.

### 5.5 Tab: My Bookings

- **Content:** Two sections: Upcoming, Past (from getMyBookings).
- **UI:** For each: DynamicTable or list of BookingWithDetails (opportunity title, session time, location, status). Actions: Cancel, Reschedule (Select target session then invoke rescheduleBooking). EmptyState when empty.
- **Data:** invoke('getMyBookings').

### 5.6 Tab: Admin

- **Visibility:** Only if current user role is researcher_admin or superadmin (getMe.role). Else show SectionMessage “Admin access required”.
- **Sub-navigation:** Use nested Tabs or Inline buttons: Dashboard | Opportunities | Sessions (per opportunity) | Bookings | Pending approvals | Admin requests (superadmin) | Admins (superadmin) | Feedback (superadmin).
- **Dashboard:** KPI-style boxes: total opportunities, published, draft, closed; total bookings, upcoming, past; total sessions, slots, booked_slots; recent bookings table (getDashboardStats).
- **Opportunities:** List all (admin filter status/type); “New” Button → form (see below). Row actions: Edit, Duplicate, Delete, Analytics. Edit/Duplicate open form with prefilled data.
- **Opportunity form (create/edit):** Form with: type (Select), title (Textfield), purpose_one_liner (Textfield), description_optional (TextArea), product_optional (Textfield), default_duration_minutes (Textfield number), status (Select), external_link_optional, meeting_location_optional, participant_type_required, participant_type_specific_details, start_date (DatePicker), end_date (DatePicker). Submit: createOpportunity or updateOpportunity.
- **Sessions (per opportunity):** List sessions; “Add session” → Form (start_time, end_time, capacity, location); createSessions. Row: Edit (updateSession), Delete (deleteSession). Buttons: “Close if past”, “Sync booked counts”.
- **Bookings (per opportunity):** getOpportunityBookings; table; optional “Complete session” for a session → completeSession; then show pending approvals.
- **Pending approvals:** getPendingApprovals; table with Approve/Reject; approveBooking/rejectBooking with optional adminNotes.
- **Admin requests (superadmin):** getAdminRequests; table; Approve/Deny; approveAdminRequest, denyAdminRequest.
- **Admins (superadmin):** getAdmins; table; Revoke → revokeAdminAccess.
- **Feedback (superadmin):** getFeedback; table; Delete; exportFeedbackCsv if implemented.

### 5.7 Tab: Settings

- **Content:** getNotificationPreferences; Form: on_book_email (CheckboxGroup or Toggle), on_cancel_email; submit updateNotificationPreferences. Optional: display name override (if stored).

### 5.8 Tab: Gamification

- **Content:** getGamificationProfile (points, level); getAchievements (earned); getLeaderboard / getMonthlyLeaderboard (DynamicTable or list); getPointsHistory. Use design tokens for “cards” (Box + xcss). No charts required unless UI Kit has BarChart/LineChart and you use them.

### 5.9 Tab: Feedback

- **Content:** Form: category (Select: bug | feature | question | other), feedback (TextArea), url (optional, from context or Textfield); submit submitFeedback. showFlag on success.

### 5.10 Opportunity analytics (admin)

- **Entry:** From Admin → Opportunities → “Analytics” on a row.
- **Content:** getOpportunityAnalytics(opportunityId, period). Show: totals (views, actions, conversion), time-series (e.g. by day). Use UI Kit data viz components if available (BarChart, LineChart); else DynamicTable + Text.

### 5.11 UI Kit rules (reminder)

- No HTML elements (div, span, button, input, a). Use Box, Text, Button, Link, Textfield, etc.
- Tabs: Tabs(id) → TabList → Tab(s) → TabPanel(s) in order; no selection props on Tab.
- CheckboxGroup: name + options array; value + onChange; no nested Checkbox children.
- Form inputs: use Label with labelFor; no built-in label on most inputs.
- Empty/loading: Spinner while loading; EmptyState when no data; SectionMessage for errors or “configure macro”.

---

## 6. Auth and permissions mapping

- **Current user:** From `view.getContext()` in frontend (accountId, cloudId, etc.). In resolver, use Forge context to get accountId (see Forge docs for resolver context).
- **Roles:** Stored in app storage (users table or KVS). Default role = employee. researcher_admin and superadmin set by superadmin (approve admin request) or seed.
- **requireAuth:** Resolver checks user exists and is logged-in (Confluence context present).
- **requireAdmin:** role === 'researcher_admin' || role === 'superadmin'.
- **requireSuperadmin:** role === 'superadmin'.
- No Google or demo login unless you add OAuth provider in manifest and token storage; then “login” is “install app / open in Confluence”.

---

## 7. Implementation order

Execute in this order so dependencies are available.

1. **Project init:** `forge create`; choose Confluence + UI Kit template. Set manifest (macro + resolver). Add `src/types/index.ts` with all shared types.
2. **Storage:** Implement storage layer (KVS and/or Custom Entities). Implement user get/create by accountId; roles.
3. **Resolvers (auth):** getMe (and logout if needed).
4. **Resolvers (opportunities):** getOpportunities, getOpportunity, createOpportunity, updateOpportunity, deleteOpportunity, duplicateOpportunity; getSessions, createSessions, updateSession, deleteSession; closeOpportunityIfPast, syncBookedCounts; trackOpportunityClick; getOpportunityAnalytics.
5. **Resolvers (bookings):** bookSession, cancelBooking, rescheduleBooking, getMyBookings, getOpportunityBookings; completeSession, getPendingApprovals, approveBooking, rejectBooking.
6. **Resolvers (admin):** getDashboardStats; requestAdminAccess, getAdminRequests, approveAdminRequest, denyAdminRequest; getAdmins, revokeAdminAccess.
7. **Resolvers (gamification):** getGamificationProfile, getAchievements, getLeaderboard, getMonthlyLeaderboard, getPointsHistory; ensure approveBooking awards points and updates profile/achievements.
8. **Resolvers (feedback, prefs, stats):** submitFeedback, getFeedback, deleteFeedback, exportFeedbackCsv; getNotificationPreferences, updateNotificationPreferences; getPlatformStats.
9. **Frontend shell:** App with Tabs (Home, My Bookings, Admin, Settings, Gamification, Feedback). Config component and useConfig. Spinner on load.
10. **Frontend Home:** getOpportunities + getPlatformStats; filters; list; opportunity detail (state or modal) with getOpportunity, sessions, book, track click.
11. **Frontend My Bookings:** getMyBookings; list; cancel, reschedule.
12. **Frontend Admin:** Role check; dashboard (getDashboardStats); opportunities list + form (create/edit) + duplicate/delete/analytics; sessions CRUD; bookings list; pending approvals; admin requests; admins; feedback list.
13. **Frontend Settings:** Notification preferences form.
14. **Frontend Gamification:** Profile, achievements, leaderboards, points history.
15. **Frontend Feedback:** Submit form.
16. **Lint and test:** forge lint; add Jest tests for resolvers and key UI (mock invoke/view).

---

## 8. Checklist before “done”

- [ ] All resolvers listed in §4 are implemented and wired in manifest.
- [ ] All entities in §3.1 are persisted (Forge storage); no PostgreSQL.
- [ ] Frontend uses only UI Kit components and xcss; no Tailwind, no Radix, no Framer, no Three.js.
- [ ] Navigation is Tabs only (no react-router).
- [ ] getMe and role checks enforce requireAuth / requireAdmin / requireSuperadmin.
- [ ] Shared types in src/types used in both frontend and resolvers; no any in payloads/returns.
- [ ] Macro config (if macro) uses only allowed config components; useConfig in App.
- [ ] forge lint passes; forge deploy and install on a Confluence site for smoke test.

---

## 9. Reference file map (current codebase)

| Current | Use for |
|--------|---------|
| `frontend/src/shared/types.ts` | Copy type definitions into `src/types/index.ts` (drop Express-specific). |
| `frontend/src/api/client.ts` | List of “API” calls → resolver names and payloads (§4). |
| `frontend/src/api/types.ts` + `api/gamification.ts` | Gamification + analytics types. |
| `backend/src/db/migrate.ts` | Schema reference for entities (§3.1). |
| `backend/src/routes/*.ts` | Request/response shape and validation rules. |
| `backend/src/validation/schemas.ts` | Validation rules (reimplement in resolvers). |
| `frontend/src/pages/Home.tsx`, `OpportunityDetail.tsx`, `Admin.tsx`, etc. | Behaviour and fields to show; reimplement in UI Kit, do not copy JSX. |

Do not copy-paste React/Express code; use this spec as the single source of truth and reimplement in Forge.

---

## Appendix A: Resolver invoke quick reference

Frontend calls: `invoke('resolverName', payload)`. Payload must be a plain object; types below.

| Invoke name | Payload (keys) | Returns |
|-------------|----------------|--------|
| getMe | — | User |
| getOpportunities | type?, q?, status? | Opportunity[] |
| getOpportunity | id | Opportunity |
| createOpportunity | CreateOpportunityRequest | Opportunity |
| updateOpportunity | id, ...UpdateOpportunityRequest | Opportunity |
| deleteOpportunity | id | — |
| duplicateOpportunity | id | Opportunity |
| getSessions | opportunityId, from?, include_past? | Session[] |
| createSessions | opportunity_id, sessions | Session[] |
| updateSession | sessionId, ...UpdateSessionRequest | Session |
| deleteSession | sessionId | — |
| closeOpportunityIfPast | opportunityId | — |
| syncBookedCounts | — | — |
| trackOpportunityClick | opportunityId, clickType | { ok } |
| getOpportunityAnalytics | opportunityId, period? | OpportunityAnalytics |
| bookSession | sessionId | Booking |
| cancelBooking | bookingId | — |
| rescheduleBooking | bookingId, target_session_id | — |
| getMyBookings | — | UserBookings |
| getOpportunityBookings | opportunityId | BookingWithDetails[] |
| completeSession | sessionId | { message, status, awaitingApproval } |
| getPendingApprovals | — | BookingWithDetails[] |
| approveBooking | bookingId, adminNotes? | { message, pointsAwarded, newLevel, levelUp, totalPoints } |
| rejectBooking | bookingId, adminNotes? | { message, status } |
| getDashboardStats | — | DashboardStats |
| requestAdminAccess | — | { success, request, message } |
| getAdminRequests | status? | { success, requests } |
| approveAdminRequest | requestId | { success, message } |
| denyAdminRequest | requestId, notes? | { success, message } |
| getAdmins | — | { success, admins } |
| revokeAdminAccess | adminId | { success, message } |
| getGamificationProfile | — | UserProfile |
| getAchievements | — | UserAchievement[] |
| getLeaderboard | limit? | LeaderboardEntry[] |
| getMonthlyLeaderboard | limit? | LeaderboardEntry[] |
| getPointsHistory | limit? | PointsTransaction[] |
| submitFeedback | category, feedback, userAgent, url | { success } |
| getFeedback | — | FeedbackItem[] |
| deleteFeedback | id | { success } |
| getNotificationPreferences | — | NotificationPreferenceResponse |
| updateNotificationPreferences | on_book_email, on_cancel_email | NotificationPreferenceResponse |
| getPlatformStats | — | PlatformStats |

---

## Appendix B: Forge docs to consult

- **forge-development-guide:** Setup, deploy, install, CLI, security (asUser vs asApp).
- **forge-ui-kit-developer-guide:** Allowed components, Tabs/CheckboxGroup/Form patterns, xcss, bridge (invoke, view).
- **forge-backend-developer-guide:** Resolver structure, layered architecture, storage abstraction.
- **forge-app-manifest-guide:** manifest.yml syntax, modules, scopes.
- **confluence-macro-developer-guide:** Macro config UI (addConfig, useConfig), allowed config components.
- **search-forge-docs:** Before using any UI Kit component or API, search for props and required scopes.
