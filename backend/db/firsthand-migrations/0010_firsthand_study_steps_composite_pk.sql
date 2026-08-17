-- Scope a step's id to its study.
--
-- study_steps.id has been a GLOBAL TEXT PRIMARY KEY since 0004, while every
-- authoring path writes an id derived from the step's position in its own list.
-- Two studies both wanting `step_1` therefore collide, and the unique violation
-- surfaces as a misleading 409 about the OPPORTUNITY rather than about the
-- step - which is how it was found, twice: once on the inline authoring path
-- and once in the hand-authored editor, each time after the feature had
-- appeared to work exactly once per environment.
--
-- Both fixes were client-side namespacing (`${studyId}_step_${n}`), and both
-- are still in place. This is the schema-level fix that makes them unnecessary
-- for correctness: a third authoring path - an importer, a template, a
-- duplicate-task-list button, or the survey builder this release adds - can no
-- longer reintroduce the collision by forgetting a convention it has no way to
-- discover.
--
-- Free to do, and that was checked rather than assumed: NOTHING has a foreign
-- key to study_steps.id (every migration was read), and every read and write of
-- the table in studies-repository.ts is already scoped by study_id -
-- loadStudyWithSteps selects WHERE study_id = $1, updateStudy deletes WHERE
-- study_id = $1, insertStudySteps supplies it. participant_responses.step_id is
-- a plain TEXT column with no constraint, and every read of it is scoped by
-- session_id. So this is a constraint swap with no data rewrite: ids that are
-- unique globally today are trivially unique per study.
--
-- The namespacing stays regardless. De-namespacing would make
-- participant_responses.step_id values indistinguishable across studies without
-- their session context - fine for today's session-scoped reads, a footgun for
-- any future cross-session analytics.
--
-- UNIQUE (study_id, step_order) from 0004 is untouched and still needed: it
-- stops two steps in one study claiming the same position, which the primary
-- key says nothing about.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'study_steps_pkey'
      AND conrelid = 'firsthand.study_steps'::regclass
  ) AND NOT EXISTS (
    -- Already swapped: the primary key is over two columns rather than one.
    SELECT 1 FROM pg_constraint
    WHERE conname = 'study_steps_pkey'
      AND conrelid = 'firsthand.study_steps'::regclass
      AND cardinality(conkey) = 2
  ) THEN
    ALTER TABLE firsthand.study_steps DROP CONSTRAINT study_steps_pkey;
    ALTER TABLE firsthand.study_steps ADD PRIMARY KEY (study_id, id);
  END IF;
END $$;
