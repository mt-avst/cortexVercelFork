import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPresignedRecordingUploadUrl,
  headS3ObjectSize
} from "./runtime-object-storage-s3";
import { createRecordingAssetResponse } from "./object-storage";

// Real-MinIO integration for the B4 direct-upload primitives, ported from
// FirstHand's recording/s3-upload-integration.test.ts. The original drove the
// Next route handlers against the filesystem repository (excised in the merge),
// so this port targets the storage layer the routes call instead: presign a
// PUT, push a genuine object, and prove finalize's trust model — the object
// size comes from HeadObject (not the client's claim) and the content type is
// pinned in the signature. The route-level auth/binding/status contract is
// covered by routes/__tests__/firsthand-session.test.ts with mocked storage.
const execFileAsync = promisify(execFile);
const skipS3Tests = process.env.FIRSTHAND_SKIP_S3_TESTS === "1";

const TEST_BUCKET = "firsthand-upload-test";
const MINIO_USER = "firsthand-test";
const MINIO_PASSWORD = "firsthand-test-secret";
const containerName = `firsthand-minio-upload-${process.pid}`;
let minioEndpoint: string;

async function startMinioContainer(): Promise<string> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
  } catch {
    throw new Error(
      "Docker is required for the S3 upload integration tests (real MinIO). " +
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

  const { stdout } = await execFileAsync("docker", ["port", containerName, "9000"]);
  const mappedPort = stdout.trim().split("\n")[0]?.split(":").pop();
  if (!mappedPort) {
    throw new Error(`Could not determine the mapped MinIO port: ${stdout}`);
  }

  const endpoint = `http://127.0.0.1:${mappedPort}`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const health = await fetch(`${endpoint}/minio/health/ready`);
      if (health.ok) return endpoint;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error("MinIO did not become ready within 30s.");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(skipS3Tests)("s3 direct upload primitives (MinIO)", () => {
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
    await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "FIRSTHAND_S3_BUCKET",
      "FIRSTHAND_S3_REGION",
      "FIRSTHAND_S3_ENDPOINT",
      "FIRSTHAND_S3_FORCE_PATH_STYLE"
    ]) {
      delete process.env[name];
    }
  });

  beforeEach(() => {
    process.env.FIRSTHAND_S3_BUCKET = TEST_BUCKET;
    process.env.FIRSTHAND_S3_REGION = "us-east-1";
    process.env.FIRSTHAND_S3_ENDPOINT = minioEndpoint;
    process.env.FIRSTHAND_S3_FORCE_PATH_STYLE = "1";
  });

  it("presigns a PUT, and finalize's HeadObject reports the real size, not the client claim", async () => {
    const objectKey = "recordings/session_demo_001/session.webm";
    const recordingBytes = new Uint8Array(64 * 1024).fill(0x5a);

    const uploadUrl = await createPresignedRecordingUploadUrl({
      objectKey,
      contentType: "video/webm",
      expiresInSeconds: 900
    });

    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/webm" },
      body: recordingBytes
    });
    expect(putResponse.ok).toBe(true);

    // The presigned PUT does not pin length, so a client could push more than it
    // declared — finalize's only trusted size source is HeadObject.
    const size = await headS3ObjectSize(objectKey);
    expect(size).toBe(recordingBytes.byteLength);

    const playback = await createRecordingAssetResponse({
      id: "asset_1",
      sessionId: "session_demo_001",
      fileName: "session.webm",
      mimeType: "video/webm",
      fileSizeBytes: recordingBytes.byteLength,
      durationSeconds: 1,
      storageProvider: "s3",
      relativePath: objectKey,
      uploadedAt: "2026-07-21T00:00:00.000Z"
    } as any);
    expect(new Uint8Array(await playback.arrayBuffer())).toEqual(recordingBytes);
  }, 60_000);

  it("rejects a PUT whose content type differs from the signed one (403)", async () => {
    const objectKey = "recordings/session_demo_001/mismatch.webm";
    const uploadUrl = await createPresignedRecordingUploadUrl({
      objectKey,
      contentType: "video/webm",
      expiresInSeconds: 900
    });

    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/html" },
      body: new Uint8Array(16)
    });

    expect(putResponse.ok).toBe(false);
    expect(putResponse.status).toBe(403);
  }, 30_000);

  it("reports null size for a key that was never uploaded", async () => {
    const size = await headS3ObjectSize(
      "recordings/session_demo_001/never-registered.webm"
    );
    expect(size).toBeNull();
  }, 30_000);
});
