import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * `POST /api/participate/opened/:opportunityId`, AGAINST A REAL DATABASE
 * (cto/AdaptaLabs#168).
 *
 * The one statement does three jobs at once: proves the id exists, proves it
 * is currently visible to a participant (`status = 'published'`), and
 * upserts the open - all inside `WHERE o.id = $2 AND
 * PARTICIPANT_VISIBLE_OPPORTUNITY_SQL`. Nothing in the fast jest suite can
 * see whether that predicate is real, because a mocked pool answers whatever
 * `rowCount` a test queues regardless of what SQL was sent - so a draft or
 * closed id would 404 in the mock suite even with the predicate deleted
 * entirely. Every visibility assertion below is proven with real rows.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB vitest
 * job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, name, email, role) VALUES ($1, 'P', $2, 'employee')`, [
    id,
    `user-${id}@example.com`,
  ]);
  return id;
}

async function seedOpportunity(opts: {
  ownerId: string;
  status: "draft" | "published" | "closed";
  publishedAt?: Date | null;
  title?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, published_at)
     VALUES ($1, 'poll', $2, 'Proving POST /opened against a real database', $3, $4, $5)`,
    [id, opts.title ?? "Opened-route fixture", opts.ownerId, opts.status, opts.publishedAt ?? null]
  );
  return id;
}

async function readOpenedAt(userId: string, opportunityId: string): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT opened_at FROM participant_study_opens WHERE user_id = $1 AND opportunity_id = $2`,
    [userId, opportunityId]
  );
  return rows.length > 0 ? rows[0].opened_at : null;
}

const open = (userId: string | null, opportunityId: string) => {
  const req = request(listening(app)).post(`/api/participate/opened/${opportunityId}`);
  return userId ? req.set("x-test-user-id", userId).send() : req.send();
};

describe.skipIf(skipDbTests)("POST /api/participate/opened/:opportunityId, against a real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("participate-opened");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-participate-opened-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const participateRouter = (await import("../participate")).default;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "P", email: "p@example.com", role: "employee" },
        };
      }
      next();
    });
    app.use("/api/participate", participateRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE participant_study_opens, participate_visits, bookings, sessions, opportunities, users CASCADE"
    );
  });

  it("401s with no session", async () => {
    const owner = await seedUser();
    const id = await seedOpportunity({ ownerId: owner, status: "published" });

    await open(null, id).expect(401);
  });

  it("400s a garbage (non-uuid) id, before ever touching the database's own row", async () => {
    const alice = await seedUser();

    const res = await open(alice, "not-a-uuid");

    expect(res.status).toBe(400);
  });

  it("gives IDENTICAL 404 bodies for a draft, a closed and a nonexistent id", async () => {
    const alice = await seedUser();
    const owner = await seedUser();
    const draftId = await seedOpportunity({ ownerId: owner, status: "draft" });
    const closedId = await seedOpportunity({ ownerId: owner, status: "closed" });
    const nonexistentId = crypto.randomUUID();

    const [draftRes, closedRes, nonexistentRes] = await Promise.all([
      open(alice, draftId),
      open(alice, closedId),
      open(alice, nonexistentId),
    ]);

    for (const res of [draftRes, closedRes, nonexistentRes]) {
      expect(res.status).toBe(404);
    }
    // Same message and code across all three - a caller who cannot see a draft
    // or closed study by id from GET /:id cannot tell the difference from this
    // route either.
    expect(draftRes.body.error).toBe(closedRes.body.error);
    expect(closedRes.body.error).toBe(nonexistentRes.body.error);
    expect(draftRes.body.code).toBe(closedRes.body.code);
    expect(closedRes.body.code).toBe(nonexistentRes.body.code);

    // And no row was written for either the draft or the closed attempt - a
    // 404 must not silently record an open of something the caller could not
    // see.
    expect(await readOpenedAt(alice, draftId)).toBeNull();
    expect(await readOpenedAt(alice, closedId)).toBeNull();
  });

  it("200s and upserts opened_at for a published study, then a repeat open updates it", async () => {
    const alice = await seedUser();
    const owner = await seedUser();
    const id = await seedOpportunity({
      ownerId: owner,
      status: "published",
      publishedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const first = await open(alice, id);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    const firstOpenedAt = await readOpenedAt(alice, id);
    expect(firstOpenedAt).not.toBeNull();

    // Force the stored value backwards so a real clock-forward on the second
    // call is unambiguous even on a very fast test run.
    await pool.query(
      `UPDATE participant_study_opens SET opened_at = opened_at - interval '1 hour'
       WHERE user_id = $1 AND opportunity_id = $2`,
      [alice, id]
    );
    const backdated = await readOpenedAt(alice, id);

    const second = await open(alice, id);
    expect(second.status).toBe(200);
    const secondOpenedAt = await readOpenedAt(alice, id);
    expect(secondOpenedAt?.getTime()).toBeGreaterThan((backdated as Date).getTime());

    // Still exactly one row - an upsert, not a log.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM participant_study_opens WHERE user_id = $1 AND opportunity_id = $2`,
      [alice, id]
    );
    expect(rows[0].n).toBe(1);
  });

  it("a republish after an open clears the badge again - the next open re-arms it", async () => {
    const alice = await seedUser();
    const owner = await seedUser();
    const id = await seedOpportunity({
      ownerId: owner,
      status: "published",
      publishedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await open(alice, id).expect(200);

    // Force the stored value backwards, the same way the upsert test above
    // does: without it, the first open and the republish/second-open below
    // are three fast statements against the same DB clock, close enough
    // together that two of their `NOW()` calls can truncate to the same
    // millisecond - a real flake, not a hypothetical one.
    await pool.query(
      `UPDATE participant_study_opens SET opened_at = opened_at - interval '1 hour'
       WHERE user_id = $1 AND opportunity_id = $2`,
      [alice, id]
    );
    const openedBeforeRepublish = await readOpenedAt(alice, id);

    // Simulate an unpublish/republish cycle re-stamping published_at ahead of
    // the earlier open (see opportunities.ts's draft->published branch for the
    // real path; this route only cares about the resulting column value).
    await pool.query(`UPDATE opportunities SET published_at = NOW() WHERE id = $1`, [id]);

    const res = await open(alice, id);

    expect(res.status).toBe(200);
    const openedAfterRepublish = await readOpenedAt(alice, id);
    expect(openedAfterRepublish?.getTime()).toBeGreaterThan((openedBeforeRepublish as Date).getTime());
  });
});
