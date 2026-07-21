import { describe, expect, it } from "vitest";

import { assessSetupReadiness, type SetupSnapshot } from "./setup-checks";

const baseSnapshot: SetupSnapshot = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  viewportWidth: 1440,
  hasMediaDevices: true,
  hasEnumerateDevices: true,
  hasGetUserMedia: true,
  hasGetDisplayMedia: true,
  audioInputCount: 1,
  deviceEnumerationFailed: false
};

describe("assessSetupReadiness", () => {
  it("passes a supported desktop environment", () => {
    const result = assessSetupReadiness(baseSnapshot);

    expect(result.canProceed).toBe(true);
    expect(result.failedChecks).toBe(0);
    expect(result.warningChecks).toBe(0);
  });

  it("fails unsupported setup conditions", () => {
    const result = assessSetupReadiness({
      ...baseSnapshot,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      viewportWidth: 800,
      audioInputCount: 0,
      hasGetDisplayMedia: false
    });

    expect(result.canProceed).toBe(false);
    expect(result.failedChecks).toBe(4);
  });

  it("allows warnings without blocking setup", () => {
    const result = assessSetupReadiness({
      ...baseSnapshot,
      audioInputCount: null,
      deviceEnumerationFailed: true
    });

    expect(result.canProceed).toBe(true);
    expect(result.warningChecks).toBe(1);
  });
});
