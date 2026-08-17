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
  captureStoppedExternally?: boolean;
  onCloseTaskPip?: () => void;
  onOpenTaskPip?: () => Promise<boolean>;
  onComplete?: () => void;
  pipSupported?: boolean;
  pipWindow?: Window | null;
  recordingStatus?: "active" | "stopped";
};

function renderRunner(token: string, overrides: RunnerOverrides = {}) {
  return render(
    <StudyRunner
      attemptNumber={1}
      captureStoppedExternally={overrides.captureStoppedExternally ?? false}
      microphonePermission="granted"
      payload={payload(token)}
      recordingStartedAt={Date.parse("2026-08-14T10:00:00.000Z")}
      recordingStatus={overrides.recordingStatus ?? "active"}
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
    // While it is up, the page defers entirely - no rival copy of the task,
    // and no reopen offer for something already open.
    expect(screen.queryByRole("button", { name: REOPEN_LABEL })).toBeNull();
    expect(screen.getByText(/floating panel/i)).toBeTruthy();
    // The task-window recovery moved INTO the pane with the task, because the
    // page is what the participant has stopped looking at.
    expect(
      within(pane).getByRole("button", { name: /bring the task page back/i })
    ).toBeTruthy();
  });

  it("advances the task from inside the pane and shares response state with the page", async () => {
    const pipWindow = createFakePipWindow();

    const { rerender } = renderRunner("token_pane_advances", { pipWindow });

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

    // ONE controlled state, rendered wherever the participant is - never a
    // copy. Answers are spoken now, so the state that has to survive is the
    // POSITION: advance in the panel, close it, and the page must pick up on
    // the same task rather than sending them back to the first one.
    rerender(
      <StudyRunner
        attemptNumber={1}
        captureStoppedExternally={false}
        microphonePermission="granted"
        payload={payload("token_pane_advances")}
        recordingStartedAt={Date.parse("2026-08-14T10:00:00.000Z")}
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

    expect(
      await screen.findByRole("heading", { name: "How easy was that to do?" })
    ).toBeInTheDocument();
    expect(screen.getByText("Task 2 of 2")).toBeInTheDocument();
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

  it("carries a non-authorable trust header the researcher cannot spoof", async () => {
    // The pane has no browser chrome and the prompt is researcher-authored, so
    // without this a one-step study is a bare window containing someone else's
    // sentence, an input and a button, floating over everything and looking
    // like it came from Cortex.
    const pipWindow = createFakePipWindow();

    renderRunner("token_pane_trust", { pipWindow });

    const pane = await waitFor(() =>
      within(pipWindow.document.body).getByRole("region", {
        name: "Floating task panel"
      })
    );

    expect(within(pane).getByText("Cortex")).toBeTruthy();
    expect(within(pane).getByText("Checkout walkthrough")).toBeTruthy();
    expect(within(pane).getByText(/^Recording$/)).toBeTruthy();
  });

  it("warns inside the pane when the recording has stopped", async () => {
    // The "your recording stopped" modal renders in the Cortex tab - the one
    // this pane exists to stop them looking at. Without this they can answer
    // their way through a study that captured nothing.
    const pipWindow = createFakePipWindow();

    renderRunner("token_pane_rec_stopped", {
      captureStoppedExternally: true,
      pipWindow,
      recordingStatus: "stopped"
    });

    const pane = await waitFor(() =>
      within(pipWindow.document.body).getByRole("region", {
        name: "Floating task panel"
      })
    );

    expect(within(pane).getByText(/recording has stopped/i)).toBeTruthy();
    expect(within(pane).getByText(/nothing you do here is being recorded/i)).toBeTruthy();
    // The strip distinguishes a mid-session stop from "not started yet" -
    // it used to render both as the same danger-red "Not recording", which
    // spent the alarm colour on the resting state.
    expect(within(pane).getByText("Recording stopped")).toBeTruthy();
  });

  it("keeps the pane up when the completion request fails", async () => {
    // Closing it first made a failed final save look like the study had simply
    // vanished, because the error renders only in the tab behind the task page.
    const { sendRuntimeEvent } = await import("../../../lib/recording/runtime-client");
    const pipWindow = createFakePipWindow();
    const onCloseTaskPip = vi.fn();

    renderRunner("token_pane_finish_fails", { onCloseTaskPip, pipWindow });

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

    // Reject the COMPLETION event specifically. A bare mockRejectedValueOnce
    // is consumed by the step_exited event that precedes it, so the failure
    // lands before finishSession is ever reached and the test proves nothing.
    // Verified by mutation: restoring the close-before-completion bug fails
    // this test only with the conditional rejection in place.
    vi.mocked(sendRuntimeEvent).mockImplementation(async (_token, event) => {
      if ((event as { eventType?: string }).eventType === "session_completed") {
        throw new Error("network");
      }

      return undefined as never;
    });

    fireEvent.click(
      within(pipBody).getByRole("button", { name: /completed this task/i })
    );

    // The failure has to reach the participant IN THE PANE: the page's copy
    // of this alert is deferred while the pane is up, so surfacing it only
    // there would leave them pressing a dead button.
    await within(pipBody).findByText(/could not finish the session/i);
    expect(onCloseTaskPip).not.toHaveBeenCalled();
  });

  it("takes the pane down on any exit from the task phase, not just completion", async () => {
    // An interrupted run unwinds by unmounting this component; the hook that
    // owns the pane lives in the parent and stays mounted, so without an
    // unmount cleanup the participant is left with an empty always-on-top
    // window over the recovery message.
    const pipWindow = createFakePipWindow();
    const onCloseTaskPip = vi.fn();

    const { unmount } = renderRunner("token_pane_unmount", {
      onCloseTaskPip,
      pipWindow
    });

    await waitFor(() => {
      within(pipWindow.document.body).getByText("Task 1 of 2");
    });

    unmount();

    expect(onCloseTaskPip).toHaveBeenCalled();
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
