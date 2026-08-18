import { beforeEach, describe, expect, it, vi } from "vitest";

const isPostgresRuntimeConfigured = vi.fn(() => true);
const captured: Array<{ sql: string; params: unknown[] }> = [];
const rowsToReturn: Array<Record<string, unknown>> = [];

vi.mock("./runtime-database", () => ({
  isPostgresRuntimeConfigured: () => isPostgresRuntimeConfigured(),
  withRuntimeDatabaseClient: async (
    run: (client: {
      query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
    }) => Promise<unknown>
  ) =>
    run({
      query: async (sql: string, params: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [...rowsToReturn] };
      }
    })
}));

import {
  listResponsesForOpportunity,
  listResponsesForStudy,
  studyHasResponses
} from "./survey-results-repository";

/**
 * The WHERE clause here IS the authorisation boundary.
 *
 * The routes that call these are tested with this module mocked, so nothing
 * above this file can tell the two readers apart - a `listResponsesForOpportunity`
 * that quietly ignored its opportunity would return the study-wide set to a
 * researcher entitled only to their own, and every route test would still pass.
 */
describe("survey results readers", () => {
  beforeEach(() => {
    captured.length = 0;
    rowsToReturn.length = 0;
    isPostgresRuntimeConfigured.mockReturnValue(true);
  });

  const whereClauseOf = (sql: string) =>
    sql.split(/\bWHERE\b/)[1].split(/\bORDER BY\b/)[0].trim();

  describe("listResponsesForOpportunity", () => {
    it("filters on the opportunity as well as the study", async () => {
      await listResponsesForOpportunity({
        // Deliberately unalike, and neither is a substring of the other: a
        // shared value cannot tell a correct binding from a swapped one.
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      // Asserted as a literal rather than against the module's own string.
      // An assertion that reads the constant moves with it, so it survives the
      // clause being narrowed to the study alone.
      expect(whereClauseOf(captured[0].sql)).toBe(
        "s.study_id = $1 AND s.opportunity_id = $2"
      );
    });

    it("binds the study first and the opportunity second", async () => {
      await listResponsesForOpportunity({
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      // Positional, not toContain: both values appear in the array either way,
      // so a swap is only visible by index.
      expect(captured[0].params[0]).toBe("study_abc");
      expect(captured[0].params[1]).toBe("opportunity-777");
    });

    it("maps a stored row into the shape the aggregation reads", async () => {
      rowsToReturn.push({
        session_id: "session_1",
        step_id: "q1",
        step_type: "rating",
        response_payload: { rating: 4 },
        saved_at: "2026-08-17T10:00:00.000Z"
      });

      const responses = await listResponsesForOpportunity({
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      expect(responses).toEqual([
        {
          session_id: "session_1",
          step_id: "q1",
          step_type: "rating",
          response_payload: { rating: 4 },
          saved_at: "2026-08-17T10:00:00.000Z"
        }
      ]);
    });

    it("reads nothing at all when the runtime database is not configured", async () => {
      isPostgresRuntimeConfigured.mockReturnValue(false);

      const responses = await listResponsesForOpportunity({
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      expect(responses).toEqual([]);
      expect(captured).toHaveLength(0);
    });
  });

  describe("the row bound", () => {
    /**
     * A loop, not `push(...rowsOf(n))`. Spreading two hundred thousand items
     * into a call exceeds the argument limit and throws RangeError, which
     * surfaces as "Maximum call stack size exceeded" and reads as a fault in
     * the repository rather than in the fixture.
     */
    const pushRows = (count: number) => {
      for (let index = 0; index < count; index += 1) {
        rowsToReturn.push({
          session_id: `session_${index}`,
          step_id: "q1",
          step_type: "rating",
          response_payload: { rating: 4 },
          saved_at: "2026-08-17T10:00:00.000Z"
        });
      }
    };

    it("asks the database for one row more than it will return", async () => {
      await listResponsesForOpportunity({ opportunityId: "o", studyId: "s" });

      // The +1 is the detector. Without it a full page is indistinguishable
      // from a complete result set.
      expect(captured[0].sql).toContain("LIMIT 200001");
    });

    it("refuses rather than truncating when the bound is passed", async () => {
      pushRows(200_001);

      // A mean, an NPS and a CSV computed over part of the data, with nothing
      // saying so, is a wrong finding presented as a finding.
      await expect(
        listResponsesForOpportunity({ opportunityId: "o", studyId: "s" })
      ).rejects.toMatchObject({ statusCode: 413 });
    });

    it("returns a result set that exactly fills the bound", async () => {
      pushRows(200_000);

      const responses = await listResponsesForOpportunity({
        opportunityId: "o",
        studyId: "s"
      });

      // Off-by-one in the other direction: refusing at the bound rather than
      // past it would refuse a study that fits.
      expect(responses).toHaveLength(200_000);
    });
  });

  describe("listResponsesForStudy", () => {
    it("spans every opportunity, which is why its route stays superadmin-only", async () => {
      await listResponsesForStudy("study_abc");

      expect(whereClauseOf(captured[0].sql)).toBe("s.study_id = $1");
      expect(captured[0].params).toEqual(["study_abc"]);
    });
  });
});

/**
 * The existence check that decides whether a study's questions may be
 * rewritten in place. It is a refusal predicate, not a reader, so its failure
 * direction is the opposite of everything above.
 */
describe("studyHasResponses", () => {
  beforeEach(() => {
    captured.length = 0;
    rowsToReturn.length = 0;
    isPostgresRuntimeConfigured.mockReturnValue(true);
  });

  it("reports false when the study has no stored answers", async () => {
    expect(await studyHasResponses("study_abc")).toBe(false);
  });

  it("reports true as soon as one answer exists", async () => {
    rowsToReturn.push({ "?column?": 1 });

    expect(await studyHasResponses("study_abc")).toBe(true);
  });

  it("filters on the study, through the session that carries it", async () => {
    await studyHasResponses("study_abc");

    // participant_responses has no study_id of its own, so the join IS the
    // filter. Asserted as literals rather than against the module's strings.
    expect(captured[0].sql).toContain(
      "JOIN runtime_sessions AS s ON s.session_id = r.session_id"
    );
    expect(captured[0].sql.split(/\bWHERE\b/)[1]).toContain("s.study_id = $1");
    expect(captured[0].params[0]).toBe("study_abc");
  });

  it("stops at the first row rather than loading the answers", async () => {
    await studyHasResponses("study_abc");

    // The whole point of not reusing listResponsesForStudy: this runs on the
    // five-connection pool that live participant sessions share, and the
    // answer set it would otherwise materialise is unbounded.
    expect(captured[0].sql).toContain("LIMIT 1");
    expect(captured[0].sql).not.toContain("response_payload");
  });

  it("assumes there ARE answers when the runtime database is not configured", async () => {
    // Fails CLOSED, unlike every reader above, and that inversion is the
    // point. This drives a refusal, so answering "no answers" would read as
    // "safe to rewrite the questions" and disable the guard by exactly the
    // misconfiguration that makes it impossible to check.
    isPostgresRuntimeConfigured.mockReturnValue(false);

    expect(await studyHasResponses("study_abc")).toBe(true);
    expect(captured).toHaveLength(0);
  });
});
