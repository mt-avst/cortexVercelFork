import React from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StudyRunner } from "../StudyRunner";
import type { SessionPayload } from "../../../shared/firsthand/contract";

vi.mock("../../../lib/recording/runtime-client", () => ({
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined)
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
      session_token: "token_1",
      study_id: "study_1",
      participant_id: "participant_1"
    },
    steps: [
      {
        step_id: "step_1",
        order: 1,
        type: "instruction",
        prompt: "Find a pair of running shoes under £80.",
        target_url: "https://shop.example.com/running"
      }
    ]
  };
}

function renderRunner(
  overrides: { recordingStatus?: "active" | "not_started" } = {}
) {
  return render(
    <StudyRunner
      attemptNumber={1}
      captureStoppedExternally={false}
      microphonePermission="granted"
      payload={payload()}
      recordingStartedAt={Date.parse("2026-08-13T10:00:00.000Z")}
      recordingStatus={overrides.recordingStatus ?? "active"}
      screenPermission="granted"
      onComplete={vi.fn()}
      onOpenTaskWindow={vi.fn().mockReturnValue(true)}
    />
  );
}

describe("StudyRunner task window note", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // jsdom has no layout, so the runner's scroll-into-view on task change
    // would throw before anything rendered.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("tells the participant closing the window ends the recording only if that window was the shared surface", () => {
    renderRunner({ recordingStatus: "active" });

    // Anchored on the panel's role and accessible name, not on its markup, so
    // this cannot quietly widen onto another element if the copy around it
    // moves.
    const panel = screen.getByRole("region", { name: "Task page" });
    const note = within(panel).getByText(
      /Keep the task window open until you finish/
    );

    // The unconditional claim is false for the whole-screen share that the
    // launch step offers as the fallback: nothing watches the task window, and
    // only the shared surface's track ending stops a recording.
    expect(note).toHaveTextContent(
      "Keep the task window open until you finish. If you shared that window rather than your whole screen, closing it ends the recording."
    );
    expect(note.textContent).not.toMatch(/closing it stops the recording/);
  });

  it("does not show the note before recording is active", () => {
    renderRunner({ recordingStatus: "not_started" });

    const panel = screen.getByRole("region", { name: "Task page" });

    expect(
      within(panel).queryByText(/Keep the task window open until you finish/)
    ).toBeNull();
  });
});
