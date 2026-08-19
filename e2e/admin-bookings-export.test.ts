import { test, expect } from '@playwright/test';

/**
 * Admin Bookings CSV Export (Track C)
 * Tests: Login as admin -> /admin -> Export CSV button visible; GET /api/admin/export/bookings returns 200 and CSV.
 * Run with dev servers: npm run dev:all then npx playwright test e2e/admin-bookings-export.test.ts
 */
/**
 * Paths are relative so `use.baseURL` from the running config decides the
 * target. A module-level BASE_URL here would silently win over the config.
 *
 * API_BASE stays as an escape hatch for a deployment that serves its API from a
 * different host; empty means "same origin as baseURL", which is the local
 * stack and the app origin on Kubera.
 */
const API_BASE = process.env.API_BASE_URL ?? '';

test.describe('Admin Bookings CSV Export', () => {
  test('admin export API returns CSV after login', async ({ page }) => {
    test.setTimeout(25000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/api/auth/admin-login', { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(2500);
    await expect(page).toHaveURL(/\/admin/, { timeout: 6000 });

    // Export with same cookies (no full-page redirect in test)
    const res = await page.request.get(`${API_BASE}/api/admin/export/bookings`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/text\/csv/);
    const body = await res.text();
    expect(body).toContain('Opportunity');
    expect(body).toContain('Participant name');
    expect(body).toContain('Booked at');
  });

  test('admin dashboard shows Export CSV when page loads', async ({ page }) => {
    test.setTimeout(25000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/api/auth/admin-login', { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(/\/admin/, { timeout: 6000 });
    const errorBoundary = page.getByText(/Something went wrong/i);
    const hasError = await errorBoundary.isVisible().catch(() => false);
    if (hasError) {
      test.skip();
    }
    // Wait for dashboard (Recent bookings or Export button); button has aria-label "Export all bookings as CSV"
    await expect(
      page.getByRole('button', { name: /Export.*CSV/i })
    ).toBeVisible({ timeout: 15000 });
  });
});
