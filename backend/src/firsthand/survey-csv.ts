import type { StudyStep } from "../../../shared/firsthand/contract";
import { UNKNOWN_REMOVED_PROMPT, type StoredResponse } from "./survey-results";

/**
 * The raw responses as CSV: one row per participant, one column per question.
 *
 * That shape rather than a row per answer, because it is what a spreadsheet or
 * a stats package expects. A row per answer would have to be pivoted before
 * anyone could look at it.
 */

/**
 * Exported so the SQL that finds removed-question columns can BIND this exact
 * set rather than restate it. The two disagreeing is what let a detached
 * non-question row become a phantom column.
 *
 * `ReadonlySet` because it now decides which participant rows become columns.
 * A live `Set` crossing a module boundary into a bound SQL parameter is a
 * predicate any importer could widen, process-wide, from anywhere.
 */
export const QUESTION_TYPES: ReadonlySet<string> = new Set([
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

/**
 * A removed question, as a column. The identity a detached answer has left.
 */
export type RemovedQuestion = { type: string; prompt: string };

/**
 * The header row, given the study's questions and the removed questions the
 * answer set turned out to contain.
 *
 * Split out so the streaming export can emit it before it has read a single
 * answer row. Both entry points below call this; there is no second copy of
 * the column ordering to drift.
 */
export function toCsvHeaderRow(
  steps: StudyStep[],
  removed: RemovedQuestion[]
): string {
  const questions = steps.filter((step) => QUESTION_TYPES.has(step.type));

  // Every question keeps its column even when nobody answered it: an absent
  // column reads as a question that was never asked. Prompts are
  // researcher-authored free text, so they are neutralised like any other
  // human-authored cell; the fixed "Participant" label is ours.
  //
  // "PARTICIPANT" IS A SESSION, AND THAT DISAGREES WITH THE RESULTS PAGE
  // (cto/AdaptaLabs#152). This column carries a `session_id`, and the export
  // emits one row per session, while the page's "N participants" headline
  // counts distinct `participant_id` (`respondentKey` in survey-results.ts,
  // cto/AdaptaLabs#129). Since an expired session now earns a fresh mint
  // rather than a dead link, one person can hold two answer-carrying sessions
  // - and reads as 1 participant on the page and 2 "Participant" rows here.
  // Deliberately NOT reconciled by renaming this cell or regrouping the
  // export: both need the which-answer-wins rule #152 exists to decide, and
  // a rename alone would change every researcher's column headings for a
  // disagreement the numbers would still have.
  return [
    cell("Participant", false),
    ...questions.map((step) => cell(step.prompt, true)),
    ...removed.map((question) =>
      cell(neutralise(question.prompt) + REMOVED_COLUMN_SUFFIX, false)
    )
  ].join(",");
}

/**
 * One SESSION's row, from that session's answers alone.
 *
 * The unit the streaming export works in: a row needs nothing but one
 * session's answers plus the column layout, which is why the export can hold
 * one row in memory instead of two hundred thousand.
 *
 * SESSION, NOT PERSON - it was called "one participant's row" and the two
 * stopped being the same thing (cto/AdaptaLabs#152). The caller keys on
 * `session_id`, the first cell is a `session_id`, and one person holding two
 * answer-carrying sessions gets two rows here while the results page counts
 * them as one. The export's grouping is left as it is on purpose; see the
 * note on the "Participant" header cell above.
 */
export function toCsvParticipantRow(
  steps: StudyStep[],
  removed: RemovedQuestion[],
  sessionId: string,
  answers: StoredResponse[]
): string {
  const questions = steps.filter((step) => QUESTION_TYPES.has(step.type));

  const byColumn = new Map<string, Record<string, unknown>>();
  for (const row of answers) {
    byColumn.set(
      row.step_id ??
        detachedKey(row.step_type, row.step_prompt ?? UNKNOWN_REMOVED_PROMPT),
      row.response_payload ?? {}
    );
  }

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

  return [
    cell(sessionId, false),
    ...questions.map((step) => columnFor(step, byColumn.get(step.step_id))),
    ...removed.map((question) =>
      columnFor(
        { type: question.type as StudyStep["type"] },
        byColumn.get(detachedKey(question.type, question.prompt))
      )
    )
  ].join(",");
}

/**
 * The removed questions a set of answers contains, in first-appearance order.
 *
 * Deduped by `(step_type, step_prompt)` because a detached answer's step id was
 * nulled when the question was deleted, so the prompt is the only identity
 * left. The streaming export asks the database for this same list directly, so
 * the two must agree on both the key and the order - hence one function.
 */
export function removedQuestionColumns(
  responses: StoredResponse[]
): RemovedQuestion[] {
  const detached = responses.filter(
    (row) => row.step_id === null && QUESTION_TYPES.has(row.step_type)
  );

  return [
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
}

/** CRLF is what RFC 4180 specifies and what Excel expects. */
export const CSV_LINE_ENDING = "\r\n";

/**
 * The whole export as one string.
 *
 * NOTHING IN PRODUCTION CALLS THIS ANY MORE - both export routes stream, a
 * participant at a time, because building the whole thing put a few hundred
 * megabytes in the heap of a single-replica pod. It is kept, and kept here
 * beside the pieces it composes, because it is the ORACLE the streamed path is
 * checked against: assembling the same emitters all at once must produce the
 * same bytes as assembling them one participant at a time, and that is the only
 * thing batching can change.
 *
 * REIMPLEMENTED ON THE PIECES ABOVE rather than kept as a second
 * implementation. The streaming export and this one now share the column
 * ordering, the escaping, the formula neutralisation and the removed-question
 * keying, so an equivalence test between them is checking the READERS agree -
 * not re-verifying two copies of the same logic that could drift apart.
 */
export function toResponsesCsv(
  steps: StudyStep[],
  responses: StoredResponse[]
): string {
  const removed = removedQuestionColumns(responses);

  // KEYED ON `session_id`, matching `streamParticipants` exactly - the two
  // must group identically or the equivalence test this oracle exists for
  // compares nothing. The name says participant and the key says session, and
  // those are no longer the same thing: see the "Participant" header cell
  // above, and cto/AdaptaLabs#152.
  const byParticipant = new Map<string, StoredResponse[]>();
  for (const row of responses) {
    const group = byParticipant.get(row.session_id);
    if (group) {
      group.push(row);
    } else {
      byParticipant.set(row.session_id, [row]);
    }
  }

  const lines = [...byParticipant.entries()].map(([sessionId, answers]) =>
    toCsvParticipantRow(steps, removed, sessionId, answers)
  );

  return (
    [toCsvHeaderRow(steps, removed), ...lines].join(CSV_LINE_ENDING) +
    CSV_LINE_ENDING
  );
}
