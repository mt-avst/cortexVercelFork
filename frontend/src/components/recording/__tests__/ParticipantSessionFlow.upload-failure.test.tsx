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
 * as `vi.fn()` stubs that nothing ever asserts against. That left the whole
 * failed-upload path uncovered: nothing checked that the "Retry upload" button
 * is wired to `recorder.retryUpload()` at all, and nothing checked what the
 * participant is TOLD while the retry is on offer.
 *
 * The progress bar was in the same position for a different reason: the
 * component renders a real `role="progressbar"` with `aria-valuenow`, and no
 * test anywhere in the frontend matched either string.
 *
 * Assertions here go through the progressbar ROLE and its `aria-valuenow`
 * rather than the "42%" text, because the accessible value is the thing a
 * screen reader announces - the visible percentage is a second rendering of
 * the same number and could agree with a broken one.
 *
 * Two things this file learned the hard way, both from an independent review
 * gate that ran its own mutation matrix against the first version:
 *
 * THE PROGRESS FIXTURE MUST USE THREE DISTINGUISHABLE NUMBERS. The first
 * version wrote `transferredBytes`, which is not a field on
 * `UploadProgressEvent` at all - the real one is `loadedBytes`. The
 * bytes-not-percentage assertion below passed only because the misnamed field
 * left `loadedBytes` undefined and the `?? 0` default caught it. Corrected,
 * with `loadedBytes`, `totalBytes` and `percentage` all different, so a bar
 * reading the wrong field cannot coincidentally announce the right number.
 *
 * THE LEDE IS LOAD-BEARING AND HAD TO BE PINNED. Nothing in the repository
 * asserted `UploadStage`'s lede, so flipping one character at its `isComplete`
 * line - `"complete"` to `"failed"`, exactly the slip the adjacent `hasFailed`
 * invites - told a participant whose upload had just FAILED that their
 * recording "was saved successfully", with the whole suite green. They close
 * the tab and the only copy is gone.
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
        directRecordingUploadMode="s3"
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

/** The lede the participant must NEVER see while an upload has failed. */
const SUCCESS_LEDE = "Your recording was saved successfully.";
const IN_FLIGHT_LEDE =
  "Stay on this page until it completes. Recording has stopped.";

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

  it("never tells a participant with a failed upload that it was saved", async () => {
    recorderState = { ...failedState };
    renderAt("uploading");

    // By ROLE: "Upload interrupted" also appears in the status rail, so a
    // plain text match resolves to two nodes and would pass on the rail alone
    // even if the stage itself said nothing.
    expect(
      await screen.findByRole("heading", { name: "Upload interrupted" })
    ).toBeInTheDocument();

    // The assertion that stops the one-character isComplete slip. Both halves
    // matter: the right lede present AND the success lede absent, because a
    // branch that rendered both would pass either one alone.
    expect(screen.getByText(IN_FLIGHT_LEDE)).toBeInTheDocument();
    expect(screen.queryByText(SUCCESS_LEDE)).toBeNull();

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
    //
    // "in_progress", not "uploading". The union is
    // not_started | pending | in_progress | complete | failed, and the first
    // version of this test used a sixth value that does not exist. It matters
    // beyond tidiness - shouldGuardNavigation returns false for an unknown
    // status and true for the real ones, so the invented state rendered a page
    // with the "Study hub" exit link still live during an in-flight upload, a
    // DOM the application can never produce. Test files are excluded from
    // tsconfig, so nothing caught it.
    recorderState = {
      ...baseState,
      uploadStatus: "in_progress",
      uploadProgress: { loadedBytes: 4200, totalBytes: 10_000, percentage: 42 }
    };
    renderAt("uploading");

    await screen.findByText(IN_FLIGHT_LEDE);
    expect(screen.queryByRole("button", { name: "Retry upload" })).toBeNull();
  });

  it("offers no retry before the upload has even begun", async () => {
    // The other in-flight status. "pending" is what stopCaptureAndUpload sets
    // before the first byte moves, and it is a distinct branch from
    // in_progress everywhere the two are read.
    recorderState = { ...baseState, uploadStatus: "pending" };
    renderAt("uploading");

    await screen.findByText(IN_FLIGHT_LEDE);
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

  it("announces the percentage it was given, not the byte count", async () => {
    // Three distinguishable numbers on purpose. With loadedBytes 42 and
    // percentage 42 - which is what the first version effectively had - a bar
    // wired to the wrong field announces the right value and the mutation
    // survives.
    recorderState = {
      ...baseState,
      uploadStatus: "in_progress",
      uploadProgress: { loadedBytes: 4200, totalBytes: 10_000, percentage: 42 }
    };
    renderAt("uploading");

    const bar = await screen.findByRole("progressbar", {
      name: "Upload progress"
    });

    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("starts at zero rather than empty before any progress arrives", async () => {
    // `uploadProgress` is null until the first progress event. A bar with no
    // aria-valuenow at all is announced as indeterminate, which is a
    // different thing from "0% so far".
    recorderState = { ...baseState, uploadStatus: "in_progress" };
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
    // never DURABLY sees it: the phase advance lives in a useEffect, so React
    // commits one render still on the uploading phase before the effect flips
    // it, and the stage is then unmounted because a "done" JourneyBlock
    // renders its head ALONE, no children.
    //
    // So it renders for a single commit and is gone - not, as an earlier
    // version of this comment claimed, unreachable dead code. The distinction
    // matters: the branch is executed but unpinned, and a paint between the
    // commit and the passive-effect flush is possible.
    //
    // Pinned as the settled behaviour, because it is the one that matters: a
    // participant left looking at a 100% bar has no idea whether they may
    // close the tab. This asserts they are told.
    recorderState = {
      ...baseState,
      uploadStatus: "complete",
      uploadProgress: {
        loadedBytes: 10_000,
        totalBytes: 10_000,
        percentage: 100
      }
    };
    renderAt("uploading");

    expect(
      await screen.findByRole("heading", { name: "Recording captured" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("progressbar", { name: "Upload progress" })
    ).toBeNull();
  });

  it("reports the uploaded recording on the completed screen", async () => {
    // Where an uploaded asset actually surfaces to the participant, and the
    // reason dropping `captureUploadedAsset` after a retry does not lose it:
    // CompletedStage reads `completionSummary?.uploadedAsset ?? state.asset`,
    // so the recorder's own state is the backstop. Nothing tested that
    // fallback, which meant nothing tested that a successful upload is
    // reported to the participant AT ALL.
    recorderState = {
      ...baseState,
      uploadStatus: "complete",
      asset: {
        assetId: "asset_1",
        relativePath: "sessions/session_1.webm",
        fileSizeBytes: 2_097_152,
        mimeType: "video/webm"
      }
    };
    renderAt("uploading");

    fireEvent.click(
      await screen.findByRole("button", { name: "Show session details" })
    );

    // The size, not just the presence of a line: the fallback branch and the
    // "Your recording was uploaded." default are both single lines of text,
    // and only the size distinguishes them.
    expect(screen.getByText("Uploaded 2 MB of video.")).toBeInTheDocument();
    expect(screen.queryByText("Your recording was uploaded.")).toBeNull();
  });
});
