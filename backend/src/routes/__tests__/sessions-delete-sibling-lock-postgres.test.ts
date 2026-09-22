import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * cto/AdaptaLabs#128: the last-bookable-slot guard on `DELETE /api/sessions/:id`
 * (row 14, see the comment block above it) re-asks "how many upcoming slots
 * would be left?" inside the deleting transaction, but until this fix that
 * count read SIBLING session rows with no lock on them at all. Two concurrent
 * deletes of a published interview's FINAL TWO upcoming slots could each read
 * the OTHER as still-remaining under READ COMMITTED, so both passed the guard
 * and both committed - the study left published with zero bookable slots,
 * exactly the state the guard exists to prevent.
 *
 * THE FIX is a `pg_advisory_xact_lock` keyed on the opportunity, taken before
 * the count, not the `ORDER BY id FOR UPDATE` sibling-row lock
 * `opportunities.ts` delete-sessions and `sessions.ts` sync-booked-counts use
 * for the same kind of problem elsewhere in this file. That shape was
 * considered and rejected here: this route already takes an unordered,
 * single-row `FOR UPDATE` on the ONE session being deleted a few lines above
 * the guard (#116/#34), pinned byte-for-byte by
 * sessions.delete-locks-against-a-racing-booking.test.ts. Adding an ordered
 * lock over every sibling row AFTER that single out-of-order row lock
 * reintroduces exactly the cross-cycle cto/AdaptaLabs#34 tracks: two
 * concurrent deletes of a study's own final two slots would each already
 * hold their OWN row, then each block wanting the OTHER's row via the ordered
 * lock - a genuine `40P01` deadlock, not merely a slow path. An advisory lock
 * is a single resource per study, so two transactions racing for it can only
 * ever produce one winner and one waiter, never a cycle, and nothing else in
 * this codebase takes this specific lock, so it cannot cross-cycle with the
 * row locks the other two handlers take. See the code comment at the lock
 * site for the full reasoning.
 *
 * REAL POSTGRES, and the two "concurrent" deletes below are not left to
 * chance: a THIRD connection takes the same advisory lock first and holds it,
 * so both real handler requests queue up behind ONE known resource before
 * either can reach the remaining-slot count. That is what makes "exactly one
 * succeeds" deterministic here rather than a hope about scheduler timing -
 * and it is bounded: `waitForBothToBlock` returns false rather than hanging
 * if the two requests never reach the lock, which is what happens instead of
 * a hang when the lock is removed (proved by manually reverting the fix and
 * re-running this file: the wait times out, failing the `bothBlocked`
 * assertion by name, and both requests separately return 204).
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;
let ownerId: string;

async function seedStudy(opts: {
  type: string;
  status: string;
  slots: Array<"future" | "past">;
}): Promise<{ opportunityId: string; sessionIds: string[] }> {
  const opportunityId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, $2, 'Sibling lock test study', 'Proving the concurrent-delete sibling lock', $3, $4)`,
    [opportunityId, opts.type, ownerId, opts.status]
  );
  const sessionIds: string[] = [];
  for (const when of opts.slots) {
    const sessionId = crypto.randomUUID();
    const start = when === "future" ? "NOW() + INTERVAL '1 day'" : "NOW() - INTERVAL '2 days'";
    const end = when === "future" ? "NOW() + INTERVAL '1 day 1 hour'" : "NOW() - INTERVAL '2 days' + INTERVAL '1 hour'";
    await pool.query(
      `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
       VALUES ($1, $2, ${start}, ${end}, 5, 0)`,
      [sessionId, opportunityId]
    );
    sessionIds.push(sessionId);
  }
  return { opportunityId, sessionIds };
}

const del = (sessionId: string) =>
  request(listening(app))
    .delete(`/api/sessions/${sessionId}`)
    .set("x-test-user-id", ownerId)
    .set("x-test-user-role", "researcher_admin");

/**
 * Waits until `count` distinct backends are blocked trying to take the
 * advisory lock the fix uses. Bounded at 10s, the same bound the sibling
 * lock-order test uses: an unbounded wait turns a broken fixture into a CI
 * job timeout with no failing test name, which is the hardest kind of
 * regression to read. Returns false rather than hanging.
 */
async function waitForBothToBlock(count: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND query ILIKE '%pg_advisory_xact_lock%'`
    );
    if (rows[0].n >= count) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(skipDbTests)(
  "DELETE /api/sessions/:id serialises concurrent deletes of the same study's sessions (cto/AdaptaLabs#128)",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("sessions-delete-sibling-lock");
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.SESSION_SECRET ||=
        "vitest-postgres-sibling-lock-constant-not-a-real-secret"; // gitleaks:allow
      process.env.NODE_ENV = "test";

      const { runMigrations } = await import("../../db/migrate");
      await runMigrations();

      const { pool: appPool } = await import("../../config");
      pool = appPool;

      const sessionsRouter = (await import("../sessions")).default;
      const { errorHandler } = await import("../../utils/errorHandler");
      const expressModule = (await import("express")).default;

      app = expressModule();
      app.use(expressModule.json());
      app.use((req, _res, next) => {
        const userId = req.header("x-test-user-id");
        const role = req.header("x-test-user-role") ?? "employee";
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "Owner", email: "owner@example.com", role },
          };
        }
        next();
      });
      app.use("/api/sessions", sessionsRouter);
      app.use(errorHandler);
    }, 180_000);

    afterAll(async () => {
      await closeListeningServers();
      await pool?.end().catch(() => {});
      await postgres?.stop();
      delete process.env.DATABASE_URL;
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE bookings, sessions, opportunities, users CASCADE");
      ownerId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
        [ownerId, `owner-${ownerId}@example.com`]
      );
    });

    it(
      "of a published interview's final two upcoming slots: exactly one delete succeeds, the study is never left with zero bookable slots",
      async () => {
        const { opportunityId, sessionIds } = await seedStudy({
          type: "interview",
          status: "published",
          slots: ["future", "future"],
        });
        const [sessionA, sessionB] = sessionIds;

        // A THIRD connection holds the exact lock both deletes need, so the two
        // real requests below queue up behind ONE resource instead of racing on
        // scheduler timing.
        const holder = await pool.connect();
        await holder.query("BEGIN");
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [opportunityId]
        );

        let responseA: request.Response;
        let responseB: request.Response;
        try {
          const pending = Promise.all([
            del(sessionA).then((res) => res),
            del(sessionB).then((res) => res),
          ]);

          const bothBlocked = await waitForBothToBlock(2);

          // THE CONTROL. Every assertion below is meaningless if the two real
          // requests never actually contended for the lock at all.
          expect(bothBlocked).toBe(true);

          await holder.query("COMMIT");
          [responseA, responseB] = await pending;
        } finally {
          holder.release();
        }

        // Order is not predictable (whichever the lock queue wakes first), so
        // compare the outcome as a set: one delete goes through, one is
        // refused as the last bookable slot.
        const statuses = [responseA.status, responseB.status].sort((a, b) => a - b);
        expect(statuses).toEqual([204, 409]);

        const remaining = await pool.query(
          "SELECT count(*)::int AS n FROM sessions WHERE opportunity_id = $1",
          [opportunityId]
        );
        // THE ASSERTION THE BUG VIOLATED: never zero. Exactly one of the two
        // slots survives, so the study is still bookable.
        expect(remaining.rows[0].n).toBe(1);

        const study = await pool.query(
          "SELECT status FROM opportunities WHERE id = $1",
          [opportunityId]
        );
        expect(study.rows[0].status).toBe("published");
      },
      60_000
    );

    // CONTROL (a): the guard must still let a delete through when it does not
    // remove the study's last bookable slot - the lock above must not turn
    // into a blanket refusal.
    it("control: deleting one of TWO future slots on a published interview still succeeds", async () => {
      const { sessionIds } = await seedStudy({
        type: "interview",
        status: "published",
        slots: ["future", "future"],
      });
      expect((await del(sessionIds[0])).status).toBe(204);
    });

    // CONTROL (b): a LONE last slot is still refused, same as before this fix -
    // proves the guard itself was not weakened by the new lock.
    it("control: deleting the ONLY future slot of a published interview is still refused", async () => {
      const { sessionIds } = await seedStudy({
        type: "interview",
        status: "published",
        slots: ["future"],
      });
      expect((await del(sessionIds[0])).status).toBe(409);
    });
  }
);
