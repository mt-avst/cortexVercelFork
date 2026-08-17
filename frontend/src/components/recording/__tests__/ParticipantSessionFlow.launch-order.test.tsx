import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import type { SessionPayload } from "../../../shared/firsthand/contract";

// The launch handler's ordering rules. The panel is no longer opened from
// here at all - it is the participant's to ask for on the setup step's own
// control - but two constraints in this handler are load-bearing and easy to
// break, so they keep their coverage:
//
// 1. the task window must exist BEFORE getDisplayMedia, or it cannot appear
//    in the browser's share picker, which is the whole reason the launch is
//    two steps rather than one;
// 2. nothing may be awaited between capture going live and the phase flip -
//    that paints an enabled "Start recording" button over a running
//    recording, and startCapture has no re-entrancy guard.

const startCapture = vi.fn();
const openTaskPip = vi.fn();
const openTaskWindow = vi.fn().mockReturnValue(true);

// Unsupported, so the page keeps the whole launch sequence and these tests
// drive the handler directly. Whether the panel opens is another suite's
// subject (ParticipantSessionFlow.open-pane.test.tsx).
vi.mock("../../../lib/recording/task-pip", () => ({
  isTaskPipSupported: () => false,
  useTaskPip: () => ({
    pipWindow: null,
    isSupported: false,
    openTaskPip,
    closeTaskPip: vi.fn()
  })
}));

// status "open" so the launch card offers "Start recording", but isOpen()
// false so the start handler takes its reopen path - which is what puts
// window.open ahead of getDisplayMedia, the rule the share picker depends on.
vi.mock("../../../lib/recording/task-window", () => ({
  useTaskWindow: () => ({
    state: { status: "open", openedUrl: "https://shop.example.com/running" },
    isOpen: () => false,
    openTaskWindow
  })
}));

// Stateful on purpose. A mock pinned at "not_started" leaves the flow looking
// at a running phase with no live recording, which it correctly treats as an
// interrupted attempt and unwinds back to setup - so the runner would never
// stay mounted, and any assertion about it would be racing that unwind.
vi.mock("../../../lib/recording/session-recorder", async () => {
  const React = await import("react");

  return {
    shouldGuardNavigation: () => false,
    useSessionRecorder: () => {
      const [status, setStatus] = React.useState<"not_started" | "active">(
        "not_started"
      );

      return {
        state: {
          recordingStatus: status,
          microphonePermission: "granted",
          screenPermission: "granted",
          recordingStartedAt: status === "active" ? 1_760_000_000_000 : null,
          captureStoppedExternally: false,
          errorMessage: null,
          uploadStatus: "idle",
          uploadProgress: 0,
          uploadedAsset: null
        },
        startCapture: async () => {
          const started = await startCapture();

          if (started) {
            setStatus("active");
          }

          return started;
        },
        stopCaptureAndUpload: vi.fn().mockResolvedValue(null),
        retryUpload: vi.fn().mockResolvedValue(null)
      };
    }
  };
});

vi.mock("../../../lib/recording/setup-checks", () => ({
  collectSetupSnapshot: vi.fn().mockResolvedValue({}),
  assessSetupReadiness: () => ({
    checks: [
      { id: "browser", label: "Chrome works for this session", status: "pass", detail: null }
    ],
    canProceed: true,
    failedChecks: 0,
    warningChecks: 0,
    summary: "You are ready to go. Everything passed"
  })
}));

vi.mock("../../../lib/recording/device-support", () => ({
  assessDeviceSupport: () => ({ canRun: true, reason: null }),
  collectDeviceSnapshot: () => ({})
}));

vi.mock("../../../lib/recording/runtime-client", () => ({
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined),
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined)
}));

// The runner is exercised by its own suite; stubbing it keeps these tests on
// the launch handler and off the whole task machine.
vi.mock("../StudyRunner", () => ({
  StudyRunner: () => <div data-testid="study-runner" />
}));

function payload(token: string, withTarget: boolean): SessionPayload {
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
      session_token: token,
      study_id: "study_1",
      participant_id: "participant_1"
    },
    steps: [
      {
        step_id: "study_1_step_1",
        order: 1,
        type: "instruction",
        prompt: "Find a pair of running shoes under £80.",
        ...(withTarget ? { target_url: "https://shop.example.com/running" } : {})
      }
    ]
  };
}

async function walkToLaunch(token: string, withTarget = true) {
  render(
    <MemoryRouter>
      <ParticipantSessionFlow
        attemptNumber={1}
        directRecordingUploadMode="disabled"
        payload={payload(token, withTarget)}
        token={token}
      />
    </MemoryRouter>
  );

  fireEvent.click(await screen.findByRole("button", { name: "Continue to consent" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "I agree and want to continue" })
  );

  // A study with no task page has no open-then-share sequence: the launch
  // collapses to one button with its own label.
  const startLabel = withTarget ? "Start recording" : "Start recorded study";

  return screen.findByRole("button", { name: startLabel });
}

describe("ParticipantSessionFlow launch ordering", () => {
  beforeEach(() => {
    window.localStorage.clear();
    startCapture.mockReset().mockResolvedValue(true);
    openTaskPip.mockReset().mockResolvedValue(true);
    openTaskWindow.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("springs no window of its own when recording starts", async () => {
    const start = await walkToLaunch("token_no_spring");

    fireEvent.click(start);

    await waitFor(() => {
      expect(startCapture).toHaveBeenCalledTimes(1);
    });
    // The panel is asked for, never sprung - including from here.
    expect(openTaskPip).not.toHaveBeenCalled();
  });

  it("never gates the phase flip on the pane, even if the window never appears", async () => {
    // The regression this pins is CRITICAL: the original code awaited the
    // pane, which suspended the handler with capture already LIVE and the
    // setup card - including an enabled "Start recording" button - still on
    // screen. startCapture has no re-entrancy guard, so a second press there
    // restarts capture and orphans the first recording.
    //
    // A never-resolving open is the honest simulation of a slow or wedged
    // browser API. The session must proceed regardless.
    openTaskPip.mockImplementation(() => new Promise<boolean>(() => {}));

    const start = await walkToLaunch("token_never_resolves");

    fireEvent.click(start);

    await screen.findByTestId("study-runner");
    // And the button that could restart capture is gone with the setup card.
    expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();
  });

  it("opens the task window before capture, so it reaches the share picker", async () => {
    const start = await walkToLaunch("token_ordering");

    fireEvent.click(start);

    await waitFor(() => {
      expect(startCapture).toHaveBeenCalled();
    });

    // The task window must exist BEFORE getDisplayMedia or it cannot appear
    // in the browser's share picker - the rule the whole two-step launch
    // exists to satisfy, and which nothing else asserts.
    expect(openTaskWindow.mock.invocationCallOrder[0]).toBeLessThan(
      startCapture.mock.invocationCallOrder[0]
    );
  });

  it("runs a questionnaire with no task page at all", async () => {
    const start = await walkToLaunch("token_no_target", false);

    fireEvent.click(start);

    // No target means no window to open and nothing to share beside the
    // tasks themselves - the launch collapses to one action.
    await screen.findByTestId("study-runner");
    expect(openTaskWindow).not.toHaveBeenCalled();
  });

  it("does not enter the task phase when capture never starts", async () => {
    startCapture.mockResolvedValue(false);

    const start = await walkToLaunch("token_capture_failed");

    fireEvent.click(start);

    await waitFor(() => {
      expect(startCapture).toHaveBeenCalled();
    });
    // A refused microphone or a cancelled picker must leave the participant
    // on setup, not in a task phase with nothing recording.
    expect(screen.queryByTestId("study-runner")).toBeNull();
  });

  it("still starts the session when the pane is refused", async () => {
    openTaskPip.mockResolvedValue(false);

    const start = await walkToLaunch("token_pane_refused");

    fireEvent.click(start);

    // A refused pane is a degraded experience, never a blocked session: the
    // in-page task card is still there.
    await screen.findByTestId("study-runner");
  });
});
