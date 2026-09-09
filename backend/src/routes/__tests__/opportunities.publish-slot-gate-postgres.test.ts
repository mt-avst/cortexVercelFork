import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE PUBLISH SLOT GATE, AGAINST A REAL DATABASE (audit row 15 / cto/AdaptaLabs#118).
 *
 * A live session (`test`) or interview is BOOKED, not handed off, so a
 * published one with no bookable slot is a study advertised as LIVE / "Book a
 * time" over nothing anyone can book. The frontend wizard's own gate (row 15's
 * "S") could not close that: a direct `PATCH { status: 'published' }` bypasses
 * the client entirely. This proves the server refuses it.
 *
 * WHY A REAL POSTGRES. `opportunities.test.ts` pins the branch with a positional
 * pool mock that returns whatever `rowCount` the test queues - which proves the
 * route ASKS for a count and refuses on zero, but not that the count is drawn
 * from the participant-actionable `end_time > NOW()` set rather than a bare
 * `COUNT(*)`. That difference is the whole gate: a study whose only slot ended
 * yesterday is as unbookable as one with none, and a text/mock assertion cannot
 * see which rows a real `NOW()` comparison excludes - the same blind spot the
 * sibling `list-upcoming-sessions-postgres.test.ts` exists to cover for the
 * fan-out filter. `NOW()` is the server's clock here and the boundary is a real
 * timestamp comparison, so the only way to know a past slot does not count is to
 * insert one and watch the publish still refuse.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB vitest
 * job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

const SLOT_GATE_MESSAGE =
  "Add at least one upcoming time slot before publishing a live session or interview";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

interface Fixture {
  adminId: string;
  opportunityId: string;
}

/**
 * One admin owner and one DRAFT live session with no slots yet. Each test then
 * inserts exactly the slots it is about and PATCHes the opportunity to
 * published, so the only thing that varies between arms is which slots exist.
 */
async function seedDraftLiveSession(type: "test" | "interview"): Promise<Fixture> {
  const adminId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [adminId, `owner-${adminId}@example.com`]
  );
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, $2, 'Publish slot gate study',
             'Proving the bookable-slot publish gate against a real database', $3, 'draft')`,
    [opportunityId, type, adminId]
  );

  return { adminId, opportunityId };
}

async function insertSession(
  opportunityId: string,
  startOffset: string,
  endOffset: string
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
     VALUES ($1, $2, NOW() + ($3)::interval, NOW() + ($4)::interval, 1, 0)`,
    [crypto.randomUUID(), opportunityId, startOffset, endOffset]
  );
}

const publish = (fixture: Fixture) =>
  request(listening(app))
    .patch(`/api/opportunities/${fixture.opportunityId}`)
    .set("x-test-user-id", fixture.adminId)
    .send({ status: "published" });

const storedStatus = async (opportunityId: string): Promise<string> => {
  const { rows } = await pool.query(
    "SELECT status FROM opportunities WHERE id = $1",
    [opportunityId]
  );
  return rows[0].status as string;
};

describe.skipIf(skipDbTests)(
  "publishing a bookable opportunity gates on an upcoming slot, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("opportunities-publish-slot-gate");

      // BEFORE importing ../../config: the pool reads DATABASE_URL once, at import.
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.SESSION_SECRET ||=
        "vitest-postgres-publish-slot-gate-constant-not-a-real-secret"; // gitleaks:allow
      process.env.NODE_ENV = "test";

      const { runMigrations } = await import("../../db/migrate");
      await runMigrations();

      const { pool: appPool } = await import("../../config");
      pool = appPool;

      const opportunitiesRouter = (await import("../opportunities")).default;
      const { errorHandler } = await import("../../utils/errorHandler");
      const expressModule = (await import("express")).default;

      app = expressModule();
      app.use(expressModule.json());
      // Stands in for the real session middleware: `requireAdmin` needs only
      // req.session.user.id and re-reads the role LIVE from the real users
      // table, which is why the owner is seeded as researcher_admin above.
      app.use((req, _res, next) => {
        const userId = req.header("x-test-user-id");
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "Test", email: "t@example.com", role: "researcher_admin" }
          };
        }
        next();
      });
      app.use("/api/opportunities", opportunitiesRouter);
      app.use(errorHandler);
    }, 180_000);

    afterAll(async () => {
      // The jest global teardown that normally closes these does not run under
      // vitest, so close here or the open server holds the process open.
      await closeListeningServers();
      await pool?.end().catch(() => {});
      await postgres?.stop();
      delete process.env.DATABASE_URL;
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE bookings, sessions, opportunities, users CASCADE");
    });

    describe.each([["test"], ["interview"]] as const)("%s", (type) => {
      it("refuses to publish with no slots at all, and leaves it a draft", async () => {
        const fixture = await seedDraftLiveSession(type);

        const res = await publish(fixture);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe(SLOT_GATE_MESSAGE);
        // The refusal is real, not cosmetic: the row did not go live.
        expect(await storedStatus(fixture.opportunityId)).toBe("draft");
      });

      it("refuses to publish when every slot is in the past", async () => {
        const fixture = await seedDraftLiveSession(type);
        // A slot that started and ENDED yesterday: a bare COUNT(*) >= 1 would
        // pass this and re-open the a21 defect. The gate must not.
        await insertSession(fixture.opportunityId, "-1 day -1 hour", "-1 day");

        const res = await publish(fixture);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe(SLOT_GATE_MESSAGE);
        expect(await storedStatus(fixture.opportunityId)).toBe("draft");
      });

      it("permits publishing once an upcoming slot exists", async () => {
        const fixture = await seedDraftLiveSession(type);
        await insertSession(fixture.opportunityId, "1 day", "1 day 1 hour");

        const res = await publish(fixture);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("published");
        expect(await storedStatus(fixture.opportunityId)).toBe("published");
      });

      /*
       * THE TEETH on `end_time > NOW()` rather than `start_time > NOW()`. A slot
       * that began ten minutes ago and runs for another fifty is still bookable
       * - `bookings.ts` refuses only when `end_time <= NOW()` - so publishing
       * over it must be permitted. A `start_time` predicate would refuse this
       * and hide a study the product would still let a participant book.
       */
      it("permits publishing over an in-progress slot (end_time is the boundary)", async () => {
        const fixture = await seedDraftLiveSession(type);
        await insertSession(fixture.opportunityId, "-10 minutes", "50 minutes");

        const res = await publish(fixture);

        expect(res.status).toBe(200);
        expect(await storedStatus(fixture.opportunityId)).toBe("published");
      });
    });

    /*
     * The mutation-canary killer for the ROUTE half, deliberately OUTSIDE the
     * describe.each above so `-t` matches exactly one test (the canary refuses an
     * ambiguous selection). It pins the route's `AND end_time > NOW()` clause:
     * dropping it to a bare `COUNT(*)` would count this study's single past slot
     * and permit the publish, so this must refuse. The per-type arms above cover
     * the same property for readability; this is the one the manifest names.
     */
    it("counts only upcoming slots: a test whose only slot is in the past cannot publish", async () => {
      const fixture = await seedDraftLiveSession("test");
      await insertSession(fixture.opportunityId, "-1 day -1 hour", "-1 day");

      const res = await publish(fixture);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(SLOT_GATE_MESSAGE);
      expect(await storedStatus(fixture.opportunityId)).toBe("draft");
    });
  }
);
