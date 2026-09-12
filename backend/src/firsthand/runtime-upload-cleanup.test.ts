import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE CONNECTION MUST BE BACK BEFORE THE S3 CALLS START.
 *
 * The stale-upload reaper commits its transaction and then deletes up to ten
 * objects from S3. Those deletes used to run INSIDE the
 * `withRuntimeDatabaseClient` callback, so the job held a runtime connection
 * across pure network latency with nothing left to do on it.
 *
 * Merely wasteful before the admission cap; not any more. This job is
 * unclassified, therefore admin, therefore capped at two - and
 * `runFirstHandMaintenance` starts both its jobs under `Promise.all`, so at
 * 03:00 the whole admin budget could sit idle on S3 while an author waited out
 * their admission timeout and got a 503.
 *
 * Asserted by ORDERING, because nothing about the return value changes. Both
 * spellings delete the same objects and report the same counts, so a test on
 * the result cannot tell them apart - which is why there was no test at all.
 */

const events: string[] = [];

const client = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM pending_recording_uploads AS pending")) {
      return {
        rows: [
          {
            id: "pending_1",
            session_id: "s1",
            token: "t1",
            file_name: "a.webm",
            mime_type: "video/webm",
            storage_provider: "s3",
            relative_path: "sessions/s1/a.webm",
            created_at: new Date(),
            valid_until: new Date()
          },
          {
            id: "pending_2",
            session_id: "s2",
            token: "t2",
            file_name: "b.webm",
            mime_type: "video/webm",
            storage_provider: "s3",
            relative_path: "sessions/s2/b.webm",
            created_at: new Date(),
            valid_until: new Date()
          }
        ]
      };
    }
    return { rows: [] };
  })
};

vi.mock("./runtime-database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-database")>()),
  isPostgresRuntimeConfigured: () => true,
  withRuntimeDatabaseClient: async (
    run: (c: unknown) => Promise<unknown>
  ) => {
    events.push("checkout:start");
    try {
      return await run(client);
    } finally {
      // Where `client.release()` and the admission release happen in the real
      // seam. Everything after this point costs the pool nothing.
      events.push("checkout:end");
    }
  }
}));

vi.mock("./object-storage", () => ({
  deleteStoredObject: vi.fn(async (input: { relativePath: string }) => {
    events.push(`s3:${input.relativePath}`);
  })
}));

vi.mock("../utils/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { processPendingRecordingUploadCleanup } from "./runtime-repository-postgres";

describe("the stale-upload reaper", () => {
  beforeEach(() => {
    events.length = 0;
    client.query.mockClear();
  });

  it("returns the connection before it starts talking to S3", async () => {
    const result = await processPendingRecordingUploadCleanup(10);

    expect(result).toMatchObject({ idle: false, processedCount: 2, deletedCount: 2 });

    // Every S3 call after the checkout ended, not merely after the COMMIT.
    const checkoutEnded = events.indexOf("checkout:end");
    const firstS3 = events.findIndex((event) => event.startsWith("s3:"));

    expect(checkoutEnded).toBeGreaterThanOrEqual(0);
    expect(firstS3).toBeGreaterThan(checkoutEnded);
    expect(events.filter((event) => event.startsWith("s3:"))).toEqual([
      "s3:sessions/s1/a.webm",
      "s3:sessions/s2/b.webm"
    ]);
  });

  it("takes exactly one checkout, however many objects it deletes", async () => {
    await processPendingRecordingUploadCleanup(10);

    expect(events.filter((event) => event === "checkout:start")).toHaveLength(1);
  });

  it("deletes the rows before the objects, never the other way round", async () => {
    await processPendingRecordingUploadCleanup(10);

    // The safe order. An S3 delete that fails leaves an orphaned object and no
    // row, which costs storage; the other order risks destroying a live
    // participant's recording while keeping the row that says it exists.
    const deletedRows = client.query.mock.calls.findIndex((call) =>
      String(call[0]).includes("DELETE FROM pending_recording_uploads")
    );
    expect(deletedRows).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("checkout:end")).toBeLessThan(
      events.findIndex((event) => event.startsWith("s3:"))
    );
  });
});
