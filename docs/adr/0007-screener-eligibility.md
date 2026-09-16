# Screener eligibility on opportunities

A researcher can attach a screener to an opportunity so only the right people take part.
It is a small set of single-choice questions, each answer flagged qualify or screen out, evaluated automatically before the study starts.

## Where the two halves live

The screener DEFINITION is a validated JSONB column on `opportunities` (`screener`), authored, stored and read as one blob with the study and never queried across studies.
The participant VERDICT is a real indexed table (`opportunity_screener_responses`, unique on `(opportunity_id, user_id)`), because it is the enforcement key looked up on every apply and it is integrity-critical.
Config-as-JSONB, records-as-rows: relational question/option tables would add integrity surface a light feature does not need, and a JSONB verdict could not carry a foreign key.

## Absence is the only "no screener"

There is no `enabled` flag.
A screener is present (JSONB with at least one question) or it is null.
That removes the ambiguous "disabled but has questions" state and makes the enforcement rule exact: a screener that exists always gates.
A valid screener therefore must have at least one question, at least one qualifying answer per question, and at least one screen-out answer overall - a screener nobody can pass, or one that filters no-one, is a mistake, not a degenerate no-op (`shared/screener.ts`).

## Enforcement is one guard at three chokepoints

`assertScreenerPassed` is called at `POST /bookings/sessions/:id/book`, `POST /opportunities/:id/recorded-study-session` and `POST /opportunities/:id/survey-session`.
No screener is a no-op; otherwise anyone without a stored `qualified` verdict is refused 403, and it fails closed - any outcome other than the exact string `qualified` refuses.
The external-delivery poll/survey is the one gap: it is a `window.open` hand-off the server never sees, and its `external_link_optional` is deliberately not redacted (a participant needs the link), so a screener on an external-delivery study is NOT enforced server-side and can only be gated in the client before the tab opens.
That client gate ships with the frontend (MR2), where it earns a `ponytail:` marker at the site and a tracked GitLab issue.
Until then a screener on an external-delivery study does not gate - a known ceiling, recorded here rather than hidden.

## The verdict snapshots what it judged

Each verdict stores `questions_snapshot`, the screener as it was evaluated, exactly like the moderated-consent `consent_text_snapshot`.
Editing an opportunity's screener later cannot rewrite a verdict already given.

## disqualifies is owner-only

The `disqualifies` flag never reaches a participant, who would otherwise know which answer to avoid.
`opportunities` is returned with `SELECT *` / `RETURNING *`, and `publicOpportunity.ts` is a deny-list that publishes new columns by default, so the screener is redacted there - `disqualifies` stripped, the shape failing closed on anything unexpected.
This is a real infoleak boundary with its own test, not a nicety.

## v1 scope, and what is deferred

Auto-evaluated, single-choice questions only, latest answer wins (a screened-out participant may retake - the answers are self-reported, so it is ungameable either way).
Deferred with room to slot in without rework: researcher/manual review, quotas, multi-select and scored screeners.
AUDIENCE enforcement (internal/partner/customer) is deferred deliberately - Cortex is internal-only today, so enforcing it would gate nothing; when partners then customers arrive it becomes the cheap outer gate, and the existing `participant_type_required` field is where it plugs in.
