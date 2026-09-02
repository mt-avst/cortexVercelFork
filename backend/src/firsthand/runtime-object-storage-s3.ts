
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import path from "node:path";
import { Readable } from "node:stream";

import {
  buildContentRangeHeader,
  createUnsatisfiableRangeResponse,
  resolveRangeRequest
} from "./http-range";
import { normalizeRecordingMimeType } from "./recording-mime";
import type {
  RecordingAssetRecord,
  TranscriptRecord
} from "./runtime-records";
import { buildStorageFileName } from "./storage-file-name";

export type S3StorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
};

export function getS3StorageConfig(): S3StorageConfig {
  const bucket = process.env.FIRSTHAND_S3_BUCKET?.trim();

  if (!bucket) {
    throw new Error(
      "S3 storage requested but FIRSTHAND_S3_BUCKET is not configured."
    );
  }

  return {
    bucket,
    region:
      process.env.FIRSTHAND_S3_REGION?.trim() ||
      process.env.AWS_REGION?.trim() ||
      "us-east-1",
    endpoint: process.env.FIRSTHAND_S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: process.env.FIRSTHAND_S3_FORCE_PATH_STYLE === "1"
  };
}

let cachedClient: { key: string; client: S3Client } | null = null;

function getS3Client(config: S3StorageConfig): S3Client {
  const key = JSON.stringify(config);

  if (cachedClient?.key === key) {
    return cachedClient.client;
  }

  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle
  });
  cachedClient = { key, client };

  return client;
}

async function getStoredObjectSizeBytes(objectKey: string): Promise<number> {
  const config = getS3StorageConfig();
  const head = await getS3Client(config).send(
    new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey })
  );

  if (typeof head.ContentLength !== "number") {
    throw new Error(
      `S3 object ${objectKey} was uploaded but HeadObject returned no size.`
    );
  }

  return head.ContentLength;
}

export async function storeRecordingObjectInS3(input: {
  sessionId: string;
  fileName: string;
  mimeType: string;
  stream: ReadableStream<Uint8Array>;
}) {
  const config = getS3StorageConfig();
  const fileName = buildStorageFileName(input.fileName);
  const objectKey = `recordings/${input.sessionId}/${fileName}`;
  const normalizedMimeType = normalizeRecordingMimeType(input.mimeType);

  // Upload streams the body with proper multipart handling and backpressure.
  // Never tee() the stream to count bytes - the counting branch buffers the
  // whole object. The authoritative size comes from HeadObject afterwards.
  const upload = new Upload({
    client: getS3Client(config),
    params: {
      Bucket: config.bucket,
      Key: objectKey,
      Body: Readable.fromWeb(
        input.stream as import("node:stream/web").ReadableStream<Uint8Array>
      ),
      ContentType: normalizedMimeType
    }
  });

  await upload.done();

  return {
    fileName,
    fileSizeBytes: await getStoredObjectSizeBytes(objectKey),
    mimeType: normalizedMimeType,
    objectUrl: undefined,
    relativePath: objectKey,
    storageProvider: "s3" as const
  };
}

export async function storeTranscriptArtifactInS3(input: {
  sessionId: string;
  body: string;
}) {
  const config = getS3StorageConfig();
  const fileName = buildStorageFileName(`${input.sessionId}-transcript.txt`);
  const objectKey = `transcripts/${input.sessionId}/${fileName}`;

  await getS3Client(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: input.body,
      ContentType: "text/plain; charset=utf-8"
    })
  );

  return {
    artifactPath: objectKey,
    artifactUrl: undefined,
    storageProvider: "s3" as const
  };
}

async function openS3ObjectStream(objectKey: string, rangeHeader?: string) {
  const config = getS3StorageConfig();
  const object = await getS3Client(config).send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Range: rangeHeader
    })
  );

  if (!object.Body) {
    throw new Error(`S3 object ${objectKey} could not be read.`);
  }

  return {
    stream: object.Body.transformToWebStream(),
    contentLength: object.ContentLength,
    contentRange: object.ContentRange
  };
}

/**
 * RFC 6266 Content-Disposition value for an inline media response: an
 * ASCII-only quoted fallback plus the RFC 5987 `filename*` form carrying the
 * real name, UTF-8 percent-encoded.
 *
 * The naive `filename="${name}"` interpolation this replaces THREW at serve
 * time for any name with a codepoint above U+00FF - header values are
 * Latin-1 in undici (`Cannot convert argument to a ByteString`) - which made
 * a recording named in CJK, Cyrillic or emoji a permanent generic 500.
 * BOTH media paths were exposed: the runtime recording flow stores the
 * participant client's raw fileName (firsthand-session.ts keeps
 * `parsedBody.data.fileName`; buildStorageFileName sanitises only the object
 * KEY), and booking artefacts (#79) store the researcher's raw name the same
 * way - an earlier version of this comment claimed the runtime path was safe,
 * and a review gate traced the chain and proved it was not. This encoder is
 * the serve-side guarantee for both. The fallback also strips quotes and
 * backslashes, which would otherwise escape the quoted-string.
 */
export function buildInlineContentDisposition(fileName: string): string {
  // A lone surrogate (JSON.parse happily produces one from "\uD800") makes
  // encodeURIComponent throw URIError - scrub to U+FFFD first, the same
  // repair String.prototype.toWellFormed performs (not in this tsconfig's
  // ES2020 lib).
  const wellFormed = fileName.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD"
  );
  const asciiFallback = wellFormed
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  // encodeURIComponent leaves !'()* bare; RFC 5987 wants them pct-encoded.
  const encoded = encodeURIComponent(wellFormed).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export async function createS3RecordingAssetResponse(
  asset: RecordingAssetRecord,
  rangeHeader?: string | null
) {
  const range = resolveRangeRequest(rangeHeader, asset.fileSizeBytes);

  if (range.kind === "unsatisfiable") {
    return createUnsatisfiableRangeResponse(asset.fileSizeBytes);
  }

  const baseHeaders = {
    "Content-Type": asset.mimeType,
    "Content-Disposition": buildInlineContentDisposition(asset.fileName),
    "Accept-Ranges": "bytes"
  };

  if (range.kind === "full") {
    const object = await openS3ObjectStream(asset.relativePath);

    return new Response(object.stream, {
      headers: {
        ...baseHeaders,
        "Content-Length": String(
          object.contentLength ?? asset.fileSizeBytes
        )
      }
    });
  }

  try {
    const object = await openS3ObjectStream(
      asset.relativePath,
      `bytes=${range.start}-${range.end}`
    );

    // Prefer the store's own range accounting: a legacy row can carry a
    // browser-reported fileSizeBytes that overstates the real object, in
    // which case S3 clamps the range and returns fewer bytes than the
    // computed Content-Length would claim, hanging the player.
    return new Response(object.stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range":
          object.contentRange ??
          buildContentRangeHeader(range.start, range.end, asset.fileSizeBytes),
        "Content-Length": String(
          object.contentLength ?? range.end - range.start + 1
        )
      }
    });
  } catch (error) {
    // The stored fileSizeBytes can overstate the real object (legacy rows
    // carry a browser-reported size), in which case a range we considered
    // satisfiable may start past the actual last byte.
    if (error instanceof Error && error.name === "InvalidRange") {
      return createUnsatisfiableRangeResponse(asset.fileSizeBytes);
    }

    throw error;
  }
}

export async function createS3TranscriptArtifactResponse(
  artifactPath: NonNullable<TranscriptRecord["artifactPath"]>
) {
  return new Response((await openS3ObjectStream(artifactPath)).stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // ASCII by construction (both callers build the path through
      // buildStorageFileName) - encoded anyway, so this file has no raw
      // header interpolation left to copy.
      "Content-Disposition": buildInlineContentDisposition(
        path.basename(artifactPath)
      )
    }
  });
}

/**
 * Presign a PUT for a server-derived object key. The content type is pinned
 * in the signature, so a PUT with a different Content-Type fails auth. The
 * URL is a raw write capability for exactly this key - never sign a
 * client-chosen key.
 */
export async function createPresignedRecordingUploadUrl(input: {
  objectKey: string;
  contentType: string;
  expiresInSeconds: number;
}): Promise<string> {
  const config = getS3StorageConfig();

  return getSignedUrl(
    getS3Client(config),
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.objectKey,
      ContentType: input.contentType
    }),
    {
      expiresIn: input.expiresInSeconds,
      // Without this the presigner leaves content-type out of the signature
      // and the store accepts a PUT with any content type - verified against
      // a real MinIO, where a text/html upload sailed through.
      signableHeaders: new Set(["content-type"])
    }
  );
}

/**
 * Size AND ETag of the object at the key, or null when no object exists. The
 * booking-artifact finalize route (#79 step 2, closed by #99) uses the ETag as
 * the CopySourceIfMatch condition on `copyS3ObjectIfMatch`: the presigned PUT
 * URL stays valid for its whole window after finalize - S3 cannot revoke a
 * signature - and this is what proves the object being copied to its
 * unpresigned finalized key is still the one just inspected, closing the
 * finalize-time race atomically rather than merely narrowing it.
 */
export async function headS3ObjectStat(
  objectKey: string
): Promise<{ sizeBytes: number; etag: string | null } | null> {
  const config = getS3StorageConfig();

  try {
    const head = await getS3Client(config).send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey })
    );

    if (typeof head.ContentLength !== "number") {
      return null;
    }

    return { sizeBytes: head.ContentLength, etag: head.ETag ?? null };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NotFound" || error.name === "NoSuchKey")
    ) {
      return null;
    }

    throw error;
  }
}

/**
 * Thrown when the object at `sourceKey` changed between the caller's own
 * HeadObject and the copy actually executing on S3's side - the race
 * `copyS3ObjectIfMatch`'s conditional copy exists to catch rather than widen.
 */
export class ArtifactCopyRaceError extends Error {
  constructor(objectKey: string) {
    super(
      `S3 object ${objectKey} changed before it could be copied to its finalized key.`
    );
    this.name = "ArtifactCopyRaceError";
  }
}

/**
 * Copies the object at `sourceKey` to `destKey`, ATOMICALLY conditioned on
 * the source's ETag still matching `expectedEtag` at the moment S3 executes
 * the copy (`CopySourceIfMatch`) - this is what makes the booking-artefact
 * finalize route's copy-to-an-unpresigned-key immune to the exact race a
 * plain HeadObject-then-copy would still carry: two separate round trips
 * leave a window where a byte-swap lands between them and gets copied as if
 * it were the reviewed upload. The condition closes that window outright
 * rather than narrowing it, because S3 evaluates it as part of the single
 * copy operation. Returns the copy's own ETag (informational only - nothing
 * downstream compares against it, because after this call the destination is
 * never addressed by a presigned URL, so there is nothing left to re-verify).
 */
export async function copyS3ObjectIfMatch(
  sourceKey: string,
  destKey: string,
  expectedEtag: string
): Promise<{ etag: string | null }> {
  const config = getS3StorageConfig();

  try {
    const result = await getS3Client(config).send(
      new CopyObjectCommand({
        Bucket: config.bucket,
        Key: destKey,
        // encodeURI, not encodeURIComponent: CopySource is "bucket/key" and
        // the key's own "/" separators must survive encoding, only special
        // characters within a segment need escaping.
        CopySource: encodeURI(`${config.bucket}/${sourceKey}`),
        CopySourceIfMatch: expectedEtag
      })
    );

    return { etag: result.CopyObjectResult?.ETag ?? null };
  } catch (error) {
    if (error instanceof Error && error.name === "PreconditionFailed") {
      throw new ArtifactCopyRaceError(sourceKey);
    }

    throw error;
  }
}

/**
 * Size of the object at the key, or null when no object exists. Used by
 * finalize as the only trusted source of fileSizeBytes.
 */
export async function headS3ObjectSize(
  objectKey: string
): Promise<number | null> {
  const config = getS3StorageConfig();

  try {
    const head = await getS3Client(config).send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey })
    );

    return typeof head.ContentLength === "number" ? head.ContentLength : null;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NotFound" || error.name === "NoSuchKey")
    ) {
      return null;
    }

    throw error;
  }
}

export async function deleteS3Object(objectKey: string) {
  const config = getS3StorageConfig();
  const client = getS3Client(config);

  // HeadObject first so deleting a missing object fails loudly. S3's
  // DeleteObject succeeds on absent keys, which would report a successful
  // erasure that erased nothing.
  await client.send(
    new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey })
  );
  await client.send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey })
  );
}
