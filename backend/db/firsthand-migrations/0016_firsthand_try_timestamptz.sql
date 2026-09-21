-- A text-to-timestamptz cast that answers NULL instead of raising.
--
-- `findParticipantSessionForOpportunity` decides whether a participant's
-- session is still live by casting the value out of the session payload:
--
--   (session_payload->'session'->>'expires_at')::timestamptz > NOW()
--
-- The PAYLOAD rather than the `runtime_sessions.expires_at` COLUMN, for the
-- reasons that function's docblock sets out, and compared against the DATABASE
-- clock so no app-server drift can move the boundary. Both of those are right
-- and neither is what this file changes.
--
-- What it changes is what a CORRUPT value does (cto/AdaptaLabs#129, LOW-5).
-- The column is `jsonb`, so `->>` will hand back whatever text is stored and
-- the cast raises on anything that is not a timestamp - "not-a-date", an empty
-- string, a bare number, an out-of-range time zone displacement, a time zone
-- name nobody has heard of. In the survey-session mint route that read sits
-- outside any try/catch, so one malformed payload turned a participant's
-- ordinary resume into a 500; in the participant detail read it was caught and
-- degraded, so the same row produced two different answers depending on which
-- route asked. Neither is the fail-closed behaviour the rest of the expiry
-- logic is built on: `session-store.ts` refuses a payload with no stated
-- lifetime rather than honouring it, and a payload whose stated lifetime
-- cannot be read is the same kind of fact.
--
-- WHY A FUNCTION rather than a guard written into the query.
--
--   - `pg_input_is_valid(text, 'timestamptz')` is exactly this and is the
--     obvious answer, but it is PostgreSQL 16+. CI and production are 17, and
--     the documented local recipe in AGENTS.md is a postgres:15 container, so
--     using it would make the query work on the gate and raise 42883 on a
--     developer's machine - a version dependency nothing in the query would
--     explain.
--   - A regex guard before the cast cannot be complete. Constraining the
--     digit ranges still admits `2026-02-31T00:00:00.000Z`, which matches any
--     shape test and raises "date/time field value out of range" on the cast.
--   - jsonpath's `.datetime()` with `silent => true` looked like a portable
--     answer and is not - but NOT for the reason first written here, and the
--     real reason is worse (cto/AdaptaLabs#129, LOW-5 of the review pass).
--     The first version of this comment said it rejects the `Z`-suffixed
--     millisecond form `session-create` writes, so it would have failed
--     CLOSED on every live session. That is true on ONE of the two versions
--     we run and false on the other. Re-measured directly, same statement,
--     `jsonb_path_query_first('"2026-09-21T10:00:00.000Z"'::jsonb,
--     '$.datetime()', silent => true)`:
--
--       postgres 15.19 -> NULL (non-silent: `22031 datetime format is not
--                         recognized`)
--       postgres 17.11 -> "2026-09-21T10:00:00+00:00", and note the
--                         milliseconds are gone
--
--     So it would have failed closed on every live session LOCALLY, on the
--     postgres:15 container AGENTS.md documents, and passed in CI and
--     production on 17 - a fail-closed expiry check that is only fail-closed
--     on a developer's machine. That is a stronger reason to refuse it than
--     the one it replaces, and the wrong-version measurement is the point:
--     anyone re-measuring this on production's 17 would have found the
--     original claim simply untrue and drawn the opposite conclusion.
--
-- So: one named seam, complete on every version we run, and testable on its
-- own rather than only through the query that uses it.
--
-- STABLE, not IMMUTABLE. Casting text to `timestamptz` reads the session's
-- `TimeZone` setting, and the input text may be a relative literal such as
-- `now`, so the result is not fixed for a fixed argument. STRICT so a NULL in
-- is a NULL out without entering the block at all, which is the common case:
-- a payload that predates the field has no `expires_at` and the caller already
-- treats that as expired.
--
-- EDITED IN PLACE after its first version, rather than added to by an 0017.
-- The runner checksums every migration and refuses one whose bytes changed
-- since it was applied (`firsthand-migrate.mjs`), so editing an applied file
-- is normally forbidden. This one has never been applied anywhere long-lived:
-- it is new on the branch that introduces it and has not reached the
-- playground, CI's throwaway database or production. The only databases
-- holding the first version are local dev ones belonging to whoever ran the
-- branch, and the recovery there is one statement:
--
--   DELETE FROM firsthand.schema_migrations
--    WHERE name = '0016_firsthand_try_timestamptz.sql';
--
-- then `npm run migrate:firsthand` again. `CREATE OR REPLACE FUNCTION` makes
-- the re-run idempotent. Once this lands, treat the file as frozen.
--
-- The EXCEPTION block opens a subtransaction per call. That is the documented
-- cost of catching in PL/pgSQL and it is paid once per query here - both
-- callers read a single row under `LIMIT 1` - so it is not on any hot path.
-- Do not reach for this function inside a scan over many rows without
-- measuring it first.
CREATE OR REPLACE FUNCTION firsthand.try_timestamptz(value TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
STRICT
AS $$
BEGIN
  RETURN value::TIMESTAMPTZ;
EXCEPTION
  -- FOUR, NOT TWO, and the first version of this list said two (LOW-5 of the
  -- review pass on cto/AdaptaLabs#129). It claimed 22007 and 22008 were "the
  -- two SQLSTATEs a bad timestamp literal raises". They are not. Fuzzed over
  -- 55 inputs against BOTH versions we run - postgres 15.19, the container
  -- AGENTS.md documents, and postgres 17.11 - a bare `text::timestamptz`
  -- raises four, identically on both:
  --
  --   22007 invalid_datetime_format       'not-a-date', '', '12345'
  --   22008 datetime_field_overflow       '2026-02-31T00:00:00.000Z'
  --   22009 invalid_time_zone_displacement_value
  --                                       '2026-09-21T10:00:00.000+99:00'
  --   22023 invalid_parameter_value       '2026-09-21T10:00:00 Nowhere/Land'
  --
  -- With only the first two caught, those last two inputs still raised, which
  -- is the exact 500 on the mint route this file exists to remove - measured
  -- as `expected 200, got 500` by adding them to the it.each in
  -- mint-refuses-a-closed-study-postgres.test.ts before this line changed.
  --
  -- WHY 22023 IS SAFE TO CATCH HERE, though its name is broad enough to look
  -- alarming. `invalid_parameter_value` covers a lot of Postgres; it does not
  -- cover a lot of THIS function. The body is one cast of one argument, so
  -- the only code that can raise inside the block is the timestamptz input
  -- parser, and the only 22023 that parser produces is an unrecognised time
  -- zone NAME. Checked rather than assumed: a second sweep over zone-shaped
  -- junk ('Europe/Atlantis', 'Mars/Olympus', 'America/Not_A_City', a
  -- 200-character zone, 'Etc/GMT+99') returned exactly one 22023 message on
  -- both versions, `time zone "..." not recognized`; everything else came
  -- back as 22007, 22008, 22009 or a valid timestamp.
  --
  -- What a bare `WHEN OTHERS` would additionally swallow is the reason this
  -- list is still a list: a statement cancellation (57014), an out-of-memory
  -- (53200), a disk-full (53100), a lost connection (08006). None of those is
  -- in class 22, so none of them can arrive here disguised as "not a
  -- timestamp" and turn an infrastructure failure into a silently expired
  -- session.
  WHEN invalid_datetime_format
    OR datetime_field_overflow
    OR invalid_time_zone_displacement_value
    OR invalid_parameter_value THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION firsthand.try_timestamptz(TEXT) IS
  'Casts text to timestamptz, answering NULL rather than raising on a malformed value. Used by the session-expiry read so a corrupt session_payload fails closed (reads as expired) instead of 500ing the mint route.';
