import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import type { SessionPayload } from "../../../shared/firsthand/contract";

// The floating panel is ASKED FOR, never sprung. It used to open on the
// consent click, which meant a chrome-less always-on-top window appeared
// over everything the moment consent was given, with nothing having been
// pressed to summon it. Step 3 now carries an explicit control.
//
// Each window still gets its own click, which is the hard platform
// constraint: one click carries one transient activation and both
// window.open and requestWindow consume it.

let pipHost: HTMLIFrameElement | null = null;
let pipSupported = true;
let paneOpenSucceeds = true;
const openTaskPip = vi.fn();
const openTaskWindow = vi.fn().mockReturnValue(true);

vi.mock("../../../lib/recording/task-pip", async () => {
  const React = await import("react");

  return {
    isTaskPipSupported: () => pipSupported,
    useTaskPip: () => {
      const [pipWindow, setPipWindow] = React.useState<Window | null>(null);

      return {
        pipWindow,
        isSupported: pipSupported,
        openTaskPip: openTaskPip.mockImplementation(async () => {
          if (!paneOpenSucceeds) {
            return false;
          }
          setPipWindow(pipHost?.contentWindow ?? null);

          return true;
        }),
        closeTaskPip: vi.fn()
      };
    }
  };
});

vi.mock("../../../lib/recording/task-window", () => ({
  useTaskWindow: () => ({
    state: { status: "idle", openedUrl: null },
    isOpen: () => false,
    openTaskWindow
  })
}));

vi.mock("../../../lib/recording/session-recorder", () => ({
  shouldGuardNavigation: () => false,
  useSessionRecorder: () => ({
    state: {
      recordingStatus: "not_started",
      microphonePermission: "not_requested",
      screenPermission: "not_requested",
      recordingStartedAt: null,
      captureStoppedExternally: false,
      errorMessage: null,
      uploadStatus: "idle",
      uploadProgress: 0,
      uploadedAsset: null
    },
    startCapture: vi.fn().mockResolvedValue(true),
    stopCaptureAndUpload: vi.fn().mockResolvedValue(null),
    retryUpload: vi.fn().mockResolvedValue(null)
  })
}));

vi.mock("../../../lib/recording/setup-checks", () => ({
  collectSetupSnapshot: vi.fn().mockResolvedValue({}),
  assessSetupReadiness: () => ({
    checks: [
      {
        id: "browser",
        label: "Chrome works for this session",
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
      session_token: "token_open_pane",
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

const OPEN_PANE = "Open the task window";

async function walkToSetup() {
  render(
    <MemoryRouter>
      <ParticipantSessionFlow
        attemptNumber={1}
        directRecordingUploadMode="disabled"
        payload={payload()}
        token="token_open_pane"
      />
    </MemoryRouter>
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "Continue to consent" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "I agree and want to continue" })
  );
}

describe("ParticipantSessionFlow opening the task window", () => {
  beforeEach(() => {
    window.localStorage.clear();
    pipSupported = true;
    paneOpenSucceeds = true;
    openTaskPip.mockClear();
    openTaskWindow.mockClear();
    Element.prototype.scrollIntoView = vi.fn();

    pipHost?.remove();
    pipHost = document.createElement("iframe");
    document.body.appendChild(pipHost);
  });

  it("springs no window on the consent click", async () => {
    await walkToSetup();

    await screen.findByRole("button", { name: OPEN_PANE });

    // Consent advances the flow and nothing else. An always-on-top window
    // appearing unbidden over every application is not something to do to
    // someone without them pressing for it.
    expect(openTaskPip).not.toHaveBeenCalled();
  });

  it("opens the panel when the participant asks for it", async () => {
    await walkToSetup();

    fireEvent.click(await screen.findByRole("button", { name: OPEN_PANE }));

    await waitFor(() => {
      expect(openTaskPip).toHaveBeenCalledTimes(1);
    });

    // And the panel arrives carrying the launch sequence.
    await waitFor(() => {
      expect(
        within(pipHost!.contentDocument!.body).getByRole("button", {
          name: "Open the task page"
        })
      ).toBeInTheDocument();
    });
  });

  it("hands over to the panel once it is up", async () => {
    await walkToSetup();

    fireEvent.click(await screen.findByRole("button", { name: OPEN_PANE }));

    await waitFor(() => {
      expect(
        screen.getByText(/controls are in the floating panel/i)
      ).toBeInTheDocument();
    });
    // The page stops offering to open a panel that is already open.
    expect(screen.queryByRole("button", { name: OPEN_PANE })).toBeNull();
  });

  it("keeps the whole sequence on the page where there is no panel", async () => {
    // Firefox and Safari have no Document PiP: offering to open one would be
    // a button that can never work.
    pipSupported = false;

    await walkToSetup();

    expect(
      await screen.findByRole("button", { name: "Open the task page" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: OPEN_PANE })).toBeNull();
  });

  it("falls back to the page when the panel is refused", async () => {
    paneOpenSucceeds = false;

    await walkToSetup();

    fireEvent.click(await screen.findByRole("button", { name: OPEN_PANE }));

    // A refused panel must not leave the participant pressing a dead button:
    // the page takes the launch sequence back.
    expect(
      await screen.findByRole("button", { name: "Open the task page" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: OPEN_PANE })).toBeNull();
  });
});
