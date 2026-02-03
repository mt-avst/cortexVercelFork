# Code Review: Admin / User View Toggle

**Date:** 2026-02-03  
**Scope:** Changes for admin–user dashboard navigation (Home.tsx, Admin.tsx) and related consistency/integrity.

---

## Summary

The implementation is **consistent and sound**. Role checks, navigation targets, and UI patterns match the rest of the app. Two unused imports were removed (Home, Admin).

---

## 1. Consistency

### Role checks
- **Admin.tsx:** Access and data loading use `user?.role === 'researcher_admin' || user?.role === 'superadmin'` (lines 134, 142, 227). Same pattern as Header, Settings, OpportunityDetail, OpportunityForm, AdminFeedback.
- **Header.tsx:** "Admin" link and logo target use the same role check; `logoLink` remains `/admin` for admins, `/` for others. No change needed.

### Navigation
- **Admin → User:** "Browse Studies" uses `navigate('/')`. Same as other "back to home" flows (e.g. OpportunityForm when `allowUserSubmission`).
- **User → Admin:** Header shows `<Link to="/admin">` when `(researcher_admin || superadmin) && !isOnAdminPage`. Correct and unchanged.
- **Other back-to-admin:** OpportunityForm, OpportunityAnalytics, Settings use `navigate('/admin')` or `navigate('/admin', { state: { refresh: true } })`. Aligned with Admin’s `location.state?.refresh` handling.

### UI / a11y
- "Browse Studies" matches "Settings": same classes (`btn btn-outline-secondary admin-settings-btn btn-nowrap`), icon size 16, `aria-label`, icon + text. Order: Browse Studies → Settings → Create Research Study.

---

## 2. Integrity (fixes applied)

### Unused imports (removed)
- **Home.tsx:** `StaticNeuralBackground` was imported but never used (Landing uses it; Home only uses `SlowNeuralBackground` when `user && isDark`). Removed.
- **Admin.tsx:** `AlertTriangle` was imported but never used in Admin (used in OpportunityForm, Settings, Feedback). Removed.

### No other issues
- No linter errors on Home.tsx or Admin.tsx.
- Home’s `useAuth()` now only destructures `user`; no leftover `loading` or `initialAuthCheck` from the removed redirect.
- Admin still correctly waits on `loading` and `initialAuthCheck` before rendering and redirects unauthenticated or non-admin users to `/`.

---

## 3. Behaviour verified

- Admins can open `/` and see the study list (no redirect to `/admin`).
- "Browse Studies" on `/admin` goes to `/`.
- "Admin" in the header on `/` goes to `/admin`.
- Role guards on `/admin` unchanged; non-admins still redirected to `/`.
- Logo link for admins remains `/admin`; no conflict with the new toggle.

---

## 4. Files touched in this review

| File | Change |
|------|--------|
| `frontend/src/pages/Home.tsx` | Removed unused `StaticNeuralBackground` import |
| `frontend/src/pages/Admin.tsx` | Removed unused `AlertTriangle` import |

No further code changes recommended for this feature.
