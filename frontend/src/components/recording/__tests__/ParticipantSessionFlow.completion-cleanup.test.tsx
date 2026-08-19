import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import type { SessionPayload } from "../../../shared/firsthand/contract";

// finishSession only ever closes the pane (see StudyRunner.pip-task-pane.test
// for that half). The task window - the target site the participant was
// working in - is a SEPARATE window this flow owns, and it is only safe to
// close from the genuine-completion branch of onComplete: closing it from
// the recorder-failure branch would end a still-live shared capture and
// resurrect an attempt that was just abandoned (see the comment beside
// taskWindow.closeTaskWindow() in ParticipantSessionFlow). These tests pin
// that: closed on real completion, left alone when the recorder has failed.

const openTaskWindow = vi.fn().mockReturnValue(true);
const closeTaskWindow = vi.fn();
const stopCaptureAndUpload = vi.fn().mockResolvedValue(null);
const startCapture = vi.fn();

let pipHost: HTMLIFrameElement | null = null;
const openTaskPip = vi.fn();

vi.mock("../../../lib/recording/task-pip", async () => {
  const React = await import("react");

  return {
    isTaskPipSupported: () => true,
    useTaskPip: () => {
      const [pipWindow, setPipWindow] = React.useState<Window | null>(null);

      return {
        pipWindow,
        isSupported: true,
        openTaskPip: openTaskPip.mockImplementation(async () => {
          setPipWindow(pipHost?.contentWindow ?? null);

          return true;
        }),
        closeTaskPip: vi.fn()
      };
    }
  };
});

vi.mock("../../../lib/recording/task-window", async () => {
  const React = await import("react");

  return {
    useTaskWindow: () => {
      const [status, setStatus] = React.useState<"idle" | "open" | "blocked">(
        "idle"
      );

      return {
        state: { status, openedUrl: null },
        isOpen: () => status === "open",
        openTaskWindow: openTaskWindow.mockImplementation(() => {
          setStatus("open");

          return true;
        }),
        closeTaskWindow
      };
    }
  };
});

// recordingStatus is controlled from outside the mock (via failNext) so a
// test can walk to a live recording, then flip to "failed" the way a
// mid-session MediaRecorder error would, before completing the task.
let failNext = false;

vi.mock("../../../lib/recording/session-recorder", async () => {
  const React = await import("react");

  const initial = {
    recordingStatus: "not_started" as const,
    microphonePermission: "not_requested" as const,
    screenPermission: "not_requested" as const,
    recordingStartedAt: null as number | null,
    captureStoppedExternally: false,
    errorMessage: null as string | null,
    uploadStatus: "idle" as const,
    uploadProgress: 0,
    uploadedAsset: null
  };

  return {
    shouldGuardNavigation: () => false,
    useSessionRecorder: () => {
      const [state, setState] = React.useState(initial);

      React.useEffect(() => {
        if (failNext && state.recordingStatus === "active") {
          setState((current) => ({
            ...current,
            recordingStatus: "failed",
            errorMessage: "The recording stopped unexpectedly."
          }));
        }
      }, [state.recordingStatus]);

      return {
        state,
        startCapture: async () => {
          const started = await startCapture();

          setState((current) =>
            started
              ? {
                  ...current,
                  recordingStatus: "active",
                  microphonePermission: "granted",
                  screenPermission: "granted",
                  recordingStartedAt: 1_760_000_000_000
                }
              : {
                  ...current,
                  recordingStatus: "failed",
                  errorMessage:
                    "We need your microphone to record this session."
                }
          );

          return started;
        },
        stopCaptureAndUpload,
        retryUpload: vi.fn().mockResolvedValue(null)
      };
    }
  };
});

vi.mock("../../../lib/recording/setup-checks", () => ({
  collectSetupSnapshot: vi.fn().mockResolvedValue({}),
  assessSetupReadiness: () => ({
    checks: [
      {
        id: "microphone",
        label: "A microphone is ready",
        status: "pass",
        detail: null
      }
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

vi.mock("../../../lib/recording/runtime-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined),
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined)
}));

const PROMPT = "Find a pair of running shoes under £80.";
const TOKEN = "token_completion_cleanup";

// A single task: the "completed this task" click both answers the last step
// and finishes the whole session in one action.
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
        prompt: PROMPT,
        target_url: "https://shop.example.com/running"
      }
    ]
  };
}

async function walkToRecording() {
  render(
    <MemoryRouter>
      <ParticipantSessionFlow
        attemptNumber={1}
        directRecordingUploadMode={null}
        payload={payload()}
        token={TOKEN}
      />
    </MemoryRouter>
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "Continue to consent" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "I agree and want to continue" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Open the task window" })
  );

  await waitFor(() => {
    expect(pipHost?.contentDocument?.body.textContent).toContain(
      "Not recording"
    );
  });

  const pane = within(pipHost!.contentDocument!.body);

  fireEvent.click(pane.getByRole("button", { name: "Open the task page" }));
  await waitFor(() => {
    expect(pane.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });
  fireEvent.click(pane.getByRole("button", { name: "Start recording" }));

  await waitFor(() => {
    expect(pane.getByText(PROMPT)).toBeInTheDocument();
  });

  return pane;
}

describe("ParticipantSessionFlow completion cleanup", () => {
  beforeEach(() => {
    failNext = false;
    window.localStorage.clear();
    openTaskWindow.mockClear();
    closeTaskWindow.mockClear();
    stopCaptureAndUpload.mockClear();
    openTaskPip.mockClear();
    startCapture.mockReset().mockResolvedValue(true);
    Element.prototype.scrollIntoView = vi.fn();

    pipHost?.remove();
    pipHost = document.createElement("iframe");
    document.body.appendChild(pipHost);
  });

  it("closes the task window once the session genuinely completes", async () => {
    const pane = await walkToRecording();

    fireEvent.click(
      pane.getByRole("button", { name: /completed this task/i })
    );

    await waitFor(() => {
      expect(closeTaskWindow).toHaveBeenCalledTimes(1);
    });

    // The order matters: the stop must already be in flight (its guard set,
    // recorder.stop() called) before the window closes, or a participant
    // sharing the task window itself would end the capture via the window's
    // own close instead of the deliberate stop path.
    expect(stopCaptureAndUpload.mock.invocationCallOrder[0]).toBeLessThan(
      closeTaskWindow.mock.invocationCallOrder[0]
    );
  });

  it("leaves the task window open when the recorder has failed", async () => {
    failNext = true;

    const pane = await walkToRecording();

    await waitFor(() => {
      expect(
        pane.getByText(/recording has stopped|stopped unexpectedly/i)
      ).toBeInTheDocument();
    });

    fireEvent.click(
      pane.getByRole("button", { name: /completed this task/i })
    );

    await waitFor(() => {
      expect(
        screen.getByText(/your last attempt was interrupted/i)
      ).toBeInTheDocument();
    });

    expect(closeTaskWindow).not.toHaveBeenCalled();
    expect(stopCaptureAndUpload).not.toHaveBeenCalled();
  });
});
