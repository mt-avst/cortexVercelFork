ALTER TABLE firsthand.runtime_sessions
  ADD COLUMN IF NOT EXISTS callback_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS return_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS external_ref TEXT NULL,
  ADD COLUMN IF NOT EXISTS participant_email TEXT NULL,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS session_payload JSONB NULL;

CREATE INDEX IF NOT EXISTS runtime_sessions_external_ref_idx
  ON firsthand.runtime_sessions (external_ref)
  WHERE external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS runtime_sessions_token_lookup_idx
  ON firsthand.runtime_sessions (token, expires_at);
