-- Where a study's content came from, and the end of reuse-by-link.
--
-- Until this release an opportunity could REUSE another opportunity's study by
-- pointing opportunities.firsthand_study_id at it. That is a live link, many
-- opportunities to one study, and it is the most dangerous of the three things
-- "reuse" could have meant: editing the study changes what participants are
-- served by every other opportunity pointing at it, silently, with no version,
-- no approval and no notification. B3 replaces it with a COPY taken at the
-- moment of choosing, so the two authors' content diverges from that point and
-- neither can alter the other's.
--
-- copied_from_study_id is the record of that choice. It is authoring
-- provenance, not an authorisation key and not a constraint: it answers "where
-- did these questions come from" for a researcher looking at a study six months
-- later, and it is what lets the form say "Copied from X, later changes to the
-- original will not affect this opportunity" instead of leaving the copy's
-- origin undiscoverable.
--
-- Deliberately NO foreign key, even though - unlike owner_user_id in 0007 and
-- opportunity_id in 0011 - a reference to firsthand.studies(id) would be
-- same-schema and legal here. Three reasons, and the decision is stated rather
-- than defaulted:
--   * A copy must survive its source being deleted. An FK would force a
--     choice between ON DELETE CASCADE (deleting a source silently deletes
--     every copy - catastrophic) and ON DELETE SET NULL (deleting a source
--     silently erases the provenance of every copy - quietly wrong). Keeping a
--     dangling id is the honest third option: the record says where the
--     content came from, and a reader that cannot resolve it says so.
--   * Provenance is a historical fact about an event that already happened.
--     Referential integrity models a relationship that must still hold.
--   * The value is written once at create and never updated, so there is no
--     write path an FK would be protecting.
--
-- No index. Nothing filters or joins on this column: it is read only as part of
-- the row that already had to be fetched by primary key, and the study list
-- returns every row unfiltered. A migration's checksum is frozen once applied,
-- so a speculative index costs another migration to remove it - the same
-- reasoning 0009 records for `kind`.
ALTER TABLE firsthand.studies
  ADD COLUMN IF NOT EXISTS copied_from_study_id TEXT NULL;

COMMENT ON COLUMN firsthand.studies.copied_from_study_id IS
  'The study whose content was copied to create this one. Authoring provenance only - never an authorisation key. Written once at create; NULL means authored from blank or predating copy. No foreign key: a copy outlives its source, and a dangling id is a truer record than a cascade or a silent NULL.';

-- ---------------------------------------------------------------------------
-- Convert the rows that reuse-by-link already created.
--
-- What actually stops a NEW one, going forward: the picker offers copy-only,
-- and `POST`/`PATCH /api/opportunities` refuse to link `firsthand_study_id`
-- at a study this caller does not own (`assertLinkedStudyKindMatches`,
-- backend/src/routes/opportunities.ts) - a
-- hand-crafted call bypasses any amount of UI filtering, so the picker alone
-- was never the boundary. This sentence used to credit the picker alone,
-- which was only ever true of the UI; corrected here rather than left to
-- mislead the next reader, given this file cannot be amended once applied.
-- Neither mechanism stops an owner fan-out linking the SAME study to several
-- of their OWN opportunities - that is still a designed feature, and it is
-- exactly the shape this migration leaves the PRIMARY referrer holding.
--
-- The rows that already share a study across DIFFERENT owners would otherwise
-- be stranded in a state the product no longer has a way to reach or explain:
-- the sharing guard in opportunities.ts would refuse to save either
-- opportunity's content, so both authors would find their questions permanently
-- read-only with no control that could fix it.
--
-- So each sharing opportunity gets its own copy of the study, exactly as the
-- new picker would have produced, and its firsthand_study_id is repointed at
-- it. Nothing is deleted and no content is rewritten - the source study is left
-- byte-unchanged, and the opportunity that keeps it is chosen deliberately (see
-- below) rather than arbitrarily.
--
-- This reads public.opportunities, which no other firsthand migration does
-- except 0007, whose owner backfill did exactly the same thing for the same
-- reason. That is a ONE-TIME read, not a structural coupling: no constraint,
-- view or trigger survives this file, so the separation 0011's comment defends
-- - firsthand objects never depending on public - still holds afterwards. The
-- guard below exists because the runner can legitimately be pointed at a
-- database where the app schema has not been created yet (a firsthand-only test
-- database, or a deploy ordering change), and a missing table must be a skip
-- rather than a CrashLooping init container.
--
-- Which opportunity keeps the original: the one whose owner authored it, so the
-- study stays with its author and stays editable by them. Failing that (an
-- unowned legacy study, or an owner who owns none of the opportunities), the
-- earliest-created opportunity, tie-broken by id so the choice is deterministic
-- and a re-run on a restored backup makes the same one.
--
-- Fan-out is not the only shape of a link. An opportunity that is the SOLE
-- referrer of a study owned by somebody else is linked just as surely - it is
-- the "reuse a colleague's task list" case the admin guide documented - and it
-- is the one that reads as a bug rather than as a policy: can_edit comes back
-- false, the authoring surface goes read-only, and after this release there is
-- no control anywhere that could give the author an editable version. So the
-- rule is ownership, not just fan-out: an opportunity keeps its study when it
-- is the primary referrer AND the study is either unowned or owned by that
-- opportunity's owner. Every other referrer gets a copy owned by the
-- opportunity's own owner, which is precisely what the new picker would have
-- produced had it existed when the link was made.
--
-- An unowned study is deliberately NOT copied: claimStudyIfUnowned already
-- gives it to the first opportunity that writes to it, so there is no
-- cross-owner edit to prevent and a copy would only duplicate a row nobody
-- disputes.
--
-- A source left with no referrer is not deleted. It was authored somewhere -
-- the Task Lists area - and it still belongs to whoever wrote it; deleting
-- another researcher's work to tidy up a foreign key would be the one
-- destructive thing in this file.
--
-- What a copy carries: every authored column, the step rows with their step ids
-- UNCHANGED (the primary key has been (study_id, id) since 0010, so ids need
-- not be re-derived, and preserving them keeps participant_responses.step_id
-- resolvable against the copy), and the runtime sessions that belong to the
-- moved opportunity. Those sessions are moved because
-- GET /api/opportunities/:id/survey-results filters on study_id AND
-- opportunity_id together: leaving them behind would make an opportunity's
-- already-collected answers invisible on its own Responses tab. Their answers
-- in participant_responses are scoped by session_id and need no change.
--
-- created_at on a copy is NOW(), not the source's: the copy is a new study
-- created by this migration, and claiming the source's creation date would
-- misdate it.
--
-- A consequence this file cannot avoid and must state plainly, since it
-- cannot be amended once applied: moving a session's runtime_sessions row is
-- right for GET /api/opportunities/:id/survey-results, which filters on
-- study_id AND opportunity_id together (see above) - but
-- GET /api/firsthand/studies/:studyId/results and its .csv twin
-- (backend/src/routes/firsthand.ts, backend/src/firsthand/
-- survey-results-repository.ts) filter on study_id ALONE. So a superadmin
-- exporting the SOURCE study directly, after this migration runs, sees fewer
-- respondents than before for exactly the sessions this file moved to a copy -
-- they now appear only under the copy's own study_id export instead. No
-- answer is lost or duplicated; participant_responses is scoped by
-- session_id and untouched. But nothing else records where they went, so
-- stating it here is the only trace.
DO $$
DECLARE
  src RECORD;
  extra RECORD;
  new_study_id TEXT;
  converted INTEGER := 0;
BEGIN
  IF to_regclass('public.opportunities') IS NULL THEN
    RAISE NOTICE '[0012] public.opportunities not present - skipping the reuse-to-copy conversion.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'opportunities'
      AND column_name = 'firsthand_study_id'
  ) THEN
    RAISE NOTICE '[0012] opportunities.firsthand_study_id not present - skipping the reuse-to-copy conversion.';
    RETURN;
  END IF;

  -- The guard 0007 has and this file lacked: the query below reads
  -- o.owner_user_id (the ranking that decides which referrer keeps the
  -- original) as well as firsthand_study_id, and this is the first firsthand
  -- migration to WRITE to the app schema, so an unguarded read of a
  -- differently-shaped public.opportunities would abort the whole file - the
  -- runner wraps each migration in one transaction, so the ADD COLUMN above
  -- rolls back with it and the deploy initContainer CrashLoops.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'opportunities'
      AND column_name = 'owner_user_id'
  ) THEN
    RAISE NOTICE '[0012] opportunities.owner_user_id not present - skipping the reuse-to-copy conversion.';
    RETURN;
  END IF;

  -- This whole conversion is nested in its own BEGIN/EXCEPTION block - an
  -- implicit savepoint - rather than left to the outer transaction. This is
  -- the first firsthand migration to WRITE to the app schema (0007 only
  -- reads it), and a role with SELECT but not INSERT/UPDATE on
  -- public.opportunities - a plausible, narrower grant than 0007 needed - hits
  -- insufficient_privilege here. Without the nested block that error aborts
  -- the whole transaction, taking the ADD COLUMN above down with it, for a
  -- conversion that legacy rows can live without a little longer. Only
  -- insufficient_privilege is caught: any other error still aborts the file,
  -- exactly as before.
  BEGIN
  FOR src IN
    SELECT s.id AS study_id, s.owner_user_id
    FROM firsthand.studies s
    WHERE EXISTS (
      SELECT 1 FROM public.opportunities o
      WHERE o.firsthand_study_id = s.id
    )
  LOOP
    FOR extra IN
      SELECT ranked.id, ranked.owner_user_id
      FROM (
        SELECT
          o.id,
          o.owner_user_id,
          ROW_NUMBER() OVER (
            ORDER BY
              -- The author's own opportunity keeps the original.
              (src.owner_user_id IS NOT NULL
                AND o.owner_user_id::text = src.owner_user_id) DESC,
              o.created_at ASC,
              o.id ASC
          ) AS referrer_rank
        FROM public.opportunities o
        WHERE o.firsthand_study_id = src.study_id
      ) ranked
      WHERE
        -- Every referrer after the primary one is a fan-out and gets a copy.
        ranked.referrer_rank > 1
        -- The primary referrer keeps the study only when it is not somebody
        -- else's. An unowned study needs no copy: it is claimed on first write.
        OR (
          src.owner_user_id IS NOT NULL
          AND ranked.owner_user_id::text IS DISTINCT FROM src.owner_user_id
        )
    LOOP
      new_study_id := 'study_' || gen_random_uuid();

      INSERT INTO firsthand.studies (
        id, title, intro_text, consent_text, brand_name,
        estimated_duration_minutes, locale, status, kind, owner_user_id,
        created_at, updated_at, copied_from_study_id
      )
      SELECT
        new_study_id, s.title, s.intro_text, s.consent_text, s.brand_name,
        s.estimated_duration_minutes, s.locale, s.status, s.kind,
        extra.owner_user_id::text,
        NOW(), NOW(), s.id
      FROM firsthand.studies s
      WHERE s.id = src.study_id;

      INSERT INTO firsthand.study_steps (
        id, study_id, step_order, type, prompt, target_url,
        helper_text, is_required, options, config
      )
      SELECT
        st.id, new_study_id, st.step_order, st.type, st.prompt, st.target_url,
        st.helper_text, st.is_required, st.options, st.config
      FROM firsthand.study_steps st
      WHERE st.study_id = src.study_id;

      UPDATE firsthand.runtime_sessions
      SET study_id = new_study_id
      WHERE opportunity_id = extra.id::text
        AND study_id = src.study_id;

      UPDATE public.opportunities
      SET firsthand_study_id = new_study_id
      WHERE id = extra.id;

      converted := converted + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE '[0012] reuse-to-copy conversion: % opportunity row(s) given their own copy of a study.', converted;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[0012] insufficient privilege to run the reuse-to-copy conversion - skipping it. The copied_from_study_id column above still applies regardless.';
  END;
END $$;
