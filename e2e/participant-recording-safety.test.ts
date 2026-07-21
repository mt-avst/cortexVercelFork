import { expect, test, type Page } from "@playwright/test";

import {
  BOUND_SESSION_TOKEN,
  PARTICIPANT_E2E_ENABLED,
  advanceToSetup,
  advanceToTask,
  expectSectionLocked,
  expectSectionStatus,
  getFlowSection,
  gotoSession,
  interceptUploadFailureOnce,
  loginAsParticipant,
  readMediaCaptureCounts,
  startRecordedStudy,
  stubMediaCapture
} from "./helpers/participant-recording";

// Ported from FirstHand e2e/participant-recording-safety.spec.ts (the oracle).
// A recording exists only as in-memory chunks until its upload lands; these
// cover every way that copy could be thrown away in the six-section one-page
// flow: leaving mid-recording, leaving during upload, a failed upload with no
// retry, and a permission denial dead-ending the participant.
//
// End-of-B verification: requires dev:all, FIRSTHAND_INTERNAL=1, a seeded
// session bound to the demo employee (FIRSTHAND_E2E_SESSION_TOKEN), the S3
// grant (OPS-3) for the real upload leg, and Chromium fake-media flags. Skipped
// unless FIRSTHAND_PARTICIPANT_E2E=1 (it is not part of build-only CI).

test.describe("navigation guard around the in-memory recording", () => {
  test.skip(
    !PARTICIPANT_E2E_ENABLED || !BOUND_SESSION_TOKEN,
    "Set FIRSTHAND_PARTICIPANT_E2E=1 and FIRSTHAND_E2E_SESSION_TOKEN to run the participant recording E2E."
  );

  test.beforeEach(async ({ page }) => {
    await loginAsParticipant(page);
  });

  test("the one-click exit is withdrawn while the recording is only in memory", async ({
    page
  }) => {
    await advanceToTask(page);

    // The "Study hub" nav link routes client-side, so beforeunload never fires
    // for it - it has to not be there at all while capture is live. The locked
    // notice stands in its place.
    await expect(page.getByText("Recording in progress")).toBeVisible();
    await expect(page.getByRole("link", { name: "Study hub" })).toBeHidden();
  });

  test("a clean upload shows real progress, releases the guard on Done and leaves earlier sections intact", async ({
    page
  }) => {
    await stubMediaCapture(page);

    // Hold the finalize response briefly so the upload section is observable.
    // Only the progress bar's presence is asserted, never an intermediate value.
    await page.route("**/api/firsthand/session/*/recording/finalize*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });

    await advanceToTask(page);
    await page.getByRole("button", { name: "I’ve completed this task" }).click();

    await expect(
      page.getByRole("heading", { name: "Uploading your recording" })
    ).toBeVisible();
    await expectSectionStatus(page, 3, "done");
    await expectSectionStatus(page, 4, "current");

    const progressBar = page.getByRole("progressbar");

    await expect(progressBar).toBeVisible();
    await expect(progressBar).toHaveAttribute("aria-valuenow", /^\d+(\.\d+)?$/);

    // The guard spans the upload: the recording is still only in memory while
    // the request is in flight.
    await expect(page.getByText("Recording in progress")).toBeVisible();

    await expect(
      page.getByRole("heading", { name: "Recording captured" })
    ).toBeVisible();
    await expectSectionStatus(page, 5, "current");

    // Once the recording is durably stored there is nothing left to lose, so
    // the exit is restored.
    await expect(page.getByText("Recording in progress")).toBeHidden();
    await expect(page.getByRole("link", { name: "Study hub" })).toBeVisible();

    // Nothing about the earlier sections was lost or duplicated: each passed
    // block stays visible marked done, with its single ".journey-doneline".
    await expectSectionStatus(page, 1, "done");
    await expect(
      getFlowSection(page, 1).locator(".journey-doneline")
    ).toContainText("completed");
    await expectSectionStatus(page, 2, "done");
    await expect(
      getFlowSection(page, 2).locator(".journey-doneline")
    ).toContainText("completed");
  });

  test("a failed upload keeps the guard, blocks Done and retries without re-recording", async ({
    page
  }) => {
    const uploadPosts = trackRecordingUploadPosts(page);

    await stubMediaCapture(page);
    await interceptUploadFailureOnce(page);
    await advanceToTask(page);

    await page.getByRole("button", { name: "I’ve completed this task" }).click();

    await expect(
      page.getByRole("heading", { name: "Upload interrupted" })
    ).toBeVisible();
    await expect(
      page.getByText(/recording is safe on this device/i)
    ).toBeVisible();
    await expectSectionStatus(page, 3, "done");
    await expectSectionStatus(page, 4, "current");

    // Done is unreachable while the upload has not succeeded.
    await expect(
      page.getByRole("heading", { name: "Recording captured" })
    ).toBeHidden();
    await expectSectionLocked(page, 5);

    // The guard must still hold: the failed upload leaves the only copy of the
    // recording in memory, and leaving now would discard it.
    await expect(page.getByText("Recording in progress")).toBeVisible();
    await expect(page.getByRole("link", { name: "Study hub" })).toBeHidden();

    await page.getByRole("button", { name: "Retry upload" }).click();

    await expect(
      page.getByRole("heading", { name: "Recording captured" })
    ).toBeVisible();
    await expectSectionStatus(page, 5, "current");

    // Exactly two upload attempts: the failed one and the retry. One
    // getDisplayMedia call across the whole journey proves the retry reused the
    // held recording rather than re-recording.
    expect(uploadPosts).toHaveLength(2);

    const counts = await readMediaCaptureCounts(page);

    expect(counts.getDisplayMedia).toBe(1);
  });
});

test.describe("permission denial returns to Setup and start", () => {
  test.skip(
    !PARTICIPANT_E2E_ENABLED || !BOUND_SESSION_TOKEN,
    "Set FIRSTHAND_PARTICIPANT_E2E=1 and FIRSTHAND_E2E_SESSION_TOKEN to run the participant recording E2E."
  );

  const MICROPHONE_DENIED_MESSAGE =
    "Microphone permission was denied. Allow microphone access on this tab before choosing what to share.";
  const SCREEN_DENIED_MESSAGE =
    "Screen sharing was denied after microphone access was granted. Choose a screen or window and retry.";

  test.beforeEach(async ({ page }) => {
    await loginAsParticipant(page);
  });

  test("a denied microphone keeps the participant on setup with a retry that re-prompts", async ({
    page
  }) => {
    await stubMediaCapture(page, { denyMicrophone: true });
    await gotoSession(page);
    await advanceToSetup(page);
    await startRecordedStudy(page);

    await expectSectionStatus(page, 2, "current");
    await expect(page.getByText("Recording could not start")).toBeVisible();
    await expect(page.getByText(MICROPHONE_DENIED_MESSAGE)).toBeVisible();
    await expect(
      page.getByText("You are ready to go. Everything passed")
    ).toBeVisible();

    const startButton = page.getByRole("button", { name: "Start recording" });

    await expect(startButton).toBeEnabled();

    const firstAttempt = await readMediaCaptureCounts(page);

    expect(firstAttempt.getUserMedia).toBe(1);
    expect(firstAttempt.getDisplayMedia).toBe(0);

    await startButton.click();
    await expect
      .poll(async () => (await readMediaCaptureCounts(page)).getUserMedia)
      .toBe(2);
    await expect(page.getByText(MICROPHONE_DENIED_MESSAGE)).toBeVisible();
    await expect(startButton).toBeEnabled();
    await expectSectionStatus(page, 2, "current");
  });

  test("a denied screen share keeps the participant on setup and re-requests both streams on retry", async ({
    page
  }) => {
    await stubMediaCapture(page, { denyScreen: true });
    await gotoSession(page);
    await advanceToSetup(page);
    await startRecordedStudy(page);

    await expectSectionStatus(page, 2, "current");
    await expect(page.getByText("Recording could not start")).toBeVisible();
    await expect(page.getByText(SCREEN_DENIED_MESSAGE)).toBeVisible();
    await expect(
      page.getByText("You are ready to go. Everything passed")
    ).toBeVisible();

    const startButton = page.getByRole("button", { name: "Start recording" });

    await expect(startButton).toBeEnabled();

    const firstAttempt = await readMediaCaptureCounts(page);

    expect(firstAttempt.getUserMedia).toBe(1);
    expect(firstAttempt.getDisplayMedia).toBe(1);

    await startButton.click();

    // The granted microphone stream must not be held open across the failure:
    // release and re-request, so both prompts fire again.
    await expect
      .poll(async () => (await readMediaCaptureCounts(page)).getDisplayMedia)
      .toBe(2);

    const secondAttempt = await readMediaCaptureCounts(page);

    expect(secondAttempt.getUserMedia).toBe(2);
    await expect(page.getByText(SCREEN_DENIED_MESSAGE)).toBeVisible();
    await expect(startButton).toBeEnabled();
    await expectSectionStatus(page, 2, "current");
  });
});

// Counts POSTs to the direct-to-S3 presign endpoint - one per upload attempt in
// Cortex's S3-only path - excluding the finalize sibling route.
function trackRecordingUploadPosts(page: Page): string[] {
  const posts: string[] = [];

  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/firsthand\/session\/[^/]+\/recording\/client-upload(\?|$)/.test(
        request.url()
      )
    ) {
      posts.push(request.url());
    }
  });

  return posts;
}
