# AGENTS.md

[CLAUDE.md](./CLAUDE.md) imports this file - edit here, never there.

## Agent skills

### Issue tracker

Issues live as GitLab issues in `cto/AdaptaLabs` on gitlab.adaptavist.net, driven via the
`gitlab` MCP server. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, label strings equal to their names. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Deliberate shortcuts

A deliberate simplification with a known ceiling always gets a `ponytail:` comment at the site,
naming the ceiling and the upgrade path.

It **also** gets a GitLab issue when production could actually hit that ceiling: correctness,
scale, security, data loss. Taste and style ceilings stay comment-only.

```ts
// ponytail: in-memory dedupe, O(n^2) over bookings
//   -> #NNN, breaks past ~5k rows
```

Reference the issue from the comment once it exists. `/ponytail-debt` harvests every `ponytail:`
comment regardless, so the comment is the ledger and the issue is the alarm.

This is the threshold `~/.claude/rules/common/code-review.md` asks each repo to set.

## Sweeps

String sweeps are case-insensitive by default (`grep -ri`), across every file type with no
path filter. A case-sensitive sweep missed a `/recorded study/i` regex and cost two full
132-second suite runs. State a sweep's actual scope beside any "no references" conclusion -
an empty result from a too-narrow search is indistinguishable from a correct one.

## CI waits

The `mutation-canary` job is sharded across four parallel jobs and runs only on MRs
touching `backend/`, `frontend/`, `shared/`, `scripts/`, the root lockfile or
`.gitlab-ci.yml`; only docs-only MRs skip it entirely. **`frontend/` joined that list
on 2026-08-28** (!308), when the first frontend entries landed - a frontend-only MR
can change a mutation outcome now, so it must not skip. That is a real cost on every
frontend MR, taken deliberately. Measured on !276's pipeline (151 entries): slowest
shard 5.6 minutes wall, whole MR pipeline 11.5 minutes to green, against ~24 minutes
serial before. Poll to match the job's known duration rather than
sleeping on a fixed long timer - ten minutes of dead air past a green result is the
recorded cost of guessing. Prefer merging with auto-merge armed so nobody watches at all.

Never scope the canary below the full manifest: a filtered run is structurally blind to a
pre-existing entry the same diff broke (that reddened main once already). The path gate
above is job-level and all-or-nothing, which is the only safe shape.

Running it LOCALLY needs a real Postgres. Of the 231 entries (re-measured
2026-09-02, post-#99), 19 are database-backed. By FILE PATH they split 209
`backend/`, 14 `shared/`, 8 `frontend/`; by `project` - a different thing, and
a real manifest field since !307 - it is 223 backend to 8 frontend, because
the 14 `shared/` entries run their specs in the backend project. Grep the
manifest rather than trusting any of these counts. The
runner **refuses to start** rather than skipping them - correctly, because a skipped entry
and a passing entry read identically in a green job. It exits 0 while refusing, so read the
output, not the exit code. There is no filter flag by design.

```bash
docker run -d --name cortex-canary-pg -e POSTGRES_DB=cortex_test \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password -p 5434:5432 postgres:15
FIRSTHAND_TEST_DATABASE_URL='postgresql://postgres:password@localhost:5434/cortex_test' \
  node scripts/mutation-canary.mjs
```

A full unsharded run is roughly 20 minutes. Commit first: the runner mutates the working
tree and refuses a dirty one without `--allow-dirty`, and never `git add` while it is
running - that has staged a live mutation into a pushed commit before.
