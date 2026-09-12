# Design-backlog (D) — autonomous decision log

Nick delegated the remaining four (D)-tier design-backlog items to run autonomously with full merge authority (2026-09-12), technical and product/UX calls made and recorded here for review.
The standing bias: the smallest, most reversible change that satisfies the ask; never invent a figure and present it as measured; do not churn a live-beta participant surface for consistency alone; hard gates (code-reviewer at high reasoning, security-auditor on external-link and session surfaces, null-controlled tests, Playwright+axe for colour/label changes) before every merge.

Each entry records the decision, why, and what was consciously NOT done so a later reader can reverse it.

---

## DT-7 — show a duration on every study type

**Decision: honest qualitative expectation copy (backlog option C) for the types that currently show no duration; no new authoring field.**

Shipped state (verified in `OpportunityDetail.tsx`): the data box shows a DURATION row only for test/interview (`default_duration_minutes`, a required authoring field) and unmoderated-with-estimate (`estimated_duration_minutes`, nullable). Poll, survey, question, and unmoderated-without-estimate show nothing — the gap DT-7 names. The current code is honest (it omits rather than prints the untouched default 30).

The backlog recommended A+C: add an optional estimated-duration authoring field to poll/survey/question (A) plus copy for external (C). I chose **C for all the currently-blank types** and deliberately did **not** add the authoring field, because:
- A needs a backend column + migration + a new wizard field on a live authoring flow that was just reworked (WZ-13/17/18). That is real live-beta risk for a capability the stated need ("communicate a time expectation on every type") does not require.
- The need is satisfied by an honest qualitative expectation; a per-poll minute figure is a capability beyond the need (NFB: need before feature).

Copy (qualitative, no fabricated precise figure): poll/question "Under a minute", survey "A few minutes".

**Scoped to NATIVE delivery only** (gated on `isNativeSurvey`, not on `type`). An *external* poll/survey hands off to a third-party form Cortex never runs, so claiming "A few minutes" about it would be the very figure-nobody-chose the rule forbids — code review (MEDIUM) caught that keying on `type` alone would make that false claim. External short-form hand-offs therefore show no duration, which is the honest answer when Cortex cannot know the length. (unmoderated keeps its existing behaviour: the real estimate when set, nothing when not.)

**Reversible follow-up if Nick wants author-set durations:** add the optional `estimated_duration_minutes` field to native types (backlog option A) — a separate MR.

---

## DT-8 — one pattern for the external hand-offs that discloses the destination

**Decision: fix the one deficient site (the detail-page external anchor) by naming its destination host, codified as a reusable `ExternalHandoff` component; leave the two sites that already disclose correctly.**

Shipped state: three sites, three elements.
- (A) detail-page external anchor (`OpportunityDetail.tsx`) — generic "Participate"/"Answer Question", host never shown. **This is the defect.**
- (B) recording task page (`StudyRunner.tsx`) — already names the host via `describeTarget(...).label`, but it is a `<button>` wired into the recording/PiP launch (`onOpen`/`onReopen`), not a plain anchor.
- (C) bookings meeting link (`MyBookings.tsx`) — already names the platform via `getMeetingPlatform` (Join via Zoom/Meet/Teams).

The backlog recommended A (a shared component migrating all three). I built the shared component and disclosed the destination on **every external hand-off the detail page itself owns**, consciously leaving B and C, because:
- B is a live participant recording surface and its hand-off is entangled with capture launch, not a swappable anchor; it already discloses. Regressing it for consistency is the wrong trade in a live beta.
- C is a *meeting-join* link for a booked session — a different affordance from a study hand-off — and it already names the platform. Forcing it into the study-handoff component risks making one read wrong.

**Correction after code review (MEDIUM):** the detail page has TWO external hand-offs, not one. The external *question* is an anchor (migrated to `ExternalHandoff`); the external *poll/survey/study* is a `window.open` **button** (the common case) that also named no host. A first pass fixed only the anchor and would have left the more common button undisclosed — the same defect DT-8 exists to close. So the disclosure line is extracted as `ExternalDestinationNote` and now renders beneath BOTH: the anchor (inside `ExternalHandoff`) and the poll/survey/study button (gated on `isExternalButtonHandoff` = not native, not a recorded study, a usable external link), so it appears for exactly the hand-offs that leave Cortex and never for an in-app run.

So the "one pattern" (host + "you're leaving Cortex", reusing `describeTarget`; `ExternalHandoff` re-validates the URL with `isPublishableExternalLink` itself — a security-review LOW — and preserves `target="_blank"`/`rel="noopener noreferrer"`) covers every detail-page external hand-off; B and C are left disclosing as they already do, marked to adopt the component when those surfaces are next touched.

**Reversible follow-up:** migrate B and C to `ExternalHandoff` when the recording flow / bookings are next worked on.

---

## RS-10 — resume or restart when a session was started elsewhere (increment-1 only)

**Decision: ship increment-1 only — an informational, restart-only prompt when the server holds mid-flight progress a fresh local device knows nothing about. No auto-resume, no answer rehydration, no backend or contract change.**

The backlog item is "let a participant resume an interrupted session". Full resume (rehydrating answers / recording state onto a new device) is a larger, riskier capability touching a live participant surface mid-beta. I split it: increment-1 closes the immediate harm — a participant who started on one device and opens the link on another silently starts over with no explanation — by making that situation *non-silent*. Increment-2 (auto-resume / rehydration, and the interruption-reset rule in `getInterruptedRunRecovery`) is deliberately deferred and untouched here.

Behaviour: at the welcome phase, when local flow state is empty (fresh device or cleared storage) and the visit is not a `forceReset`, read the participant's own latest runtime snapshot. If its `sessionStatus` is one of the five mid-flight states (consent_accepted, setup_in_progress, ready_to_start, recording_in_progress, uploading), show a dismissible banner: "You have an unfinished session … continuing will start a fresh attempt." The pre-progress (created, link_opened) and terminal (completed, abandoned, failed) states show nothing.

**Frontend-only, by design.** The existing `GET /:token/runtime` already returns the latest snapshot; increment-1 only adds a passive read of it. No migration, no new field, no route — the smallest reversible change that satisfies the need on a live beta.

**Corrected during the hard gates (this is why un-gated subagent output was not trusted):**
- The first cut read the snapshot's status as snake_case `session_status`. The wire key is camelCase `sessionStatus` (the postgres mapper emits camelCase, express.json does not transform it). Left unfixed, the banner could *never* fire — a silent no-op, the exact failure mode this feature removes. Fixed and pinned by a direct parse test with a snake_case null-control (reverting the key fails the test by name).
- **code-reviewer (Opus, high):** no CRITICAL/HIGH. One MEDIUM fixed — six sibling ParticipantSessionFlow suites spread the real module and clear storage, so the new effect made them hit real network I/O, green only by the accident of a relative base URL throwing; each now stubs `fetchLatestRuntimeStatus`. Three LOWs actioned: documented the deliberately attempt-agnostic read; added a `ponytail:` comment naming the hand-mirrored lifecycle set (an 11th backend state fails safe to no-prompt); and moved the banner into an always-mounted `role="status"` live region so a screen reader announces it when it appears.
- **security-auditor (Opus, participant session surface):** clean — no CRITICAL/HIGH/MEDIUM. The read is a safe GET scoped to the token owner by the unchanged `[requireAuth, bindParticipantSession]` guard; the status string is never rendered; fetch fails safe to null; no prototype-pollution, SSRF, or info-disclosure sink.

**Reversible follow-up:** increment-2 — auto-resume / answer rehydration and the interruption-reset rule — as a separate, backend-aware MR.

---

## CB-31 — stop the ambient neural background from cluttering signed-in working surfaces

**Decision: remove the `SlowNeuralBackground` mount from all nine signed-in pages and delete the dead CSS-based neural effect. Do NOT add a centralised mount, and leave the signed-out Landing's own background untouched.**

The backlog item (and the original handoff plan) was framed as "centralise the neural bg in AppChromeLayout, show ONLY on the signed-out Landing + auth screen, remove the 9 signed-in mounts". Reading the actual code corrected that premise:
- The signed-out **Landing already renders its own, *different* background component** — `OrganicNeuralBackground` (Landing.tsx), not `SlowNeuralBackground`. The brand flourish the plan wanted "on the signed-out Landing" is already there and correct. Nothing to centralise to achieve it.
- The nine `SlowNeuralBackground` mounts are all on **signed-in working surfaces** (Admin, Gamification, Home's signed-in listing, MyBookings, OpportunityAnalytics, OpportunityDetail, OpportunityForm, SessionReview, Settings) — exactly the "visual noise behind dense working data" the review flagged.
- There is **no in-app auth screen** to put a background on: sign-in is an OIDC redirect (`AuthContext.login()` → `window.location`), not an SPA route.

So the product-correct change is simply to **remove the particle background from the signed-in surfaces** (they go clean) and leave the signed-out Landing flourish alone. Adding a centralised mount to `AppChromeLayout` would either re-introduce the noise on signed-in pages or duplicate Landing's flourish — both wrong — so it was deliberately NOT done.

**On "retokenise hex → --brand-orange-500":** moot and deliberately skipped. `SlowNeuralBackground` is a three.js/WebGL canvas with a hardcoded ember palette (not a CSS-token surface), and it no longer renders anywhere after this change; retokenising an unmounted canvas is pointless. Landing's `OrganicNeuralBackground` (also WebGL, live, signed-out) was left entirely untouched — churning a live surface's palette for token-consistency is the wrong trade, and a `var()` cannot feed a WebGL colour anyway.

**Scope held deliberately small for a live beta:**
- Removed the 9 mounts + their now-unused `isDark`/`theme`/`useTheme` (kept in OpportunityDetail, where `isDark` still drives a `btn-close` variant).
- Deleted the fully-orphaned CSS-based neural effect (`.neural-particle-field`, `.neural-node`, `.neural-connection`, the `.nn-*`/`.nc-*` animation-delay helpers, and `@keyframes node-pulse`/`connection-pulse`) — confirmed zero usage anywhere in `frontend/src`. These were an older CSS effect unrelated to the WebGL component.
- **Did NOT delete `SlowNeuralBackground.tsx` itself**, nor the 45 test files that mock it. The component is now unused, but deleting it forces rewriting 45 test mocks (several sharing grouped stub comments) — a wide, mechanical churn that belongs in its own hygiene MR, not mixed into a live-beta visual change. Recorded here as the reversible follow-up.

**Gates:** pure deletion (10 files, 117 deletions, no added content). typecheck clean; full frontend vitest green; root `npm run lint` (the CI gate) clean on all nine pages. code-reviewer (Opus, high): clean, no CRITICAL/HIGH — it verified the removals leave no dangling `isDark`/`theme`/`useTheme`, the kept OpportunityDetail `isDark` is genuinely used, the CSS deletion hit only dead rules, `three` stays needed (kept component + Landing both import it), and the lower-z-index fixed canvas could not have been load-bearing for content stacking. The a11y check is the CI `test-a11y` (Playwright + axe) blocking job on the MR — removing a decorative full-viewport canvas cannot introduce a new violation, and the armed merge waits on that job.

**Reversible follow-up (one hygiene MR):** delete the now-unused `SlowNeuralBackground.tsx` and the ~45 test mocks of it; sweep the remaining `.slow-neural-background` / `.slow-neural-background canvas` CSS that belonged to it; and simplify `frontend/src/styles/_themes.css:936` — its `body.theme-dark .admin-page-bg > :not(.slow-neural-background)` selector now has a dead exclusion clause and a stale comment (harmless today: the rule still applies `position: relative; z-index: 1` to the remaining content children correctly). Kept out of this MR to stay deletion-only and tightly scoped on a live beta.

---

*Design-backlog (D) tier CLOSED: DT-7, DT-8 (!422), RS-10 increment-1 (!423), CB-31 (this MR). Increment-2 of RS-10 (auto-resume / rehydration) remains the one tracked forward item.*
