# HackDay Central (HDC) Overview — Template for ClaudeL

**Purpose:** When you have access to the HackDay Central codebase, fill this template and share it with ClaudeL (together with `CORTEX-FOR-CLAUDEL-UNMODERATED-PLANNING.md`). That gives enough to map the **three-product architecture** (Cortex, HDC, testing tool) and propose a **build sequence**.

**Current status:** HDC is not in the Cortex (Labs2) repo. This doc is a **checklist + template**. Fill it from the HDC codebase (schema, auth, APIs, docs), then paste the result into your thread with ClaudeL or save it as `docs/HDC-OVERVIEW-FROM-CODEBASE.md` in this repo.

---

## 1. What ClaudeL needs from HDC

Three things block the full architecture map:

| Question | Why it matters |
|----------|----------------|
| **Does HDC have its own user identity or defer to Cortex?** | Determines whether HDC stores users, uses Cortex `/api/me`, or shares an SSO layer (e.g. same Google/Confluence identity). |
| **Is the testing tool something HDC triggers directly** (e.g. “Run a usability test on this HackDay submission”) **or does that integration come later?** | Drives build order: HDC→testing vs Cortex→testing vs both in parallel. |
| **HDC data model** (main entities, relationships, where “submissions” or “events” live) | So ClaudeL can see how a “run test on this submission” flow would attach to Cortex opportunities and/or bookings. |

---

## 2. HDC overview template (fill from codebase)

Copy the section below and replace the placeholders after inspecting the HDC repo (schema, env, auth, README, API routes).

```markdown
## HackDay Central — Data model & identity (filled from codebase)

**Repo / location:** [e.g. GitHub URL or path]

**Tech stack:** [e.g. Next.js + Postgres, or Confluence Forge, or …]

### Identity / users
- [ ] HDC has its own user table/entity → [describe: table name, key fields, how users are created (SSO, signup, Confluence accountId)?]
- [ ] HDC defers to Cortex for identity → [how? e.g. “Cortex JWT / API key”, “same SSO, HDC calls Cortex GET /api/me”?]
- [ ] Other: [describe]

**Conclusion:** [One sentence: e.g. “HDC uses Confluence accountId only; no Cortex user sync” or “HDC expects Cortex session; calls Cortex /api/me for current user”.]

### Main entities (tables / storage)
- [List main entities, e.g.: Event, Submission, Judge, Vote, …]
- [For each: key fields and relation to “user” or “participant” if relevant.]

### Submissions (or equivalent)
- [How are HackDay “submissions” or “projects” represented? ID, title, link, owner, event_id, …]
- [Any existing link to “tests” or “usability” or “Cortex” (e.g. external_link, opportunity_id)?]

### APIs relevant to integration
- [List endpoints that might be used by Cortex or by a testing tool, e.g. “GET /api/events”, “GET /api/submissions/:id”, “POST /api/…”. Or “Forge resolvers: getSubmissions, getEvent”.]

### Testing tool / unmoderated (current or planned)
- [ ] HDC can trigger a test today → [how? e.g. “Button ‘Run usability test’ opens external link” or “API POST /api/submissions/:id/start-test”?]
- [ ] Integration is planned later → [any spec or ticket?]
- [ ] No link yet → [confirm so ClaudeL can propose the integration point.]

**Conclusion:** [One sentence: e.g. “HDC has no testing trigger today; we want to add ‘Run test on this submission’ that creates/links a Cortex unmoderated opportunity.”]
```

---

## 3. Where to look in the HDC codebase

Suggested places to get the above:

- **Schema:** `schema.prisma`, or `**/migrate*.ts`, or `**/migrations/*.sql`, or Forge `manifest.yml` + storage docs.
- **Identity:** Auth middleware, “current user” resolution, env vars (e.g. `CORTEX_URL`, `NEXTAUTH_*`, Confluence `accountId`).
- **Submissions:** Tables or entities named submission, project, entry; routes like `/api/submissions`, `/api/events/:id/submissions`.
- **Testing / Cortex:** Grep for “cortex”, “unmoderated”, “usability”, “test”, “opportunity”; any “Run test” or “Start test” buttons or links.

---

## 4. After you fill it

1. Save the filled template (e.g. as **`docs/HDC-OVERVIEW-FROM-CODEBASE.md`** in Labs2, or paste into the thread).
2. Share with ClaudeL together with **`docs/CORTEX-FOR-CLAUDEL-UNMODERATED-PLANNING.md`**.
3. Ask ClaudeL to: **map the full three-product architecture (Cortex, HDC, testing tool) and give a proper build sequence** given (a) HDC identity vs Cortex, (b) whether HDC triggers the testing tool directly or later, and (c) the Cortex schema and API from the planning doc.

---

*Template for use when pulling an HDC overview from the HackDay Central codebase into the Cortex repo for ClaudeL.*
