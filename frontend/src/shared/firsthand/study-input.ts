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

import { stepSchema, studySchema, type StudyStep } from "./contract";
import { authorableStepTypes } from "./inline-study";
import { authorableSurveyStepTypes } from "./survey-authoring";

const studyMetaSchema = studySchema.omit({ id: true });

/**
 * Which authoring vocabulary a study is written in.
 *
 * `recorded` is a first-hand task list: the participant works through tasks
 * while their screen and voice are captured and answers out loud, so it authors
 * `authorableStepTypes` only. `survey` is a native poll or survey: it records
 * nothing and types everything, so it also authors multi_choice, rating and
 * nps (`authorableSurveyStepTypes`).
 *
 * Stored on the study rather than derived from the step types it contains -
 * an instruction-only study is ambiguous between the two, and derivation would
 * let a step edit reclassify a study an opportunity is already linked to. Set
 * at create and not editable afterwards: changing it would leave the steps
 * written in the wrong vocabulary for the runner that then reads them.
 */
export const studyKinds = ["recorded", "survey"] as const;

export const studyKindSchema = z.enum(studyKinds);

export type StudyKind = (typeof studyKinds)[number];

/**
 * A step that does not belong in the vocabulary its study declares.
 *
 * The step schema on its own cannot answer this: `stepSchema` permits the whole
 * contract vocabulary, because it also describes steps the runtime reads rather
 * than steps an author writes. So a `recorded` study full of `nps` questions,
 * and a `survey` whose steps carry a page to open, both parsed cleanly - each
 * proven reachable through `POST /api/firsthand/studies` before this existed.
 *
 * Reported as a code, per the pattern `findStepShapeProblem` already sets, so
 * one rule can be worded differently at the boundaries that enforce it.
 */
export type StepVocabularyProblem =
  | { code: "type_not_in_vocabulary"; index: number; field: "type" }
  | { code: "survey_step_takes_no_target"; index: number; field: "target_url" };

/**
 * `end` is permitted in both: it is the completion marker every authoring path
 * appends after the authored steps, never something an author writes.
 */
const vocabularyFor = (kind: StudyKind): ReadonlySet<string> =>
  new Set<string>(
    kind === "survey"
      ? [...authorableSurveyStepTypes, "end"]
      : [...authorableStepTypes, "end"]
  );

export function findStepVocabularyProblem(
  kind: StudyKind,
  steps: ReadonlyArray<Pick<StudyStep, "type"> & { target_url?: string }>
): StepVocabularyProblem | null {
  const permitted = vocabularyFor(kind);

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];

    if (!permitted.has(step.type)) {
      return { code: "type_not_in_vocabulary", index, field: "type" };
    }

    // A survey records nothing, so a step naming a page would hand the
    // participant the recorded runner's task-window affordances - "open the
    // task page", "keep it open or the recording stops" - with no recording
    // behind them.
    if (kind === "survey" && step.target_url) {
      return { code: "survey_step_takes_no_target", index, field: "target_url" };
    }
  }

  return null;
}

export const STEP_VOCABULARY_MESSAGES: Record<
  StepVocabularyProblem["code"],
  string
> = {
  type_not_in_vocabulary:
    "This question type is not available in this kind of study",
  survey_step_takes_no_target:
    "A survey has no page to open, so its questions take no target URL"
};

export const createStudyRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    ...studyMetaSchema.shape,
    status: z.enum(["draft", "launched", "archived"]).optional(),
    // Optional, defaulting to `recorded` in the repository rather than here, so
    // that every caller predating the survey vocabulary keeps its meaning
    // without being edited.
    kind: studyKindSchema.optional(),
    steps: z.array(stepSchema).min(1)
  })
  .superRefine((value, ctx) => {
    // Absent means recorded, matching the repository's own default. Reading it
    // any other way here would let the strictest vocabulary be skipped simply
    // by omitting the field.
    const problem = findStepVocabularyProblem(value.kind ?? "recorded", value.steps);

    if (problem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: STEP_VOCABULARY_MESSAGES[problem.code],
        path: ["steps", problem.index, problem.field]
      });
    }
  });

/**
 * Strict, because `kind` must not appear here.
 *
 * A study's vocabulary is fixed at create - changing it would leave the stored
 * steps written for a runner that no longer reads them. Without this the field
 * was accepted, silently dropped and answered 200, which tells the caller the
 * opposite of what happened.
 *
 * `id` is the one exception, and it is deliberate rather than an oversight.
 * StudyEditor builds a single payload for both operations and sends the id on
 * update too, where the route takes the id from its own path and ignores the
 * body's. Rejecting it would mean a cached SPA breaks every save for the
 * fifteen to thirty minutes between the backend rolling and the new bundle
 * being served - so it is accepted and ignored, in writing, rather than by
 * accident.
 */
export const updateStudyRequestSchema = z.strictObject({
  id: z.string().min(1).optional(),
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
