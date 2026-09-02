import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  ArtifactCopyRaceError,
  copyS3ObjectIfMatch
} from "../runtime-object-storage-s3";

/**
 * cto/AdaptaLabs#99's whole security property, proven WITHOUT MinIO.
 *
 * A security gate found this property was previously proven only by
 * s3-upload-integration.test.ts's real-MinIO tests - which the CI backend
 * jobs and the local mutation canary both skip via FIRSTHAND_SKIP_S3_TESTS
 * (that file's own docblock: two vitest files start a real MinIO container
 * and neither this repo's no-docker runners nor the canary can give them
 * one). Measured before this file existed: deleting `CopySourceIfMatch`
 * entirely from the call site left the full CI-runnable suite green - 1787
 * jest, 691 vitest - because nothing that actually runs on the merge gate
 * inspected what was sent to S3, only what the ROUTE passed to a mocked
 * `copyS3ObjectIfMatch`. This file inspects the SDK call itself, with only
 * `S3Client.prototype.send` stubbed - the same spy-the-client pattern
 * content-disposition.test.ts already uses for the identical reason.
 */
describe("copyS3ObjectIfMatch", () => {
  const priorBucket = process.env.FIRSTHAND_S3_BUCKET;
  // S3Client.prototype.send is overloaded per-command, which vi.spyOn's
  // return type cannot express as one variable's type - erased here the same
  // way content-disposition.test.ts's `as never` casts erase it at the call
  // site, since this file needs the spy across multiple `it` blocks.
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.FIRSTHAND_S3_BUCKET = "test-bucket";
    send = vi.spyOn(S3Client.prototype, "send") as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (priorBucket === undefined) {
      delete process.env.FIRSTHAND_S3_BUCKET;
    } else {
      process.env.FIRSTHAND_S3_BUCKET = priorBucket;
    }
  });

  it("conditions the copy on the ETag the caller inspected - the finalize-time race guard itself", async () => {
    send.mockResolvedValue({ CopyObjectResult: { ETag: '"new-etag"' } } as never);

    const result = await copyS3ObjectIfMatch(
      "booking-artifacts/booking-1/pending.webm",
      "booking-artifacts/finalized/booking-1/pending.webm",
      '"expected-etag"'
    );

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as CopyObjectCommand;
    expect(command).toBeInstanceOf(CopyObjectCommand);
    // THE PROPERTY: without this exact parameter, a re-PUT landing between
    // the caller's HeadObject and this copy is copied as if it were the
    // reviewed upload - the whole reason this function exists rather than a
    // plain CopyObjectCommand.
    expect(command.input).toMatchObject({
      Bucket: "test-bucket",
      Key: "booking-artifacts/finalized/booking-1/pending.webm",
      CopySource: "test-bucket/booking-artifacts/booking-1/pending.webm",
      CopySourceIfMatch: '"expected-etag"'
    });
    expect(result).toEqual({ etag: '"new-etag"' });
  });

  it("maps S3's PreconditionFailed to ArtifactCopyRaceError - the object changed since it was inspected", async () => {
    const preconditionFailed = new Error("At least one of the pre-conditions you specified did not hold");
    preconditionFailed.name = "PreconditionFailed";
    send.mockRejectedValue(preconditionFailed as never);

    await expect(
      copyS3ObjectIfMatch("source-key", "dest-key", '"stale-etag"')
    ).rejects.toThrow(ArtifactCopyRaceError);
  });

  it("CONTROL: an unrelated S3 error propagates unchanged, not wrapped as a race", async () => {
    // Without this, a detector that maps EVERY rejection to
    // ArtifactCopyRaceError would pass the test above for the wrong reason -
    // it has to distinguish the named precondition failure from anything else.
    const outage = new Error("S3 fell over");
    outage.name = "InternalError";
    send.mockRejectedValue(outage as never);

    await expect(
      copyS3ObjectIfMatch("source-key", "dest-key", '"etag"')
    ).rejects.toThrow("S3 fell over");
  });
});
