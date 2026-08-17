import type { StudyStep } from "../../../shared/firsthand/contract";
import type { StoredResponse } from "./survey-results";

/**
 * The raw responses as CSV: one row per participant, one column per question.
 *
 * That shape rather than a row per answer, because it is what a spreadsheet or
 * a stats package expects. A row per answer would have to be pivoted before
 * anyone could look at it.
 */

const QUESTION_TYPES = new Set([
  "open_text",
  "single_choice",
  "multi_choice",
  "rating",
  "nps"
]);

/**
 * Excel and Google Sheets execute a cell beginning =, +, - or @ as a formula.
 * Participant free text reaches these cells verbatim, so an answer of
 * `=HYPERLINK("http://evil.test")` becomes a live formula in a researcher's
 * spreadsheet. Prefixing with a tab neutralises it while leaving the text
 * readable, and the tab is inside the quoted field so it does not disturb
 * parsing.
 *
 * Applied to every cell of human-authored text, not only the participant's:
 * question prompts are free text written by any researcher_admin, and the
 * person who opens this export is a superadmin - a prompt of
 * `=HYPERLINK(...)` would make the header row a formula aimed at the
 * highest-privileged user in the system. The only cells exempted are the ones
 * we generate ourselves within a known shape: a rating is a bounded integer,
 * and prefixing it would stop it being a number in the sheet - which is the
 * entire reason to export it.
 */
const neutralise = (value: string) =>
  /^[=+\-@]/.test(value) ? `\t${value}` : value;

const escape = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const cell = (value: string, humanAuthored: boolean) =>
  escape(humanAuthored ? neutralise(value) : value);

function answerFor(step: StudyStep, payload: Record<string, unknown>) {
  if (step.type === "rating" || step.type === "nps") {
    const rating = payload.rating;
    // Numbers are ours, not the participant's: emitted unprefixed so the
    // column stays numeric.
    return typeof rating === "number"
      ? { text: String(rating), participantAuthored: false }
      : { text: "", participantAuthored: false };
  }

  if (step.type === "multi_choice") {
    const selected = Array.isArray(payload.selectedOptions)
      ? payload.selectedOptions.filter((v): v is string => typeof v === "string")
      : [];
    // Semicolon rather than comma so the join does not force quoting for a
    // reason unrelated to the content.
    return { text: selected.join("; "), participantAuthored: true };
  }

  if (step.type === "single_choice") {
    return {
      text: typeof payload.selectedOption === "string" ? payload.selectedOption : "",
      participantAuthored: true
    };
  }

  return {
    text: typeof payload.text === "string" ? payload.text : "",
    participantAuthored: true
  };
}

export function toResponsesCsv(
  steps: StudyStep[],
  responses: StoredResponse[]
): string {
  const questions = steps.filter((step) => QUESTION_TYPES.has(step.type));

  // Every question keeps its column even when nobody answered it: an absent
  // column reads as a question that was never asked. Prompts are
  // researcher-authored free text, so they are neutralised like any other
  // human-authored cell; the fixed "Participant" label is ours.
  const header = [
    cell("Participant", false),
    ...questions.map((step) => cell(step.prompt, true))
  ];

  const byParticipant = new Map<string, Map<string, Record<string, unknown>>>();

  for (const row of responses) {
    const existing = byParticipant.get(row.session_id) ?? new Map();
    existing.set(row.step_id, row.response_payload ?? {});
    byParticipant.set(row.session_id, existing);
  }

  const lines = [...byParticipant.entries()].map(([sessionId, answers]) => {
    const cells = questions.map((step) => {
      const payload = answers.get(step.step_id);

      if (!payload) {
        return "";
      }

      const { text, participantAuthored } = answerFor(step, payload);
      return cell(text, participantAuthored);
    });

    return [cell(sessionId, false), ...cells].join(",");
  });

  // CRLF is what RFC 4180 specifies and what Excel expects.
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}
