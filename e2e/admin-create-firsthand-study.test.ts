import { test, expect } from '@playwright/test';

/**
 * Authoring E2E for the ported task list editor (B5).
 * Flow: login as admin -> /admin/studies -> New Task List -> fill three steps
 * -> Create -> land on the task lists index -> reload and confirm it persisted.
 *
 * Uses the seeded admin-login (researcher_admin), same harness as
 * superadmin-create-study.test.ts. Assumes dev servers are already running
 * (npm run dev:all) with a Postgres DB configured for FirstHand studies.
 */
/**
 * Paths are relative so `use.baseURL` from the running config decides the
 * target. A module-level BASE_URL here would silently win over the config -
 * that is how `test:a11y:prod` ended up grading a different application.
 */
const UNIQUE_TITLE = `E2E Task List ${Date.now()}`;

test.describe('Admin authoring - create task list', () => {
  test('admin can create a task list with three steps, save, and see it after reload', async ({
    page,
  }) => {
    test.setTimeout(90000);

    // Load app first so AuthContext exists, then log in as admin.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/api/auth/admin-login', {
      waitUntil: 'load',
      timeout: 15000,
    });
    await page.waitForTimeout(4000);
    await expect(page).toHaveURL(/\/admin/, { timeout: 6000 });

    // Open the authoring form.
    await page.goto('/admin/studies/new', { waitUntil: 'load' });
    await page.waitForSelector('#study-title', {
      state: 'visible',
      timeout: 10000,
    });

    // Study metadata.
    await page.fill('#study-title', UNIQUE_TITLE);
    await page.fill('#study-intro', 'Automated authoring E2E intro copy');
    await page.fill('#study-consent', 'Automated authoring E2E consent copy');

    // Step 1 (task step with a target URL, so the no-task-page gate stays clear).
    await page.fill('#step-prompt-0', 'Open the product and complete checkout');
    await page.fill('#step-target-0', 'https://example.com/checkout');

    // Step 2.
    await page.getByRole('button', { name: /Add step/i }).click();
    await page.waitForSelector('#step-prompt-1', { state: 'visible' });
    await page.fill('#step-prompt-1', 'Describe what you found confusing');

    // Step 3.
    await page.getByRole('button', { name: /Add step/i }).click();
    await page.waitForSelector('#step-prompt-2', { state: 'visible' });
    await page.fill('#step-prompt-2', 'Rate the overall experience');

    // Save.
    await page.getByRole('button', { name: /Create task list/i }).click();

    // Lands on the task lists index with the new task list visible.
    await page.waitForURL(/\/admin\/studies$/, { timeout: 10000 });
    await expect(page.getByText(UNIQUE_TITLE)).toBeVisible({ timeout: 10000 });

    // Reload and confirm it persisted (came back from the API, not just state).
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByText(UNIQUE_TITLE)).toBeVisible({ timeout: 10000 });
  });
});
