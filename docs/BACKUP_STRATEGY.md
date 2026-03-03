# Database backup strategy

This document describes how database backups are handled for AdaptaLabs (Cortex) and how to verify or enable them.

## Hosting options

The app uses PostgreSQL. In production this is typically:

- **Neon** – serverless Postgres; or
- **Vercel Postgres** – also backed by Neon under the hood.

Connection is via `DATABASE_URL` (or `POSTGRES_URL`) set in Vercel environment variables.

## Neon / Vercel Postgres backups

### Neon

- Neon projects include **point-in-time recovery (PITR)** on paid plans. Check your Neon project dashboard: **Project Settings → Backups** (or equivalent).
- **Retention** depends on plan (e.g. 7 days PITR on Pro). Confirm in the Neon console.
- **Recovery**: Use Neon’s restore flow from the dashboard (restore to a point in time or from a branch).

### Vercel Postgres

- If you use Vercel Postgres, backups are managed by the provider (Neon). See Vercel’s storage docs and the linked Neon project for backup and retention details.
- Enable and verify backups from the Vercel project’s Storage tab or the linked Neon project.

## Pre-flight checklist (confirm and tick when done)

- [ ] **Backups enabled** – Log into [Neon Console](https://console.neon.tech) (or Vercel → Storage → your Postgres). Open the project used by `DATABASE_URL`. In Project Settings, confirm **Backups** or **Point-in-time recovery (PITR)** is enabled for the plan.
- [ ] **Retention noted** – In the same place, note the retention window (e.g. 7 days PITR on Pro). Record it in your runbook or team doc.
- [ ] **Recovery path** – Know how to restore: Neon dashboard → Restore to a point in time or branch. After restore, run `GET https://<your-domain>/api/run-migrations` if schema might differ.

**Current setup (as of 2026-03):** Retention is **6 hours** (Neon Free plan; longer retention incurs cost). To extend the restore window, use **Configure** on the Backup & Restore page or Project Settings → Instant restore; upgrading the Neon plan allows up to 7–30 days depending on tier.

## Responsibilities and verification

| Item | Responsibility | How to verify |
|------|----------------|---------------|
| Backups enabled | Ops / project owner | Neon/Vercel dashboard: confirm backup or PITR is on for the project. |
| Retention | Ops / project owner | Note retention window in Neon/Vercel (e.g. 7 days). |
| Recovery test | Ops (periodic) | Optionally restore to a branch or point-in-time and run a quick smoke check. |
| Migrations after restore | Deploy / script | After any restore, run `GET /api/run-migrations` (or equivalent) if schema might differ. |

## After schema changes

When you change the schema (migrations), ensure production is updated:

1. Deploy the code that includes the new migration(s).
2. Run migrations once: `GET https://<your-domain>/api/run-migrations` (or use a script with `DATABASE_URL`).

Migrations are idempotent; safe to run multiple times.

## References

- [Neon: Branching and backups](https://neon.tech/docs/guides/backup-restore) (check current docs for your plan).
- [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres) – backup behaviour follows the underlying store.
- Project runbook: see [docs/PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) for deploy verification and health checks.
