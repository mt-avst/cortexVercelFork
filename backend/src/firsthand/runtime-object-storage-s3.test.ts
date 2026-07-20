import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const execFileAsync = promisify(execFile);

/**
 * These tests run against a REAL object store (MinIO in docker), not SDK
 * mocks. The suite's @vercel/blob mocks are exactly why the client-upload
 * path's dead server branch went unnoticed - do not mock storage here.
 * Opt out only explicitly, via FIRSTHAND_SKIP_S3_TESTS=1.
 */
const skipS3Tests = process.env.FIRSTHAND_SKIP_S3_TESTS === "1";

const TEST_BUCKET = "firsthand-s3-test";
const MINIO_USER = "firsthand-test";
const MINIO_PASSWORD = "firsthand-test-secret";

const containerName = `firsthand-minio-vitest-${process.pid}`;
let minioEndpoint: string;

async function startMinioContainer(): Promise<string> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
  } catch {
    throw new Error(
      "Docker is required for the S3 integration tests (they run against a real MinIO). " +
        "Start Docker, or set FIRSTHAND_SKIP_S3_TESTS=1 to opt out explicitly."
    );
  }

  await execFileAsync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-e",
    `MINIO_ROOT_USER=${MINIO_USER}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${MINIO_PASSWORD}`,
    "-p",
    "127.0.0.1:0:9000",
    "minio/minio:latest",
    "server",
    "/data"
  ]);

  const { stdout } = await execFileAsync("docker", [
    "port",
    containerName,
    "9000"
  ]);
  const mappedPort = stdout.trim().split("\n")[0]?.split(":").pop();

  if (!mappedPort) {
    throw new Error(`Could not determine the mapped MinIO port: ${stdout}`);
  }

  const endpoint = `http://127.0.0.1:${mappedPort}`;
  const deadline = Date.now() + 30_000;

  while (true) {
    try {
      const health = await fetch(`${endpoint}/minio/health/ready`);

      if (health.ok) {
        return endpoint;
      }
    } catch {
      // Not up yet.
    }

    if (Date.now() > deadline) {
      throw new Error("MinIO did not become ready within 30s.");
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function stopMinioContainer() {
  await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});
}

function buildStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

describe.skipIf(skipS3Tests)("runtime object storage: s3 (MinIO)", () => {
  beforeAll(async () => {
    minioEndpoint = await startMinioContainer();

    process.env.AWS_ACCESS_KEY_ID = MINIO_USER;
    process.env.AWS_SECRET_ACCESS_KEY = MINIO_PASSWORD;

    const client = new S3Client({
      region: "us-east-1",
      endpoint: minioEndpoint,
      forcePathStyle: true
    });
    await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
    client.destroy();
  }, 90_000);

  afterAll(async () => {
    await stopMinioContainer();
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.FIRSTHAND_S3_BUCKET;
    delete process.env.FIRSTHAND_S3_REGION;
    delete process.env.FIRSTHAND_S3_ENDPOINT;
    delete process.env.FIRSTHAND_S3_FORCE_PATH_STYLE;
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });

  beforeEach(() => {
    process.env.FIRSTHAND_S3_BUCKET = TEST_BUCKET;
    process.env.FIRSTHAND_S3_REGION = "us-east-1";
    process.env.FIRSTHAND_S3_ENDPOINT = minioEndpoint;
    process.env.FIRSTHAND_S3_FORCE_PATH_STYLE = "1";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.FIRSTHAND_STORAGE_MODE;
  });

  it("round-trips a recording: streaming put, streaming get, loud delete", async () => {
    const objectStorage = await import("./object-storage");

    // The multi-backend storage-mode selector is excised in the S3-only merge
    // (filesystem/vercel_blob dropped), so writes always target S3 — there is no
    // longer a getObjectStorageMode() to assert.

    // 6MB spans the 5MB part-size threshold, so multipart upload is exercised.
    const chunk = new Uint8Array(1024 * 1024).fill(0xab);
    const chunks = Array.from({ length: 6 }, (_, index) => {
      const copy = new Uint8Array(chunk);
      copy[0] = index;
      return copy;
    });
    const expectedBytes = new Uint8Array(6 * 1024 * 1024);
    chunks.forEach((part, index) => expectedBytes.set(part, index * part.length));

    const stored = await objectStorage.storeRecordingObject({
      fileName: "Screen Capture (1).webm",
      mimeType: "video/webm;codecs=vp9",
      sessionId: "session_demo_001",
      stream: buildStream(chunks)
    });

    expect(stored.storageProvider).toBe("s3");
    expect(stored.relativePath).toMatch(/^recordings\/session_demo_001\//);
    expect(stored.fileSizeBytes).toBe(expectedBytes.byteLength);
    expect(stored.mimeType).toBe("video/webm");
    expect(stored.objectUrl).toBeUndefined();

    const response = await objectStorage.createRecordingAssetResponse({
      id: "asset_s3_1",
      sessionId: "session_demo_001",
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      fileSizeBytes: stored.fileSizeBytes,
      durationSeconds: null,
      storageProvider: "s3",
      relativePath: stored.relativePath,
      uploadedAt: new Date().toISOString()
    });

    expect(response.headers.get("Content-Type")).toBe("video/webm");
    expect(response.headers.get("Content-Length")).toBe(
      String(expectedBytes.byteLength)
    );
    expect(await readResponseBytes(response)).toEqual(expectedBytes);

    await objectStorage.deleteStoredObject({
      relativePath: stored.relativePath,
      storageProvider: "s3"
    });

    await expect(
      objectStorage.createRecordingAssetResponse({
        id: "asset_s3_1",
        sessionId: "session_demo_001",
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        fileSizeBytes: stored.fileSizeBytes,
        durationSeconds: null,
        storageProvider: "s3",
        relativePath: stored.relativePath,
        uploadedAt: new Date().toISOString()
      })
    ).rejects.toThrow();
  }, 60_000);

  it("serves byte ranges of a recording for seek and resume", async () => {
    const objectStorage = await import("./object-storage");

    // A recognisable byte pattern so a sliced read proves offset correctness,
    // not just length.
    const allBytes = new Uint8Array(64 * 1024);
    allBytes.forEach((_, index) => {
      allBytes[index] = index % 251;
    });

    const stored = await objectStorage.storeRecordingObject({
      fileName: "seekable.webm",
      mimeType: "video/webm",
      sessionId: "session_demo_range",
      stream: buildStream([allBytes])
    });

    const asset = {
      id: "asset_s3_range",
      sessionId: "session_demo_range",
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      fileSizeBytes: stored.fileSizeBytes,
      durationSeconds: null,
      storageProvider: "s3" as const,
      relativePath: stored.relativePath,
      uploadedAt: new Date().toISOString()
    };

    const fullResponse = await objectStorage.createRecordingAssetResponse(asset);
    expect(fullResponse.status).toBe(200);
    expect(fullResponse.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await readResponseBytes(fullResponse)).toEqual(allBytes);

    const midResponse = await objectStorage.createRecordingAssetResponse(asset, {
      rangeHeader: "bytes=1024-2047"
    });
    expect(midResponse.status).toBe(206);
    expect(midResponse.headers.get("Content-Range")).toBe(
      `bytes 1024-2047/${allBytes.byteLength}`
    );
    expect(midResponse.headers.get("Content-Length")).toBe("1024");
    expect(midResponse.headers.get("Accept-Ranges")).toBe("bytes");
    expect(midResponse.headers.get("Content-Type")).toBe("video/webm");
    expect(await readResponseBytes(midResponse)).toEqual(
      allBytes.slice(1024, 2048)
    );

    const openEndedResponse = await objectStorage.createRecordingAssetResponse(
      asset,
      { rangeHeader: `bytes=${allBytes.byteLength - 512}-` }
    );
    expect(openEndedResponse.status).toBe(206);
    expect(openEndedResponse.headers.get("Content-Range")).toBe(
      `bytes ${allBytes.byteLength - 512}-${allBytes.byteLength - 1}/${allBytes.byteLength}`
    );
    expect(await readResponseBytes(openEndedResponse)).toEqual(
      allBytes.slice(allBytes.byteLength - 512)
    );

    const suffixResponse = await objectStorage.createRecordingAssetResponse(
      asset,
      { rangeHeader: "bytes=-256" }
    );
    expect(suffixResponse.status).toBe(206);
    expect(await readResponseBytes(suffixResponse)).toEqual(
      allBytes.slice(allBytes.byteLength - 256)
    );

    const unsatisfiableResponse =
      await objectStorage.createRecordingAssetResponse(asset, {
        rangeHeader: `bytes=${allBytes.byteLength}-`
      });
    expect(unsatisfiableResponse.status).toBe(416);
    expect(unsatisfiableResponse.headers.get("Content-Range")).toBe(
      `bytes */${allBytes.byteLength}`
    );

    const malformedResponse = await objectStorage.createRecordingAssetResponse(
      asset,
      { rangeHeader: "bytes=not-a-range" }
    );
    expect(malformedResponse.status).toBe(200);
    expect(await readResponseBytes(malformedResponse)).toEqual(allBytes);

    await objectStorage.deleteStoredObject({
      relativePath: stored.relativePath,
      storageProvider: "s3"
    });
  }, 60_000);

  it("trusts the store's range accounting over a stale fileSizeBytes", async () => {
    const objectStorage = await import("./object-storage");
    const allBytes = new Uint8Array(1000).fill(0x42);

    const stored = await objectStorage.storeRecordingObject({
      fileName: "stale-size.webm",
      mimeType: "video/webm",
      sessionId: "session_demo_stale",
      stream: buildStream([allBytes])
    });

    // A legacy row can carry a browser-reported size larger than the real
    // object. The range parser then admits ranges past the real end; the
    // response headers must reflect what S3 actually returns, or the player
    // hangs waiting for bytes that never arrive.
    const response = await objectStorage.createRecordingAssetResponse(
      {
        id: "asset_s3_stale",
        sessionId: "session_demo_stale",
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        fileSizeBytes: 2000,
        durationSeconds: null,
        storageProvider: "s3",
        relativePath: stored.relativePath,
        uploadedAt: new Date().toISOString()
      },
      { rangeHeader: "bytes=500-1499" }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 500-999/1000");
    expect(response.headers.get("Content-Length")).toBe("500");
    expect(await readResponseBytes(response)).toEqual(allBytes.slice(500));

    await objectStorage.deleteStoredObject({
      relativePath: stored.relativePath,
      storageProvider: "s3"
    });
  }, 30_000);

  it("rejects when asked to delete an s3 object that does not exist", async () => {
    const objectStorage = await import("./object-storage");

    await expect(
      objectStorage.deleteStoredObject({
        relativePath: "recordings/session_demo_001/never-uploaded.webm",
        storageProvider: "s3"
      })
    ).rejects.toThrow();
  }, 30_000);

  it("round-trips a transcript artifact", async () => {
    const objectStorage = await import("./object-storage");
    const transcriptBody = "Participant found the checkout straightforward.";

    const stored = await objectStorage.storeTranscriptArtifact({
      body: transcriptBody,
      sessionId: "session_demo_001"
    });

    expect(stored.storageProvider).toBe("s3");
    expect(stored.artifactPath).toMatch(/^transcripts\/session_demo_001\//);
    expect(stored.artifactUrl).toBeUndefined();

    const response = await objectStorage.createTranscriptArtifactResponse({
      id: "transcript_s3_1",
      sessionId: "session_demo_001",
      body: transcriptBody,
      createdAt: new Date().toISOString(),
      source: "prototype_generated",
      segments: [],
      storageProvider: "s3",
      artifactPath: stored.artifactPath
    });

    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(await response.text()).toBe(transcriptBody);

    await objectStorage.deleteStoredObject({
      relativePath: stored.artifactPath,
      storageProvider: "s3"
    });
  }, 30_000);
});
