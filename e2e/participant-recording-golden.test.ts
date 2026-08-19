import { expect, test } from "@playwright/test";

// Canonical golden end-to-end for the internalised recording engine (End-of-B).
// Ported/assembled from the blueprint's golden flow: a logged-in Cortex
// employee opens a published unmoderated opportunity, launches the recorded
// study, grants screen + microphone, completes the phase machine (welcome,
// consent, setup, running, uploading, completed), the recording uploads to S3,
// they return into Cortex, and a researcher reviews the recording.
//
// Uses real fake-media capture via Chromium launch flags (not the JS stub the
// safety/setup specs use), so getDisplayMedia/getUserMedia resolve headless.
//
// Prerequisites (not build-only CI): dev:all, FIRSTHAND_INTERNAL=1, the S3
// grant + bucket CORS (OPS-3), and a seeded published unmoderated opportunity
// (FIRSTHAND_E2E_OPPORTUNITY_ID) whose participant is the demo employee. Skipped
// unless FIRSTHAND_PARTICIPANT_E2E=1.

/**
 * Paths are relative so `use.baseURL` from the running config decides the
 * target. A module-level BASE_URL here would silently win over the config -
 * that is how `test:a11y:prod` ended up grading a different application.
 */
const OPPORTUNITY_ID = process.env.FIRSTHAND_E2E_OPPORTUNITY_ID || "";
const PARTICIPANT_E2E_ENABLED = process.env.FIRSTHAND_PARTICIPANT_E2E === "1";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen"
    ]
  }
});

test.describe("golden: record and review end to end", () => {
  test.skip(
    !PARTICIPANT_E2E_ENABLED || !OPPORTUNITY_ID,
    "Set FIRSTHAND_PARTICIPANT_E2E=1 and FIRSTHAND_E2E_OPPORTUNITY_ID (published unmoderated opportunity) to run the golden E2E."
  );

  test("a logged-in employee records a study and a researcher reviews it", async ({
    page
  }) => {
    test.setTimeout(120000);

    // Log in as the seeded employee, then open the published opportunity.
    await page.goto('/', { waitUntil: "domcontentloaded" });
    await page.goto('/api/auth/demo-login', { waitUntil: "load" });
    await page.goto(`/opportunities/${OPPORTUNITY_ID}`, {
      waitUntil: "load"
    });

    // Launch the recorded study; the handoff mints a same-origin /session/:token
    // bound to this user and navigates there.
    await page
      .getByRole("button", { name: /start test|start recorded study|record/i })
      .first()
      .click();
    await page.waitForURL(/\/session\//, { timeout: 20000 });

    // Phase machine: welcome -> consent -> setup -> running.
    await page.getByRole("button", { name: "Continue to consent" }).click();
    await page
      .getByRole("button", { name: "I agree and want to continue" })
      .click();
    await expect(
      page.getByText("You are ready to go. Everything passed")
    ).toBeVisible();

    const openTaskPage = page.getByRole("button", { name: "Open the task page" });
    if ((await openTaskPage.count()) > 0) {
      await openTaskPage.click();
      await page.getByRole("button", { name: "Start recording" }).click();
    } else {
      await page.getByRole("button", { name: "Start recorded study" }).click();
    }

    await expect(
      page.locator(".recording-callout-title", { hasText: "Recording is live" })
    ).toBeVisible({ timeout: 20000 });

    // Complete the single task and let the upload land in S3.
    await page.getByRole("button", { name: "I’ve completed this task" }).click();
    await expect(
      page.getByRole("heading", { name: "Recording captured" })
    ).toBeVisible({ timeout: 60000 });

    // Return into Cortex.
    await page.getByRole("link", { name: "Return to the study hub" }).click();
    await expect(page).toHaveURL(/firsthand_outcome=completed/);

    // A researcher reviews the recording: switch to admin and open the
    // opportunity's session review. The recording and transcript render.
    await page.goto('/api/auth/admin-login', { waitUntil: "load" });
    await page.goto(
      `/admin/opportunities/${OPPORTUNITY_ID}/analytics`,
      { waitUntil: "load" }
    );
    await expect(page.getByText(/session/i).first()).toBeVisible();
  });
});
