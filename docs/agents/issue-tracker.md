# Issue tracker: GitLab (via MCP)

Issues and specs for this repo live as GitLab issues on the self-hosted instance
`gitlab.adaptavist.net`, project **`cto/AdaptaLabs`** (numeric id `5005`).

All operations go through the connected `gitlab` **MCP server**, not the `glab` CLI.
`glab` is not installed here; do not shell out to it. Load tool schemas with
`ToolSearch` (e.g. `select:mcp__gitlab__create_issue`) before calling.

Every tool takes `project_id`. Pass `"cto/AdaptaLabs"` (or `"5005"`).

## Conventions

- **Create an issue**: `mcp__gitlab__create_issue` with `project_id`, `title`, `description`, `labels`
- **Read an issue**: `mcp__gitlab__get_issue`, plus `mcp__gitlab__list_issue_discussions` for comments
- **List issues**: `mcp__gitlab__list_issues` with `state: "opened"`, `scope: "all"`, and `labels` filters.
  Default scope is created-by-me, so pass `scope: "all"` when you mean the whole project
- **Comment**: `mcp__gitlab__create_issue_note`. GitLab calls comments "notes"
- **Labels**: `mcp__gitlab__update_issue` with `labels`. **This replaces the entire label set** -
  read the issue's current labels first and send the full intended list, or you will silently
  strip labels. `mcp__gitlab__list_labels` / `create_label` manage the vocabulary
- **Close**: `mcp__gitlab__update_issue` with `state_event: "close"`. Post the explanation as a
  note first, then close
- **Description edits**: prefer `mcp__gitlab__update_issue_description_patch` for targeted edits
  over resending the whole body
- **Merge requests**: GitLab calls PRs "merge requests" - `create_merge_request`,
  `get_merge_request`, `get_merge_request_diffs`, `create_merge_request_note`

## Merge requests as a triage surface

**MRs as a request surface: no.** _(Set to `yes` if this repo treats external merge requests as
feature requests; `/triage` reads this flag.)_

When set to `yes`, MRs run through the same labels and states as issues, using
`list_merge_requests`, `get_merge_request_diffs`, `create_merge_request_note` and
`update_merge_request`. GitLab numbers issues and MRs separately, so `#42` is unambiguous once
you know which surface is meant.

## When a skill says "publish to the issue tracker"

Create a GitLab issue in `cto/AdaptaLabs`.

## When a skill says "fetch the relevant ticket"

`mcp__gitlab__get_issue` plus `mcp__gitlab__list_issue_discussions`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body
- **Child ticket**: an issue carrying `Part of #<map>` at the top of its description and a
  `wayfinder:<type>` label (`research` / `prototype` / `grilling` / `task`). Once claimed,
  assigned to the driving dev
- **Blocking**: `mcp__gitlab__create_issue_link` with `link_type: "is_blocked_by"` - the
  canonical, UI-visible representation. Read them back with `mcp__gitlab__list_issue_links`.
  A ticket is unblocked when every blocker is closed
- **Frontier query**: `list_issues` scoped to the map's children; drop any with an open
  `is_blocked_by` link or an assignee; first in map order wins
- **Claim**: `mcp__gitlab__update_issue` with `assignee_ids`, the session's first write
- **Resolve**: post the answer as a note, close the issue, then append a context pointer to the
  map's Decisions-so-far
