import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../__tests__/helpers/postgres-instance";

import type { StudyStep } from "../../../shared/firsthand/contract";

/**
 * What a SEQUENCE of autosaves does to the database, against a real Postgres
 * with every firsthand migration applied.
 *
 * D2 turns `updateStudy` from something a researcher calls when they press
 * Save into something a timer calls every few seconds for as long as the form
 * is open. Nothing about a single call changes; what changes is that the
 * hundredth call has to leave the database in the same shape as the first,
 * and that every call's precondition comes from the previous call's own
 * write.
 *
 * This file runs against a real database rather than a mocked client, and the
 * reason is not general rigour - it is that every behaviour asserted here is
 * enforced by a CONSTRAINT, and a mocked `pg` cannot raise one:
 *
 *   - `UNIQUE (study_id, step_order)` (0004) is checked per statement, so a
 *     reorder collides on the first swap unless the surviving rows are parked
 *     at a negative order first. An autosave reorders on a timer.
 *   - `PRIMARY KEY (study_id, id)` (0010) is what makes the upsert an upsert.
 *   - the composite FOREIGN KEY on `participant_responses (study_id, step_id)`
 *     with `ON DELETE SET NULL` (0015) is what detaches an answer when its
 *     question goes.
 *   - `CHECK ((study_id IS NULL) = (step_id IS NULL))` (0015) is what refuses
 *     a HALF-detached row - and it is the one that shipped a defect to
 *     production in F2, because six tests asserted SQL text against a mocked
 *     client and not one of them could see that the statement wrote a row the
 *     database refuses.
 *
 * So there are no SQL-string assertions here. Every expectation is about rows
 * Postgres accepted or refused.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

/**
 * Generated, not written down.
 *
 * The container is throwaway - `--rm`, on loopback, on an ephemeral port - so
 * a literal here was never a live credential. It was still a high-entropy
 * string inside the merge request's commit range, and `gitleaks` scans the
 * whole range, so a later commit cannot clear a finding an earlier one
 * introduced. Cheaper to generate it than to argue with the scanner.
 */
const migrateScript = path.resolve(__dirname, "../../scripts/firsthand-migrate.mjs");

const STUDY_ID = "study_autosave";
const AUTHOR = { userId: "author-1", isSuperadmin: false };

let databaseUrl: string;
let pool: pg.Pool;
let postgres: TestPostgres;


const importRepository = async () => await import("./studies-repository");

/**
 * A question, in the shape the opportunity route hands `updateStudy` after
 * `toSurveySteps` has resolved each `step_key` into a namespaced id.
 *
 * `step_id` derives from the key, which is exactly F2's promise: the id is the
 * author's minted identity, not the array position. Every save in this file
 * builds its steps through this helper so a reorder genuinely carries the same
 * ids to different positions - which is the only version of a reorder that can
 * trip the per-statement UNIQUE.
 */
const question = (key: string, order: number, prompt: string): StudyStep => ({
  step_id: `${STUDY_ID}_${key}`,
  order,
  type: "rating",
  prompt,
  config: { scale_max: 5 }
});

/**
 * A participant who has answered one question.
 *
 * Written straight to the tables rather than through the runtime repository:
 * what is under test here is what the DELETE does to this row, so the row only
 * has to exist and be attached. `participant_responses.session_id` has a real
 * foreign key to `runtime_sessions`, so the session has to exist too - which is
 * itself worth having, because a cascade that removed the answer for the wrong
 * reason would otherwise look like a successful detach.
 */
const seedAnsweredSession = async (stepId: string, prompt: string) => {
  await pool.query(
    `INSERT INTO firsthand.runtime_sessions
       (session_id, logical_session_id, token, study_id, study_title,
        participant_id, participant_display_name, session_status,
        transcript_status, microphone_permission, screen_permission,
        recording_status, upload_status, steps)
     VALUES ('session_1', 'session_1', 'fh_token', $1, 'Pulse',
             'user-42', 'User 42', 'in_progress', 'idle', 'granted', 'granted',
             'idle', 'idle', '[]'::jsonb)`,
    [STUDY_ID]
  );
  await pool.query(
    `INSERT INTO firsthand.participant_responses
       (id, session_id, study_id, step_id, step_type, step_prompt,
        response_payload, saved_at)
     VALUES ('response_1', 'session_1', $1, $2, 'rating', $3,
             '{"rating":4}'::jsonb, NOW())`,
    [STUDY_ID, stepId, prompt]
  );
};

const stepRows = async () => {
  const { rows } = await pool.query<{ id: string; step_order: number; prompt: string }>(
    `SELECT id, step_order, prompt
       FROM firsthand.study_steps
      WHERE study_id = $1
      ORDER BY step_order`,
    [STUDY_ID]
  );
  return rows;
};

const studyRowCount = async () => {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*) FROM firsthand.studies"
  );
  // node-pg returns COUNT(*) as a string.
  return Number(rows[0].count);
};

const storedUpdatedAt = async () => {
  const { rows } = await pool.query<{ updated_at: Date }>(
    "SELECT updated_at FROM firsthand.studies WHERE id = $1",
    [STUDY_ID]
  );
  return rows[0]?.updated_at;
};

/**
 * One autosave, as the opportunity route makes it: the same content every
 * time unless the caller varies it, and a precondition that must be whatever
 * the PREVIOUS save left behind.
 */
const autosave = async (
  steps: StudyStep[],
  expectedUpdatedAt: string | undefined,
  consentText = "Consent"
) => {
  const { updateStudy } = await importRepository();
  return await updateStudy(
    STUDY_ID,
    { consent_text: consentText, steps },
    AUTHOR,
    expectedUpdatedAt
  );
};

/**
 * The precondition a caller would hold after a successful save.
 *
 * Read off the RESULT, never re-fetched, because that is precisely what D2's
 * client does and what the route's new `linked_study_updated_at` carries. A
 * test that re-read the row here would pass while the returned value was
 * wrong, which is the whole thing worth checking.
 */
const revisionFrom = (result: Awaited<ReturnType<typeof autosave>>): string => {
  if (!result.ok) {
    throw new Error(`Expected a successful save, got ${JSON.stringify(result)}`);
  }
  return result.study.updated_at;
};

describe.skipIf(skipDbTests)("a sequence of autosaves, against a real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("autosave");
    databaseUrl = postgres.connectionString;

    await execFileAsync("node", [migrateScript], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60_000
    });

    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await postgres?.stop();
  });

  beforeEach(async () => {
    process.env.DATABASE_URL = databaseUrl;

    await pool.query("TRUNCATE firsthand.studies CASCADE");
    await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
    await pool.query(
      `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, kind, owner_user_id)
       VALUES ($1, 'Pulse', 'Intro', 'Consent', 'survey', $2)`,
      [STUDY_ID, AUTHOR.userId]
    );
    await pool.query(
      `INSERT INTO firsthand.study_steps (study_id, id, step_order, type, prompt)
       VALUES ($1, $2, 1, 'rating', 'First'),
              ($1, $3, 2, 'rating', 'Second')`,
      [STUDY_ID, `${STUDY_ID}_alpha`, `${STUDY_ID}_beta`]
    );
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    const globals = globalThis as typeof globalThis & {
      __firsthandRuntimePool?: { end?: () => Promise<void> };
      __firsthandRuntimeVerification?: unknown;
    };
    await globals.__firsthandRuntimePool?.end?.().catch(() => {});
    delete globals.__firsthandRuntimePool;
    delete globals.__firsthandRuntimeVerification;
  });

  /**
   * THE exit criterion, asserted where it can actually be observed.
   *
   * "A hundred saves produce one study" is a statement about rows, and the
   * response of any individual save cannot make it. A repository that minted
   * a study per save, or that appended step rows instead of upserting them,
   * would answer every one of those hundred calls with a perfectly ordinary
   * success.
   */
  it("leaves exactly one study and one set of steps after a hundred saves", async () => {
    let revision: string | undefined = undefined;
    for (let save = 0; save < 100; save += 1) {
      // The prompt changes on every pass so that no save is a no-op the
      // repository could legitimately skip - a hundred identical bodies would
      // prove nothing about a hundred writes.
      const result = await autosave(
        [question("alpha", 1, `First ${save}`), question("beta", 2, "Second")],
        revision
      );
      revision = revisionFrom(result);
    }

    expect(await studyRowCount()).toBe(1);
    expect(await stepRows()).toEqual([
      expect.objectContaining({ id: `${STUDY_ID}_alpha`, prompt: "First 99" }),
      expect.objectContaining({ id: `${STUDY_ID}_beta`, prompt: "Second" })
    ]);
  });

  /**
   * The precondition loop, which is the thing D2 adds and the thing that
   * cannot work without the route returning the new revision.
   *
   * Each save's precondition is the previous save's OWN returned value. If
   * that value were wrong - or if the client had to keep re-sending the
   * revision it loaded with - the second save would be refused as stale
   * against the first, and so would every save after it.
   */
  it("accepts each save's own returned revision as the next save's precondition", async () => {
    const first = await autosave([question("alpha", 1, "First")], undefined);
    const second = await autosave([question("alpha", 1, "Second")], revisionFrom(first));
    const third = await autosave([question("alpha", 1, "Third")], revisionFrom(second));

    expect(third.ok).toBe(true);
    expect((await stepRows())[0]).toEqual(
      expect.objectContaining({ prompt: "Third" })
    );
  });

  /**
   * The same loop's failure mode, stated as its own test so that a fix which
   * simply stopped sending preconditions could not pass the one above.
   *
   * Re-using a spent revision is exactly what a client does when it never
   * learns the new one, and it must be REFUSED rather than quietly written.
   */
  it("refuses a save that reuses a revision an earlier save already spent, and writes nothing", async () => {
    const first = await autosave([question("alpha", 1, "First")], undefined);
    const spent = revisionFrom(first);
    await autosave([question("alpha", 1, "Second")], spent);

    const before = await stepRows();
    const refused = await autosave([question("alpha", 1, "Third")], spent);

    expect(refused.ok).toBe(false);
    expect(refused).toEqual(expect.objectContaining({ reason: "stale" }));
    // The refusal wrote nothing. Asserted on rows rather than on the return
    // value: a ROLLBACK that did not happen is invisible from the caller's
    // side, and this is the only place it shows.
    expect(await stepRows()).toEqual(before);
  });

  /**
   * `UNIQUE (study_id, step_order)` is checked per statement, so swapping two
   * questions collides on the first row unless the survivors are parked out of
   * the way first.
   *
   * An author reordering questions with autosave running hits this without
   * doing anything unusual, and a mocked client would report the same sequence
   * of statements whether or not Postgres accepted them.
   */
  it("survives a reorder, which the per-statement unique constraint would otherwise refuse", async () => {
    const first = await autosave(
      [question("alpha", 1, "First"), question("beta", 2, "Second")],
      undefined
    );

    const reordered = await autosave(
      [question("beta", 1, "Second"), question("alpha", 2, "First")],
      revisionFrom(first)
    );

    expect(reordered.ok).toBe(true);
    // The IDS moved position; they were not rewritten. That is F2's promise
    // and it is what keeps answers with their questions.
    expect(await stepRows()).toEqual([
      expect.objectContaining({ id: `${STUDY_ID}_beta`, step_order: 1 }),
      expect.objectContaining({ id: `${STUDY_ID}_alpha`, step_order: 2 })
    ]);
  });

  /**
   * The F2 shape, reached through the autosave path rather than the
   * participant one.
   *
   * A researcher removing a question while answers exist detaches them through
   * `ON DELETE SET NULL` on the composite foreign key. The CHECK requires
   * `study_id` and `step_id` to be null TOGETHER - and because the composite
   * FK is MATCH SIMPLE it stops checking the moment either column is null, so
   * the CHECK is the only thing standing between a half-detached row and
   * storage. If `ON DELETE SET NULL` ever nulled one column and not the other,
   * this delete would abort.
   */
  it("detaches an answer when its question is removed, with both columns going null together", async () => {
    await seedAnsweredSession(`${STUDY_ID}_beta`, "Second");

    const first = await autosave(
      [question("alpha", 1, "First"), question("beta", 2, "Second")],
      undefined
    );

    // The removal. Only alpha survives, so beta's row is deleted and the
    // answer written against it has to go somewhere.
    const removed = await autosave([question("alpha", 1, "First")], revisionFrom(first));

    expect(removed.ok).toBe(true);
    expect(await stepRows()).toEqual([
      expect.objectContaining({ id: `${STUDY_ID}_alpha` })
    ]);

    const { rows } = await pool.query<{ study_id: string | null; step_id: string | null }>(
      "SELECT study_id, step_id FROM firsthand.participant_responses"
    );
    // The answer SURVIVED, detached. Losing it would be worse than the
    // constraint violation this replaces.
    expect(rows).toEqual([{ study_id: null, step_id: null }]);
  });

  /**
   * A no-op save must not move the revision.
   *
   * Autosave fires on a timer, and a form that is open but untouched should
   * not be advancing a value other people's saves are checked against. This
   * is `touchesTheRow` observed from outside.
   */
  it("does not move the revision for a save that changes nothing", async () => {
    const { updateStudy } = await importRepository();
    const first = await autosave([question("alpha", 1, "First")], undefined);
    const revision = revisionFrom(first);
    const settled = await storedUpdatedAt();

    const empty = await updateStudy(STUDY_ID, {}, AUTHOR, revision);

    expect(empty.ok).toBe(true);
    expect(await storedUpdatedAt()).toEqual(settled);
  });
});
