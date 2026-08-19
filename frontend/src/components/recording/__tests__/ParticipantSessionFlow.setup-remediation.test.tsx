import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import {
  getFlowStorageKey,
  type FlowPhase
} from "../../../lib/recording/session-local-state";
import type { SetupAssessment } from "../../../lib/recording/setup-checks";
import type { RecorderState } from "../../../lib/recording/session-recorder";
import type { SessionPayload } from "../../../shared/firsthand/contract";

/**
 * A setup check that fails has to say what to DO about it.
 *
 * `SetupCheck.remediation` is the field that turns "Window size: this window
 * is too narrow" into something a participant can act on. Every other flow
 * test mocks `assessSetupReadiness` with a single passing check and no
 * remediation field at all, so the branch that renders it had no coverage:
 * deleting the whole `check.remediation ? ... : null` block left every test in
 * this directory green, and the participant staring at a diagnosis with no
 * instruction.
 *
 * The assessment is mocked rather than driven through `collectSetupSnapshot`,
 * because the point here is the RENDERING of a failed check - setup-checks.ts
 * has its own unit tests for which snapshot produces which verdict.
 */

const TOKEN = "token_setup";

const baseState: RecorderState = {
  captureStoppedExternally: false,
  microphonePermission: "not_requested",
  screenPermission: "not_requested",
  recordingStatus: "not_started",
  uploadStatus: "not_started",
  uploadProgress: null,
  recordingStartedAt: null,
  errorMessage: null,
  durationSeconds: null,
  asset: null
};

/**
 * Set per test. Typed as the real SetupAssessment so a status outside the
 * union, or a missing field, is a compile error rather than a test that
 * quietly asserts against a shape the component never receives.
 */
let assessment: SetupAssessment = {
  checks: [],
  canProceed: true,
  failedChecks: 0,
  warningChecks: 0,
  summary: "You are ready to go. Everything passed"
};

vi.mock("../../../lib/recording/session-recorder", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionRecorder: () => ({
    state: baseState,
    startCapture: vi.fn().mockResolvedValue(true),
    stopCaptureAndUpload: vi.fn().mockResolvedValue(null),
    retryUpload: vi.fn().mockResolvedValue(null)
  })
}));

vi.mock("../../../lib/recording/setup-checks", () => ({
  collectSetupSnapshot: vi.fn().mockResolvedValue({}),
  assessSetupReadiness: () => assessment
}));

vi.mock("../../../lib/recording/task-pip", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTaskPipSupported: () => true,
  useTaskPip: () => ({
    pipWindow: null,
    isSupported: true,
    openTaskPip: vi.fn().mockResolvedValue(true),
    closeTaskPip: vi.fn()
  })
}));

vi.mock("../../../lib/recording/device-support", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assessDeviceSupport: () => ({ canRun: true, reason: null }),
  collectDeviceSnapshot: () => ({})
}));

vi.mock("../../../lib/recording/runtime-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendRuntimeEvent: vi.fn().mockResolvedValue(undefined),
  saveParticipantResponse: vi.fn().mockResolvedValue(undefined)
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

function renderAt(phase: FlowPhase) {
  window.localStorage.setItem(
    getFlowStorageKey(TOKEN, 1),
    JSON.stringify({ phase })
  );

  return render(
    <MemoryRouter>
      <ParticipantSessionFlow
        attemptNumber={1}
        directRecordingUploadMode="disabled"
        payload={payload()}
        token={TOKEN}
      />
    </MemoryRouter>
  );
}

const NARROW_WINDOW_REMEDIATION =
  "Use a laptop or desktop, and make the browser window wider, then check again.";

describe("ParticipantSessionFlow setup checks", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names a failed check and what to do about it", async () => {
    assessment = {
      checks: [
        {
          id: "viewport",
          label: "Window size",
          status: "fail",
          detail: "This window is too narrow to run the session",
          remediation: NARROW_WINDOW_REMEDIATION
        }
      ],
      canProceed: false,
      failedChecks: 1,
      warningChecks: 0,
      summary: "One check needs your attention before you can start"
    };

    renderAt("setup");

    // All three parts, because each one alone is useless. The label says WHICH
    // check, the detail says WHAT is wrong, the remediation says what to DO -
    // and the remediation is the part with no coverage before this.
    expect(await screen.findByText("Window size")).toBeInTheDocument();
    expect(
      screen.getByText(/This window is too narrow to run the session/)
    ).toBeInTheDocument();
    expect(screen.getByText(NARROW_WINDOW_REMEDIATION)).toBeInTheDocument();
  });

  it("carries remediation on a warning too, not only on a failure", async () => {
    // Warnings take the same render branch as failures. A guard that only
    // rendered remediation for status === "fail" would still pass the test
    // above.
    assessment = {
      checks: [
        {
          id: "microphone",
          label: "Microphone",
          status: "warning",
          detail: "No microphone was detected yet",
          remediation: "Plug in a microphone, or allow access when prompted."
        }
      ],
      canProceed: true,
      failedChecks: 0,
      warningChecks: 1,
      summary: "One check needs a look, but you can continue"
    };

    renderAt("setup");

    expect(await screen.findByText("Microphone")).toBeInTheDocument();
    expect(
      screen.getByText("Plug in a microphone, or allow access when prompted.")
    ).toBeInTheDocument();
  });

  it("renders a failed check with no remediation without inventing one", async () => {
    // The field is optional. A check that carries no instruction must still
    // render its diagnosis rather than crashing or printing "undefined".
    assessment = {
      checks: [
        {
          id: "screen_share",
          label: "Screen sharing",
          status: "fail",
          detail: "Screen sharing is not available in this browser"
        }
      ],
      canProceed: false,
      failedChecks: 1,
      warningChecks: 0,
      summary: "One check needs your attention before you can start"
    };

    renderAt("setup");

    expect(await screen.findByText("Screen sharing")).toBeInTheDocument();
    expect(
      screen.getByText(/Screen sharing is not available in this browser/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("shows no remediation text when every check passes", async () => {
    // The negative case that stops the assertions above passing against a
    // component that renders remediation unconditionally from a constant.
    assessment = {
      checks: [
        {
          id: "browser",
          label: "Your browser",
          status: "pass",
          detail: "Chrome works for this session"
        }
      ],
      canProceed: true,
      failedChecks: 0,
      warningChecks: 0,
      summary: "You are ready to go. Everything passed"
    };

    renderAt("setup");

    await screen.findByText(/Chrome works for this session/);
    expect(screen.queryByText(NARROW_WINDOW_REMEDIATION)).toBeNull();
  });
});
