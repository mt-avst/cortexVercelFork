import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONSENT_TEXT,
  inlineStudySchema
} from "../../../shared/firsthand/inline-study";

/**
 * This constant is not documentation - it is pre-filled into the required
 * Consent field on every new unmoderated study, so unless a researcher rewrites
 * boilerplate the product handed them, it IS the consent the participant
 * accepts before recording starts.
 *
 * It used to end "You can stop at any time." There is no stop, withdraw or
 * exit control anywhere in the recording flow. The only way out is the
 * browser's own Stop sharing, and the partial recording is uploaded anyway -
 * so the sentence promised a control that does not exist, on the one surface
 * where the promise is a consent term, and it contradicted Cortex's own
 * non-authorable "Before you start" panel two hundred pixels further down the
 * same page.
 */
describe("DEFAULT_CONSENT_TEXT", () => {
  it("does not promise a stop control that the recording flow does not have", () => {
    expect(DEFAULT_CONSENT_TEXT).not.toMatch(/stop at any time/i);
    expect(DEFAULT_CONSENT_TEXT).not.toMatch(/withdraw at any time/i);
  });

  it("names the only thing that actually ends a recording", () => {
    // Recording ends when the shared display track fires `ended`
    // (session-recorder.ts). Nothing else stops it - not closing the task
    // window, and not any control Cortex renders.
    expect(DEFAULT_CONSENT_TEXT).toMatch(/screen share|sharing/i);
  });

  it("says the part already recorded is still sent, because it is", () => {
    expect(DEFAULT_CONSENT_TEXT).toMatch(/still (sent|uploaded)|up to that point/i);
  });

  it("is still a valid consent value for a study", () => {
    const parsed = inlineStudySchema.safeParse({
      title: "A study",
      consent_text: DEFAULT_CONSENT_TEXT,
      steps: [{ type: "instruction", prompt: "Open the dashboard" }]
    });
    expect(parsed.success).toBe(true);
  });
});
