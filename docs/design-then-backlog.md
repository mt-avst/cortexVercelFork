# Design backlog — the "Then" tier (Mav and Petra)

Tracked from the **Then** section of the Mav and Petra design review of Cortex.
These are the second-tier items, grouped from the six fix tables (154 rows total); the "Fix first" 18 are tracked separately.

Source report: `mav-and-petra-on-cortex.html` (prior-session scratchpad, now cleaned — re-create it from this doc plus the decision log if the per-row evidence tables are needed again).

## Status (refreshed 2026-09-13) — TIER COMPLETE

**All 33 items are actioned**: shipped, dropped by decision, or confirmed already-satisfied in shipped code.
The only unfinished work is deliberately parked:
- **RS-10 increment-2** (auto-resume / answer-rehydration) — tracked as **issue #127**, needs a product decision, deferred past the beta
- Neither of these blocks the tier

The full option-by-option rationale for every **(D)** decision lives in the committed **`docs/design-backlog-decisions.md`** and the session handover memory.

**Fix-first 18** — complete/settled: 16 in-scope rows already done (code-verified), row 12 shipped as **MR !402** (dark-theme Fraunces headings), row 11 = deliberate leave-alone (the landing sample video).

**Related item already SHIPPED (not one of the 33):** the researcher **Session Management** table slot-picker — **MR !403**, merged + live.

**Brand/icon cluster — DONE.** Helena Voss direction: **A2** the "Neuron" mark from the Labs node DNA, **B1** Fraunces wordmark, **C** lucide over emoji. Shipped as **MR !404** (CB-27 header lockup, RS-9 recording mark, CB-30 fonts) and **MR !405** (DA-21 analytics icons, CB-29 emoji-out).

Convention: `- [ ]` open, `- [x]` done, `- [~]` partial/parked; **(Q)** quick win, **(D)** needed a decision.

## Booking
- [x] (D) BK-1 Warn on a second booking of the same study — DONE, MR !418 (merge ab4ca38). Option A: soft-warn and allow. `already-booked-notice` on OpportunityDetail, reuses `getMyBookings()`/bookedSlots keyed by opportunity; no backend change
- [x] (D) BK-2 Book over a calendar conflict with the clash named — DONE, MR !418. Option A: clashed slots SHOWN not hidden, named via shared `describeCalendarClash` (`utils/calendarClash.ts`); `getCalendarConflict` returns the matched event in both OpportunityDetail and CalendarGrid; new `.slot-chip-conflict` state
- [x] (Q) BK-3 Give the booked slot its own state in the table instead of FULL — DONE (merge 84e5b47, feat/bk3-booked-slot-state-in-table)
- [x] (Q) BK-4 Put the time zone on every calendar time — DONE, MR !408 (merge fdfb9cf). CalendarGrid one zone caption regardless of hideLegend; new pure `sharedZoneOffset` (null on a DST straddle → prose only)
- [x] (Q) BK-5 Separate Cancel from Join on My bookings — DONE-IN-SPIRIT: premise stale vs shipped code. Join is an orange primary filled button, Cancel a muted-red chip routed through a "Yes, Cancel Booking" confirm dialog (a11y-reworked in !195). Only residual is optional adjacency (`margin-left:auto`) — not built

## Detail pages
- [x] (Q) DT-6 Hide the empty metadata box that native survey/poll/one-question studies ship — DONE + live, MR !409. `.mission-data-box` gated on ≥1 row (`OpportunityDetail.tsx:1028`); content flex:6 fills the row
- [x] (D) DT-7 Show a duration on every study type — DONE, MR !422 (v7.89.0). Option C: honest qualitative expectation copy for the blank types (poll/question "Under a minute", survey "A few minutes"), scoped to NATIVE delivery (`isNativeSurvey`, not `type`) so external hand-offs make no time claim. No new authoring field (a reversible follow-up if author-set durations are wanted). See decision log
- [x] (D) DT-8 One external hand-off pattern that discloses the destination — DONE, MR !422. Option A: new `ExternalHandoff` component + `ExternalDestinationNote` ("you're leaving Cortex" + host, reusing `describeTarget`, re-validates via `isPublishableExternalLink`), disclosed on BOTH detail-page hand-offs (the question anchor and the poll/survey/study `window.open` button). StudyRunner + MyBookings left (already disclose; marked to adopt when next touched). See decision log

## Recorded session
- [x] (Q) RS-9 Put the product mark back where the empty circle is — DONE, MR !404 (CortexMark Neuron in the recording journey rail)
- [~] (D) RS-10 Offer resume or restart on an abandoned session — INCREMENT-1 DONE + live, MR !423 (squash fd700fe). Frontend-only, no contract change: when local state is empty but the server holds mid-flight progress, a dismissible "You have an unfinished session" banner offers restart (closes the silent cross-device data loss, safe for the live beta). **Increment-2 PARKED as issue #127** (auto-resume / answer-rehydration + the interruption-reset rule) — needs a product decision, recording capture is device-local so it cannot cross-device resume without a capture-pipeline rewrite. See decision log
- [x] (Q) RS-11 Rewrite the phone gate — DONE (premise stale vs shipped code): a mobile-UA gate returns clear copy "This session records your screen, which phones and tablets cannot do. Open your invitation link on a laptop or desktop." (`device-support.ts:34-40`), shown pre-consent with a disabled Continue
- [x] (Q) RS-12 Mark the current step in the journey rail — DONE (satisfied in shipped code): the rail computes a `SectionStatus` and marks the active section `journey-block--hero` with `aria-current="page"` (`ParticipantSessionFlow.tsx:79-112, 433, 794-825`)

## Wizard
- [x] (D) WZ-13 Guard header navigation while the form holds unsaved work — DONE, MR !419 (merge bfebba6). Option A: new `contexts/NavigationGuardContext.tsx` (GuardedLink + provider in AppChromeLayout) routes header-link exits through the form's dirty guard / existing confirm modal; no router migration. See decision log
- [x] (Q) WZ-14 Signage for the two save models — DONE, MR !417 (merge e664c71). Signs-posts that drafts autosave but published studies save manually
- [x] (Q) WZ-15 Inline message on the empty task prompt — DONE (premise stale): `QuestionList` renders an `emptyMessage` (`QuestionList.tsx:419-422`); tasks step "No tasks yet. Add the first thing you want the participant to do.", survey step the parallel copy
- [x] (Q) WZ-16 Hide Preview for bookable types — DONE, MR !411. Gated the Review-step Preview on `authoringKind` (not `type`), so it also hides for external poll/survey/question, not just test/interview
- [x] (D) WZ-17 Give Review's summary a hierarchy — DONE, MR !419. Option B: a header identity card (title/type/status promoted out of the basics rows) + grouped two-column `<dl>` via `buildReviewHeader`; emoji → lucide. See decision log
- [x] (D) WZ-18 Do not change the step count after the type is chosen — DONE, MR !419. The `StepNav` strip is gated on `formData.type` so the step set is committed once the type is chosen. See decision log

## Dashboard and analytics
- [x] (D) DA-19 One scope for the snapshot band and the table — DONE across both surfaces. Per-study page (MR !420): the period selector now governs the tiles as well as the charts (calendar-day-aligned bound so tile == chart bars); real-pg test. Admin dashboard: the "Operational snapshot" band carries an explicit scope note ("Your studies only" / "Across every researcher on Cortex", `Admin.tsx:463-467`) and snapshot + table share one clock reading (`Admin.tsx:72-74`) so they agree; each figure is scope-labelled. Only residual is a cosmetic "all-time" tag on the Clicks column, which cannot mislead here because the dashboard has no period control (LOW, not built). See decision log
- [x] (Q) DA-20 Fix the chart empty state and "Unique: 0" beside eight actions — DONE + live, two MRs. Symptom A (chart empty state) = !406 (merge dcc0bc0): zone-aware `analyticsChart.ts`, empty states gated on header period totals; residual → issue #124 (since CLOSED by !420). Symptom B (Unique: 0) = !407 (merge 053657a): `COUNT(DISTINCT COALESCE(user_id::text, ip_hash))`, real-pg test; material proxy ceiling → issue #125 (since CLOSED by !428, first-party visitor nonce)
- [x] (D) DA-21 Draw eight icons where there are eight emoji — DONE, MR !405 (lucide icons across the analytics stat cards and chart titles)
- [x] (D) DA-22 Give charts values and an axis — DONE, MR !420. New pure `utils/barChartAxis.ts` (`computeBarChartAxis`, nice-number ticks, integer step floor); `BarChart` restructured to y-axis + gridlines + baseline, bars scale vs `niceMax`; headers sum the drawn series (closed #124). No charting lib. See decision log
- [x] (Q) DA-23 Sort on the columns that hold the operational questions — DONE (merge 4a9e96f, feat/da23-sortable-analytics-columns): the operational columns in the analytics session and participant tables are sortable
- [x] (Q) DA-24 Name the collateral in the delete dialog — DONE, MR !412. The delete-study confirm names the real cascade collateral (sessions, bookings, recordings/transcripts, analytics), grounded in `migrate.ts` ON DELETE CASCADE; wired into `aria-describedby` on the shared ConfirmationModal
- [x] (D) DA-25 Previous and next between session reviews — DONE, MR !420. `SessionReview` gains prev/next + "Session N of M" via a shared `groupEventsBySession`, honouring the Sessions tab's current sort/filter (order carried in nav state). See decision log

## Chrome and brand
- [x] (Q) CB-26 Demote the theme toggle on the signed-out page — DONE, MR !416. Full "Light Mode" button → a quiet, theme-aware icon
- [x] (D) CB-27 Add the wordmark to the header and redraw the mark as SVG — DONE, MR !404 (Neuron SVG mark + Fraunces "Cortex" wordmark lockup, replacing the Labs PNG)
- [x] (Q) CB-28 One left edge for chrome and content — DROPPED (Nick's call after a live before/after). The aligned hero lost the composed inset tuned against the neural artwork and stacked the two wordmarks; the tuned inset was kept. Branch deleted, no MR
- [x] (D) CB-29 Emoji out of the type select, analytics cards and feedback form — DONE, MR !405. Analytics got lucide icons; the selects went to clean text (a native `<option>` cannot hold an SVG — icons-in-picker would need a custom dropdown, deferred). The DRAFT warning banner is a deliberate convention, left
- [x] (Q) CB-30 Delete the Clash Grotesk load and self-host IBM Plex Mono — DONE, MR !404
- [x] (D) CB-31 Give the neural background a rule — DONE, MR !424 (v7.90.1). Premise corrected on reading the code: the signed-out Landing already has its own `OrganicNeuralBackground`; the nine `SlowNeuralBackground` mounts were all on signed-in working surfaces and there is no in-app auth screen. So the fix was to REMOVE the nine signed-in mounts and delete the orphaned CSS-based neural effect — not centralise a mount. Follow-up hygiene (delete the now-unused SlowNeuralBackground.tsx) shipped as !425. See decision log

## Docs
- [x] (Q) DC-32 The user guide describes a home search box that does not exist — DONE, MR !410. Rewrote USER_GUIDE.md "Searching Opportunities" → "Using the Type Filters" (the real chips) and the matching troubleshooting bullet. Left the stale "AdaptaLabs" name as a separate concern
- [x] (D) DC-33 The product description says visitors can browse studies signed out — DONE, MR !421. Option A (docs-only): fixed USER_GUIDE.md and CORTEX-PRODUCT-DESCRIPTION-FOR-CLAUDE.md to say sign-in is required to browse and dropped the "above the browsable list" claim; kept the direct-link claims (the `/opportunities/:id` detail route opens signed-out; only the booking action gates on the user). Signed-out browse (options B/C) is a genuine post-beta product decision with its own security pass
