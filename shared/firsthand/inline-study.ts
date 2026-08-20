import { z } from "zod";

import type { StepShapeProblem, StudyStep } from "./contract";
import { findStepShapeProblem } from "./contract";
import { isSafeTargetUrl } from "./url-safety";

/**
 * Wording for the authoring boundary. Same rules as the runtime contract, but
 * addressed to the person editing the question rather than to whoever is
 * debugging a rejected payload - which is why the messages are duplicated here
 * rather than shared. The rules themselves are not: see findStepShapeProblem.
 */
export const AUTHORING_STEP_SHAPE_MESSAGES: Record<
  StepShapeProblem["code"],
  string
> = {
  choice_needs_options: "A choice step needs at least two options",
  selection_range_inverted:
    "The most selections allowed cannot be fewer than the fewest required",
  selection_min_exceeds_options:
    "This asks for more selections than there are options",
  rating_needs_scale: "Choose how many points the rating scale has",
  rating_scale_out_of_range: "A rating scale can have between 2 and 10 points",
  nps_scale_not_authorable:
    "An NPS question is always 0 to 10, so it has no scale to set",
  nps_takes_no_options: "An NPS question does not take options"
};

/**
 * Inline study authoring for unmoderated opportunities.
 *
 * An unmoderated opportunity cannot run without a study: the study holds the
 * prompts the participant answers and the consent they accept. Requiring the
 * author to create that study separately, launch it, and then come back and
 * pick it from a dropdown made a two-object model visible for a job that is
 * almost always one-to-one. This module lets the opportunity form carry the
 * study's content directly, so the backend can create the study as part of
 * creating the opportunity.
 *
 * The separate Task Lists area is unchanged and remains the place to edit a script
 * or reuse one across several opportunities.
 */

/**
 * Step types an author can write.
 *
 * `end` is deliberately absent: it is a completion marker the runner never
 * renders (see StudyRunner, which filters it out of the task list), so it is
 * appended by `toStudySteps` rather than authored. Spelled out rather than
 * derived from `stepTypeSchema` so that adding a machine-only step type later
 * cannot silently expose it in the authoring UI.
 */
/**
 * Deliberately NOT widened with the native survey types (`multi_choice`,
 * `rating`, `nps`). This set is the vocabulary of a recorded first-hand task
 * list, where answers are now spoken aloud rather than typed, so a rating
 * widget has nothing to render into. Native surveys author from their own set,
 * which is why the contract's `stepTypes` is wider than this one.
 */
export const authorableStepTypes = [
  "instruction",
  "open_text",
  "single_choice"
] as const;

export const authorableStepTypeSchema = z.enum(authorableStepTypes);

/**
 * Bounds exist because every step is a row on the FirstHand runtime pool, which
 * is small (max 5 connections) and shared with the live participant runtime. An
 * unbounded payload is one admin request away from holding a pooled client long
 * enough to time out participant traffic. The numbers are generous for real
 * authoring, not tight.
 */
export const INLINE_STUDY_LIMITS = {
  maxSteps: 50,
  maxPromptLength: 2000,
  maxConsentLength: 10000,
  maxOptions: 20,
  maxOptionLength: 500,
  // studies.estimated_duration_minutes is a Postgres INTEGER, so an unbounded
  // value overflows and surfaces as a 500 rather than a validation error. A day
  // is far beyond any real session.
  maxDurationMinutes: 24 * 60,
  maxTargetUrlLength: 2000
} as const;

/**
 * Every string is `.trim()`ed BEFORE `.min(1)` rather than after.
 *
 * The order matters: validating first and trimming later let "   " satisfy
 * min(1) and then reach storage as "", producing a study whose prompt or
 * consent text is empty. Nothing downstream rejects that - the columns are TEXT
 * NOT NULL and validateSteps does not check emptiness - but assembling a
 * session payload from it fails the contract's own min(1), so every participant
 * who started that study got a 500. Trimming inside the schema means the
 * validated value is the stored value.
 *
 * `step_id` and `order` are absent by design: they are bookkeeping the author
 * should never have to invent, and `toStudySteps` derives both from array
 * position, which is also the only ordering the form can express.
 */
export const inlineStudyStepSchema = z.object({
  type: authorableStepTypeSchema,
  prompt: z.string().trim().min(1).max(INLINE_STUDY_LIMITS.maxPromptLength),
  options: z
    .array(z.string().trim().min(1).max(INLINE_STUDY_LIMITS.maxOptionLength))
    .max(INLINE_STUDY_LIMITS.maxOptions)
    .optional(),
  helper_text: z.string().trim().min(1).max(INLINE_STUDY_LIMITS.maxPromptLength).optional(),
  is_required: z.boolean().optional()
});

/**
 * Shown by the schema and by the form. Exported so the two cannot drift into
 * saying different things about the same rule.
 */
export const UNSAFE_TARGET_URL_MESSAGE =
  "Enter an http(s) address, or a path beginning with a single /";

export const inlineStudySchema = z
  .object({
    /**
     * The page the participant opens and shares before recording starts.
     *
     * Study-level rather than per-step, which is how the job is actually
     * described ("test this page"), even though the contract carries
     * `target_url` per step: `toStudySteps` applies it to every authored step,
     * because the setup handoff reads the first one while StudyRunner needs it
     * on the current step to keep offering the task window.
     *
     * Optional, and its absence is meaningful: a study with no target on any
     * step is not a first-hand study at all, and the setup flow falls back to a
     * single start action instead of the open-then-share sequence. That is the
     * right shape for a pure questionnaire.
     *
     * Validated with the same `isSafeTargetUrl` the contract and the window
     * sink use - the task page is opened as a same-origin about:blank and then
     * navigated by assigning location.href, so a javascript: URL here would
     * execute against the participant's session.
     */
    target_url: z
      .string()
      .trim()
      .min(1)
      .max(INLINE_STUDY_LIMITS.maxTargetUrlLength)
      .refine(isSafeTargetUrl, { message: UNSAFE_TARGET_URL_MESSAGE })
      .optional(),
    consent_text: z.string().trim().min(1).max(INLINE_STUDY_LIMITS.maxConsentLength),
    /**
     * A CLAIM about which approved wording `consent_text` is, carried from the
     * form so a study stays attributed to the template VERSION it was written
     * against once a later version ships. Never an instruction: the repository
     * checks the claim against the text and downgrades it to `custom` when the
     * two disagree, so a caller can understate its approval and can never
     * overstate it. See shared/firsthand/consent-templates.ts.
     *
     * This object is NOT `.strict()` - unlike its survey twin - so an
     * undeclared key here is dropped in silence rather than refused. That is
     * exactly why these two are declared on BOTH schemas in the same change:
     * the same omission fails loudly on one path and invisibly on the other,
     * and the invisible one is a study claiming approved wording it does not
     * carry.
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
    steps: z.array(inlineStudyStepSchema).min(1).max(INLINE_STUDY_LIMITS.maxSteps),
    /**
     * The study this one was copied from, recorded by the picker at the moment
     * of copy-on-select rather than a live link. Optional: absent for a study
     * authored from blank. Never trusted as an authorisation key - it is
     * carried straight through to CreateStudyInput.copied_from_study_id and
     * stored as-is; see migration 0012.
     */
    copied_from_study_id: z.string().min(1).max(200).optional()
  })
  .superRefine((value, ctx) => {
    // Mirrors the rule enforced in studies-repository.validateSteps. Duplicated
    // here so the author gets the error against the step they are editing
    // rather than a generic create failure after submit.
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

export type InlineStudyStep = z.infer<typeof inlineStudyStepSchema>;
export type InlineStudy = z.infer<typeof inlineStudySchema>;

/**
 * Shown to the participant once every authored step is done. Not authorable:
 * the runner treats the end step as a marker and never displays its prompt, but
 * the contract requires a non-empty prompt on every step.
 */
export const END_STEP_PROMPT = "Thanks - that is the end of the study.";

/**
 * Pre-filled into the required Consent field on every new unmoderated study.
 * Unless a researcher rewrites boilerplate the product handed them, this IS the
 * consent a participant accepts before recording starts - so it has to be true
 * about the thing it is hardest to be true about.
 *
 * It used to end "You can stop at any time." There is no stop, withdraw or exit
 * control anywhere in the recording flow: recording ends when the shared
 * display track fires `ended` (session-recorder.ts), which only the browser's
 * own Stop sharing does, and the partial recording is uploaded regardless.
 * Consent is exactly the wrong place to overstate a participant's control, and
 * the sentence also contradicted Cortex's own non-authorable "Before you start"
 * panel further down the same page.
 */
export const DEFAULT_CONSENT_TEXT =
  "This session records your screen and microphone while you complete the tasks. " +
  "The recording is used for research analysis and is visible to the research team. " +
  "You can end the recording whenever you want by stopping the screen share, and " +
  "anything recorded up to that point is still sent to the research team.";

/**
 * Expand authored steps into contract-shaped `StudyStep`s.
 *
 * Assigns `step_id` and `order` from array position, and appends the `end`
 * completion marker. Optional fields are omitted rather than set to undefined
 * so the result matches what `stepSchema` expects for an absent field.
 *
 * `studyId` is required and prefixes every step id, because step ids are NOT
 * scoped to their study in storage: `firsthand.study_steps.id` is a global
 * `TEXT PRIMARY KEY` (0004_firsthand_studies.sql), and `insertStudySteps`
 * writes `step_id` straight into it. Position-only ids such as `step_1` would
 * therefore collide the second time anything authored a study this way, and the
 * resulting unique violation surfaces as a misleading 409 about the
 * opportunity. Prefixing with the study's own id makes collision impossible
 * without changing the schema or the hand-authored editor's behaviour.
 */
export function toStudySteps(
  steps: InlineStudyStep[],
  studyId: string,
  targetUrl?: string
): StudyStep[] {
  const authored: StudyStep[] = steps.map((step, index) => ({
    step_id: `${studyId}_step_${index + 1}`,
    order: index + 1,
    type: step.type,
    prompt: step.prompt.trim(),
    // The starting URL goes on EVERY authored step, not just the first.
    //
    // getPrimaryTargetUrl only needs it on one - it finds the first runnable
    // step carrying a target, for the setup handoff before the runner mounts.
    // But it is not the only consumer: StudyRunner renders TaskWindowPanel
    // (the "Go to the task page" button and the "keep the task window open or
    // the recording stops" warning) only when the CURRENT step carries one. On
    // first-step-only, a participant who buried or closed the popup during task
    // 2 had no way to bring it back and had never been warned. It also made an
    // inline study a different shape from the same study built by hand in
    // StudyEditor, which sets the target per step.
    //
    // Safe to repeat: task-window.ts focuses rather than reopens when the URL
    // is unchanged, so this does not spawn a window per task. The appended
    // `end` marker is added after this map and never gets one.
    ...(targetUrl ? { target_url: targetUrl.trim() } : {}),
    ...(step.options ? { options: step.options } : {}),
    ...(step.helper_text ? { helper_text: step.helper_text } : {}),
    ...(step.is_required !== undefined ? { is_required: step.is_required } : {})
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
