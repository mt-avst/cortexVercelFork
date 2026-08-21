-- Who last wrote a study, so a lost race has a name attached to it somewhere.
--
-- F1 adds an optimistic-concurrency precondition to study writes: the client
-- sends back the `updated_at` it loaded, and a write whose precondition no
-- longer matches is refused with 409 instead of silently overwriting whatever
-- landed in between. That closes the data loss. It does not, on its own, answer
-- the question the loser of the race actually asks - "who changed it?" - because
-- `updated_at` records only WHEN.
--
-- This column records WHO. It is set on every write that goes through
-- `createStudy` or `updateStudy` (backend/src/firsthand/studies-repository.ts),
-- from the authenticated requester, never from a request body: a client-supplied
-- editor id would let an author attribute their own edit to somebody else, which
-- is worse than recording nothing.
--
-- NULLABLE, with no backfill and no default, deliberately.
--
-- Every row that exists when this runs was written before anything recorded an
-- editor, and there is no source of truth for who wrote it. `owner_user_id` is
-- the nearest thing and it is NOT the answer: the owner is who the study belongs
-- to, and the whole reason F1 exists is that somebody OTHER than the owner can
-- have been the last person to write it. Stamping the owner into this column
-- would manufacture a fact - the same objection 0013 records against a
-- `NOT NULL DEFAULT` on the consent classification, and for the same reason.
-- NULL is the honest value for "nobody recorded it", and every read path treats
-- it as unknown rather than as anyone in particular.
--
-- TEXT, not UUID, and no foreign key - matching `owner_user_id` as 0007
-- declared it. `public.users` lives in the app schema behind a different
-- connection pool; firsthand objects deliberately do not depend on public ones
-- (see 0011's comment, and 0012's one-time read for the exception that proves
-- it). A user id is stored as an opaque string here and resolved, if ever, by
-- the application.
--
-- No index. Nothing filters, joins or orders on this column: it is read only as
-- part of a row already fetched by primary key. A migration's checksum is frozen
-- once applied, so a speculative index costs another migration to remove - the
-- same reasoning 0009, 0012 and 0013 each record.
ALTER TABLE firsthand.studies
  ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT NULL;

COMMENT ON COLUMN firsthand.studies.updated_by_user_id IS
  'The authenticated user who last wrote this row, taken from the session and never from a request body. NULL means the write predates this column or had no user context (a script or a fixture). Not an authorisation key and not an owner - see owner_user_id for that.';
