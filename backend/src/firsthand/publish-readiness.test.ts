import { describe, expect, it } from "vitest";

import {
  findPublishProblem,
  findPublishProblems,
  PUBLISH_PROBLEM_MESSAGES,
  type PublishReadinessInput
} from "../../../shared/firsthand/publish-readiness";
import { OPPORTUNITY_TYPES } from "../../../shared/constants";

/**
 * Direct tests for the publish gate. It had none: it was exercised only
 * transitively through the create and update routes, which test the shapes
 * those routes happen to send. That is how `question` came to be the one type
 * the gate says nothing about - no test enumerated the types, so nothing
 * noticed the gap.
 *
 * The enumerating test below is the guard against that recurring. A new type
 * added to OPPORTUNITY_TYPES now has to be given an explicit decision here
 * rather than falling through the bottom of the function unremarked.
 */

/**
 * The publishable baseline: published, external delivery, no study, no link.
 * Every test states only the fields it is about, so a reader can see which
 * value is under test rather than diffing two long literals.
 */
const input = (over: Partial<PublishReadinessInput> = {}): PublishReadinessInput => ({
  willBePublished: true,
  type: "test",
  deliveryMode: "external",
  hasLinkedStudy: false,
  hasInlineStudy: false,
  hasInlineSurvey: false,
  ...over
});

describe("findPublishProblem", () => {
  it("permits any shape that is not being published", () => {
    // The draft escape hatch, asserted on the type MOST likely to be refused:
    // an unmoderated study with nothing attached. If this ever starts gating
    // drafts, an author could not save work in progress.
    expect(
      findPublishProblem(
        input({ willBePublished: false, type: "unmoderated" })
      )
    ).toBeNull();
  });

  describe("unmoderated", () => {
    it("refuses a publish with no task list", () => {
      expect(findPublishProblem(input({ type: "unmoderated" }))).toEqual({
        code: "unmoderated_study_required"
      });
    });

    it("words it differently when the task list is being taken away", () => {
      expect(
        findPublishProblem(
          input({ type: "unmoderated", removingLinkedStudy: true })
        )
      ).toEqual({ code: "unmoderated_study_removed" });
    });

    it.each([
      ["a linked task list", { hasLinkedStudy: true }],
      ["an inline task list", { hasInlineStudy: true }]
    ])("permits a publish with %s", (_label, over) => {
      expect(
        findPublishProblem(input({ type: "unmoderated", ...over }))
      ).toBeNull();
    });

    it("never asks an unmoderated study for a link", () => {
      // It has nowhere external to go. A link requirement here would be
      // unsatisfiable through the form, which offers no link field for it.
      expect(
        findPublishProblem(
          input({ type: "unmoderated", hasInlineStudy: true, externalLink: "" })
        )
      ).toBeNull();
    });
  });

  describe.each([["poll"], ["survey"]])("%s", (type) => {
    it("refuses an external publish with no link", () => {
      expect(findPublishProblem(input({ type }))).toEqual({
        code: "external_link_required"
      });
    });

    it("permits an external publish with a usable link", () => {
      expect(
        findPublishProblem(input({ type, externalLink: "https://example.com/s" }))
      ).toBeNull();
    });

    it("refuses a native publish with no questions", () => {
      expect(
        findPublishProblem(input({ type, deliveryMode: "native" }))
      ).toEqual({ code: "native_survey_study_required" });
    });

    it("does not ask a native publish for a link", () => {
      expect(
        findPublishProblem(
          input({ type, deliveryMode: "native", hasInlineSurvey: true })
        )
      ).toBeNull();
    });
  });

  describe("question", () => {
    /*
     * `question` has BOTH shapes since #78. Externally it hands off, and a
     * published one with no link is a study nobody can take part in - the
     * detail page renders a disabled "Link unavailable" button, which is the
     * honest thing to show and the wrong place to find out. The gate said
     * nothing about this type at all, so that refusal never fired and the
     * author was never warned.
     *
     * Natively it runs in SurveyRunner and needs its question instead, which
     * is the arm below. The two must not eat each other: the native arm
     * returns for every shape it covers, so a native question is never asked
     * for a link, and an external one is never let through without one.
     *
     * These tests are stated on the DEFAULT (external) mode, so they keep
     * holding for the pre-#78 rows: `delivery_mode` defaults to external in
     * the column and every question ever stored is one.
     */
    it("refuses a publish with no link", () => {
      expect(findPublishProblem(input({ type: "question" }))).toEqual({
        code: "external_link_required"
      });
    });

    it("refuses a publish whose link is not a usable web address", () => {
      // Guarded on the SCHEME rather than on the string being non-empty, for
      // the same reason the participant-facing render gate is: a stored
      // `javascript:` URL must not become an href.
      expect(
        findPublishProblem(
          input({ type: "question", externalLink: "javascript:alert(1)" })
        )
      ).toEqual({ code: "external_link_required" });
    });

    it("permits a publish with a usable link", () => {
      expect(
        findPublishProblem(
          input({ type: "question", externalLink: "https://example.com/q" })
        )
      ).toBeNull();
    });

    it("still permits saving an unlinked draft", () => {
      expect(
        findPublishProblem(input({ type: "question", willBePublished: false }))
      ).toBeNull();
    });

    describe("running natively (#78)", () => {
      it("asks for its question rather than for a link", () => {
        expect(
          findPublishProblem(input({ type: "question", deliveryMode: "native" }))
        ).toEqual({ code: "native_survey_study_required" });
      });

      it("permits a publish on an authored question, with no link at all", () => {
        expect(
          findPublishProblem(
            input({
              type: "question",
              deliveryMode: "native",
              hasInlineSurvey: true
            })
          )
        ).toBeNull();
      });

      it("permits a publish on a linked set of questions", () => {
        expect(
          findPublishProblem(
            input({
              type: "question",
              deliveryMode: "native",
              hasLinkedStudy: true
            })
          )
        ).toBeNull();
      });

      /*
       * The ordering assertion, and the one a reader is most likely to break
       * by tidying: move the link check above the native arm and this is the
       * test that goes red. Without it, a native question with its question
       * written would be refused for want of a link it does not use - and the
       * author would be sent to a step their shape does not have.
       */
      it("never asks a native question for a link", () => {
        expect(
          findPublishProblem(
            input({
              type: "question",
              deliveryMode: "native",
              hasInlineSurvey: true,
              externalLink: undefined
            })
          )
        ).toBeNull();
      });
    });
  });

  describe.each([["test"], ["interview"]])("%s", (type) => {
    it("needs no link or study to publish", () => {
      // Both are booked rather than handed off, and Session Management is
      // their only authoring step. Requiring a link here would make a bookable
      // study unpublishable, since the form offers it no link field.
      expect(findPublishProblem(input({ type }))).toBeNull();
    });

    /*
     * The slot gate (audit row 15 / #118). A live session or interview is
     * booked, so a published one with no bookable slot is a study advertised as
     * LIVE / "Book a time" over nothing anyone can book. The signal is
     * DELIBERATELY tri-state:
     *   - `false` -> a caller that positively counted zero bookable slots. Gated.
     *   - `true`  -> at least one. Permitted.
     *   - absent  -> a caller that cannot report (the create route, which writes
     *     no sessions in the same request, and every pre-#118 caller). NOT gated,
     *     or a naive backend would refuse every moderated publish.
     */
    it("refuses a publish when the caller reports no bookable slot", () => {
      expect(findPublishProblem(input({ type, hasBookableSlot: false }))).toEqual({
        code: "bookable_slot_required"
      });
    });

    it("permits a publish when the caller reports a bookable slot", () => {
      expect(
        findPublishProblem(input({ type, hasBookableSlot: true }))
      ).toBeNull();
    });

    it("permits saving a draft with no bookable slot", () => {
      expect(
        findPublishProblem(
          input({ type, willBePublished: false, hasBookableSlot: false })
        )
      ).toBeNull();
    });

    it("does not gate when the caller cannot report slot state", () => {
      // The explicit-signal guard, pinned so a reader cannot "tidy" the branch
      // into `!input.hasBookableSlot` - which would refuse every caller that
      // passes no signal, breaking the create route and every existing test.
      expect(findPublishProblem(input({ type }))).toBeNull();
    });

    /*
     * The meeting-location gate (row 9). Where a session takes place used to be
     * required at step 1, blocking a draft author who had not decided the venue
     * yet. It moves to publish time, and - like the slot gate above - the signal
     * is DELIBERATELY tri-state:
     *   - `false` -> a caller that positively found the field empty. Gated.
     *   - `true`  -> a location is set. Permitted.
     *   - absent  -> a caller that does not report it (the backend routes, which
     *     never required a location and still do not). NOT gated.
     * Each assertion holds the OTHER moderated signal satisfied so it isolates
     * one gate regardless of which is checked first.
     */
    it("refuses a publish when the caller reports no meeting location", () => {
      expect(
        findPublishProblem(
          input({ type, hasMeetingLocation: false, hasBookableSlot: true })
        )
      ).toEqual({ code: "meeting_location_required" });
    });

    it("permits a publish when the caller reports a meeting location", () => {
      expect(
        findPublishProblem(
          input({ type, hasMeetingLocation: true, hasBookableSlot: true })
        )
      ).toBeNull();
    });

    it("permits saving a draft with no meeting location", () => {
      expect(
        findPublishProblem(
          input({ type, willBePublished: false, hasMeetingLocation: false })
        )
      ).toBeNull();
    });

    it("does not gate when the caller cannot report meeting-location state", () => {
      // The explicit-signal guard again: an absent signal (the backend routes,
      // which never enforced a location) must not start refusing.
      expect(
        findPublishProblem(input({ type, hasBookableSlot: true }))
      ).toBeNull();
    });
  });

  /*
   * The mutation-canary killer for the slot gate, deliberately OUTSIDE the
   * describe.each above: `-t` matches by name and the canary refuses an
   * ambiguous (two-match) selection, so this single, uniquely-named assertion
   * is the one the manifest names. `=== true` (the pinned mutation) inverts the
   * gate and fails the first expectation here.
   */
  it("bookable_slot_required fires on a positive report of no bookable slot", () => {
    expect(
      findPublishProblem(input({ type: "test", hasBookableSlot: false }))
    ).toEqual({ code: "bookable_slot_required" });
    expect(
      findPublishProblem(input({ type: "test", hasBookableSlot: true }))
    ).toBeNull();
  });

  /**
   * The guard that would have caught this class of bug.
   *
   * Enumerates OPPORTUNITY_TYPES rather than listing types by hand, so a type
   * added later cannot slip past the gate unconsidered - the same technique
   * that found the dashboard filter missing `unmoderated` entirely.
   *
   * It asserts a DECISION exists per type, not a particular decision: the two
   * bookable types legitimately need nothing. What it refuses to allow is a
   * type nobody has thought about.
   */
  describe("every type has an explicit decision", () => {
    const NEEDS_NOTHING = new Set<string>(["test", "interview"]);

    it.each(Object.values(OPPORTUNITY_TYPES).map((type) => [type]))(
      "%s",
      (type) => {
        const problem = findPublishProblem(input({ type }));

        if (NEEDS_NOTHING.has(type)) {
          expect(problem).toBeNull();
          return;
        }

        // Every other type is refused when published with nothing attached,
        // and the refusal carries a message the author can act on.
        expect(problem, `"${type}" publishes with nothing attached`).not.toBeNull();
        expect(
          PUBLISH_PROBLEM_MESSAGES[problem!.code],
          `"${problem!.code}" has no message`
        ).toBeTruthy();
      }
    );
  });
});

/**
 * Row 4 / row 16: Review needs every unmet requirement, not the first one a
 * chain of early returns happens to reach - and it needs the same checklist
 * on a Draft, which `findPublishProblem` deliberately says nothing about.
 */
describe("findPublishProblems", () => {
  it("readiness returns every unmet requirement", () => {
    // A moderated study with NEITHER a venue nor a slot fails two
    // independent gates at once (audit row 5's seeded studies). The singular
    // `findPublishProblem` reports only the first (location); the plural
    // form reports both, in the same order.
    expect(
      findPublishProblems(
        input({ type: "test", hasMeetingLocation: false, hasBookableSlot: false })
      )
    ).toEqual([
      { code: "meeting_location_required" },
      { code: "bookable_slot_required" }
    ]);
  });

  it("agrees with findPublishProblem when only one gate is unmet", () => {
    expect(
      findPublishProblems(input({ type: "test", hasBookableSlot: false }))
    ).toEqual([{ code: "bookable_slot_required" }]);
  });

  it("returns nothing once every gate for the shape is satisfied", () => {
    expect(
      findPublishProblems(
        input({ type: "test", hasMeetingLocation: true, hasBookableSlot: true })
      )
    ).toEqual([]);
  });

  it("a draft Review sees the same checklist a publish attempt would meet", () => {
    // `willBePublished: false` is not read at all: the question this answers
    // is "what would block a publish", which does not change because the
    // status happens to be Draft right now.
    expect(
      findPublishProblems(
        input({
          type: "unmoderated",
          willBePublished: false,
          hasLinkedStudy: false,
          hasInlineStudy: false
        })
      )
    ).toEqual([{ code: "unmoderated_study_required" }]);
  });

  it("still words a removed task list differently, matching findPublishProblem", () => {
    expect(
      findPublishProblems(
        input({ type: "unmoderated", removingLinkedStudy: true })
      )
    ).toEqual([{ code: "unmoderated_study_removed" }]);
  });

  it("never asks a native question for a link, matching findPublishProblem", () => {
    expect(
      findPublishProblems(
        input({
          type: "question",
          deliveryMode: "native",
          hasInlineSurvey: true,
          externalLink: undefined
        })
      )
    ).toEqual([]);
  });
});
