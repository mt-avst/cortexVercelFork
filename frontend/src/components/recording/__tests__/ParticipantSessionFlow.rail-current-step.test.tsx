import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import type { SessionPayload } from "@shared/firsthand/contract";

// RS-12: the Journey rail already marks DONE steps but rendered the current
// step identically to one not yet reached. This pins the missing marker -
// aria-current plus a non-colour class cue on the active rail item.

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
      session_token: "token_rail_current",
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
        token="token_rail_current"
      />
    </MemoryRouter>
  );
}

describe("ParticipantSessionFlow rail current-step marker", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("marks the active step and leaves an unreached step unmarked", async () => {
    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    const rail = screen.getByRole("complementary");
    const welcomeItem = within(rail).getByText("Welcome");
    const consentItem = within(rail).getByText("Consent");

    // Control: nothing is marked "done" or "current" yet on the not-yet-
    // reached step, so a false positive here would prove the query is
    // matching the wrong node rather than a genuine current-step gap.
    expect(consentItem).not.toHaveAttribute("aria-current");
    expect(consentItem.className).not.toContain("journey-vitem--done");
    expect(consentItem.className).not.toContain("journey-vitem--current");

    expect(welcomeItem).toHaveAttribute("aria-current", "step");
    expect(welcomeItem.className).toContain("journey-vitem--current");
    expect(welcomeItem.className).not.toContain("journey-vitem--done");
  });

  it("moves the marker forward as a step completes", async () => {
    renderFlow();

    fireEvent.click(
      await screen.findByRole("button", { name: "Continue to consent" })
    );

    await screen.findByRole("button", { name: "I agree and want to continue" });

    const rail = screen.getByRole("complementary");
    const welcomeItem = within(rail).getByText("Welcome");
    const consentItem = within(rail).getByText("Consent");
    const taskItem = within(rail).getByText("Task");

    expect(welcomeItem).not.toHaveAttribute("aria-current");
    expect(welcomeItem.className).toContain("journey-vitem--done");
    expect(welcomeItem.className).not.toContain("journey-vitem--current");

    expect(consentItem).toHaveAttribute("aria-current", "step");
    expect(consentItem.className).toContain("journey-vitem--current");
    expect(consentItem.className).not.toContain("journey-vitem--done");

    expect(taskItem).not.toHaveAttribute("aria-current");
    expect(taskItem.className).not.toContain("journey-vitem--done");
    expect(taskItem.className).not.toContain("journey-vitem--current");
  });
});
