import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * HOW A STUDY CLOSED (`opportunities.auto_closed`), AGAINST A REAL DATABASE.
 *
 * The admin table captions a closed study "Auto-closed". Once a researcher can
 * close one by hand that caption is false unless the row records which kind of
 * close it was. The rule under test:
 *
 *   - each lifecycle close writes `true` in the same UPDATE as the status:
 *     `autoCloseOpportunityIfNeeded` (reached through POST /:id/close-if-past)
 *     and the end-date sweep `autoClosePublishedStudiesPastEndDate`;
 *   - any status written through PATCH /:id writes `false` - a manual close,
 *     and a reopen, which clears the true an earlier sweep left;
 *   - a body naming `auto_closed` cannot set it. This file runs the REAL
 *     `validateRequest`, so the strip is in place; the allow-list refusal with
 *     the strip neutralised lives in `opportunities.patch-column-allowlist.test.ts`.
 *
 * A real Postgres because the lifecycle closes are raw SQL a mocked pool can
 * only echo, and the column exists or does not only in a real schema.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB vitest
 * job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;
let autoClosePublishedStudiesPastEndDate: () => Promise<number>;
let autoCloseOpportunityIfNeeded: (opportunityId: string) => Promise<void>;

type Status = "draft" | "published" | "closed";

async function seedOwner(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [id, `owner-${id}@example.com`]
  );
  return id;
}

/** An interview study; `endOffset` sets `end_date` relative to NOW(), or leaves it null. */
async function seedStudy(ownerId: string, status: Status, endOffset: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, end_date)
     VALUES ($1, 'interview', 'How-it-closed fixture',
             'Proving auto_closed against a real database', $2, $3,
             CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() + ($4::text)::interval END)`,
    [id, ownerId, status, endOffset]
  );
  return id;
}

/** A one-hour session ending `endOffset` from NOW(). */
async function seedSession(opportunityId: string, endOffset: string): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
     VALUES ($1, $2, NOW() + ($3)::interval - interval '1 hour', NOW() + ($3)::interval, 2, 0)`,
    [crypto.randomUUID(), opportunityId, endOffset]
  );
}

const stored = async (id: string): Promise<{ status: string; auto_closed: boolean }> => {
  const { rows } = await pool.query(
    "SELECT status, auto_closed FROM opportunities WHERE id = $1",
    [id]
  );
  return rows[0] as { status: string; auto_closed: boolean };
};

const patchAs = (ownerId: string, id: string, body: Record<string, unknown>) =>
  request(listening(app))
    .patch(`/api/opportunities/${id}`)
    .set("x-test-user-id", ownerId)
    .send(body);

describe.skipIf(skipDbTests)("how a study closed (auto_closed), against a real Postgres", () => {
  let owner: string;

  beforeAll(async () => {
    postgres = await startTestPostgres("opportunities-auto-closed");

    // BEFORE importing ../../config: the pool reads DATABASE_URL once, at import.
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-auto-closed-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    ({ autoClosePublishedStudiesPastEndDate, autoCloseOpportunityIfNeeded } = await import(
      "../../utils/opportunityLifecycle"
    ));

    const opportunitiesRouter = (await import("../opportunities")).default;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
    // Stands in for the session middleware. `requireAdmin` re-reads the role
    // LIVE from the users table, which is why the owner is seeded as an admin.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Owner", email: "o@example.com", role: "researcher_admin" }
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
    owner = await seedOwner();
  });

  it("defaults to false on a new study", async () => {
    const study = await seedStudy(owner, "published");

    expect(await stored(study)).toEqual({ status: "published", auto_closed: false });
  });

  describe("each lifecycle close records true", () => {
    it("the last-session close, reached through close-if-past", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "-2 days");

      await request(listening(app))
        .post(`/api/opportunities/${study}/close-if-past`)
        .set("x-test-user-id", owner)
        .expect(200);

      expect(await stored(study)).toEqual({ status: "closed", auto_closed: true });
    });

    // THE CONTROL: the close-if-past check does not mark a study it leaves open.
    it("the last-session check leaves a study with an upcoming session open and false", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "-2 days");
      await seedSession(study, "+2 days");

      await request(listening(app))
        .post(`/api/opportunities/${study}/close-if-past`)
        .set("x-test-user-id", owner)
        .expect(200);

      expect(await stored(study)).toEqual({ status: "published", auto_closed: false });
    });

    it("the end-date sweep", async () => {
      const ended = await seedStudy(owner, "published", "-1 hour");
      const live = await seedStudy(owner, "published", "+1 day");

      expect(await autoClosePublishedStudiesPastEndDate()).toBe(1);

      expect(await stored(ended)).toEqual({ status: "closed", auto_closed: true });
      // THE CONTROL: the study the sweep did not close is not marked.
      expect(await stored(live)).toEqual({ status: "published", auto_closed: false });
    });
  });

  /*
   * THE LAST-SESSION CLOSE MUST NOT OVERWRITE A STATUS SOMEONE ELSE WROTE.
   * `autoCloseOpportunityIfNeeded` reads the status in one statement and
   * writes in another, so a manual close or a move to draft can land between
   * them. The UPDATE's own `AND status = 'published'` is what stops the sweep
   * relabelling that as an automatic close. The race is reproduced by
   * running the competing write immediately after the real SELECT returns.
   */
  describe("the last-session close does not overwrite a status written under it", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const raceAfterTheRead = (competingWrite: string, id: string) => {
      const realQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
        const result = await realQuery(...args);
        if (String(args[0]).includes("as total_sessions")) {
          await realQuery(competingWrite, [id]);
        }
        return result;
      }) as never);
    };

    it("leaves a study closed by hand between its read and its write closed by hand", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "-2 days");
      raceAfterTheRead(
        "UPDATE opportunities SET status = 'closed', auto_closed = false WHERE id = $1",
        study
      );

      await autoCloseOpportunityIfNeeded(study);

      vi.restoreAllMocks();
      expect(await stored(study)).toEqual({ status: "closed", auto_closed: false });
    });

    it("leaves a study moved to draft between its read and its write a draft", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "-2 days");
      raceAfterTheRead("UPDATE opportunities SET status = 'draft' WHERE id = $1", study);

      await autoCloseOpportunityIfNeeded(study);

      vi.restoreAllMocks();
      expect(await stored(study)).toEqual({ status: "draft", auto_closed: false });
    });

    it.each([["draft"], ["closed"]] as const)(
      "does not touch a %s study whose sessions are all past",
      async (status) => {
        const study = await seedStudy(owner, status);
        await seedSession(study, "-2 days");

        await autoCloseOpportunityIfNeeded(study);

        expect(await stored(study)).toEqual({ status, auto_closed: false });
      }
    );

    // THE CONTROL for the race arms: the same spy with a harmless competing
    // write still lets the close land, so the arms above are about the status
    // guard and not a spy that broke the function.
    it("still closes when the competing write leaves the study published", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "-2 days");
      raceAfterTheRead("UPDATE opportunities SET title = 'Retitled mid-sweep' WHERE id = $1", study);

      await autoCloseOpportunityIfNeeded(study);

      vi.restoreAllMocks();
      expect(await stored(study)).toEqual({ status: "closed", auto_closed: true });
    });
  });

  describe("any status written through PATCH records false", () => {
    it("a manual close of a published study", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "+2 days");

      const res = await patchAs(owner, study, { status: "closed" }).expect(200);

      expect(res.body.status).toBe("closed");
      // It rides out on RETURNING *, so the client learns it without a re-read.
      expect(res.body.auto_closed).toBe(false);
      expect(await stored(study)).toEqual({ status: "closed", auto_closed: false });
    });

    /*
     * THE ARM THAT CAN SEE THE DERIVATION ON A CLOSE. A published study is
     * already false, so the manual-close arm above would pass on a handler that
     * never wrote `auto_closed` at all. A published row carrying a stale true
     * is set up directly, because no route produces one (a reopen clears it) -
     * it is the only published -> closed write where the derived false is
     * observable.
     */
    it("a manual close of a published study clears a stale true", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "+2 days");
      await pool.query("UPDATE opportunities SET auto_closed = true WHERE id = $1", [study]);

      await patchAs(owner, study, { status: "closed" }).expect(200);

      expect(await stored(study)).toEqual({ status: "closed", auto_closed: false });
    });

    /*
     * A WRITE OF THE STATUS THE ROW ALREADY HAS IS NOT A DECISION. An admin
     * whose table still shows "published" presses Close minutes after the sweep
     * closed the study. That PATCH changes nothing, so it must not relabel the
     * sweep close as a manual one.
     */
    it("a PATCH writing closed to a study the sweep already closed leaves it auto-closed", async () => {
      const study = await seedStudy(owner, "published", "-1 hour");
      await autoClosePublishedStudiesPastEndDate();
      // THE CONTROL: the precondition really is a sweep close.
      expect(await stored(study)).toEqual({ status: "closed", auto_closed: true });

      await patchAs(owner, study, { status: "closed" }).expect(200);

      expect(await stored(study)).toEqual({ status: "closed", auto_closed: true });
    });

    it("a reopen of a study the last-session close shut", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "-2 days");
      await request(listening(app))
        .post(`/api/opportunities/${study}/close-if-past`)
        .set("x-test-user-id", owner)
        .expect(200);
      expect(await stored(study)).toEqual({ status: "closed", auto_closed: true });

      // The researcher adds a new slot and reopens, as the publish guard asks.
      await seedSession(study, "+3 days");
      const res = await patchAs(owner, study, { status: "published" }).expect(200);

      expect(res.body.auto_closed).toBe(false);
      expect(await stored(study)).toEqual({ status: "published", auto_closed: false });
    });

    // THE CONTROL FOR THE DERIVATION: a save that writes no status must not
    // rewrite how a study closed.
    it("a save that writes no status leaves an auto-close marked true", async () => {
      const study = await seedStudy(owner, "published", "-1 hour");
      await autoClosePublishedStudiesPastEndDate();

      await patchAs(owner, study, { title: "Retitled after it closed" }).expect(200);

      expect(await stored(study)).toEqual({ status: "closed", auto_closed: true });
    });
  });

  describe("a client cannot set it", () => {
    it("refuses a body of only auto_closed: true as having nothing to update", async () => {
      const study = await seedStudy(owner, "closed");

      const res = await patchAs(owner, study, { auto_closed: true }).expect(400);

      expect(res.body.error).toBe("No fields to update");
      expect(await stored(study)).toEqual({ status: "closed", auto_closed: false });
    });

    it("stores false when auto_closed: true rides beside a status write", async () => {
      const study = await seedStudy(owner, "published");
      await seedSession(study, "+2 days");

      const res = await patchAs(owner, study, { status: "closed", auto_closed: true }).expect(200);

      expect(res.body.auto_closed).toBe(false);
      expect(await stored(study)).toEqual({ status: "closed", auto_closed: false });
    });

    it("ignores auto_closed: true beside a non-status field", async () => {
      const study = await seedStudy(owner, "closed");

      await patchAs(owner, study, { title: "Retitled", auto_closed: true }).expect(200);

      expect(await stored(study)).toEqual({ status: "closed", auto_closed: false });
    });
  });

  /*
   * NOT ON ANYTHING A PARTICIPANT READS. How a study closed is an admin
   * concern, and `toPublicOpportunity` strips it by key. Every study a
   * participant can list or open is published, so its value is false - which
   * is exactly why the assertion is on the KEY: a leak of `false` is still a
   * leak of the column. The admin read of the same study is the control.
   */
  describe("participant and anonymous responses carry no auto_closed", () => {
    let participant: string;
    let study: string;

    beforeEach(async () => {
      participant = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, name, email, role) VALUES ($1, 'Participant', $2, 'employee')`,
        [participant, `participant-${participant}@example.com`]
      );
      study = await seedStudy(owner, "published");
      await seedSession(study, "+2 days");
    });

    const readAs = (callerId: string | null, path: string) => {
      const req = request(listening(app)).get(path);
      return callerId ? req.set("x-test-user-id", callerId) : req;
    };

    it.each([
      ["a signed-in participant", "participant"],
      ["an anonymous caller", "anonymous"]
    ] as const)("on the list, for %s", async (_label, who) => {
      const res = await readAs(who === "participant" ? participant : null, "/api/opportunities").expect(200);
      const row = (res.body as Array<Record<string, unknown>>).find((r) => r.id === study);

      // THE CONTROL: the study is really in the list.
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("auto_closed");
    });

    it.each([
      ["a signed-in participant", "participant"],
      ["an anonymous caller", "anonymous"]
    ] as const)("on the detail read, for %s", async (_label, who) => {
      const res = await readAs(
        who === "participant" ? participant : null,
        `/api/opportunities/${study}`
      ).expect(200);

      expect(res.body.id).toBe(study);
      expect(res.body).not.toHaveProperty("auto_closed");
    });

    it("is still served to the owning admin on both reads (the control)", async () => {
      const list = await readAs(owner, "/api/opportunities").expect(200);
      const detail = await readAs(owner, `/api/opportunities/${study}`).expect(200);

      expect(
        (list.body as Array<Record<string, unknown>>).find((r) => r.id === study)
      ).toHaveProperty("auto_closed", false);
      expect(detail.body).toHaveProperty("auto_closed", false);
    });
  });

  // The list read serves `o.*`, so the admin table sees the fact without a
  // second request. Confirmed here rather than assumed.
  it("is served on the admin list", async () => {
    const auto = await seedStudy(owner, "published", "-1 hour");
    await autoClosePublishedStudiesPastEndDate();
    const manual = await seedStudy(owner, "published");
    await patchAs(owner, manual, { status: "closed" }).expect(200);

    const res = await request(listening(app))
      .get("/api/opportunities")
      .set("x-test-user-id", owner)
      .expect(200);
    const byId = new Map(
      (res.body as Array<{ id: string; auto_closed?: boolean }>).map((row) => [row.id, row])
    );

    expect(byId.get(auto)?.auto_closed).toBe(true);
    expect(byId.get(manual)?.auto_closed).toBe(false);
  });
});
