import { getPrimaryTargetUrl } from '../recording/task-target';
import type { StudyStep } from '../../shared/firsthand/contract';
import {
  authorableStepTypes,
  toStudySteps,
  type InlineStudyStep
} from '../../shared/firsthand/inline-study';
import {
  authorableSurveyStepTypes,
  toSurveySteps,
  type SurveyQuestion
} from '../../shared/firsthand/survey-authoring';

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
 * A stored step as the task-list form holds it.
 *
 * `step_id` and `order` are deliberately absent: `inlineStudyStepSchema` does
 * not accept them, and the backend preserves the stored ids positionally on an
 * in-place update rather than taking them from the payload. `target_url` is
 * absent because it is read once, study-level, via `getPrimaryTargetUrl` -
 * `toStudySteps` writes it back onto every step.
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
export const toInlineStudyPayloadStep = (step: InlineStudyStep): InlineStudyStep => ({
  type: step.type,
  prompt: step.prompt.trim(),
  ...(step.type === 'single_choice'
    ? { options: (step.options ?? []).map((option) => option.trim()).filter(Boolean) }
    : {}),
  ...(step.helper_text ? { helper_text: step.helper_text.trim() } : {}),
  ...(step.is_required !== undefined ? { is_required: step.is_required } : {})
});

/** An authored question as the save payload carries it. */
export const toSurveyPayloadStep = (question: SurveyQuestion): SurveyQuestion => ({
  type: question.type,
  prompt: question.prompt.trim(),
  ...(question.type === 'single_choice' || question.type === 'multi_choice'
    ? { options: (question.options ?? []).map((option) => option.trim()).filter(Boolean) }
    : {}),
  ...(question.config ? { config: question.config } : {}),
  ...(question.helper_text ? { helper_text: question.helper_text } : {}),
  ...(question.is_required !== undefined ? { is_required: question.is_required } : {})
});

/**
 * The fields a comparison of two steps should actually look at, normalised the
 * way the payload normalises them.
 *
 * `step_id` and `order` are excluded because the form does not author them and
 * the backend preserves the stored ones. Strings are trimmed on BOTH sides so
 * that a stored prompt with trailing whitespace - which the payload would trim
 * - does not read as a difference the author did not make.
 */
const comparableStep = (step: StudyStep) =>
  JSON.stringify([
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
      ? toSurveySteps(authored.map(toSurveyQuestion).map(toSurveyPayloadStep), studyId)
      : toStudySteps(
          authored.map(toInlineStudyStep).map(toInlineStudyPayloadStep),
          studyId,
          getPrimaryTargetUrl(steps) ?? undefined
        );

  const before = authored.map(comparableStep);
  const after = authoredStepsOf(rewritten).map(comparableStep);

  return before.length === after.length && before.every((step, i) => step === after[i]);
};
