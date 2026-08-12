/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * 
 * This file is automatically copied from the shared/ directory during the build process.
 * Any changes should be made to the source file in the shared/ directory.
 * 
 * Source: See copy-shared-types.js for the source path
 * Generated: 2026-08-12T22:31:13.732Z
 */

import { z } from "zod";

import type { StudyStep } from "./contract";

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
 * The separate studies area is unchanged and remains the place to edit a script
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
export const authorableStepTypes = [
  "instruction",
  "open_text",
  "single_choice"
] as const;

export const authorableStepTypeSchema = z.enum(authorableStepTypes);

/**
 * `step_id` and `order` are absent by design. They are bookkeeping the author
 * should never have to invent, and `toStudySteps` derives both from array
 * position, which is also the only ordering the form can express.
 */
export const inlineStudyStepSchema = z.object({
  type: authorableStepTypeSchema,
  prompt: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(500)).max(20).optional(),
  helper_text: z.string().min(1).max(2000).optional(),
  is_required: z.boolean().optional()
});

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
  maxDurationMinutes: 24 * 60
} as const;

export const inlineStudySchema = z
  .object({
    consent_text: z.string().min(1).max(INLINE_STUDY_LIMITS.maxConsentLength),
    estimated_duration_minutes: z
      .number()
      .int()
      .positive()
      .max(INLINE_STUDY_LIMITS.maxDurationMinutes)
      .optional(),
    steps: z.array(inlineStudyStepSchema).min(1).max(INLINE_STUDY_LIMITS.maxSteps)
  })
  .superRefine((value, ctx) => {
    // Mirrors the rule enforced in studies-repository.validateSteps. Duplicated
    // here so the author gets the error against the step they are editing
    // rather than a generic create failure after submit.
    value.steps.forEach((step, index) => {
      if (
        step.type === "single_choice" &&
        (!step.options || step.options.length < 2)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A choice step needs at least two options",
          path: ["steps", index, "options"]
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

export const DEFAULT_CONSENT_TEXT =
  "This session records your screen and microphone while you complete the tasks. " +
  "The recording is used for research analysis and is visible to the research team. " +
  "You can stop at any time.";

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
  studyId: string
): StudyStep[] {
  const authored: StudyStep[] = steps.map((step, index) => ({
    step_id: `${studyId}_step_${index + 1}`,
    order: index + 1,
    type: step.type,
    prompt: step.prompt.trim(),
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
