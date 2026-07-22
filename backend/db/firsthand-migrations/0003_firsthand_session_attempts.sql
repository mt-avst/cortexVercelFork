ALTER TABLE firsthand.runtime_sessions
  ADD COLUMN IF NOT EXISTS logical_session_id TEXT;

ALTER TABLE firsthand.runtime_sessions
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER;

UPDATE firsthand.runtime_sessions
SET logical_session_id = session_id
WHERE logical_session_id IS NULL;

UPDATE firsthand.runtime_sessions
SET attempt_number = 1
WHERE attempt_number IS NULL;

ALTER TABLE firsthand.runtime_sessions
  ALTER COLUMN logical_session_id SET NOT NULL;

ALTER TABLE firsthand.runtime_sessions
  ALTER COLUMN attempt_number SET NOT NULL;

ALTER TABLE firsthand.runtime_sessions
  ALTER COLUMN attempt_number SET DEFAULT 1;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'firsthand.runtime_sessions'::regclass
      AND conname = 'runtime_sessions_token_key'
  ) THEN
    ALTER TABLE firsthand.runtime_sessions
      DROP CONSTRAINT runtime_sessions_token_key;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS runtime_sessions_logical_attempt_idx
  ON firsthand.runtime_sessions (logical_session_id, attempt_number);

CREATE INDEX IF NOT EXISTS runtime_sessions_logical_latest_idx
  ON firsthand.runtime_sessions (logical_session_id, attempt_number DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS runtime_sessions_token_idx
  ON firsthand.runtime_sessions (token, attempt_number DESC);
