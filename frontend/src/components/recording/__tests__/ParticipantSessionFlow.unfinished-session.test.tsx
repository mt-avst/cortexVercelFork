import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import { getFlowStorageKey } from "../../../lib/recording/session-local-state";
import type { SessionPayload } from "@shared/firsthand/contract";

// RS-10 increment-1: a participant whose local state is empty (fresh device or
// cleared storage) but whose server snapshot shows mid-flight progress must be
// told, at the welcome phase, that continuing starts a fresh attempt. This is a
// restart-only, informational prompt - NO auto-resume, NO rehydration. These
// tests pin: the prompt appears only for the mid-flight case with empty local
// state, and never when local state exists or the visit is a forced reset.

const BANNER_HEADING = "You have an unfinished session for this study";
const TOKEN = "token_unfinished";

// Controls what the server snapshot read resolves to, per test.
const fetchLatestRuntimeStatus = vi.fn();

vi.mock("../../../lib/recording/runtime-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchLatestRuntimeStatus: () => fetchLatestRuntimeStatus(),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined),
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined)
}));

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
      session_token: TOKEN,
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

function renderFlow(props?: { forceReset?: boolean }) {
  render(
    <MemoryRouter>
      <ParticipantSessionFlow
        attemptNumber={1}
        directRecordingUploadMode={null}
        forceReset={props?.forceReset}
        payload={payload()}
        token={TOKEN}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  fetchLatestRuntimeStatus.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ParticipantSessionFlow unfinished-session prompt", () => {
  it("shows the restart-only banner when local is empty and the server has mid-flight progress", async () => {
    fetchLatestRuntimeStatus.mockResolvedValue("recording_in_progress");

    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    expect(
      await screen.findByText(BANNER_HEADING)
    ).toBeInTheDocument();
    // Honest copy: it must say a fresh attempt, never claim resume.
    expect(
      screen.getByText(/continuing will start a fresh attempt/i)
    ).toBeInTheDocument();
  });

  it("shows no banner when local is empty but the server status is terminal", async () => {
    fetchLatestRuntimeStatus.mockResolvedValue("completed");

    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    // Give the status effect a chance to resolve before asserting absence.
    await waitFor(() => {
      expect(fetchLatestRuntimeStatus).toHaveBeenCalled();
    });
    expect(screen.queryByText(BANNER_HEADING)).toBeNull();
  });

  it("shows no banner when local is empty but the server status is pre-progress", async () => {
    fetchLatestRuntimeStatus.mockResolvedValue("link_opened");

    renderFlow();

    await screen.findByRole("button", { name: "Continue to consent" });

    await waitFor(() => {
      expect(fetchLatestRuntimeStatus).toHaveBeenCalled();
    });
    expect(screen.queryByText(BANNER_HEADING)).toBeNull();
  });

  it("shows no banner and never consults the server when local state exists", async () => {
    window.localStorage.setItem(
      getFlowStorageKey(TOKEN, 1),
      JSON.stringify({ phase: "welcome" })
    );

    renderFlow();

    // Reaching the welcome button means hydration ran; with local state found,
    // localSessionEmpty stays false so the status effect early-returns and the
    // server is never consulted.
    await screen.findByRole("button", { name: "Continue to consent" });

    expect(screen.queryByText(BANNER_HEADING)).toBeNull();
    expect(fetchLatestRuntimeStatus).not.toHaveBeenCalled();
  });

  it("shows no banner and never consults the server on a forced reset", async () => {
    fetchLatestRuntimeStatus.mockResolvedValue("recording_in_progress");

    renderFlow({ forceReset: true });

    await screen.findByRole("button", { name: "Continue to consent" });

    expect(screen.queryByText(BANNER_HEADING)).toBeNull();
    expect(fetchLatestRuntimeStatus).not.toHaveBeenCalled();
  });

  it("dismisses the banner when the participant presses Got it", async () => {
    fetchLatestRuntimeStatus.mockResolvedValue("uploading");

    renderFlow();

    const dismiss = await screen.findByRole("button", { name: "Got it" });

    fireEvent.click(dismiss);

    await waitFor(() => {
      expect(screen.queryByText(BANNER_HEADING)).toBeNull();
    });
  });
});
