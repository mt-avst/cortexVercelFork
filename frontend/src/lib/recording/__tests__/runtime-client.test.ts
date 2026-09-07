import { describe, expect, it } from "vitest";

import {
  RuntimeRequestError,
  runtimeFailureStatus
} from "../runtime-client";

describe("runtimeFailureStatus", () => {
  it("returns the status of a RuntimeRequestError", () => {
    expect(
      runtimeFailureStatus(new RuntimeRequestError("nope", 403))
    ).toBe(403);
    expect(
      runtimeFailureStatus(new RuntimeRequestError("nope", 500))
    ).toBe(500);
  });

  it("returns null for a status of 0 (never reached the server)", () => {
    // A dropped connection has no useful code to show a participant, so this
    // stays the 'check your connection' case rather than 'error 0'.
    expect(runtimeFailureStatus(new RuntimeRequestError("offline", 0))).toBeNull();
  });

  it("returns null for a plain Error or a non-error value", () => {
    expect(runtimeFailureStatus(new Error("boom"))).toBeNull();
    expect(runtimeFailureStatus("boom")).toBeNull();
    expect(runtimeFailureStatus(undefined)).toBeNull();
  });
});
