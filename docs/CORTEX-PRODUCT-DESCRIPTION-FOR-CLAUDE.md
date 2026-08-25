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
| **Employee** | Authenticated staff (e.g. Google SSO) | Everything a visitor can do; book and cancel sessions; view “My Bookings”; earn AdaptaBits; request admin access; submit feedback. **There is no reschedule** — the control was removed because it shipped permanently disabled; the route is cancel and re-book. |
| **Researcher admin** | Researcher / PM with admin role | Create, edit, delete, duplicate opportunities and sessions; publish/draft/close; view dashboard and per-opportunity analytics; **read and export user feedback**; manage notification preferences; optional demo login for testing. |
| **Superadmin** | Platform owner | All admin capabilities; approve/deny admin and superadmin requests; manage admins; **delete** feedback. |

Identity is SSO (e.g. company Google); no separate Cortex account. Demo logins (User, Admin, Superadmin) exist for development/demo when enabled.

---

## 4. Core concepts

### Opportunities

A research “study” or activity. Key attributes:

- **Type:** `test`, `poll`, `survey`, `interview`, `question`, `unmoderated`. `question` points at an external tool. `poll` and `survey` do either, per `delivery_mode` (see *Native polls and surveys* below): `external` hands off to SurveyMonkey and friends, `native` runs the questions inside Cortex. `unmoderated` is a self-guided study that Cortex records in the browser (see *Unmoderated studies* below). `test` and `interview` are bookable.
- **Content:** title, purpose one-liner, optional description, optional product, default duration.
  `default_duration_minutes` is `NOT NULL DEFAULT 30` and is only *asked for* on bookable types.
  A recorded study carries its own **optional** duration on the Task List instead (`firsthand.studies.estimated_duration_minutes`, nullable, no default).
  Null means the researcher did not say, and every surface renders that as nothing - never as 30.
- **Status:** draft (admin-only), published (visible to all), closed (visible but not bookable).
- **Sessions:** For bookable types (test, interview), one or more time slots with capacity, location/meeting link; for poll/survey/question, an optional external link and click tracking only. `unmoderated` has neither — no time slots to book and no external link; it carries a **Task List** instead.

### Native polls and surveys

A poll or survey can run **inside Cortex** rather than handing the participant to an external tool. The researcher chooses on the opportunity form under *Where participants answer*; `external` is the default and is a supported choice, not a fallback, for teams that already licence a survey tool.

Native delivery collects the questions on the form itself (a Questions tab replaces the External Link tab) and stores them as a **study**, exactly like an unmoderated task list — but written in a different vocabulary. That is what `firsthand.studies.kind` records:

- `recorded` — a first-hand task list. The participant works through tasks while their screen and voice are captured, so they answer **out loud** and the authorable types are instruction, open text and single choice only
- `survey` — a native poll or survey. Nothing is recorded and everything is typed, so it also authors multi-choice, rating and NPS

The two are not interchangeable and the API refuses a mismatch: a recorded opportunity cannot link survey questions, and a native survey cannot link a task list. Question types are edited afterwards in the Task Lists area, which speaks both vocabularies.

A participant answers at `/survey/:token`, reached from the study page's call to action. Nothing is recorded — no screen, no microphone, no camera — and the consent text says so. One answer per participant per opportunity: an unfinished survey resumes where they left off, a finished one cannot be answered again — the mint route answers **409**, and the opportunity page shows *"You have already answered this survey"* rather than the generic failure message it fell through to before (MR !144).

A researcher reads the answers on their opportunity's analytics page, under a **Responses** tab beside Overview (`/admin/opportunities/:id/analytics`), with a CSV export beside the tallies.
Both are gated on **opportunity ownership** — the owner or a superadmin — like every other surface that returns participants' own data, and both are rate limited per user.

The tab appears whenever the opportunity has questions linked, **including after a switch to external delivery**: answers already collected are still that researcher's data, and gating the tab on delivery mode lost them the only route to it. A participant can no longer change an answer once their session has finished, and a survey session's token cannot reach the recording machinery at all.

The unit is the opportunity, not the study, and that distinction is the whole point.
A study is reusable by an opportunity its author did not create, so the study-wide read spans participants that other researchers recruited under their own consent wording; those routes (`GET /api/firsthand/studies/:id/results` and `.../results.csv`) stay **superadmin-only** and are not what a researcher sees.
Answers recorded before the opportunity was tracked on the session — anything minted before 7.37.0 — have no opportunity to be attributed to, and are left readable only through that superadmin route rather than being guessed at.

### Unmoderated studies

An `unmoderated` opportunity is a **self-guided study that Cortex records in the participant's browser**. There is no moderator, no time slot and no external tool. This capability came from folding the former standalone FirstHand app into Cortex, which is why the code still uses `firsthand` naming throughout.

- **Task List** — the script the participant works through: intro copy, consent (see **Consent is governed** below) and an ordered list of steps. A step may carry a `target_url`, the page the participant is asked to open and test. Authored inline on the opportunity form, or **started from a copy** of an existing Task List (B3, 7.45.0 — the source is copied in, not linked to). **Every authored step is an `instruction`**: sessions record screen and voice, so participants answer out loud and nothing typed is captured. The schema still carries `open_text` and `single_choice` for Task Lists written before that decision — those steps run, and stay editable, but no authoring surface offers the types and the runtime renders no input for them. A terminal `end` marker is appended automatically and is never rendered.
- **Vocabulary** — admin-side, the script object is a **Task List** and the word *study* means the research project (the opportunity). Participant-facing copy still says "recorded study", deliberately: a participant only ever meets one object, so the distinction would be noise to them.
- **Participation** — the participant opens the published opportunity, clicks *Start Test*, consents, then opens the floating task panel and drives the rest from there: the task page opens in its own window (so it appears in the browser's share picker), then recording starts. A session is minted server-side and its steps are **snapshotted at launch**, so editing a Task List never changes a session already in flight.
- **Floating task pane** (7.33.x) — where the Task List carries a `target_url`, the current task *also* renders into a **Document Picture-in-Picture** window floating above the page under test, so the participant is not memorising the task across two windows. **The participant opens it themselves**, from *Open the task window* in the setup step — nothing springs it, because a chrome-less always-on-top window appearing over every application unbidden is not something to do to someone. It then carries the whole launch: *Open the task page*, then *Start recording*. The in-page card and the pane are one React state rendered twice (`createPortal` into the pane's document), not a copy. Three things are load-bearing and easy to break: (1) **one click carries ONE transient activation, and `window.open` and `requestWindow` each consume it** — so no single click can open both the pane and the task-page popup, in either order, which is why each has its own control (verified live in Chrome both ways). A click *inside* the pane does carry activation for the opener's `window.open` and `getDisplayMedia`, which is what lets the pane run the launch; (2) the method is `requestWindow`, never `open`, and must be feature-detected as a *method*, because embedded browsers expose the object with it stripped; (3) the pane carries a non-authorable trust header and its own recording state, because every other recording-health signal renders in the tab this pane exists to stop them looking at, and because a chrome-less always-on-top window whose only heading is researcher-authored text is a phishing surface. Chromium only; Firefox and Safari keep the two-window flow. On genuine completion both windows close themselves — the pane, and now the task window too (MR !143) — but only from the success branch of `onComplete`: closing the task window from the recorder-failure/abandoned branch instead would risk ending a still-live shared capture (if the participant shared the task window itself) and re-triggering an upload for an attempt already marked abandoned, so the close is ordered after `stopCaptureAndUpload()` has already set its stop-in-flight guard.
- **Who can take part** — logged-in Cortex users only. There is no anonymous or emailed-token route, so an unmoderated study cannot be sent to anyone outside the organisation.
- **Sharing** — the shareable unit is the **opportunity URL** (`/opportunities/:id`). There is no participant-facing URL for a Task List. An admin viewing a published opportunity sees a *Share this study* panel offering that link.
- **Ownership** — a Task List records `owner_user_id`. Any admin may READ one and start a copy from it, but only its owner or a superadmin may edit or delete it, and since B3 (7.45.0) the API refuses a `firsthand_study_id` owned by somebody else.
- **Review** — the research team gets recording playback and a transcript. There are no per-step responses to read any more: a step with none shows *"Answered out loud - in the recording"*, and only sessions run before typed capture was removed carry stored answers.

### The authoring path — all three recorded defects are now fixed

Three defects were recorded here on 2026-08-18. **All three are resolved as of 7.43.7 (2026-08-19).** Full detail in `KNOWN_ISSUES.md`; the rework plan is at `~/.claude/plans/cortex-authoring-ux-rework.md`, now at **step C3** (A0, A1, B1, B2, B3, C1 and C2 are merged).

1. **Step ids are positional, and that is a real fragility — but it was never reachable, and is now guarded.** Ids are `` `${studyId}_step_${index + 1}` `` (`shared/firsthand/inline-study.ts`, `shared/firsthand/survey-authoring.ts`), `survey-results.ts` re-attaches responses by that key, and `participant_responses.step_id` has **no foreign key**. What the original write-up missed is that nothing could reach it: `StudyEditor` has no reorder control and its remove keeps every surviving step's id, and the opportunity route — the only thing that renumbers — refused to author over an existing study until 7.43.5. Since 7.43.5 it can, and **refuses the save when the study has collected answers and the questions would change**. Making the ids genuinely stable is still worth doing (plan step F2) but is no longer urgent.
2. **`loadOpportunity` now reads authored content back.** ~~Editing an opportunity reset the steps, questions and both consent fields to empty/default~~ — resolved in 7.43.7 (`!156`, plan step A1). It hydrates the linked study by `kind`, strips the appended `end` marker, reads the study-level starting URL through the runtime's own `getPrimaryTargetUrl`, and seeds `originalFormData` from the server's state rather than from defaults.

   Two things are worth carrying into any later change here. First, the flag that meant two things is split: `hasLinkedStudy` (a study is linked, so the source choice is hidden) and `studyIsReadOnly` (it may not be authored here, so the tab shows the content read-only). Collapsing them is what made the original loss invisible. B3 added a third distinction on top: a study that is **missing** is not read-only, because there is nothing to protect and the author needs the surface open to write a replacement. Second, and more important — **because the save path deletes every `study_steps` row and re-inserts what the payload carried, anything the form hydrates but cannot send back is destroyed on the next save and looks like a successful save.** Hydration and serialisation therefore live together in `frontend/src/lib/opportunity-authoring/hydrate-study.ts`, and `studyRoundTripsCleanly` decides read-only by running the round trip and requiring the result to equal what is stored, rather than by trusting either field list. Two HIGH review findings came from those lists having drifted apart.
3. **The opportunity route can now update a linked study in place.** ~~There was no in-place update path~~ — resolved in 7.43.5 (`!148`, `!152`). A `PATCH` carrying `inline_study`/`inline_survey` against an opportunity that already has a study now rewrites that study, and only when the caller may write it. The authorisation decision is taken by `updateStudy` inside its transaction behind its `FOR UPDATE` lock. Refused, deliberately, when: the study belongs to another researcher (403); another opportunity also links it; or it has collected answers and the questions would change. `title`, `intro_text` and `status` are never rewritten, because they are not authored on that form.

~~Also worth knowing, not a defect but routinely misread: **reuse is a live link, not a copy.**~~ **Resolved in 7.45.0 (`!179`, plan step B3): reuse is now a COPY.** Choosing an existing study copies its steps, consent and duration into the form as editable content, and the ordinary `inline_*` path mints a new study owned by the current user. `firsthand.studies.copied_from_study_id` records where it came from, is written once at create, and is shown both when the copy is taken and when the opportunity is reopened.

### Consent is governed — a template, a version, and a recorded override (C1, 7.46.0)

Consent used to be a four-row textarea at the bottom of the Questions / Task List step, pre-filled with one of two hardcoded defaults and freely editable, with nothing recording whether a study ran on approved wording or on something a researcher typed over it. Since `!181` it is **its own step**, and the answer is stored.

- **The step set changed.** The two authoring paths now have FOUR steps — Basic information → Content → Questions/Task List → **Consent** — and the create/update control moved onto Consent, because it is the last step. The three paths that author no study (external poll/survey/question, test/interview) are **unchanged at three steps and have no Consent step**: there is no consent for Cortex to govern when the participant answers in somebody else's tool. `getTabsForType` derives the Consent step from the presence of a `questions`/`taskList` step rather than re-testing `type` and `deliveryMode`, so a future authoring type gets one for free.
- **Two templates, versioned.** `shared/firsthand/consent-templates.ts` holds `recorded-default` v1 and `survey-default` v1 — the two strings that were already the hardcoded defaults, now with an id, a version, a name and a summary. A study stores `firsthand.studies.consent_template_id` and `consent_template_version`, or `custom` with a null version.
- 🔑 **The classification is VERIFIED, never trusted.** `resolveConsentTemplate` takes a client's *claim* about which template its wording is and returns it **only when the wording actually is that template version's wording**; otherwise `custom`. So a caller can always understate its approval and can never overstate it. A claim naming the other kind's template is refused before it is even compared — the survey wording's central sentence is "Nothing is recorded", which would be false of a recorded study.
- 🔑 **The classification is never independently writable.** `updateStudy` pushes the two columns **only when `consent_text` is present in the same request**, and resolves against the `kind` it read under its own `FOR UPDATE` lock, never the caller's. A request that could set the classification without sending the wording could assert that a study runs on approved consent while the stored sentence says something else.
- **Both columns are NULLable, deliberately.** Migration `0013` adds them empty and backfills by *reading each row's wording*, rather than stamping a `NOT NULL DEFAULT` over rows nobody had looked at — including the copies migration `0012` minted by `SELECT`-copying `consent_text` verbatim. NULL survives as the honest value for a row nothing could classify, and the application reads NULL as **unapproved** (`isCustomConsentTemplate`). A CHECK constraint pins the three legal shapes.
- **The pair is snapshotted into `runtime_sessions.session_payload` at mint**, beside the wording. The text alone answers "what did this participant agree to"; it cannot answer "and was that the wording anybody approved", because the study can be edited afterwards and a template can be superseded.
- **In the UI:** the step opens locked, naming the template and version; *Customise consent wording* unlocks it and is never blocked; `custom` is set by **divergence, not by the button**, so unlocking and changing nothing leaves the study on the template; a word-level diff shows what changed, with a sentence saying it in words as well as marked-up text. A **Custom consent** chip appears in the Task Lists list and on the copy-picker rows — the latter *before* a copy is taken, since a copy inherits its source's classification.
- ⚠️ **`StudyEditor` (the Task Lists area) has no template UI.** Its saves are classified correctly by the repository, so the record is complete, but the lock-by-default affordance is not there.
- **A new file under `shared/firsthand/` now needs nothing doing to it.** The frontend imports `shared/` directly via the `@shared/*` alias, so there is no copy to keep current and no hand-written list to update. This used to be a live hazard: `copy-shared-types.js` copied the directory wholesale while the guard test enumerated it by hand, so a new file was copied and never verified — `consent-templates.ts` shipped that way, and deleting its cross-kind guard from the frontend copy alone passed the whole frontend suite. Removing the duplication removed the class of defect.

`opportunities.firsthand_study_id` is **still** a bare `TEXT` column with no FK, no unique constraint and no index — deliberately kept, because it is how a *copied* study is referenced at runtime (session start, the publish guard, survey-results ownership, `OpportunityDetail`'s start-button logic). What went away is the ability to point two opportunities at one study: the picker is gone, and `assertLinkedStudyKindMatches` now refuses a link to a study you may not write. Migration `0012` converted the rows that already shared one.

Nothing has gone live, so none of this has harmed real data — every study and response in the deployment is test data.

### The authoring form is a stepper (C2)

Since `!183` the strip across the top of the opportunity form reports **progress and validity**, not just location. It had none of this before — no completion state, no validity state, no numbering, and no accessibility semantics at all.

- **Four states per step**, each carried by an icon *and* words as well as a colour: `notStarted`, `current`, `completed`, `needsAttention`. The whole state machine is one pure function, `deriveStepStatus` in `frontend/src/lib/opportunity-authoring/step-status.ts`.
- **Forward and backward navigation both stay free.** Needs-attention is information, not a lock. Nothing in the form gates a step behind an earlier one.
- 🔑 **One rule set, not two.** `collectValidationErrors` used to call `setValidationErrors` and *then* return the map, which makes it illegal to call during render. It is split into a pure `computeValidationErrors` (memoised) and a thin stateful wrapper; the strip asks the pure half. **No second "is this step done" rule set exists, and adding one would be the drift this form has already been bitten by.**
- The strip reads **both** the reported `validationErrors` state map and the live rules. The map alone is empty until something has been refused, so a blank form would claim Completed; the live rules alone would flag steps the author has never reached. `needsAttention` is `reported || (visited && live)`; `completed` is `visited && !reported && !live` **and only once `current` has been ruled out**, because the function answers `current` before it considers `completed`. Written out in full because this is the document the next session re-derives the rule from instead of reading `deriveStepStatus`, and a premise that is nearly right has cost this plan more than one defect.
- 🔥 **Visits are held by `StepKey`, never by the numeric step id.** Id 3 is Task List, Questions, External Link or Session Management depending on `type` and `delivery_mode`. Keyed on the id, walking to the Task List and then changing the type made the strip report **"External Link — Completed"** for a step the author had never opened. Errors are located by tab *number* and history by step *key*; `statusOfStep` takes the whole `FormStep` so the two cannot be collapsed.
- 🔥 **Anything that reshapes the step set must clear the errors belonging to the surface it replaced.** `clearTypeConditionalErrors` only ran for `type`; a `delivery_mode` change discards the authored questions just as completely, and the errors they produced stranded a "Needs attention" badge on the External Link step with nothing on it to fix. `clearDeliveryConditionalErrors` is its twin. Both live in `OpportunityForm.tsx` because the `FIELD_LOCATIONS` completeness test greps that file off disk.
- **"Completed" means "nothing here is stopping you"**, not "this step is finished" — a draft task list with no tasks passes, because the validator has nothing to say until publish. Anything stronger would be a second rule set.
- **An opportunity being edited opens with every step marked visited**, seeded once its load produces a baseline. Its content is on the server; calling three of four steps "Not started" would be false.
- 🔑 **The steps are `<button aria-current="step">`, deliberately NOT `role="tab"`.** A wizard is not a tab panel; `aria-current` is what `ParticipantSessionFlow` already says for this shape, while `Admin`, `Settings`, `OpportunityAnalytics` and `AdminManagement` are the real tab surfaces. The tab role also brings a roving tabindex (one Tab stop for the whole strip) and, decisively, **`role="tab"` replaces the button role, which around 100 unit-test call sites address these by**. The Playwright specs are a separate dependency and a separate reason: they navigate the strip with `.nav-link` plus a text substring rather than by role, so what they need is the **class** surviving on the clickable element. Both constraints are real; they are not the same constraint.
- ⚠️ **The accessible name of a step is now `Step N of M {title} {description} {status}`.** It is a strict superset of what it was, so substring matchers still match — but `Previous: {step name}` at the bottom of the page can make a bare `getByRole('button', { name: /Task List/i })` **ambiguous**. Address a step with `within(getByRole('navigation', { name: 'Form steps' }))`.
- **Step changes are announced** through a visually-hidden `role="status"` region naming position, title and state, guarded so it fires on a step change and not on every render.

- ⚠️ **The two `DEFENCE ONLY` guards in `OpportunityForm.tsx` are still unreachable**, and C2 did not change that. The `activeTab` clamp needs a control that reshapes the step set to live somewhere other than step 1, and both of them — the type selector and the delivery-mode choice — still live on step 1. The refusal-routing guard needs a validation error naming a step this shape does not have, and `handleSubmit` routes off a **freshly computed** map, which cannot name step 4 for a shape with no step 4. Note the asymmetry that makes this subtle: the stepper reads the **stored** `validationErrors` map as well, which is why a stale consent error *could* strand a badge and why `clearDeliveryConditionalErrors` exists — the badge and the routing read different maps.

**The two backward concepts are named apart.** The control that leaves the form and the control that goes back one step were two `btn-outline-secondary` buttons carrying the same `ArrowLeft` and the same word, told apart by position alone. The top one is now **"Exit to dashboard"** — flatly, since #46 removed `allowUserSubmission` and with it the "Exit to home" variant — with a different icon and an unsaved-changes confirmation; the bottom one is **"Previous: {step name}"**, derived from the step list rather than a number hard-coded at each call site, across **all six** of them — `AdminSessionManager` renders the sixth and had been missed.

🔑 **The unsaved-work check runs two instruments.** `hasChanges()` enumerates ~40 comparisons because it decides whether to *offer* a save, and that list has been wrong twice; `hasUnsavedChanges` in `frontend/src/lib/opportunity-authoring/dirty-signature.ts` compares the whole form object and cannot drift. Either one warning is enough. It also counts `sessions` holding a `temp-session-` id, which live outside `formData` entirely, and it falls back to the object comparison whenever there is no server baseline — **an edit whose load failed renders fully editable with `originalFormData` still null**, and `hasChanges()` returns a flat false for it. There is deliberately **no "a save just succeeded" shortcut**: both baselines are refreshed by the save itself, and a shortcut would suppress a real warning for anything typed in the up-to-three-second window the form stays on screen after a create.

### Sessions

Time-bound slots for an opportunity: start/end time, capacity, booked count, optional location or meeting link. Sessions auto-close when full or when end time has passed. Bookable types only — `unmoderated` never has them.

### Bookings

A user’s reservation of one session slot. States: booked, cancelled. Booking creates a Google Calendar event on the opportunity owner’s calendar and sends confirmation (and optional reminder) to the participant. User can cancel from “My Bookings”, then book a different slot. Reschedule is **not** implemented: `POST /api/bookings/:id/reschedule` exists and is guarded, but no UI calls it.

### Polls and surveys

Opportunities with an external link (e.g. Google Forms, Typeform). User clicks “Open Poll” / “Open Survey”; the app records a click (view vs action) for analytics and opens the link. No in-app form; participation is tracked for engagement/analytics (e.g. views, actions, conversion).

**The native in-app path is live and complete**, as of phase 4 (releases 7.37.0 to 7.40.0 plus 4e).
`poll` and `survey` have always been opportunity types - they were only ever *forced* external by the publish guard in `backend/src/routes/opportunities.ts`, and that guard now accepts native delivery.
Phases 1 to 3 shipped the machinery in 7.36.0, inert: question types on the study contract, per-step question config (migration `0008_firsthand_step_config.sql`), answer validation rules, a participant runner, and results aggregation with CSV export.
Phase 4 wired all of it up - the delivery toggle, the publish guard, the authoring UI, the participant route at `/survey/:token`, and finally the researcher's Responses tab.
See *Native polls and surveys* above for how it behaves.

Read this before building anything here: most of it already exists, and a previous session nearly rebuilt it from scratch.
Phase 4 is the part that is missing - the authoring toggle, the publish-guard change, the CTA labels and the routing in `OpportunityDetail`.
Do **not** widen `authorableStepTypes` to do it; that set is the vocabulary of a *recorded* task list, and the frontend typecheck refuses the change.

---

## 5. Main features (by area)

### Dates, times and time zones

**One format across the whole app, from `frontend/src/utils/datetime.ts`. Never call `toLocaleDateString`/`toLocaleTimeString` directly in a component.**

- Dates: `Tue 18 Aug 2026`. The month is always **named** — `08/07` reads as July to half of Adaptavist and August to the rest, and a booking is the one thing nobody can afford to misread.
- Times: 24-hour, `21:00 – 21:45`.
- Time zone: always available, as an **offset** (`GMT+1`), never an abbreviation. `timeZoneName: 'short'` hands `BST` to a British reader and `GMT-4` to an American one *from the same call*, so two colleagues would see one slot labelled two ways.
- Every helper returns `null` for an unusable value, so a bad date renders as nothing rather than as "Invalid Date".

**Exception:** the admin session **calendar** grid is local throughout — geometry and labels — but any grid whose layout encodes a zone must have its labels in that same zone. Changing one without the other puts every caption an hour out of its own row.

### For everyone

- **Browse:** A single **index of rows** (not a card grid) of published opportunities, filtered by type. Sorted **closing soonest first**, with unknown deadlines after those and ended studies last. Each row carries a verb for what taking part involves (*Book a time*, *Open poll*, *Start recorded study*), and participant-facing type names — **Recorded study**, not "unmoderated".
  Those names are now used on **admin surfaces too**: `getParticipantFacingType` is the single place a type becomes words, and the old admin formatter (`formatOpportunityType`, which produced "APP TESTING" / "UNMODERATED") is deleted.
  One name per type, everywhere.
- **Opportunity detail:** Full description, sessions with remaining slots, Book button (bookable types) or Open Poll/Survey (external link types).
  Eligibility is stated **only when it narrows** who can take part (`external`, or `specific` with the researcher's criteria) — `getEligibilityNote`, shared with the browse row. "Any" is never shown: every route to taking part needs a signed-in Cortex account, and a recorded study refuses external participants outright.
- **Calendar conflict detection:** When logged in, sessions can show a conflict indicator if the user’s calendar is busy (where integrated).

### For employees

- **Book / cancel:** Book a session; cancel from “My Bookings” (upcoming and past). To change time, cancel and re-book.
- **My Bookings:** Upcoming and past; cancel action; each booking shows its date, time **and time zone**, and past bookings show their outcome (awaiting confirmation / attendance confirmed / not confirmed).
- **AdaptaBits (gamification):** Points for participation (e.g. completed tests/interviews); levels; achievements; global and monthly leaderboards; points history. Access via “AdaptaBits” in the header.
- **Submit Research Request:** Link out to service desk (e.g. Atlassian) for formal requests. **The only path** — there is no in-app request form, and #46 deleted the unrouted one that suggested there might be.
- **Send Feedback:** In-app feedback (category, text, URL, etc.); visible to admins/superadmins.
- **Request Admin Access:** Self-serve request for researcher_admin (or superadmin) role; superadmin approves/denies.

### For researcher admins

- **Admin dashboard:** Counts (opportunities, bookings, participants, available slots); table of opportunities with stats (sessions, bookings, clicks for poll/survey).
- **CRUD opportunities:** Create, edit, delete, duplicate; set type, title, purpose, description, duration, status; for poll/survey/question set an external link; for unmoderated author a Task List on the form (or start from a copy of an existing one).
- **Sessions:** Add, edit, delete sessions (start/end, capacity, location/meeting link); sessions with existing bookings require care when editing.
- **Publish workflow:** Save as draft or publish; draft only visible to admins.
- **Analytics (per opportunity):** For poll/survey/unmoderated (and relevant types): views/actions, time-series, conversion; period 7/14/30 days. Admin/owner only. Unmoderated additionally has per-session review — recording playback and transcript (answers are spoken, so no typed responses are stored).
  **Days and hours are bucketed in one fixed organisation zone** (`ANALYTICS_TIME_ZONE`, default `Europe/London`), cut in SQL, and the page states which zone it counted in. Analytics gets quoted between people, so a chart that reshaped itself per viewer would be worse than one explicitly in UK time.
  **Week-over-week is `null` when the previous week was empty**, and the card reads "no previous week to compare". There is no percentage change from zero, and 0% would read as flat — which is a measurement.
  Chart totals follow the selected period rather than a fixed seven days, and what counts as an "action" is named per type: *Started the study*, *Booked a time*, *Opened the poll*.
- **Survey results (built, not yet reachable):** `GET /api/firsthand/studies/:studyId/results` returns an aggregate per question, and `.../results.csv` exports the raw answers.
  Both require a **superadmin**, and that is deliberately stricter than it looks.
  These routes aggregate every response for a study across **every opportunity that used it**, and a study is reusable by an opportunity its author did not create - so granting the study's owner would hand them answers from participants another researcher recruited, under that researcher's consent wording.
  A refusal is answered before any answer is read, and before the CSV download headers are set, so a rejected export cannot still hand over a file.
  **Phase 4e fixed the model rather than relaxing the gate**, and the superadmin restriction on these two routes is now the end state.
  A researcher reads their own answers at `GET /api/opportunities/:id/survey-results` (and `.csv`), gated on opportunity ownership like `/:id/session-events` and filtered to the answers that opportunity collected - `firsthand.runtime_sessions.opportunity_id` was added in 7.37.0 for exactly this.
  Extend that surface, not this one, when a researcher cannot see something they should.
- **Click tracking:** Back-end records view (detail opened) and action (e.g. “Open Poll” / “Book” clicked); optional auth; IP hashed for privacy.
- **Settings:** Notification preferences (on_book_email, on_cancel_email); optional reminder timing.

### For superadmins

- **Admin requests:** List and approve/deny requests for researcher_admin or superadmin.
- **Admins:** List current admins; revoke access.
- **Feedback:** Delete user feedback.
  NOTE: *reading* and exporting feedback is open to **every admin**, not just superadmins - `Admin.tsx` says so deliberately, twice ("Feedback tab - all admins (researcher_admin and superadmin)"), and the API matches it. This document previously claimed superadmin-only and was wrong; it was nearly the subject of a security sweep on that basis.

### Platform / UX

- **Theme:** Light/dark mode toggle; WCAG 2.2 AA–oriented.
- **Landing:** Branded hero (“CORTEX”, “Collective Intelligence”), primary CTA “Access Cortex” (e.g. Google), then six below-the-fold sections — pitch, “How Cortex works”, value by role, key features, FAQ, final CTA; demo access pills when enabled.
  The landing renders only for a signed-out visitor (`Home.tsx`), directly above the browsable list of published studies.
  **There is no social proof section.** It was deleted in the copy refresh: its three metrics and two testimonials were invented, nothing in the repository sourced them, and the product is in alpha with test data only. Bring it back only with attributed quotes and counts read from the dashboard aggregates.
  The copy is guarded by `frontend/src/components/__tests__/SalesSections.test.tsx`, which pins the section list and holds a literal list of banned claims — including the participant-matching engine that has never existed — with a control arm proving the detector still fires.

---

## 6. Integrations and technical behaviour

- **Auth:** SSO (e.g. OpenID Connect / Google); session-based; `/api/me` for current user and role.
- **Google Calendar:** On book: create event on opportunity owner’s calendar; attendees include participant and owner; reminder (e.g. 24h). On cancel/reschedule: update/remove event and notify.
- **Email:** Transactional emails for booked, reminder, cancelled, reschedule; researcher notification toggles for on_book and on_cancel.
- **Cron (in-process node-cron in the Express backend):** Reminder job (e.g. 24h before session); the manual trigger endpoint is protected by CRON_SECRET.

---

## 7. Data and privacy

- **Minimal PII:** e.g. name, email, business unit, role/title; SSO as source of truth.
- **Analytics:** Click tracking with hashed IP; views/actions and conversion for research use only.
- **Security:** Role checks server-side; CORS; secure cookies; rate limiting on auth; internal/VPC deployment expectations.
- **Participants' own answers and recordings are owner-gated, not merely admin-gated.**
  Being a `researcher_admin` is not sufficient: recording playback and transcripts (`session-outputs.ts`) and per-session events (`GET /api/opportunities/:id/session-events`) require the **opportunity owner** or a superadmin, and survey results (`GET /api/firsthand/studies/:studyId/results` and `.../results.csv`) currently require a **superadmin** because they cannot yet be scoped to an opportunity - see the survey results entry above.
  Study *copy* is treated differently on purpose - the study list and single-study read stay open to every admin, because the copy picker lists every launched study. That was confirmed under B3's security gate rather than assumed: copy grants **no new read capability**, since both routes are byte-identical to their pre-B3 form and edit-mode hydration already fetched a linked study's full content. Recorded and not yet decided: `requireAdmin` does not distinguish `researcher_admin` from `superadmin`, so any researcher-admin can read every study's `consent_text`. C1's security gate confirmed the writing half of the same question and it is **also open**: `canWriteStudy` fails open on a NULL `owner_user_id`, and `consent_text` counts toward `claimsOwnership`, so **any researcher-admin can rewrite the consent wording of any unowned legacy study, and doing so adopts it**. C1 did not widen that — a consent edit went from pushing one column to three, and the check is `> 0` — and it now records the deviation where it did not before. The gate recommends failing *closed* for `consent_text` on an unowned study while leaving title and steps open; that is a product call and belongs to a later step.
  The line is drawn at participant data, so when adding any route that returns answers, events or recordings, gate it on ownership and not on `requireAdmin` alone.

---

## 8. Non-functional goals

- **Performance:** List of opportunities renders in under ~1 second with large lists (e.g. 100 items).
- **Accessibility:** WCAG 2.2 AA basics.
- **Deployment:** Production-ready; alpha testing phase; Kubernetes (Kubera) + AWS RDS Postgres; Docker option for dev.

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
- **Opportunity types:** test, poll, survey, interview, question, unmoderated. Three shapes, not two: **bookable** (test, interview), **external link** (poll, survey, question), and **recorded self-guided** (unmoderated). Do not describe unmoderated as external-link.
- **Flows:** Browse → Detail → Book (or Open Poll/Survey); My Bookings for cancel; Admin for create/publish/analytics; superadmin for admin requests and feedback.
- **Rewards:** AdaptaBits (points, levels, leaderboards, achievements).
- **Support:** In-app “Send Feedback”; service desk link; contact (e.g. cortex@adaptavist.com, nfine@adaptavist.com for support).

Use this document as the single source of truth for product description when providing context to Claude or other AI assistants.
