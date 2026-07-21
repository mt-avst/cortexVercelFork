import { describe, expect, it, vi } from "vitest";

import {
  canRetryRecordingUpload,
  classifyPermissionError,
  deriveUploadProgress,
  releaseCaptureResources,
  shouldGuardNavigation
} from "./session-recorder";

describe("releaseCaptureResources", () => {
  it("stops newly acquired streams even when refs were never populated", () => {
    const displayTrackStop = vi.fn();
    const microphoneTrackStop = vi.fn();
    const combinedTrackStop = vi.fn();

    const refs = {
      combinedStreamRef: { current: null },
      displayStreamRef: { current: null },
      mediaRecorderRef: { current: null },
      microphoneStreamRef: { current: null }
    };

    releaseCaptureResources(refs, {
      combinedStream: createMockStream(combinedTrackStop),
      displayStream: createMockStream(displayTrackStop),
      microphoneStream: createMockStream(microphoneTrackStop)
    });

    expect(displayTrackStop).toHaveBeenCalledTimes(1);
    expect(microphoneTrackStop).toHaveBeenCalledTimes(1);
    expect(combinedTrackStop).toHaveBeenCalledTimes(1);
  });

  it("clears ref-held resources after stopping them", () => {
    const displayTrackStop = vi.fn();
    const microphoneTrackStop = vi.fn();
    const combinedTrackStop = vi.fn();

    const refs = {
      combinedStreamRef: { current: createMockStream(combinedTrackStop) },
      displayStreamRef: { current: createMockStream(displayTrackStop) },
      mediaRecorderRef: { current: {} as MediaRecorder },
      microphoneStreamRef: { current: createMockStream(microphoneTrackStop) }
    };

    releaseCaptureResources(refs);

    expect(displayTrackStop).toHaveBeenCalledTimes(1);
    expect(microphoneTrackStop).toHaveBeenCalledTimes(1);
    expect(combinedTrackStop).toHaveBeenCalledTimes(1);
    expect(refs.displayStreamRef.current).toBeNull();
    expect(refs.microphoneStreamRef.current).toBeNull();
    expect(refs.combinedStreamRef.current).toBeNull();
    expect(refs.mediaRecorderRef.current).toBeNull();
  });
});

describe("classifyPermissionError", () => {
  it("keeps screen sharing untouched when microphone permission is denied first", () => {
    const result = classifyPermissionError(
      new DOMException("Denied", "NotAllowedError"),
      "microphone"
    );

    expect(result).toEqual({
      message:
        "Microphone permission was denied. Allow microphone access on this tab before choosing what to share.",
      microphonePermission: "denied",
      screenPermission: "not_requested"
    });
  });

  it("preserves microphone granted state when screen sharing is cancelled later", () => {
    const result = classifyPermissionError(
      new DOMException("Cancelled", "AbortError"),
      "screen"
    );

    expect(result).toEqual({
      message:
        "Screen sharing was cancelled after microphone access was granted. Retry when you are ready to choose what to share.",
      microphonePermission: "granted",
      screenPermission: "cancelled"
    });
  });
});

describe("shouldGuardNavigation", () => {
  it("does not nag before anything has been captured", () => {
    expect(
      shouldGuardNavigation({
        recordingStatus: "not_started",
        uploadStatus: "not_started"
      })
    ).toBe(false);
  });

  // starting: the permission prompts are open. active: the session is being
  // recorded. stopping: the recorder is still flushing its final chunks.
  it.each(["starting", "active", "stopping"] as const)(
    "guards while recording is %s",
    (recordingStatus) => {
      expect(
        shouldGuardNavigation({
          recordingStatus,
          uploadStatus: "not_started"
        })
      ).toBe(true);
    }
  );

  it.each(["pending", "in_progress"] as const)(
    "guards while the upload is %s",
    (uploadStatus) => {
      expect(
        shouldGuardNavigation({ recordingStatus: "stopped", uploadStatus })
      ).toBe(true);
    }
  );

  it("keeps guarding after a failed upload, because the only copy is still in memory", () => {
    // The recording exists solely as in-memory chunks until the upload lands.
    // A failed upload is retryable, so leaving now silently discards a session
    // the participant has already sat through.
    expect(
      shouldGuardNavigation({
        recordingStatus: "stopped",
        uploadStatus: "failed"
      })
    ).toBe(true);
  });

  it("releases the guard once the upload has completed", () => {
    expect(
      shouldGuardNavigation({
        recordingStatus: "stopped",
        uploadStatus: "complete"
      })
    ).toBe(false);
  });

  it("does not guard a failed recording that never produced anything to lose", () => {
    expect(
      shouldGuardNavigation({
        recordingStatus: "failed",
        uploadStatus: "not_started"
      })
    ).toBe(false);
  });
});

describe("canRetryRecordingUpload", () => {
  it("offers a retry when an upload failed and the recording is still held", () => {
    expect(
      canRetryRecordingUpload({ uploadStatus: "failed" }, true)
    ).toBe(true);
  });

  it("cannot retry once the recording has been released", () => {
    expect(
      canRetryRecordingUpload({ uploadStatus: "failed" }, false)
    ).toBe(false);
  });

  it.each(["not_started", "pending", "in_progress", "complete"] as const)(
    "offers no retry while the upload is %s",
    (uploadStatus) => {
      expect(canRetryRecordingUpload({ uploadStatus }, true)).toBe(false);
    }
  );
});

describe("deriveUploadProgress", () => {
  it("passes a fresh attempt through at zero", () => {
    expect(
      deriveUploadProgress({ loadedBytes: 0, totalBytes: 1000, percentage: 0 })
    ).toEqual({ loadedBytes: 0, totalBytes: 1000, percentage: 0 });
  });

  it("floors mid-flight percentages so equal displays can be skipped", () => {
    expect(
      deriveUploadProgress({ loadedBytes: 476, totalBytes: 1000, percentage: 47.6 })
    ).toEqual({ loadedBytes: 476, totalBytes: 1000, percentage: 47 });
  });

  it("lets a genuine 99 through unchanged", () => {
    expect(
      deriveUploadProgress({ loadedBytes: 990, totalBytes: 1000, percentage: 99 })
    ).toEqual({ loadedBytes: 990, totalBytes: 1000, percentage: 99 });
  });

  it("caps a fully sent body at 99, because the finalize step has not confirmed it", () => {
    // Transport-level progress covers only the blob body. Showing 100 before
    // finalization would claim durable storage the server has not confirmed.
    expect(
      deriveUploadProgress({ loadedBytes: 1000, totalBytes: 1000, percentage: 100 })
    ).toEqual({ loadedBytes: 1000, totalBytes: 1000, percentage: 99 });
  });

  it("clamps percentages that stray outside the valid range", () => {
    expect(
      deriveUploadProgress({ loadedBytes: 2000, totalBytes: 1000, percentage: 200 })
        .percentage
    ).toBe(99);
    expect(
      deriveUploadProgress({ loadedBytes: 0, totalBytes: 1000, percentage: -1 })
        .percentage
    ).toBe(0);
  });

  it("returns a new event rather than mutating the input", () => {
    const event = { loadedBytes: 995, totalBytes: 1000, percentage: 99.5 };

    const derived = deriveUploadProgress(event);

    expect(derived).not.toBe(event);
    expect(event.percentage).toBe(99.5);
  });
});

function createMockStream(stop: () => void) {
  return {
    getTracks() {
      return [
        {
          stop
        }
      ];
    }
  } as unknown as MediaStream;
}
