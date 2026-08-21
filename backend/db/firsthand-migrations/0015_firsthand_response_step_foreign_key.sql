-- Give a stored answer a real reference to the question it was shown against.
--
-- participant_responses.step_id has been bare TEXT with no constraint since
-- 0001, and that absence is what let POSITIONAL step ids masquerade as
-- identity. Every authoring path minted `${studyId}_step_${index + 1}`, so
-- reordering four questions regenerated exactly the same four ids against
-- different prompts. Every answer already collected moved to whichever question
-- now sat in its place, and nothing surfaced it: there was no dangling
-- reference to detect, because the ids regenerated identically. A researcher
-- read a mean, an NPS or a set of quotes under the wrong prompt with no way to
-- know. 0010's docblock is the fuller account and is worth reading first.
--
-- The application half of the fix is that a question's identity is now minted
-- once, by the client that created it, and travels with it through every edit
-- and reorder (shared/firsthand/step-identity.ts). This is the schema half: a
-- foreign key, so that if any future authoring path forgets the convention, the
-- database refuses the write instead of quietly re-attributing research data.
--
-- That last claim needs the CHECK constraint at the bottom of this file to be
-- true, and the reason is written out under decision 3. A composite foreign key
-- is MATCH SIMPLE by default and stops checking the moment either column is
-- NULL, so without the CHECK a writer that simply omitted study_id could store
-- any step_id at all - and an independent mutation pass proved it: swapping one
-- parameter for another stored every answer permanently detached, with the
-- database raising nothing and all 1,232 tests green.
--
-- THREE deliberate decisions are recorded here rather than left to be inferred.
--
-- 1. EXISTING STUDIES AND STEPS ARE KEPT, and this is a departure from the
--    plan, which said to delete them.
--
--    It turned out to be unnecessary. Every stored step id is already
--    namespaced as `${studyId}_<key>`, and every key that exists - `step_1`,
--    `step_001`, `step_end` - is a legal key under the new scheme. So an
--    existing study upgrades by being read: the authoring form recovers each
--    question's key from the id it already has, sends it back, and the same id
--    is stored again. Nothing is rewritten and nothing has to be.
--
--    Deleting them would have cost something real. Nine opportunities hold a
--    firsthand_study_id, `opportunities` lives in the app schema on a different
--    pool with no foreign key to this one, and this runner cannot reach across
--    to repair them - so the deletion would have stranded nine published
--    opportunities to save work that turned out not to be needed.
--
-- 2. EVERY STORED ANSWER IS DELETED, and the premise for that is CHECKED
--    rather than asserted.
--
--    Every stored answer was written against a positionally-minted step id, so
--    no attribution can be trusted - not because it is known to be wrong, but
--    because nothing recorded which question it was actually shown against,
--    which is the entire defect. Repairing that is not possible from what
--    exists. These are test rows: the whole product is pre-launch, and the plan
--    sanctions dropping them explicitly on those grounds.
--
--    But that argument expires the moment a real participant answers a real
--    question, and a migration cannot know when it will be deployed. Between
--    this being merged and the initContainer running it, somebody could take a
--    real study. So the delete is gated on the cutoff below: every row that
--    existed when this was written is test data by inspection, and a row saved
--    AFTER it was written was created by someone who could not have been
--    consulted about this decision. If one exists, the migration REFUSES and
--    the deploy fails loudly, which is the right way round - a failed deploy is
--    recoverable and a deleted answer is not.
--
--    The count is raised as a NOTICE so the deploy log records what was
--    dropped rather than leaving it to be reconstructed later. The runner
--    listens for notices (backend/scripts/firsthand-migrate.mjs); without that
--    listener node-postgres drops them and this record would not exist.
--
-- 3. ON DELETE SET NULL, not CASCADE.
--
--    A researcher tidying a form must not destroy a participant's answer.
--    CASCADE would do exactly that - silently, on an ordinary edit - which is
--    the bug this migration exists to close, wearing a different hat. SET NULL
--    detaches the answer instead and keeps it readable: step_prompt below
--    records the question as the participant was actually shown it, so the
--    results view can report a removed question's answers under their own
--    prompt rather than dropping them or filing them under someone else's.
--
--    SET NULL over the composite key nulls BOTH columns, which is the plain
--    form supported by every Postgres version rather than the column-list form
--    added in 15. Nothing is lost by it: which study an answer belongs to is
--    carried by its session (runtime_sessions.study_id), which is how every
--    reader in survey-results-repository.ts already scopes these rows.
--
--    ON UPDATE RESTRICT, not CASCADE. A step id is immutable by design - every
--    write path either keeps it or deletes the row - and CASCADE would mean
--    that a future path which renamed one silently dragged every stored answer
--    along with it. That is the F2 defect wearing a third hat, and the foreign
--    key would not object to it. RESTRICT makes that future mistake an error.
--
--    The CHECK below closes the hole a composite foreign key leaves open. A
--    composite FK defaults to MATCH SIMPLE, which skips the check entirely when
--    ANY referencing column is NULL - so a writer that omitted study_id could
--    store any step_id string at all, restoring exactly the unconstrained
--    column this migration exists to end. Requiring the two columns to be NULL
--    together makes "detached" the only legal NULL state, which is precisely
--    what ON DELETE SET NULL produces and what every writer already does.

ALTER TABLE firsthand.participant_responses
  ADD COLUMN IF NOT EXISTS study_id TEXT NULL;

-- The prompt as the PARTICIPANT saw it, written at the same moment as the
-- answer.
--
-- Not derived at deletion time by a trigger, which is the other way to do it.
-- Writing it with the answer needs no hidden machinery, and it records strictly
-- more: it also survives a researcher REWORDING a question after the fact,
-- which changes what an answer means without deleting anything. That second
-- case has a READER - `asked_as` in survey-results.ts reports the wordings an
-- answer set was actually collected under - so the claim is about behaviour
-- rather than about a column nobody consults.
--
-- Nullable because a row can be written before its prompt is known - the
-- session's own step list is the source, and a response naming a step that list
-- does not contain has no prompt to record.
ALTER TABLE firsthand.participant_responses
  ADD COLUMN IF NOT EXISTS step_prompt TEXT NULL;

-- Nullable so that removing a question detaches its answers rather than
-- destroying them. NOT NULL since 0001; every writer still supplies a value.
ALTER TABLE firsthand.participant_responses
  ALTER COLUMN step_id DROP NOT NULL;

DO $$
DECLARE
  -- Every answer that existed when this migration was written was inspected
  -- and is test data. Anything saved after it is not covered by that
  -- inspection, whoever saved it.
  cutoff CONSTANT TIMESTAMPTZ := TIMESTAMPTZ '2026-08-21 00:00:00+00';
  dropped BIGINT;
  newer BIGINT;
BEGIN
  SELECT count(*) INTO dropped
    FROM firsthand.participant_responses WHERE saved_at < cutoff;
  SELECT count(*) INTO newer
    FROM firsthand.participant_responses WHERE saved_at >= cutoff;

  IF newer > 0 THEN
    RAISE EXCEPTION
      'F2: refusing to delete % participant_responses rows because % of them were saved on or after %. The premise for this migration is that no real participant has answered a real question yet, and that is no longer true. Read those rows before deciding what to do with them.',
      dropped, newer, cutoff;
  END IF;

  IF dropped > 0 THEN
    -- SCOPED to the cutoff rather than unconditional, and that is not
    -- redundant with the refusal above. The runner checksums each file and
    -- applies it exactly once, so a replay cannot happen through it - but the
    -- file reads as idempotent everywhere else, and one unscoped DELETE inside
    -- it is a statement whose safety depends on machinery a reader has to go
    -- and check. Scoped, it says what it removes and could be replayed against
    -- a live database without destroying anything, which is the property the
    -- rest of this file already has.
    DELETE FROM firsthand.participant_responses WHERE saved_at < cutoff;
    RAISE NOTICE
      'F2: deleted % participant_responses rows whose step_id was minted positionally and cannot be trusted to identify a question.',
      dropped;
  END IF;
END $$;

-- Indexed on the referencing side. Postgres does not require it, but
-- updateStudy deletes step rows on an ordinary save, and each delete has to
-- find the answers pointing at that step to null them.
CREATE INDEX IF NOT EXISTS participant_responses_step_idx
  ON firsthand.participant_responses (study_id, step_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'participant_responses_step_fkey'
      AND conrelid = 'firsthand.participant_responses'::regclass
  ) THEN
    ALTER TABLE firsthand.participant_responses
      ADD CONSTRAINT participant_responses_step_fkey
      FOREIGN KEY (study_id, step_id)
      REFERENCES firsthand.study_steps (study_id, id)
      ON DELETE SET NULL
      ON UPDATE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'participant_responses_detached_together'
      AND conrelid = 'firsthand.participant_responses'::regclass
  ) THEN
    ALTER TABLE firsthand.participant_responses
      ADD CONSTRAINT participant_responses_detached_together
      CHECK ((study_id IS NULL) = (step_id IS NULL));
  END IF;
END $$;
