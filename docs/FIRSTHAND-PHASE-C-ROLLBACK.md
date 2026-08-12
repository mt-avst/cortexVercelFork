# FirstHand Phase C cutover record

Status: CLOSED 2026-08-12.
Rollback is no longer possible - the FirstHand source RDS was decommissioned (FirstHand repo MR !2; deletion completed manually by internal engineering on 2026-08-12 after the automated destroy wedged - see below).
Final snapshot: `arn:aws:rds:us-east-1:270148732964:snapshot:firsthand-snapshot`.
Snapshot recovery is NOT self-service - restoring from it requires internal engineering (per Nigel Alvares, 2026-08-12).
Retained as the migration's verification and provenance record; the rollback procedure this file used to describe was a git revert of the cutover commit and is struck as unusable.

## What was cut over

On 2026-07-22 the FirstHand runtime data (schema `firsthand`: studies, steps, sessions, events, responses, recording-asset metadata) was copied from FirstHand's standalone RDS into Cortex's own RDS and verified three ways (migration-ledger row-for-row, per-table counts, JSONB md5 spot-checks).
On 2026-07-23 at 01:26 UTC the cutover deployed: `getRuntimeDatabaseUrl()` no longer reads `FIRSTHAND_DATABASE_URL`, so the firsthand runtime pool resolves to this deployment's own RDS (`DB_URL`), where the migrated copy lives.
Recordings themselves never moved: the `firsthand-playground` S3 bucket is unchanged and is reached via the backend's IRSA grant.

## How the window closed

The retention window closed on 2026-07-25.
The source RDS deletion merged as FirstHand repo MR !2 (commit `21a3a70d`) and deployed on 2026-08-11 after a group-level Nexus credential fix; the kubera-playground job log confirmed ArgoCD `prune: true`, which removes the RDS Workspace so Crossplane runs the destroy with `skipFinalSnapshot: false`.
The automated destroy then WEDGED for ~15 hours: the pruned Workspace's terraform destroy failed repeatedly with "Value for undeclared variable" (`CannotDeleteExternalResource`, 731+ events) - a chart/module version skew in application-chart 1.30.2-1.30.5, which pass `enable_db_url_suffix_ssl_no_verify` while defaulting `rds.moduleRevision: v1.1.3`, a module version that does not declare it (fixed in chart 1.30.6).
Internal engineering (Nigel Alvares) completed the database deletion manually in AWS on 2026-08-12, taking the final snapshot above first.
Recovery routes from here are point-in-time recovery and automated backups on Cortex's own instance (14 days - see [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md)) or the source's final snapshot via internal engineering.

## Verification record

- Reviewer UI lists the migrated studies and sessions.
- Playback of pre-migration session `session_bb101ec8` verified end to end (asset streams with Range support, transcript renders).
- Backend boot check: a wrong or missing database URL fails startup schema-verify (nine `firsthand.*` relations checked) rather than serving empty or foreign data.
  Note the limit: schema-verify catches an unmigrated database, not a wrong-but-migrated one.
- Post-retirement (2026-08-12): the standalone app's hostname and DNS record are gone, and the `firsthand-playground` bucket's CORS rule was verified intact byte-for-byte via unauthenticated preflight (PUT-only, Cortex origin only) - Cortex recording unaffected throughout.

## Key commits

- Execute flag (data copy armed): !62, merge `5ddd77cd`
- Migration machinery teardown: !63, merge `dfab5de0`
- Cutover: !64, squash `4dbff74b`, merge `50230caf`
- Image CVE cleanup: !65, merge `e2ca23d5`
- Source RDS decommission: FirstHand repo !2, merge `21a3a70d`, deployed 2026-08-11, completed manually 2026-08-12
- Standalone app retirement to bucket-custodian shell (D1): FirstHand repo !3
- Dead-remnant removal (guard, comments, resolver test): !89
