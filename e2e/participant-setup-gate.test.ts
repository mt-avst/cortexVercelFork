import { devices, expect, test } from "@playwright/test";

import {
  BOUND_SESSION_TOKEN,
  PARTICIPANT_E2E_ENABLED,
  advanceToSetup,
  expectSectionStatus,
  getFlowSection,
  gotoSession,
  loginAsParticipant
} from "./helpers/participant-recording";

// Ported from FirstHand e2e/participant-setup-gate.spec.ts (the oracle).
//
// Scope is now the device gate and the auto-running setup checks. The rest of
// this file - the block-card mechanics, the launch sequence, the read-only
// setup - was removed in the same change that deleted
// participant-recording-safety and participant-recording-golden: those specs
// had never run, and asserted on a DOM the participant flow deliberately no
// longer renders. See that commit for what would need rebuilding.
//
// Skipped unless FIRSTHAND_PARTICIPANT_E2E=1 with a seeded bound session; mint
// one with POST /api/opportunities/:id/recorded-study-session, because the
// sessions in the table expire.

const SETUP_VERDICT = "You are ready to go. Everything passed";

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





});

