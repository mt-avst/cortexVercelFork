import { test, expect } from '@playwright/test';

/**
 * M6 Poll/Survey Click Tracking E2E
 * Flow: Login as admin → Create poll → Publish → Open public detail → Click "Open Poll" → Verify click tracked.
 * Optional: Verify analytics shows the click.
 */
const UNIQUE_TITLE = `M6 E2E Poll ${Date.now()}`;

test.describe('M6 Poll Click Tracking', () => {
  test('publish poll, click Open Poll, verify click is tracked', async ({ page }) => {
    test.setTimeout(120000);

    // --- 1. Login as admin ---
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/api/auth/admin-login', { waitUntil: 'load', timeout: 15000 });
    // Wait for redirect to /admin and for admin UI (auth check may take a few seconds)
    await expect(page).toHaveURL(/\/admin/, { timeout: 25000 });
    await expect(page.getByText(/Research studies|Create|Opportunities/i).first()).toBeVisible({ timeout: 15000 });

    // --- 2. Create poll with external link ---
    // Navigate to create page. Set loginRedirect so AuthContext treats the load as "returning from login"
    // and keeps the session (otherwise it clears cookies on full load).
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/admin/opportunities/new', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/admin\/opportunities\/new/, { timeout: 15000 });
    // Form may show auth loading first; wait for type dropdown (Basic Info tab)
    await page.waitForSelector('#type', { state: 'visible', timeout: 20000 });

    await page.selectOption('#type', 'poll');
    await page.waitForTimeout(300);
    await page.fill('#title', UNIQUE_TITLE);
    await page.fill('#purpose_one_liner', 'M6 E2E click tracking test');

    await page.locator('.nav-link').filter({ hasText: 'Content' }).click();
    await page.waitForTimeout(500);
    await page.locator('.nav-link').filter({ hasText: 'External Link' }).click();
    await page.waitForTimeout(300);
    await page.fill('#external_link_optional', 'https://example.com/m6-poll');

    await page.getByRole('button', { name: /Create Opportunity/i }).click();
    await page.waitForTimeout(5000);
    await expect(page.getByRole('button', { name: /Return to Dashboard/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /Return to Dashboard/i }).click();
    await page.waitForURL(/\/admin/, { timeout: 8000 });
    await page.waitForTimeout(2000);

    // --- 3. Open Edit for our poll and publish ---
    await expect(page.getByText(UNIQUE_TITLE)).toBeVisible({ timeout: 10000 });
    // Open dropdown for the row containing our title (kebab ⋮)
    const row = page.locator('tr').filter({ has: page.getByText(UNIQUE_TITLE) });
    await row.locator('button[title="Actions"]').click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.waitForURL(/\/admin\/opportunities\/[^/]+\/edit/, { timeout: 8000 });

    const editUrl = page.url();
    const opportunityIdMatch = editUrl.match(/\/admin\/opportunities\/([^/]+)\/edit/);
    const opportunityId = opportunityIdMatch ? opportunityIdMatch[1] : null;
    expect(opportunityId).toBeTruthy();

    // Ensure we're on Basic Info tab and change status to published
    await page.waitForSelector('#status', { state: 'visible', timeout: 10000 });
    await page.selectOption('#status', 'published');
    await page.waitForTimeout(800);
    
    // Visit External Link tab to ensure validation runs (poll requires external link when published)
    await page.locator('.nav-link').filter({ hasText: 'External Link' }).click();
    await page.waitForTimeout(500);
    
    // Scroll to bottom where submit button is and click Update
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    
    const updateBtn = page.getByRole('button', { name: 'Update Opportunity' });
    await updateBtn.waitFor({ state: 'visible', timeout: 10000 });
    await updateBtn.scrollIntoViewIfNeeded();
    await updateBtn.click();
    await page.waitForTimeout(3000);

    // --- 4. Open public opportunity detail and listen for click POST ---
    const clickRequestPromise = page.waitForRequest(
      (req) => {
        const url = req.url();
        return req.method() === 'POST' && /\/api\/opportunities\/[^/]+\/click/.test(url);
      },
      { timeout: 15000 }
    );

    const clickResponsePromise = page.waitForResponse(
      (res) => {
        const url = res.url();
        return res.request().method() === 'POST' && /\/api\/opportunities\/[^/]+\/click/.test(url) && res.status() === 200;
      },
      { timeout: 15000 }
    );

    await page.goto(`/opportunities/${opportunityId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const openPollButton = page.getByRole('button', { name: /Open Poll|Open poll/i });
    await expect(openPollButton).toBeVisible({ timeout: 8000 });

    await openPollButton.click();

    const clickRequest = await clickRequestPromise;
    const clickResponse = await clickResponsePromise;

    expect(clickRequest.url()).toContain(`/opportunities/${opportunityId}/click`);
    expect(clickResponse.status()).toBe(200);

    const responseBody = await clickResponse.json().catch(() => ({}));
    expect(responseBody.ok).toBe(true);

    // --- 5. Click tracking verified! ---
    // The POST /api/opportunities/:id/click returned 200, confirming the click was recorded.
    // Analytics dashboard verification skipped due to E2E session management complexity.
    // To manually verify analytics: Admin → Edit poll → Analytics button (or /admin/opportunities/:id/analytics)
  });

  test('clicking Open Poll sends POST to click endpoint (request assertion only)', async ({ page }) => {
    test.setTimeout(60000);
    // Navigate to home and find any poll/survey card; if none, skip. Then open detail and click Open Poll, assert POST /click.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const pollCard = page.locator('a[href*="/opportunities/"]').filter({ has: page.locator('text=Poll') }).first();
    const surveyCard = page.locator('a[href*="/opportunities/"]').filter({ has: page.locator('text=Survey') }).first();
    const card = pollCard.or(surveyCard);
    const count = await card.count();
    if (count === 0) {
      test.skip();
      return;
    }

    const href = await card.getAttribute('href');
    const idMatch = href?.match(/\/opportunities\/([^/?#]+)/);
    const opportunityId = idMatch?.[1];
    if (!opportunityId) {
      test.skip();
      return;
    }

    const clickResponsePromise = page.waitForResponse(
      (res) => {
        const url = res.url();
        return res.request().method() === 'POST' && /\/api\/opportunities\/[^/]+\/click/.test(url);
      },
      { timeout: 12000 }
    );

    await card.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    const openButton = page.getByRole('button', { name: /Open Poll|Open Survey/i });
    if ((await openButton.count()) === 0) {
      test.skip();
      return;
    }
    await openButton.click();

    const response = await clickResponsePromise;
    expect(response.status()).toBe(200);
    const body = await response.json().catch(() => ({}));
    expect(body.ok).toBe(true);
  });
});
