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

import { isSafeTargetUrl } from "./url-safety";

/**
 * `multi_choice`, `rating` and `nps` exist so a poll or survey can run natively
 * in Cortex instead of handing the participant off to an external service.
 *
 * They join the recorded-study vocabulary rather than forming a separate survey
 * schema because they persist into the same `firsthand.study_steps` rows and
 * answer into the same `participant_responses`. `study_steps.type` is TEXT and
 * `options` is JSONB, so no storage reshaping was needed - which is precisely
 * why this schema has to be the gate. Nothing below it will reject a malformed
 * question.
 */
const stepTypes = [
  "instruction",
  "open_text",
  "single_choice",
  "multi_choice",
  "rating",
  "nps",
  "end"
] as const;

export const stepTypeSchema = z.enum(stepTypes);

/**
 * NPS is 0 to 10 by definition, so the scale is fixed here rather than
 * authored. An author-set scale would produce something labelled NPS whose
 * scores cannot be compared with anyone else's NPS.
 */
export const NPS_SCALE_MAX = 10;

/**
 * A rating needs at least two points to be a rating, and more than ten stops
 * being a scale a participant can hold in their head.
 */
export const RATING_SCALE_BOUNDS = { min: 2, max: 10 } as const;

/**
 * Per-type question configuration.
 *
 * Carried in its own `config` object, and stored in a `config JSONB` column,
 * rather than widened into `options`: `options` is read as `string[]` in
 * studies-repository, so overloading it would break the existing reader for
 * every step type that already uses it.
 */
export const stepConfigSchema = z
  .object({
    scale_max: z.number().int().optional(),
    min_label: z.string().min(1).optional(),
    max_label: z.string().min(1).optional(),
    min_selections: z.number().int().positive().optional(),
    max_selections: z.number().int().positive().optional()
  })
  .strict();

export type StepConfig = z.infer<typeof stepConfigSchema>;

/**
 * A shape rule broken by a single step.
 *
 * Reported as a code rather than a message because the same rule is enforced at
 * three boundaries - the runtime contract, the authoring schema and the
 * repository - and each already words its errors for a different reader. Codes
 * keep one copy of the rule without forcing one copy of the prose.
 */
export type StepShapeProblem =
  | { code: "choice_needs_options"; field: "options" }
  | { code: "selection_range_inverted"; field: "config" }
  | { code: "selection_min_exceeds_options"; field: "config" }
  | { code: "rating_needs_scale"; field: "config" }
  | { code: "rating_scale_out_of_range"; field: "config" }
  | { code: "nps_scale_not_authorable"; field: "config" }
  | { code: "nps_takes_no_options"; field: "options" };

/**
 * The single source of truth for whether a step's options and config agree with
 * its type. Returns the first problem found, or null when the step is workable.
 */
export function findStepShapeProblem(step: {
  type: string;
  options?: string[];
  config?: StepConfig;
}): StepShapeProblem | null {
  const optionCount = step.options?.length ?? 0;
  const config = step.config;

  if (step.type === "single_choice" || step.type === "multi_choice") {
    if (optionCount < 2) {
      return { code: "choice_needs_options", field: "options" };
    }
  }

  if (step.type === "multi_choice" && config) {
    const { min_selections: min, max_selections: max } = config;

    if (min !== undefined && max !== undefined && min > max) {
      return { code: "selection_range_inverted", field: "config" };
    }

    // Otherwise an author can write a required question nobody can satisfy,
    // and the runner blocks completion on it at run time.
    if (min !== undefined && min > optionCount) {
      return { code: "selection_min_exceeds_options", field: "config" };
    }
  }

  if (step.type === "rating") {
    const scale = config?.scale_max;

    // Not defaulted on purpose: two studies with identical authored content
    // would otherwise produce data on different scales with nothing recording
    // which was which.
    if (scale === undefined) {
      return { code: "rating_needs_scale", field: "config" };
    }

    if (scale < RATING_SCALE_BOUNDS.min || scale > RATING_SCALE_BOUNDS.max) {
      return { code: "rating_scale_out_of_range", field: "config" };
    }
  }

  if (step.type === "nps") {
    if (config?.scale_max !== undefined) {
      return { code: "nps_scale_not_authorable", field: "config" };
    }

    if (optionCount > 0) {
      return { code: "nps_takes_no_options", field: "options" };
    }
  }

  return null;
}

/**
 * Wording for the runtime boundary, where the reader is whoever is debugging a
 * rejected session payload.
 */
export const CONTRACT_STEP_SHAPE_MESSAGES: Record<
  StepShapeProblem["code"],
  string
> = {
  choice_needs_options: "choice steps must include at least two options",
  selection_range_inverted:
    "max_selections must be greater than or equal to min_selections",
  selection_min_exceeds_options:
    "min_selections cannot exceed the number of options",
  rating_needs_scale: "rating steps must include config.scale_max",
  rating_scale_out_of_range: `config.scale_max must be between ${RATING_SCALE_BOUNDS.min} and ${RATING_SCALE_BOUNDS.max}`,
  nps_scale_not_authorable: `nps steps are fixed at 0 to ${NPS_SCALE_MAX} and cannot set config.scale_max`,
  nps_takes_no_options: "nps steps must not include options"
};

export const studySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  intro_text: z.string().min(1),
  consent_text: z.string().min(1),
  status: z.string().min(1).optional(),
  brand_name: z.string().min(1).optional(),
  estimated_duration_minutes: z.number().int().positive().optional(),
  locale: z.string().min(1).optional()
});

export const participantSchema = z.object({
  participant_id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  segment: z.string().min(1).optional(),
  external_ref: z.string().min(1).optional(),
  email: z.string().email().optional()
});

export const sessionSchema = z.object({
  session_id: z.string().min(1),
  session_token: z.string().min(1),
  study_id: z.string().min(1),
  participant_id: z.string().min(1),
  expires_at: z.string().datetime().optional(),
  single_use: z.boolean().optional(),
  callback_url: z
    .string()
    .url()
    .refine(isSafeTargetUrl, {
      message:
        "callback_url must be an http(s) URL (no javascript:, data:, or other non-http schemes)"
    })
    .optional(),
  return_url: z
    .string()
    .url()
    .refine(isSafeTargetUrl, {
      message:
        "return_url must be an http(s) URL (no javascript:, data:, or other non-http schemes)"
    })
    .optional(),
  asset_upload_context: z.record(z.string(), z.unknown()).optional()
});

export const stepSchema = z.object({
  step_id: z.string().min(1),
  order: z.number().int().positive(),
  type: stepTypeSchema,
  prompt: z.string().min(1),
  target_url: z
    .string()
    .min(1)
    .refine(isSafeTargetUrl, {
      message:
        "target_url must be an http(s) URL or a same-origin path (no javascript:, data:, or protocol-relative URLs)"
    })
    .optional(),
  is_required: z.boolean().optional(),
  options: z.array(z.string().min(1)).optional(),
  config: stepConfigSchema.optional(),
  helper_text: z.string().min(1).optional(),
  min_length: z.number().int().nonnegative().optional(),
  max_length: z.number().int().positive().optional()
});

export const contractVersionSchema = z.literal("1.0");

export const sessionPayloadSchema = z
  .object({
    contract_version: contractVersionSchema,
    study: studySchema,
    participant: participantSchema,
    session: sessionSchema,
    steps: z.array(stepSchema).min(1)
  })
  .superRefine((payload, ctx) => {
    if (payload.session.study_id !== payload.study.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session.study_id must match study.id",
        path: ["session", "study_id"]
      });
    }

    if (payload.session.participant_id !== payload.participant.participant_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session.participant_id must match participant.participant_id",
        path: ["session", "participant_id"]
      });
    }

    const stepIds = new Set<string>();
    const stepOrders = new Set<number>();

    for (const step of payload.steps) {
      if (stepIds.has(step.step_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "step_id values must be unique",
          path: ["steps"]
        });
      }

      if (stepOrders.has(step.order)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "step order values must be unique",
          path: ["steps"]
        });
      }

      const shapeProblem = findStepShapeProblem(step);

      if (shapeProblem) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: CONTRACT_STEP_SHAPE_MESSAGES[shapeProblem.code],
          path: ["steps"]
        });
      }

      stepIds.add(step.step_id);
      stepOrders.add(step.order);
    }
  });

export type Study = z.infer<typeof studySchema>;
export type Participant = z.infer<typeof participantSchema>;
export type SessionContext = z.infer<typeof sessionSchema>;
export type StudyStep = z.infer<typeof stepSchema>;
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;
