import crypto from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";

/**
 * AUTO-CLOSING A STUDY AT ITS END DATE, AGAINST A REAL DATABASE (Decision 3).
 *
 * `autoClosePublishedStudiesPastEndDate` flips `published -> closed` for every
 * study whose `end_date` has passed. WHY A REAL POSTGRES rather than a pool
 * mock: `status` is a Postgres ENUM (`opportunity_status`), not an app-level
 * string, and a mocked UPDATE cannot see an enum mismatch, a CHECK on the row,
 * or that `NOW()` is the database clock. A mocked close-if-past suite already
 * exists and asserts the app ASKS for the UPDATE; it cannot prove the write
 * lands. A prior status change shipped a CHECK violation exactly this way, so
 * the boundary here is a real timestamptz comparison against real constraints.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB vitest
 * job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let autoClosePublishedStudiesPastEndDate: () => Promise<number>;

/**
 * A published study owned by `ownerId`, with the given `end_date` offset from
 * NOW() (or no end_date when `endOffset` is null) and the given status.
 * Returns its id.
 */
async function seedStudy(
  ownerId: string,
  status: "draft" | "published" | "closed",
  endOffset: string | null
): Promise<string> {
  const id = crypto.randomUUID();
  const endDateExpr = endOffset === null ? "NULL" : "NOW() + ($4)::interval";
  const params =
    endOffset === null ? [id, ownerId, status] : [id, ownerId, status, endOffset];
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, end_date)
     VALUES ($1, 'poll', 'Ended-study sweep fixture',
             'Proving the end-date auto-close against a real database', $2, $3, ${endDateExpr})`,
    params
  );
  return id;
}

const storedStatus = async (id: string): Promise<string> => {
  const { rows } = await pool.query("SELECT status FROM opportunities WHERE id = $1", [id]);
  return rows[0].status as string;
};

describe.skipIf(skipDbTests)(
  "auto-closing published studies at their end date, against a real Postgres",
  () => {
    let ownerId: string;

    beforeAll(async () => {
      postgres = await startTestPostgres("opportunity-end-date-close");

      // BEFORE importing ../../config: the pool reads DATABASE_URL once, at import.
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.SESSION_SECRET ||=
        "vitest-postgres-end-date-close-constant-not-a-real-secret"; // gitleaks:allow
      process.env.NODE_ENV = "test";

      const { runMigrations } = await import("../../db/migrate");
      await runMigrations();

      const { pool: appPool } = await import("../../config");
      pool = appPool;

      ({ autoClosePublishedStudiesPastEndDate } = await import("../opportunityLifecycle"));
    }, 180_000);

    afterAll(async () => {
      await pool?.end().catch(() => {});
      await postgres?.stop();
      delete process.env.DATABASE_URL;
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE opportunities, users CASCADE");
      ownerId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
        [ownerId, `owner-${ownerId}@example.com`]
      );
    });

    it("closes a published study whose end date has passed, and reports it closed one", async () => {
      const ended = await seedStudy(ownerId, "published", "-1 hour");

      const closed = await autoClosePublishedStudiesPastEndDate();

      expect(closed).toBe(1);
      expect(await storedStatus(ended)).toBe("closed");
    });

    it("leaves a published study whose end date is still in the future", async () => {
      const live = await seedStudy(ownerId, "published", "+1 day");

      const closed = await autoClosePublishedStudiesPastEndDate();

      // The control that proves the sweep is not just closing every published
      // study: an unpaired UPDATE with a broken predicate would fail here.
      expect(closed).toBe(0);
      expect(await storedStatus(live)).toBe("published");
    });

    it("leaves an open-ended published study with no end date", async () => {
      const openEnded = await seedStudy(ownerId, "published", null);

      const closed = await autoClosePublishedStudiesPastEndDate();

      expect(closed).toBe(0);
      expect(await storedStatus(openEnded)).toBe("published");
    });

    it("does not resurrect-then-close a draft whose date has passed", async () => {
      const draft = await seedStudy(ownerId, "draft", "-1 day");

      const closed = await autoClosePublishedStudiesPastEndDate();

      // Only published -> closed. A draft past its date stays a draft; closing
      // it would publish-by-side-effect a study its author never launched.
      expect(closed).toBe(0);
      expect(await storedStatus(draft)).toBe("draft");
    });

    it("is idempotent: a second run closes nothing new", async () => {
      const ended = await seedStudy(ownerId, "published", "-2 hours");
      const alreadyClosed = await seedStudy(ownerId, "closed", "-3 days");

      expect(await autoClosePublishedStudiesPastEndDate()).toBe(1);
      // The already-closed study is untouched, and a re-run finds nothing.
      expect(await storedStatus(alreadyClosed)).toBe("closed");
      expect(await autoClosePublishedStudiesPastEndDate()).toBe(0);
      expect(await storedStatus(ended)).toBe("closed");
    });
  }
);
