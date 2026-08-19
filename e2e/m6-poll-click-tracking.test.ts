import { test, expect, type Request } from '@playwright/test';

/**
 * M6 Poll/Survey Click Tracking E2E
 * Flow: Login as admin → Create poll → Publish → Open public detail → Click "Open Poll" → Verify click tracked.
 * Optional: Verify analytics shows the click.
 */
const UNIQUE_TITLE = `M6 E2E Poll ${Date.now()}`;

/**
 * Match ONLY the click fired by pressing the action button.
 *
 * OpportunityDetail tracks a 'view' click on mount, so a predicate that matches
 * the URL alone is already satisfied by the time the button is pressed - these
 * tests passed with the button click removed entirely. Discriminating on
 * click_type is what makes them about click tracking rather than page load.
 */
const isActionClick = (req: Request): boolean => {
  if (req.method() !== 'POST') return false;
  if (!/\/api\/opportunities\/[^/]+\/click/.test(req.url())) return false;
  try {
    return req.postDataJSON()?.click_type === 'action';
  } catch {
    return false;
  }
};

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
    // The success alert - and the Return to Dashboard button inside it - is only
    // mounted until the form auto-navigates, 3s for a draft and 1.5s otherwise
    // (OpportunityForm.tsx). Sleeping 5s here landed after it had gone. Assert on
    // it instead of sleeping past it.
    await expect(page.getByText(/created successfully|created as DRAFT/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Return to Dashboard/i })).toBeVisible();
    // Let the form's own auto-navigation take us back rather than racing its
    // timer to click the button. Anchor the match: the current URL
    // (/admin/opportunities/new) already contains "/admin".
    await page.waitForURL(/\/admin$/, { timeout: 15000 });
    await page.waitForTimeout(2000);

    // --- 3. Open Edit for our poll and publish ---
    await expect(page.getByText(UNIQUE_TITLE)).toBeVisible({ timeout: 10000 });
    // Open dropdown for the row containing our title (kebab ⋮)
    const row = page.locator('tr').filter({ has: page.getByText(UNIQUE_TITLE) });
    await row.locator('button[title="Actions"]').click();
    // Scope to the row's own dropdown and match exactly: getByRole name matching
    // is a case-insensitive substring by default, so a bare 'Edit' also matched
    // the "...new script editor" recent-study links and tripped strict mode.
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.waitForURL(/\/admin\/opportunities\/[^/]+\/edit/, { timeout: 8000 });

    const editUrl = page.url();
    const opportunityIdMatch = editUrl.match(/\/admin\/opportunities\/([^/]+)\/edit/);
    const opportunityId = opportunityIdMatch ? opportunityIdMatch[1] : null;
    expect(opportunityId).toBeTruthy();

    // Ensure we're on Basic Info tab and change status to published
    await page.waitForSelector('#status', { state: 'visible', timeout: 10000 });
    // Wait for the study's data, not just the controls. Reached via a
    // client-side route the form mounts EMPTY - #status is visible and enabled
    // while #title is still '' - and loadOpportunity() then replaces the whole
    // form state. A status selected in that window is silently reverted, the
    // PATCH sends 'draft', and the study never publishes. This was a ~50% flake.
    await expect(page.locator('#title')).toHaveValue(UNIQUE_TITLE, { timeout: 15000 });
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

    // Assert the save actually landed. Without this a failed publish is silent,
    // and the first symptom is the click-tracking POST 404ing 40 lines later
    // (the endpoint rejects anything not published) - which reads as a
    // click-tracking bug rather than a save that never happened.
    const updateResponsePromise = page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && /\/api\/opportunities\/[^/]+$/.test(res.url()),
      { timeout: 15000 }
    );
    await updateBtn.click();
    const updateResponse = await updateResponsePromise;
    expect(updateResponse.status()).toBe(200);
    expect((await updateResponse.json()).status).toBe('published');
    await page.waitForTimeout(3000);

    // --- 4. Open public opportunity detail and listen for click POST ---
    const clickRequestPromise = page.waitForRequest(isActionClick, { timeout: 15000 });

    const clickResponsePromise = page.waitForResponse(
      (res) => isActionClick(res.request()) && res.status() === 200,
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
    // The home page only lists studies to a signed-in user - anonymously it is a
    // marketing landing page with no study links at all, so this test skipped on
    // every run instead of testing anything. Sign in as a plain employee first.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/api/auth/demo-login', { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Fail loudly if the session was not established. Without this a failed
    // login looks exactly like an empty database - the home page falls back to
    // its signed-out marketing view, no study cards render, and the data guard
    // below skips the test with a reason that is not the real one. The auth
    // routes are rate limited (100 requests / 15 min from one IP in
    // development), so repeated local runs do hit this.
    const me = await page.request.get('/api/me');
    expect(me.status(), 'demo login did not establish a session').toBe(200);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const pollCard = page.locator('a[href*="/opportunities/"]').filter({ has: page.locator('text=Poll') });
    const surveyCard = page.locator('a[href*="/opportunities/"]').filter({ has: page.locator('text=Survey') });
    // .first() has to come AFTER .or(): a.first().or(b.first()) still matches both
    // of them, which is two elements and a strict-mode violation.
    const card = pollCard.or(surveyCard).first();
    // Genuinely-empty data is the only thing worth skipping for, and it says so
    // when it happens. Everything below is logic, so it asserts instead.
    const count = await card.count();
    test.skip(count === 0, 'no published poll or survey study on the home page');

    const href = await card.getAttribute('href');
    const idMatch = href?.match(/\/opportunities\/([^/?#]+)/);
    const opportunityId = idMatch?.[1];
    expect(opportunityId, `could not parse an opportunity id from href ${href}`).toBeTruthy();

    const clickResponsePromise = page.waitForResponse((res) => isActionClick(res.request()), { timeout: 20000 });

    await card.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    const openButton = page.getByRole('button', { name: /Open Poll|Open Survey/i });
    await expect(openButton).toBeVisible({ timeout: 8000 });
    await openButton.click();

    const response = await clickResponsePromise;
    expect(response.status()).toBe(200);
    const body = await response.json().catch(() => ({}));
    expect(body.ok).toBe(true);
  });
});
