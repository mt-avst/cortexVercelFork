# AI study drafting - spec

Status: proposal, 2026-09-04. Not built. Nothing here is committed to a branch yet.

## Objective

As a researcher, I need to describe the study I want to run in plain English and have Cortex draft the opportunity form for me so that I can review and publish it in minutes instead of filling every field by hand.

## Decision

Build one backend drafting endpoint and put a "Describe it" panel on the first step of the opportunity form.
The form stays the review surface.
Nothing is saved until the researcher saves, and nothing is published except through the existing publish path.

The endpoint is deliberately shaped so that two later entry points can call it unchanged: a brief importer (paste a research plan) and an MCP server for agents.
Neither is in scope here.
The MCP server is blocked on a non-browser credential story that does not exist today, and that is a separate issue.

## What already exists

This is mostly plumbing work, because the form is already a machine contract.

| Thing | Where | Why it matters here |
|---|---|---|
| Create payload schema | `backend/src/validation/schemas.ts` `CreateOpportunitySchema` | The draft is validated against the real create schema before it reaches the form |
| Task list steps | `shared/firsthand/inline-study.ts` `inlineStudySchema`, `authorableStepTypes` | Vocabulary for unmoderated drafts: instruction, open_text, single_choice |
| Survey questions | `shared/firsthand/survey-authoring.ts` `inlineSurveySchema`, `authorableSurveyStepTypes` | Vocabulary for native poll, survey and question drafts: instruction, open_text, single_choice, multi_choice, rating, nps |
| Per-step shape rules | `shared/firsthand/contract.ts` `findStepShapeProblem` | Choice needs two options, rating scale 2 to 10, nps takes no scale or options |
| Consent templates | `shared/firsthand/consent-templates.ts` `currentConsentTemplate`, `resolveConsentTemplate` | Consent text comes from here, never from the model |
| Publish rules | `shared/firsthand/publish-readiness.ts` `findPublishProblem` | The Review step already tells the author why a publish would be refused |
| Link safety | `shared/firsthand/url-safety.ts` `isPublishableExternalLink`, `isSafeTargetUrl` | Any link the model proposes is checked by the same predicates the form uses |
| Form shape by type | `frontend/src/pages/OpportunityForm.tsx` `getTabsForType` | Tells the review panel which steps a draft populated |

Measured absences, so the reader does not have to trust them:

- No LLM SDK in the repo. `grep -n "anthropic\|openai\|@ai-sdk"` across the root, backend and frontend `package.json` files returns nothing
- No non-browser auth. `backend/src/middleware/` has cookie session, CSRF and per-user rate limiting. `grep -in "api[_-]\?key\|bearer"` in the middleware and auth route finds only the OIDC token exchange and the cron bearer

## Architecture

```
researcher types brief
        |
        v
POST /api/opportunities/draft-from-brief     requireAdmin, draftLimiter, no DB write
        |
        v
services/study-drafter.ts
   1. system prompt = product rules + the six types + vocabularies
   2. client.messages.parse with zodOutputFormat(DraftSchema)
   3. fill consent from currentConsentTemplate(kind)
   4. force status: 'draft'
   5. CreateOpportunitySchema.safeParse - on failure, one retry with the issues fed back
        |
        v
{ draft, assumptions, gaps }  ->  form pre-fills, researcher reviews, saves, publishes as today
```

### Endpoint

`POST /api/opportunities/draft-from-brief`

Guards, in mount order: `requireAdmin`, then a per-user limiter of 10 a minute (`perUserLimiter` from `middleware/per-user-rate-limit.ts`), then body validation.
It writes nothing to Postgres.
It does not touch the FirstHand runtime pool.

Request:

```ts
{
  brief: string,            // trimmed, min 20, max 8000 chars
  hints?: {
    type?: OpportunityType,          // researcher already picked one
    delivery_mode?: 'native' | 'external'
  }
}
```

Response 200:

```ts
{
  draft: CreateOpportunityInput,   // exactly what the form would POST, status 'draft'
  assumptions: string[],           // things the model inferred rather than read
  gaps: string[],                  // things the brief did not say and the model left empty
  filled: string[]                 // field names populated, for the review panel
}
```

Other responses:

| Code | When |
|---|---|
| 400 | brief outside bounds, unknown hint values |
| 401 / 403 | not signed in, not admin, same as every other write |
| 422 | the model's output failed `CreateOpportunitySchema` twice, body carries the zod issues |
| 429 | limiter |
| 503 | drafting disabled or key absent, body `{ error: 'drafting_unavailable' }` |

### Service

`backend/src/services/study-drafter.ts`, one exported function:

```ts
draftOpportunityFromBrief(input: { brief: string; hints?: DraftHints }): Promise<DraftResult>
```

Uses `@anthropic-ai/sdk` directly, no framework.
The call is `client.messages.parse` with `output_config.format = zodOutputFormat(DraftSchema)`, model `claude-opus-5`, adaptive thinking left at the default, `max_tokens` 16000.
The model tier is an open decision, see the cost section.

The system prompt is a frozen string with a `cache_control` breakpoint so repeated drafts hit the cache.
It carries the six types with their one-line meanings from `BasicInfoTab`, the delivery split, the two step vocabularies with their per-type shape rules, the limits from `INLINE_STUDY_LIMITS`, and the rules in the guardrails section below.
The brief goes in the user turn, wrapped as data.

### DraftSchema versus CreateOpportunitySchema

The model does not fill `CreateOpportunitySchema` directly.
It fills a narrower `DraftSchema` that excludes every field a client must never invent, and the service assembles the real payload from it.
This is the schema-to-tool mapping.

| Create field | Model may fill | Source when not | Rule |
|---|---|---|---|
| `type` | yes | hint overrides | One of the six. Hint wins over inference |
| `delivery_mode` | yes, poll/survey/question only | hint overrides, else `native` | Native unless the brief names an external tool |
| `title` | yes | | 4 to 140 chars |
| `purpose_one_liner` | yes | | 10 to 180 chars, participant-facing |
| `description_optional` | yes | | Participant-facing. What they will do, what to prepare |
| `product_optional` | yes | | Only if the brief names one |
| `participant_type_required` | yes | `any` | `specific` only when the brief states criteria |
| `participant_type_specific_details` | yes, with `specific` | | Copied from the brief, not embellished |
| `default_duration_minutes` | yes | | 5 to 240. Recorded as an assumption unless the brief states it |
| `start_date`, `end_date` | no in v1 | left empty | Highest hallucination risk. Listed as a gap. Open decision |
| `meeting_location_optional` | no | left empty | A link is a session-level fact the researcher sets |
| `external_link_optional` | only verbatim from the brief | | Must pass `isPublishableExternalLink`. Never composed |
| `inline_study.target_url` | only verbatim from the brief | | Must pass `isSafeTargetUrl` |
| `inline_study.steps` | yes, unmoderated only | | `authorableStepTypes`, 1 to 50, prompt max 2000 |
| `inline_survey.steps` | yes, native poll/survey/question | | `authorableSurveyStepTypes`, shape-checked by `findStepShapeProblem`. `question` is exactly one step |
| `inline_*.estimated_duration_minutes` | yes | | Same assumption rule as duration |
| `inline_*.consent_text` | never | `currentConsentTemplate(kind)` | Server fills text, id and version. Recorded kind for unmoderated, survey kind for native surveys |
| `consent_text` (moderated) | never | `currentConsentTemplate('moderated')` | test and interview only |
| `consent_template_id`, `consent_template_version` | never | server | Same |
| `status` | never | `'draft'` | Forced after the model returns, not requested of it |
| `firsthand_study_id`, `copied_from_study_id` | never | absent | Linking existing studies is a picker job |
| `step_key` | never | absent | The client mints identity on apply, exactly as it does for a hand-typed question |
| `expected_study_updated_at` | never | absent | Create path only in v1 |

Sessions for test and interview are out of v1.
The drafter fills the basics and consent for those types and lists "session slots" as a gap.

The zod schemas in `shared/firsthand/` become the JSON schema the model sees through `zodOutputFormat`.
Zod is at 3.25.76 across all three packages, which `@anthropic-ai/sdk/helpers/zod` supports.
The service must import the shared schemas rather than restate them, so a vocabulary change reaches the drafter without a second edit.

### Validation loop

1. Model returns `DraftSchema` output. If `parsed_output` is null or `stop_reason` is `refusal`, return 422 with the reason.
2. Service assembles the create payload: consent from template, status forced, hints applied.
3. `CreateOpportunitySchema.safeParse`. On success, return.
4. On failure, one retry with the flattened issues appended to the user turn as "these fields were refused, fix only these".
5. Second failure returns 422 with the issues. The form shows them and offers the brief back for editing.

Two model calls maximum per request, enforced as a literal the tests pin.

### Frontend

On `/admin/opportunities/new` only, the Basic Information step gains a "Describe it" panel above the study type select.
It is hidden when the capability flag is off.

Flow:

1. Researcher types or dictates a brief and clicks Draft.
2. Panel shows a review list: field, value, and whether it came from the brief, was assumed, or is a gap. Gaps render hatched.
3. Researcher clicks Apply to form. The client sets `formData` from the draft and mints `step_key` for every question or task, the same path a typed one takes. Nothing is saved.
4. The step strip shows which steps are now populated. The researcher walks them, edits, saves and publishes as today.
5. Discard returns the brief to the textarea for editing.

The wireframe is at `docs/wireframes/ai-study-drafting-review.html` and runs as a prototype.

The capability flag reaches the SPA at load.
The exact carrier is a build-time decision, because there is no existing config endpoint to add it to. `/api/health` is one candidate and a static build-time value is the other.

## Guardrails

- Consent is never model-written. The server fills it from the template for the resolved kind. A model-supplied consent field is not in `DraftSchema`, so it cannot arrive
- Status is forced to draft after the model returns. Publish is the researcher's click on the Review step, through the existing gate
- Links are copied, never composed. A URL the brief does not contain is refused by the service before validation, and one it does contain still passes the existing safety predicates
- The brief is untrusted input. The system prompt says it is data. A brief that says "publish this" or "set status to published" produces a draft with status draft, and a test pins that
- No personal data. The system prompt forbids names, emails and identifying details in any participant-facing field
- Brief size cap of 8000 chars, 10 drafts a minute per user, two model calls a request
- One structured log line per draft: user id, type resolved, filled count, tokens used, cache hit. No brief text in the log
- The API key lives in the Kubera secret store beside `SESSION_SECRET` in `.kubera/playground-backend.yaml`, never in the manifest body. Adding it is a manifest change plus a secret-store write, and the secret-store half is Lilly's via the shared channel

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret store | Absent means the endpoint answers 503 and the panel hides |
| `CORTEX_AI_DRAFTING` | manifest env, default off | Kill switch independent of the key |
| `CORTEX_AI_DRAFTING_MODEL` | manifest env, default `claude-opus-5` | Tier override without a deploy of code |

Local development: the key in `.env`, flag on, same code path. Nothing about drafting is stubbed locally, which is the point of iterating here first.

## Cost

Estimates, not measurements. Built from a 3k token cached system prompt, a 1k token brief and a 2k token draft at the September 2026 first-party rates.

| Tier | Per draft, roughly | Notes |
|---|---|---|
| Haiku 4.5 | under 1p | Cheapest. Shape rules are the risk, needs the eval set to prove it |
| Sonnet 5 | about 2p | Likely enough for this task |
| Opus 5 | about 5p | The default the SDK guidance recommends |

At a hundred drafts a week the difference between the top and bottom tier is under three pounds a week.
Pick on the eval set, not on price.

## Testing

Unit, `backend/src/services/__tests__/study-drafter.test.ts`, SDK mocked:

- a brief for each of the six types resolves to that type
- a brief naming an external tool resolves external delivery, one that does not resolves native
- `question` drafts contain exactly one step
- consent text equals the template for the kind, and the id and version are set
- status is draft even when the brief demands published
- a URL not in the brief is stripped, one in the brief survives
- invalid first output triggers exactly one retry, invalid second output returns the issues
- refusal stop reason surfaces as 422, not 500

Integration, `backend/src/routes/__tests__/opportunities-draft.test.ts`:

- 401 without a session, 403 as a participant
- 400 on a 19-char brief and on an 8001-char one
- 503 with the flag off, and with the key absent
- 429 on the eleventh call in a minute
- no row is written to `opportunities` or `firsthand.studies` by a 200

Frontend, `OpportunityForm.__tests__/describe-it.test.tsx`:

- Apply populates `formData` and does not call the save endpoint
- every applied question carries a minted `step_key`
- the panel is absent on the edit route and with the flag off

Eval set, `backend/src/services/__tests__/fixtures/briefs/`:

- ten real-shaped briefs with an expected type, delivery and step count each
- run against the live model on demand, not in CI, and the pass count is recorded in the fixture README as a measurement with a date

Mutation canary entries, added with the change:

- the line forcing `status: 'draft'`
- the line filling consent from the template
- the retry ceiling literal

## Phases

1. Service, endpoint, tests, canary. Backend only. One MR
2. Describe-it panel and the review list, per the wireframe. One MR, pays the canary as every frontend MR does
3. Manifest and secret. Blocked on the secret-store write
4. Later, not this spec: brief import from a URL or file, session slot proposals for test and interview, MCP server once token auth exists

## Open decisions

- Model tier. Default Opus 5, measured on the eval set before phase 3
- Dates. Left empty in v1. Filling them from relative phrases in the brief is a later choice
- Edit route. The panel is new-only in v1. Redrafting a saved opportunity is a different interaction and needs its own look
- Flag carrier. `/api/health` or a build-time value

## Not doing

- Publishing from the drafter, ever
- Session slots in v1
- Model-written consent, ever
- An agent-facing API. That is the MCP issue and it starts with auth, not with AI
