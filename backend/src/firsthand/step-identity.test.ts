import { describe, expect, it } from "vitest";

import {
  findDuplicateStepIdentity,
  stepIdFor,
  stepKeyOf,
  stepKeysAreComplete,
  stepKeySchema
} from "../../../shared/firsthand/step-identity";

/**
 * The identity F2 stores.
 *
 * The single property everything else rests on is that `stepKeyOf` inverts
 * `stepIdFor`. If it does not, an edit renumbers every question in the study
 * and every answer already collected is detached from the question that
 * produced it - so the round trip is asserted directly rather than inferred
 * from the two halves separately.
 */

describe("a key survives the round trip through a stored id", () => {
  // The uuids in this file are deliberately unrandom - repeating nibbles, a
  // readable pattern - and the variables holding them are named for what they
  // are. Both matter: a plausible v4 uuid assigned to something called `key`
  // is high-entropy enough that the pipeline's `gitleaks` job reports it as a
  // generic-api-key finding and turns main red, which is how this comment came
  // to exist. The shape is what the tests are about; the digits are not.
  it("recovers exactly what was namespaced", () => {
    const studyId = "study_11111111-2222-4333-8444-555555555555";
    const stepKey = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    expect(stepKeyOf(stepIdFor(studyId, stepKey), studyId)).toBe(stepKey);
  });

  it("recovers the positional keys existing studies already carry", () => {
    // The reason nothing had to be rewritten to land F2: every id already
    // stored is `${studyId}_step_N`, and `step_N` is a legal key. Both the
    // unpadded form the inline paths minted and the zero-padded form
    // StudyEditor mints.
    const studyId = "study_demo";

    expect(stepKeyOf("study_demo_step_1", studyId)).toBe("step_1");
    expect(stepKeyOf("study_demo_step_001", studyId)).toBe("step_001");
    expect(stepKeyOf("study_demo_step_end", studyId)).toBe("step_end");
  });

  it("does not split on the separator, because a study id is full of them", () => {
    // `study_<uuid>` contains an underscore, and the uuid contains hyphens. A
    // key recovered by splitting on `_` would return "11111111-..." here and
    // re-namespace to a DIFFERENT id.
    const studyId = "study_11111111-2222-4333-8444-555555555555";

    expect(stepKeyOf(`${studyId}_step_3`, studyId)).toBe("step_3");
  });

  it("answers null for an id outside the study's namespace", () => {
    // Null rather than the whole id. Falling back to the id itself would
    // re-prefix it - `study_b_s1` becoming `study_a_study_b_s1` - which is a
    // silent identity change on the save, exactly what this module exists to
    // stop. Callers treat null as "this form cannot author this study".
    expect(stepKeyOf("study_b_step_1", "study_a")).toBeNull();
    expect(stepKeyOf("s1", "study_a")).toBeNull();
  });

  it("answers null for a namespaced id whose key is not a legal key", () => {
    // The prefix matching alone is not enough: a suffix carrying a space or a
    // slash would be re-namespaced into an id the schema would then refuse.
    expect(stepKeyOf("study_a_step one", "study_a")).toBeNull();
    expect(stepKeyOf("study_a_", "study_a")).toBeNull();
    expect(stepKeyOf(`study_a_${"x".repeat(65)}`, "study_a")).toBeNull();
  });
});

describe("what the schema accepts as a key", () => {
  it("accepts a v4 uuid, which is what the authoring surface mints", () => {
    expect(
      stepKeySchema.safeParse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").success
    ).toBe(true);
  });

  it("refuses characters that would make the stored id ambiguous or unstable", () => {
    for (const candidate of ["", "a b", "a/b", "a.b", "é", "x".repeat(65)]) {
      expect(stepKeySchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("two questions that would be stored as one", () => {
  it("names the second occurrence, which is the one to point at", () => {
    expect(
      findDuplicateStepIdentity([
        { step_key: "a" },
        { step_key: "b" },
        { step_key: "a" }
      ])
    ).toEqual({ index: 2, stepKey: "a" });
  });

  it("is not confused by items that carry no key at all", () => {
    // Two key-less questions are not duplicates of each other: they fall back
    // to `step_1` and `step_2`, which are distinct. Reporting them as a
    // collision would refuse every save from a client that sends no keys,
    // which is the case the fallback exists to keep working.
    expect(findDuplicateStepIdentity([{}, {}, {}])).toBeNull();
  });

  it("answers null when every key is distinct", () => {
    expect(
      findDuplicateStepIdentity([{ step_key: "a" }, { step_key: "b" }])
    ).toBeNull();
  });

  /**
   * The collisions a key-only comparison could not see, and the ones a caller
   * can actually construct. Both were reported by review gates against the
   * first version of this function, which compared keys.
   */
  it("catches a key that collides with another item's POSITIONAL fallback", () => {
    // Index 1 carries no key and derives `step_2`. Index 0 claims `step_2`
    // outright. The two KEYS do not collide - one of them does not exist - but
    // the stored ids do, and the study saves one question short.
    expect(
      findDuplicateStepIdentity([{ step_key: "step_2" }, {}])
    ).toEqual({ index: 1, stepKey: "step_2" });
  });

  it("catches a key that collides with the completion marker", () => {
    // `toSurveySteps` and `toStudySteps` both append `${studyId}_step_end`
    // after the authored list, so an authored question claiming `step_end`
    // produces two rows with one primary key.
    expect(
      findDuplicateStepIdentity([{ step_key: "step_end" }])
    ).toEqual({ index: 0, stepKey: "step_end" });
  });

  it("leaves the ordinary positional list alone", () => {
    // The pair for the two above. Without it, a check that simply refused
    // anything looking like `step_N` would satisfy them and break every
    // key-less save.
    expect(findDuplicateStepIdentity([{}, {}, {}, {}])).toBeNull();
    expect(
      findDuplicateStepIdentity([
        { step_key: "step_1" },
        { step_key: "step_2" },
        { step_key: "step_3" }
      ])
    ).toBeNull();
  });
});

describe("whether a payload's identity can be trusted", () => {
  it("is true only when EVERY item carries a key", () => {
    // All-or-nothing. A half-keyed list is a client bug, and treating it as
    // authoritative would let the un-keyed half fall back to positional ids
    // that could collide with the keyed half.
    expect(stepKeysAreComplete([{ step_key: "a" }, { step_key: "b" }])).toBe(true);
    expect(stepKeysAreComplete([{ step_key: "a" }, {}])).toBe(false);
    expect(stepKeysAreComplete([{}, { step_key: "b" }])).toBe(false);
  });

  it("is false for an empty list", () => {
    // Vacuous truth would be the wrong answer: an empty payload asserts no
    // identity, and the caller uses this to decide whether to STOP applying a
    // safety guard.
    expect(stepKeysAreComplete([])).toBe(false);
  });
});
