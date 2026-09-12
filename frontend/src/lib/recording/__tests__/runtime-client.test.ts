import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeRequestError,
  fetchLatestRuntimeStatus,
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

// RS-10 increment-1 control: fetchLatestRuntimeStatus reads the runtime snapshot's
// status to decide whether to surface the "unfinished session" prompt. The snapshot
// is a serialised RuntimeSessionRecord whose status field is camelCase `sessionStatus`
// on the wire (the postgres mapper emits camelCase and express.json does not transform
// it). The ParticipantSessionFlow tests mock this function, so they cannot see a key
// mismatch - these tests exercise the real parse and pin the wire key by name. If it
// ever regresses to the DB column's snake_case `session_status`, the "reads camelCase"
// test fails, not a silent no-op where the banner never fires.

const TOKEN = "token_runtime_status";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body
  } as unknown as Response;
}

describe("fetchLatestRuntimeStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the camelCase sessionStatus field from the snapshot", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ sessionId: "session_1", sessionStatus: "recording_in_progress" })
      );

    await expect(fetchLatestRuntimeStatus(TOKEN)).resolves.toBe(
      "recording_in_progress"
    );

    // GETs the attempt-agnostic runtime snapshot with credentials, no CSRF.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      `/api/firsthand/session/${TOKEN}/runtime`
    );
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("returns null when only the DB snake_case session_status is present", async () => {
    // Guards against reverting to the wrong key: a body shaped like the DB row
    // rather than the serialised record must NOT be read as a status.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ session_status: "recording_in_progress" })
    );

    await expect(fetchLatestRuntimeStatus(TOKEN)).resolves.toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ sessionStatus: "recording_in_progress" }, false)
    );

    await expect(fetchLatestRuntimeStatus(TOKEN)).resolves.toBeNull();
  });

  it("returns null when the status field is missing or not a string", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ sessionId: "session_1" })
    );
    await expect(fetchLatestRuntimeStatus(TOKEN)).resolves.toBeNull();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ sessionStatus: 42 })
    );
    await expect(fetchLatestRuntimeStatus(TOKEN)).resolves.toBeNull();
  });

  it("returns null on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(fetchLatestRuntimeStatus(TOKEN)).resolves.toBeNull();
  });
});
