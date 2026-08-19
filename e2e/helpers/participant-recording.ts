import { expect, type Page } from "@playwright/test";

// Shared helpers for the six-state participant recording flow (Welcome,
// Consent, Setup and start, Task, Upload, Done), ported from FirstHand's
// e2e/helpers/participant-flow.ts and adapted to Cortex:
//  - the surface lives at `/session/:token` inside the Cortex SPA and is gated
//    by AuthContext, so a real logged-in employee is established first;
//  - the runtime/upload endpoints are `/api/firsthand/session/:token/*`;
//  - uploads are S3-only (client-upload -> presigned PUT -> finalize).
//
// These specs are End-of-B verification: they need `dev:all`, a seeded
// participant session bound to the demo employee, `FIRSTHAND_INTERNAL=1`, and
// (for the real upload leg) the S3 grant tracked as OPS-3. They are NOT part of
// the build-only CI. Provide the bound token via FIRSTHAND_E2E_SESSION_TOKEN.

/**
 * Paths are relative so `use.baseURL` from the running config decides the
 * target. A module-level BASE_URL here would silently win over the config -
 * that is how `test:a11y:prod` ended up grading a different application.
 */
export const PARTICIPANT_E2E_ENABLED =
  process.env.FIRSTHAND_PARTICIPANT_E2E === "1";
export const BOUND_SESSION_TOKEN =
  process.env.FIRSTHAND_E2E_SESSION_TOKEN || "";
const SETUP_VERDICT = "You are ready to go. Everything passed";

export type MediaCaptureOptions = {
  denyMicrophone?: boolean;
  denyScreen?: boolean;
};

export type MediaCaptureCounts = {
  getUserMedia: number;
  getDisplayMedia: number;
};

const stubbedPages = new WeakSet<Page>();

// Runs in the page. Synthetic streams stand in for the screen and microphone so
// the real record/upload path runs without native permission dialogs. Every
// invocation of the capture APIs is counted on the window so tests can prove
// how many times the browser would have prompted.
function installMediaCaptureStub(options: MediaCaptureOptions): void {
  const captureWindow = window as Window & {
    __firsthandDisplayStream?: MediaStream;
    __firsthandMediaCaptureCounts?: {
      getUserMedia: number;
      getDisplayMedia: number;
    };
  };
  const counts = { getUserMedia: 0, getDisplayMedia: 0 };

  captureWindow.__firsthandMediaCaptureCounts = counts;

  const canvas = document.createElement("canvas");

  canvas.width = 640;
  canvas.height = 360;
  canvas.getContext("2d")?.fillRect(0, 0, 640, 360);

  const videoStream = canvas.captureStream(5);
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  audioContext.createOscillator().connect(destination);

  navigator.mediaDevices.getUserMedia = async () => {
    counts.getUserMedia += 1;

    if (options.denyMicrophone) {
      throw new DOMException("Microphone access was denied.", "NotAllowedError");
    }

    return new MediaStream(destination.stream.getAudioTracks());
  };

  navigator.mediaDevices.getDisplayMedia = async () => {
    counts.getDisplayMedia += 1;

    if (options.denyScreen) {
      throw new DOMException("Screen capture was denied.", "NotAllowedError");
    }

    const displayStream = new MediaStream(videoStream.getVideoTracks());

    captureWindow.__firsthandDisplayStream = displayStream;

    return displayStream;
  };

  // The setup flow opens the task page in its own window before recording. Stub
  // window.open so no real popup spawns, always report the window as opened
  // (never pop-up blocked), and record the URLs it navigated to.
  const openWindow = window as Window & {
    __firsthandTaskWindowOpens?: string[];
  };
  const taskWindowOpens: string[] = [];

  openWindow.__firsthandTaskWindowOpens = taskWindowOpens;

  window.open = ((url?: string | URL) => {
    const href = typeof url === "string" ? url : url?.toString() ?? "";

    if (href) {
      taskWindowOpens.push(href);
    }

    let currentHref = href;
    const fakeLocation = {
      get href() {
        return currentHref;
      },
      set href(value: string) {
        currentHref = value;
        taskWindowOpens.push(value);
      }
    };

    const fakeWindow = {
      closed: false,
      opener: {} as unknown,
      focus() {},
      blur() {},
      close() {
        fakeWindow.closed = true;
      },
      location: fakeLocation
    };

    return fakeWindow as unknown as Window;
  }) as typeof window.open;
}

export async function stubMediaCapture(
  page: Page,
  options: MediaCaptureOptions = {}
): Promise<void> {
  stubbedPages.add(page);

  await page.addInitScript(installMediaCaptureStub, options);

  if (!page.url().startsWith("about:")) {
    await page.evaluate(installMediaCaptureStub, options);
  }
}

export async function readMediaCaptureCounts(
  page: Page
): Promise<MediaCaptureCounts> {
  return page.evaluate(() => {
    const captureWindow = window as Window & {
      __firsthandMediaCaptureCounts?: {
        getUserMedia: number;
        getDisplayMedia: number;
      };
    };

    return (
      captureWindow.__firsthandMediaCaptureCounts ?? {
        getUserMedia: 0,
        getDisplayMedia: 0
      }
    );
  });
}

/**
 * Establish the logged-in employee identity the recording surface is gated on.
 * Uses Cortex's seeded demo-login (role `employee`, fixed user id), the same
 * harness pattern as the other Cortex e2e specs. The seeded session token must
 * be minted for that same participant id (see file header).
 */
export async function loginAsParticipant(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: "domcontentloaded" });
  await page.goto('/api/auth/demo-login', {
    waitUntil: "load",
    timeout: 15000
  });
  await page.waitForURL(/\/(?:$|\?)/, { timeout: 10000 }).catch(() => {
    // demo-login redirects to '/'; a slow redirect is not fatal for the goto
    // that follows.
  });
}

export async function gotoSession(
  page: Page,
  token: string = BOUND_SESSION_TOKEN
): Promise<void> {
  await page.goto(`/session/${token}`);
}

export async function advanceToSetup(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue to consent" }).click();
  await page
    .getByRole("button", { name: "I agree and want to continue" })
    .click();
}

export async function startRecordedStudy(page: Page): Promise<void> {
  await expect(page.getByText(SETUP_VERDICT)).toBeVisible();

  // A recorded study with a task page opens that page in its own window first,
  // then starts recording and shares it. A survey-style study with no task page
  // keeps the single start action.
  const openTaskPage = page.getByRole("button", { name: "Open the task page" });

  if ((await openTaskPage.count()) > 0) {
    await openTaskPage.click();
    await page.getByRole("button", { name: "Start recording" }).click();

    return;
  }

  await page.getByRole("button", { name: "Start recorded study" }).click();
}

export async function advanceToTask(page: Page, token?: string): Promise<void> {
  if (!stubbedPages.has(page)) {
    await stubMediaCapture(page);
  }

  await gotoSession(page, token);
  await advanceToSetup(page);
  await startRecordedStudy(page);

  await expect(
    page.locator(".recording-callout-title", { hasText: "Recording is live" })
  ).toBeVisible();
}

export function getJourneyRailItem(page: Page, index: number) {
  return page.locator(".journey-vitem").nth(index);
}

// Ends screen sharing the way a participant does: from the browser's own
// stop-sharing control. A programmatic stop() does not fire the track's "ended"
// event, so the event the browser would fire is dispatched explicitly.
export async function endScreenShareExternally(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stream = (
      window as Window & { __firsthandDisplayStream?: MediaStream }
    ).__firsthandDisplayStream;
    const track = stream?.getVideoTracks()[0];

    if (!track) {
      throw new Error("Expected the stubbed display stream to be exposed.");
    }

    track.stop();
    track.dispatchEvent(new Event("ended"));
  });
}

export const FLOW_SECTION_LABELS = [
  "Welcome",
  "Consent",
  "Setup and start",
  "Task",
  "Upload",
  "Done"
] as const;

export const FLOW_SECTION_GATES = [
  "",
  "Unlocks after welcome",
  "Unlocks after consent",
  "Unlocks once recording is live",
  "Unlocks when the task is completed",
  "Unlocks after upload succeeds"
] as const;

export function getFlowSection(page: Page, index: number) {
  return page.locator(".journey-block").nth(index);
}

export async function expectSectionStatus(
  page: Page,
  index: number,
  status: "locked" | "current" | "done" | "ended"
): Promise<void> {
  await expect(getFlowSection(page, index)).toHaveClass(
    new RegExp(`journey-block--${status}\\b`)
  );
}

export async function expectSectionLocked(
  page: Page,
  index: number
): Promise<void> {
  await expectSectionStatus(page, index, "locked");
  await expect(
    getFlowSection(page, index).getByText(FLOW_SECTION_GATES[index])
  ).toBeVisible();
}

// Fail the first direct-to-S3 upload once, then let subsequent attempts
// through. Cortex uploads S3-only, so the failure is injected at the
// presign (client-upload) step - the earliest point of the S3 upload chain -
// which is enough to drive the recorder into its retryable failed state
// without a byte leaving the browser.
export async function interceptUploadFailureOnce(page: Page): Promise<void> {
  let uploadAttempts = 0;

  await page.route(
    "**/api/firsthand/session/*/recording/client-upload*",
    async (route) => {
      uploadAttempts += 1;

      if (uploadAttempts === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "upload exploded" })
        });

        return;
      }

      await route.continue();
    }
  );
}
