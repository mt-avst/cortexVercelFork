import { describe, expect, it } from "vitest";

import type { StudyStep } from "../../../shared/firsthand/contract";
import { toResponsesCsv } from "./survey-csv";
import type { StoredResponse } from "./survey-results";

const step = (over: Partial<StudyStep> & Pick<StudyStep, "type" | "step_id">) =>
  ({ order: 1, prompt: "Question", ...over }) as StudyStep;

const response = (
  stepId: string,
  sessionId: string,
  payload: Record<string, unknown>
): StoredResponse => ({
  session_id: sessionId,
  step_id: stepId,
  step_type: "x",
  response_payload: payload,
  saved_at: "2026-08-16T09:00:00.000Z"
});

const rows = (csv: string) => csv.trim().split("\r\n");

describe("shape", () => {
  const steps = [
    step({ step_id: "q1", type: "open_text", prompt: "Thoughts?" }),
    step({
      step_id: "q2",
      type: "rating",
      prompt: "Ease",
      order: 2,
      config: { scale_max: 5 }
    })
  ];

  // One row per participant, one column per question: the shape every
  // spreadsheet and stats package expects. A row per answer would need
  // pivoting before anyone could look at it.
  it("writes a header of prompts and one row per participant", () => {
    const csv = toResponsesCsv(steps, [
      response("q1", "s1", { text: "Good" }),
      response("q2", "s1", { rating: 4 }),
      response("q1", "s2", { text: "Bad" })
    ]);

    expect(rows(csv)).toEqual([
      "Participant,Thoughts?,Ease",
      "s1,Good,4",
      "s2,Bad,"
    ]);
  });

  it("keeps a column for a question nobody answered", () => {
    const csv = toResponsesCsv(steps, [response("q1", "s1", { text: "Good" })]);

    expect(rows(csv)[0]).toBe("Participant,Thoughts?,Ease");
    expect(rows(csv)[1]).toBe("s1,Good,");
  });

  // Semicolon, not comma, so the join does not force the field to be quoted
  // for a reason that has nothing to do with its content.
  it("joins multi choice selections in one unquoted cell", () => {
    const csv = toResponsesCsv(
      [step({ step_id: "q1", type: "multi_choice", prompt: "Which?" })],
      [response("q1", "s1", { selectedOptions: ["a", "b"] })]
    );

    expect(rows(csv)[1]).toBe("s1,a; b");
  });

  it("still quotes a selected option that itself contains a comma", () => {
    const csv = toResponsesCsv(
      [step({ step_id: "q1", type: "multi_choice", prompt: "Which?" })],
      [response("q1", "s1", { selectedOptions: ["Jira, Cloud", "b"] })]
    );

    expect(rows(csv)[1]).toBe('s1,"Jira, Cloud; b"');
  });
});

describe("quoting", () => {
  const steps = [step({ step_id: "q1", type: "open_text", prompt: "Thoughts?" })];

  it.each([
    ["a comma", "Good, mostly", '"Good, mostly"'],
    ["a quote", 'He said "no"', '"He said ""no"""'],
    ["a newline", "line one\nline two", '"line one\nline two"']
  ])("quotes %s", (_label, text, expected) => {
    const csv = toResponsesCsv(steps, [response("q1", "s1", { text })]);

    expect(rows(csv)[1]).toBe(`s1,${expected}`);
  });

  it("quotes a prompt containing a comma", () => {
    const csv = toResponsesCsv(
      [step({ step_id: "q1", type: "open_text", prompt: "Easy, or hard?" })],
      []
    );

    expect(rows(csv)[0]).toBe('Participant,"Easy, or hard?"');
  });
});

/**
 * A cell starting =, +, - or @ is executed as a formula when the file is
 * opened in Excel or Sheets. Participant free text lands in these cells
 * verbatim, so an answer of `=HYPERLINK(...)` becomes a live formula in a
 * researcher's spreadsheet - the standard CSV injection route.
 */
describe("formula injection", () => {
  const steps = [step({ step_id: "q1", type: "open_text", prompt: "Thoughts?" })];

  it.each([["="], ["+"], ["@"]])(
    "neutralises a cell starting with %s",
    (lead) => {
      const csv = toResponsesCsv(steps, [
        response("q1", "s1", { text: `${lead}HYPERLINK("http://evil.test")` })
      ]);

      expect(rows(csv)[1]).not.toMatch(new RegExp(`^s1,"?\\${lead}`));
      expect(rows(csv)[1]).toContain("HYPERLINK");
    }
  );

  it("neutralises a formula disguised as a negative number", () => {
    const csv = toResponsesCsv(steps, [
      response("q1", "s1", { text: '-2+3+cmd|" /c calc"!A0' })
    ]);

    expect(rows(csv)[1]).not.toMatch(/^s1,"?-/);
  });

  it("leaves ordinary text alone", () => {
    const csv = toResponsesCsv(steps, [
      response("q1", "s1", { text: "No problems at all" })
    ]);

    expect(rows(csv)[1]).toBe("s1,No problems at all");
  });

  // Question prompts are free text authored by any researcher_admin, and the
  // person who opens the export is a superadmin - so a formula in a prompt is
  // aimed at the highest-privileged user in the system, through the header
  // row rather than the data rows.
  it("neutralises a formula in a researcher-authored prompt", () => {
    const csv = toResponsesCsv(
      [
        step({
          step_id: "q1",
          type: "open_text",
          prompt: '=HYPERLINK("http://evil.test","Click")'
        })
      ],
      [response("q1", "s1", { text: "Fine" })]
    );

    expect(rows(csv)[0]).not.toMatch(/^Participant,"?=/);
    expect(rows(csv)[0]).toContain("HYPERLINK");
  });

  it("leaves an ordinary prompt readable in the header", () => {
    const csv = toResponsesCsv(steps, [response("q1", "s1", { text: "Fine" })]);

    expect(rows(csv)[0]).toBe("Participant,Thoughts?");
  });

  // A rating is generated by us from a bounded integer, never typed by a
  // participant, so it must not pick up a defensive prefix and stop being a
  // number in the spreadsheet.
  it("leaves a numeric rating usable as a number", () => {
    const csv = toResponsesCsv(
      [step({ step_id: "q1", type: "rating", prompt: "Ease", config: { scale_max: 5 } })],
      [response("q1", "s1", { rating: 4 })]
    );

    expect(rows(csv)[1]).toBe("s1,4");
  });
});
