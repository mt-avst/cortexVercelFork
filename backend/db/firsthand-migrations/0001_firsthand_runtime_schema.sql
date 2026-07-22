CREATE SCHEMA IF NOT EXISTS firsthand;

CREATE TABLE IF NOT EXISTS firsthand.runtime_sessions (
  session_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  study_id TEXT NOT NULL,
  study_title TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  participant_display_name TEXT NOT NULL,
  session_status TEXT NOT NULL,
  transcript_status TEXT NOT NULL,
  microphone_permission TEXT NOT NULL,
  screen_permission TEXT NOT NULL,
  recording_status TEXT NOT NULL,
  upload_status TEXT NOT NULL,
  current_step_id TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  transcript JSONB NULL,
  transcript_failure_message TEXT NULL,
  steps JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS runtime_sessions_study_idx
  ON firsthand.runtime_sessions (study_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS firsthand.runtime_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES firsthand.runtime_sessions(session_id) ON DELETE CASCADE,
  step_id TEXT NULL,
  event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  metadata JSONB NULL
);

CREATE INDEX IF NOT EXISTS runtime_events_session_idx
  ON firsthand.runtime_events (session_id, timestamp ASC);

CREATE TABLE IF NOT EXISTS firsthand.participant_responses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES firsthand.runtime_sessions(session_id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_type TEXT NOT NULL,
  response_payload JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS participant_responses_session_idx
  ON firsthand.participant_responses (session_id, saved_at ASC);

CREATE TABLE IF NOT EXISTS firsthand.recording_assets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES firsthand.runtime_sessions(session_id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  duration_seconds DOUBLE PRECISION NULL,
  storage_provider TEXT NOT NULL DEFAULT 'filesystem',
  relative_path TEXT NOT NULL,
  object_url TEXT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS recording_assets_session_idx
  ON firsthand.recording_assets (session_id, uploaded_at ASC);

CREATE TABLE IF NOT EXISTS firsthand.pending_recording_uploads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES firsthand.runtime_sessions(session_id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_provider TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_recording_uploads_valid_until_idx
  ON firsthand.pending_recording_uploads (valid_until ASC);

DO $$
BEGIN
  IF to_regclass('public.runtime_sessions') IS NOT NULL THEN
    INSERT INTO firsthand.runtime_sessions (
      session_id,
      token,
      study_id,
      study_title,
      participant_id,
      participant_display_name,
      session_status,
      transcript_status,
      microphone_permission,
      screen_permission,
      recording_status,
      upload_status,
      current_step_id,
      started_at,
      completed_at,
      transcript,
      transcript_failure_message,
      steps,
      created_at,
      updated_at
    )
    SELECT
      session_id,
      token,
      study_id,
      study_title,
      participant_id,
      participant_display_name,
      session_status,
      transcript_status,
      microphone_permission,
      screen_permission,
      recording_status,
      upload_status,
      current_step_id,
      started_at,
      completed_at,
      transcript,
      transcript_failure_message,
      steps,
      created_at,
      updated_at
    FROM public.runtime_sessions
    ON CONFLICT (session_id) DO NOTHING;
  END IF;

  IF to_regclass('public.runtime_events') IS NOT NULL THEN
    INSERT INTO firsthand.runtime_events (
      id,
      session_id,
      step_id,
      event_type,
      timestamp,
      metadata
    )
    SELECT
      id,
      session_id,
      step_id,
      event_type,
      timestamp,
      metadata
    FROM public.runtime_events
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF to_regclass('public.participant_responses') IS NOT NULL THEN
    INSERT INTO firsthand.participant_responses (
      id,
      session_id,
      step_id,
      step_type,
      response_payload,
      saved_at
    )
    SELECT
      id,
      session_id,
      step_id,
      step_type,
      response_payload,
      saved_at
    FROM public.participant_responses
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF to_regclass('public.recording_assets') IS NOT NULL THEN
    INSERT INTO firsthand.recording_assets (
      id,
      session_id,
      file_name,
      mime_type,
      file_size_bytes,
      duration_seconds,
      storage_provider,
      relative_path,
      object_url,
      uploaded_at
    )
    SELECT
      id,
      session_id,
      file_name,
      mime_type,
      file_size_bytes,
      duration_seconds,
      storage_provider,
      relative_path,
      object_url,
      uploaded_at
    FROM public.recording_assets
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF to_regclass('public.pending_recording_uploads') IS NOT NULL THEN
    INSERT INTO firsthand.pending_recording_uploads (
      id,
      session_id,
      token,
      file_name,
      mime_type,
      storage_provider,
      relative_path,
      created_at,
      valid_until
    )
    SELECT
      id,
      session_id,
      token,
      file_name,
      mime_type,
      storage_provider,
      relative_path,
      created_at,
      valid_until
    FROM public.pending_recording_uploads
    ON CONFLICT (relative_path) DO NOTHING;
  END IF;
END
$$;
