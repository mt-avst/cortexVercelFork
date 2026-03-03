# Cortex — Full Product Description for Claude

Use this document as canonical context when working on Cortex: product intent, users, features, and technical boundaries.

---

## 1. Product identity

- **Product name:** Cortex (also referred to in some docs as AdaptaLabs or Adaptalabs Recruitment App; the live UI and landing use **Cortex**).
- **Tagline:** Collective Intelligence.
- **Parent brand:** Adaptavist. Cortex is Adaptavist’s internal research participation platform.
- **One-line purpose:** Recruit internal participants quickly and simply; turn participation into decisions.

---

## 2. What Cortex is

Cortex is an **internal recruitment and research participation application** for Adaptavist. It lets:

- **Researchers / admins** post opportunities (studies, polls, surveys, interviews, tests).
- **Employees** discover, browse, and book sessions (or open polls/surveys) with minimal friction.
- **Admins** oversee content, manage sessions and bookings, and see analytics.

Cortex is described in-product as Adaptavist’s **collective intelligence engine**: it connects questions, people, and decisions so every contribution makes the organisation smarter. Value propositions include:

- Run interviews, surveys, polls, and tests from one place.
- Reach the right people fast across teams, products, and locations.
- Reward participation with AdaptaBits and build a culture of contribution.

**Positioning:** Unified research hub; smart booking; governed access; designed to sit alongside Jira, Confluence, and the Adaptavist toolchain.

---

## 3. Users and roles

| Role | Who | Capabilities |
|------|-----|--------------|
| **Visitor** | Anyone (unauthenticated) | Browse all published opportunities; view details; open poll/survey links. Cannot book. |
| **Employee** | Authenticated staff (e.g. Google SSO) | Everything a visitor can do; book, cancel, reschedule sessions; view “My Bookings”; earn AdaptaBits; request admin access; submit feedback. |
| **Researcher admin** | Researcher / PM with admin role | Create, edit, delete, duplicate opportunities and sessions; publish/draft/close; view dashboard and per-opportunity analytics; manage notification preferences; optional demo login for testing. |
| **Superadmin** | Platform owner | All admin capabilities; approve/deny admin and superadmin requests; manage admins; handle feedback (list, delete, export). |

Identity is SSO (e.g. company Google); no separate Cortex account. Demo logins (User, Admin, Superadmin) exist for development/demo when enabled.

---

## 4. Core concepts

### Opportunities

A research “study” or activity. Key attributes:

- **Type:** `test`, `poll`, `survey`, `interview`, `question`, `unmoderated` (external link only).
- **Content:** title, purpose one-liner, optional description, optional product, default duration.
- **Status:** draft (admin-only), published (visible to all), closed (visible but not bookable).
- **Sessions:** For bookable types (test, interview), one or more time slots with capacity, location/meeting link; for poll/survey/unmoderated, optional external link and click tracking only.

### Sessions

Time-bound slots for an opportunity: start/end time, capacity, booked count, optional location or meeting link. Sessions auto-close when full or when end time has passed.

### Bookings

A user’s reservation of one session slot. States: booked, cancelled. Booking creates a Google Calendar event on the opportunity owner’s calendar and sends confirmation (and optional reminder) to the participant. User can cancel or reschedule from “My Bookings.”

### Polls and surveys

Opportunities with an external link (e.g. Google Forms, Typeform). User clicks “Open Poll” / “Open Survey”; the app records a click (view vs action) for analytics and opens the link. No in-app form; participation is tracked for engagement/analytics (e.g. views, actions, conversion).

---

## 5. Main features (by area)

### For everyone

- **Browse:** Single list of published opportunities with filters (type) and search (title/description).
- **Opportunity detail:** Full description, sessions with remaining slots, Book button (bookable types) or Open Poll/Survey (external link types).
- **Calendar conflict detection:** When logged in, sessions can show a conflict indicator if the user’s calendar is busy (where integrated).

### For employees

- **Book / cancel / reschedule:** Book a session; cancel or reschedule from “My Bookings” (upcoming and past).
- **My Bookings:** Tabs for upcoming and past; cancel and reschedule actions.
- **AdaptaBits (gamification):** Points for participation (e.g. completed tests/interviews); levels; achievements; global and monthly leaderboards; points history. Access via “AdaptaBits” in the header.
- **Submit Research Request:** Link out to service desk (e.g. Atlassian) for formal requests.
- **Send Feedback:** In-app feedback (category, text, URL, etc.); visible to admins/superadmins.
- **Request Admin Access:** Self-serve request for researcher_admin (or superadmin) role; superadmin approves/denies.

### For researcher admins

- **Admin dashboard:** Counts (opportunities, bookings, participants, available slots); table of opportunities with stats (sessions, bookings, clicks for poll/survey).
- **CRUD opportunities:** Create, edit, delete, duplicate; set type, title, purpose, description, duration, status; for poll/survey/unmoderated set external link.
- **Sessions:** Add, edit, delete sessions (start/end, capacity, location/meeting link); sessions with existing bookings require care when editing.
- **Publish workflow:** Save as draft or publish; draft only visible to admins.
- **Analytics (per opportunity):** For poll/survey/unmoderated (and relevant types): views/actions, time-series, conversion; period 7/14/30 days. Admin/owner only.
- **Click tracking:** Back-end records view (detail opened) and action (e.g. “Open Poll” / “Book” clicked); optional auth; IP hashed for privacy.
- **Settings:** Notification preferences (on_book_email, on_cancel_email); optional reminder timing.

### For superadmins

- **Admin requests:** List and approve/deny requests for researcher_admin or superadmin.
- **Admins:** List current admins; revoke access.
- **Feedback:** List and delete (and optionally export) user feedback.

### Platform / UX

- **Theme:** Light/dark mode toggle; WCAG 2.2 AA–oriented.
- **Landing:** Branded hero (“CORTEX”, “Collective Intelligence”), primary CTA “Access Cortex” (e.g. Google), “How it works,” value by role, features, social proof, FAQ, final CTA; demo access pills when enabled.

---

## 6. Integrations and technical behaviour

- **Auth:** SSO (e.g. OpenID Connect / Google); session-based; `/api/me` for current user and role.
- **Google Calendar:** On book: create event on opportunity owner’s calendar; attendees include participant and owner; reminder (e.g. 24h). On cancel/reschedule: update/remove event and notify.
- **Email:** Transactional emails for booked, reminder, cancelled, reschedule; researcher notification toggles for on_book and on_cancel.
- **Cron (e.g. Vercel Cron):** Reminder job (e.g. 24h before session); protected by CRON_SECRET.

---

## 7. Data and privacy

- **Minimal PII:** e.g. name, email, business unit, role/title; SSO as source of truth.
- **Analytics:** Click tracking with hashed IP; views/actions and conversion for research use only.
- **Security:** Role checks server-side; CORS; secure cookies; rate limiting on auth; internal/VPC deployment expectations.

---

## 8. Non-functional goals

- **Performance:** List of opportunities renders in under ~1 second with large lists (e.g. 100 items).
- **Accessibility:** WCAG 2.2 AA basics.
- **Deployment:** Production-ready; alpha testing phase; e.g. Vercel + Postgres; Docker option for dev.

---

## 9. Out of scope (current product)

- Targeting by segment (e.g. by team/product) for invitations.
- CSV export or advanced reporting (beyond in-app analytics).
- Screeners or complex eligibility logic.
- Full incentives management (beyond AdaptaBits and monthly recognition).

---

## 10. Naming and docs

- **UI and landing:** Use “Cortex” and “Adaptavist” (e.g. “Access Cortex,” “Cortex Logo,” “Adaptavist Cortex”).
- **Code and older docs:** May still say “AdaptaLabs” or “Adaptalabs Recruitment App”; treat as same product. Forge/Confluence rebuild spec allows “Adaptalabs” or “Cortex / Adaptavist Cortex” as branding.

---

## 11. Quick reference for Claude

When editing copy, UX, or features:

- **Product name in user-facing text:** Cortex (Collective Intelligence); parent brand Adaptavist.
- **User types:** Visitor, Employee, Researcher admin, Superadmin.
- **Opportunity types:** test, poll, survey, interview, question, unmoderated; bookable vs external-link-only.
- **Flows:** Browse → Detail → Book (or Open Poll/Survey); My Bookings for cancel/reschedule; Admin for create/publish/analytics; superadmin for admin requests and feedback.
- **Rewards:** AdaptaBits (points, levels, leaderboards, achievements).
- **Support:** In-app “Send Feedback”; service desk link; contact (e.g. cortex@adaptavist.com, nfine@adaptavist.com for support).

Use this document as the single source of truth for product description when providing context to Claude or other AI assistants.
