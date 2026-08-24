import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import { getFlowStorageKey, type FlowPhase } from "../../../lib/recording/session-local-state";
import type { RecorderState } from "../../../lib/recording/session-recorder";
import type { SessionPayload } from "@shared/firsthand/contract";

/**
 * The one-click exit, and why removing it is the whole protection.
 *
 * While a recording exists only in memory, leaving the page destroys it. The
 * `beforeunload` guard catches a reload or a closed tab - but an in-app
 * `<Link>` routes CLIENT-SIDE and never fires `beforeunload` at all, so the
 * guard cannot see it. The only thing standing between a participant and a
 * lost recording is that the link is not rendered.
 *
 * `shouldGuardNavigation` is deliberately NOT mocked here. Every other flow
 * test hard-codes it to `false`, so nothing anywhere renders this component
 * with the real predicate - which means the WIRING (what state is passed to
 * it) had no coverage at all, only the predicate's own arithmetic. Driving
 * these from a real `RecorderState` is what makes the failed-upload case below
 * mean anything: a failed upload still holds the only copy, so it must guard,
 * and a mutation that passed a "complete" status instead would otherwise sail
 * through.
 */

const TOKEN = "token_guard";

/**
 * The nav's own locked copy, matched exactly. A loose /stay on this page/
 * also matches the upload stage's warning, so it would pass with the nav
 * link still rendered.
 */
const NAV_LOCKED_COPY = "Recording in progress - stay on this page";

/** The real shape, so a status outside the union cannot be invented. */
const baseState: RecorderState = {
  captureStoppedExternally: false,
  microphonePermission: "not_requested",
  screenPermission: "not_requested",
  recordingStatus: "not_started",
  uploadStatus: "not_started",
  uploadProgress: null,
  recordingStartedAt: null,
  errorMessage: null,
  durationSeconds: null,
  asset: null
};

let recorderState: RecorderState = { ...baseState };

vi.mock("../../../lib/recording/session-recorder", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // shouldGuardNavigation is intentionally the real one.
  useSessionRecorder: () => ({
    state: recorderState,
    startCapture: vi.fn().mockResolvedValue(true),
    stopCaptureAndUpload: vi.fn().mockResolvedValue(null),
    retryUpload: vi.fn().mockResolvedValue(null)
  })
}));

vi.mock("../../../lib/recording/task-pip", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTaskPipSupported: () => true,
  useTaskPip: () => ({
    pipWindow: null,
    isSupported: true,
    openTaskPip: vi.fn().mockResolvedValue(true),
    closeTaskPip: vi.fn()
  })
}));

vi.mock("../../../lib/recording/device-support", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assessDeviceSupport: () => ({ canRun: true, reason: null }),
  collectDeviceSnapshot: () => ({})
}));

vi.mock("../../../lib/recording/runtime-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined),
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined)
}));

function payload(): SessionPayload {
  return {
    contract_version: "1.0",
    study: {
      id: "study_1",
      title: "Checkout walkthrough",
      intro_text: "Thanks for taking part.",
      consent_text: "You consent to screen and microphone recording."
    },
    participant: { participant_id: "participant_1" },
    session: {
      session_id: "session_1",
      session_token: TOKEN,
      study_id: "study_1",
      participant_id: "participant_1"
    },
    steps: [
      {
        step_id: "study_1_step_1",
        order: 1,
        type: "instruction",
        prompt: "Find a pair of running shoes under £80.",
        target_url: "https://shop.example.com/running"
      }
    ]
  };
}

/** Seeds the persisted phase so a guarded stage renders its real DOM. */
function renderAt(phase: FlowPhase) {
  window.localStorage.setItem(
    getFlowStorageKey(TOKEN, 1),
    JSON.stringify({ phase })
  );

  return render(
    <MemoryRouter>
      <ParticipantSessionFlow
        attemptNumber={1}
        directRecordingUploadMode={null}
        payload={payload()}
        token={TOKEN}
      />
    </MemoryRouter>
  );
}

const beforeUnloadHandlers = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([event]) => event === "beforeunload");

describe("ParticipantSessionFlow navigation guard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    recorderState = { ...baseState };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers a way back to the hub while nothing is at risk", async () => {
    renderAt("welcome");
    await screen.findByRole("button", { name: "Continue to consent" });

    // By ROLE, not by text: an anchor is what routes client-side past
    // beforeunload, so "the copy is gone" is not the property that matters.
    expect(screen.getByRole("link", { name: "Study hub" })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("withdraws the one-click exit while a recording is live", async () => {
    recorderState = { ...baseState, recordingStatus: "active" };
    renderAt("running");

    expect(await screen.findByText(NAV_LOCKED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Study hub" })).toBeNull();
  });

  it("keeps it withdrawn while a FAILED upload still holds the only copy", async () => {
    // The case most easily got wrong. Recording has stopped, so it looks
    // finished - but the blob is still in memory and the participant is being
    // offered a retry. Leaving now destroys it.
    recorderState = {
      ...baseState,
      recordingStatus: "stopped",
      uploadStatus: "failed"
    };
    renderAt("uploading");

    expect(await screen.findByText(NAV_LOCKED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Study hub" })).toBeNull();
  });

  it("leaves no in-page link to route away on, in the states that are guarded", async () => {
    // Asserted against the DOM of a genuinely guarded stage, not the welcome
    // screen: withdrawing the nav link is worth nothing if the upload stage
    // renders its own anchor beside "Retry upload".
    recorderState = {
      ...baseState,
      recordingStatus: "stopped",
      uploadStatus: "failed"
    };
    renderAt("uploading");

    await screen.findByText(NAV_LOCKED_COPY);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("registers a beforeunload guard that actually cancels the unload", async () => {
    // Registering a listener is not the protection - Chrome and Firefox only
    // show the leave-site dialog if the handler calls preventDefault. A
    // registered no-op would pass any assertion that only checks the
    // listener exists.
    const add = vi.spyOn(window, "addEventListener");

    recorderState = { ...baseState, recordingStatus: "active" };
    renderAt("running");
    await screen.findByText(NAV_LOCKED_COPY);

    const registered = beforeUnloadHandlers(add);
    expect(registered).toHaveLength(1);

    const handler = registered[0][1] as (event: BeforeUnloadEvent) => void;
    const event = new Event("beforeunload", {
      cancelable: true
    }) as BeforeUnloadEvent;
    handler(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("registers no beforeunload guard when nothing is at risk", async () => {
    const add = vi.spyOn(window, "addEventListener");

    renderAt("welcome");
    await screen.findByRole("button", { name: "Continue to consent" });

    expect(beforeUnloadHandlers(add)).toHaveLength(0);
  });

  it("takes the guard back off once the recording is safely uploaded", async () => {
    // Without the effect's cleanup the listener outlives the risk, and every
    // later reload asks the participant to confirm leaving a page with
    // nothing left to lose.
    const remove = vi.spyOn(window, "removeEventListener");

    recorderState = { ...baseState, recordingStatus: "active" };
    const { unmount } = renderAt("running");
    await screen.findByText(NAV_LOCKED_COPY);

    unmount();

    expect(beforeUnloadHandlers(remove)).toHaveLength(1);
  });
});
