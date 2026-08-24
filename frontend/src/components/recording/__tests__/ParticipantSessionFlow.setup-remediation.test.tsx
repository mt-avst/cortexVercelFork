import React from "react";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import {
  getFlowStorageKey,
  type FlowPhase
} from "../../../lib/recording/session-local-state";
import type { SetupAssessment } from "../../../lib/recording/setup-checks";
import type { RecorderState } from "../../../lib/recording/session-recorder";
import type { SessionPayload } from "@shared/firsthand/contract";

/**
 * A setup check that fails has to say what to DO about it, and it has to say
 * it on the right row.
 *
 * `SetupCheck.remediation` is the field that turns "Window size: this window
 * is too narrow" into something a participant can act on. Every other flow
 * test mocks `assessSetupReadiness` with a single passing check and no
 * remediation field at all, so the branch that renders it had no coverage:
 * deleting the whole `check.remediation ? ... : null` block left every test in
 * this directory green.
 *
 * MULTI-CHECK FIXTURES, DELIBERATELY. The first version of this file used a
 * single check per test, which is the convenient-fixture trap in its purest
 * form: with one check, `check.remediation` and `checks[0].remediation` are
 * the same value by construction, so a component that showed EVERY row the
 * first check's instruction passed. A real assessment returns four checks, and
 * a participant told to widen their window on the Microphone row is sent to a
 * dead end. Every assertion below is scoped to its own row with `within`.
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
 * Set per test, and annotated with the real `SetupAssessment` so the shape
 * stays honest to the reader.
 *
 * Note that this is documentation, NOT enforcement: `frontend/tsconfig.json`
 * excludes `src/**' + '/__tests__/*`, so nothing type-checks this file during
 * `npm run build` or lint. An earlier version of this comment claimed a wrong
 * status would be "a compile error". It would not be, and its sibling file
 * shipped six type errors green to prove the point.
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
        directRecordingUploadMode="s3"
        payload={payload()}
        token={TOKEN}
      />
    </MemoryRouter>
  );
}

const NARROW_WINDOW_REMEDIATION =
  "Use a laptop or desktop, and make the browser window wider, then check again.";
const MICROPHONE_REMEDIATION =
  "Plug in a microphone, or allow access when prompted.";

/**
 * The row a check renders into. There is no role on it, so the class is the
 * only handle - and scoping to the row is the whole point of these tests, so
 * a class query here buys more than it costs.
 *
 * Matched on the row's own `<strong>` label rather than on any text on the
 * page: "Microphone" also appears in the setup stage's surrounding copy, so a
 * bare text lookup resolves to several nodes and throws before it can scope
 * anything.
 */
function rowFor(label: string) {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>(".journey-checkrow")
  ).find(
    (candidate) => candidate.querySelector("strong")?.textContent === label
  );

  if (!row) {
    throw new Error(`No check row found for "${label}"`);
  }

  return within(row);
}

describe("ParticipantSessionFlow setup checks", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts each failing check's instruction on its own row", async () => {
    // Two failures with different instructions, which is the only fixture
    // shape that can catch a component showing every row the same one.
    assessment = {
      checks: [
        {
          id: "browser",
          label: "Your browser",
          status: "pass",
          detail: "Chrome works for this session"
        },
        {
          id: "viewport",
          label: "Window size",
          status: "fail",
          detail: "This window is too narrow to run the session",
          remediation: NARROW_WINDOW_REMEDIATION
        },
        {
          id: "microphone",
          label: "Microphone",
          status: "warning",
          detail: "No microphone was detected yet",
          remediation: MICROPHONE_REMEDIATION
        }
      ],
      canProceed: false,
      failedChecks: 1,
      warningChecks: 1,
      summary: "Some checks need your attention before you can start"
    };

    renderAt("setup");
    await screen.findByText(/This window is too narrow/);

    const viewport = rowFor("Window size");
    const microphone = rowFor("Microphone");

    // Each row carries its own diagnosis and its own instruction...
    expect(
      viewport.getByText(/This window is too narrow to run the session/)
    ).toBeInTheDocument();
    expect(viewport.getByText(NARROW_WINDOW_REMEDIATION)).toBeInTheDocument();

    expect(
      microphone.getByText(/No microphone was detected yet/)
    ).toBeInTheDocument();
    expect(microphone.getByText(MICROPHONE_REMEDIATION)).toBeInTheDocument();

    // ...and NOT the other one's. This is the pair of assertions a
    // single-check fixture cannot make.
    expect(viewport.queryByText(MICROPHONE_REMEDIATION)).toBeNull();
    expect(microphone.queryByText(NARROW_WINDOW_REMEDIATION)).toBeNull();
  });

  it("distinguishes a failure from a warning on the row itself", async () => {
    // What the participant reads to know whether they are blocked. Both the
    // glyph and the state chip come from the status branch rather than from
    // the fixture, so nothing else in this file covers them - a warning
    // rendered as "✕ fail" leaves someone staring at a red failure they are
    // in fact allowed to start through.
    assessment = {
      checks: [
        {
          id: "viewport",
          label: "Window size",
          status: "fail",
          detail: "This window is too narrow to run the session",
          remediation: NARROW_WINDOW_REMEDIATION
        },
        {
          id: "microphone",
          label: "Microphone",
          status: "warning",
          detail: "No microphone was detected yet",
          remediation: MICROPHONE_REMEDIATION
        }
      ],
      canProceed: false,
      failedChecks: 1,
      warningChecks: 1,
      summary: "Some checks need your attention before you can start"
    };

    renderAt("setup");
    await screen.findByText(/This window is too narrow/);

    expect(rowFor("Window size").getByText("fail")).toBeInTheDocument();
    expect(rowFor("Window size").getByText("✕")).toBeInTheDocument();

    expect(rowFor("Microphone").getByText("warn")).toBeInTheDocument();
    expect(rowFor("Microphone").getByText("!")).toBeInTheDocument();
  });

  it("renders a failed check with no remediation without inventing one", async () => {
    // The field is optional on the type. Every fail and warning branch in
    // setup-checks.ts does in fact set it today, so this is robustness
    // against the type rather than a state the current assessor produces -
    // worth keeping precisely because the optionality is what makes the
    // conditional render exist at all.
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
    await screen.findByText(/Screen sharing is not available/);

    const row = rowFor("Screen sharing");
    expect(
      row.getByText(/Screen sharing is not available in this browser/)
    ).toBeInTheDocument();
    expect(row.queryByText(/undefined/)).toBeNull();
  });

  it("shows no remediation on a check that passed", async () => {
    // The passing check CARRIES a remediation here, which is the only way to
    // catch a row that renders the field unconditionally. Asserting the
    // absence of some other test's string proves nothing: a passing check
    // normally has no remediation to leak in the first place.
    assessment = {
      checks: [
        {
          id: "browser",
          label: "Your browser",
          status: "pass",
          detail: "Chrome works for this session",
          remediation: NARROW_WINDOW_REMEDIATION
        }
      ],
      canProceed: true,
      failedChecks: 0,
      warningChecks: 0,
      summary: "You are ready to go. Everything passed"
    };

    renderAt("setup");
    await screen.findByText(/Chrome works for this session/);

    // A SUBSTRING matcher, not the exact string. A leak does not necessarily
    // arrive in a text node of its own: rendering the field inside the row's
    // existing state chip produces "passUse a laptop or desktop...", which an
    // exact-string query sails straight past. Found by mutating exactly that
    // way and watching the first version of this assertion survive.
    expect(screen.queryByText(/make the browser window wider/)).toBeNull();
  });
});
