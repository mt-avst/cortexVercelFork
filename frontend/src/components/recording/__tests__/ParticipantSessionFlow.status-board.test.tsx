import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import type { SessionPayload } from "@shared/firsthand/contract";

// Once control moves to the floating pane this page stops being a workspace
// and becomes a status board. It carried two progress systems - six stacked
// blocks AND the Journey rail - and the locked blocks spent ~180px each to
// say "not yet", which the rail already says in one line. Only the live
// block is expanded now; finished ones collapse to a line; unreached ones
// live in the rail alone.

vi.mock("../../../lib/recording/task-pip", () => ({
  isTaskPipSupported: () => true,
  useTaskPip: () => ({
    pipWindow: null,
    isSupported: true,
    openTaskPip: vi.fn().mockResolvedValue(true),
    closeTaskPip: vi.fn()
  })
}));

vi.mock("../../../lib/recording/device-support", () => ({
  assessDeviceSupport: () => ({ canRun: true, reason: null }),
  collectDeviceSnapshot: () => ({})
}));

vi.mock("../../../lib/recording/runtime-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined),
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined),
  // RS-10 status effect fires when local storage is empty; stub to a no-op.
  fetchLatestRuntimeStatus: vi.fn().mockResolvedValue(null)
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
      session_token: "token_board",
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

function renderFlow() {
  render(
    <MemoryRouter>
      <ParticipantSessionFlow
        attemptNumber={1}
        directRecordingUploadMode={null}
        payload={payload()}
        token="token_board"
      />
    </MemoryRouter>
  );
}

describe("ParticipantSessionFlow status board", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("spends no space on steps the participant has not reached", async () => {
    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    // The Journey rail already lists every step, so an unreached one gets no
    // block at all. Assert on the BLOCK HEADING, not on the old gate copy -
    // that string was deleted with the change, so querying it would pass
    // whether or not the block still renders.
    for (const label of ["Task", "Upload", "Done"]) {
      expect(screen.queryByRole("heading", { name: label })).toBeNull();
    }
    // And the live step does have its heading, so the query above is real.
    expect(
      screen.getByRole("heading", { name: "Welcome" })
    ).toBeInTheDocument();
  });

  it("keeps every step named in the rail, so nothing is hidden", async () => {
    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    const rail = screen.getByRole("complementary");

    for (const label of ["Welcome", "Consent", "Task", "Upload", "Done"]) {
      expect(within(rail).getByText(label)).toBeInTheDocument();
    }
  });

  it("collapses a finished step to a line instead of its full body", async () => {
    renderFlow();

    fireEvent.click(
      await screen.findByRole("button", { name: "Continue to consent" })
    );

    // Welcome is behind us now: its heading and body copy go, and the block
    // is left as a completed line.
    await screen.findByRole("button", { name: "I agree and want to continue" });

    expect(screen.queryByRole("heading", { name: "Think out loud" })).toBeNull();
    expect(screen.queryByText(/no right answers/i)).toBeNull();
  });

  it("expands only the step that is live", async () => {
    renderFlow();

    fireEvent.click(
      await screen.findByRole("button", { name: "Continue to consent" })
    );

    // Consent is the live block, so its body is present...
    expect(
      await screen.findByRole("button", { name: "I agree and want to continue" })
    ).toBeInTheDocument();
    // ...while the setup checks below it have not been rendered yet.
    expect(screen.queryByText(/Chrome works for this session/i)).toBeNull();
  });
});
