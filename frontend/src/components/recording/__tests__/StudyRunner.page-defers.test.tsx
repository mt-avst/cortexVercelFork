import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StudyRunner } from "../StudyRunner";
import type { SessionPayload } from "@shared/firsthand/contract";

// Once the participant is working in the floating pane over the task window,
// they never look at the Cortex page again - so a full second copy of the
// task there is dead weight that can also drift out of sync. The page defers
// to the pane while it is live.
//
// DEFERS, never deletes: pipWindow is null on Firefox and Safari (no Document
// PiP), when the pane is refused, and the instant the participant closes it -
// and in each case the page is the ONLY surface the task exists on.

vi.mock("../../../lib/recording/runtime-client", () => ({
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined)
}));

const PROMPT = "Find a pair of running shoes under £80.";

function createFakePipWindow(): Window {
  const iframe = document.createElement("iframe");

  document.body.appendChild(iframe);

  return {
    document: iframe.contentDocument as Document,
    closed: false,
    close: vi.fn()
  } as unknown as Window;
}

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
      session_token: "token_defers",
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

function renderRunner(pipWindow: Window | null, pipSupported = true) {
  return render(
    <StudyRunner
      attemptNumber={1}
      captureStoppedExternally={false}
      microphonePermission="granted"
      payload={payload()}
      recordingStartedAt={Date.parse("2026-08-16T10:00:00.000Z")}
      recordingStatus="active"
      screenPermission="granted"
      onComplete={vi.fn()}
      onCloseTaskPip={vi.fn()}
      onOpenTaskPip={vi.fn().mockResolvedValue(true)}
      onOpenTaskWindow={vi.fn().mockReturnValue(true)}
      pipSupported={pipSupported}
      pipWindow={pipWindow}
    />
  );
}

describe("StudyRunner page defers to the pane", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("drops the in-page task copy while the pane is live", async () => {
    const pipWindow = createFakePipWindow();

    renderRunner(pipWindow);

    await waitFor(() => {
      expect(
        within(pipWindow.document.body).getByText(PROMPT)
      ).toBeInTheDocument();
    });

    // The page keeps no second prompt and no second complete button - the
    // pane is the control surface now.
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /completed this task/i })
    ).toBeNull();
  });

  it("still says where the task went, and keeps recording state visible", async () => {
    const pipWindow = createFakePipWindow();

    renderRunner(pipWindow);

    await waitFor(() => {
      expect(screen.getByText(/floating panel/i)).toBeInTheDocument();
    });

    // Recording state is a security signal, not a control: it stays on the
    // page even while the page is deferring. toBeVisible, not
    // toBeInTheDocument - getByText matches hidden nodes, so the weaker
    // assertion passed against a build that hid the callout entirely.
    expect(screen.getByText("Recording is live")).toBeVisible();
  });

  it("renders the whole task in the page when there is no pane", () => {
    // Firefox and Safari never get a pane. The page must be complete there.
    renderRunner(null, false);

    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /completed this task/i })
    ).toBeInTheDocument();
  });

  it("takes the task back the moment the participant closes the pane", async () => {
    const pipWindow = createFakePipWindow();

    const { rerender } = renderRunner(pipWindow);

    await waitFor(() => {
      expect(screen.queryByText(PROMPT)).toBeNull();
    });

    // The pane has an X in its own title bar. Closing it nulls pipWindow -
    // and if the page did not take the task back, the participant would be
    // left recording with no task and no way to complete it.
    rerender(
      <StudyRunner
        attemptNumber={1}
        captureStoppedExternally={false}
        microphonePermission="granted"
        payload={payload()}
        recordingStartedAt={Date.parse("2026-08-16T10:00:00.000Z")}
        recordingStatus="active"
        screenPermission="granted"
        onComplete={vi.fn()}
        onCloseTaskPip={vi.fn()}
        onOpenTaskPip={vi.fn().mockResolvedValue(true)}
        onOpenTaskWindow={vi.fn().mockReturnValue(true)}
        pipSupported
        pipWindow={null}
      />
    );

    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /completed this task/i })
    ).toBeInTheDocument();
  });
});
