-- Which authoring vocabulary a study is written in.
--
-- There are two, and they are not interchangeable. A 'recorded' study is a
-- first-hand task list: the participant works through tasks while their screen
-- and voice are captured, and answers out loud, so its authorable types are
-- instruction, open_text and single_choice only (authorableStepTypes in
-- shared/firsthand/inline-study.ts). A 'survey' study records nothing and types
-- everything, so it also authors multi_choice, rating and nps
-- (authorableSurveyStepTypes in shared/firsthand/survey-authoring.ts).
--
-- Carried as a column rather than derived from the step types a study happens
-- to contain, for three reasons. listStudies selects no steps, so the reuse
-- picker could not filter on a derived value without an aggregate or an N+1. An
-- instruction-only study is genuinely ambiguous between the two vocabularies,
-- which is the commonest shape a new study passes through. And derivation would
-- make the kind change as a side effect of editing a step, silently
-- reclassifying a study an opportunity is already linked to.
--
-- DEFAULT 'recorded' is a correct backfill rather than a guess: every study
-- that exists when this runs was authored from the recorded vocabulary, because
-- the survey vocabulary does not exist until the release carrying this file.
-- Same reasoning as opportunities.delivery_mode defaulting to 'external'.
--
-- No index. Every study read in studies-repository.ts is by primary key, and
-- listStudies returns every row and orders by updated_at; a filter on two
-- values over a table this size would not use one. A migration's checksum is
-- frozen once applied, so a speculative index costs another migration to
-- remove.
ALTER TABLE firsthand.studies
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'recorded';

COMMENT ON COLUMN firsthand.studies.kind IS
  'Authoring vocabulary: recorded (first-hand task list) or survey (native poll/survey). Set at create and not edited afterwards.';

-- A CHECK rather than an enum type: study_steps.type is TEXT for the same
-- reason, and the real gate is the zod contract above this. The constraint is
-- here to stop a hand-written UPDATE putting a third value in a column that two
-- code paths switch on.
--
-- Guarded because ADD CONSTRAINT has no IF NOT EXISTS. The runner applies each
-- file once, so this only matters when a database has been part-migrated by
-- hand, but an unguarded failure there rolls back the ADD COLUMN with it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'studies_kind_check'
      AND conrelid = 'firsthand.studies'::regclass
  ) THEN
    ALTER TABLE firsthand.studies
      ADD CONSTRAINT studies_kind_check CHECK (kind IN ('recorded', 'survey'));
  END IF;
END $$;
