import { describe, expect, it } from "vitest";

import type { StudyStep } from "../../../shared/firsthand/contract";
import { toCsvContentDisposition, toResponsesCsv } from "./survey-csv";
import type { StoredResponse } from "./survey-results";

const step = (over: Partial<StudyStep> & Pick<StudyStep, "type" | "step_id">) =>
  ({ order: 1, prompt: "Question", ...over }) as StudyStep;

const response = (
  stepId: string | null,
  sessionId: string,
  payload: Record<string, unknown>,
  over: Partial<StoredResponse> = {}
): StoredResponse => ({
  session_id: sessionId,
  step_id: stepId,
  // Spelled out rather than defaulted away, because a fixture that omits a
  // field cannot test what the field does - and this one decides whether an
  // answer is reported under a live question or a removed one.
  step_prompt: null,
  step_type: "x",
  response_payload: payload,
  saved_at: "2026-08-16T09:00:00.000Z",
  ...over
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

/**
 * Node THROWS on a header value it cannot encode as latin1 rather than
 * mangling it, so this is the difference between an export that works and one
 * that 500s until somebody guesses the title is at fault.
 */
describe("toCsvContentDisposition", () => {
  // The header is written by res.setHeader, which is where the throw happens.
  // Reproducing that check here is what makes this a test of the real failure
  // rather than of a regex.
  const isLatin1Encodable = (value: string) =>
    Buffer.from(value, "latin1").toString("latin1") === value;

  it("survives a title Node could not put in a header", () => {
    // A curly apostrophe, which is what pasting from Word produces.
    const header = toCsvContentDisposition("Nick’s survey");

    expect(isLatin1Encodable(header)).toBe(true);
  });

  it("still carries the real title, in the encoded form clients prefer", () => {
    const header = toCsvContentDisposition("Nick’s survey");

    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent("Nick’s survey responses.csv"));
  });

  it("keeps an ordinary title readable in the plain filename", () => {
    expect(toCsvContentDisposition("Pulse check")).toContain(
      'filename="Pulse check responses.csv"'
    );
  });

  it("strips a quote that would close the filename early", () => {
    const header = toCsvContentDisposition('Ple"ase');

    expect(header).toContain('filename="Please responses.csv"');
  });

  // The cap is applied in code points. `slice` counts UTF-16 code units, so a
  // title whose 80th unit was the first half of an emoji left a lone surrogate
  // and encodeURIComponent threw URIError - a 500 on the export, which is the
  // failure this function exists to remove, reached another way.
  it("does not break an emoji in half at the length cap", () => {
    const title = `${"A".repeat(79)}\u{1F600}`;

    expect(() => toCsvContentDisposition(title)).not.toThrow();
  });

  it("keeps the whole emoji rather than dropping it at the cap", () => {
    const header = toCsvContentDisposition(`${"A".repeat(79)}\u{1F600}`);

    expect(header).toContain(encodeURIComponent("\u{1F600}"));
  });

  it("still caps a long title", () => {
    const header = toCsvContentDisposition("B".repeat(200));

    expect(header).toContain(`filename="${"B".repeat(80)} responses.csv"`);
  });

  it("falls back to a usable name when nothing printable survives", () => {
    // Every character non-latin1, so the ASCII fallback empties out.
    expect(toCsvContentDisposition("你好")).toContain(
      'filename="survey responses.csv"'
    );
  });
});

/**
 * F2. Columns for questions the study no longer has.
 *
 * The export is where a finding actually gets computed, so a detached answer
 * that quietly did not appear would hand a researcher a smaller data set than
 * they believe they are looking at - with nothing on the sheet saying so.
 */
describe("answers to a removed question", () => {
  const live = [step({ step_id: "q1", type: "open_text", prompt: "Still asked" })];

  const detached = (
    prompt: string | null,
    sessionId: string,
    payload: Record<string, unknown>,
    stepType = "open_text"
  ) => response(null, sessionId, payload, { step_prompt: prompt, step_type: stepType });

  it("gets a column of its own, marked as removed", () => {
    const csv = toResponsesCsv(live, [
      response("q1", "s1", { text: "live" }),
      detached("What did you think of the old checkout?", "s1", { text: "detached" })
    ]);

    expect(rows(csv)[0]).toBe(
      "Participant,Still asked,What did you think of the old checkout? (removed question)"
    );
    expect(rows(csv)[1]).toBe("s1,live,detached");
  });

  it("does not spill a detached answer into a live question's column", () => {
    // The two are keyed differently - one by step id, one by prompt and type -
    // and a shared key would put the detached answer under "Still asked".
    const csv = toResponsesCsv(live, [
      detached("Removed", "s1", { text: "detached" })
    ]);

    expect(rows(csv)[1]).toBe("s1,,detached");
  });

  it("leaves the cell blank for a participant who never saw the removed question", () => {
    const csv = toResponsesCsv(live, [
      response("q1", "s1", { text: "live" }),
      detached("Removed", "s2", { text: "detached" })
    ]);

    expect(rows(csv).slice(1)).toEqual(["s1,live,", "s2,,detached"]);
  });

  it("neutralises a removed prompt that would run as a formula", () => {
    // The suffix must not become the thing that makes the cell safe: the
    // prompt is still researcher-authored free text, and the person opening
    // this export is the highest-privileged user in the system.
    const csv = toResponsesCsv(live, [
      detached('=HYPERLINK("http://evil.test")', "s1", { text: "a" })
    ]);

    expect(rows(csv)[0]).toContain('"\t=HYPERLINK(""http://evil.test"") (removed question)"');
  });

  it("names the column plainly when the wording was never recorded", () => {
    const csv = toResponsesCsv(live, [detached(null, "s1", { text: "a" })]);

    expect(rows(csv)[0]).toBe(
      "Participant,Still asked,A question that has since been removed (removed question)"
    );
  });

  it("adds no columns when nothing was removed", () => {
    const csv = toResponsesCsv(live, [response("q1", "s1", { text: "live" })]);

    expect(rows(csv)[0]).toBe("Participant,Still asked");
  });
});
