import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StudyRunner } from "../StudyRunner";
import type { SessionPayload } from "../../../shared/firsthand/contract";

// Sessions record screen and voice, so participants answer OUT LOUD. A typed
// response box invited them to stop talking and type - the opposite of
// think-aloud - so the runtime captures nothing typed, whatever a step's
// stored type says.
//
// Authoring stopped OFFERING the typed types earlier; this is the other half.
// Studies written before that still hold open_text and single_choice steps,
// and leaving those to render an input made the experience depend on when the
// study happened to be written.

vi.mock("../../../lib/recording/runtime-client", () => ({
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined)
}));

function createFakePipWindow(): Window {
  const iframe = document.createElement("iframe");

  document.body.appendChild(iframe);

  return {
    document: iframe.contentDocument as Document,
    closed: false,
    close: vi.fn()
  } as unknown as Window;
}

// A legacy study: a REQUIRED open_text step and a single_choice step, exactly
// what the authoring form used to produce.
function legacyPayload(): SessionPayload {
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
      session_token: "token_spoken",
      study_id: "study_1",
      participant_id: "participant_1"
    },
    steps: [
      {
        step_id: "study_1_step_1",
        order: 1,
        type: "open_text",
        prompt: "How easy was that to do?",
        is_required: true,
        target_url: "https://shop.example.com/running"
      },
      {
        step_id: "study_1_step_2",
        order: 2,
        type: "single_choice",
        prompt: "Rate the experience",
        options: ["Good", "Bad"],
        target_url: "https://shop.example.com/running"
      }
    ]
  };
}

function renderRunner(pipWindow: Window | null) {
  return render(
    <StudyRunner
      attemptNumber={1}
      captureStoppedExternally={false}
      microphonePermission="granted"
      payload={legacyPayload()}
      recordingStartedAt={Date.parse("2026-08-16T10:00:00.000Z")}
      recordingStatus="active"
      screenPermission="granted"
      onComplete={vi.fn()}
      onCloseTaskPip={vi.fn()}
      onOpenTaskPip={vi.fn().mockResolvedValue(true)}
      onOpenTaskWindow={vi.fn().mockReturnValue(true)}
      pipSupported
      pipWindow={pipWindow}
    />
  );
}

describe("StudyRunner spoken answers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("offers no typed input in the panel, even for a legacy open_text step", async () => {
    const pipWindow = createFakePipWindow();

    renderRunner(pipWindow);

    const pane = await waitFor(() =>
      within(pipWindow.document.body).getByRole("region", {
        name: "Floating task panel"
      })
    );

    expect(within(pane).getByText("How easy was that to do?")).toBeTruthy();
    expect(within(pane).queryByRole("textbox")).toBeNull();
    expect(
      within(pane).queryByPlaceholderText("Type your response here")
    ).toBeNull();
  });

  it("offers no choice control in the panel for a legacy single_choice step", async () => {
    const pipWindow = createFakePipWindow();

    renderRunner(pipWindow);

    const pane = await waitFor(() =>
      within(pipWindow.document.body).getByRole("region", {
        name: "Floating task panel"
      })
    );

    fireEvent.click(
      within(pane).getByRole("button", { name: /completed this task/i })
    );

    await waitFor(() => {
      expect(within(pane).getByText("Rate the experience")).toBeTruthy();
    });
    expect(within(pane).queryByRole("radio")).toBeNull();
    expect(within(pane).queryByText("Good")).toBeNull();
  });

  it("lets a REQUIRED legacy step be completed with nothing typed", async () => {
    // The trap: validateStepResponse blocked completion when a required
    // answerable step had no answer. Remove the input without removing that
    // and the participant is stuck on the task forever, being recorded.
    const pipWindow = createFakePipWindow();

    renderRunner(pipWindow);

    const pane = await waitFor(() =>
      within(pipWindow.document.body).getByRole("region", {
        name: "Floating task panel"
      })
    );

    fireEvent.click(
      within(pane).getByRole("button", { name: /completed this task/i })
    );

    await waitFor(() => {
      expect(within(pane).getByText("Rate the experience")).toBeTruthy();
    });
    expect(within(pane).queryByRole("alert")).toBeNull();
  });

  it("offers no typed input in the page either", () => {
    renderRunner(null);

    expect(screen.getByText("How easy was that to do?")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    // And no leftover instruction telling them to type something absent.
    expect(screen.queryByText(/Type your answer below/i)).toBeNull();
    expect(screen.queryByText(/This one is optional/i)).toBeNull();
  });
});
