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
