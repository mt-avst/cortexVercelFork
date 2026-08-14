import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import type { SessionPayload } from "../../../shared/firsthand/contract";

// The floating task pane must be opened from the start handler, inside the
// user activation that the "Start recording" click created. Document PiP
// refuses to open without one, and no later moment - an effect after the phase
// flip, or the runner mounting - still carries it. These tests pin that.

const startCapture = vi.fn();
const openTaskPip = vi.fn();
const openTaskWindow = vi.fn().mockReturnValue(true);

vi.mock("../../../lib/recording/task-pip", () => ({
  useTaskPip: () => ({
    pipWindow: null,
    isSupported: true,
    openTaskPip,
    closeTaskPip: vi.fn()
  })
}));

vi.mock("../../../lib/recording/task-window", () => ({
  useTaskWindow: () => ({
    state: { status: "open", openedUrl: "https://shop.example.com/running" },
    isOpen: () => true,
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

describe("ParticipantSessionFlow floating pane auto-open", () => {
  beforeEach(() => {
    window.localStorage.clear();
    startCapture.mockReset().mockResolvedValue(true);
    openTaskPip.mockReset().mockResolvedValue(true);
    openTaskWindow.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("opens the pane for the participant once recording starts", async () => {
    const start = await walkToLaunch("token_auto_open");

    fireEvent.click(start);

    await waitFor(() => {
      expect(openTaskPip).toHaveBeenCalledTimes(1);
    });
    // Nothing was pressed to ask for it: capture start is the only trigger.
    expect(startCapture).toHaveBeenCalledTimes(1);
  });

  it("opens the pane inside the start handler, before the runner mounts", async () => {
    // Record what the DOM looked like AT THE MOMENT the pane was asked for,
    // rather than after the fact - the phase flip lands within the same tick,
    // so an assertion made afterwards races it.
    let runnerMountedWhenPaneOpened: boolean | null = null;

    openTaskPip.mockImplementation(async () => {
      runnerMountedWhenPaneOpened = Boolean(
        document.querySelector('[data-testid="study-runner"]')
      );

      return true;
    });

    const start = await walkToLaunch("token_ordering");

    fireEvent.click(start);

    await waitFor(() => {
      expect(openTaskPip).toHaveBeenCalled();
    });

    // The activation-critical ordering: capture first (its prompts are what
    // the gesture is spent on), then the pane, and only then the phase flip
    // that mounts the runner. If the pane moved after the flip it would be
    // outside the activation and would be refused.
    expect(startCapture.mock.invocationCallOrder[0]).toBeLessThan(
      openTaskPip.mock.invocationCallOrder[0]
    );
    expect(runnerMountedWhenPaneOpened).toBe(false);

    await screen.findByTestId("study-runner");
  });

  it("does not open a pane for a study with no task page", async () => {
    const start = await walkToLaunch("token_no_target", false);

    fireEvent.click(start);

    await screen.findByTestId("study-runner");
    // A questionnaire has nothing to float over: the tasks are already the
    // only thing on screen.
    expect(openTaskPip).not.toHaveBeenCalled();
  });

  it("does not open a pane when capture never starts", async () => {
    startCapture.mockResolvedValue(false);

    const start = await walkToLaunch("token_capture_failed");

    fireEvent.click(start);

    await waitFor(() => {
      expect(startCapture).toHaveBeenCalled();
    });
    expect(openTaskPip).not.toHaveBeenCalled();
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
