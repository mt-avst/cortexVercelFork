-- Which Cortex opportunity a runtime session was started from.
--
-- This exists to make the survey results routes gateable by OPPORTUNITY
-- ownership, which is the model every neighbouring participant-data surface
-- already uses (session-outputs.ts, GET /api/opportunities/:id/session-events).
-- Those routes aggregate a study's answers across EVERY opportunity that used
-- it, and reusing a study you did not author is a designed feature - so gating
-- on the STUDY's owner would hand a researcher answers from participants
-- another researcher recruited under that researcher's consent wording. Until
-- this column exists the routes can only be superadmin-only, which is where
-- they have been since 7.36.1 as an interim.
--
-- Why not reuse external_ref, which 0005 already added, already indexes, and
-- which the recorded-study-session route already populates with exactly this
-- value. Because external_ref is a CONTRACT field meaning "whatever the caller
-- wants to correlate on": it is part of the session-create input, so any future
-- reopening of an integration path makes it caller-supplied, and gating on it
-- would turn that into a cross-researcher read of participants' answers.
-- created_via cannot rescue it either - the column exists but nothing ever
-- writes it, so every row carries its 'manual' default and no row's provenance
-- can be proved. A separate column with one meaning, written only by the
-- server, is the difference between a correlation hint and an authorisation
-- key.
--
-- NULL for every row that exists today, and deliberately NOT backfilled from
-- external_ref. The rows are almost certainly right, but "almost certainly" is
-- the wrong standard for deciding who may read a participant's answers:
-- migration 0007 backfilled study owners by heuristic and documents that it can
-- be wrong, and mis-attributing an answer is a worse error than mis-attributing
-- a study. A NULL row stays superadmin-only, which is exactly the status quo it
-- already has.
--
-- TEXT with no foreign key, matching owner_user_id in 0007 and for the same
-- reason: opportunities.id lives in public on the app pool, this table lives in
-- firsthand on the runtime pool whose search_path is firsthand only, and a
-- cross-schema FK would reintroduce the coupling that separation exists to
-- prevent.
ALTER TABLE firsthand.runtime_sessions
  ADD COLUMN IF NOT EXISTS opportunity_id TEXT NULL;

COMMENT ON COLUMN firsthand.runtime_sessions.opportunity_id IS
  'Cortex opportunity this session was started from. Server-set only; the authorisation key for per-opportunity results reads. NULL means pre-dating this column, which stays superadmin-only.';

-- Indexed, unlike owner_user_id in 0007, because there IS a query shape that
-- uses it: the per-opportunity results read joins participant_responses to
-- runtime_sessions and filters on this column. Partial, because the NULL rows
-- are never selected by it.
CREATE INDEX IF NOT EXISTS runtime_sessions_opportunity_idx
  ON firsthand.runtime_sessions (opportunity_id)
  WHERE opportunity_id IS NOT NULL;
