import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE SESSION FAN-OUT'S TIME FILTER, AGAINST A REAL DATABASE (cto/AdaptaLabs#62).
 *
 * `GET /api/opportunities` embeds every session of every opportunity it
 * returns, and refuses with 413 above `MAX_SESSIONS_RETURNED = 5000`. The
 * fan-out had no predicate on time, so it counted every session ever created:
 * nothing reclaims a past session, so the number the ceiling bounds only ever
 * went up, and `frontend/src/pages/Home.tsx:42` issues the same request - which
 * made the arrival of that ceiling a whole-product outage on a schedule.
 *
 * The participant branch now reads only sessions that can still be ACTED on.
 * The admin branch deliberately still reads the archive, because
 * `frontend/src/pages/Admin.tsx:771` sums `capacity` and `booked_count` across
 * those rows and whether the totals should count completed sessions is a
 * product question (cto/AdaptaLabs#103).
 *
 * WHY A REAL POSTGRES. The sibling arms in `opportunities.list-bound.test.ts`
 * assert the SQL TEXT against a mocked pool, and a text assertion cannot see
 * which rows a predicate actually excludes - the same hole that let a
 * substring oracle in this repository pass with a join commented out. `NOW()`
 * is evaluated by the server, the boundary is a real timestamp comparison, and
 * the only way to know a past session is absent is to insert one and look.
 *
 * `end_time`, NOT `start_time`, and one of the arms below is dedicated to that
 * difference. `backend/src/routes/bookings.ts:107` refuses a booking when
 * `new Date(session.end_time) <= new Date()`, so a session that began ten
 * minutes ago and runs for another twenty is bookable - and a catalogue that
 * hides what the product will still let you book is a worse defect than the one
 * being fixed. A `start_time` filter passes every other arm in this file.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

interface Fixture {
  adminId: string;
  opportunityId: string;
  pastSessionId: string;
  ancientSessionId: string;
  futureSessionId: string;
  inProgressSessionId: string;
}

/**
 * One published study with three sessions: one finished, one in progress, one
 * to come.
 *
 * The in-progress row is the whole reason this fixture has three rather than
 * two. With only a past and a future session, `start_time` and `end_time`
 * filters are indistinguishable.
 */
async function seed(): Promise<Fixture> {
  const adminId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();
  const pastSessionId = crypto.randomUUID();
  const ancientSessionId = crypto.randomUUID();
  const futureSessionId = crypto.randomUUID();
  const inProgressSessionId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [adminId, `owner-${adminId}@example.com`]
  );
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, 'test', 'Upcoming session fan-out',
             'Proving the participant catalogue reads the live schedule', $2, 'published')`,
    [opportunityId, adminId]
  );

  const insertSession = (id: string, startsIn: string, endsIn: string) =>
    pool.query(
      `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
       VALUES ($1, $2, NOW() + $3::interval, NOW() + $4::interval, 5, 0)`,
      [id, opportunityId, startsIn, endsIn]
    );

  await insertSession(pastSessionId, "-2 days", "-2 days 23 hours");
  // Older than the admin fan-out's 14-day recent window (#103): present in the
  // table, absent from what the admin listing embeds.
  await insertSession(ancientSessionId, "-20 days", "-19 days 23 hours");
  await insertSession(inProgressSessionId, "-10 minutes", "20 minutes");
  await insertSession(futureSessionId, "3 days", "3 days 1 hour");

  return { adminId, opportunityId, pastSessionId, ancientSessionId, futureSessionId, inProgressSessionId };
}

const sessionIdsFor = (body: unknown): string[] => {
  const [opportunity] = body as Array<{ sessions?: Array<{ id: string }> }>;
  return (opportunity?.sessions ?? []).map((session) => session.id).sort();
};

describe.skipIf(skipDbTests)(
  "GET /api/opportunities embeds only actionable sessions for a participant, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("opportunities-upcoming-sessions");

      // BEFORE importing ../../config: the pool reads DATABASE_URL once, at
      // import, so a later assignment would not reach the app pool.
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.SESSION_SECRET ||=
        "vitest-postgres-upcoming-sessions-constant-not-a-real-secret"; // gitleaks:allow
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
      // Stands in for the real session middleware: a request carrying
      // `x-test-user-id` is that user, and one without it is anonymous - which
      // is the participant home page's request.
      app.use((req, _res, next) => {
        const userId = req.header("x-test-user-id");
        const role = req.header("x-test-role") ?? "researcher_admin";
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "Test", email: "t@example.com", role },
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

    it("leaves the finished session out of the anonymous catalogue", async () => {
      const fixture = await seed();

      const res = await request(listening(app)).get("/api/opportunities");

      expect(res.status).toBe(200);
      expect(sessionIdsFor(res.body)).not.toContain(fixture.pastSessionId);
    });

    /**
     * THE CONTROL on the arm above, and it is not optional: "the past session is
     * absent" passes just as well when the fan-out returned nothing at all, or
     * when the catalogue came back empty because the seed failed.
     */
    it("still embeds the sessions a participant can act on", async () => {
      const fixture = await seed();

      const res = await request(listening(app)).get("/api/opportunities");

      expect(res.status).toBe(200);
      expect(sessionIdsFor(res.body)).toEqual(
        [fixture.futureSessionId, fixture.inProgressSessionId].sort()
      );
    });

    /**
     * THE ARM A `start_time` FILTER FAILS, and the only one that can tell the
     * two predicates apart. `bookings.ts` accepts a booking while `end_time` is
     * in the future, so a session already under way is still on offer, and the
     * catalogue has to keep showing it.
     */
    it("keeps a session that has already started but not yet ended", async () => {
      const fixture = await seed();

      const res = await request(listening(app)).get("/api/opportunities");

      expect(sessionIdsFor(res.body)).toContain(fixture.inProgressSessionId);
    });

    it("leaves the finished session out for a signed-in employee too", async () => {
      const fixture = await seed();
      const employeeId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, name, email, role) VALUES ($1, 'Employee', $2, 'employee')`,
        [employeeId, `employee-${employeeId}@example.com`]
      );

      const res = await request(listening(app))
        .get("/api/opportunities")
        .set("x-test-user-id", employeeId)
        .set("x-test-role", "employee");

      expect(res.status).toBe(200);
      expect(sessionIdsFor(res.body)).not.toContain(fixture.pastSessionId);
    });

    /**
     * THE OTHER HALF OF THE DECISION (cto/AdaptaLabs#103). #62 left the admin
     * branch unfiltered and recorded the product question; #103 answered it: an
     * admin study card means the live schedule plus a RECENT TAIL, not the whole
     * archive. So a recently-finished session is still embedded (the admin
     * dashboard counts THIS WEEK's completed sessions and sums recruitment over
     * the live-plus-recent set), while a session older than the window is not -
     * which is what closes the monotonic growth the ceiling used to be a date for.
     *
     * Pinned as BEHAVIOUR against real Postgres because a SQL-text arm cannot see
     * which rows `NOW() - INTERVAL '14 days'` actually excludes.
     */
    it("hands an admin the recent and live sessions but not one past the window", async () => {
      const fixture = await seed();

      const res = await request(listening(app))
        .get("/api/opportunities")
        .set("x-test-user-id", fixture.adminId);

      expect(res.status).toBe(200);
      const ids = sessionIdsFor(res.body);
      // The recently-finished (-2 days), in-progress and future sessions are all
      // embedded; the ancient (-20 days) one, outside the recent window, is not.
      expect(ids).toEqual(
        [fixture.pastSessionId, fixture.inProgressSessionId, fixture.futureSessionId].sort()
      );
      expect(ids).not.toContain(fixture.ancientSessionId);
    });
  }
);
