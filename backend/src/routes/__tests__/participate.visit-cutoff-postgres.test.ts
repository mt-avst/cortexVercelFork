import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * `POST /api/participate/visit`'S CUTOFF SQL, AGAINST A REAL DATABASE
 * (cto/AdaptaLabs#168).
 *
 * Nothing in the fast suite pins the three predicates the single CTE query in
 * `participate.ts` depends on: the visibility predicate (`status = 'published'`
 * - draft/closed excluded even with `published_at` set), the `published_at >
 * cutoff` direction, and the `NOT EXISTS` "not opened since" check including its
 * own `opened_at >= published_at` boundary. Deleting any of the three leaves
 * backend jest green, because the jest suite mocks the pool and can never see
 * which rows a real predicate keeps.
 *
 * Every SQL-shape assertion below sets up the real timestamps that make a
 * mock-pool test incapable of seeing the difference, then reads the actual
 * response and/or the actual stored row.
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

/** An opportunity with a controlled status and `published_at`. */
async function seedOpportunity(opts: {
  ownerId: string;
  status: "draft" | "published" | "closed";
  publishedAt: Date | null;
  title?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, published_at)
     VALUES ($1, 'poll', $2, 'Proving the visit cutoff SQL against a real database', $3, $4, $5)`,
    [id, opts.title ?? "Visit cutoff fixture", opts.ownerId, opts.status, opts.publishedAt]
  );
  return id;
}

/** Directly seeds/overwrites a user's `participate_visits` row, bypassing the
 * route, so the gap the route measures is under the test's own control. */
async function seedVisitRow(userId: string, lastSeenAt: Date, previousVisitEndAt: Date | null): Promise<void> {
  await pool.query(
    `INSERT INTO participate_visits (user_id, last_seen_at, previous_visit_end_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET last_seen_at = $2, previous_visit_end_at = $3`,
    [userId, lastSeenAt, previousVisitEndAt]
  );
}

/** Seeds `last_seen_at` a fixed offset BEHIND the database's own clock,
 * rather than the app process's `Date.now()` - so a margin close to the
 * 30-minute boundary is not also a bet on the two clocks agreeing. */
async function seedVisitRowSecondsBeforeDbNow(userId: string, secondsAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO participate_visits (user_id, last_seen_at, previous_visit_end_at)
     VALUES ($1, NOW() - ($2 || ' seconds')::interval, NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       last_seen_at = NOW() - ($2 || ' seconds')::interval,
       previous_visit_end_at = NULL`,
    [userId, secondsAgo]
  );
}

async function markOpened(userId: string, opportunityId: string, openedAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO participant_study_opens (user_id, opportunity_id, opened_at) VALUES ($1, $2, $3)`,
    [userId, opportunityId, openedAt]
  );
}

async function readVisitRow(userId: string): Promise<{ lastSeenAt: Date; previousVisitEndAt: Date | null }> {
  const { rows } = await pool.query(
    `SELECT last_seen_at, previous_visit_end_at FROM participate_visits WHERE user_id = $1`,
    [userId]
  );
  return { lastSeenAt: rows[0].last_seen_at, previousVisitEndAt: rows[0].previous_visit_end_at };
}

const visit = (userId: string) =>
  request(listening(app)).post("/api/participate/visit").set("x-test-user-id", userId).send();

describe.skipIf(skipDbTests)("POST /api/participate/visit, against a real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("participate-visit-cutoff");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-participate-visit-not-a-real-secret"; // gitleaks:allow
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

  it("pins the gap at exactly 30 minutes, as the literal the route's own comment promises", async () => {
    const { PARTICIPATE_VISIT_GAP_MINUTES } = await import("../participate");
    expect(PARTICIPATE_VISIT_GAP_MINUTES).toBe(30);
  });

  it(
    "a gap of exactly 30 minutes does not end the visit, " +
      "deterministically (one transaction, one NOW())",
    async () => {
      // `NOW()` is pinned to the transaction's start for every statement run
      // inside it, in Postgres - so seeding `last_seen_at` as `NOW() - 30
      // minutes` and then calling the route's own function on the SAME
      // connection makes the gap it measures exactly 30:00, not
      // approximately 30:00 shifted by however long the seed and the call
      // take on a loaded CI runner. No sleep, no wall-clock race either way.
      const { PARTICIPATE_VISIT_GAP_MINUTES, recordVisitAndListNew } = await import("../participate");
      expect(PARTICIPATE_VISIT_GAP_MINUTES).toBe(30);

      const alice = await seedUser();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO participate_visits (user_id, last_seen_at, previous_visit_end_at)
           VALUES ($1, NOW() - make_interval(mins => $2), NULL)`,
          [alice, PARTICIPATE_VISIT_GAP_MINUTES]
        );

        await recordVisitAndListNew(client, alice);

        const { rows } = await client.query(
          `SELECT previous_visit_end_at FROM participate_visits WHERE user_id = $1`,
          [alice]
        );
        // Exactly AT the boundary is the `>` comparison's negative arm: the
        // cutoff must not move.
        expect(rows[0].previous_visit_end_at).toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  );

  it(
    "a gap one microsecond past 30 minutes does end the visit, " +
      "deterministically (one transaction, one NOW())",
    async () => {
      // The positive arm of the same boundary, on the same single
      // connection and transaction as the test above, so the two together
      // pin the comparison to exactly 30:00.
      const { PARTICIPATE_VISIT_GAP_MINUTES, recordVisitAndListNew } = await import("../participate");

      const alice = await seedUser();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO participate_visits (user_id, last_seen_at, previous_visit_end_at)
           VALUES ($1, NOW() - make_interval(mins => $2) - interval '1 microsecond', NULL)`,
          [alice, PARTICIPATE_VISIT_GAP_MINUTES]
        );

        await recordVisitAndListNew(client, alice);

        const { rows } = await client.query(
          `SELECT previous_visit_end_at FROM participate_visits WHERE user_id = $1`,
          [alice]
        );
        expect(rows[0].previous_visit_end_at).not.toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  );

  it("answers [] for a user with no prior visit row, and creates one with no cutoff yet", async () => {
    const alice = await seedUser();

    const res = await visit(alice).expect(200);

    expect(res.body).toEqual({ newOpportunityIds: [] });
    const row = await readVisitRow(alice);
    expect(row.previousVisitEndAt).toBeNull();
  });

  it("leaves the cutoff exactly where it was when the gap is well inside the window", async () => {
    const alice = await seedUser();
    const establishedCutoff = new Date(Date.now() - 45 * 60 * 1000);
    // A visit that has already ended once (a real, non-null cutoff), then a
    // second call inside the 30-minute window.
    await seedVisitRow(alice, new Date(Date.now() - 5 * 60 * 1000), establishedCutoff);

    await visit(alice).expect(200);

    const row = await readVisitRow(alice);
    expect(row.previousVisitEndAt?.getTime()).toBe(establishedCutoff.getTime());
  });

  it("rolls the cutoff forward to the OLD last_seen_at once the gap exceeds the window", async () => {
    const alice = await seedUser();
    const oldLastSeen = new Date(Date.now() - 40 * 60 * 1000);
    await seedVisitRow(alice, oldLastSeen, null);

    await visit(alice).expect(200);

    const row = await readVisitRow(alice);
    // The NEW cutoff is the visit's own OLD last_seen_at, not the moment the
    // gap was noticed and not left null.
    expect(row.previousVisitEndAt?.getTime()).toBe(oldLastSeen.getTime());
    // And last_seen_at itself has moved up to (about) now.
    expect(Date.now() - row.lastSeenAt.getTime()).toBeLessThan(10_000);
  });

  it("does not roll the cutoff at a gap safely inside 30 minutes (the `>` boundary, negative arm)", async () => {
    const alice = await seedUser();
    // 29:57, measured from the DATABASE's own clock rather than the app
    // process's `Date.now()` - a 3-second margin this close to the boundary
    // must not also be a bet on the app and DB clocks agreeing.
    await seedVisitRowSecondsBeforeDbNow(alice, 29 * 60 + 57);

    await visit(alice).expect(200);

    const row = await readVisitRow(alice);
    expect(row.previousVisitEndAt).toBeNull();
  });

  it("does roll the cutoff at a gap safely past 30 minutes (the `>` boundary, positive arm)", async () => {
    const alice = await seedUser();
    // 30:03, from the database's own clock for the same reason as the
    // negative arm above.
    await seedVisitRowSecondsBeforeDbNow(alice, 30 * 60 + 3);
    const { lastSeenAt: oldLastSeen } = await readVisitRow(alice);

    await visit(alice).expect(200);

    const row = await readVisitRow(alice);
    expect(row.previousVisitEndAt?.getTime()).toBe(oldLastSeen.getTime());
  });

  it("never returns a draft study, even one with published_at set", async () => {
    const alice = await seedUser();
    const owner = await seedUser();
    await seedVisitRow(alice, new Date(Date.now() - 40 * 60 * 1000), null);
    await seedOpportunity({
      ownerId: owner,
      status: "draft",
      publishedAt: new Date(Date.now() - 10 * 60 * 1000),
      title: "A draft carrying published_at",
    });

    const res = await visit(alice).expect(200);

    expect(res.body.newOpportunityIds).toEqual([]);
  });

  it("never returns a closed study, even one with published_at set", async () => {
    const alice = await seedUser();
    const owner = await seedUser();
    await seedVisitRow(alice, new Date(Date.now() - 40 * 60 * 1000), null);
    await seedOpportunity({
      ownerId: owner,
      status: "closed",
      publishedAt: new Date(Date.now() - 10 * 60 * 1000),
      title: "A closed study carrying published_at",
    });

    const res = await visit(alice).expect(200);

    expect(res.body.newOpportunityIds).toEqual([]);
  });

  it("published_at exactly AT the cutoff is excluded (`>`, not `>=`); one instant later it is included", async () => {
    const alice = await seedUser();
    const owner = await seedUser();
    await seedVisitRow(alice, new Date(Date.now() - 40 * 60 * 1000), null);

    // First call rolls the cutoff; read back its exact stored value so the two
    // fixtures below can be placed relative to it with no wall-clock race.
    await visit(alice).expect(200);
    const { previousVisitEndAt: cutoff } = await readVisitRow(alice);
    expect(cutoff).not.toBeNull();

    const atCutoff = await seedOpportunity({
      ownerId: owner,
      status: "published",
      publishedAt: cutoff as Date,
      title: "Published exactly at the cutoff",
    });
    const justAfterCutoff = await seedOpportunity({
      ownerId: owner,
      status: "published",
      publishedAt: new Date((cutoff as Date).getTime() + 1000),
      title: "Published one second after the cutoff",
    });

    // Second call, still inside the 30-minute window, so the cutoff is unchanged.
    const res = await visit(alice).expect(200);

    expect(res.body.newOpportunityIds).not.toContain(atCutoff);
    expect(res.body.newOpportunityIds).toContain(justAfterCutoff);
  });

  it("excludes a study this user opened AT OR AFTER its published_at (`>=`, not `>`)", async () => {
    const alice = await seedUser();
    const owner = await seedUser();
    await seedVisitRow(alice, new Date(Date.now() - 40 * 60 * 1000), null);
    await visit(alice).expect(200);
    const { previousVisitEndAt: cutoff } = await readVisitRow(alice);

    const publishedAt = new Date((cutoff as Date).getTime() + 60_000);
    const openedExactlyAtPublish = await seedOpportunity({
      ownerId: owner,
      status: "published",
      publishedAt,
      title: "Opened exactly when published",
    });
    await markOpened(alice, openedExactlyAtPublish, publishedAt);

    const openedBeforePublish = await seedOpportunity({
      ownerId: owner,
      status: "published",
      publishedAt: new Date(publishedAt.getTime() + 60_000),
      title: "Opened before it was (re)published",
    });
    // A view recorded BEFORE this publish stamp - e.g. an admin previewing the
    // draft - must not count as clearing the badge once it goes live.
    await markOpened(alice, openedBeforePublish, new Date(publishedAt.getTime() + 60_000 - 1000));

    const res = await visit(alice).expect(200);

    expect(res.body.newOpportunityIds).not.toContain(openedExactlyAtPublish);
    expect(res.body.newOpportunityIds).toContain(openedBeforePublish);
  });

  it("excludes a study opened by this user well after publish, via the NOT EXISTS clause", async () => {
    const alice = await seedUser();
    const owner = await seedUser();
    await seedVisitRow(alice, new Date(Date.now() - 40 * 60 * 1000), null);
    await visit(alice).expect(200);
    const { previousVisitEndAt: cutoff } = await readVisitRow(alice);

    const publishedAt = new Date((cutoff as Date).getTime() + 60_000);
    const opened = await seedOpportunity({ ownerId: owner, status: "published", publishedAt, title: "Opened" });
    await markOpened(alice, opened, new Date(publishedAt.getTime() + 60_000));
    const neverOpened = await seedOpportunity({
      ownerId: owner,
      status: "published",
      publishedAt,
      title: "Never opened",
    });

    const res = await visit(alice).expect(200);

    expect(res.body.newOpportunityIds).not.toContain(opened);
    expect(res.body.newOpportunityIds).toContain(neverOpened);
  });

  it("another user's open does not clear MY badge for the same study", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const owner = await seedUser();
    await seedVisitRow(alice, new Date(Date.now() - 40 * 60 * 1000), null);
    await visit(alice).expect(200);
    const { previousVisitEndAt: cutoff } = await readVisitRow(alice);

    const publishedAt = new Date((cutoff as Date).getTime() + 60_000);
    const study = await seedOpportunity({
      ownerId: owner,
      status: "published",
      publishedAt,
      title: "Bob opened it, Alice did not",
    });
    await markOpened(bob, study, new Date(publishedAt.getTime() + 60_000));

    const res = await visit(alice).expect(200);

    expect(res.body.newOpportunityIds).toContain(study);
  });
});
