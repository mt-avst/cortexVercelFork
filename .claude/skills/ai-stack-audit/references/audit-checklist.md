# Audit checklist

The finding catalogue for `ai-stack-audit`.
Work each category against the discovery inventory.
The script proves the mechanical cases; the notes below tell you what it caught and what it left for judgement.
Every finding you keep must cite evidence and state its scope.

## Severity rubric

| Level | Meaning | Examples |
|-------|---------|----------|
| **critical** | Secret exposure or a break that silently corrupts the session | Hardcoded API key or token in settings, a settings file that fails to parse so config is silently ignored |
| **high** | The stack does not do what it claims, or a real security loosening | Broken `@import` so a referenced ruleset never loads, `dangerously-skip-permissions` on, a rule naming an agent that does not exist |
| **medium** | Maintainability, drift or cost that will bite later | CLAUDE.md and AGENTS.md able to drift apart, broad allow-rule, heavy always-on context, conflicting rules |
| **low** | Tidy-up, candidates to verify | Unreferenced agent/skill, a memory note whose path no longer resolves |

Match the ceiling to real consequence, not to how alarming the wording sounds.

## Categories

### 1. Integrity - does the wiring hold
- **Broken `@import`** (mechanical). Any `@file.md` in the bootstrap chain that does not resolve. Nothing behind it loads.
- **Invented agent / skill reference** (judgement). A rule or CLAUDE/AGENTS text that instructs "use the X agent" or "the X skill" where no `agents/X.md` or `skills/X/` exists. Cross the inventory's `agents`/`skills` lists against the names the rules invoke. This is a classic silent failure: the instruction reads fine and never fires.
- **Unparseable settings** (mechanical). A `settings.json` that is not valid JSON is ignored wholesale - the user's permissions and hooks are silently off.

### 2. Drift - do the sources of truth agree
- **CLAUDE.md vs AGENTS.md** (mechanical seed + judgement). The script flags the structural case (both exist, no `@import` link). Then read both: call out substantive contradictions, not cosmetic ones.
- **Conflicting rules** (judgement). Two rules that give opposing instructions on the same subject (e.g. one mandates a pattern another forbids). Name both files. Where the stack documents a precedence order (specific overrides general), a deliberate override is not a conflict - say so.
- **Duplicated guidance** (judgement). The same rule stated in several places drifts out of sync. Point at the copies.

### 3. Staleness - do the notes still describe reality
- **Dead memory references** (mechanical candidate + judgement). The script lists backticked path-like tokens in memory that do not resolve in the project. These are LEADS. Open each: a path that moved, a flag that was removed, a function that was renamed is a real finding; one that resolves elsewhere or was always illustrative is not. Do not report the raw candidate list as findings - report the ones you verified.
- **Superseded project notes** (judgement). A memory entry describing work that has since shipped or reversed. Only flag when you can show the contradiction.

### 4. Security - what has been loosened
- **Hardcoded secrets** (mechanical). Any key/token/private-key pattern in a settings or MCP file. Critical: name the file, do not echo the secret, say rotate + move to a secret store.
- **`dangerously-skip-permissions`** (mechanical). High wherever it appears.
- **Broad allow-rules** (mechanical seed + judgement). Wildcards like `Bash(*)` or `**` hand back the guardrail. The script flags the pattern; judge whether each is deliberate and scoped or an over-grant.
- **MCP write scope** (judgement). From the inventory's MCP list, note servers that can write to external systems (issue trackers, mail, cloud, deploy). Not a defect in itself - surface it so the user sees their real blast radius.

### 5. Context cost - what you pay every session
- **Always-on load** (mechanical). The `sessionLoad` figure is what boots before the first token of work. Report it plainly. Flag as medium when it is heavy enough to crowd the window (the script's threshold is a starting point - use judgement for the user's model and typical task).
- **Bloat sources** (judgement). Which always-on files dominate the load, and which could move to on-demand skills or references instead of booting every time.

### 6. Coverage + dead weight - what is missing or unused
- **Missing gates** (judgement). No testing rule, no code-review rule, hooks declared nowhere - name the gap against what a stack this size would be expected to have. Do not invent a need the user has not shown.
- **Dead weight** (mechanical candidate + judgement). Agents or skills named nowhere in the bootstrap/rules corpus. Remember the stated scope: a skill self-triggers on its own description, so "unreferenced in rules" is not "unused". Low severity, framed as "candidate to confirm or prune".

## Reporting posture

- Most-severe first.
- One line of evidence (path, and line where it sharpens the point) and one line of fix per finding.
- State each check's scope inline. "No conflicts found" must say what was compared.
- A clean audit is a real outcome. Say the stack is sound and show the numbers that back it - do not pad.
