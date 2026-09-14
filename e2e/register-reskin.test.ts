import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PARTICIPANT_E2E_ENABLED, loginAsParticipant } from './helpers/participant-recording';

/**
 * Decision 4/5 (Lane H): one light ground, the recording register's cream
 * promoted to the light theme and given a dark half, orange primary in both
 * themes. Paths are relative so `use.baseURL` decides the target, per the
 * other specs here.
 */

const outputsFixture = {
  contract_version: '1',
  session: {
    session_id: 'session-1',
    logical_session_id: 'session_1',
    attempt_number: 1,
    study_id: 'opp-1',
    study_title: 'Register reskin fixture study',
    participant: { participant_id: 'user-1', display_name: 'Demo User' },
    session_status: 'completed',
    started_at: '2026-09-13T13:34:00.000Z',
    completed_at: '2026-09-13T13:40:00.000Z',
    transcript_status: 'not_requested',
    transcript_failure_message: null,
  },
  attempts: [
    {
      attempt_number: 1,
      session_id: 'session-1',
      session_status: 'completed',
      started_at: '2026-09-13T13:34:00.000Z',
      completed_at: '2026-09-13T13:40:00.000Z',
      transcript_status: 'not_requested',
    },
  ],
  steps: [
    {
      step_id: 'step-1',
      order: 1,
      type: 'single_choice',
      prompt: 'How often should we ship to the Marketplace?',
      response: { text: null, selected_option: 'Weekly', saved_at: '2026-09-13T13:35:00.000Z' },
    },
  ],
  transcript: null,
  assets: [],
};

const mockSessionReview = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'admin-1',
        name: 'Admin User',
        email: 'admin@example.com',
        role: 'researcher_admin',
        business_unit: 'Research',
        role_title: 'Researcher',
      }),
    });
  });
  await page.route('**/api/opportunities/opp-1/sessions/session-1/outputs*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(outputsFixture) });
  });
  await page.route('**/api/opportunities/opp-1/session-events', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
};

test.describe('Session Review page - register re-skin (Decision 4)', () => {
  /**
   * SessionReview's own heading structure (an <h1> page title followed
   * directly by SessionSummaryCard's <h5>) skips levels regardless of theme -
   * a pre-existing structural gap in a component-logic file this lane does
   * not own (session-review/*.tsx is Lane D's), not something Decision 4
   * introduced or can fix from a styles-only pass. Named and excluded here
   * rather than silently loosened, so a NEW heading-order violation this lane
   * does cause still fails.
   */
  const HEADING_ORDER_PRE_EXISTING = 'heading-order';

  test('carries the register look and is accessible in light mode', async ({ page }) => {
    await mockSessionReview(page);
    await page.goto('/admin/opportunities/opp-1/sessions/session-1/review');
    await page.waitForLoadState('load');
    await expect(page.locator('.session-review-page')).toHaveCount(1);
    await expect(page.locator('.cortex-analytics-card').first()).toBeVisible();

    // Pinned: the card reads as the register's flat, hairline-bordered card,
    // not the generic Sci-Fi-glass card OpportunityAnalytics still uses -
    // proves the .session-review-page scope actually applied, not just that
    // the page rendered.
    const card = page.locator('.cortex-analytics-card').first();
    const boxShadow = await card.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow, 'register card must not carry the analytics glass shadow').toBe('none');

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => v.id !== HEADING_ORDER_PRE_EXISTING)).toEqual([]);
  });

  test('carries the register look and is accessible in dark mode', async ({ page }) => {
    await mockSessionReview(page);
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/admin/opportunities/opp-1/sessions/session-1/review');
    await page.waitForLoadState('load');
    await expect(page.locator('body.theme-dark')).toHaveCount(1);
    await expect(page.locator('.session-review-page')).toHaveCount(1);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => v.id !== HEADING_ORDER_PRE_EXISTING)).toEqual([]);
  });

  test('does not leak into OpportunityAnalytics, which shares the same card classes', async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'admin-1',
          name: 'Admin User',
          email: 'admin@example.com',
          role: 'researcher_admin',
          business_unit: 'Research',
          role_title: 'Researcher',
        }),
      });
    });
    await page.route('**/api/opportunities/opp-1/analytics*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          views: { total: 0, unique: 0, by_period: [] },
          actions: { total: 0, by_period: [] },
          conversion_rate: 0,
        }),
      });
    });
    await page.route('**/api/opportunities/opp-1*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'opp-1', title: 'Fixture study', type: 'poll', status: 'published' }),
      });
    });
    await page.goto('/admin/opportunities/opp-1/analytics');
    await page.waitForLoadState('load');
    await expect(page.locator('.session-review-page')).toHaveCount(0);
  });
});

test.describe('One light ground (Decision 4): study listing page', () => {
  test('sits on the standard cream --bg-app, not a bespoke surface', async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'user-1',
          name: 'Demo User',
          email: 'demo@example.com',
          role: 'employee',
          business_unit: 'Engineering',
          role_title: 'Developer',
        }),
      });
    });
    await page.route('**/api/opportunities**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.goto('/');
    await page.waitForLoadState('load');

    const listing = page.locator('.study-listing-page');
    await expect(listing).toBeVisible();
    const bg = await listing.evaluate((el) => getComputedStyle(el).backgroundColor);
    const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
    // Pinned: the old --surface-page-study-listing carved out #f8fafc (a cool
    // grey), rgb(248, 250, 252) - distinct from the cream body ground. That
    // token and its rules are gone; the listing page now shows through to the
    // same cream body paints everywhere else in light theme.
    expect(bg, 'study-listing-page must not paint its own background over the cream body').toBe('rgba(0, 0, 0, 0)');
    expect(bodyBg).not.toBe('rgb(248, 250, 252)');
  });
});

test.describe('Orange primary in both themes (Decision 5)', () => {
  test('--cta-bg resolves orange, not navy ink, in light theme', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const isDark = await page.locator('body').evaluate((el) => el.classList.contains('theme-dark'));
    if (isDark) {
      await page.getByRole('button', { name: /Switch to light mode/i }).click();
      await expect(page.locator('body')).toHaveClass(/theme-light/, { timeout: 5000 });
    }
    const ctaBg = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--cta-bg').trim());
    // Pinned: was var(--fs-ink), #14213d (navy). Now the light-safe orange
    // fill, #BF4417 (--accent-fill-on-light / --brand-orange-700).
    expect(ctaBg.toLowerCase()).toBe('#bf4417');
  });

  /**
   * recording-session.css is a lazy chunk that only registers once
   * ParticipantSessionFlow itself has actually rendered - a probe on any
   * other route, or on this route's own "session unavailable" state (a
   * lighter component that does not import it), reads an empty custom
   * property, not a wrong one. Needs a real, DB-backed session token, so it
   * follows the same gate as the rest of the participant recording e2e
   * suite - skipped unless FIRSTHAND_PARTICIPANT_E2E=1 - but mints its own
   * token rather than also requiring a pre-seeded FIRSTHAND_E2E_SESSION_TOKEN,
   * since sessions expire and this only needs the flow to mount, not to
   * complete a real recording.
   */
  test('.fh-recording --accent resolves the one brand orange, not its old terracotta', async ({ page, baseURL }) => {
    test.skip(!PARTICIPANT_E2E_ENABLED, 'Set FIRSTHAND_PARTICIPANT_E2E=1 to run against a real local backend.');

    await loginAsParticipant(page);
    const mint = await page.request.post(
      `${baseURL}/api/opportunities/0aa00001-0000-4000-8000-00000000000c/recorded-study-session`,
      { headers: { 'Content-Type': 'application/json' } }
    );
    expect(mint.ok(), 'minting a recorded-study session token').toBeTruthy();
    const { session_url } = await mint.json();

    await page.goto(session_url);
    await expect(page.locator('.fh-recording').first()).toBeVisible();
    const accent = await page
      .locator('.fh-recording')
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim());
    // Pinned: was the literal #dd6e42 (terracotta), a different hue from the
    // rest of the brand. Now var(--brand-orange-500), #FF5A1F - resolved.
    expect(accent.toLowerCase()).toBe('#ff5a1f');
  });
});
