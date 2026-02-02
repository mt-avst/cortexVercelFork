# Code Consistency & Integrity Review v7.2.11

**Date:** February 2, 2026  
**Version Reviewed:** 7.2.11 (root, api, frontend, backend)  
**Scope:** api/, frontend/, backend/, shared/, scripts/

---

## Executive Summary

Consistency and integrity were reviewed across the AdaptaLabs codebase. **Version numbers are aligned** at 7.2.11. **Feedback flow** (API save-only, footer category, migrations) is consistent. **Role authorization** (researcher_admin and superadmin) is consistent in API and backend. **Shared types** (User, SessionUser with role union) are correct. **One fix applied:** api/admin/admins.ts catch block now uses logger instead of console.error. No critical issues; a few known differences and low-priority notes are documented below.

---

## 1. Version Numbers ✅

| Location              | Version |
|-----------------------|--------|
| package.json (root)   | 7.2.11 |
| api/package.json      | 7.2.11 |
| frontend/package.json | 7.2.11 |
| backend/package.json  | 7.2.11 |

**Status:** All aligned. No action.

---

## 2. Feedback Flow ✅

| Layer        | POST feedback behaviour | GET feedback |
|-------------|---------------------------|--------------|
| **api/feedback.ts** (Vercel prod) | Save to DB only; no email. Uses getPool(), logger, createErrorResponse. | requireAuth; researcher_admin \|\| superadmin; returns rows. |
| **backend/routes/feedback.ts** (local) | Save to DB + optional email to nfine@adaptavist.com (EmailService.getFeedbackTemplate + sendEmail). | requireAdmin; same role check. |

**Known difference:** Production (API) does not send feedback emails; local backend does. Intentional per product decision (feedback DB-only, show in Feedback tab).

**Schema:** feedback.category CHECK includes 'bug', 'feature', 'question', 'other', 'footer'. run-migrations.ts creates table and alters constraint for existing DBs. ✅

---

## 3. Role Authorization ✅

| Area | researcher_admin | superadmin |
|------|------------------|------------|
| **api/** | feedback GET, dashboard, opportunities, sessions, feedback export, etc. | set-superadmin, admins (list/revoke), admin requests (approve/deny), reset-keep-two-users |
| **backend/** | Same pattern: admin routes require researcher_admin \|\| superadmin; superadmin-only for admin management. | Same. |
| **shared/types** | User.role = 'employee' \| 'researcher_admin' \| 'superadmin' ✅ | SessionUser.role same. |

**Scripts:** set-superadmin.ts (single email → superadmin). set-researcher-admin.ts (one or more emails → researcher_admin); skips if already researcher_admin or superadmin; requires user to exist (log in once). Both use DATABASE_URL/POSTGRES_URL, same URL cleanup. ✅

---

## 4. Shared Types ✅

- **User / SessionUser:** role is `'employee' | 'researcher_admin' | 'superadmin'` in shared/types/index.ts and frontend types.
- **AdminRequest:** requested_role `'researcher_admin' | 'superadmin'`.
- **Feedback:** Stored in DB (user_id, user_name, user_email, category, feedback, url, user_agent, created_at). No shared type for feedback row; API returns result.rows.

**Status:** Consistent. No action.

---

## 5. API Error Handling & Logging ✅

| File | Catch block |
|------|-------------|
| api/feedback.ts | logger.error + createErrorResponse ✅ |
| api/admin/admins.ts | **Fixed:** now logger.error (was console.error) ✅ |
| api/admin/set-superadmin.ts | console.error (one-off script; acceptable) |
| api/admin/requests.ts, request.ts, approve, deny | console.error — low priority to switch to logger |
| api/run-migrations.ts | console.error for migration failure (script-style) |

**Status:** Main API routes use logger; admins.ts updated. Other admin/request handlers still use console.error; can be migrated to logger in a follow-up.

---

## 6. Database Access (API) ✅

- **api/feedback.ts** uses getPool() and pool.query().
- **api/admin/admins.ts** uses query() from db (which uses getPool() internally).
- **api/db.ts** exports getPool() and query(); both use same pool singleton and logger for errors.

**Status:** Consistent. No action.

---

## 7. Frontend Feedback Footer ✅

- **FeedbackFooter.tsx:** submitFeedback with category 'footer', trim, logger on error, BEM classes, accessibility (label, aria-describedby, role status/alert).
- **App.tsx:** FeedbackFooter rendered after </main>; no conditional — appears on all routes.
- **CSS:** _components.css (feedback-footer block), _themes.css (dark overrides). Centred, responsive (767px / 480px).

**Status:** Consistent with plan and previous review. No action.

---

## 8. Integrity Checks ✅

| Check | Result |
|-------|--------|
| Unused imports (api/feedback, FeedbackFooter, admins) | None. |
| Duplicate IDs | Scoped and unique. |
| Feedback category in migrations | 'footer' in CREATE and in ALTER for existing DBs. |
| set-researcher-admin.ts | Uses pg Pool, same URL cleanup as set-superadmin; no storage of secrets. |

---

## Changes Made During Review

1. **api/admin/admins.ts** — Replaced console.error in catch block with logger.error (message + errorMessage/stack) for consistency with other API routes.

---

## Summary

- **Versions:** 7.2.11 everywhere. ✅  
- **Feedback:** API save-only; footer category allowed; migrations include footer; backend still sends email locally (known difference). ✅  
- **Roles:** researcher_admin and superadmin checks consistent; set-researcher-admin script aligns with set-superadmin pattern. ✅  
- **Types:** User/SessionUser role union correct. ✅  
- **Logging:** admins.ts now uses logger in catch. ✅  

No further action required. Optional follow-up: migrate remaining console.error in api/admin (requests, request, approve, deny) to logger for consistency.
