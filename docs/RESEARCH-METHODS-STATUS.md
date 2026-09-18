# Research methods - what is complete and what hands off

Status of the six study types Cortex offers, as of 2026-08-26, with the #78 publish gate re-checked on 2026-08-28, the moderated rows rewritten on 2026-08-29 after cto/AdaptaLabs#79 landed (!311-!315), and the `question` rows rewritten on 2026-09-02 when cto/AdaptaLabs#78 closed.

Read-only survey of the code, not a plan.
It records which research methods run end to end inside Cortex and which send the participant to a third-party site, along with what that costs in captured data.

**Method**: traced each type through the enum, the publish gate, the author form, the participant call to action and the results surface.
The files that decide each of those are named inline so a future reader can re-check rather than trust this document.

## The six types

Cortex has exactly six opportunity types, defined in `shared/constants/index.ts:275`.

| Method | Author | Participant runs it | Data lands in Cortex | Status |
|---|---|---|---|---|
| Unmoderated ("Recorded session") | Task List tab + Consent | Recorded runner in Cortex | Recording, transcript, session review | **Complete** |
| Survey - native delivery | Questions tab + Consent | SurveyRunner at `/survey/:token` | Results view + CSV export | **Complete** |
| Poll - native delivery | Same engine as survey | Same | Same | **Complete** |
| Survey - external delivery | External Link tab | Third-party tool, new tab | Click count only | **Hands off** |
| Poll - external delivery | External Link tab | Third-party tool, new tab | Click count only | **Hands off** |
| Question ("one question") - native delivery | Question tab + Consent, capped at one question | Same engine as survey | Results view + CSV export | **Complete** |
| Question ("one question") - external delivery | External Link tab | Third-party tool, new tab | Click count only | **Hands off** |
| Test ("Live session") | Session Management + Consent | Zoom / Meet / Teams call | Consent acceptance, researcher notes, ingested recording + transcript, playback | **Artefact parity** |
| Interview | Session Management + Consent | Zoom / Meet / Teams call | Consent acceptance, researcher notes, ingested recording + transcript, playback | **Artefact parity** |

Poll, survey and question each appear twice because `delivery_mode` genuinely splits them into two different products.
`native` runs in Cortex, `external` is a hand-off, and the author picks per opportunity.
Question joined them when #78 closed; before that it had the external row only.

**Artefact parity** means the artefacts land in Cortex but the session does not run there.
The call still happens on a third-party platform; the researcher ingests that platform's own export afterwards.
Capture is exactly as complete as the export and arrives after the call, by decision (#79, D1) - a hosted call or an automatic platform-API pull would be a later enhancement behind the same surface.

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

The API refuses a mismatched pairing at the boundary rather than only in the picker: `requiredStudyKindFor` in `backend/src/routes/opportunities.ts:257` maps unmoderated to the `recorded` vocabulary and native poll or survey to the `survey` vocabulary, and every other shape links no study at all.

### Moderated test and interview - artefact parity, shipped as #79

The gap this document originally named as its largest was closed in five merges (!311-!315), all landed 2026-08-28/29.
The session still runs on a call - the meeting link is `meeting_location_optional`, rendered as "Join via Google Meet / Zoom / Teams" in `frontend/src/pages/MyBookings.tsx:163` - but everything around it now lands in Cortex:

- **Consent authoring on the opportunity.** Both moderated types get a Consent step by type in `getTabsForType` (`frontend/src/pages/OpportunityForm.tsx:529`), anchored to the opportunity because there is no study row to hang it on.
  The API refuses `consent_*` columns on every other type, at all six write surfaces - four through a single gate (`resolveModeratedConsentWrite`, `backend/src/routes/opportunities.ts:309`), while the two duplicate branches copy the already-resolved trio verbatim from a source that passed it.
- **Acceptance recorded at booking.** The participant accepts the wording they were shown - the client echoes it back and the server refuses a mismatch - and the booking stores the acceptance timestamp (`NOW()` in SQL, same clock as `created_at`) plus the wording itself as `consent_text_snapshot`, so what was agreed to can be reproduced, not merely detected.
- **Artefact ingest.** Recordings and transcripts upload against the booking via presign, direct S3 PUT and finalize (`backend/src/routes/booking-artifacts.ts`).
  Ingest refuses unless the booking carries recorded acceptance or the researcher supplies a typed attestation that consent was obtained outside Cortex (`resolveConsentGate`), and a write-side playable-mime gate keeps stored-XSS shapes out.
- **Playback.** A gated media route streams the recording to the owner or a superadmin, scope-bound to the booking in the path.
  Finalize copies the upload to a key no presigned URL was ever issued for (`cto/AdaptaLabs#99`, closing the MD5-collision swap an earlier ETag tripwire could only detect rather than prevent), so the media route serves it directly with no live re-verification against S3.
  The Participants tab on the analytics page carries the artefact section: upload, on-demand `<video>` playback and delete-with-confirm.
- **Transcript rendering.** An ingested WebVTT transcript renders inline as cues (`shared/firsthand/vtt-parser.ts`, `TranscriptView`), falling back to raw text when parsing misses.
- **Researcher notes.** A free-text note per booking (`bookings.researcher_notes`), the researcher's own record - both participant-facing booking projections exclude the column by construction.

Two things are deliberately not built, each a decision rather than an omission.
Cortex does not host or record the call itself, and does not pull recordings from the meeting platform's API - ingest-afterwards was chosen (#79, D1) and a pull would be a later enhancement behind the same routes.
There is no speech-to-text in the repo (#79, D2): a transcript artefact is whatever the platform exported, and the recorded path's "transcript generation" (`transcript-automation.ts`) remains a prototype that interleaves prompts with typed answers, so it offers nothing to reuse here.

## What needs work

Two items. A third - `question` having no native path - closed on 2026-09-02 and is recorded below.

### Closed: `question` had no native path at all - was #78

It has one now. `question` carries `delivery_mode` exactly as poll and survey do: native gets the Question step, a Consent step, an `inline_survey` of one, a study of kind `survey`, a session at `POST /:id/survey-session`, SurveyRunner at `/survey/:token` and the Responses tab with its CSV export. External delivery is untouched, which is what every stored `question` row is - the column defaults to it.

A one-question opportunity asks exactly one question, enforced at the API boundary on both the authored payload and a study arriving by `firsthand_study_id`. Without that cap it and a native survey are one product under two names.

The predicate deciding native delivery now lives once, in `shared/firsthand/delivery.ts`, rather than being written out at each site that asks.

A second defect used to be stacked on this one, and was fixed earlier.
`findPublishProblem` gated only `unmoderated`, `poll` and `survey`, so a `question` opportunity could be published with no link at all and the participant was shown a disabled "Link unavailable" button.
That shipped as commit `43ca805` on 2026-08-26 (merge `af2c9f4`): `findPublishProblem` requires a usable external link before a handed-off `question` study can be published, and the reproduce steps in #78 no longer reproduce.
Those tests still guard it in `backend/src/firsthand/publish-readiness.test.ts`, alongside the native arm added when #78 closed.

### 1. External poll and survey return no data - not tracked

`external_link_optional` is required before publish, the call to action is a `window.open`, and the only thing that comes back is `trackOpportunityClick(id, 'action')`.
Started, abandoned, completed and the answers themselves are all invisible to Cortex.

The existing `backend/src/firsthand/callback-delivery.ts` does **not** cover this.
It delivers outbound lifecycle events from Cortex to an integrator (`session_started`, `session_completed`, `session_abandoned`, `session_failed`), not inbound results from Typeform, SurveyMonkey or similar.
Closing this gap means either an inbound ingest path or an explicit decision that an external study's data stays external.

### 2. Consent exists only where Cortex runs the study or stores its artefacts - the pure hand-offs are untracked

The moderated half of this item closed with #79: `test` and `interview` now carry opportunity-anchored consent with an acceptance record at booking, and ingest is gated on it (see above).
The old argument - "a booked session has no study, so there is no consent for this product to govern" - expired the moment Cortex began storing a moderated session's recording, and the comment beside the Consent step in `frontend/src/pages/OpportunityForm.tsx` now says so.

What remains is the pure hand-off paths: external poll, external survey and external `question`.
A NATIVE question left this list when #78 closed - it authors a study, so it gets a Consent step derived from that step rather than from its type, which is the rule the wizard already applied to poll and survey.
For the hand-offs, consent lives in the tool on the other side of the link, deliberately, because Cortex keeps no artefacts of them and an empty Consent step would imply Cortex has a say in something it does not.
For those paths Cortex still holds no consent record for a study it recruited participants for.
Worth revisiting as research governance rather than as a bug - together with item 1, since ingesting external results would expire the argument for those paths exactly as artefact storage expired it for the moderated ones.

## Recommended order

Both remaining items are deliberately untracked.
Both are decisions about what Cortex is for rather than defects in what it does, and neither has an owner asking for it.
Raise them when someone does - and raise them together, because ingesting external results (item 1) would change the consent answer (item 2).

## Naming

`test` and `unmoderated` are named as a pair - **Live session** and **Recorded session** - as of !273, 2026-08-26.
They are one research method differing only in whether a researcher is present, and the previous names ("Usability test" and "Recorded study") implied the recorded one was not a usability test.
The word *Recorded* is load-bearing rather than decorative: it carries the first part of the recording disclosure, and it reaches a participant long before the detail page does.
