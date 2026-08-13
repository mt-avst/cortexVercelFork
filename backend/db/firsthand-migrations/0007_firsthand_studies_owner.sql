-- Per-owner authorisation for studies, mirroring opportunities.owner_user_id.
--
-- Without an owner every researcher_admin could rewrite every other admin's
-- study: consent copy and a task step's target_url are attacker-controllable
-- inputs handed to a participant while screen and microphone recording runs.
-- Note this closes STRANGER edits only. Cross-owner reuse is a designed
-- feature, so the owner of a reused study can still change what another
-- owner's published opportunity serves - see the MR description.
--
-- TEXT NULL and no foreign key on purpose. The column holds a Cortex user id
-- (public.users.id, app pool) but this table lives in the firsthand schema on
-- the runtime pool. The two schemas are deliberately uncoupled - the runtime
-- pool's search_path is `firsthand` only, precisely so a runtime query can
-- never resolve against live Cortex tenant data - and a cross-schema FK would
-- reintroduce that coupling at DDL level, breaking any runtime-only database
-- where public does not exist.
-- No index on owner_user_id: every study lookup in studies-repository.ts is by
-- primary key and listStudies orders by updated_at, so nothing would use it.
-- A migration's checksum is frozen once applied, so a speculative index costs
-- another migration to remove.
ALTER TABLE firsthand.studies
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT NULL;

-- Backfill the owner of every study an opportunity already points at. It is a
-- heuristic, not proof of authorship: an inline study is created by whoever
-- edited the opportunity, who is not necessarily the opportunity's owner, and
-- any admin can point an opportunity at any study. It is the best signal
-- available for the rows that matter most - the ones whose deletion would
-- break a published opportunity - and a superadmin can correct a wrong owner
-- through PUT /api/firsthand/studies/:id.
--
-- Guarded on public.opportunities AND its firsthand_study_id column: this
-- runner also has to migrate a runtime-only database carrying the firsthand
-- schema and nothing else, and the column is added late in the app's own
-- migration chain. The whole file runs in one transaction, so an error here
-- would roll back the ADD COLUMN with it.
--
-- Where a study is referenced by more than one opportunity the earliest
-- created one wins, so the result does not depend on scan order.
DO $$
BEGIN
  IF to_regclass('public.opportunities') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'opportunities'
         AND column_name = 'firsthand_study_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'opportunities'
         AND column_name = 'owner_user_id'
     )
  THEN
    EXECUTE $backfill$
      UPDATE firsthand.studies AS s
      SET owner_user_id = owning.owner_user_id
      FROM (
        SELECT DISTINCT ON (o.firsthand_study_id)
               o.firsthand_study_id AS study_id,
               o.owner_user_id
        FROM public.opportunities AS o
        WHERE o.firsthand_study_id IS NOT NULL
          AND o.owner_user_id IS NOT NULL
        ORDER BY o.firsthand_study_id, o.created_at ASC, o.id ASC
      ) AS owning
      WHERE owning.study_id = s.id
        AND s.owner_user_id IS NULL
    $backfill$;
  END IF;
END $$;
