import { z } from 'zod';

import { VALIDATION } from './constants';
import type {
  ParticipantScreener,
  Screener,
  ScreenerOutcome,
} from './types';

/**
 * SCREENER contract - the eligibility questions a researcher sets on an
 * opportunity, and the pure logic for validating, evaluating and redacting them.
 *
 * This is opportunity-level, not study-runtime, so it lives here rather than
 * under shared/firsthand. The zod schema is the authoring gate (wired into the
 * create/update opportunity schemas in backend/src/validation/schemas.ts); the
 * plain interfaces are in shared/types. A build-time assertion in schemas.ts
 * fails if the two ever drift.
 *
 * "No screener" is represented by the ABSENCE of a screener (a null/undefined
 * column), never by an empty or disabled object - so a screener that exists
 * always gates, which is the property the three apply chokepoints rely on. That
 * is why a valid screener must have at least one question, at least one way to
 * pass every question, and at least one answer that screens out overall: a
 * screener nobody can pass, or one that filters no-one, is a mistake, not a
 * degenerate no-op.
 *
 * `disqualifies` is OWNER-ONLY and must never reach a participant, who would
 * otherwise know exactly which answer to avoid. redactScreenerForParticipant is
 * the one transform that strips it, applied at the public serialiser
 * (backend/src/utils/publicOpportunity.ts).
 */

// Authoring-validation messages. Exported so both the schema tests and the
// authoring UI assert the exact sentence rather than a paraphrase.
export const SCREENER_QUESTION_NEEDS_PASS =
  'Each question needs at least one answer that qualifies';
export const SCREENER_NEEDS_SCREEN_OUT =
  'A screener needs at least one answer that screens someone out';
export const SCREENER_DUPLICATE_OPTION_ID =
  'Each answer within a question needs a distinct id';
export const SCREENER_DUPLICATE_QUESTION_ID =
  'Each question needs a distinct id';

// Answer-submission messages (participant side).
export const SCREENER_ANSWERS_MALFORMED =
  'Screener answers must be an object mapping each question to a chosen answer';
export const SCREENER_ANSWER_INVALID =
  'Answer every question with one of its listed options';

const screenerOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(VALIDATION.SCREENER_MAX_OPTION_LABEL_CHARS),
  disqualifies: z.boolean(),
});

const screenerQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: z.string().trim().min(1).max(VALIDATION.SCREENER_MAX_PROMPT_CHARS),
  options: z
    .array(screenerOptionSchema)
    .min(VALIDATION.SCREENER_MIN_OPTIONS)
    .max(VALIDATION.SCREENER_MAX_OPTIONS)
    .refine(
      (options) => new Set(options.map((o) => o.id)).size === options.length,
      { message: SCREENER_DUPLICATE_OPTION_ID }
    )
    // A question every answer to which screens out can never be passed, so the
    // screener as a whole can never be passed - reject it at authoring time
    // rather than mint an opportunity nobody can ever take part in.
    .refine((options) => options.some((o) => !o.disqualifies), {
      message: SCREENER_QUESTION_NEEDS_PASS,
    }),
});

/**
 * The screener as authored and stored. Single-choice questions only in v1.
 */
export const screenerSchema = z
  .object({
    questions: z
      .array(screenerQuestionSchema)
      .min(VALIDATION.SCREENER_MIN_QUESTIONS)
      .max(VALIDATION.SCREENER_MAX_QUESTIONS)
      .refine(
        (questions) =>
          new Set(questions.map((q) => q.id)).size === questions.length,
        { message: SCREENER_DUPLICATE_QUESTION_ID }
      ),
    screenedOutMessage: z
      .string()
      .trim()
      .max(VALIDATION.SCREENER_MAX_MESSAGE_CHARS)
      .optional(),
  })
  // A screener with no screen-out answer anywhere filters no-one, so it is a
  // screener in name only - reject it rather than store a gate that never gates.
  .refine(
    (screener) =>
      screener.questions.some((q) => q.options.some((o) => o.disqualifies)),
    { message: SCREENER_NEEDS_SCREEN_OUT }
  );

/**
 * Evaluate a participant's answers against a screener.
 *
 * FAILS CLOSED: any question whose answer is missing or does not match a listed
 * option returns `screened_out`, so a malformed submission can never be a silent
 * qualify. Callers validate completeness with parseScreenerAnswers first and
 * reject bad input with a 400; this is the backstop, not the front door.
 */
export function evaluateScreener(
  screener: Screener,
  answers: Record<string, string>
): ScreenerOutcome {
  for (const question of screener.questions) {
    const chosen = question.options.find((o) => o.id === answers[question.id]);
    if (!chosen) {
      return 'screened_out';
    }
    if (chosen.disqualifies) {
      return 'screened_out';
    }
  }
  return 'qualified';
}

export type ScreenerAnswerParse =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; message: string };

/**
 * Validate a raw answer submission against a screener and normalise it to a map
 * of questionId -> chosen optionId, keeping only the screener's own questions.
 * Every question must be answered with one of its listed options.
 */
export function parseScreenerAnswers(
  screener: Screener,
  raw: unknown
): ScreenerAnswerParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: SCREENER_ANSWERS_MALFORMED };
  }
  const input = raw as Record<string, unknown>;
  const answers: Record<string, string> = {};
  for (const question of screener.questions) {
    const chosen = input[question.id];
    if (
      typeof chosen !== 'string' ||
      !question.options.some((o) => o.id === chosen)
    ) {
      return { ok: false, message: SCREENER_ANSWER_INVALID };
    }
    answers[question.id] = chosen;
  }
  return { ok: true, answers };
}

/**
 * Strip the owner-only `disqualifies` flag from every option, producing the
 * shape a participant may safely receive. The one place the flag is removed.
 */
export function redactScreenerForParticipant(
  screener: Screener
): ParticipantScreener {
  const view: ParticipantScreener = {
    questions: screener.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    })),
  };
  if (screener.screenedOutMessage !== undefined) {
    view.screenedOutMessage = screener.screenedOutMessage;
  }
  return view;
}
