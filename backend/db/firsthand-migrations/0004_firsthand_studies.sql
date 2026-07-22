CREATE TABLE IF NOT EXISTS firsthand.studies (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  intro_text TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  brand_name TEXT NULL,
  estimated_duration_minutes INTEGER NULL,
  locale TEXT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS studies_status_idx
  ON firsthand.studies (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS firsthand.study_steps (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES firsthand.studies(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  target_url TEXT NULL,
  helper_text TEXT NULL,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  options JSONB NULL,
  UNIQUE (study_id, step_order)
);

CREATE INDEX IF NOT EXISTS study_steps_study_idx
  ON firsthand.study_steps (study_id, step_order ASC);
