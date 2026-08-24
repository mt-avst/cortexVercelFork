import { mintClientId, withClientIds, type WithClientId } from './client-ids';
import { stepKeyOf } from '@shared/firsthand/step-identity';
import { getPrimaryTargetUrl } from '../recording/task-target';
import type { StudyStep } from '@shared/firsthand/contract';
import { CUSTOM_CONSENT_TEMPLATE_ID } from '@shared/firsthand/consent-templates';
import type { FirstHandStudy } from '@shared/types';
import {
  authorableStepTypes,
  toStudySteps,
  type InlineStudyStep
} from '@shared/firsthand/inline-study';
import {
  authorableSurveyStepTypes,
  toSurveySteps,
  type SurveyQuestion
} from '@shared/firsthand/survey-authoring';

/**
 * Reading a stored study into the opportunity form, and writing it back out.
 *
 * BOTH directions live here, together, on purpose. They used to be a
 * hydration whitelist near the top of OpportunityForm.tsx and a payload
 * whitelist two thousand lines below it, and they disagreed: hydration kept
 * `helper_text` and `is_required`, serialisation dropped them. Because A0
 * applies a save by deleting every `study_steps` row and re-inserting what the
 * payload carried, that disagreement DELETED both fields from any study built
 * in the Task Lists area - on a save where the author had changed nothing but
 * the opportunity's title, reported as success.
 *
 * Keeping the inverse next to the function it inverts is most of the fix. The
 * rest is `studyRoundTripsCleanly`, which stops trusting either list and
 * checks the actual round trip.
 */

const AUTHORABLE_TASK_TYPES: ReadonlySet<string> = new Set(authorableStepTypes);
const AUTHORABLE_QUESTION_TYPES: ReadonlySet<string> = new Set(authorableSurveyStepTypes);

/** Which authoring vocabulary a study is written in. */
export type AuthoringKind = 'recorded' | 'survey';

/**
 * Why a linked study is not editable on the opportunity form.
 *
 * `not-yours` and `not-representable` need different sentences: only the second
 * can be resolved in the Task Lists area, because StudyEditor applies the same
 * ownership rule and would refuse the first as well. Null means a banner above
 * the tabs already explains it.
 */
export type StudyReadOnlyReason = 'not-yours' | 'not-representable' | null;

/**
 * The stored steps this form is being asked to author, with the completion
 * marker removed.
 *
 * `end` is appended at serialisation by `toStudySteps`/`toSurveySteps` and is
 * never authored, so hydrating it would show the author a task they did not
 * write and then write a second one on the next save.
 */
export const authoredStepsOf = (steps: StudyStep[]): StudyStep[] =>
  steps.filter((step) => step.type !== 'end');

/**
 * A hydrated list, carrying the identity its stored steps already have.
 *
 * This is what makes a reorder safe. `_clientId` started as a rendering key -
 * something for React to key a card on that reordering does not change - and F2
 * promotes it to the question's PERSISTED identity: it is recovered here from
 * the stored step id, sent back as `step_key` by the payload builders below,
 * and namespaced back into the same id by `toSurveySteps`/`toStudySteps`. So a
 * question keeps one identity from the moment it is created until it is
 * deleted, whatever position it is dragged to in between.
 *
 * Positional by index rather than matched by anything, because that is exactly
 * what it is: `items` is `steps.map(...)`, the two lists are the same list at
 * this instant, and no reordering has happened yet.
 *
 * The `?? mintClientId()` fallback is for a stored id that is NOT in this
 * study's namespace, which nothing this product writes produces. It is not a
 * silent repair: a minted id round-trips to a DIFFERENT step id, so
 * `studyRoundTripsCleanly` refuses the study and the author is offered it
 * read-only rather than handed a form that would renumber it on save.
 *
 * NOT used for a copy. A copied question is a new question and gets a fresh
 * identity from `withClientIds` - inheriting the source's would make two
 * studies' questions claim the same keys for no benefit, since the stored ids
 * are namespaced per study anyway.
 */
export const withStoredIdentity = <T extends object>(
  items: readonly T[],
  steps: StudyStep[],
  studyId: string
): WithClientId<T>[] =>
  items.map((item, index) => ({
    ...item,
    _clientId: stepKeyOf(steps[index]?.step_id ?? '', studyId) ?? mintClientId()
  }));

/**
 * A stored step as the task-list form holds it.
 *
 * `step_id` and `order` are deliberately absent, and the reason for `step_id`
 * changed with F2: the backend used to preserve the stored ids POSITIONALLY on
 * an in-place update, and now the form carries identity explicitly instead -
 * as `_clientId` here (`withStoredIdentity`) and as `step_key` in the payload.
 * A whole id is still never sent, so a caller cannot mint one claiming to
 * belong to another study. `order` stays derived from array position, which is
 * the only ordering the form can express.
 *
 * `target_url` is absent because it is read once, study-level, via
 * `getPrimaryTargetUrl` - `toStudySteps` writes it back onto every step.
 */
export const toInlineStudyStep = (step: StudyStep): InlineStudyStep => ({
  type: step.type as InlineStudyStep['type'],
  prompt: step.prompt,
  ...(step.options ? { options: [...step.options] } : {}),
  ...(step.helper_text ? { helper_text: step.helper_text } : {}),
  ...(step.is_required !== undefined ? { is_required: step.is_required } : {})
});

/**
 * A stored step as the survey form holds it.
 *
 * Same as `toInlineStudyStep` plus `config`, which carries a rating scale.
 * `surveyQuestionSchema` is `.strict()`, so anything else round-tripped into
 * state would be REFUSED on save rather than dropped.
 */
export const toSurveyQuestion = (step: StudyStep): SurveyQuestion => ({
  type: step.type as SurveyQuestion['type'],
  prompt: step.prompt,
  ...(step.options ? { options: [...step.options] } : {}),
  ...(step.config ? { config: { ...step.config } } : {}),
  ...(step.helper_text ? { helper_text: step.helper_text } : {}),
  ...(step.is_required !== undefined ? { is_required: step.is_required } : {})
});

/**
 * An authored task as the save payload carries it.
 *
 * The blank-option filter is not cosmetic: an empty option row is UI
 * scaffolding, and `inlineStudyStepSchema` rejects an empty string, so a
 * trailing blank would fail the whole save.
 */
export const toInlineStudyPayloadStep = (
  step: WithClientId<InlineStudyStep>
): InlineStudyStep => ({
  // The task's identity, promoted from the rendering key. This is the ONE field
  // whose absence would silently restore positional ids, so it is listed first
  // and `step_key` is declared on `inlineStudyStepSchema` - which is not
  // `.strict()`, and would therefore have dropped it in silence.
  step_key: step._clientId,
  type: step.type,
  prompt: step.prompt.trim(),
  ...(step.type === 'single_choice'
    ? { options: (step.options ?? []).map((option) => option.trim()).filter(Boolean) }
    : {}),
  ...(step.helper_text ? { helper_text: step.helper_text.trim() } : {}),
  ...(step.is_required !== undefined ? { is_required: step.is_required } : {})
});

/**
 * The question types a `config` means anything on.
 *
 * `findStepShapeProblem` in the contract is the reason this list is exactly
 * these two: `rating` REQUIRES `config.scale_max` and `multi_choice` may carry
 * `min_selections`/`max_selections`, while `nps` is REFUSED outright if a scale
 * arrives with it - NPS is fixed at 0 to 10 and an author-set scale would
 * produce numbers nothing records the meaning of.
 *
 * That refusal is why this whitelist exists at all. Changing a question's type
 * now PRESERVES its options and config in form state, so switching a rating to
 * an NPS and back restores the scale the author chose. Sending the leftover
 * would fail the whole save, naming a field the form is no longer showing.
 * Preserve in state, strip here.
 *
 * Narrowing this narrows `studyRoundTripsCleanly` with it: a STORED question of
 * another type carrying a config is now offered read-only rather than loaded
 * into a form that would drop it. That is the safe direction, and StudyEditor -
 * the only other authoring surface - writes `config` for `rating` alone, so
 * nothing this product creates lands there.
 *
 * It is a small LOSS OF CAPABILITY rather than a prevention of loss, though,
 * and worth stating plainly: `stepConfigSchema` permits `min_label`/`max_label`
 * on any type and `findStepShapeProblem` accepts them, so a question written
 * through the study API directly is storable, WAS editable here, and is now
 * read-only. StudyEditor still edits it losslessly, which is exactly what the
 * read-only banner tells the author to do.
 */
const CONFIGURABLE_QUESTION_TYPES: ReadonlySet<SurveyQuestion['type']> = new Set([
  'rating',
  'multi_choice'
]);

/** An authored question as the save payload carries it. */
export const toSurveyPayloadStep = (
  question: WithClientId<SurveyQuestion>
): SurveyQuestion => ({
  // See `toInlineStudyPayloadStep`. `surveyQuestionSchema` IS `.strict()`, so
  // here the field had to be declared on the schema or the whole save would
  // have been refused rather than quietly losing identity - which is the better
  // of the two failures, and is why this one was found first.
  step_key: question._clientId,
  type: question.type,
  prompt: question.prompt.trim(),
  ...(question.type === 'single_choice' || question.type === 'multi_choice'
    ? { options: (question.options ?? []).map((option) => option.trim()).filter(Boolean) }
    : {}),
  ...(question.config && CONFIGURABLE_QUESTION_TYPES.has(question.type)
    ? { config: question.config }
    : {}),
  ...(question.helper_text ? { helper_text: question.helper_text } : {}),
  ...(question.is_required !== undefined ? { is_required: question.is_required } : {})
});

/**
 * The fields a comparison of two steps should actually look at, normalised the
 * way the payload normalises them.
 *
 * `step_id` is INCLUDED, and that inclusion is the point after F2. The form now
 * round-trips a question's identity as well as its content, so a study whose
 * stored ids this form would not write back unchanged is a study it must not
 * edit - the save would renumber every question and detach every answer already
 * collected. Excluding it would have made that the one kind of loss this check
 * could not see, which is precisely the failure the check was built to end.
 *
 * `order` is still excluded: it is derived from array position at both ends, so
 * it can only restate what the comparison already knows.
 *
 * Strings are trimmed on BOTH sides so that a stored prompt with trailing
 * whitespace - which the payload would trim - does not read as a difference the
 * author did not make.
 */
const comparableStep = (step: StudyStep) =>
  JSON.stringify([
    step.step_id,
    step.type,
    step.prompt.trim(),
    (step.options ?? []).map((option) => option.trim()).filter(Boolean),
    step.config ?? null,
    step.helper_text?.trim() ?? null,
    step.is_required ?? false,
    step.target_url?.trim() ?? null
  ]);

/**
 * Whether this form can write the study back exactly as it found it.
 *
 * The question that matters is NOT "is every step type in the vocabulary" -
 * that is merely the dimension easiest to check, and checking only it is how
 * `helper_text`, `is_required` and per-step `target_url` were all lost while a
 * type-only guard reported everything fine.
 *
 * So this runs the round trip and compares: hydrate the stored steps, build the
 * payload from them, re-expand it with the same `toStudySteps`/`toSurveySteps`
 * the backend will store, and require the result to match what is already
 * there. Anything the form would silently drop, flatten or rewrite shows up as
 * a mismatch, and the study is offered read-only instead of being loaded into a
 * surface that would destroy part of it on the next save.
 *
 * Two known mismatches this catches today, neither of which was special-cased:
 * a recorded study whose steps carry DIFFERENT `target_url`s, because
 * `toStudySteps` stamps one study-level URL onto all of them; and any step
 * type outside the vocabulary, which the type check caught before and still
 * does - as one instance of the general rule rather than the whole rule.
 */
export const studyRoundTripsCleanly = (
  steps: StudyStep[],
  kind: AuthoringKind,
  studyId: string
): boolean => {
  const authored = authoredStepsOf(steps);
  const vocabulary = kind === 'survey' ? AUTHORABLE_QUESTION_TYPES : AUTHORABLE_TASK_TYPES;

  // Checked first and separately: the casts inside the hydrators assume the
  // type is in the vocabulary, so a step outside it must not reach them.
  if (!authored.every((step) => vocabulary.has(step.type))) {
    return false;
  }

  const rewritten =
    kind === 'survey'
      ? toSurveySteps(
          withStoredIdentity(authored.map(toSurveyQuestion), authored, studyId).map(
            toSurveyPayloadStep
          ),
          studyId
        )
      : toStudySteps(
          withStoredIdentity(authored.map(toInlineStudyStep), authored, studyId).map(
            toInlineStudyPayloadStep
          ),
          studyId,
          getPrimaryTargetUrl(steps) ?? undefined
        );

  const before = authored.map(comparableStep);
  const after = authoredStepsOf(rewritten).map(comparableStep);

  return before.length === after.length && before.every((step, i) => step === after[i]);
};

/**
 * The form fields a copy sets, and nothing else.
 *
 * Kept separate from the edit-mode hydration in `loadOpportunity` even though
 * the two transform the same steps the same way, because they differ on the one
 * thing that matters most and would otherwise be shared by accident: a copy is
 * NEVER read-only. Edit-mode hydration asks `can_edit` and, when the answer is
 * false, swaps the whole surface for a read-only one. Running that rule over a
 * copy would produce the exact defect this step exists to remove - copying a
 * colleague's questions and landing in a form that will not let you change
 * them, because the ownership of the SOURCE was consulted about the copy.
 *
 * The source's ownership is irrelevant here and is not read. What the copy
 * becomes is decided by who saves it: the inline path mints a new study owned
 * by the current user.
 *
 * `withClientIds` is applied here rather than by the caller because a list
 * without them keys on `undefined` and B2's whole card identity collapses -
 * that mutation survived on the survey twin last time precisely because one of
 * two call sites was easy to miss.
 *
 * `duration_auto` comes back FALSE, carrying the source's stored number. Same
 * reasoning A1 recorded for edit-mode hydration: a stored duration was decided
 * by a human, and a copy of a decision is still a decision. Re-deriving the
 * estimate would silently overwrite it on first save.
 */
export type CopiedSurveyFields = {
  inline_survey_questions: WithClientId<SurveyQuestion>[];
  inline_survey_consent_text: string;
  inline_survey_consent_template_id: string;
  inline_survey_consent_template_version: number | null;
  inline_survey_duration_minutes: number | undefined;
  inline_survey_duration_auto: boolean;
};

export type CopiedRecordedFields = {
  inline_study_steps: WithClientId<InlineStudyStep>[];
  inline_study_consent_text: string;
  inline_study_consent_template_id: string;
  inline_study_consent_template_version: number | null;
  inline_study_duration_minutes: number | undefined;
  inline_study_duration_auto: boolean;
  inline_study_target_url: string;
};

/**
 * The study fields a copy reads.
 *
 * A NAMED Pick over `FirstHandStudy`, and the two functions below carry EXPLICIT
 * return types, and both of those are load-bearing rather than tidiness.
 *
 * These functions used to take an inline structural literal and infer their
 * return type. Adding a field to the study was therefore not a compile error
 * anywhere: the call site passes a variable, not a fresh object, so a wider
 * type is assignable to a narrower one in silence; the bodies enumerate their
 * outputs rather than spreading; and an inferred return type spread into
 * `{ ...prev, ...copied }` type-checks whatever it contains. A copy would have
 * carried CUSTOM consent wording while claiming the DEFAULT template - the
 * exact lie this step exists to prevent - with a green build either side of it.
 *
 * With the return type written down, omitting a field is a compile error in the
 * function that omits it. With the parameter named, widening what a copy reads
 * is a deliberate edit here rather than an accident somewhere else.
 */
export type CopyableStudy = Pick<
  FirstHandStudy,
  | 'consent_text'
  | 'estimated_duration_minutes'
  | 'consent_template_id'
  | 'consent_template_version'
>;

export const copiedSurveyFields = (
  study: CopyableStudy,
  steps: StudyStep[]
): CopiedSurveyFields => ({
  inline_survey_questions: withClientIds(authoredStepsOf(steps).map(toSurveyQuestion)),
  inline_survey_consent_text: study.consent_text,
  // A copy inherits the SOURCE's classification, not a fresh one. The wording
  // came from that study, so claiming the current template for it would be
  // asserting an approval nobody granted to this text - and if the source ran
  // on custom wording, the copy runs on custom wording. Null means the source's
  // provenance was never established, which is not the same as approved, so it
  // reads as custom here too.
  inline_survey_consent_template_id:
    study.consent_template_id ?? CUSTOM_CONSENT_TEMPLATE_ID,
  inline_survey_consent_template_version: study.consent_template_version ?? null,
  inline_survey_duration_minutes: study.estimated_duration_minutes ?? undefined,
  inline_survey_duration_auto: false
});

/** The recorded twin of `copiedSurveyFields`. Same rules, different vocabulary. */
export const copiedRecordedFields = (
  study: CopyableStudy,
  steps: StudyStep[]
): CopiedRecordedFields => ({
  inline_study_steps: withClientIds(authoredStepsOf(steps).map(toInlineStudyStep)),
  inline_study_consent_text: study.consent_text,
  inline_study_consent_template_id:
    study.consent_template_id ?? CUSTOM_CONSENT_TEMPLATE_ID,
  inline_study_consent_template_version: study.consent_template_version ?? null,
  inline_study_duration_minutes: study.estimated_duration_minutes ?? undefined,
  inline_study_duration_auto: false,
  inline_study_target_url: getPrimaryTargetUrl(steps) ?? ''
});

/**
 * Whether the author has asked to start from an existing study and has not
 * chosen one yet.
 *
 * Exported and shared because TWO surfaces now depend on it and they must not
 * drift: the content step renders the picker in this state, and the Consent
 * step must refuse to render a consent editor in it - the wording that will
 * arrive belongs to whichever study is picked, so offering to author it first
 * asks the author to consent on behalf of content that does not exist yet.
 * Computed from form data alone, deliberately, so a step that cannot see the
 * content step's local UI state can still answer the question.
 */
export const isAwaitingCopiedContent = (state: {
  hasLinkedStudy: boolean;
  studyIsReadOnly: boolean;
  sourceMode: string;
  copiedFromStudyId: string;
}): boolean =>
  !state.hasLinkedStudy &&
  !state.studyIsReadOnly &&
  state.sourceMode === 'copy' &&
  !state.copiedFromStudyId;
