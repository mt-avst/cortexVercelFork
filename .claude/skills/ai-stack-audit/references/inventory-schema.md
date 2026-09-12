# Inventory schema

The JSON `discover.mjs` writes to stdout. All figures are read from disk.

```jsonc
{
  "meta": { "generatedAt", "projectDir", "home", "tool", "note" },

  "bootstrap": {
    "globalClaudeMd":  { "path", "bytes" } | null,   // ~/.claude/CLAUDE.md
    "projectClaudeMd": { "path", "bytes" } | null,   // <project>/CLAUDE.md
    "projectAgentsMd": { "path", "bytes" } | null,   // <project>/AGENTS.md
    "imports": [ { "ref", "resolved", "exists" } ]    // every @import, transitively, exists=false is a broken link
  },

  "rules":   { "count", "bytes", "tokensEst", "files": [ { "path", "bytes" } ] },

  "memory": {
    "globalMemoryFiles": [ { "path", "bytes" } ],     // ~/.claude/*MEMORY*.md
    "projectMemoryDir":  "~/..." | null,
    "index":             { "path", "bytes" } | null,  // project memory/MEMORY.md
    "factCount": 0,
    "factFiles": [ { "path", "bytes" } ],
    "stalenessCandidates": [ { "memoryFile", "references" } ]  // LEADS to verify, not findings
  },

  "agents":  { "count", "unreferenced": [ "name" ], "items": [ { "name", "path", "bytes" } ] },
  "skills":  { "count", "unreferencedInRules": [ "name" ], "items": [ { "name", "path", "hasScripts", "hasReferences" } ] },

  "settings": {
    "files": [ "~/..." ],
    "hooks": [ "PostToolUse", ... ],    // hook event names declared
    "allowRules": 0, "denyRules": 0,    // permission rule counts
    "flags": [ ]
  },

  "mcp": { "sources": [ "~/..." ], "count", "servers": [ { "name", "transport", "source" } ] },

  "sessionLoad": { "bytes", "tokensEst", "files": [ { "path", "bytes" } ] },  // what boots before the user types

  "mechanicalFindings": [ { "severity", "category", "detail", "evidence" } ],  // deterministic, already proven

  "summary": { "rules", "agents", "skills", "mcpServers", "memoryFacts", "hooks", "findingsBySeverity", "sessionLoadTokensEst" }
}
```

Notes for the renderer:

- `sessionLoad` is the honest "cost per session" figure - the bootstrap chain plus always-on memory. Rules and skills are available-on-reference, not always-on, so they are counted but not summed into the session load.
- `stalenessCandidates` and `agents.unreferenced` / `skills.unreferencedInRules` are candidate lists. Verify before rendering any as a finding.
- `tokensEst` is `bytes / 4` - the one deliberately estimated figure. Label it as approximate wherever shown.
