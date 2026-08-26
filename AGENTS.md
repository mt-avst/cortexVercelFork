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

The `mutation-canary` job takes roughly 20-25 minutes and runs only on MRs touching
`backend/`, `shared/`, `scripts/`, the root lockfile or `.gitlab-ci.yml`; frontend-only and
docs-only MRs skip it, so their MR pipelines finish in a few minutes. Poll to match the
job's known duration rather than sleeping on a fixed long timer - ten minutes of dead air
past a green result is the recorded cost of guessing.

Never scope the canary below the full manifest: a filtered run is structurally blind to a
pre-existing entry the same diff broke (that reddened main once already). The path gate
above is job-level and all-or-nothing, which is the only safe shape.
