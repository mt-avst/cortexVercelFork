# Database backup strategy

This document describes how database backups are handled for AdaptaLabs (Cortex) and how to verify or enable them.

## Hosting

Cortex runs on the Kubera platform.
The production database is an **AWS RDS PostgreSQL** instance provisioned by the Kubera library chart from `.kubera/playground-backend.yaml` (`database.postgresql.deploymentType: "rds"`, `majorEngineVersion: "17"`, `engineVersion: "17.6"`, `dbFamily: "postgres17"`).
The backend connects via `DB_URL`, which the chart injects into the pod; the connection-string resolver also accepts `DATABASE_URL`/`POSTGRES_URL`/`POSTGRESQL_URL`, but only `DB_URL` is set in this deployment.
There is no Neon or Vercel Postgres in production; those were the retired standalone-Vercel era and no longer apply.

## RDS backups

AWS RDS provides two backup mechanisms:

- **Automated backups** – a daily snapshot plus continuous transaction-log capture, which together enable point-in-time recovery (PITR) within the configured retention window. Automated backups exist only when `backupRetentionPeriod` is greater than 0; a value of 0 disables them entirely.
- **Manual snapshots** – on-demand snapshots taken from the AWS RDS console or CLI. These persist until explicitly deleted and are independent of the retention window.

On instance deletion the chart sets `rds.skipFinalSnapshot: false`, so RDS takes a final snapshot before the instance is removed.
`rds.deletionProtection` is `false`, so the instance is not protected against accidental deletion at the AWS level.

## Retention – MUST be confirmed, not assumed

`.kubera/playground-backend.yaml` does **not** declare `database.postgresql.rds.backupRetentionPeriod`.
Retention is therefore whatever the Kubera library chart defaults it to, which is not visible from this repository.

This is load-bearing and must be verified directly:
during the FirstHand-into-Cortex migration the FirstHand RDS was found to have `backupRetentionPeriod` defaulted to **0** (automated backups effectively off).
Cortex's RDS may inherit the same default.
Do not assume PITR is enabled.

**Action:** confirm the actual retention window in the **AWS RDS console** (or via `aws rds describe-db-instances`) for the Cortex instance.
If `backupRetentionPeriod` is 0, automated backups and PITR are off and should be enabled (set a non-zero retention, e.g. 7 days) by adding `backupRetentionPeriod` under `database.postgresql.rds` in the manifest, or via the AWS console for an existing instance.
This requires AWS RDS access, which lives outside GitLab; note the finding as a fact and decide who holds that access.

## Recovery

RDS restores create a **new** instance (restore-to-point-in-time or restore-from-snapshot); they do not overwrite the running one.
After a restore the new instance's connection details must be wired into the deployment (`DB_URL`) before it serves traffic.

Schema is handled automatically on the next deploy:
the backend's init container runs `npm run migrate && npm run seed && npm run migrate:firsthand` against `DB_URL` on every rollout (see `.kubera/playground-backend.yaml` `initContainer`).
The runners are idempotent and checksum-guarded, so a restored instance is brought up to the current schema by the next deploy with no manual step.
There is no `GET /api/run-migrations` endpoint; that was a retired Vercel-era mechanism.

## Responsibilities and verification

| Item | Responsibility | How to verify |
|------|----------------|---------------|
| Retention configured | Ops / AWS RDS owner | `aws rds describe-db-instances` → `BackupRetentionPeriod` for the Cortex instance; confirm it is non-zero |
| Automated backups on | Ops / AWS RDS owner | AWS RDS console → Maintenance & backups → automated backups present within the retention window |
| Manual snapshot (pre-risky-change) | Whoever runs the change | Take a manual snapshot from the RDS console/CLI before schema or data changes with blast radius |
| Recovery path known | Ops | Confirm the restore-to-point-in-time / restore-from-snapshot flow and that `DB_URL` gets repointed at the restored instance |
| Schema after restore | Deploy pipeline | The next deploy's init container re-runs the migrations (idempotent); no manual migration call |

## References

- [Amazon RDS backups and PITR](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html)
- `.kubera/playground-backend.yaml` – the `database.postgresql` block is the source of truth for the RDS configuration
- [docs/PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) – deploy verification and health checks
