import { describe, expect, it } from "vitest";

import {
  defaultRecordingMimeType,
  normalizeRecordingMimeType
} from "./recording-mime";

describe("normalizeRecordingMimeType", () => {
  it("strips codec parameters from browser recorder mime types", () => {
    expect(normalizeRecordingMimeType("video/webm;codecs=vp9,opus")).toBe(
      "video/webm"
    );
    expect(normalizeRecordingMimeType("video/webm; codecs=vp8,opus")).toBe(
      "video/webm"
    );
  });

  it("keeps plain mime types unchanged", () => {
    expect(normalizeRecordingMimeType("video/mp4")).toBe("video/mp4");
    expect(normalizeRecordingMimeType("audio/webm")).toBe("audio/webm");
  });

  it("falls back to the default recording mime type when none is provided", () => {
    expect(normalizeRecordingMimeType("")).toBe(defaultRecordingMimeType);
    expect(normalizeRecordingMimeType(null)).toBe(defaultRecordingMimeType);
    expect(normalizeRecordingMimeType(undefined)).toBe(
      defaultRecordingMimeType
    );
  });
});
