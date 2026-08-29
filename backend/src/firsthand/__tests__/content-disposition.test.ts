import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";

import {
  buildInlineContentDisposition,
  createS3RecordingAssetResponse
} from "../runtime-object-storage-s3";

/**
 * The header-safety property behind #79's artefact serving: booking artefacts
 * store the researcher's RAW file name, and undici header values are Latin-1,
 * so the naive `filename="${name}"` interpolation threw on any codepoint
 * above U+00FF - a review gate measured a CJK-named recording presigning,
 * uploading and finalizing cleanly, then 500ing on every serve, permanently.
 * The builder must produce a header value that a real Headers object accepts
 * for ANY name the presign schema admits.
 */
describe("buildInlineContentDisposition", () => {
  const HEADER_HOSTILE_NAMES = [
    ["CJK", "会議.webm"],
    ["emoji", "call-🎥.webm"],
    ["Cyrillic", "звонок.webm"],
    ["Greek", "κλήση.webm"],
    ["U+2028 line separator", "call\u2028recording.webm"],
    ["U+0085 next line", "call\u0085recording.webm"],
    ["trailing backslash", "call.webm\\"],
    ["embedded quote", 'call ".webm'],
    // JSON.parse('"\uD800"') yields exactly these - encodeURIComponent throws
    // URIError on them unless the builder scrubs to U+FFFD first.
    ["lone high surrogate", "call-\uD800.webm"],
    ["lone low surrogate", "call-\uDC00.webm"]
  ] as const;

  it.each(HEADER_HOSTILE_NAMES)(
    "a %s name produces a value a real Headers object accepts",
    (_label, name) => {
      const value = buildInlineContentDisposition(name);

      // THE MEASUREMENT, not a character-class opinion: undici's own
      // ByteString conversion is what threw in production shape, so undici's
      // own Headers is the oracle that it no longer can.
      expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
    }
  );

  it("keeps a plain ASCII name intact in both forms", () => {
    expect(buildInlineContentDisposition("call.webm")).toBe(
      "inline; filename=\"call.webm\"; filename*=UTF-8''call.webm"
    );
  });

  it("carries the real name, UTF-8 percent-encoded, in the filename* form", () => {
    const value = buildInlineContentDisposition("会議.webm");
    expect(value).toContain("filename*=UTF-8''%E4%BC%9A%E8%AD%B0.webm");
    // And the quoted fallback is pure ASCII with the non-ASCII collapsed.
    expect(value).toContain('filename="__.webm"');
  });

  it("strips quotes and backslashes from the quoted fallback - they would escape it", () => {
    const value = buildInlineContentDisposition('a"b\\c.webm');
    expect(value).toContain('filename="a_b_c.webm"');
  });

  it("pct-encodes the characters encodeURIComponent leaves bare, per RFC 5987", () => {
    const value = buildInlineContentDisposition("call (1)'*!.webm");
    expect(value).toContain("filename*=UTF-8''call%20%281%29%27%2A%21.webm");
  });
});

/**
 * The WIRING, not the encoder: a re-gate proved the encoder's unit suite
 * could not see `createS3RecordingAssetResponse` revert to the raw
 * interpolation - the identical 743/1707 green with the fix unwired. This is
 * the assertion that dies with the call site, and it anchors the
 * recording-media-content-disposition-encoded canary entry.
 */
describe("createS3RecordingAssetResponse wires the encoder", () => {
  const priorBucket = process.env.FIRSTHAND_S3_BUCKET;

  beforeEach(() => {
    process.env.FIRSTHAND_S3_BUCKET = "test-bucket";
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Body: {
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            }
          })
      },
      ContentLength: 10
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (priorBucket === undefined) {
      delete process.env.FIRSTHAND_S3_BUCKET;
    } else {
      process.env.FIRSTHAND_S3_BUCKET = priorBucket;
    }
  });

  it("puts the ENCODED Content-Disposition on the response, never the raw name", async () => {
    const response = await createS3RecordingAssetResponse(
      {
        id: "asset-1",
        sessionId: "session-1",
        fileName: "会議.webm",
        mimeType: "video/webm",
        fileSizeBytes: 10,
        durationSeconds: null,
        storageProvider: "s3",
        relativePath: "recordings/session-1/call.webm",
        uploadedAt: "2026-08-29T00:00:00.000Z"
      },
      null
    );

    expect(response.headers.get("content-disposition")).toBe(
      buildInlineContentDisposition("会議.webm")
    );
  });
});
