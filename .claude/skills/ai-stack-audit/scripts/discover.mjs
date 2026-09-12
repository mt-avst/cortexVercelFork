#!/usr/bin/env node
// ai-stack-audit / discover.mjs
// Walks a Claude Code setup (user-global ~/.claude + the current project) and
// emits a MEASURED inventory of the stack as JSON on stdout, plus a set of
// mechanical audit flags the checklist can build on. No dependencies.
//
// Ground truth only: every count and byte figure here is read off disk, never
// derived. Judgement findings are left to the model + references/audit-checklist.md.
//
// Usage:  node discover.mjs [projectDir]      (projectDir defaults to cwd)
//         node discover.mjs --pretty          (indented JSON)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const pretty = args.includes("--pretty");
const projectDir = path.resolve(args.find((a) => !a.startsWith("--")) || process.cwd());
const HOME = os.homedir();
const CLAUDE = path.join(HOME, ".claude");

// ---------- fs helpers (all defensive: a missing path is data, not a crash) ----------
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readJSON = (p) => { const t = readText(p); if (t == null) return null; try { return JSON.parse(t); } catch { return { __parseError: true }; } };
const bytes = (p) => { const s = stat(p); return s && s.isFile() ? s.size : 0; };
const listDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };

function walk(dir, filterExt) {
  const out = [];
  const rec = (d) => {
    for (const e of listDir(d)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) rec(full);
      else if (!filterExt || full.endsWith(filterExt)) out.push(full);
    }
  };
  if (exists(dir)) rec(dir);
  return out;
}

const rel = (p) => p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
const tokEst = (b) => Math.round(b / 4); // rough chars->tokens

const findings = [];
const flag = (severity, category, detail, evidence) =>
  findings.push({ severity, category, detail, evidence });

// ---------- 1. bootstrap chain: CLAUDE.md + its @imports ----------
function resolveImports(file, seen = new Set(), depth = 0) {
  const chain = [];
  if (!file || depth > 4 || seen.has(file)) return chain;
  seen.add(file);
  const text = readText(file);
  if (text == null) return chain;
  const dir = path.dirname(file);
  // @import lines: `@./foo.md`, `@AGENTS.md`, `@../rules/x.md`
  const re = /(^|\s)@([./A-Za-z0-9_\-]+\.md)\b/g;
  let m;
  while ((m = re.exec(text))) {
    const target = path.resolve(dir, m[2]);
    const ok = exists(target);
    chain.push({ ref: m[2], resolved: rel(target), exists: ok });
    if (!ok) flag("high", "integrity", `Broken @import in ${rel(file)}: ${m[2]} does not resolve`, rel(file));
    else chain.push(...resolveImports(target, seen, depth + 1));
  }
  return chain;
}

const globalClaude = path.join(CLAUDE, "CLAUDE.md");
const projectClaude = path.join(projectDir, "CLAUDE.md");
const projectAgents = path.join(projectDir, "AGENTS.md");

const bootstrap = {
  globalClaudeMd: exists(globalClaude) ? { path: rel(globalClaude), bytes: bytes(globalClaude) } : null,
  projectClaudeMd: exists(projectClaude) ? { path: rel(projectClaude), bytes: bytes(projectClaude) } : null,
  projectAgentsMd: exists(projectAgents) ? { path: rel(projectAgents), bytes: bytes(projectAgents) } : null,
  imports: [
    ...resolveImports(globalClaude),
    ...resolveImports(projectClaude),
  ],
};
if (!bootstrap.globalClaudeMd && !bootstrap.projectClaudeMd)
  flag("medium", "integrity", "No CLAUDE.md found at user-global or project level - nothing bootstraps the session", rel(CLAUDE));

// CLAUDE.md vs AGENTS.md drift (both present, project level)
if (bootstrap.projectClaudeMd && bootstrap.projectAgentsMd) {
  const c = readText(projectClaude) || "";
  const importsAgents = /@(\.\/)?AGENTS\.md/.test(c);
  if (!importsAgents && c.replace(/\s/g, "").length > 200)
    flag("medium", "drift", "Project CLAUDE.md and AGENTS.md both exist but CLAUDE.md does not @import AGENTS.md - they can drift apart", rel(projectClaude));
}

// ---------- 2. rules tree ----------
function inventoryRules() {
  const dirs = [path.join(CLAUDE, "rules"), path.join(projectDir, ".claude", "rules")];
  const files = [];
  for (const d of dirs) for (const f of walk(d, ".md")) files.push({ path: rel(f), bytes: bytes(f) });
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  return { count: files.length, bytes: totalBytes, files };
}
const rules = inventoryRules();

// ---------- 3. memory (global dynamic + project memory dir) ----------
const ARCHIVED = /archive|backup|old|\.bak/i; // reference files, not always-on session context
function inventoryMemory() {
  const memMd = listDir(CLAUDE).filter((e) => e.isFile() && /MEMORY/i.test(e.name) && e.name.endsWith(".md"));
  const globalMem = memMd.filter((e) => !ARCHIVED.test(e.name))
    .map((e) => ({ path: rel(path.join(CLAUDE, e.name)), bytes: bytes(path.join(CLAUDE, e.name)) }));
  const archivedMem = memMd.filter((e) => ARCHIVED.test(e.name))
    .map((e) => ({ path: rel(path.join(CLAUDE, e.name)), bytes: bytes(path.join(CLAUDE, e.name)) }));
  const slug = projectDir.split(path.sep).join("-");
  const memDir = path.join(CLAUDE, "projects", slug, "memory");
  const indexPath = path.join(memDir, "MEMORY.md");
  const factFiles = walk(memDir, ".md").filter((f) => f !== indexPath).map((f) => ({ path: rel(f), bytes: bytes(f) }));
  return {
    globalMemoryFiles: globalMem,
    archivedMemoryFiles: archivedMem,
    projectMemoryDir: exists(memDir) ? rel(memDir) : null,
    index: exists(indexPath) ? { path: rel(indexPath), bytes: bytes(indexPath) } : null,
    factCount: factFiles.length,
    factFiles,
  };
}
const memory = inventoryMemory();

// staleness candidates: backticked path-like tokens in memory that name a file this
// repo no longer has. A memory note that writes a SHORTHAND path (`routes/foo.ts` for
// `backend/src/routes/foo.ts`) is not stale, so a candidate only survives when NO file
// of that basename exists anywhere in the repo. Cross-repo absolutes, hashed build
// assets and served URLs are skipped - they were never repo files to begin with.
function repoBasenames() {
  const set = new Set();
  try {
    const { execSync } = require("node:child_process");
    const out = execSync("git ls-files", { cwd: projectDir, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString();
    for (const p of out.split("\n")) if (p) set.add(p.split("/").pop());
    if (set.size) return set;
  } catch { /* not a git repo, or git absent - fall through to a walk */ }
  for (const f of walk(projectDir)) { if (f.includes("/node_modules/") || f.includes("/.git/")) continue; set.add(path.basename(f)); }
  return set;
}
const REPO_BASENAMES = repoBasenames();
const HASHED_ASSET = /-[A-Za-z0-9_]{6,}\.(?:js|css|mjs)$/; // e.g. index-DqbIrUin.js
function memoryStaleness() {
  const cands = [];
  const all = [...(memory.factFiles || []), ...(memory.index ? [memory.index] : [])];
  for (const f of all) {
    const abs = f.path.replace(/^~/, HOME);
    const text = readText(abs) || "";
    const re = /`([A-Za-z0-9_\-./]+\.(?:ts|tsx|js|mjs|md|json|yaml|yml|sh|py|sql))`/g;
    let m; const local = new Set();
    while ((m = re.exec(text))) {
      const tok = m[1];
      if (!tok.includes("/") || tok.startsWith("http")) continue; // bare filename or URL
      if (tok.startsWith("/")) continue;                          // absolute -> outside this repo
      if (HASHED_ASSET.test(tok)) continue;                       // ephemeral build artifact
      local.add(tok);
    }
    for (const tok of local) {
      const base = tok.split("/").pop();
      if (REPO_BASENAMES.has(base)) continue;                     // shorthand path, file still exists
      if ([path.join(projectDir, tok)].some(exists)) continue;    // resolves exactly
      cands.push({ memoryFile: f.path, references: tok });
    }
  }
  return cands;
}
const stalenessCandidates = memoryStaleness();
if (stalenessCandidates.length)
  flag("low", "staleness", `${stalenessCandidates.length} memory reference(s) name a file path that does not resolve in this project - verify each before trusting the note`, "memory/*");

// ---------- 4. agents ----------
function inventoryAgents() {
  const dirs = [path.join(CLAUDE, "agents"), path.join(projectDir, ".claude", "agents")];
  const agents = [];
  for (const d of dirs) for (const f of walk(d, ".md"))
    agents.push({ name: path.basename(f, ".md"), path: rel(f), bytes: bytes(f) });
  return agents;
}
const agents = inventoryAgents();

// ---------- 5. skills ----------
function inventorySkills() {
  const dirs = [path.join(CLAUDE, "skills"), path.join(projectDir, ".claude", "skills")];
  const skills = [];
  for (const d of dirs) for (const e of listDir(d)) {
    const skillMd = path.join(d, e.name, "SKILL.md");
    if (exists(skillMd)) {
      const sub = listDir(path.join(d, e.name)).map((x) => x.name);
      skills.push({
        name: e.name,
        path: rel(path.join(d, e.name)),
        hasScripts: sub.includes("scripts"),
        hasReferences: sub.includes("references"),
      });
    }
  }
  return skills;
}
const skills = inventorySkills();

// ---------- dead-weight: agents/skills whose NAME appears in no rule or bootstrap text ----------
function corpusText() {
  let t = "";
  for (const f of [globalClaude, projectClaude, projectAgents]) t += (readText(f) || "") + "\n";
  for (const f of rules.files) t += (readText(f.path.replace(/^~/, HOME)) || "") + "\n";
  return t;
}
const CORPUS = corpusText();
const unreferencedAgents = agents.filter((a) => !CORPUS.includes(a.name)).map((a) => a.name);
const unreferencedSkills = skills.filter((s) => !CORPUS.includes(s.name)).map((s) => s.name);
// note: absence in rules/CLAUDE is not proof a skill is dead (skills self-trigger on
// their own description), so these are reported as low-severity candidates only.
if (unreferencedAgents.length)
  flag("low", "dead-weight", `Agent(s) not named in any rule or CLAUDE/AGENTS text: ${unreferencedAgents.join(", ")} (scope: bootstrap + rules only; skills' own descriptions not scanned)`, "agents/*");

// ---------- 6. settings + hooks + permissions + secrets ----------
function inventorySettings() {
  const files = [
    path.join(CLAUDE, "settings.json"),
    path.join(CLAUDE, "settings.local.json"),
    path.join(projectDir, ".claude", "settings.json"),
    path.join(projectDir, ".claude", "settings.local.json"),
  ].filter(exists);
  const out = { files: [], hooks: [], allowRules: 0, denyRules: 0, flags: [] };
  const secretRe = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  for (const f of files) {
    const raw = readText(f) || "";
    const j = readJSON(f) || {};
    out.files.push(rel(f));
    if (j.__parseError) flag("high", "integrity", `settings file is not valid JSON: ${rel(f)}`, rel(f));
    // hooks
    if (j.hooks) for (const evt of Object.keys(j.hooks)) out.hooks.push(evt);
    // permissions
    const perm = j.permissions || {};
    out.allowRules += (perm.allow || []).length;
    out.denyRules += (perm.deny || []).length;
    const broad = (perm.allow || []).filter((r) => /\(\s*\*\s*\)|^Bash$|Bash\(\*\)|\*\*/.test(r));
    if (broad.length) flag("medium", "security", `Broad allow rule(s) in ${rel(f)}: ${broad.join(", ")}`, rel(f));
    // dangerous flags
    if (/dangerously-?skip-?permissions/i.test(raw) || j.dangerouslySkipPermissions)
      flag("high", "security", `dangerously-skip-permissions present in ${rel(f)}`, rel(f));
    if (secretRe.test(raw)) flag("critical", "security", `Possible hardcoded secret in ${rel(f)} - rotate and move to a secret store`, rel(f));
  }
  out.hooks = [...new Set(out.hooks)];
  if (!files.length) out.flags.push("no settings.json found");
  return out;
}
const settings = inventorySettings();

// ---------- 7. MCP servers ----------
function inventoryMCP() {
  const sources = [
    { path: path.join(projectDir, ".mcp.json"), key: null },
    { path: path.join(CLAUDE, "settings.json"), key: "mcpServers" },
    { path: path.join(HOME, ".claude.json"), key: "mcpServers" },
    { path: path.join(projectDir, ".claude", "settings.json"), key: "mcpServers" },
  ];
  const servers = new Map();
  const found = [];
  for (const s of sources) {
    if (!exists(s.path)) continue;
    const j = readJSON(s.path);
    if (!j || j.__parseError) continue;
    const block = s.key ? j[s.key] : j.mcpServers || j.servers || j;
    if (!block || typeof block !== "object") continue;
    for (const name of Object.keys(block)) {
      if (servers.has(name)) continue;
      const cfg = block[name] || {};
      const transport = cfg.command ? "stdio" : (cfg.url || cfg.type ? "http/sse" : "unknown");
      servers.set(name, { name, transport, source: rel(s.path) });
    }
    found.push(rel(s.path));
  }
  return { sources: found, count: servers.size, servers: [...servers.values()] };
}
const mcp = inventoryMCP();

// ---------- session load estimate (what actually boots every session) ----------
const alwaysOn = [];
if (bootstrap.globalClaudeMd) alwaysOn.push(bootstrap.globalClaudeMd);
if (bootstrap.projectClaudeMd) alwaysOn.push(bootstrap.projectClaudeMd);
for (const imp of bootstrap.imports) if (imp.bytes) alwaysOn.push({ path: imp.resolved, bytes: imp.bytes });
if (memory.index) alwaysOn.push(memory.index);
for (const g of memory.globalMemoryFiles) alwaysOn.push(g);
// dedupe by path
const seenP = new Set();
const loadFiles = alwaysOn.filter((f) => f && !seenP.has(f.path) && seenP.add(f.path));
const sessionBytes = loadFiles.reduce((s, f) => s + (f.bytes || 0), 0);
const sessionTokens = tokEst(sessionBytes);
if (sessionTokens > 40000)
  flag("medium", "context-cost", `~${sessionTokens.toLocaleString()} tokens boot into every session before you type - consider trimming always-on context`, "bootstrap chain");

// ---------- assemble ----------
const inventory = {
  meta: {
    generatedAt: new Date().toISOString(),
    projectDir: rel(projectDir),
    home: rel(HOME),
    tool: "ai-stack-audit/discover.mjs",
    note: "All counts and bytes read from disk. Findings below are mechanical; judgement findings come from references/audit-checklist.md.",
  },
  bootstrap,
  rules: { count: rules.count, bytes: rules.bytes, tokensEst: tokEst(rules.bytes), files: rules.files },
  memory: { ...memory, stalenessCandidates },
  agents: { count: agents.length, unreferenced: unreferencedAgents, items: agents },
  skills: { count: skills.length, unreferencedInRules: unreferencedSkills, items: skills },
  settings,
  mcp,
  sessionLoad: { bytes: sessionBytes, tokensEst: sessionTokens, files: loadFiles },
  mechanicalFindings: findings,
  summary: {
    rules: rules.count,
    agents: agents.length,
    skills: skills.length,
    mcpServers: mcp.count,
    memoryFacts: memory.factCount,
    hooks: settings.hooks.length,
    findingsBySeverity: findings.reduce((a, f) => ((a[f.severity] = (a[f.severity] || 0) + 1), a), {}),
    sessionLoadTokensEst: sessionTokens,
  },
};

process.stdout.write(JSON.stringify(inventory, null, pretty ? 2 : 0) + "\n");
