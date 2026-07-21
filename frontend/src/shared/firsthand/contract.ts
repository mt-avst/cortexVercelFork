/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * 
 * This file is automatically copied from the shared/ directory during the build process.
 * Any changes should be made to the source file in the shared/ directory.
 * 
 * Source: See copy-shared-types.js for the source path
 * Generated: 2026-07-21T20:18:04.470Z
 */

import { z } from "zod";

import { isSafeTargetUrl } from "./url-safety";

const stepTypes = ["instruction", "open_text", "single_choice", "end"] as const;

export const stepTypeSchema = z.enum(stepTypes);

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

      if (step.type === "single_choice" && (!step.options || step.options.length < 2)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "single_choice steps must include at least two options",
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
