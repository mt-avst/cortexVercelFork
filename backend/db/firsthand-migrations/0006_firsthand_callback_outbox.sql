CREATE TABLE IF NOT EXISTS firsthand.callback_outbox (
  delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  callback_url TEXT NOT NULL,
  body TEXT NOT NULL,
  event TEXT NOT NULL,
  logical_session_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT NULL,
  delivered_at TIMESTAMPTZ NULL,
  abandoned_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS callback_outbox_due_idx
  ON firsthand.callback_outbox (next_attempt_at)
  WHERE delivered_at IS NULL AND abandoned_at IS NULL;
