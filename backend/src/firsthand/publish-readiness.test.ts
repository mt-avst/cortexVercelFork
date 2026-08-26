import { describe, expect, it } from "vitest";

import {
  findPublishProblem,
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
     * `question` is external-only: `getTabsForType` gives it the External Link
     * step unconditionally and offers no native alternative. So a published
     * `question` with no link is a study nobody can take part in - the detail
     * page renders a disabled "Link unavailable" button, which is the honest
     * thing to show and the wrong place to find out.
     *
     * The gate said nothing about this type at all, so the refusal never fired
     * and the author was never warned.
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
  });

  describe.each([["test"], ["interview"]])("%s", (type) => {
    it("needs nothing to publish", () => {
      // Both are booked rather than handed off, and Session Management is
      // their only authoring step. Requiring a link here would make a bookable
      // study unpublishable, since the form offers it no link field.
      expect(findPublishProblem(input({ type }))).toBeNull();
    });
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
