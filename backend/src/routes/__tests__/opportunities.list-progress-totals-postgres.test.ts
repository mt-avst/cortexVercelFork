import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * ALL-TIME PROGRESS TOTALS ON THE ADMIN STUDIES LIST, AGAINST A REAL DATABASE.
 *
 * The admin list carries only sessions that ended in the last fourteen days
 * (`ADMIN_RECENT_SESSIONS_ONLY`), so a closed study's Progress cell summed an
 * empty array and drew a dash. `total_booked` / `total_capacity` are the
 * unwindowed figures. A real Postgres because every rule here is about WHICH
 * ROWS a join and an aggregate keep:
 *
 *   - a session that ended long ago still counts (no window);
 *   - a cancelled booking does not (it released its seat);
 *   - a session's capacity counts ONCE however many bookings it holds - the
 *     flat `sessions JOIN bookings ... SUM(capacity)` reads a capacity-4 session
 *     with 2 bookings as 2/8, and only a real join can show that;
 *   - a study with no sessions gets no fields at all, not 0/0;
 *   - the owner scope and the admin gate hold.
 *
 * Every figure below is a LITERAL, never computed from the fixture.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB vitest
 * job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

type Role = "employee" | "researcher_admin" | "superadmin";

const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const PARTICIPANT = crypto.randomUUID();

async function seedUser(id: string, role: Role): Promise<void> {
  await pool.query(`INSERT INTO users (id, name, email, role) VALUES ($1, $2, $3, $4)`, [
    id,
    `User ${id.slice(0, 6)}`,
    `${id}@example.com`,
    role
  ]);
}

async function seedStudy(ownerId: string, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, 'interview', $2,
             'Proving all-time progress totals against a real database', $3, 'published')`,
    [id, title, ownerId]
  );
  return id;
}

/** A session whose END is `endOffset` from NOW(), one hour long. */
async function seedSession(
  opportunityId: string,
  endOffset: string,
  capacity: number
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
     VALUES ($1, $2, NOW() + ($3)::interval - interval '1 hour', NOW() + ($3)::interval, $4, 0)`,
    [id, opportunityId, endOffset, capacity]
  );
  return id;
}

let bookerSeq = 0;
/** One booking by a fresh participant, so the active-booking unique index never bites. */
async function seedBooking(sessionId: string, status: "booked" | "cancelled"): Promise<void> {
  bookerSeq += 1;
  const userId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, $2, $3, 'employee')`,
    [userId, `Booker ${bookerSeq}`, `booker-${bookerSeq}-${userId}@example.com`]
  );
  await pool.query(
    `INSERT INTO bookings (user_id, session_id, status, cancelled_at)
     VALUES ($1, $2, $3, CASE WHEN $3::booking_status = 'cancelled' THEN NOW() END)`,
    [userId, sessionId, status]
  );
}

const listAs = (callerId: string | null, role: Role | null, scope?: string) => {
  const query = scope ? `?scope=${scope}` : "";
  const req = request(listening(app)).get(`/api/opportunities${query}`);
  return callerId && role
    ? req.set("x-test-user-id", callerId).set("x-test-user-role", role)
    : req;
};

type Row = { id: string; title: string; sessions: unknown[]; [key: string]: unknown };

const rowFor = (body: unknown, id: string): Row => {
  const found = (body as Row[]).find((opportunity) => opportunity.id === id);
  if (!found) throw new Error(`study ${id} was not in the response`);
  return found;
};

describe.skipIf(skipDbTests)(
  "all-time progress totals on the admin studies list, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("opportunities-list-progress-totals");

      // BEFORE importing ../../config: the pool reads DATABASE_URL once, at import.
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.SESSION_SECRET ||=
        "vitest-postgres-progress-totals-constant-not-a-real-secret"; // gitleaks:allow
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
      // Stands in for the session middleware: optionalAuth reads
      // req.session.user and withLiveRoleIfPresent re-reads the role LIVE from
      // the users table, so each caller is seeded with the role it claims.
      app.use((req, _res, next) => {
        const userId = req.header("x-test-user-id");
        const role = req.header("x-test-user-role");
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "T", email: `${userId}@example.com`, role }
          };
        }
        next();
      });
      app.use("/api/opportunities", opportunitiesRouter);
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
      await seedUser(ALICE, "researcher_admin");
      await seedUser(BOB, "researcher_admin");
      await seedUser(PARTICIPANT, "employee");
    });

    describe("what the totals count", () => {
      it("counts a session that ended more than 14 days ago", async () => {
        const study = await seedStudy(ALICE, "Closed last month");
        const old = await seedSession(study, "-30 days", 3);
        await seedBooking(old, "booked");
        await seedBooking(old, "booked");

        const res = await listAs(ALICE, "researcher_admin").expect(200);
        const row = rowFor(res.body, study);

        expect(row.total_booked).toBe(2);
        expect(row.total_capacity).toBe(3);
        // THE CONTROL: the session really is outside the list's 14-day window,
        // so the totals are the only place it is counted at all.
        expect(row.sessions).toEqual([]);
      });

      it("sums every session, old and upcoming alike", async () => {
        const study = await seedStudy(ALICE, "Long-running study");
        const old = await seedSession(study, "-20 days", 2);
        const upcoming = await seedSession(study, "+3 days", 5);
        await seedBooking(old, "booked");
        await seedBooking(upcoming, "booked");
        await seedBooking(upcoming, "booked");

        const res = await listAs(ALICE, "researcher_admin").expect(200);
        const row = rowFor(res.body, study);

        expect(row.total_booked).toBe(3);
        expect(row.total_capacity).toBe(7);
        // Only the upcoming session is in the windowed array.
        expect(row.sessions).toHaveLength(1);
      });

      it("does not count a cancelled booking", async () => {
        const study = await seedStudy(ALICE, "Study with cancellations");
        const session = await seedSession(study, "+2 days", 5);
        await seedBooking(session, "booked");
        await seedBooking(session, "booked");
        await seedBooking(session, "cancelled");
        await seedBooking(session, "cancelled");
        await seedBooking(session, "cancelled");

        const res = await listAs(ALICE, "researcher_admin").expect(200);
        const row = rowFor(res.body, study);

        expect(row.total_booked).toBe(2);
        expect(row.total_capacity).toBe(5);
      });

      it("counts a session's capacity once, not once per booking: 2 of 4, not 2 of 8", async () => {
        const study = await seedStudy(ALICE, "Two bookings, capacity four");
        const session = await seedSession(study, "+1 day", 4);
        await seedBooking(session, "booked");
        await seedBooking(session, "booked");

        const res = await listAs(ALICE, "researcher_admin").expect(200);
        const row = rowFor(res.body, study);

        expect(row.total_booked).toBe(2);
        expect(row.total_capacity).toBe(4);
      });

      it("counts each session's capacity once across several booked sessions: 3 of 7, not 3 of 11", async () => {
        const study = await seedStudy(ALICE, "Two sessions, three bookings");
        const first = await seedSession(study, "+1 day", 4);
        const second = await seedSession(study, "-40 days", 3);
        await seedBooking(first, "booked");
        await seedBooking(first, "booked");
        await seedBooking(second, "booked");

        const res = await listAs(ALICE, "researcher_admin").expect(200);
        const row = rowFor(res.body, study);

        expect(row.total_booked).toBe(3);
        expect(row.total_capacity).toBe(7);
      });

      it("counts an empty session's capacity with zero booked", async () => {
        const study = await seedStudy(ALICE, "Nobody booked");
        await seedSession(study, "-60 days", 6);

        const res = await listAs(ALICE, "researcher_admin").expect(200);
        const row = rowFor(res.body, study);

        expect(row.total_booked).toBe(0);
        expect(row.total_capacity).toBe(6);
      });

      it("sends no totals at all for a study with no sessions - absent, not 0", async () => {
        const bare = await seedStudy(ALICE, "No sessions");
        const withSession = await seedStudy(ALICE, "One session");
        await seedSession(withSession, "+1 day", 2);

        const res = await listAs(ALICE, "researcher_admin").expect(200);
        const bareRow = rowFor(res.body, bare);

        expect(bareRow).not.toHaveProperty("total_booked");
        expect(bareRow).not.toHaveProperty("total_capacity");
        // THE CONTROL: the same response DOES carry the fields for a study with
        // a session, so the absence above is about sessions, not the payload.
        expect(rowFor(res.body, withSession)).toMatchObject({ total_booked: 0, total_capacity: 2 });
      });
    });

    describe("who receives them", () => {
      let aliceStudy: string;
      let bobStudy: string;

      beforeEach(async () => {
        aliceStudy = await seedStudy(ALICE, "Alice study");
        const aliceSession = await seedSession(aliceStudy, "-30 days", 4);
        await seedBooking(aliceSession, "booked");

        // Distinctive numbers, so a leak of Bob's totals is recognisable.
        bobStudy = await seedStudy(BOB, "Bob study");
        const bobSession = await seedSession(bobStudy, "+1 day", 9);
        for (let i = 0; i < 7; i += 1) {
          await seedBooking(bobSession, "booked");
        }
      });

      it("never sends another owner's totals to an admin at scope=mine", async () => {
        const res = await listAs(ALICE, "researcher_admin", "mine").expect(200);
        const body = res.body as Row[];

        expect(body.map((opportunity) => opportunity.id)).toEqual([aliceStudy]);
        expect(body[0]).toMatchObject({ total_booked: 1, total_capacity: 4 });
        // Bob's figures appear nowhere in the payload, under any key.
        const serialised = JSON.stringify(body);
        expect(serialised).not.toContain(bobStudy);
        expect(serialised).not.toMatch(/"total_capacity":9\b/);
        expect(serialised).not.toMatch(/"total_booked":7\b/);
      });

      // THE CONTROL for the arm above: Bob's totals exist and ARE served to an
      // admin who widens to every researcher, so their absence at scope=mine is
      // the scope's doing and not a totals query that simply returned nothing.
      it("sends every listed study's totals to an admin at scope=all", async () => {
        const res = await listAs(ALICE, "researcher_admin", "all").expect(200);

        expect(rowFor(res.body, aliceStudy)).toMatchObject({ total_booked: 1, total_capacity: 4 });
        expect(rowFor(res.body, bobStudy)).toMatchObject({ total_booked: 7, total_capacity: 9 });
      });

      it.each([
        ["a signed-in participant", PARTICIPANT, "employee" as Role],
        ["an anonymous caller", null, null]
      ])("sends %s no totals on any row", async (_label, callerId, role) => {
        const res = await listAs(callerId, role).expect(200);
        const body = res.body as Row[];

        // THE CONTROL: both published studies really are in the list, so the
        // absences below are about the fields and not an empty response.
        expect(body.map((opportunity) => opportunity.id).sort()).toEqual(
          [aliceStudy, bobStudy].sort()
        );
        for (const opportunity of body) {
          expect(opportunity).not.toHaveProperty("total_booked");
          expect(opportunity).not.toHaveProperty("total_capacity");
        }
      });
    });
  }
);
