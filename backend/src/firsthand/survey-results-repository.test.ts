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
  listResponsesForStudy
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

  describe("listResponsesForStudy", () => {
    it("spans every opportunity, which is why its route stays superadmin-only", async () => {
      await listResponsesForStudy("study_abc");

      expect(whereClauseOf(captured[0].sql)).toBe("s.study_id = $1");
      expect(captured[0].params).toEqual(["study_abc"]);
    });
  });
});
