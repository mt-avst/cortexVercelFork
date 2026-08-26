# Research methods - what is complete and what hands off

Status of the six study types Cortex offers, as of 2026-08-26.

Read-only survey of the code, not a plan.
It records which research methods run end to end inside Cortex and which send the participant to a third-party site, along with what that costs in captured data.

**Method**: traced each type through the enum, the publish gate, the author form, the participant call to action and the results surface.
The files that decide each of those are named inline so a future reader can re-check rather than trust this document.

## The six types

Cortex has exactly six opportunity types, defined in `shared/constants/index.ts:262`.

| Method | Author | Participant runs it | Data lands in Cortex | Status |
|---|---|---|---|---|
| Unmoderated ("Recorded session") | Task List tab + Consent | Recorded runner in Cortex | Recording, transcript, session review | **Complete** |
| Survey - native delivery | Questions tab + Consent | SurveyRunner at `/survey/:token` | Results view + CSV export | **Complete** |
| Poll - native delivery | Same engine as survey | Same | Same | **Complete** |
| Survey - external delivery | External Link tab | Third-party tool, new tab | Click count only | **Hands off** |
| Poll - external delivery | External Link tab | Third-party tool, new tab | Click count only | **Hands off** |
| Question ("one question") | External Link tab, no native option | Third-party tool, new tab | Click count only | **Hands off** |
| Test ("Live session") | Session Management only | Zoom / Meet / Teams call | Booking count only | **Hands off** |
| Interview | Session Management only | Zoom / Meet / Teams call | Booking count only | **Hands off** |

Poll and survey appear twice because `delivery_mode` genuinely splits them into two different products.
`native` runs in Cortex, `external` is a hand-off, and the author picks per opportunity.

## What is complete

### Unmoderated - "Recorded session"

The deepest of the three.
Inline authoring of the task list, a consent step, a study-level `target_url` the participant opens and screen-shares, recording upload to object storage, automatic transcript generation in `backend/src/firsthand/transcript-automation.ts`, playback in Session Review, and session events on the analytics page.

The participant does leave Cortex to reach the product under test, but Cortex captures the whole session.
That is a hand-off in name only and should not be counted as a gap.

Authorable step types are narrower than the contract's, deliberately: `instruction`, `open_text` and `single_choice` only, because answers are spoken aloud rather than typed and a rating widget has nothing to render into (`shared/firsthand/inline-study.ts:66`).

### Poll and survey, native delivery

One engine serves both.
Six question types - `instruction`, `open_text`, `single_choice`, `multi_choice`, `rating`, `nps` (`shared/firsthand/survey-authoring.ts:37`).
Consent step, in-tab runner, a results panel and a CSV download on the analytics page.

The API refuses a mismatched pairing at the boundary rather than only in the picker: `requiredStudyKindFor` in `backend/src/routes/opportunities.ts:247` maps unmoderated to the `recorded` vocabulary and native poll or survey to the `survey` vocabulary, and every other shape links no study at all.

## What needs work

Four items, in the order they are worth doing.

### 1. `question` has no native path at all - tracked as #78

Smallest gap, and the engine that would close it already ships.

The form code says it outright at `frontend/src/pages/OpportunityForm.tsx:459`: *"`question` has no native path yet and keeps the link tab unconditionally"*.
A one-question study is the smallest possible case of the survey runner already built for poll and survey.

A second defect is stacked on it.
`findPublishProblem` in `shared/firsthand/publish-readiness.ts:122` gates only `unmoderated`, `poll` and `survey`.
A `question` opportunity can therefore be published with no link at all, and the participant is then shown a disabled "Link unavailable" button (`frontend/src/pages/OpportunityDetail.tsx:1257`).
Publishing something unusable should not be possible.

**Scope of the absence assertion**: grepped all `.ts` and `.tsx` under `shared`, `backend/src` and `frontend/src`, excluding test files.
51 references to the `question` type, none of them touching `native`, `firsthand` or `delivery_mode`.

### 2. Moderated test and interview capture nothing - tracked as #79

Biggest gap, biggest build.

Both types get a Session Management tab and nothing else (`getTabsForType`, `frontend/src/pages/OpportunityForm.tsx:449`).
No consent step, no recording, no notes, no results.
The researcher runs the session on a call - the meeting link is `meeting_location_optional`, rendered as "Join via Google Meet / Zoom / Teams" in `frontend/src/pages/MyBookings.tsx:163` - and Cortex's entire record of what happened is "Booked a time" on the analytics card.

The components exist separately: a recorded runner, a booking system, transcript generation.
Nothing joins them for a live moderated session.

### 3. External poll and survey return no data - not tracked

`external_link_optional` is required before publish, the call to action is a `window.open`, and the only thing that comes back is `trackOpportunityClick(id, 'action')`.
Started, abandoned, completed and the answers themselves are all invisible to Cortex.

The existing `backend/src/firsthand/callback-delivery.ts` does **not** cover this.
It delivers outbound lifecycle events from Cortex to an integrator (`session_started`, `session_completed`, `session_abandoned`, `session_failed`), not inbound results from Typeform, SurveyMonkey or similar.
Closing this gap means either an inbound ingest path or an explicit decision that an external study's data stays external.

### 4. Consent exists only on the native paths - not tracked

Deliberate, and argued for at `frontend/src/pages/OpportunityForm.tsx:497`: a hand-off's consent lives in the tool on the other side of the link, and an empty Consent step would imply Cortex has a say in something it does not.

Worth revisiting as research governance rather than as a bug.
For external and booked studies, Cortex holds no consent record for a study it recruited participants for.

## Recommended order

Build the native path for `question` first (#78).
It is a `delivery_mode` branch plus a one-question reuse of SurveyRunner, it closes the publish-readiness hole in the same change, and it is the only one of the four that adds no new machinery.
The publish-readiness half is worth splitting out and doing on its own first: it is a few lines, and until it lands a researcher can publish a study nobody can take part in.

Item 2 (#79) is a product decision before it is a ticket, and the issue carries the questions that need answering before anyone starts.

Items 3 and 4 are deliberately untracked.
Both are decisions about what Cortex is for rather than defects in what it does, and neither has an owner asking for it.
Raise them when someone does.

## Naming

`test` and `unmoderated` are named as a pair - **Live session** and **Recorded session** - as of !273, 2026-08-26.
They are one research method differing only in whether a researcher is present, and the previous names ("Usability test" and "Recorded study") implied the recorded one was not a usability test.
The word *Recorded* is load-bearing rather than decorative: it carries the first part of the recording disclosure, and it reaches a participant long before the detail page does.
