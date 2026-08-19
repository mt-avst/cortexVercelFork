import { test, expect } from '@playwright/test';

/**
 * Admin Create Study Flow Test
 * Tests: Login as admin -> Create new study (poll type) -> Submit -> Verify study appears in list
 * Uses admin-login (researcher_admin) - seeded in DB. For superadmin, run backend seed to add superadmin user.
 * Covers: study visibility after submit, refresh for admin, LEFT JOIN for owners not in users table
 */
const UNIQUE_TITLE = `E2E Test Study ${Date.now()}`;

test.describe('Superadmin Create Study Flow', () => {
  test('superadmin can create study and see it in research studies list', async ({ page }) => {
    test.setTimeout(90000);
    // Load app first to get AuthContext, set loginRedirect so AuthContext will fetch user on return
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    // 1. Login as admin (researcher_admin - seeded in DB; superadmin may not exist in local DB)
    await page.goto('/api/auth/admin-login', { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(4000); // Auth context fetch + redirect
    await expect(page).toHaveURL(/\/admin/, { timeout: 6000 });
    // Wait for admin UI and click Create Research Study
    await expect(page.getByText(/Research studies|Create|Opportunities/i).first()).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /Create.*Study/i }).click();
    await page.waitForURL(/\/admin\/opportunities\/new/, { timeout: 5000 });
    await page.waitForSelector('#type', { state: 'visible', timeout: 10000 });

    // 3. Fill Basic Info tab - use poll (no sessions, simpler)
    await page.selectOption('#type', 'poll');
    await page.waitForTimeout(300);
    await page.fill('#title', UNIQUE_TITLE);
    await page.fill('#purpose_one_liner', 'E2E test purpose for visibility check');

    // 4. Click Content & Details tab
    await page.locator('.nav-link').filter({ hasText: 'Content' }).click();
    await page.waitForTimeout(500);

    // 5. Click External Link tab (required for poll)
    await page.locator('.nav-link').filter({ hasText: 'External Link' }).click();
    await page.waitForTimeout(300);
    await page.fill('#external_link_optional', 'https://example.com/poll');

    // 6. Submit form - click Create Opportunity button (on External Link tab for poll)
    await page.getByRole('button', { name: /Create Opportunity/i }).click();

    // 7. After submit the success alert shows, then the form auto-navigates to
    // /admin on its own (3s for a draft, 1.5s otherwise - OpportunityForm.tsx).
    // This study is created without setting status, so it saves as a DRAFT and
    // the copy is the draft warning rather than "created successfully".
    await expect(page.getByText(/created successfully|created as DRAFT/i)).toBeVisible({ timeout: 10000 });
    // Anchor the match: the current URL (/admin/opportunities/new) already
    // contains "/admin", so an unanchored regex resolves instantly and waits
    // for nothing.
    await page.waitForURL(/\/admin$/, { timeout: 10000 });
    await page.waitForTimeout(1000); // Allow list to refresh

    // 8. Verify our study appears in the list
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.getByText(UNIQUE_TITLE)).toBeVisible({ timeout: 10000 });
  });
});
