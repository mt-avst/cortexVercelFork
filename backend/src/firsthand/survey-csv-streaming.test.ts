import { describe, expect, it } from "vitest";

import type { StudyStep } from "../../../shared/firsthand/contract";
import {
  CSV_LINE_ENDING,
  removedQuestionColumns,
  toCsvHeaderRow,
  toCsvParticipantRow,
  toResponsesCsv
} from "./survey-csv";
import type { StoredResponse } from "./survey-results";

/**
 * ASSEMBLING THE SAME EMITTERS ONE PARTICIPANT AT A TIME MUST PRODUCE THE SAME
 * BYTES AS ASSEMBLING THEM ALL AT ONCE.
 *
 * That is the whole of what batching can change, and it is what these compare.
 * A column order or a quoting rule that drifted between the two paths would be
 * invisible until somebody exported the same study twice and got different
 * spreadsheets.
 *
 * NOTE WHAT THIS FILE DOES NOT TEST, because an earlier version of this comment
 * claimed more than it delivered. Both sides here call `removedQuestionColumns`
 * in memory, so the SQL that finds those columns is never compared with
 * anything - six mutations to the streaming path passed this file untouched.
 * survey-csv-export-postgres.ts is where the two READERS are compared, against
 * a real database. This file compares two assembly orders of one reader.
 *
 * `toResponsesCsv` is now implemented on the same header and row emitters the
 * stream uses, so this is not comparing two implementations - it is checking
 * that assembling them a participant at a time produces the same result as
 * assembling them all at once, which is the only thing streaming changes.
 */

const step = (id: string, type: StudyStep["type"], prompt: string): StudyStep =>
  ({ step_id: id, order: 1, type, prompt }) as StudyStep;

const answer = (
  sessionId: string,
  stepId: string | null,
  payload: Record<string, unknown>,
  extra: Partial<StoredResponse> = {}
): StoredResponse => ({
  session_id: sessionId,
  step_id: stepId,
  step_prompt: null,
  step_type: "open_text",
  response_payload: payload,
  saved_at: "2026-08-21T10:00:00.000Z",
  ...extra
});

/** Assembles the same rows the way the streaming writer does. */
function assembleStreamed(
  steps: StudyStep[],
  responses: StoredResponse[]
): string {
  const removed = removedQuestionColumns(responses);

  const byParticipant = new Map<string, StoredResponse[]>();
  for (const row of responses) {
    const group = byParticipant.get(row.session_id);
    if (group) group.push(row);
    else byParticipant.set(row.session_id, [row]);
  }

  let out = toCsvHeaderRow(steps, removed) + CSV_LINE_ENDING;
  for (const [sessionId, answers] of byParticipant) {
    out += toCsvParticipantRow(steps, removed, sessionId, answers) + CSV_LINE_ENDING;
  }
  return out;
}

describe("streamed against whole-string CSV", () => {
  const cases: Array<[string, StudyStep[], StoredResponse[]]> = [
    ["no answers at all", [step("q1", "open_text", "How was it?")], []],
    [
      "one participant, one answer",
      [step("q1", "open_text", "How was it?")],
      [answer("s1", "q1", { text: "Fine" })]
    ],
    [
      "a question nobody answered keeps its column",
      [step("q1", "open_text", "A"), step("q2", "open_text", "B")],
      [answer("s1", "q1", { text: "only A" })]
    ],
    [
      "answers needing quoting, and a formula",
      [step("q1", "open_text", "A"), step("q2", "open_text", 'B, "quoted"')],
      [
        answer("s1", "q1", { text: '=HYPERLINK("http://evil.test")' }),
        answer("s1", "q2", { text: "line\r\nbreak, comma" })
      ]
    ],
    [
      "a removed question, carried through",
      [step("q1", "open_text", "A")],
      [
        answer("s1", "q1", { text: "kept" }),
        answer("s1", null, { text: "detached" }, {
          step_prompt: "A question that was deleted"
        })
      ]
    ],
    [
      "two removed questions sharing a type, in first-appearance order",
      [step("q1", "open_text", "A")],
      [
        answer("s1", null, { text: "second" }, { step_prompt: "Deleted B" }),
        answer("s1", null, { text: "first" }, { step_prompt: "Deleted A" }),
        answer("s2", "q1", { text: "kept" })
      ]
    ],
    [
      "a removed question with no snapshotted prompt",
      [step("q1", "open_text", "A")],
      [answer("s1", null, { text: "orphan" }, { step_prompt: null })]
    ],
    [
      "ratings stay numeric while text is neutralised",
      [step("q1", "rating", "Score"), step("q2", "open_text", "Why?")],
      [
        answer("s1", "q1", { rating: 4 }, { step_type: "rating" }),
        answer("s1", "q2", { text: "-1 is not a formula either" })
      ]
    ],
    [
      "several participants, interleaved answers",
      [step("q1", "open_text", "A"), step("q2", "open_text", "B")],
      [
        answer("s1", "q1", { text: "a1" }),
        answer("s2", "q1", { text: "a2" }),
        answer("s1", "q2", { text: "b1" }),
        answer("s3", "q2", { text: "b3" })
      ]
    ]
  ];

  it.each(cases)("matches for %s", (_name, steps, responses) => {
    expect(assembleStreamed(steps, responses)).toBe(
      toResponsesCsv(steps, responses)
    );
  });

  it("matches across a large generated set", () => {
    // Enough participants to cross several streaming batches, with a removed
    // question and a participant who answered nothing but the removed one.
    const steps = Array.from({ length: 12 }, (_u, i) =>
      step(`q${i}`, "open_text", `Question ${i}`)
    );
    const responses: StoredResponse[] = [];
    for (let p = 0; p < 250; p += 1) {
      for (let q = 0; q < 12; q += 1) {
        if ((p + q) % 3 === 0) continue; // sparse, so gaps are covered too
        responses.push(answer(`s${p}`, `q${q}`, { text: `p${p}q${q}` }));
      }
      if (p % 25 === 0) {
        responses.push(
          answer(`s${p}`, null, { text: `detached ${p}` }, {
            step_prompt: "Since removed"
          })
        );
      }
    }

    expect(assembleStreamed(steps, responses)).toBe(
      toResponsesCsv(steps, responses)
    );
  });
});
