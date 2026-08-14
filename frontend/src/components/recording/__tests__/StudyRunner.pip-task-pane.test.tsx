import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StudyRunner } from "../StudyRunner";
import type { SessionPayload } from "../../../shared/firsthand/contract";

// The pane itself is owned by ParticipantSessionFlow, which opens it as
// recording starts (see ParticipantSessionFlow.pip-auto-open.test.tsx). What
// the runner owns is what these cover: rendering the live task into whatever
// window it is handed, taking the pane down when the session ends, and
// offering the way back once the participant closes it.

vi.mock("../../../lib/recording/runtime-client", () => ({
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined)
}));

function createFakePipWindow(): Window {
  // Role queries need a document with a defaultView, which a detached
  // createHTMLDocument document lacks - an iframe's document has one.
  const iframe = document.createElement("iframe");

  document.body.appendChild(iframe);

  return {
    document: iframe.contentDocument as Document,
    closed: false,
    close: vi.fn()
  } as unknown as Window;
}

function payload(token: string): SessionPayload {
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
        target_url: "https://shop.example.com/running"
      },
      {
        step_id: "study_1_step_2",
        order: 2,
        type: "open_text",
        prompt: "How easy was that to do?",
        is_required: false,
        target_url: "https://shop.example.com/running"
      }
    ]
  };
}

type RunnerOverrides = {
  onCloseTaskPip?: () => void;
  onOpenTaskPip?: () => Promise<boolean>;
  onComplete?: () => void;
  pipSupported?: boolean;
  pipWindow?: Window | null;
};

function renderRunner(token: string, overrides: RunnerOverrides = {}) {
  return render(
    <StudyRunner
      attemptNumber={1}
      captureStoppedExternally={false}
      microphonePermission="granted"
      payload={payload(token)}
      recordingStartedAt={Date.parse("2026-08-14T10:00:00.000Z")}
      recordingStatus="active"
      screenPermission="granted"
      onComplete={overrides.onComplete ?? vi.fn()}
      onCloseTaskPip={overrides.onCloseTaskPip ?? vi.fn()}
      onOpenTaskPip={overrides.onOpenTaskPip ?? vi.fn().mockResolvedValue(true)}
      onOpenTaskWindow={vi.fn().mockReturnValue(true)}
      pipSupported={overrides.pipSupported ?? true}
      pipWindow={overrides.pipWindow ?? null}
    />
  );
}

const REOPEN_LABEL = /keep tasks on top/i;

describe("StudyRunner floating task pane", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // jsdom has no scrollIntoView; the runner calls it on every task change.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the live task into the pane it is given", async () => {
    const pipWindow = createFakePipWindow();

    renderRunner("token_pane_renders", { pipWindow });

    const pane = await waitFor(() =>
      within(pipWindow.document.body).getByRole("region", {
        name: "Floating task panel"
      })
    );

    expect(within(pane).getByText("Task 1 of 2")).toBeTruthy();
    expect(
      within(pane).getByRole("heading", {
        name: "Find a pair of running shoes under £80."
      })
    ).toBeTruthy();
    // While it is up, the panel says where the tasks went instead of offering
    // to open something already open.
    expect(screen.queryByRole("button", { name: REOPEN_LABEL })).toBeNull();
    expect(screen.getByText(/small window on top/i)).toBeTruthy();
  });

  it("advances the task from inside the pane and shares response state with the page", async () => {
    const pipWindow = createFakePipWindow();

    renderRunner("token_pane_advances", { pipWindow });

    const pipBody = pipWindow.document.body;

    await waitFor(() => {
      within(pipBody).getByText("Task 1 of 2");
    });

    fireEvent.click(
      within(pipBody).getByRole("button", { name: /completed this task/i })
    );

    await waitFor(() => {
      within(pipBody).getByText("Task 2 of 2");
    });
    within(pipBody).getByRole("heading", { name: "How easy was that to do?" });

    // One controlled state, two views: typing in the pane must show up in the
    // in-page card too.
    fireEvent.change(
      within(pipBody).getByPlaceholderText("Type your response here"),
      { target: { value: "Really easy" } }
    );

    const pageInputs = screen.getAllByPlaceholderText("Type your response here");

    expect(pageInputs.length).toBeGreaterThan(0);

    for (const input of pageInputs) {
      expect((input as HTMLTextAreaElement).value).toBe("Really easy");
    }
  });

  it("takes the pane down when the session completes", async () => {
    const pipWindow = createFakePipWindow();
    const onCloseTaskPip = vi.fn();
    const onComplete = vi.fn();

    renderRunner("token_pane_session_done", {
      onCloseTaskPip,
      onComplete,
      pipWindow
    });

    const pipBody = pipWindow.document.body;

    await waitFor(() => {
      within(pipBody).getByText("Task 1 of 2");
    });

    fireEvent.click(
      within(pipBody).getByRole("button", { name: /completed this task/i })
    );
    await waitFor(() => {
      within(pipBody).getByText("Task 2 of 2");
    });

    // The answer step is optional, so it completes without a response.
    fireEvent.click(
      within(pipBody).getByRole("button", { name: /completed this task/i })
    );

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
    expect(onCloseTaskPip).toHaveBeenCalled();
  });

  it("offers the way back once the participant has closed the pane", async () => {
    const onOpenTaskPip = vi.fn().mockResolvedValue(true);

    renderRunner("token_pane_reopen", { onOpenTaskPip, pipWindow: null });

    fireEvent.click(await screen.findByRole("button", { name: REOPEN_LABEL }));

    await waitFor(() => {
      expect(onOpenTaskPip).toHaveBeenCalledTimes(1);
    });
  });

  it("says so, without blocking the session, when the pane will not reopen", async () => {
    const onOpenTaskPip = vi.fn().mockResolvedValue(false);

    renderRunner("token_pane_reopen_failed", { onOpenTaskPip, pipWindow: null });

    fireEvent.click(await screen.findByRole("button", { name: REOPEN_LABEL }));

    expect(await screen.findByText(/that window would not open/i)).toBeTruthy();
    // The in-page task card is still fully usable underneath.
    expect(
      screen.getByRole("button", { name: /completed this task/i })
    ).toBeTruthy();
  });

  it("offers no pane control at all where Document PiP is unsupported", async () => {
    renderRunner("token_pane_unsupported", {
      pipSupported: false,
      pipWindow: null
    });

    await screen.findByRole("region", { name: "Task page" });

    expect(screen.queryByRole("button", { name: REOPEN_LABEL })).toBeNull();
  });
});
