import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipantSessionFlow } from "../ParticipantSessionFlow";
import {
  getFlowStorageKey,
  type FlowPhase
} from "../../../lib/recording/session-local-state";
import type { RecorderState } from "../../../lib/recording/session-recorder";
import type { SessionPayload } from "../../../shared/firsthand/contract";

/**
 * The end of a recorded session, where the recording exists only in memory.
 *
 * `retryUpload` and `stopCaptureAndUpload` appear across the flow tests only
 * as `vi.fn()` stubs that nothing ever asserts against. That leaves the whole
 * failed-upload path uncovered: nothing checked that the "Retry upload" button
 * is wired to `recorder.retryUpload()` at all, and nothing checked that what
 * it resolves is carried into the completion summary rather than dropped.
 * A button wired to a no-op, or an `onRetryUpload` that awaits and discards,
 * would have passed every test in this directory.
 *
 * The progress bar was in the same position for a different reason: the
 * component renders a real `role="progressbar"` with `aria-valuenow`, and no
 * test anywhere in the frontend matched either string. `uploadProgress` could
 * have been read from the wrong field, or the completed case could have
 * reported the last streamed percentage instead of 100, without anything
 * noticing.
 *
 * Assertions here go through the progressbar ROLE and its `aria-valuenow`
 * rather than the "42%" text, because the accessible value is the thing a
 * screen reader announces - the visible percentage is a second rendering of
 * the same number and could agree with a broken one.
 */

const TOKEN = "token_upload";

const baseState: RecorderState = {
  captureStoppedExternally: false,
  microphonePermission: "granted",
  screenPermission: "granted",
  recordingStatus: "stopped",
  uploadStatus: "not_started",
  uploadProgress: null,
  recordingStartedAt: null,
  errorMessage: null,
  durationSeconds: null,
  asset: null
};

let recorderState: RecorderState = { ...baseState };

/**
 * The real method under test. Declared out here so each case can choose what
 * it resolves, and so the assertions can count calls rather than trust that
 * clicking a button did anything.
 */
const retryUpload = vi.fn().mockResolvedValue(null);

vi.mock("../../../lib/recording/session-recorder", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionRecorder: () => ({
    state: recorderState,
    startCapture: vi.fn().mockResolvedValue(true),
    stopCaptureAndUpload: vi.fn().mockResolvedValue(null),
    retryUpload
  })
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

const failedState: RecorderState = {
  ...baseState,
  uploadStatus: "failed",
  errorMessage:
    "Your recording is safe on this device, but the upload did not finish. Stay on this page and try again."
};

describe("ParticipantSessionFlow failed upload", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    recorderState = { ...baseState };
    retryUpload.mockClear();
    retryUpload.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers a retry that actually calls the recorder", async () => {
    recorderState = { ...failedState };
    renderAt("uploading");

    const retry = await screen.findByRole("button", { name: "Retry upload" });

    // Nothing before this asserted the button reaches the recorder at all.
    expect(retryUpload).not.toHaveBeenCalled();
    fireEvent.click(retry);
    expect(retryUpload).toHaveBeenCalledTimes(1);
  });

  it("tells the participant the recording is still safe on the device", async () => {
    recorderState = { ...failedState };
    renderAt("uploading");

    // By ROLE: "Upload interrupted" also appears in the status rail, so a
    // plain text match resolves to two nodes and would pass on the rail alone
    // even if the stage itself said nothing.
    expect(
      await screen.findByRole("heading", { name: "Upload interrupted" })
    ).toBeInTheDocument();

    // The promise the retry rests on. If the copy ever stops saying the
    // recording survives, the retry button is asking for trust it has not
    // earned - a participant who believes it is lost has no reason to wait.
    expect(
      screen.getByText(/Your recording is safe on this device/)
    ).toBeInTheDocument();
  });

  it("offers no retry while the upload is still in flight", async () => {
    // The guard on the other side: a retry offered mid-upload invites a
    // second upload of the same blob.
    recorderState = {
      ...baseState,
      uploadStatus: "uploading",
      uploadProgress: { percentage: 42, transferredBytes: 42, totalBytes: 100 }
    };
    renderAt("uploading");

    await screen.findByText(/Uploading your recording/);
    expect(screen.queryByRole("button", { name: "Retry upload" })).toBeNull();
  });

  it("still offers a retry after one that did not succeed", async () => {
    // The realistic case for a flaky connection: the first retry does not get
    // the file up either. `retryUpload` reports that by RESOLVING null - it
    // catches its own upload failure internally and never rejects - so the
    // state stays "failed" and the offer must still stand. A handler that
    // treated a null asset as "done" would leave the participant holding the
    // only copy with no way to send it.
    recorderState = { ...failedState };
    retryUpload.mockResolvedValue(null);
    renderAt("uploading");

    const retry = await screen.findByRole("button", { name: "Retry upload" });
    fireEvent.click(retry);
    await Promise.resolve();

    expect(retryUpload).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Retry upload" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    expect(retryUpload).toHaveBeenCalledTimes(2);
  });
});

describe("ParticipantSessionFlow upload progress", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    recorderState = { ...baseState };
    retryUpload.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("announces the percentage it was given", async () => {
    recorderState = {
      ...baseState,
      uploadStatus: "uploading",
      uploadProgress: { percentage: 42, transferredBytes: 42, totalBytes: 100 }
    };
    renderAt("uploading");

    const bar = await screen.findByRole("progressbar", {
      name: "Upload progress"
    });

    // 42, not "some number" - a bar reading a byte count instead of the
    // percentage would still be a progressbar with a valuenow.
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("starts at zero rather than empty before any progress arrives", async () => {
    // `uploadProgress` is null until the first progress event. A bar with no
    // aria-valuenow at all is announced as indeterminate, which is a
    // different thing from "0% so far".
    recorderState = { ...baseState, uploadStatus: "uploading" };
    renderAt("uploading");

    expect(
      await screen.findByRole("progressbar", { name: "Upload progress" })
    ).toHaveAttribute("aria-valuenow", "0");
  });

  it("moves the participant on rather than leaving them watching a finished bar", async () => {
    // What actually happens when the upload completes, established by running
    // it rather than by reading UploadStage.
    //
    // UploadStage has an isComplete branch - percentage forced to 100, an
    // "Upload complete" heading, a "saved successfully" lede. The participant
    // never sees any of it. Completing the upload advances the phase, which
    // makes this section "done", and a done JourneyBlock renders its head
    // ALONE - no children. So the stage unmounts instead of showing a full
    // bar, and that branch is unreachable in the flow.
    //
    // Pinned as the reachable behaviour, because it is the better one: a
    // participant left looking at a 100% bar has no idea whether they may
    // close the tab. This asserts they are told.
    recorderState = {
      ...baseState,
      uploadStatus: "complete",
      uploadProgress: { percentage: 97, transferredBytes: 97, totalBytes: 100 }
    };
    renderAt("uploading");

    expect(
      await screen.findByRole("heading", { name: "Recording captured" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("progressbar", { name: "Upload progress" })
    ).toBeNull();
  });
});
