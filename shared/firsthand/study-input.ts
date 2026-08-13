import { z } from "zod";

import { stepSchema, studySchema } from "./contract";

const studyMetaSchema = studySchema.omit({ id: true });

export const createStudyRequestSchema = z.object({
  id: z.string().min(1).optional(),
  ...studyMetaSchema.shape,
  status: z.enum(["draft", "launched", "archived"]).optional(),
  steps: z.array(stepSchema).min(1)
});

export const updateStudyRequestSchema = z.object({
  title: z.string().min(1).optional(),
  intro_text: z.string().min(1).optional(),
  consent_text: z.string().min(1).optional(),
  brand_name: z.string().min(1).nullable().optional(),
  estimated_duration_minutes: z.number().int().positive().nullable().optional(),
  locale: z.string().min(1).nullable().optional(),
  status: z.enum(["draft", "launched", "archived"]).optional(),
  // Superadmin-only ownership reassignment; the repository answers 403 for
  // anyone else. Not nullable - handing a study back to the unowned fail-open
  // is not a repair. See updateStudy in backend/src/firsthand/
  // studies-repository.ts for why this is the only way to correct an owner.
  owner_user_id: z.string().min(1).optional(),
  steps: z.array(stepSchema).min(1).optional()
});

export type CreateStudyRequest = z.infer<typeof createStudyRequestSchema>;
export type UpdateStudyRequest = z.infer<typeof updateStudyRequestSchema>;
