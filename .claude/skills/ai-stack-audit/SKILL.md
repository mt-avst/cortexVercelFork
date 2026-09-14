---
name: ai-stack-audit
description: >-
  Visualise and audit a Claude Code stack - the config ecosystem that boots
  into every session and the tools it reaches for. Walks the user-global
  ~/.claude and the current project (CLAUDE.md/AGENTS.md and their @imports,
  the rules tree, memory, agents, skills, hooks, settings and MCP servers),
  produces a MEASURED inventory, audits it for integrity, drift, staleness,
  security, context cost and dead weight, then renders a single shareable
  artifact - a way-of-working pipeline diagram (from the workflow rules), a
  layered stack map and a severity-coded audit panel. The whole report is
  downloadable as an HTML file or a single SVG image, to save and share.
  The diagram is core, not a bonus - visualise AND audit.
  TRIGGER when the user asks to "map / visualise / diagram my AI stack",
  "audit my Claude Code setup", "what loads every session", "review my
  ~/.claude", "is my config drifting", "what's my context cost", or runs
  /ai-stack-audit. DO NOT TRIGGER for editing a single rule or skill, for
  general Claude Code how-to questions (use the guide), or when the user
  wants code changed rather than the setup mapped.
origin: nick
---

# AI stack audit

Turn a Claude Code setup into one page: a **map** of what boots every session, how a task moves through it, and what it reaches for, plus an **audit** of where that stack is broken, bloated, drifting or stale. The map is derived from disk, never hand-drawn, so it stays true for any user's `~/.claude` and project - not just the one it was first built for.

This is two jobs of equal weight - **visualise and audit**. The visualise half is the load-order stack *and* the way-of-working pipeline diagram. Producing the audit without the diagram is only half the skill; never stop there.

Two hard commitments run through everything below, because they are what make the output trustworthy:

- **Measured, not derived.** Every count, byte and token figure comes from the discovery script reading disk. Never estimate a number you can measure, and flag anything genuinely estimated as an estimate.
- **A finding is proven, not asserted.** Every audit finding cites the file (and line where it helps) that demonstrates it, and states the actual scope of the check that produced it. A recorded finding is a hypothesis until re-checked - especially a staleness candidate, which is a lead to verify, not a fact to report.

## Workflow

### 1. Discover (measured inventory)

Run the discovery script against the current project:

```bash
node "$CLAUDE_SKILL_DIR/scripts/discover.mjs" --pretty
```

(If `$CLAUDE_SKILL_DIR` is not set, use the skill's own path: `~/.claude/skills/ai-stack-audit/scripts/discover.mjs`. Pass a project directory as the first argument to audit somewhere other than the cwd.)

It emits JSON: the bootstrap chain and its resolved `@imports`, the rules tree, memory (global dynamic files + the project memory dir), agents, skills, settings/hooks/permissions, MCP servers, a **session-load** estimate of what boots before the user types, and a set of **mechanical findings** it can prove deterministically. The shape is documented in `references/inventory-schema.md`. Read the whole object - this is your ground truth.

Do not re-count anything the script already counted. If a number matters to the map or the report, take it from the inventory.

### 2. Audit (judgement findings)

Open `references/audit-checklist.md` and work its categories against the inventory. The script has already caught the mechanical cases (broken imports, secrets, broad permissions, context bloat, dead-weight and staleness candidates); your job is the judgement half - drift between overlapping rules, gates that are documented but not wired, redundancy, coverage gaps.

For every finding, mechanical or judgement:

- **Verify before promoting.** Open the cited file. A staleness candidate whose path actually resolves elsewhere is not a finding - drop it. Re-run a check rather than trusting the script's aggregate when a specific claim matters.
- **Assign severity** on the rubric in the checklist (critical / high / medium / low).
- **State the scope** of the check beside the finding, so a narrow search never reads as a global absence (for example: "grepped bootstrap + rules `.md` only; skills' own descriptions not scanned").
- Keep only findings that survive this pass. An empty audit panel is a valid, good result - do not manufacture findings to fill it.

### 3. Render (one artifact)

Copy `references/stack-map.html` as the starting point and populate it entirely from the inventory and the surviving findings. It carries the full design system (tokens, both themes, the layered stack bands, the load-order flow, and a severity-coded **audit panel** component) with clearly marked fill points. Rules for a faithful render:

- The stack bands, counts and session-load figure are filled from the inventory verbatim - the map must reconcile with the numbers.
- The audit panel lists surviving findings, most severe first, each with its evidence path and one-line fix. If there are none, show the "clean" state, not an empty box.
- The **way-of-working pipeline** is a REQUIRED part of the map whenever the stack encodes a workflow (a development-workflow, testing or code-review rule - the usual case). Derive its stages from those rules and draw it as an inline SVG; the template ships a worked pipeline to adapt, not to copy blindly. This is the *visualise* half of the skill - do not skip it because a similar diagram exists elsewhere, because the audit alone looks sufficient, or to save time. Omit it ONLY for a bare setup with no workflow rules at all, and say so explicitly in the page.
- The template already carries a complete, considered design system - keep its treatment and fill every section faithfully from the inventory. You do not need any external design skill; if your Claude Code happens to have an `artifact-design` skill it is a bonus to load first, but most machines will not have it and the template stands on its own. Then publish with the Artifact tool and hand back the link; where that tool is unavailable, write the finished HTML to a file and hand that over instead.

### 4. Make the report downloadable (HTML + SVG)

The on-screen report from step 3 is the primary output. Also hand it over as **files the user can save and share**, carrying the whole report - map, pipeline and audit - in two formats:

- **HTML** - the self-contained report file you built in step 3. It opens in any browser and stays interactive. Deliver it via `SendUserFile` where the harness has it, otherwise write it into the working directory and give the path.
- **SVG** - the whole report as one vector image. Fill `references/stack-report.svg` from the same inventory and findings; its header comment lists the placeholders, the pill colours, and how to shift the `y` coordinates if the finding count differs from the three slots. Deliver it the same way. It is single-theme (dark) and system-font only, so it needs no rendering tools and looks identical on every machine.

Both files are the full report, not a summary - there is no separate card. If someone wants a PNG (for inline Slack preview), convert the SVG where a converter exists (`rsvg-convert`, `magick`, or macOS `qlmanage`) - a bonus, never a blocker.

### 5. Report (optional)

If the user wants something to paste into an issue or a doc, also write a short markdown findings report: the summary counts, then findings grouped by severity with evidence and fix. Offer it - do not force it.

## Generalisation notes

This skill must work for any Claude Code user, so:

- Discover, never assume. There are no hardcoded file names beyond the Claude Code conventions themselves (`CLAUDE.md`, `AGENTS.md`, `rules/`, `agents/`, `skills/`, `settings.json`, `.mcp.json`). A user's own specifics - their memory, their bespoke rules, their MCP servers - are read off disk and shown as discovered content.
- The audit rubric is universal good practice, not one person's taste. Keep it that way.
- If discovery finds almost nothing (a bare setup), say so plainly and map what exists - the value is an honest picture, however small.
