# AGENTS.md

Mirrored in [CLAUDE.md](./CLAUDE.md) for Claude Code sessions - change both together.

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
