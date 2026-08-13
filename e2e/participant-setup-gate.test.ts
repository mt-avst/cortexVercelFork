import { devices, expect, test, type Page } from "@playwright/test";

import {
  BOUND_SESSION_TOKEN,
  PARTICIPANT_E2E_ENABLED,
  advanceToSetup,
  advanceToTask,
  expectSectionLocked,
  expectSectionStatus,
  getFlowSection,
  gotoSession,
  loginAsParticipant
} from "./helpers/participant-recording";

// Ported from FirstHand e2e/participant-setup-gate.spec.ts (the oracle).
// Covers the merged Setup and start block: checks auto-run on arrival, the
// verdict sits above the check rows above the launch sequence, and the launch
// is the two ordered sub-steps (open the task page, then start recording and
// share it), plus the block-card mechanics (locked gates, done-state doneline).
//
// End-of-B verification (see participant-recording-safety.test.ts header).
// Skipped unless FIRSTHAND_PARTICIPANT_E2E=1 with a seeded bound session.

const SETUP_VERDICT = "You are ready to go. Everything passed";
const RUNTIME_URL_PATTERN = /\/api\/firsthand\/session\/[^/]+\/runtime(\?|$)/;

test.describe("participant setup gate", () => {
  test.skip(
    !PARTICIPANT_E2E_ENABLED || !BOUND_SESSION_TOKEN,
    "Set FIRSTHAND_PARTICIPANT_E2E=1 and FIRSTHAND_E2E_SESSION_TOKEN to run the participant recording E2E."
  );

  test.beforeEach(async ({ page }) => {
    await loginAsParticipant(page);
  });

  test.describe("on a phone", () => {
    test.use({
      userAgent: devices["iPhone 13"].userAgent,
      viewport: devices["iPhone 13"].viewport
    });

    test("a participant is stopped before consenting to a recording their device cannot make", async ({
      page
    }) => {
      await gotoSession(page);

      await expect(
        page.getByText("You cannot take part on this device")
      ).toBeVisible();
      await expect(page.getByText(/laptop or desktop/i).first()).toBeVisible();

      await expect(
        page.getByRole("button", { name: "Continue to consent" })
      ).toBeDisabled();
    });

    test("the device requirement is stated up front, not discovered", async ({
      page
    }) => {
      await gotoSession(page);

      await expect(page.getByText("Recorded · screen and mic")).toBeVisible();
      await expect(page.getByText("Laptop or desktop only")).toBeVisible();
    });
  });

  test("a desktop participant is not blocked", async ({ page }) => {
    await gotoSession(page);

    await expect(
      page.getByText("You cannot take part on this device")
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Continue to consent" })
    ).toBeEnabled();
  });

  test("every section after Welcome starts locked with the correct unlock copy", async ({
    page
  }) => {
    await gotoSession(page);

    await expectSectionStatus(page, 0, "current");

    for (let index = 1; index <= 5; index += 1) {
      await expectSectionLocked(page, index);
    }
  });

  test("setup checks run themselves the moment the stage is reached", async ({
    page
  }) => {
    await gotoSession(page);
    await advanceToSetup(page);

    await expectSectionStatus(page, 2, "current");

    const setupSection = getFlowSection(page, 2);

    await expect(setupSection.getByText(SETUP_VERDICT)).toBeVisible();

    await expect(
      page.getByRole("button", { name: "Check my setup" })
    ).toHaveCount(0);

    await expect(setupSection.locator(".journey-checkrow")).toHaveCount(4);

    await expect(setupSection.getByText("Chrome works for this session")).toBeVisible();
    await expect(setupSection.getByText("Your window is big enough")).toBeVisible();
    await expect(setupSection.getByText("A microphone is ready")).toBeVisible();
    await expect(setupSection.getByText("Screen sharing is ready")).toBeVisible();
  });

  test("the verdict sits above the results, the results above the launch sequence", async ({
    page
  }) => {
    await gotoSession(page);
    await advanceToSetup(page);

    const setupSection = getFlowSection(page, 2);

    await expect(setupSection.getByText(SETUP_VERDICT)).toBeVisible();

    const order = await setupSection.evaluate((section) => {
      const verdict = section.querySelector(".journey-verdict");
      const checklist = section.querySelector(".journey-checkrows");
      const launch = section.querySelector(".journey-launch");
      const open = Array.from(section.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Open the task page")
      );

      const precedes = (first: Element | null, second: Element | null) =>
        Boolean(
          first &&
            second &&
            first.compareDocumentPosition(second) &
              Node.DOCUMENT_POSITION_FOLLOWING
        );

      return {
        verdictBeforeChecklist: precedes(verdict, checklist),
        checklistBeforeLaunch: precedes(checklist, launch),
        launchContainsOpen: Boolean(launch && open && launch.contains(open))
      };
    });

    expect(order).toEqual({
      verdictBeforeChecklist: true,
      checklistBeforeLaunch: true,
      launchContainsOpen: true
    });
  });

  test("start is gated behind the checks and Check again re-runs them", async ({
    page
  }) => {
    const releaseFirstRun = await holdNextSetupCheck(page);

    await gotoSession(page);
    await advanceToSetup(page);

    const setupSection = getFlowSection(page, 2);

    await expect(setupSection.getByText("Checking your setup…")).toBeVisible();
    await expect(
      setupSection.locator(".journey-checkrow.is-pending")
    ).toHaveCount(4);
    await expect(
      setupSection.getByRole("button", { name: "Open the task page" })
    ).toBeDisabled();

    releaseFirstRun();

    await expect(setupSection.getByText(SETUP_VERDICT)).toBeVisible();
    await expect(
      setupSection.getByRole("button", { name: "Open the task page" })
    ).toBeEnabled();

    const releaseSecondRun = await holdNextSetupCheck(page);

    await setupSection.getByRole("button", { name: "Check again" }).click();

    await expect(setupSection.getByText("Checking your setup…")).toBeVisible();
    await expect(
      setupSection.getByRole("button", { name: "Open the task page" })
    ).toBeDisabled();

    releaseSecondRun();

    await expect(setupSection.getByText(SETUP_VERDICT)).toBeVisible();
    await expect(
      setupSection.getByRole("button", { name: "Open the task page" })
    ).toBeEnabled();
  });

  test("a failed check names itself in the verdict and expands with remediation", async ({
    page
  }) => {
    await gotoSession(page);
    await page.getByRole("button", { name: "Continue to consent" }).click();
    await page.setViewportSize({ width: 900, height: 800 });
    await page
      .getByRole("button", { name: "I agree and want to continue" })
      .click();

    await expectSectionStatus(page, 2, "current");

    const setupSection = getFlowSection(page, 2);

    await expect(
      setupSection.getByText("Window size needs attention before you can start")
    ).toBeVisible();

    await expect(setupSection.locator(".journey-checkrow")).toHaveCount(4);

    const failedRow = setupSection.locator(".journey-checkrow.is-fail");

    await expect(failedRow).toHaveCount(1);
    await expect(failedRow).toContainText(
      "This window is too narrow to run the session"
    );
    await expect(failedRow).toContainText(
      "Use a laptop or desktop, and make the browser window wider, then check again."
    );
    await expect(setupSection.locator(".journey-remediation")).toHaveCount(1);

    await expect(setupSection.getByText("Chrome works for this session")).toBeVisible();
    await expect(setupSection.getByText("Screen sharing is ready")).toBeVisible();

    await expect(
      setupSection.getByRole("button", { name: "Open the task page" })
    ).toBeDisabled();
  });

  test("the task state points at the recorded window rather than embedding it", async ({
    page
  }) => {
    await advanceToTask(page);

    await expectSectionStatus(page, 3, "current");

    const panel = getFlowSection(page, 3).locator(".task-window-panel");

    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Keep the task window open until you finish");
    // The warning is only true when the task window is the shared surface, and
    // whole-screen sharing is the fallback the launch step offers. Asserting
    // the qualifier keeps the unconditional "closing it stops the recording"
    // from coming back unnoticed.
    await expect(panel).toContainText("closing it ends the recording");
    await expect(
      panel.getByRole("button", { name: "Go to the task page" })
    ).toBeVisible();
  });

  test("the setup section becomes read-only once recording starts", async ({
    page
  }) => {
    await advanceToTask(page);

    await expectSectionStatus(page, 2, "done");

    const setupSection = getFlowSection(page, 2);

    await expect(getFlowSection(page, 2).locator(".journey-doneline")).toContainText(
      "completed"
    );
    await expect(
      setupSection.getByRole("button", { name: "Open the task page" })
    ).toHaveCount(0);
    await expect(
      setupSection.getByRole("button", { name: "Start recording" })
    ).toHaveCount(0);
    await expect(
      setupSection.getByRole("button", { name: "Check again" })
    ).toHaveCount(0);
  });
});

/**
 * Parks the next setup_started runtime event until the returned release
 * function is called, freezing the setup stage in its pending state.
 */
async function holdNextSetupCheck(page: Page): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;

  await page.route(RUNTIME_URL_PATTERN, async (route) => {
    const request = route.request();
    const body =
      request.method() === "POST"
        ? (request.postDataJSON() as { eventType?: string } | null)
        : null;

    if (!held && body?.eventType === "setup_started") {
      held = true;
      await gate;
    }

    await route.continue();
  });

  return release;
}
