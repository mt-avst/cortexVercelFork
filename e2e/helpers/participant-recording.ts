import { expect, type Page } from "@playwright/test";

/**
 * Helpers for the participant recording flow at `/session/:token`.
 *
 * This file used to carry the media-capture stubs, the launch sequence, the
 * upload-failure interception and the journey-block gate assertions. All of it
 * existed for participant-recording-safety and participant-recording-golden,
 * which were deleted: they had never run once, and asserted on a DOM the
 * participant flow deliberately no longer renders (ParticipantSessionFlow
 * returns null for locked steps). Rebuilding that coverage means writing
 * against the Journey rail, not restoring this.
 *
 * Paths are relative so `use.baseURL` from the running config decides the
 * target.
 */

export const PARTICIPANT_E2E_ENABLED =
  process.env.FIRSTHAND_PARTICIPANT_E2E === "1";

/**
 * A session token bound to the demo employee. Mint a fresh one per run with
 * POST /api/opportunities/:id/recorded-study-session - the rows already in
 * firsthand.runtime_sessions expire, so an old token is rejected.
 */
export const BOUND_SESSION_TOKEN =
  process.env.FIRSTHAND_E2E_SESSION_TOKEN || "";

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
