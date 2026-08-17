/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 *
 * Copied from the shared/ directory by frontend/copy-shared-types.js. Nothing
 * runs that script for you: edit the source under shared/, then run
 * `node copy-shared-types.js` from frontend/ and commit the result.
 *
 * Source: See copy-shared-types.js for the source path
 */

import { z } from "zod";

import { findStepShapeProblem, stepConfigSchema, type StudyStep } from "./contract";
import {
  AUTHORING_STEP_SHAPE_MESSAGES,
  END_STEP_PROMPT,
  INLINE_STUDY_LIMITS
} from "./inline-study";

/**
 * Authoring for a native poll or survey.
 *
 * This is a SECOND authoring vocabulary, deliberately, and the reason is worth
 * keeping close to the code. `authorableStepTypes` in inline-study.ts is the
 * vocabulary of a RECORDED task list: its participant works through tasks while
 * their screen and voice are captured, and answers out loud. A rating or
 * multi-choice widget has nothing to render into there, which is why that set
 * must never be widened to cover surveys (a regression test pins it, and the
 * frontend typecheck refuted the first attempt).
 *
 * A survey is the opposite shape - it records nothing and types everything - so
 * it gets its own set here. The two share `firsthand.study_steps` for storage
 * and `findStepShapeProblem` for the per-type rules, and nothing else.
 *
 * Which vocabulary applies to a given study is carried by the study's `kind`
 * column rather than inferred from the step types it happens to contain: an
 * instruction-only study is otherwise ambiguous between the two, and inference
 * would let editing a step silently reclassify a study an opportunity is
 * already linked to.
 */
export const authorableSurveyStepTypes = [
  "instruction",
  "open_text",
  "single_choice",
  "multi_choice",
  "rating",
  "nps"
] as const;

export const authorableSurveyStepTypeSchema = z.enum(authorableSurveyStepTypes);

/**
 * `instruction` earns its place: a survey uses it as a section page - a heading
 * and some context before the next block of questions. It is not answerable
 * (see isAnswerable in survey-answers.ts), so the runner shows it and moves on
 * without counting it towards progress.
 *
 * `end` is absent for the same reason it is absent from the recorded set: it is
 * a completion marker the runner filters out, appended by `toSurveySteps`
 * rather than authored.
 */

/**
 * Bounds are shared with inline study authoring rather than restated. They are
 * not a statement about surveys specifically: every step is a row written on
 * the small FirstHand runtime pool that the live participant runtime also uses,
 * so the limit exists to stop one admin request holding a pooled client long
 * enough to time out a participant.
 */
export const surveyQuestionSchema = z.object({
  type: authorableSurveyStepTypeSchema,
  prompt: z.string().trim().min(1).max(INLINE_STUDY_LIMITS.maxPromptLength),
  options: z
    .array(z.string().trim().min(1).max(INLINE_STUDY_LIMITS.maxOptionLength))
    .max(INLINE_STUDY_LIMITS.maxOptions)
    .optional(),
  config: stepConfigSchema.optional(),
  helper_text: z
    .string()
    .trim()
    .min(1)
    .max(INLINE_STUDY_LIMITS.maxPromptLength)
    .optional(),
  is_required: z.boolean().optional()
})
  /**
   * Strict per question, not only on the survey around them.
   *
   * The survey object's own `.strict()` rejects a study-level `target_url`, but
   * without this a PER-QUESTION one was accepted and silently dropped - which
   * is the same silent-strip that discarded every multi_choice, rating and nps
   * answer before 7.36.2, and it would have made the comment below false of
   * exactly the field it is about.
   */
  .strict();

/**
 * The survey a poll or survey opportunity carries.
 *
 * `target_url` is absent, and its absence is the point. A survey has no page
 * under test, and accepting one would hand the participant the recorded
 * runner's task-window affordances - "open the task page", "keep it open or the
 * recording stops" - in a flow that records nothing. `.strict()` makes that a
 * rejection rather than a silent drop, so an author who sends one is told.
 */
export const inlineSurveySchema = z
  .object({
    consent_text: z
      .string()
      .trim()
      .min(1)
      .max(INLINE_STUDY_LIMITS.maxConsentLength),
    estimated_duration_minutes: z
      .number()
      .int()
      .positive()
      .max(INLINE_STUDY_LIMITS.maxDurationMinutes)
      .optional(),
    steps: z
      .array(surveyQuestionSchema)
      .min(1)
      .max(INLINE_STUDY_LIMITS.maxSteps)
  })
  .strict()
  .superRefine((value, ctx) => {
    // Same rules as the runtime contract and the repository, reported against
    // the question being edited so the author is told which one is wrong.
    value.steps.forEach((step, index) => {
      const problem = findStepShapeProblem(step);

      if (problem) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: AUTHORING_STEP_SHAPE_MESSAGES[problem.code],
          path: ["steps", index, problem.field]
        });
      }
    });
  });

/**
 * Pre-filled into the required Consent field on every new native survey.
 *
 * NOT `DEFAULT_CONSENT_TEXT` from inline-study.ts, which is about a session that
 * records screen and microphone. A survey records nothing, so reusing that text
 * would have participants agreeing to a capture that never happens - consent
 * copy is the last place to describe something the product does not do.
 */
export const DEFAULT_SURVEY_CONSENT_TEXT =
  "Your answers are stored for research analysis and are visible to the research team. " +
  "Nothing is recorded: no screen, no microphone and no camera. " +
  "You can close the page at any point, and anything you have already answered is kept.";

export type SurveyQuestion = z.infer<typeof surveyQuestionSchema>;
export type InlineSurvey = z.infer<typeof inlineSurveySchema>;

/**
 * Expand authored questions into contract-shaped `StudyStep`s.
 *
 * Mirrors `toStudySteps` and shares its step-id namespacing for the same
 * reason: `firsthand.study_steps.id` is a global TEXT PRIMARY KEY, so
 * position-only ids collide the second time anything authors a study. The
 * composite primary key added alongside this work removes the collision at the
 * schema level, but the namespacing stays - de-namespacing would make
 * `participant_responses.step_id` values indistinguishable across studies
 * without their session context.
 */
export function toSurveySteps(
  questions: SurveyQuestion[],
  studyId: string
): StudyStep[] {
  const authored: StudyStep[] = questions.map((question, index) => ({
    step_id: `${studyId}_step_${index + 1}`,
    order: index + 1,
    type: question.type,
    prompt: question.prompt.trim(),
    ...(question.options ? { options: question.options } : {}),
    ...(question.config ? { config: question.config } : {}),
    ...(question.helper_text ? { helper_text: question.helper_text } : {}),
    ...(question.is_required !== undefined
      ? { is_required: question.is_required }
      : {})
  }));

  return [
    ...authored,
    {
      step_id: `${studyId}_step_end`,
      order: authored.length + 1,
      type: "end",
      prompt: END_STEP_PROMPT
    }
  ];
}
