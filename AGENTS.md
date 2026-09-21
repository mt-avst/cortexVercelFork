# AGENTS.md

[CLAUDE.md](./CLAUDE.md) imports this file - edit here, never there.

## Live beta - do not touch the all-admin switch

Cortex is in an **active internal beta on the playground, with real external testers using
it right now.** The `CORTEX_BETA_ALL_ADMIN` switch (in `.kubera/playground-backend.yaml`,
shipped in !353) is **ON deliberately** - Nick asked for it, it lifts every signed-in
`adaptavist.com` employee to `researcher_admin` for the duration of the beta.

**Do not recommend removing it, do not list it as a to-do, do not turn it off.**
Issue **#107** ("Remove the temporary CORTEX_BETA_ALL_ADMIN beta switch at go-live") is a
**go-live alarm only** - it is not actionable during the beta, and surfacing it as pending
work is wrong. Turning the switch off is Nick's call, made once he says the beta is over.
Until then, leave it on and leave #107 closed-in-spirit even though it is open.

## Agent skills

### Issue tracker

Issues live as GitLab issues in `cto/AdaptaLabs` on gitlab.adaptavist.net, driven via the
`gitlab` MCP server. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, label strings equal to their names. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Project agents

Two implementation agents live in `.claude/agents/` and are scoped to one subtree each. They are
for building, not reviewing - the review gates are the five global agents in `~/.claude/agents`
(`code-reviewer`, `security-auditor`, and the rest), which are unchanged.

- **backend-engineer** (`sonnet`) - API and data layer: routes, services, schema, queries,
  integrations. Owns **only** `backend/src`.
- **frontend-engineer** (`sonnet`) - UI: components, hooks, pages, state, styling. Owns **only**
  `frontend/src`.

Keep each agent inside its subtree. A change that spans both is two delegations, not one agent
reaching across the boundary.

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

## Local dev database

`npm run dev:backend` runs NO migrations, so a local `cortex-ux-pg` needs
`npm run migrate:firsthand` (from `backend/`) by hand after pulling a branch that adds one.
Skip it and the survey-session mint route answers 500 for every participant holding a
session, on `42883 function try_timestamptz(unknown) does not exist` - migration 0016.
Deploy is not exposed to this: the initContainer runs `migrate:firsthand` before the app
container and a failed run exits non-zero, so the pod never starts against an unmigrated
database.

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

The canary runs on the **merge-train pipeline only** - not the plain MR
pipeline, not the post-merge `main` pipeline (both dropped 2026-09-18, MRs
!477 then !478). The train grades the full manifest against the real merge
result (main + MR) just before it lands, so it is the one run that both sees
the real tree and gates the merge; the MR-pipeline run graded main-at-MR-time
and the `$PROD_REF` run re-graded an identical tree on the deploy critical path
(measured !476: semantic-release + deploy idle ~10 min waiting for it). Gated on
`$CI_MERGE_REQUEST_EVENT_TYPE == "merge_train"`. **This leans hard on merge
trains being ON: with trains OFF the canary would run nowhere and the merge gate
would silently vanish.** If trains are ever disabled, that rule MUST change back
in the same commit - restore the plain `merge_request_event` MR run and the
`$PROD_REF` main run. Keep this paragraph and that job's `rules:` in step.

Never scope the canary below the full manifest: a filtered run is structurally blind to a
pre-existing entry the same diff broke (that reddened main once already). The path gate
above is job-level and all-or-nothing, which is the only safe shape.

Running it LOCALLY needs a real Postgres. Of the 233 entries (re-measured
2026-09-02, post-#78), 19 are database-backed. By FILE PATH they split 209
`backend/`, 16 `shared/`, 8 `frontend/`; by `project` - a different thing, and
a real manifest field since !307 - it is 225 backend to 8 frontend, because
the 16 `shared/` entries run their specs in the backend project. Grep the
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
