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

## Hosting and CI (this fork)

This repository is the **Vercel fork** of Cortex. The live beta still runs from the
GitLab original (`cto/AdaptaLabs`) on Kubera; nothing here deploys there, and the
Kubera, Docker and GitLab CI files were deleted from this fork on purpose. Setup,
environment variables and what is still missing: `docs/VERCEL.md`.

There is **no CI in this fork yet**: nothing re-runs the suites on push. Before a push
that changes `backend/`, `frontend/`, `shared/` or `scripts/`, run what the deleted
pipeline ran - `npm run typecheck`, `npm run lint`, both backend suites, the frontend
suite, `npm run test:scripts` - and quote the result lines. Vercel's build is not a test:
a green deploy proves only that it compiled.

The `mutation-canary` still guards the suites and is still run against the full
manifest only: a filtered run is structurally blind to a pre-existing entry the same
diff broke (that reddened main once already).

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
