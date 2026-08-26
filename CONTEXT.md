# CONTEXT.md

Domain glossary for Cortex (AdaptaLabs).
Use these terms exactly in issue titles, test names and proposals - do not drift to synonyms.
Seeded 2026-08-26; extend via `/domain-modeling` when a term gets resolved, not speculatively.

## Terms

- **Opportunity** - a research opportunity a researcher publishes and participants book into.
  Lives at `/opportunities/:id`; authored in OpportunityForm at `/admin/opportunities`.
- **Session** - a bookable time slot belonging to an opportunity.
- **Booking** - a participant's claim on a session.
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
