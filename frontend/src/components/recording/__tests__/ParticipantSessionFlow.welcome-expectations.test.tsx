import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import type { SessionPayload } from "@shared/firsthand/contract";

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

// The welcome card sets expectations; it must not reveal the tasks. A
// participant who reads every prompt before consenting rehearses their route,
// and the recording captures a performance instead of a first encounter.
// Tasks are revealed one at a time once recording is live - the same order
// UserTesting uses.

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

// Spread the real module so exports these tests do not name (used by
// session-recorder and StudyRunner) stay callable if a test ever walks past
// the welcome stage.
vi.mock("../../../lib/recording/runtime-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined),
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined)
}));

const PROMPT_ONE = "Find a pair of running shoes under £80.";
const PROMPT_TWO = "Locate the returns policy for footwear.";

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
      session_token: "token_welcome",
      study_id: "study_1",
      participant_id: "participant_1"
    },
    steps: [
      {
        step_id: "study_1_step_1",
        order: 1,
        type: "instruction",
        prompt: PROMPT_ONE,
        target_url: "https://shop.example.com/running"
      },
      {
        step_id: "study_1_step_2",
        order: 2,
        type: "open_text",
        prompt: PROMPT_TWO,
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
        token="token_welcome"
      />
    </MemoryRouter>
  );
}

describe("ParticipantSessionFlow welcome expectations", () => {
  it("does not reveal any task prompt before the session starts", async () => {
    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    // Both prompts, not just the first: a regression that leaks "all but one"
    // must still fail here. Substring match, so a prompt wrapped in other
    // text ("Step 1 - Find a pair...") still counts as a leak.
    expect(screen.queryByText(PROMPT_ONE, { exact: false })).toBeNull();
    expect(screen.queryByText(PROMPT_TWO, { exact: false })).toBeNull();
  });

  it("tells the participant to think out loud before they consent", async () => {
    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    expect(
      screen.getByRole("heading", { name: "Think out loud" })
    ).toBeInTheDocument();
  });

  it("tells the participant their camera is never recorded", async () => {
    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    expect(screen.getByText(/never your camera/i)).toBeInTheDocument();
  });
});
