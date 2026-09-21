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
-- string, a bare number. In the survey-session mint route that read sits
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
--     answer and is not: it rejects the `Z`-suffixed millisecond form that
--     `session-create` actually writes ("datetime format is not recognized"),
--     so it would have failed CLOSED on every live session. Measured on
--     postgres 15.19 before this file was written.
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
  -- Narrow on purpose. These are the two SQLSTATEs a bad timestamp literal
  -- raises - `22007 invalid_datetime_format` for text that is not a timestamp
  -- at all, `22008 datetime_field_overflow` for text shaped like one whose
  -- fields are out of range. A bare `WHEN OTHERS` would also swallow a
  -- statement cancellation or an out-of-memory condition and answer "not a
  -- timestamp", turning an infrastructure failure into a silently expired
  -- session.
  WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION firsthand.try_timestamptz(TEXT) IS
  'Casts text to timestamptz, answering NULL rather than raising on a malformed value. Used by the session-expiry read so a corrupt session_payload fails closed (reads as expired) instead of 500ing the mint route.';
