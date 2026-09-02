import { z } from "zod";

import { findStepShapeProblem, stepConfigSchema, type StudyStep } from "./contract";
import {
  AUTHORING_STEP_SHAPE_MESSAGES,
  END_STEP_PROMPT,
  INLINE_STUDY_LIMITS
} from "./inline-study";
import {
  DUPLICATE_STEP_KEY_MESSAGE,
  findDuplicateStepIdentity,
  stepIdFor,
  stepKeySchema
} from "./step-identity";

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
  /**
   * The question's identity, minted once by the client that created it and sent
   * back unchanged on every save. See step-identity.ts for why this exists and
   * why the server namespaces it rather than accepting a whole step id.
   *
   * OPTIONAL, and absence is a real case rather than laxness: a script has no
   * identity to express, and an SPA bundle older than the backend serving it -
   * a real window on every rolling deploy - does not send one. Absence means
   * "this client cannot express identity", and `toSurveySteps` falls back to the
   * pre-F2 positional id for it while the opportunity route keeps its
   * fail-closed guard over that case. What absence must never do is silently
   * look like identity.
   */
  step_key: stepKeySchema.optional(),
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
    /**
     * A CLAIM about which approved wording `consent_text` is. Same field and
     * the same reasoning as `inlineStudySchema`'s - see there - and carried
     * here for the same reason `copied_from_study_id` is: `.strict()` on this
     * object rejects any key it does not declare, so omitting it would 400
     * every survey save that carries a classification rather than merely
     * dropping it the way the non-strict twin would.
     */
    consent_template_id: z.string().min(1).max(100).optional(),
    consent_template_version: z.number().int().positive().optional(),
    /**
     * `null` and absent mean DIFFERENT things, which is why this is nullable
     * rather than merely optional.
     *
     * Absent means "this request says nothing about the duration", and the
     * in-place update path leaves the stored value alone - otherwise a save
     * that only touched consent would erase an estimate set by hand in
     * StudyEditor. Explicit `null` means "the author cleared the field", which
     * has to be storable or a duration could be set on this form and never
     * removed: the field's own help text offers exactly that ("leave it empty
     * if you are not sure"), and the form showed a value it could not unset.
     *
     * Same per-field decision the `kind` and `expires_at` fields already make.
     */
    estimated_duration_minutes: z
      .number()
      .int()
      .positive()
      .max(INLINE_STUDY_LIMITS.maxDurationMinutes)
      .nullable()
      .optional(),
    steps: z
      .array(surveyQuestionSchema)
      .min(1)
      .max(INLINE_STUDY_LIMITS.maxSteps),
    /**
     * The study this one was copied from. Same field and the same reasoning as
     * inlineStudySchema's - see there - carried here too because `.strict()`
     * on this object rejects any key it does not declare: omitting it here
     * would 400 every survey save that carries provenance, rather than merely
     * dropping the field the way the non-strict twin would.
     */
    copied_from_study_id: z.string().min(1).max(200).optional()
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

    // Refused here as well as in the repository, which throws a bare Error the
    // routes answer as a 500. Two questions sharing one identity would store as
    // one row, so this is a save that silently loses a question.
    const duplicate = findDuplicateStepIdentity(value.steps);

    if (duplicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: DUPLICATE_STEP_KEY_MESSAGE,
        path: ["steps", duplicate.index, "step_key"]
      });
    }
  });

/**
 * How many questions an opportunity of this type may ask.
 *
 * A `question` opportunity asks exactly one, and that is the whole of what
 * distinguishes it from a native survey now that both run in SurveyRunner.
 * Without this cap the two types are the same product wearing two names, and
 * the name the PARTICIPANT is shown - "One question" on the browse card and on
 * the study page - is the one that would be lying.
 *
 * A number rather than a boolean because the schema's own `.max()` is the other
 * bound and the two read against each other: this narrows that ceiling for one
 * type, it never widens it.
 */
export const maxQuestionsFor = (type: string): number =>
  type === "question" ? 1 : INLINE_STUDY_LIMITS.maxSteps;

export const TOO_MANY_QUESTIONS_MESSAGE =
  "A one-question opportunity asks exactly one question; use a poll or a survey to ask more";

/**
 * The questions a participant is actually asked, out of steps in either shape.
 *
 * Authored questions (`inline_survey.steps`) carry no `end` marker and stored
 * steps do - `toSurveySteps` appends it - so a count taken over a stored study
 * is one too many unless it is filtered here. Counting the marker would refuse
 * a perfectly legal one-question study on the linking path while accepting the
 * identical one on the authoring path.
 */
export const countAskedQuestions = (
  steps: readonly { type: string }[]
): number => steps.filter((step) => step.type !== "end").length;

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
 *
 * A question that carries a `step_key` gets an id derived from it, and that id
 * is the same one whatever position the question is in. That is the whole of
 * F2: reordering four questions no longer regenerates four ids against
 * different prompts, so answers already collected stay attached to the question
 * that produced them.
 *
 * A question with no key falls back to the pre-F2 positional id. Kept, not
 * removed, because a script and a stale SPA bundle both send key-less payloads
 * and both worked before this change - and because the ids it produces are
 * exactly what an existing study already holds, so nothing has to be rewritten.
 * What protects a key-less UPDATE is the opportunity route's own guard, which
 * still refuses to rewrite the steps of a study that has collected answers.
 */
export function toSurveySteps(
  questions: SurveyQuestion[],
  studyId: string
): StudyStep[] {
  const authored: StudyStep[] = questions.map((question, index) => ({
    step_id: question.step_key
      ? stepIdFor(studyId, question.step_key)
      : `${studyId}_step_${index + 1}`,
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
