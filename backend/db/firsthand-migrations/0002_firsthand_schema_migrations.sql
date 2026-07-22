CREATE SCHEMA IF NOT EXISTS firsthand;

CREATE TABLE IF NOT EXISTS firsthand.schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO firsthand.schema_migrations (name, checksum)
VALUES (
  '0001_firsthand_runtime_schema.sql',
  'ad557eb1d8926268b84aca3a2beb73555ea55037b1c9f5dcacbe758b623a4ccf'
)
ON CONFLICT (name) DO NOTHING;
