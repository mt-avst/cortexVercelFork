-- Which consent wording a study runs on, and whether anybody approved it.
--
-- Until this release `firsthand.studies.consent_text` was one free-text column
-- with two hardcoded defaults behind it, and there was no way - at a glance or
-- at all - to tell whether the sentence a participant accepted was the wording
-- the organisation stands behind or something a researcher typed over it. Every
-- study looked identical from the outside. C1 makes consent its own authoring
-- step, locks the approved wording by default, and records the deviation when
-- an author deliberately overrides it. These two columns are where that record
-- lives.
--
-- consent_template_id names a template ('recorded-default', 'survey-default')
-- or the sentinel 'custom'. consent_template_version names which version of
-- that template, and is NULL for 'custom' because custom wording is not a
-- version of anything. The pair is maintained by the repository from the
-- wording itself (`resolveConsentTemplate` in shared/firsthand/
-- consent-templates.ts): a caller may CLAIM a template, and the claim is
-- checked against the text before it is believed. A caller can therefore always
-- understate its approval and can never overstate it.
--
-- BOTH COLUMNS ARE NULLABLE, and that is the whole point of this migration
-- rather than a `NOT NULL DEFAULT 'default'` one-liner.
--
-- A default would stamp every existing row - including the copies migration
-- 0012 minted by SELECT-copying `consent_text` verbatim from a source study -
-- with an id saying "this is the approved wording" without anything having
-- looked at the wording. For rows whose text a researcher had already rewritten
-- that is not an incomplete record, it is a FALSE one, and a false claim of
-- approval is precisely the failure this feature exists to prevent. So the
-- columns arrive empty and the backfill below fills them in by reading the
-- text. NULL survives as the honest value for a row nothing could classify, and
-- the application treats NULL as unapproved (`isCustomConsentTemplate`), which
-- is the safe direction to fail in.
--
-- No index. Nothing filters or joins on either column: they are read as part of
-- a row already fetched by primary key, and the study list returns every row
-- unfiltered. A migration's checksum is frozen once applied, so a speculative
-- index costs another migration to remove - the same reasoning 0009 and 0012
-- both record.
ALTER TABLE firsthand.studies
  ADD COLUMN IF NOT EXISTS consent_template_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS consent_template_version INTEGER NULL;

-- The pair has exactly three legal shapes, and the constraint says so rather
-- than leaving it to every write path to remember:
--   * both NULL          - provenance unknown; read as unapproved
--   * 'custom' + NULL    - deliberately overridden wording
--   * a template + an integer version
--
-- A version without a template, or a template without a version, would be a row
-- that cannot answer the only question these columns exist to answer. Naming
-- 'custom' in the constraint is deliberate: it is a sentinel, not a template, so
-- there is no version of it to record and permitting one would invite a write
-- path to invent a meaning for it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'studies_consent_template_shape'
      AND conrelid = 'firsthand.studies'::regclass
  ) THEN
    ALTER TABLE firsthand.studies
      ADD CONSTRAINT studies_consent_template_shape CHECK (
        (consent_template_id IS NULL AND consent_template_version IS NULL)
        OR (consent_template_id = 'custom' AND consent_template_version IS NULL)
        OR (consent_template_id <> 'custom' AND consent_template_version IS NOT NULL)
      );
  END IF;
END $$;

-- Backfill: classify every existing row by reading its wording.
--
-- The two literals below are version 1 of the two templates, embedded verbatim
-- because SQL cannot import TypeScript. They are pinned against
-- DEFAULT_CONSENT_TEXT and DEFAULT_SURVEY_CONSENT_TEXT by
-- backend/src/firsthand/consent-templates.test.ts, so editing a shipped
-- version's wording in the TypeScript - which is a version bump, not an edit -
-- cannot pass silently and leave this file describing wording that no longer
-- exists.
--
-- Matching is on `btrim` alone, for the same reason `consentTextMatches` trims
-- and does nothing else: a trailing newline picked up from a textarea is not a
-- deviation from approved wording, but a changed word is. Nothing else is
-- normalised, because collapsing whitespace here and not in the application
-- would make the two disagree about the same row.
--
-- A row's KIND decides which template it is measured against. A recorded study
-- carrying the survey wording is `custom`, not `survey-default`: that wording's
-- central claim - "Nothing is recorded" - would be false about it, and recording
-- it as approved would be worse than recording nothing at all.
--
-- This runs over the WHOLE table, which is what makes it correct for the rows
-- migration 0012 created. Those rows copy `consent_text` byte-for-byte from
-- their source, so they classify exactly as their source does, which is the
-- right answer: a verbatim copy of approved wording is approved wording, and a
-- verbatim copy of somebody's override is still an override. They are not
-- distinguishable by `copied_from_study_id` in any case - B3's picker sets the
-- same column - and 0012 is not guaranteed to have produced any: it returns
-- early on three schema guards and swallows insufficient_privilege.
UPDATE firsthand.studies
SET
  consent_template_id = CASE
    WHEN kind = 'survey'
      AND btrim(consent_text) = btrim('Your answers are stored for research analysis and are visible to the research team. Nothing is recorded: no screen, no microphone and no camera. You can close the page at any point, and anything you have already answered is kept.')
      THEN 'survey-default'
    WHEN kind <> 'survey'
      AND btrim(consent_text) = btrim('This session records your screen and microphone while you complete the tasks. The recording is used for research analysis and is visible to the research team. You can end the recording whenever you want by stopping the screen share, and anything recorded up to that point is still sent to the research team.')
      THEN 'recorded-default'
    ELSE 'custom'
  END,
  consent_template_version = CASE
    WHEN kind = 'survey'
      AND btrim(consent_text) = btrim('Your answers are stored for research analysis and are visible to the research team. Nothing is recorded: no screen, no microphone and no camera. You can close the page at any point, and anything you have already answered is kept.')
      THEN 1
    WHEN kind <> 'survey'
      AND btrim(consent_text) = btrim('This session records your screen and microphone while you complete the tasks. The recording is used for research analysis and is visible to the research team. You can end the recording whenever you want by stopping the screen share, and anything recorded up to that point is still sent to the research team.')
      THEN 1
    ELSE NULL
  END
WHERE consent_template_id IS NULL;

DO $$
DECLARE
  approved INTEGER;
  overridden INTEGER;
BEGIN
  SELECT
    count(*) FILTER (WHERE consent_template_id <> 'custom'),
    count(*) FILTER (WHERE consent_template_id = 'custom')
  INTO approved, overridden
  FROM firsthand.studies;

  RAISE NOTICE '[0013] consent classification: % study row(s) on an approved template, % on custom wording.', approved, overridden;
END $$;
