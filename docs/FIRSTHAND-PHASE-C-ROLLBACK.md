# FirstHand Phase C rollback runbook

Status: ACTIVE through the retention window.
Written 2026-07-23, immediately after the Phase C cutover deployed.

## What was cut over

On 2026-07-22 the FirstHand runtime data (schema `firsthand`: studies, steps, sessions, events, responses, recording-asset metadata) was copied from FirstHand's standalone RDS into Cortex's own RDS and verified three ways (migration-ledger row-for-row, per-table counts, JSONB md5 spot-checks).
On 2026-07-23 at 01:26 UTC the cutover deployed: `getRuntimeDatabaseUrl()` no longer reads `FIRSTHAND_DATABASE_URL`, so the firsthand runtime pool resolves to this deployment's own RDS (`DB_URL`), where the migrated copy lives.
Recordings themselves never moved: the `firsthand-playground` S3 bucket is unchanged and is reached via the backend's IRSA grant.

## Rollback (retention window): one git revert

The rollback is a revert of the cutover commit, nothing else.

```bash
git revert 4dbff74b   # "feat: cut the firsthand runtime over to Cortex's own RDS (C3 cutover)"
```

Raise the revert as an MR, merge, let it deploy.
The revert restores `FIRSTHAND_DATABASE_URL` to the head of the resolver chain, and the env var is still injected into the backend pod from the secret store - so on restart the runtime pool points straight back at the untouched FirstHand source RDS.
No AWS action, no data restore, no coordination required.

### Preconditions that keep this rollback alive

1. The `FIRSTHAND_DATABASE_URL` secret MUST stay in the adaptalabs backend's secret store until the retention window closes.
   Deleting it is post-retention hygiene ONLY - doing it early converts the rollback from a git revert into an AWS re-provisioning exercise.
2. The FirstHand RDS instance and the `firsthand-playground` bucket stay untouched and retained.
   The source RDS has no automated backups (chart default) - the live instance IS the rollback copy.
3. The standalone FirstHand app is only scaled to zero on explicit instruction, after the migrated data has been verified end to end in the reviewer UI.

### What a rollback loses

Any firsthand-runtime data written between cutover and rollback exists only in Cortex's RDS and is not visible after reverting.
This is the same drift window that motivates the standing rule: no recording sessions until the migration is verified and stable.
Note the copy pipeline was torn down with Phase C (job, script, report route and table all removed) - re-running the copy after a rollback requires reverting the teardown MR as well and re-authorising an execute run.

## Verification after either direction

- Reviewer UI lists the migrated studies and sessions.
- Playback of pre-migration session `session_bb101ec8` works end to end (asset streams with Range support, transcript renders).
- Backend boot is the tripwire: a wrong or missing database URL fails startup schema-verify (nine `firsthand.*` relations checked) rather than serving empty or foreign data.

## Key commits

- Execute flag (data copy armed): !62, merge `5ddd77cd`
- Migration machinery teardown: !63, merge `dfab5de0`
- Cutover (revert THIS to roll back): !64, squash `4dbff74b`, merge `50230caf`
- Image CVE cleanup: !65, merge `e2ca23d5`
