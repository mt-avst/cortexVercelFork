import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * A CONCURRENT BURST OF MINTS FOR THE SAME (OPPORTUNITY, PARTICIPANT) PAIR
 * CANNOT ALL WIN (cto/AdaptaLabs#159).
 *
 * `mint-refuses-answer-carrying-abandoned-session-postgres.test.ts` proves the
 * SEQUENTIAL case: once any session for a pair carries an answer, every later
 * single mint is refused. That check is itself a SELECT-then-decide, so it is
 * exactly the shape that a concurrent burst can defeat: every request in the
 * burst can read "clear to mint" before any of them has committed, and each
 * one then inserts its own row. cto/AdaptaLabs#159's own review measured this
 * directly against the widened (post-#155) check: six bursts of three
 * parallel mints, abandoning the newest still-answer-free session between
 * bursts so each burst's read stayed clean, produced 18 sessions total - i.e.
 * every one of the 18 concurrent requests minted its own row, not the 6 a
 * correctly serialized burst is entitled to.
 *
 * This suite runs the SAME shape against the fix: `runSerializedForMintPair`
 * takes an advisory lock on `(opportunity_id, participant_id)` around the
 * entire resume/refuse/mint decision, so only ONE request per burst can be
 * the one that reads "clear to mint" - every sibling re-reads AFTER the
 * winner's transaction commits and resolves against what actually landed.
 *
 * REAL END-TO-END: both routers are mounted together, `createSession` is NOT
 * stubbed, and the mint/answer/abandon requests all go through the actual
 * HTTP routes a participant's browser would hit - matching the other
 * DB-backed mint suites in this directory.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";
const migrateScript = path.resolve(__dirname, "../../../scripts/firsthand-migrate.mjs");

const UNFINISHED_SESSION_REFUSAL_CODE = "UNFINISHED_SESSION_HAS_RESPONSES";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;
let resetParticipantRouteLimits: (userId: string) => void;
let resetRuntimeRouteLimits: (userId: string) => void;

async function seedUser(role = "employee"): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, name, email, role) VALUES ($1, 'User', $2, $3)`, [
    id,
    `user-${id}@example.com`,
    role,
  ]);
  return id;
}

async function seedStudy(): Promise<string> {
  const id = `study_${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, status, kind)
     VALUES ($1, 'Concurrent-burst mint fixture', 'Intro', 'Consent', 'launched', 'survey')`,
    [id]
  );
  return id;
}

async function seedStep(studyId: string, stepId = "q1"): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.study_steps (id, study_id, step_order, type, prompt, is_required)
     VALUES ($1, $2, 1, 'open_text', 'How is it going?', false)`,
    [stepId, studyId]
  );
}

async function seedOpportunity(ownerId: string, studyId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities
       (id, type, title, purpose_one_liner, owner_user_id, status, delivery_mode, firsthand_study_id)
     VALUES ($1, 'survey', 'Concurrent-burst mint opportunity',
             'Proving a concurrent burst of mints serializes to one new session', $2,
             'published', 'native', $3)`,
    [id, ownerId, studyId]
  );
  return id;
}

function mintSurvey(opportunityId: string, userId: string) {
  return request(listening(app))
    .post(`/api/opportunities/${opportunityId}/survey-session`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "employee")
    .send({});
}

/** Fires `k` mint requests for the same pair truly concurrently. */
function fireBurst(opportunityId: string, userId: string, k: number) {
  return Promise.all(Array.from({ length: k }, () => mintSurvey(opportunityId, userId)));
}

async function answerStep(token: string, userId: string, stepId = "q1", text = "An answer"): Promise<void> {
  await request(listening(app))
    .post(`/api/firsthand/session/${token}/runtime`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "employee")
    .send({ type: "response", stepId, stepType: "open_text", responsePayload: { text } })
    .expect(200);
}

async function endSession(token: string, userId: string, eventType: string): Promise<void> {
  await request(listening(app))
    .post(`/api/firsthand/session/${token}/runtime`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "employee")
    .send({ type: "event", eventType })
    .expect(200);
}

type RuntimeSessionRow = {
  session_id: string;
  token: string;
  session_status: string;
  created_at: string;
};

/** Every runtime_sessions row for one (opportunity, participant) pair, oldest first. */
async function rowsForPair(opportunityId: string, participantId: string): Promise<RuntimeSessionRow[]> {
  const result = await pool.query<RuntimeSessionRow>(
    `
      SELECT session_id, token, session_status, created_at
      FROM firsthand.runtime_sessions
      WHERE opportunity_id = $1 AND participant_id = $2
      ORDER BY created_at ASC, session_id ASC
    `,
    [opportunityId, participantId]
  );
  return result.rows;
}

describe.skipIf(skipDbTests)("mint-session serializes a concurrent burst for one pair", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("concurrent-burst-mint");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-concurrent-burst-mint-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";
    process.env.FRONTEND_URL = "https://cortex.example.com";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();
    await execFileAsync("node", [migrateScript], {
      env: { ...process.env, DATABASE_URL: postgres.connectionString },
      timeout: 60_000,
    });

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const opportunitiesModule = await import("../opportunities");
    const opportunitiesRouter = opportunitiesModule.default;
    resetParticipantRouteLimits = opportunitiesModule.resetParticipantRouteLimits;
    const firsthandSessionModule = await import("../firsthand-session");
    const firsthandSessionRouter = firsthandSessionModule.default;
    resetRuntimeRouteLimits = firsthandSessionModule.resetRuntimeRouteLimits;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      const role = req.header("x-test-user-role") ?? "employee";
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test", email: "t@example.com", role },
        };
      }
      next();
    });
    app.use("/api/opportunities", opportunitiesRouter);
    app.use("/api/firsthand/session", firsthandSessionRouter);
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
      "TRUNCATE firsthand.participant_responses, firsthand.runtime_sessions, firsthand.studies CASCADE"
    );
    await pool.query("TRUNCATE sessions, opportunities, users CASCADE");
  });

  /**
   * THE CORE PROOF OF #159. Six bursts of three concurrent mints, matching
   * the issue's own Pass 2 measurement exactly in shape: between bursts 1-5,
   * the surviving session is abandoned WITHOUT an answer (so
   * `hasAnswerCarryingTerminalSession` keeps reading clean and the next burst
   * is free to mint again - "abandoning only the newest, still answer-free,
   * session between bursts", cto/AdaptaLabs#159's own wording). The sixth
   * burst's survivor is finished off LIVE instead - answered, then abandoned
   * - matching the issue's "answering+abandoning everything live at the end"
   * and proving the #155 refusal this lock sits alongside still fires
   * correctly once a real answer is on the row.
   *
   * BEFORE this fix, this exact probe (stashing just the four source files
   * cto/AdaptaLabs#159 changed) landed all 18 concurrent requests as 18
   * separate inserts - one per request, not one per burst - reproducing the
   * issue's own "18 sessions" measurement to the row. See the file-level
   * docblock for the reasoning; re-run that stash locally to reproduce the
   * exact number rather than trusting it restated here.
   */
  it("lands exactly ONE new session per burst of 3, never the other 2 concurrent requests' own inserts", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);
    resetParticipantRouteLimits(participant);
    resetRuntimeRouteLimits(participant);

    const BURST_SIZE = 3;
    const BURST_COUNT = 6;
    let previousRowCount = 0;

    for (let burst = 0; burst < BURST_COUNT; burst++) {
      const responses = await fireBurst(opportunity, participant, BURST_SIZE);

      // Every concurrent request in the burst still gets a clean 200 - either
      // by minting, or by resuming the SAME row a sibling minted under the
      // lock this request waited behind.
      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      const rows = await rowsForPair(opportunity, participant);
      // THE ASSERTION: exactly one new row this burst, not up to
      // BURST_SIZE. Before the fix this was BURST_SIZE new rows almost
      // every time (18 total across 6 bursts of 3, measured against the
      // issue's own probe).
      expect(rows).toHaveLength(previousRowCount + 1);

      // And every one of the 3 concurrent responses names that SAME row -
      // never a duplicate `session_url` of its own.
      const sessionUrls = new Set(responses.map((response) => response.body.session_url));
      expect(sessionUrls.size).toBe(1);

      const survivor = rows[rows.length - 1];
      expect(sessionUrls.has(`https://cortex.example.com/survey/${survivor.token}`)).toBe(true);

      if (burst < BURST_COUNT - 1) {
        await endSession(survivor.token, participant, "session_abandoned");
      } else {
        await answerStep(survivor.token, participant);
        await endSession(survivor.token, participant, "session_abandoned");

        // The sequential #155 refusal still closes the pair permanently once
        // a real answer is on a terminal row - the lock does not disturb it.
        const blockedMint = await mintSurvey(opportunity, participant);
        expect(blockedMint.status).toBe(409);
        expect(blockedMint.body.code).toBe(UNFINISHED_SESSION_REFUSAL_CODE);
      }

      previousRowCount = rows.length;
    }

    const finalRows = await rowsForPair(opportunity, participant);
    expect(finalRows).toHaveLength(BURST_COUNT);
  }, 60_000);

  /**
   * THE CONTROL: two DIFFERENT participants minting the SAME opportunity
   * concurrently must not serialize against each OTHER - the lock is keyed
   * on `(opportunity_id, participant_id)`, not on the opportunity alone.
   *
   * NOT proven by "both eventually return 200" alone (review pass 1 found
   * this: an opportunity-only lock still serializes CORRECTLY, it just does
   * it for the wrong reason, so both requests still succeed with one row
   * each - Promise.all gives no guarantee either request was actually
   * running WHILE the other held a lock).
   *
   * ALSO NOT proven by holding a manually-constructed lock key in the test
   * itself (a real first draft of this fix): a test that computes
   * `pg_advisory_xact_lock(hashtext(opportunity), hashtext(participantA))`
   * by hand asserts the CORRECT formula never collides with itself, which is
   * true whether or not production's OWN key derivation has been mutated to
   * something else entirely (proven: collapsing production to
   * `hashtext(opportunityId), hashtext(opportunityId)` - dropping
   * participantId - left that version of this test green, because the
   * hand-built key never matched what the mutated route actually computes
   * for anyone).
   *
   * So this drives the REAL `runSerializedForMintPair` directly for
   * participant A, with a deliberately slow operation, so whatever key
   * production ACTUALLY derives - correct or mutated - is what gets held.
   * Participant B's REAL HTTP mint, fired while A's hold is still open, must
   * complete well inside A's hold window if the two are genuinely
   * pair-scoped; a collapsed key would leave B queued behind A until A's
   * operation finishes, which the bound below would catch.
   */
  it("does not serialize two different participants' concurrent mints against each other", async () => {
    const owner = await seedUser("researcher_admin");
    const participantA = await seedUser();
    const participantB = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);
    resetParticipantRouteLimits(participantA);
    resetParticipantRouteLimits(participantB);

    const { runSerializedForMintPair } = await import("../../firsthand/runtime-database");
    const holdMs = 3_000;

    // MR !528 review pass 2 MEDIUM-1: firing B immediately after CALLING
    // runSerializedForMintPair, rather than after A's operation has actually
    // started (i.e. after the lock is actually held - the callback only runs
    // once BEGIN and the advisory lock both succeed), let this test pass for
    // the wrong reason when B happened to be sent before A's transaction
    // reached the lock. Proven: collapsing the lock to opportunity-only
    // failed this test reliably when the whole file ran (A warmed up first),
    // but passed when this test ran alone. Waiting on `lockHeld` removes that
    // ordering dependency.
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalLockHeld = resolve;
    });

    const holdA = runSerializedForMintPair(opportunity, participantA, async () => {
      signalLockHeld();
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      return "held";
    });
    await lockHeld;

    const startB = Date.now();
    const responseB = await mintSurvey(opportunity, participantB);
    const elapsedB = Date.now() - startB;

    expect(responseB.status).toBe(200);
    // A genuine opportunity-only collision would make B wait out ~all of
    // A's hold; a correctly pair-scoped lock lets B run immediately.
    expect(elapsedB).toBeLessThan(holdMs / 2);

    expect(await holdA).toBe("held");

    const rowsB = await rowsForPair(opportunity, participantB);
    expect(rowsB).toHaveLength(1);
  }, 15_000);

  /**
   * THE POOL-EXHAUSTION REGRESSION (MR !528 review pass 1 HIGH-1), pinned as
   * its own test rather than left to the two tests above, which both use at
   * most two participants and so never approach `RUNTIME_POOL_MAX_CONNECTIONS`
   * (5).
   *
   * `runSerializedForMintPair` holds ONE runtime-pool connection for the
   * whole locked mint decision. Before the HIGH-1 fix, `createSession`'s
   * `getStudyById` call took a SECOND connection from the same pool while
   * still inside that lock - and participant traffic is not behind the
   * admission cap that would otherwise queue a second checkout politely. With
   * 5+ DIFFERENT participants minting the same study concurrently, every
   * connection in the pool ended up held by a request waiting on a 6th, and
   * every one of them timed out at `connectionTimeoutMillis` (10s) and 500'd
   * - proven directly against this exact test shape before the fix: 8
   * concurrent participants, all 8 returning 500 after ~10s. After the fix
   * (`getStudyById` now runs on the SAME locked client), the same 8 succeed
   * in well under a second.
   *
   * 8, not 5: to exceed the pool's ENTIRE capacity, not merely saturate it -
   * a burst of exactly 5 could plausibly scrape by on timing alone.
   */
  it("survives a burst of MORE participants than the runtime pool has connections", async () => {
    const owner = await seedUser("researcher_admin");
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);

    const participantCount = 8;
    const participants = await Promise.all(
      Array.from({ length: participantCount }, () => seedUser())
    );
    for (const participantId of participants) {
      resetParticipantRouteLimits(participantId);
    }

    const start = Date.now();
    const responses = await Promise.all(
      participants.map((participantId) => mintSurvey(opportunity, participantId))
    );
    const elapsed = Date.now() - start;

    for (const response of responses) {
      expect(response.status).toBe(200);
    }
    // A pool-exhaustion regression times out at connectionTimeoutMillis
    // (10s) per stranded request - this bound is well under that, so a
    // reintroduced second checkout under the lock fails this by name rather
    // than merely running slow.
    expect(elapsed).toBeLessThan(5_000);

    for (const participantId of participants) {
      const rows = await rowsForPair(opportunity, participantId);
      expect(rows).toHaveLength(1);
    }
  }, 20_000);
});
