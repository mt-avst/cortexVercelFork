import type { StudyStep } from "../../../shared/firsthand/contract";
import { UNKNOWN_REMOVED_PROMPT, type StoredResponse } from "./survey-results";

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
 * The `Content-Disposition` value for a study's export.
 *
 * Titles are researcher-authored free text and reach a header, which imposes
 * two separate constraints that are easy to mistake for one:
 *
 * - A quote, backslash or newline would end or split the quoted filename, so
 *   they are stripped.
 * - Node refuses to write a header value it cannot encode as latin1, and
 *   THROWS rather than mangling it. A curly apostrophe pasted from Word is
 *   enough, so a title carrying one used to 500 the export until somebody
 *   edited the title - with no message saying that was why.
 *
 * So the quoted `filename` is reduced to ASCII as the fallback every client
 * understands, and the real title is carried in RFC 5987 `filename*`, which
 * every current browser prefers.
 *
 * The length cap is taken in CODE POINTS. `slice` counts UTF-16 code units, so
 * a title whose 80th unit is the first half of an emoji left a lone surrogate
 * behind, and `encodeURIComponent` throws `URIError` on one - a 500 on the
 * export, which is the same failure this function exists to remove, reached by
 * a different route. Reported by the phase 4e security gate, reproduced with a
 * 79-character title followed by an emoji.
 */
export function toCsvContentDisposition(title: string): string {
  const cleaned = [...title.replace(/["\\\r\n]/g, "")].slice(0, 80).join("").trim();

  const ascii = cleaned.replace(/[^\x20-\x7E]/g, "").trim() || "survey";
  const filename = `${ascii} responses.csv`;
  const encoded = encodeURIComponent(`${cleaned || "survey"} responses.csv`);

  return `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`;
}

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

/**
 * Marks a column whose question the study no longer has.
 *
 * In the header rather than only in the JSON view, because a CSV is where a
 * finding gets computed: a column silently missing its question would be
 * averaged alongside the live ones with nothing to say it is no longer being
 * asked. Suffixed rather than prefixed so the prompt still sorts and reads
 * first, and applied AFTER neutralisation of the prompt itself.
 */
const REMOVED_COLUMN_SUFFIX = " (removed question)";

/**
 * A removed question's answers, as a column.
 *
 * Keyed by `(step_type, step_prompt)` for the same reason `removedQuestionsFrom`
 * groups on that pair: a detached answer's step id was nulled when the question
 * was deleted, so the prompt the participant was shown is the only identity
 * left. The key is the map key AND the lookup key, so the two cannot drift.
 */
const detachedKey = (stepType: string, prompt: string) =>
  `${stepType}\u0000${prompt}`;

export function toResponsesCsv(
  steps: StudyStep[],
  responses: StoredResponse[]
): string {
  const questions = steps.filter((step) => QUESTION_TYPES.has(step.type));

  // Answers whose question has been removed. Exported rather than dropped: the
  // participant answered, and an export that quietly omits it is a smaller data
  // set than the researcher believes they are looking at.
  const detached = responses.filter(
    (row) => row.step_id === null && QUESTION_TYPES.has(row.step_type)
  );

  const removed = [
    ...new Map(
      detached.map((row) => [
        detachedKey(row.step_type, row.step_prompt ?? UNKNOWN_REMOVED_PROMPT),
        {
          type: row.step_type,
          prompt: row.step_prompt ?? UNKNOWN_REMOVED_PROMPT
        }
      ])
    ).values()
  ];

  // Every question keeps its column even when nobody answered it: an absent
  // column reads as a question that was never asked. Prompts are
  // researcher-authored free text, so they are neutralised like any other
  // human-authored cell; the fixed "Participant" label is ours.
  const header = [
    cell("Participant", false),
    ...questions.map((step) => cell(step.prompt, true)),
    ...removed.map((question) =>
      cell(neutralise(question.prompt) + REMOVED_COLUMN_SUFFIX, false)
    )
  ];

  const byParticipant = new Map<string, Map<string, Record<string, unknown>>>();

  for (const row of responses) {
    const existing = byParticipant.get(row.session_id) ?? new Map();
    existing.set(
      row.step_id ??
        detachedKey(row.step_type, row.step_prompt ?? UNKNOWN_REMOVED_PROMPT),
      row.response_payload ?? {}
    );
    byParticipant.set(row.session_id, existing);
  }

  const lines = [...byParticipant.entries()].map(([sessionId, answers]) => {
    const columnFor = (
      step: Pick<StudyStep, "type">,
      payload: Record<string, unknown> | undefined
    ) => {
      if (!payload) {
        return "";
      }

      const { text, participantAuthored } = answerFor(step as StudyStep, payload);
      return cell(text, participantAuthored);
    };

    const cells = questions.map((step) => columnFor(step, answers.get(step.step_id)));

    const removedCells = removed.map((question) =>
      columnFor(
        { type: question.type as StudyStep["type"] },
        answers.get(detachedKey(question.type, question.prompt))
      )
    );

    return [cell(sessionId, false), ...cells, ...removedCells].join(",");
  });

  // CRLF is what RFC 4180 specifies and what Excel expects.
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}
