import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import type { SessionPayload } from "../../../shared/firsthand/contract";

// The floating pane opens on the CONSENT click - the last click that opens
// nothing else. One click carries one transient activation, and both
// window.open and requestWindow consume it, so pane-plus-popup off a single
// click is impossible (verified live in Chrome, both orders, 2026-08-16).
// Until recording starts the pane is a standby card: trust header, recording
// state and where to go next. It must never show a task - tasks are revealed
// only once recording is live.

const openTaskWindow = vi.fn().mockReturnValue(true);
const startCapture = vi.fn();

// Stateful pane mock: openTaskPip "opens" a real document (an iframe's, so
// portals get a defaultView) and pipWindow flows back into the component the
// way the real hook's state does.
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

// Stateful like the real hook: opening the task page flips status to "open",
// which is what arms the standby card's start button. Set
// taskWindowBlocksNext to walk the pop-up-blocked path instead.
let taskWindowBlocksNext = false;

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
          if (taskWindowBlocksNext) {
            setStatus("blocked");

            return false;
          }
          setStatus("open");

          return true;
        }),
        closeTaskWindow: vi.fn()
      };
    }
  };
});

// Stateful: success flips to active (so StudyRunner stays mounted for the
// handover test), failure lands the error message the pane must surface.
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
        stopCaptureAndUpload: vi.fn().mockResolvedValue(null),
        retryUpload: vi.fn().mockResolvedValue(null)
      };
    }
  };
});

// Configurable so a test can flip the checks to failing mid-flow (mic
// unplugged, then "Check again") and observe the pane's gating respond.
let setupCanProceed = true;

vi.mock("../../../lib/recording/setup-checks", () => ({
  collectSetupSnapshot: vi.fn().mockResolvedValue({}),
  assessSetupReadiness: () => ({
    checks: [
      {
        id: "microphone",
        label: "A microphone is ready",
        status: setupCanProceed ? "pass" : "fail",
        detail: null
      }
    ],
    canProceed: setupCanProceed,
    failedChecks: setupCanProceed ? 0 : 1,
    warningChecks: 0,
    summary: setupCanProceed
      ? "You are ready to go. Everything passed"
      : "A microphone is needed before you can start"
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
      session_token: "token_standby",
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

async function walkToLaunch() {
  render(
    <MemoryRouter>
      <ParticipantSessionFlow
        attemptNumber={1}
        directRecordingUploadMode={null}
        payload={payload()}
        token="token_standby"
      />
    </MemoryRouter>
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "Continue to consent" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "I agree and want to continue" })
  );

  // The panel is asked for, not sprung: the setup step carries a control for
  // it, and only once it is up does the page hand the launch sequence over.
  fireEvent.click(
    await screen.findByRole("button", { name: "Open the task window" })
  );

  await waitFor(() => {
    expect(pipHost?.contentDocument?.body.textContent).toContain(
      "Not recording"
    );
  });

  return within(pipHost!.contentDocument!.body);
}

describe("ParticipantSessionFlow pane standby", () => {
  beforeEach(() => {
    setupCanProceed = true;
    taskWindowBlocksNext = false;
    window.localStorage.clear();
    openTaskWindow.mockClear();
    openTaskPip.mockClear();
    startCapture.mockReset().mockResolvedValue(true);
    Element.prototype.scrollIntoView = vi.fn();

    pipHost?.remove();
    pipHost = document.createElement("iframe");
    document.body.appendChild(pipHost);
  });

  it("opens on its own control, and the page hands over once it is up", async () => {
    await walkToLaunch();

    // The page shows no rival set of launch buttons beside the panel's.
    expect(
      screen.queryByRole("button", { name: "Open the task page" })
    ).toBeNull();
    expect(
      screen.getByText(/controls are in the floating panel/i)
    ).toBeInTheDocument();

    // One panel, asked for once, and no popup yet.
    expect(openTaskPip).toHaveBeenCalledTimes(1);
    expect(openTaskWindow).not.toHaveBeenCalled();
  });

  it("spends the open-task-page click on the popup alone", async () => {
    const pane = await walkToLaunch();

    openTaskPip.mockClear();
    fireEvent.click(pane.getByRole("button", { name: "Open the task page" }));

    // One click, one transient activation: window.open must be the only
    // consumer here, or the popup gets blocked (seen live).
    expect(openTaskWindow).toHaveBeenCalledWith(
      "https://shop.example.com/running"
    );
    expect(openTaskPip).not.toHaveBeenCalled();
  });

  it("shows a standby card in the pane - recording state and no tasks", async () => {
    await walkToLaunch();

    const paneText = pipHost?.contentDocument?.body.textContent ?? "";

    // The non-authorable brand, the study title (below the strip) - and the
    // tasks stay hidden until recording is live.
    expect(paneText).toContain("Cortex");
    expect(paneText).toContain("Checkout walkthrough");
    expect(paneText).not.toContain(PROMPT);
  });

  it("walks the launch sequence inside the pane: open the page, then start", async () => {
    const pane = await walkToLaunch();

    // Before the task page exists the pane offers only the open action -
    // starting now would put a picker in front of someone with nothing to
    // share.
    expect(
      pane.queryByRole("button", { name: "Start recording" })
    ).toBeNull();

    fireEvent.click(pane.getByRole("button", { name: "Open the task page" }));

    expect(openTaskWindow).toHaveBeenCalledWith(
      "https://shop.example.com/running"
    );

    // The same button slot now carries the start action.
    await waitFor(() => {
      expect(
        pane.getByRole("button", { name: "Start recording" })
      ).toBeEnabled();
    });
    expect(
      pane.queryByRole("button", { name: "Open the task page" })
    ).toBeNull();
  });

  it("disarms the pane's start button when the checks stop passing", async () => {
    const pane = await walkToLaunch();

    fireEvent.click(pane.getByRole("button", { name: "Open the task page" }));

    await waitFor(() => {
      expect(
        pane.getByRole("button", { name: "Start recording" })
      ).toBeEnabled();
    });

    // The microphone goes away; the participant re-runs the checks from the
    // Cortex page. The pane's start button must disarm with them - it can
    // never start what the page's own button could not.
    setupCanProceed = false;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(
        pane.getByRole("button", { name: "Start recording" })
      ).toBeDisabled();
    });
    expect(pane.getByText(/Waiting for the setup checks/)).toBeInTheDocument();
  });

  it("shows the blocked-pop-up recovery inside the pane", async () => {
    const pane = await walkToLaunch();

    taskWindowBlocksNext = true;
    fireEvent.click(pane.getByRole("button", { name: "Open the task page" }));

    // The failure and its remedy must render HERE - the Cortex tab's banner
    // is behind the task window, which is the exact place the participant
    // has stopped looking.
    await waitFor(() => {
      expect(pane.getByText(/blocked the pop-up/)).toBeInTheDocument();
    });
    // And the retry affordance is still in front of them.
    expect(
      pane.getByRole("button", { name: "Open the task page" })
    ).toBeEnabled();
  });

  it("surfaces a failed capture inside the pane", async () => {
    startCapture.mockResolvedValue(false);

    const pane = await walkToLaunch();

    fireEvent.click(pane.getByRole("button", { name: "Open the task page" }));
    await waitFor(() => {
      expect(
        pane.getByRole("button", { name: "Start recording" })
      ).toBeEnabled();
    });
    fireEvent.click(pane.getByRole("button", { name: "Start recording" }));

    // A denied mic prompt must not silently return the card to its idle
    // state: the participant would loop on it forever with the explanation
    // hidden in the Cortex tab.
    await waitFor(() => {
      expect(pane.getByRole("alert")).toHaveTextContent(
        /Recording could not start/
      );
    });
    expect(pane.getByText(/microphone/)).toBeInTheDocument();
  });

  it("hands the pane over to the task card once recording is live", async () => {
    const pane = await walkToLaunch();

    fireEvent.click(pane.getByRole("button", { name: "Open the task page" }));
    await waitFor(() => {
      expect(
        pane.getByRole("button", { name: "Start recording" })
      ).toBeEnabled();
    });
    fireEvent.click(pane.getByRole("button", { name: "Start recording" }));

    // The riskiest seam on the branch: two portals, one pane body, exclusive
    // conditions. The standby card must give way to the real task card.
    await waitFor(() => {
      expect(pane.getByText(PROMPT)).toBeInTheDocument();
    });
    expect(
      pane.queryByText(/will appear here once recording starts/)
    ).toBeNull();
  });

  it("starts capture from the pane's own button", async () => {
    const pane = await walkToLaunch();

    fireEvent.click(pane.getByRole("button", { name: "Open the task page" }));

    await waitFor(() => {
      expect(
        pane.getByRole("button", { name: "Start recording" })
      ).toBeEnabled();
    });

    fireEvent.click(pane.getByRole("button", { name: "Start recording" }));

    await waitFor(() => {
      expect(startCapture).toHaveBeenCalledTimes(1);
    });
  });
});
