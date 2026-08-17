import { describe, expect, it } from "vitest";

import type { SessionPayload } from "../../../shared/firsthand/contract";
import { runtimeMutationSchema } from "./runtime-records";
import {
  applyRuntimeMutationToSession,
  createRuntimeSessionRecord
} from "./runtime-session-model";

/**
 * The write path, end to end at the unit level: the body the browser sends,
 * through the mutation schema, through the session model, into the stored
 * response record.
 *
 * This suite exists because of a defect the results suites could not see: the
 * survey feature taught the client to send `selectedOptions` and `rating`
 * while `responsePayloadSchema` still knew only `text` and `selectedOption`,
 * and zod's default key-stripping stored every multi_choice, rating and nps
 * answer as `{}` - a 200, an empty aggregate, no error anywhere. The results
 * tests passed throughout, because they hand-built stored fixtures in shapes
 * the write path could never produce. So: fixtures here are the CLIENT's
 * bodies, never the stored shape, and the assertion is that what was sent is
 * what is stored.
 */

const payload: SessionPayload = {
  contract_version: "1.0",
  study: { id: "study_1", title: "S", intro_text: "i", consent_text: "c" },
  participant: { participant_id: "user_1" },
  session: {
    session_id: "session_1",
    session_token: "tok",
    study_id: "study_1",
    participant_id: "user_1"
  },
  steps: [
    { step_id: "s_text", order: 1, type: "open_text", prompt: "Thoughts?" },
    {
      step_id: "s_single",
      order: 2,
      type: "single_choice",
      prompt: "Pick one",
      options: ["Red", "Blue"]
    },
    {
      step_id: "s_multi",
      order: 3,
      type: "multi_choice",
      prompt: "Pick some",
      options: ["A", "B", "C"]
    },
    {
      step_id: "s_rating",
      order: 4,
      type: "rating",
      prompt: "Ease",
      config: { scale_max: 5 }
    },
    { step_id: "s_nps", order: 5, type: "nps", prompt: "Recommend?" }
  ]
};

const submissions: Array<{
  stepId: string;
  stepType: string;
  responsePayload: Record<string, unknown>;
}> = [
  { stepId: "s_text", stepType: "open_text", responsePayload: { text: "Good" } },
  {
    stepId: "s_single",
    stepType: "single_choice",
    responsePayload: { selectedOption: "Red" }
  },
  {
    stepId: "s_multi",
    stepType: "multi_choice",
    responsePayload: { selectedOptions: ["A", "C"] }
  },
  { stepId: "s_rating", stepType: "rating", responsePayload: { rating: 4 } },
  // Zero is a real NPS score; it must survive as 0, not vanish as falsy.
  { stepId: "s_nps", stepType: "nps", responsePayload: { rating: 0 } }
];

describe("a submitted answer is stored intact, per step type", () => {
  it.each(submissions)(
    "$stepType round-trips $responsePayload",
    ({ stepId, stepType, responsePayload }) => {
      const parsed = runtimeMutationSchema.parse({
        type: "response",
        stepId,
        stepType,
        responsePayload
      });

      const session = createRuntimeSessionRecord(payload);
      applyRuntimeMutationToSession(session, parsed);

      const stored = session.responses.find(
        (response) => response.stepId === stepId
      );

      expect(stored?.responsePayload).toEqual(responsePayload);
    }
  );
});

describe("the mutation boundary is strict about answer keys", () => {
  it("rejects an unknown key instead of silently stripping it", () => {
    const result = runtimeMutationSchema.safeParse({
      type: "response",
      stepId: "s_nps",
      stepType: "nps",
      responsePayload: { score: 9 }
    });

    // Under the pre-fix schema this parsed successfully as {} - the answer
    // accepted and discarded. Client/schema drift must be a 422 the first
    // time it is submitted, not an empty column in the researcher's export.
    expect(result.success).toBe(false);
  });

  it("still accepts the recorded flow's original shapes", () => {
    for (const responsePayload of [{ text: "spoken" }, { selectedOption: "Red" }]) {
      const result = runtimeMutationSchema.safeParse({
        type: "response",
        stepId: "s_text",
        stepType: "open_text",
        responsePayload
      });

      expect(result.success).toBe(true);
    }
  });
});
