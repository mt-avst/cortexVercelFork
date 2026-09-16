# CONTEXT.md

Domain glossary for Cortex (AdaptaLabs).
Use these terms exactly in issue titles, test names and proposals - do not drift to synonyms.
Seeded 2026-08-26; extend via `/domain-modeling` when a term gets resolved, not speculatively.
Calendar terms added 2026-08-27 after #89.
Moderated-capture terms added 2026-08-29 after #79.
Drawable window and actionable session added 2026-09-01 after #95 and #62.

## Terms

- **Opportunity** - a research opportunity a researcher publishes and participants book into.
  Lives at `/opportunities/:id`; authored in OpportunityForm at `/admin/opportunities`.
- **Session** - a bookable time slot belonging to an opportunity.
- **Booking** - a participant's claim on a session.
- **Booking artefact** - a recording or transcript of a moderated session, ingested against the
  booking after the call (presign, direct S3 PUT, finalize - `routes/booking-artifacts.ts`).
  The artefact is the call platform's own export; Cortex neither hosts nor records the call (#79, D1)
  and runs no speech-to-text (D2).
- **Consent acceptance** - the booking-time record that the participant accepted the
  opportunity's consent wording: timestamp plus the wording itself as `consent_text_snapshot`.
  Anchored to the OPPORTUNITY for moderated types (there is no study row), refused on every
  other type (#79, D5).
- **Attestation** - a researcher's typed statement that consent was obtained outside Cortex,
  the only alternative the artefact ingest gate accepts to a recorded acceptance (#79, D3).
- **Study** - a FirstHand study attached to an opportunity; the participant-facing research
  instrument. Runs in-process under `/api/firsthand/*` (the old HTTP integration is gone).
- **`studies.kind`** - the column that separates the two study vocabularies (native
  poll/survey vs usability studies). The two vocabularies never mix - see ADR-0001.
- **Participant** / **Researcher** / **Admin** - the three actor roles. "Researcher admin"
  in older docs means researcher.
- **Step** - one unit of a study a participant moves through. Which types are authorable is
  governed by `authorableStepTypes` - never widen it casually (ADR-0001).
- **Ponytail** - a deliberate simplification with a known ceiling, marked with a
  `ponytail:` comment naming the ceiling and upgrade path (see AGENTS.md).
- **Mutation canary** - the curated manifest of load-bearing lines, each paired with the one
  test that must fail when the line changes (`scripts/mutation-canary.*`, ADR-0004).
- **Calendar mode** - `real` / `demo` / `unavailable`, decided once by `calendarOAuthMode()`
  in `routes/userCalendar.ts` and read by BOTH ends of the OAuth flow. `demo` is a complete
  working connection with no Google credentials (development only); `unavailable` refuses,
  because demo tokens are fabricated. Say "mode", not "demo mode is on" - the latter hides
  the development/production distinction that is the whole point (#89, ADR-0006).
- **Generated slot** vs **hand-entered slot** - the availability endpoint GENERATES a grid on
  duration boundaries from 07:00 UTC without consulting any calendar; a researcher can also
  HAND-ENTER one. Hand-entered slots and real sessions are *protected*: they win the overlap
  prune and skip the duration filter, because a slot the researcher asked for that is silently
  dropped is worse than a crowded grid (#89).
- **Drawable window** - the hours the Session Management timeline actually draws, 07:00-23:00
  in the VIEWER's local time (`TIMELINE_START_HOUR` / `TIMELINE_END_HOUR`). It is a property of
  the grid, not of the data, which is why there is no server-side rule enforcing it: the same
  instant is inside one researcher's window and outside another's (#95).
- **Gutter row** - the row beneath a day's column carrying sessions outside the drawable window,
  at their real times and clickable. It exists because `getTimePosition` clamps, so such a session
  was drawn at a fraction of a pixel: present, counted, and impossible to remove (#95).
- **Actionable session** - one a participant can still act on, `end_time > NOW()`, which is what
  the participant catalogue embeds. NOT "upcoming": a session already under way is still bookable
  (`routes/bookings.ts` refuses on end time), so the two differ by exactly the sessions in
  progress. The admin listing embeds the live schedule plus a recent 14-day tail rather than the
  whole archive (#62, #103), so its slot totals mean "recent + live", not "lifetime".
- **Availability** is not **free/busy**. Availability needs no calendar and always works.
  Free/busy is the researcher's real commitments and needs a connected calendar; without one
  the grid is unchecked and the UI says so. Conflating the two is what made #89 look like a
  calendar bug when the picker was actually discarding a perfectly good grid.
- **Screener** - the eligibility questions a researcher attaches to an opportunity so only the
  right people take part. A small set of single-choice questions, each answer flagged qualify
  or screen out, stored as JSONB on the opportunity. Absent means no screener - anyone signed
  in may take part. Not "role" or "targeting" - "role" already means the actor roles. Owns
  its own vocabulary in `shared/screener.ts` (ADR-0007).
- **Screener verdict** - a participant's stored outcome for one opportunity's screener,
  `qualified` or `screened_out`, one per `(opportunity, participant)` in
  `opportunity_screener_responses`. The three apply chokepoints (book, recorded-session,
  survey-session) refuse anyone without a `qualified` verdict. Latest answer wins - a
  screened-out participant may retake. NOT the same axis as a booking's `completion_status`
  (that is post-session approval); the verdict gates BEFORE the study starts.
- **Screened out** - the terminal verdict for a participant an answer disqualified. They see
  the opportunity's not-a-match message and cannot book. Say "screened out", not "rejected"
  or "disqualified" (which reads as the answer-level flag, `disqualifies`).
