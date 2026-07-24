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

`.kubera/playground-backend.yaml` declares `rds.skipFinalSnapshot: false`, so on instance deletion RDS should take a final snapshot before the instance is removed. Declared, not confirmed applied, like the two values below.
`rds.deletionProtection` is `true`, so a deletion attempt fails at the AWS level until that flag is first flipped off in the manifest and deployed.
As with retention below, this is the declared value; the applied value cannot be read back from git.

`rds.multiAz` is `true`, which should keep a synchronous standby in a second availability zone and fail over to it automatically.
As with the two values above, that is the declared state; the applied state cannot be read back from git, and a wrong key name would leave the instance single-AZ while this paragraph says otherwise.

**Multi-AZ is not a backup.** It protects against losing an availability zone or an instance; it does not protect against a bad migration, an accidental `DELETE` or corruption, because every write is replicated to the standby immediately. Recovering from those needs the automated backups and PITR described below. The two are complements, not substitutes.
A failover is also not free: expect roughly 60 to 120 seconds of dropped connections while DNS moves to the standby.

**Note on applying a change:** enabling Multi-AZ on an existing single-AZ instance is not a metadata-only flag like `deletionProtection`. RDS snapshots the primary's volumes, restores them into a second AZ and then establishes synchronous replication, so expect elevated write and I/O latency while the standby seeds, over a period proportional to the data volume. The conversion itself is not expected to require downtime, but note the interaction with the failover cost above: with no `applyImmediately` the modification most likely completes in the maintenance window, and completing it can end in a failover. Plan for the 60 to 120 seconds rather than for zero.
No `applyImmediately` is declared anywhere in this repo, so whether a change applies at once or defers to the maintenance window is not knowable from git, which is why the verification below reads `PendingModifiedValues` and `DBInstanceStatus` as well as the live values.

## Retention – declared in the manifest

`.kubera/playground-backend.yaml` declares `database.postgresql.rds.backupRetentionPeriod: 14`, which should give automated backups a **14-day** window with point-in-time recovery across it.

Declared is not the same as applied, and the difference matters here: Helm ignores unrecognised values keys without erroring, so a wrong key name would leave retention on the chart default while this document asserts 14.
Treat the applied value as unconfirmed until someone with AWS RDS read access checks it (see the table below).

This is declared explicitly rather than left to the chart default, on purpose.
During the FirstHand-into-Cortex migration the FirstHand RDS was found to have `backupRetentionPeriod` defaulted to **0** – automated backups and PITR silently off.
Leaving the key unset makes retention an invisible property of the platform's default; declaring it makes it a reviewed line in git that survives re-provisioning.
14 days matches the value FirstHand's own production manifest established.

Change the retention window by editing that key and deploying, not in the AWS console: the chart provisions this instance through Crossplane, so an out-of-band console change drifts from the manifest and is liable to be reconciled away.

Break-glass: in an incident (retention discovered at 0, or the pipeline unavailable) the console is the fast path and should be used. Follow it with a same-day manifest change to reconcile, and expect the console value to be reverted if Crossplane syncs first.

**Note on applying a change:** AWS applies a move between 0 and a non-zero retention *immediately, with a brief instance restart*. Moving between two non-zero values applies without an outage.

Reading the instance's live state (as opposed to its declared state) needs AWS RDS access, which lives outside GitLab. The declared value above is the source of truth for what the platform should be applying.

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
| Retention declared | Anyone with repo access | `database.postgresql.rds.backupRetentionPeriod` is set (currently 14) in `.kubera/playground-backend.yaml` |
| Retention actually applied | AWS RDS owner (access outside GitLab) | `aws rds describe-db-instances` → `BackupRetentionPeriod` matches the declared value |
| Deletion protection declared | Anyone with repo access | `database.postgresql.rds.deletionProtection` is `true` in `.kubera/playground-backend.yaml` |
| Multi-AZ declared | Anyone with repo access | `database.postgresql.rds.multiAz` is `true` in `.kubera/playground-backend.yaml` |
| Deletion protection and Multi-AZ actually applied | AWS RDS owner (access outside GitLab) | Same single read as retention, below; all three come back together |
| Manual snapshot (pre-risky-change) | Whoever runs the change | Take a manual snapshot from the RDS console/CLI before schema or data changes with blast radius |
| Recovery path known | Ops | Confirm the restore-to-point-in-time / restore-from-snapshot flow and that `DB_URL` gets repointed at the restored instance |
| Schema after restore | Deploy pipeline | The next deploy's init container re-runs the migrations (idempotent); no manual migration call |

All three declared RDS attributes resolve in one read:

```bash
aws rds describe-db-instances --db-instance-identifier <id> \
  --query 'DBInstances[0].{Retention:BackupRetentionPeriod,DeletionProtection:DeletionProtection,MultiAZ:MultiAZ,Status:DBInstanceStatus,Pending:PendingModifiedValues}'
```

`PendingModifiedValues` and `DBInstanceStatus` are what make a `false` or stale reading interpretable. There are four states, not two, and only the last one means something is actually wrong:

1. **The attribute is pending** – queued, and it applies now or in the maintenance window depending on `applyImmediately`
2. **`Status: modifying`** – the change is in flight; for a Multi-AZ conversion this is the standby being built
3. **Nothing pending, and the deploy has not reconciled yet** – the value never reached AWS. Budget the 15 to 30 minutes of ArgoCD lag documented in [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) before reading anything into this, and confirm the pipeline has synced first
4. **Nothing pending, `Status: available`, and the deploy has demonstrably reconciled** – only now does a wrong value mean the chart did not recognise the key

State 3 is the easy mistake: read too soon after a merge and it is indistinguishable from state 4, which sends you looking for a broken key name on a control that is simply still in flight.

## References

- [Amazon RDS backups and PITR](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html)
- [Amazon RDS Multi-AZ deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html) – conversion mechanics and failover behaviour behind the claims above
- `.kubera/playground-backend.yaml` – the `database.postgresql` block is the source of truth for the RDS configuration
- [docs/PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) – deploy verification and health checks
