# Next Milestones – Roadmap

**Status**: M1–M6 complete; M7 core (dashboard + settings) complete.  
**Pick one track to start; each can be done incrementally.**

---

## Track A: M7 – Dashboard & settings (enhancements)

**Goal**: Richer admin and user experience around profile, notifications, and usage.

| Item | Description | Effort |
|------|-------------|--------|
| **Profile** | Editable display name or profile fields (beyond read-only name/email/role) | Small |
| **Notifications** | Extra notification options (e.g. reminder timing, digest vs instant) | Small–medium |
| **Usage stats** | “Sessions completed”, “Studies participated in”, or similar for users/admins | Medium |

**Quick start**: Add one “usage stat” to the existing admin dashboard or user profile (e.g. bookings count, studies completed).

---

## Track B: Production hardening

**Goal**: Stability, security, and operability for production traffic.

| Item | Description | Effort |
|------|-------------|--------|
| **Perf** | Response-time targets, slow-query review, optional caching | Medium |
| **Security pass** | Review auth, role checks, input validation, env/secrets | Medium |
| **Load test** | Basic load test (e.g. k6 or Artillery) for key APIs | Small–medium |
| **Backups** | DB backup strategy (e.g. Neon/Vercel Postgres backups, retention) | Small |

**Quick start**: Document backup strategy and run a single load test against `/api/health` and one critical path (e.g. list opportunities or book).

---

## Track C: Features

**Goal**: New capabilities that add clear user value.

| Item | Description | Effort |
|------|-------------|--------|
| **Email reminders** | Already partially in place (cron); verify and document, or extend (e.g. templates) | Small–medium |
| **Analytics export** | Export poll/survey or booking analytics (CSV/Excel) for admins | Medium |
| **i18n** | Multi-language support (e.g. react-i18next, locale switcher) | Large |

**Quick start**: Add a “Download CSV” (or similar) for one analytics view (e.g. opportunity clicks or bookings).

---

## Suggested order

1. **Track B (hardening)** if the next goal is a more production-ready deploy: backups + one load test + a short security checklist.
2. **Track A (M7)** if the next goal is better UX: one usage stat or one profile/notification enhancement.
3. **Track C (features)** when core and hardening are in a good place: start with analytics export or email reminder improvements.

---

## How to use this in a session

- Say which **track** you want (A, B, or C).
- Optionally name a **quick start** (e.g. “Track B – load test” or “Track A – usage stat”).
- We can then break that into concrete tasks and implement step by step.
