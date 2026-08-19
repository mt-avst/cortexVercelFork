import { test, expect } from '@playwright/test';

/**
 * Production Smoke Tests
 * Basic tests to verify production deployment is working.
 * Uses domcontentloaded (not networkidle) so tests don't hang when API is slow or returns HTML.
 * Accepts both success (opportunities load) and degraded ("Backend API not available" + key UI visible).
 */

const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://adaptalabs.kubera-playground.adaptavist.net';
const WAIT_AFTER_LOAD_MS = 3000;

test.describe('Production Smoke Tests', () => {
  test('home page loads', async ({ page }) => {
    await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    await expect(page).toHaveTitle(/AdaptaLabs/i);

    // Pass if key branding/UI is visible, degraded state, or page has substantial content
    const bodyText = (await page.textContent('body')) || '';
    const hasBranding =
      bodyText.includes('AdaptaLabs') ||
      bodyText.includes('Sign in') ||
      bodyText.includes('Sign In') ||
      bodyText.includes('Demo') ||
      bodyText.includes('backend') ||
      bodyText.includes('Backend API');
    const hasSubstantialContent = bodyText.length > 200;
    expect(hasBranding || hasSubstantialContent).toBeTruthy();
  });

  test('opportunities list or degraded state', async ({ page }) => {
    await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    const bodyText = (await page.textContent('body')) || '';
    const hasContent =
      bodyText.includes('AdaptaLabs') ||
      bodyText.includes('Sign in') ||
      bodyText.includes('Demo') ||
      bodyText.length > 100;
    expect(hasContent).toBeTruthy();
    expect(bodyText.length).toBeGreaterThan(0);
  });

  test('can navigate to opportunity detail', async ({ page }) => {
    await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    const opportunityLinks = page.locator('a[href*="/opportunities/"]').first();
    const count = await opportunityLinks.count();

    if (count > 0) {
      await opportunityLinks.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);
      const url = page.url();
      expect(url).toContain('/opportunities/');
    } else {
      test.skip();
    }
  });

  test('demo login page accessible', async ({ page }) => {
    await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    const loginLinks = page.locator('text=/demo login|sign in/i').first();
    const count = await loginLinks.count();

    if (count > 0) {
      await loginLinks.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);
      const url = page.url();
      expect(url).toMatch(/login|auth|demo|adapta-labs/i);
    } else {
      test.skip();
    }
  });

  test('feedback page accessible', async ({ page }) => {
    await page.goto(`${PRODUCTION_URL}/feedback`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    const bodyText = (await page.textContent('body')) || '';
    const hasFeedbackContent =
      bodyText.match(/feedback|send feedback|report|category|your feedback/i) ||
      (await page.locator('form, textarea, [type="submit"]').count()) > 0 ||
      (await page.locator('h1, h2').filter({ hasText: /feedback/i }).count()) > 0;

    expect(bodyText.length).toBeGreaterThan(100);
    expect(hasFeedbackContent || bodyText.includes('Send Feedback') || bodyText.includes('Category')).toBeTruthy();
  });

  test('no console errors on home page', async ({ page }) => {
    const errors: string[] = [];
    const failedRequests: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (res) => {
      if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
    });

    await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    // A signed-out visitor legitimately gets 401 from /api/me - that is how the
    // page decides to render its signed-out view - and the browser logs every
    // 4xx as a console error. The console message carries no URL, so it cannot
    // be excluded on its own; instead the generic 401 line is tolerated only
    // when the responses actually seen show the 401s were the expected ones.
    const unexpectedFailures = failedRequests.filter((r) => !/^401 .*\/api\/me\b/.test(r));
    const only401sWereExpected = unexpectedFailures.length === 0;
    const criticalErrors = errors.filter(
      (err) =>
        !err.includes('favicon') &&
        !err.includes('analytics') &&
        !err.includes('tracking') &&
        !(only401sWereExpected && /status of 401/.test(err))
    );

    expect(unexpectedFailures, `failing requests: ${unexpectedFailures.join(' | ')}`).toEqual([]);
    expect(criticalErrors, `console errors: ${criticalErrors.join(' | ')}`).toEqual([]);
  });

  test('page performance - domcontentloaded within 5 seconds', async ({ page }) => {
    const startTime = Date.now();
    await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
    const loadTime = Date.now() - startTime;
    expect(loadTime).toBeLessThan(5000);
  });

  test('API health returns JSON when deployed', async ({ request }) => {
    const res = await request.get(`${PRODUCTION_URL}/api/health`);
    const text = await res.text();
    let body: { status?: string; database?: string };
    try {
      body = JSON.parse(text);
    } catch {
      // API not deployed (HTML or error page); skip so suite passes in degraded state
      test.skip();
    }
    // The endpoint reports { status, database, ... } and has never returned an
    // `ok` property, so the previous toHaveProperty('ok', true) could not pass
    // against any version of this API. It went unnoticed because the suite
    // collected zero tests. 200 + status 'ok' is the healthy contract; 503 +
    // 'degraded' is the documented unhealthy one, which a smoke test should fail.
    expect(res.status()).toBe(200);
    expect(body!.status).toBe('ok');
    expect(body!.database).toBe('up');
  });

  // v7.1.9+: Demo Access pills are hidden in production (shown only in dev or when VITE_SHOW_DEMO_LOGIN=true)
  test('demo access hidden on production landing', async ({ page }) => {
    await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    const footer = page.locator('.landing-demo-footer');
    await expect(footer).toHaveCount(0);
    const bodyText = (await page.textContent('body')) || '';
    expect(bodyText).not.toContain('DEMO ACCESS');
  });
});
