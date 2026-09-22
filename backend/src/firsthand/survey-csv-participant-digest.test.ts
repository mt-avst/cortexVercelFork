import { describe, expect, it } from "vitest";

import { participantDigest } from "./survey-csv";

// Vitest owns src/firsthand/** and sets no secrets of its own (unlike jest's
// src/__tests__/setup.ts) - see the note beside `../config`'s Queryable type
// in studies-repository.ts for why this file cannot import that module
// instead. Same shape as pool-statement-timeout-postgres.test.ts.
process.env.SESSION_SECRET ||=
  "vitest-survey-csv-participant-digest-not-a-real-secret"; // gitleaks:allow

/**
 * cto/AdaptaLabs#154. The Participant column used to print `participant_id`
 * (`users.id`) raw - stable across every study the same person takes part in,
 * so two exports from two DIFFERENT studies could be joined on it, which two
 * session ids could not. The replacement has to hold two properties at once:
 * stable WITHIN one study (so a researcher can still tell one person's two
 * sessions from two people's one each - the whole point of #152) and
 * UNRELATED across studies (so this column cannot join two exports the way
 * the raw id could).
 */
describe("participantDigest", () => {
  it("is stable for the same participant in the same study", () => {
    expect(participantDigest("study_a", "user_1")).toBe(
      participantDigest("study_a", "user_1")
    );
  });

  it("differs for the same participant across two different studies", () => {
    expect(participantDigest("study_a", "user_1")).not.toBe(
      participantDigest("study_b", "user_1")
    );
  });

  it("differs for two different participants in the same study", () => {
    expect(participantDigest("study_a", "user_1")).not.toBe(
      participantDigest("study_a", "user_2")
    );
  });

  it("is not the raw id, nor a trivial transform of it, and is a fixed hex shape", () => {
    const digest = participantDigest("study_a", "user_1");

    expect(digest).not.toContain("user_1");
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses to run without a server secret to key on", () => {
    const original = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;

    try {
      expect(() => participantDigest("study_a", "user_1")).toThrow(
        /SESSION_SECRET/
      );
    } finally {
      process.env.SESSION_SECRET = original;
    }
  });

  it("does not let a delimiter collision fake a cross-study match", () => {
    // Would collide on a plain-space-joined message: "study a" + "b" ===
    // "study" + "a b". Guards the NUL separator, not the space one it
    // replaced.
    expect(participantDigest("study a", "b")).not.toBe(
      participantDigest("study", "a b")
    );
  });
});
