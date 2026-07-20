import type {
  RecordingAssetRecord,
  TranscriptRecord
} from "./runtime-records";
import {
  createS3RecordingAssetResponse,
  createS3TranscriptArtifactResponse,
  deleteS3Object,
  storeRecordingObjectInS3,
  storeTranscriptArtifactInS3
} from "./runtime-object-storage-s3";

// S3-only object storage for the unified product.
//
// FirstHand shipped a multi-backend selector (filesystem / vercel_blob / s3).
// The merge into Cortex keeps only S3 (IRSA to the firsthand-{env} bucket):
// @vercel/blob and the filesystem-legacy path are excised, not ported. Every
// production recording is stored on S3, so writes always target S3 and reads
// assert the persisted provider is "s3" — a legacy provider on a row is a data
// error we surface loudly rather than silently mis-serve.

function assertS3Provider(
  provider: RecordingAssetRecord["storageProvider"] | TranscriptRecord["storageProvider"],
  what: string
): asserts provider is "s3" {
  if (provider !== "s3") {
    throw new Error(
      `Unsupported storage provider "${String(provider)}" for ${what}. ` +
        `The unified product serves S3 recordings only; ` +
        `filesystem and vercel_blob storage were retired in the FirstHand merge.`
    );
  }
}

export async function storeRecordingObject(input: {
  sessionId: string;
  fileName: string;
  mimeType: string;
  stream: ReadableStream<Uint8Array>;
}) {
  return storeRecordingObjectInS3(input);
}

export async function createRecordingAssetResponse(
  asset: RecordingAssetRecord,
  options?: { rangeHeader?: string | null }
) {
  assertS3Provider(asset.storageProvider, "recording asset");
  return createS3RecordingAssetResponse(asset, options?.rangeHeader);
}

export async function storeTranscriptArtifact(input: {
  sessionId: string;
  body: string;
}) {
  return storeTranscriptArtifactInS3(input);
}

export async function createTranscriptArtifactResponse(transcript: TranscriptRecord) {
  if (!transcript.artifactPath) {
    return new Response(transcript.body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }

  assertS3Provider(transcript.storageProvider ?? "s3", "transcript artifact");
  return createS3TranscriptArtifactResponse(transcript.artifactPath);
}

export async function deleteStoredObject(input: {
  relativePath: string;
  storageProvider: RecordingAssetRecord["storageProvider"];
}) {
  assertS3Provider(input.storageProvider, "stored object deletion");
  await deleteS3Object(input.relativePath);
}
