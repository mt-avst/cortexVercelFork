import { describe, expect, it } from "vitest";

// H10 backend smoke-import: the ported unit tests mock `pg`/`server-only`, so
// they are blind to a real backend load. This suite imports the whole ported
// firsthand domain/storage tree in plain Node — no mocks — to prove:
//   1. nothing pulls `import "server-only"` (which throws outside Next.js),
//   2. nothing pulls `@vercel/blob` or the filesystem-legacy path (excised),
//   3. importing does not eagerly open a pg pool or an S3 client (lazy init),
// all with NO firsthand env configured. If any module leaked a server-only or
// vercel import, or initialised a client at module scope, importing would throw
// and this suite would fail.
describe("firsthand domain layer backend smoke-import", () => {
  it("loads the repository facade and its transitive tree without env or mocks", async () => {
    const repo = await import("./runtime-repository");
    expect(typeof repo.seedRuntimeSession).toBe("function");
    expect(typeof repo.getRuntimeSession).toBe("function");
    expect(typeof repo.saveUploadedRecordingAsset).toBe("function");
    expect(typeof repo.processDueCallbackDeliveries).toBe("function");
  });

  it("loads the postgres repository, studies repository and database modules", async () => {
    const pg = await import("./runtime-repository-postgres");
    expect(typeof pg.seedRuntimeSessionPostgres).toBe("function");

    const studies = await import("./studies-repository");
    expect(studies).toBeTypeOf("object");

    const db = await import("./runtime-database");
    // Runs the resolver without constructing a pool (lazy init proof).
    expect(typeof db.isPostgresRuntimeConfigured()).toBe("boolean");
  });

  it("loads the S3-only object storage layer without constructing a client", async () => {
    const objectStorage = await import("./object-storage");
    expect(typeof objectStorage.storeRecordingObject).toBe("function");
    expect(typeof objectStorage.deleteStoredObject).toBe("function");

    const s3 = await import("./runtime-object-storage-s3");
    expect(typeof s3.createPresignedRecordingUploadUrl).toBe("function");
  });

  it("loads session-outputs, integration-auth and the record/model modules", async () => {
    const outputs = await import("./session-outputs");
    expect(typeof outputs.buildSessionOutputs).toBe("function");

    const auth = await import("./integration-auth");
    expect(auth).toBeTypeOf("object");

    await import("./runtime-records");
    await import("./runtime-session-model");
    await import("./state-model");
    await import("./transcript-generator");
    await import("./callback-delivery");
  });
});
