import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectMock = vi.fn();
// `on` is part of the mock because the runtime pool registers an `error`
// listener at construction - see ../utils/poolErrorLogging.ts. A pool without
// one turns an idle-connection error into an unhandled EventEmitter error.
const onMock = vi.fn();
const poolConstructorMock = vi.fn(() => ({
  connect: connectMock,
  on: onMock
}));

vi.mock("pg", () => ({
  Pool: poolConstructorMock
}));

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

const baseStep = {
  step_id: "step_001",
  order: 1,
  type: "instruction" as const,
  prompt: "Talk through the page out loud.",
  is_required: true,
  helper_text: "Be specific",
  target_url: "/demo-target/checkout"
};

const choiceStep = {
  step_id: "step_002",
  order: 2,
  type: "single_choice" as const,
  prompt: "Would you sponsor a spike?",
  is_required: true,
  options: ["Yes", "Maybe", "No"]
};

const endStep = {
  step_id: "step_end",
  order: 3,
  type: "end" as const,
  prompt: "Thanks for taking part."
};

describe("studies repository", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    delete (
      globalThis as typeof globalThis & {
        __firsthandRuntimeVerification?: unknown;
      }
    ).__firsthandRuntimeVerification;
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns an empty list when persistence is not configured", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;

    const studiesRepository = await import("./studies-repository");

    await expect(studiesRepository.listStudies()).resolves.toEqual([]);
    expect(studiesRepository.isStudiesPersistenceConfigured()).toBe(false);
  });

  it("inserts a study and its steps in a single transaction", async () => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });

    operationClient.query.mockImplementation(async (sql: string) => {
      if (sql === "SET search_path TO firsthand") {
        return { rowCount: null, rows: [] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rowCount: null, rows: [] };
      }

      if (sql.includes("INSERT INTO studies")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("INSERT INTO study_steps")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM studies")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "study_abc",
              title: "Sample",
              intro_text: "Intro",
              consent_text: "Consent",
              brand_name: "Adaptavist",
              estimated_duration_minutes: 15,
              locale: "en-GB",
              status: "draft",
              created_at: "2026-06-08T00:00:00.000Z",
              updated_at: "2026-06-08T00:00:00.000Z"
            }
          ]
        };
      }

      if (sql.includes("FROM study_steps")) {
        return {
          rowCount: 3,
          rows: [
            {
              id: "step_001",
              study_id: "study_abc",
              step_order: 1,
              type: "instruction",
              prompt: "Talk through the page out loud.",
              target_url: "/demo-target/checkout",
              helper_text: "Be specific",
              is_required: true,
              options: null
            },
            {
              id: "step_002",
              study_id: "study_abc",
              step_order: 2,
              type: "single_choice",
              prompt: "Would you sponsor a spike?",
              target_url: null,
              helper_text: null,
              is_required: true,
              options: ["Yes", "Maybe", "No"]
            },
            {
              id: "step_end",
              study_id: "study_abc",
              step_order: 3,
              type: "end",
              prompt: "Thanks for taking part.",
              target_url: null,
              helper_text: null,
              is_required: false,
              options: null
            }
          ]
        };
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    });

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    const studiesRepository = await import("./studies-repository");

    const result = await studiesRepository.createStudy({
      id: "study_abc",
      title: "Sample",
      intro_text: "Intro",
      consent_text: "Consent",
      brand_name: "Adaptavist",
      estimated_duration_minutes: 15,
      locale: "en-GB",
      owner_user_id: "user-author",
      steps: [baseStep, choiceStep, endStep]
    });

    expect(result.study.id).toBe("study_abc");
    expect(result.study.status).toBe("draft");
    expect(result.steps).toHaveLength(3);
    expect(result.steps[1].options).toEqual(["Yes", "Maybe", "No"]);

    const studyInserts = operationClient.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO studies")
    );
    const stepInserts = operationClient.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO study_steps")
    );

    expect(studyInserts).toHaveLength(1);
    expect(stepInserts).toHaveLength(3);

    // The author is stored, or every study lands unowned and the whole
    // ownership rule below degrades to "anyone may edit anything".
    expect(String(studyInserts[0][0])).toContain("owner_user_id");
    expect(studyInserts[0][1]).toContain("user-author");
    expect(
      operationClient.query.mock.calls.some((call) => call[0] === "BEGIN")
    ).toBe(true);
    expect(
      operationClient.query.mock.calls.some((call) => call[0] === "COMMIT")
    ).toBe(true);
  });

  it("rejects steps that fail integrity rules before touching the database", async () => {
    const studiesRepository = await import("./studies-repository");

    await expect(
      studiesRepository.createStudy({
        title: "Broken",
        intro_text: "Intro",
        consent_text: "Consent",
        steps: [
          baseStep,
          {
            ...baseStep,
            order: 2
          }
        ]
      })
    ).rejects.toThrow(/Duplicate step_id/);

    await expect(
      studiesRepository.createStudy({
        title: "Broken",
        intro_text: "Intro",
        consent_text: "Consent",
        steps: [
          {
            step_id: "step_only",
            order: 1,
            type: "single_choice",
            prompt: "Pick one",
            options: ["Only one"]
          }
        ]
      })
    ).rejects.toThrow(/at least two options/);

    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rolls back when an underlying insert fails", async () => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });
    let stepInsertAttempts = 0;

    operationClient.query.mockImplementation(async (sql: string) => {
      if (sql === "SET search_path TO firsthand") {
        return { rowCount: null, rows: [] };
      }

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }

      if (sql.includes("INSERT INTO studies")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("INSERT INTO study_steps")) {
        stepInsertAttempts += 1;
        throw new Error("duplicate key value violates unique constraint");
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    });

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    const studiesRepository = await import("./studies-repository");

    await expect(
      studiesRepository.createStudy({
        id: "study_abc",
        title: "Sample",
        intro_text: "Intro",
        consent_text: "Consent",
        steps: [baseStep, endStep]
      })
    ).rejects.toThrow(/duplicate key/);

    expect(stepInsertAttempts).toBeGreaterThan(0);
    expect(
      operationClient.query.mock.calls.some((call) => call[0] === "ROLLBACK")
    ).toBe(true);
  });
});

// ─── Ownership ────────────────────────────────────────────────────────────────
//
// The boundary these cover: a second researcher_admin rewriting the consent
// copy and a task step's target_url on somebody else's LAUNCHED study, which
// is then served to employees while screen and microphone recording runs. The
// route-level tests only prove the 403 is relayed; the decision itself is
// taken here, inside the transaction, and this is where it has to be pinned.
describe("countStudyTasks", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    delete (
      globalThis as typeof globalThis & {
        __firsthandRuntimeVerification?: unknown;
      }
    ).__firsthandRuntimeVerification;
    vi.clearAllMocks();
    vi.resetModules();
  });

  const wireClient = (
    handler: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  ) => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });
    operationClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === "SET search_path TO firsthand") {
        return { rowCount: null, rows: [] };
      }
      return handler(sql, params);
    });
    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);
    return operationClient;
  };

  it("returns null when persistence is not configured, rather than a misleading zero", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;

    const studiesRepository = await import("./studies-repository");

    await expect(studiesRepository.countStudyTasks("study_abc")).resolves.toBeNull();
  });

  // The count and the existence check are separate queries on purpose: count(*)
  // over no rows is 0, which would otherwise report "0 tasks" for a study that
  // does not exist at all.
  it("distinguishes a study with no tasks from a study that is not there", async () => {
    wireClient(async (sql) => {
      if (sql.includes("FROM study_steps")) return { rows: [{ task_count: "0" }] };
      if (sql.includes("FROM studies")) return { rows: [] };
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    const studiesRepository = await import("./studies-repository");

    await expect(studiesRepository.countStudyTasks("study_missing")).resolves.toBeNull();
  });

  it("reports zero for a study that exists and has only the end marker", async () => {
    wireClient(async (sql) => {
      if (sql.includes("FROM study_steps")) return { rows: [{ task_count: "0" }] };
      if (sql.includes("FROM studies")) return { rows: [{ one: 1 }] };
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    const studiesRepository = await import("./studies-repository");

    await expect(studiesRepository.countStudyTasks("study_abc")).resolves.toBe(0);
  });

  // pg returns count(*) as a string. Without the Number() the route would ship
  // task_count: "4" and the frontend's `brief.task_count ? ...` would render
  // the string, which happens to look right and is not.
  it("coerces the driver's string count to a number", async () => {
    wireClient(async (sql) => {
      if (sql.includes("FROM study_steps")) return { rows: [{ task_count: "4" }] };
      if (sql.includes("FROM studies")) return { rows: [{ one: 1 }] };
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    const studiesRepository = await import("./studies-repository");

    const result = await studiesRepository.countStudyTasks("study_abc");
    expect(result).toBe(4);
    expect(typeof result).toBe("number");
  });

  // pg is mocked here, so this pins the clause rather than proving the SQL
  // semantics - those were checked against the real database, where a study
  // with two steps plus an end marker reports 2 and one with four reports 4.
  // Without the clause the participant is promised one more task than they get.
  it("excludes the terminal end marker from the count", async () => {
    const client = wireClient(async (sql) => {
      if (sql.includes("FROM study_steps")) return { rows: [{ task_count: "4" }] };
      if (sql.includes("FROM studies")) return { rows: [{ one: 1 }] };
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    const studiesRepository = await import("./studies-repository");
    await studiesRepository.countStudyTasks("study_abc");

    const countSql = client.query.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes("FROM study_steps"));
    expect(countSql).toContain("FILTER (WHERE type <> 'end')");
  });

  // The prompts must never be read by this path: the only public caller is the
  // recorded-study brief, and a handler that never holds them cannot leak them.
  it("selects no prompt or target_url", async () => {
    const client = wireClient(async (sql) => {
      if (sql.includes("FROM study_steps")) return { rows: [{ task_count: "4" }] };
      if (sql.includes("FROM studies")) return { rows: [{ one: 1 }] };
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    const studiesRepository = await import("./studies-repository");
    await studiesRepository.countStudyTasks("study_abc");

    for (const call of client.query.mock.calls) {
      expect(String(call[0])).not.toContain("prompt");
      expect(String(call[0])).not.toContain("target_url");
    }
  });
});

describe("studies repository ownership", () => {
  const owner = { userId: "user-owner", isSuperadmin: false };
  const intruder = { userId: "user-intruder", isSuperadmin: false };
  const superadmin = { userId: "user-super", isSuperadmin: true };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    delete (
      globalThis as typeof globalThis & { __firsthandRuntimeVerification?: unknown }
    ).__firsthandRuntimeVerification;
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("updateStudy", () => {
    it("lets the owner edit their own study", async () => {
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy(
        "study_abc",
        { consent_text: "Updated consent" },
        owner
      );

      expect(result.ok).toBe(true);
      expect(updateStatements(client)).toHaveLength(1);
      expect(committed(client)).toBe(true);
    });

    it("refuses a non-owner and writes nothing", async () => {
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy(
        "study_abc",
        { consent_text: "Attacker consent", steps: [baseStep, endStep] },
        intruder
      );

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      // Not just "the answer was forbidden" - nothing may have reached the
      // table, including the DELETE that replaces the step rows.
      expect(updateStatements(client)).toHaveLength(0);
      expect(
        client.query.mock.calls.filter((call) =>
          /DELETE FROM|INSERT INTO/.test(String(call[0]))
        )
      ).toHaveLength(0);
      expect(rolledBack(client)).toBe(true);
      expect(committed(client)).toBe(false);
    });

    it("lets a superadmin edit a study they do not own", async () => {
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy(
        "study_abc",
        { title: "Renamed by superadmin" },
        superadmin
      );

      expect(result.ok).toBe(true);
      expect(updateStatements(client)).toHaveLength(1);
    });

    it("does not re-stamp the owner on an owned study", async () => {
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      // A superadmin edit must not quietly transfer the study to the
      // superadmin - the owner would lose their own study to a routine fix.
      await studiesRepository.updateStudy("study_abc", { title: "Renamed" }, superadmin);

      expect(String(updateStatements(client)[0][0])).not.toContain("owner_user_id");
    });

    it("claims an unowned legacy study for the editing admin", async () => {
      const client = arrangeOwnedStudy(null);
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy(
        "study_abc",
        { title: "Tidied up" },
        intruder
      );

      // Fail-open on read, closed on write: a legacy row stays editable (it is
      // otherwise unmanageable by the people who authored it), and this edit
      // is the last one any non-owner gets.
      expect(result.ok).toBe(true);
      expect(result.ok && result.claimed).toBe(true);
      expectAssignedOwner(updateStatements(client)[0], "user-intruder");
    });

    it("does not claim when the request changes nothing", async () => {
      // Every field in updateStudyRequestSchema is optional, so `PUT {}`
      // parses. Claiming on that would let one admin walk the study list -
      // which now carries every study's id and owner - and take every unowned
      // study without editing a thing.
      const client = arrangeOwnedStudy(null);
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy("study_abc", {}, intruder);

      expect(result.ok).toBe(true);
      expect(result.ok && result.claimed).toBe(false);
      expect(updateStatements(client)).toHaveLength(0);
    });

    it("does not let a superadmin claim an unowned study by editing it", async () => {
      // A superadmin can already write every study, so claiming buys them no
      // access - it would only take a legacy study away from the researcher
      // who wrote it, the moment a superadmin fixed a typo on it.
      const client = arrangeOwnedStudy(null);
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy(
        "study_abc",
        { title: "Superadmin tidy-up" },
        superadmin
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.claimed).toBe(false);
      expect(String(updateStatements(client)[0][0])).not.toContain("owner_user_id");
    });

    it("lets a superadmin reassign the owner explicitly", async () => {
      // The only way to correct an owner - notably one migration 0007 inferred
      // from whichever opportunity happened to be created first. There is no
      // database console to do it by hand.
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy(
        "study_abc",
        { owner_user_id: "user-rightful" },
        superadmin
      );

      expect(result.ok).toBe(true);
      expectAssignedOwner(updateStatements(client)[0], "user-rightful");
    });

    it("refuses a reassignment from a researcher admin, even on their own study", async () => {
      const client = arrangeOwnedStudy("user-intruder");
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy(
        "study_abc",
        { owner_user_id: "user-someone-else" },
        intruder
      );

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect(updateStatements(client)).toHaveLength(0);
    });

    it("prefers an explicit reassignment over the automatic claim", async () => {
      const client = arrangeOwnedStudy(null);
      const studiesRepository = await import("./studies-repository");

      await studiesRepository.updateStudy(
        "study_abc",
        { title: "Handed to its author", owner_user_id: "user-rightful" },
        superadmin
      );

      expectAssignedOwner(updateStatements(client)[0], "user-rightful");
    });

    it("claims an unowned study even when only its steps change", async () => {
      // The steps-only branch skips the field UPDATE entirely, so the claim
      // has to ride the same path rather than the field loop.
      const client = arrangeOwnedStudy(null);
      const studiesRepository = await import("./studies-repository");

      await studiesRepository.updateStudy(
        "study_abc",
        { steps: [baseStep, endStep] },
        intruder
      );

      const owning = updateStatements(client).filter((call) =>
        String(call[0]).includes("owner_user_id")
      );
      expect(owning).toHaveLength(1);
      expect(owning[0][1]).toContain("user-intruder");
    });

    it("reports a missing study as not_found, not forbidden", async () => {
      const client = arrangeMissingStudy();
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.updateStudy(
        "study_missing",
        { title: "Ghost" },
        intruder
      );

      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(updateStatements(client)).toHaveLength(0);
    });

    it("takes the owner row lock inside the transaction", async () => {
      // Without FOR UPDATE two concurrent editors of an unowned study both
      // read NULL and both claim it, and the loser's authorisation decision
      // was taken against an owner that no longer holds.
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      await studiesRepository.updateStudy("study_abc", { title: "Renamed" }, owner);

      const ownerSelectIndex = client.query.mock.calls.findIndex((call) =>
        String(call[0]).includes("FOR UPDATE")
      );
      const beginIndex = client.query.mock.calls.findIndex((call) => call[0] === "BEGIN");
      expect(ownerSelectIndex).toBeGreaterThan(beginIndex);
    });
  });

  describe("deleteStudy", () => {
    it("lets the owner delete their own study", async () => {
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.deleteStudy("study_abc", owner);

      expect(result).toEqual({ ok: true });
      expect(deleteStudyStatements(client)).toHaveLength(1);
      expect(committed(client)).toBe(true);
    });

    it("refuses a non-owner and deletes nothing", async () => {
      // The other half of the attack: deleting a study out from under a
      // published opportunity that references it.
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      const result = await studiesRepository.deleteStudy("study_abc", intruder);

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect(deleteStudyStatements(client)).toHaveLength(0);
      expect(rolledBack(client)).toBe(true);
    });

    it("lets a superadmin delete a study they do not own", async () => {
      const client = arrangeOwnedStudy("user-owner");
      const studiesRepository = await import("./studies-repository");

      await expect(
        studiesRepository.deleteStudy("study_abc", superadmin)
      ).resolves.toEqual({ ok: true });
      expect(deleteStudyStatements(client)).toHaveLength(1);
    });

    it("still deletes an unowned legacy study, since a delete cannot claim it", async () => {
      const client = arrangeOwnedStudy(null);
      const studiesRepository = await import("./studies-repository");

      await expect(
        studiesRepository.deleteStudy("study_abc", intruder)
      ).resolves.toEqual({ ok: true });
      expect(deleteStudyStatements(client)).toHaveLength(1);
    });

    it("reports a missing study as not_found", async () => {
      const client = arrangeMissingStudy();
      const studiesRepository = await import("./studies-repository");

      await expect(
        studiesRepository.deleteStudy("study_missing", owner)
      ).resolves.toEqual({ ok: false, reason: "not_found" });
      expect(deleteStudyStatements(client)).toHaveLength(0);
    });
  });

  describe("claimStudyIfUnowned", () => {
    it("claims an unowned study in one conditional statement", async () => {
      // The guard lives in the WHERE clause rather than in a read-then-write,
      // so two admins linking the same study cannot both claim it and no row
      // lock is needed.
      const client = arrangeOwnedStudy(null);
      const studiesRepository = await import("./studies-repository");

      await expect(
        studiesRepository.claimStudyIfUnowned("study_abc", "user-linker")
      ).resolves.toBe(true);

      const statements = updateStatements(client);
      expect(statements).toHaveLength(1);
      expect(String(statements[0][0])).toContain("owner_user_id IS NULL");
      expectAssignedOwner(statements[0], "user-linker");
    });

    it("reports false when the study already has an owner", async () => {
      // rowCount 0 is what a study someone already owns produces, and the
      // caller only logs the transfer when this says it happened.
      const client = arrangeOwnedStudy("user-owner");
      client.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith("UPDATE studies")) return { rowCount: 0, rows: [] };
        return { rowCount: null, rows: [] };
      });
      const studiesRepository = await import("./studies-repository");

      await expect(
        studiesRepository.claimStudyIfUnowned("study_abc", "user-linker")
      ).resolves.toBe(false);
    });
  });

  describe("deleteStudyUnchecked", () => {
    it("deletes without consulting the owner at all", async () => {
      // The compensating rollback in the opportunity handlers removes a study
      // it created moments earlier. An ownership check there could strand a
      // launched study no opportunity references.
      const client = arrangeOwnedStudy("user-someone-else");
      const studiesRepository = await import("./studies-repository");

      await expect(studiesRepository.deleteStudyUnchecked("study_abc")).resolves.toBe(
        true
      );
      expect(deleteStudyStatements(client)).toHaveLength(1);
      expect(
        client.query.mock.calls.filter((call) => String(call[0]).includes("FOR UPDATE"))
      ).toHaveLength(0);
    });
  });

  // ── Arrangement helpers ────────────────────────────────────────────────────

  /**
   * Script a runtime client for one study row. `ownerUserId` is what the
   * `FOR UPDATE` owner probe returns; null models a row created before
   * migration 0007.
   */
  function arrangeOwnedStudy(ownerUserId: string | null) {
    return arrangeClient({ ownerRows: [{ owner_user_id: ownerUserId }] });
  }

  /**
   * A study id that is not in the table. The reload branch returns nothing
   * either, so the mock stays a consistent model of the real database rather
   * than one that has no owner row but a full study row.
   */
  function arrangeMissingStudy() {
    return arrangeClient({ ownerRows: [], studyExists: false });
  }

  function arrangeClient(input: {
    ownerRows: { owner_user_id: string | null }[];
    studyExists?: boolean;
  }) {
    const studyExists = input.studyExists ?? true;
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });

    operationClient.query.mockImplementation(async (sql: string) => {
      if (sql === "SET search_path TO firsthand") return { rowCount: null, rows: [] };
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }

      // Checked before the generic `FROM studies` branch: the owner probe
      // selects from the same table.
      if (sql.includes("FOR UPDATE")) {
        return { rowCount: input.ownerRows.length, rows: input.ownerRows };
      }

      if (sql.startsWith("DELETE FROM studies") || sql.startsWith("UPDATE studies")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("DELETE FROM study_steps") || sql.includes("INSERT INTO study_steps")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM studies")) {
        if (!studyExists) {
          return { rowCount: 0, rows: [] };
        }

        return {
          rowCount: 1,
          rows: [
            {
              id: "study_abc",
              title: "Sample",
              intro_text: "Intro",
              consent_text: "Consent",
              brand_name: null,
              estimated_duration_minutes: null,
              locale: null,
              status: "launched",
              owner_user_id: input.ownerRows[0]?.owner_user_id ?? null,
              created_at: "2026-06-08T00:00:00.000Z",
              updated_at: "2026-06-08T00:00:00.000Z"
            }
          ]
        };
      }

      if (sql.includes("FROM study_steps")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "study_abc_step_001",
              study_id: "study_abc",
              step_order: 1,
              type: "end",
              prompt: "Thanks for taking part.",
              target_url: null,
              helper_text: null,
              is_required: false,
              options: null
            }
          ]
        };
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    });

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    return operationClient;
  }

  // ── Assertion helpers ──────────────────────────────────────────────────────

  function updateStatements(client: MockClient) {
    return client.query.mock.calls.filter((call) =>
      String(call[0]).startsWith("UPDATE studies")
    );
  }

  /**
   * Assert the owner a statement actually writes, by reading the placeholder
   * index out of `owner_user_id = $N` and indexing the parameters with it.
   * A bare `toContain` would pass on a claim written into the wrong slot -
   * which is a study with someone else's id in its title, not an owner.
   */
  function expectAssignedOwner(call: unknown[], expected: string) {
    const sql = String(call[0]);
    const placeholder = /owner_user_id = \$(\d+)/.exec(sql);

    expect(placeholder).not.toBeNull();
    expect((call[1] as unknown[])[Number(placeholder![1]) - 1]).toBe(expected);
  }

  function deleteStudyStatements(client: MockClient) {
    return client.query.mock.calls.filter((call) =>
      String(call[0]).startsWith("DELETE FROM studies")
    );
  }

  function committed(client: MockClient) {
    return client.query.mock.calls.some((call) => call[0] === "COMMIT");
  }

  function rolledBack(client: MockClient) {
    return client.query.mock.calls.some((call) => call[0] === "ROLLBACK");
  }
});

function createMockClient(input: { missingRelations: string[] }): MockClient {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "SET search_path TO firsthand") {
      return {
        rowCount: null,
        rows: []
      };
    }

    if (sql.includes("SELECT relation_path, to_regclass(relation_path) AS regclass")) {
      const relationPaths = (params?.[0] as string[]) ?? [];

      return {
        rowCount: relationPaths.length,
        rows: relationPaths.map((relationPath) => ({
          relation_path: relationPath,
          regclass: input.missingRelations.includes(relationPath) ? null : relationPath
        }))
      };
    }

    throw new Error(`Unexpected query in test: ${sql}`);
  });

  return {
    query,
    release: vi.fn()
  };
}

/**
 * The repository is the third boundary that enforces step shape, after the
 * runtime contract and the authoring schema. It had its own hand-written copy
 * of the single_choice rule, which is why the rules now come from
 * findStepShapeProblem and only the wording is local.
 *
 * `config` carries the per-type question settings for the native survey types:
 * the rating scale and its end labels, and the multi-choice selection range. It
 * is a separate JSONB column rather than a widening of `options`, which is read
 * as string[] here and by every existing caller.
 */
describe("survey question storage", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    delete (
      globalThis as typeof globalThis & {
        __firsthandRuntimeVerification?: unknown;
      }
    ).__firsthandRuntimeVerification;
    vi.clearAllMocks();
    vi.resetModules();
  });

  const createWithStep = async (step: Record<string, unknown>) => {
    const studiesRepository = await import("./studies-repository");

    return studiesRepository.createStudy({
      title: "Survey",
      intro_text: "Intro",
      consent_text: "Consent",
      steps: [step as never]
    });
  };

  it("rejects a rating step with no scale", async () => {
    await expect(
      createWithStep({
        step_id: "step_001",
        order: 1,
        type: "rating",
        prompt: "How easy was that?"
      })
    ).rejects.toThrow(/scale/i);

    // Rejected before a client is taken from the pool, like every other shape
    // rule here, so a malformed study never opens a transaction.
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rejects a rating step whose scale is out of range", async () => {
    await expect(
      createWithStep({
        step_id: "step_001",
        order: 1,
        type: "rating",
        prompt: "How easy was that?",
        config: { scale_max: 11 }
      })
    ).rejects.toThrow(/scale/i);
  });

  it("rejects an nps step carrying options", async () => {
    await expect(
      createWithStep({
        step_id: "step_001",
        order: 1,
        type: "nps",
        prompt: "How likely are you to recommend us?",
        options: ["Yes", "No"]
      })
    ).rejects.toThrow(/options/i);
  });

  it("rejects a multi_choice step with one option", async () => {
    await expect(
      createWithStep({
        step_id: "step_001",
        order: 1,
        type: "multi_choice",
        prompt: "Which do you use?",
        options: ["Only one"]
      })
    ).rejects.toThrow(/at least two options/);
  });

  // The existing rule has to keep biting with the same wording: a route test
  // asserts on it, and single_choice now shares the multi_choice code path.
  it("still rejects a single_choice step with one option", async () => {
    await expect(
      createWithStep({
        step_id: "step_001",
        order: 1,
        type: "single_choice",
        prompt: "Pick one",
        options: ["Only one"]
      })
    ).rejects.toThrow(/at least two options/);
  });

  const wireRoundTrip = (storedConfig: unknown) => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });
    const stepInserts: unknown[][] = [];
    const stepSelects: string[] = [];

    operationClient.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql === "SET search_path TO firsthand") {
          return { rowCount: null, rows: [] };
        }

        if (sql === "BEGIN" || sql === "COMMIT") {
          return { rowCount: null, rows: [] };
        }

        if (sql.includes("INSERT INTO study_steps")) {
          stepInserts.push(params ?? []);
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes("INSERT INTO studies")) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes("FROM studies")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "study_abc",
                title: "Survey",
                intro_text: "Intro",
                consent_text: "Consent",
                brand_name: null,
                estimated_duration_minutes: null,
                locale: null,
                status: "draft",
                created_at: "2026-08-16T00:00:00.000Z",
                updated_at: "2026-08-16T00:00:00.000Z"
              }
            ]
          };
        }

        if (sql.includes("FROM study_steps")) {
          stepSelects.push(sql);

          return {
            rowCount: 1,
            rows: [
              {
                id: "step_001",
                study_id: "study_abc",
                step_order: 1,
                type: "rating",
                prompt: "How easy was that?",
                target_url: null,
                helper_text: null,
                is_required: true,
                options: null,
                config: storedConfig
              }
            ]
          };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }
    );

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    return { stepInserts, stepSelects };
  };

  it("writes config into the insert and reads it back out", async () => {
    const config = { scale_max: 5, min_label: "Very hard", max_label: "Very easy" };
    const { stepInserts, stepSelects } = wireRoundTrip(config);

    const created = await createWithStep({
      step_id: "step_001",
      order: 1,
      type: "rating",
      prompt: "How easy was that?",
      is_required: true,
      config
    });

    // Serialised like `options` is: node-postgres will not infer JSONB from a
    // plain object parameter.
    expect(stepInserts[0]).toContain(JSON.stringify(config));
    expect(created.steps[0].config).toEqual(config);

    // The column has to be in the SELECT, not merely in the row type.
    //
    // Added because a mutation that dropped `config` from the select list
    // survived the round-trip assertions above: the mock returns its row
    // whatever is asked for, so nothing here noticed. In production that
    // mutation returns undefined config for every step, and every rating
    // question renders with no scale.
    expect(stepSelects).not.toHaveLength(0);
    stepSelects.forEach((sql) => expect(sql).toMatch(/\bconfig\b/));
  });

  it("writes null when the step has no config", async () => {
    const { stepInserts } = wireRoundTrip(null);

    await createWithStep({
      step_id: "step_001",
      order: 1,
      type: "open_text",
      prompt: "What did you think?",
      is_required: true
    });

    // Last parameter is config, and it must be null rather than undefined:
    // node-postgres sends undefined as NULL but the column list has to line up
    // with the placeholder count either way.
    expect(stepInserts[0][stepInserts[0].length - 1]).toBeNull();
  });
});

/**
 * A study's authoring vocabulary.
 *
 * `kind` decides which set of question types may be authored into a study, and
 * which runner a participant gets. It is stored rather than derived from the
 * step types present, because an instruction-only study is ambiguous between
 * the two vocabularies and because deriving it would let a step edit silently
 * reclassify a study an opportunity is already linked to.
 */
describe("studies repository - study kind", () => {
  beforeEach(() => {
    process.env.DATABASE_URL =
      "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    delete (
      globalThis as typeof globalThis & {
        __firsthandRuntimeVerification?: unknown;
      }
    ).__firsthandRuntimeVerification;
    vi.clearAllMocks();
    vi.resetModules();
  });

  const wireStudy = (storedKind: string) => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });
    const studyInserts: Array<{ sql: string; params: unknown[] }> = [];
    const studySelects: string[] = [];

    operationClient.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql === "SET search_path TO firsthand") {
          return { rowCount: null, rows: [] };
        }

        if (sql === "BEGIN" || sql === "COMMIT") {
          return { rowCount: null, rows: [] };
        }

        if (sql.includes("INSERT INTO studies")) {
          studyInserts.push({ sql, params: params ?? [] });
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes("INSERT INTO study_steps")) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes("FROM studies")) {
          studySelects.push(sql);

          return {
            rowCount: 1,
            rows: [
              {
                id: "study_abc",
                title: "Pulse",
                intro_text: "Intro",
                consent_text: "Consent",
                brand_name: null,
                estimated_duration_minutes: null,
                locale: null,
                status: "draft",
                kind: storedKind,
                owner_user_id: null,
                created_at: "2026-08-17T00:00:00.000Z",
                updated_at: "2026-08-17T00:00:00.000Z"
              }
            ]
          };
        }

        if (sql.includes("FROM study_steps")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "study_abc_step_1",
                study_id: "study_abc",
                step_order: 1,
                type: "nps",
                prompt: "Would you recommend it?",
                target_url: null,
                helper_text: null,
                is_required: true,
                options: null,
                config: null
              }
            ]
          };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }
    );

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    return { studyInserts, studySelects };
  };

  const create = async (kind?: "recorded" | "survey") => {
    const studiesRepository = await import("./studies-repository");

    return studiesRepository.createStudy({
      id: "study_abc",
      title: "Pulse",
      intro_text: "Intro",
      consent_text: "Consent",
      ...(kind ? { kind } : {}),
      steps: [
        {
          step_id: "study_abc_step_1",
          order: 1,
          type: "nps",
          prompt: "Would you recommend it?"
        }
      ]
    });
  };

  it("stores the kind it was given", async () => {
    const { studyInserts } = wireStudy("survey");

    await create("survey");

    expect(studyInserts[0].sql).toContain("kind");
    expect(studyInserts[0].params).toContain("survey");
  });

  /**
   * Every caller that predates the survey vocabulary - the inline task-list
   * path, the hand-authored editor, fixtures - passes no kind, and every one of
   * them means a recorded task list. Defaulting anywhere else would put survey
   * question types into the recorded runner, which renders no widget for them.
   */
  it("defaults to a recorded task list when no kind is given", async () => {
    const { studyInserts } = wireStudy("recorded");

    await create();

    expect(studyInserts[0].params).toContain("recorded");
    expect(studyInserts[0].params).not.toContain("survey");
  });

  it("reports the stored kind on the record", async () => {
    wireStudy("survey");

    const result = await create("survey");

    expect(result.study.kind).toBe("survey");
  });

  it("reads kind back out of the table rather than echoing the input", async () => {
    const { studySelects } = wireStudy("survey");

    await create("survey");

    expect(studySelects.length).toBeGreaterThan(0);
    studySelects.forEach((sql) => expect(sql).toMatch(/\bkind\b/));
  });

  /**
   * The picker filters on this, so a list that omits it cannot tell a survey
   * from a recorded task list without loading every study's steps.
   */
  it("selects kind when listing studies", async () => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });
    const selects: string[] = [];

    operationClient.query.mockImplementation(async (sql: string) => {
      if (sql === "SET search_path TO firsthand") {
        return { rowCount: null, rows: [] };
      }

      selects.push(sql);
      return { rowCount: 0, rows: [] };
    });

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    const studiesRepository = await import("./studies-repository");
    await studiesRepository.listStudies();

    expect(selects.some((sql) => /\bkind\b/.test(sql))).toBe(true);
  });

  /**
   * The column carries a CHECK constraint, so an unrecognised value should be
   * unreachable. Normalising anyway costs one comparison and means a row that
   * somehow holds one is treated as the conservative vocabulary rather than
   * offering survey widgets in a recorded runner.
   */
  it("treats an unrecognised stored kind as recorded", async () => {
    wireStudy("something_else");

    const result = await create("survey");

    expect(result.study.kind).toBe("recorded");
  });
});

/**
 * Replacing a study's steps must respect the vocabulary the study already
 * declares.
 *
 * `createStudyRequestSchema` can check this from the payload because the kind
 * is in it. An update payload carries no kind - the vocabulary is fixed at
 * create - so the only place that knows it is the transaction that has just
 * locked the row. Without this, `PUT` was the way round the create-time rule.
 */
describe("studies repository - update respects the stored vocabulary", () => {
  beforeEach(() => {
    process.env.DATABASE_URL =
      "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    delete (
      globalThis as typeof globalThis & {
        __firsthandRuntimeVerification?: unknown;
      }
    ).__firsthandRuntimeVerification;
    vi.clearAllMocks();
    vi.resetModules();
  });

  const wireStored = (storedKind: string) => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });
    const stepInserts: unknown[][] = [];

    operationClient.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql === "SET search_path TO firsthand") {
          return { rowCount: null, rows: [] };
        }

        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rowCount: null, rows: [] };
        }

        if (sql.includes("FOR UPDATE")) {
          return {
            rowCount: 1,
            rows: [{ owner_user_id: "user-author", kind: storedKind }]
          };
        }

        if (sql.includes("INSERT INTO study_steps")) {
          stepInserts.push(params ?? []);
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes("FROM studies")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "study_abc",
                title: "Pulse",
                intro_text: "Intro",
                consent_text: "Consent",
                brand_name: null,
                estimated_duration_minutes: null,
                locale: null,
                status: "draft",
                kind: storedKind,
                owner_user_id: "user-author",
                created_at: "2026-08-17T00:00:00.000Z",
                updated_at: "2026-08-17T00:00:00.000Z"
              }
            ]
          };
        }

        return { rowCount: 0, rows: [] };
      }
    );

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    return { stepInserts };
  };

  const npsStep = {
    step_id: "study_abc_step_1",
    order: 1,
    type: "nps" as const,
    prompt: "Would you recommend it?"
  };

  const requester = { userId: "user-author", isSuperadmin: false };

  it("refuses survey question types on a recorded study", async () => {
    const { stepInserts } = wireStored("recorded");
    const studiesRepository = await import("./studies-repository");

    await expect(
      studiesRepository.updateStudy(
        "study_abc",
        { steps: [npsStep] },
        requester
      )
    ).rejects.toThrow(/not available in this kind of study/i);

    // The refusal has to come before anything is written, not after.
    expect(stepInserts).toHaveLength(0);
  });

  it("accepts survey question types on a survey study", async () => {
    wireStored("survey");
    const studiesRepository = await import("./studies-repository");

    const result = await studiesRepository.updateStudy(
      "study_abc",
      { steps: [npsStep] },
      requester
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a target_url on a survey study's steps", async () => {
    wireStored("survey");
    const studiesRepository = await import("./studies-repository");

    await expect(
      studiesRepository.updateStudy(
        "study_abc",
        { steps: [{ ...npsStep, target_url: "https://example.com/x" }] },
        requester
      )
    ).rejects.toThrow(/no page to open/i);
  });
});
