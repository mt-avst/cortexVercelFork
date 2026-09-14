import { test, expect } from '@playwright/test';

/**
 * Row 16 (second-pass fix-first register): the Research Studies table is
 * `table-layout: fixed` with percentage column widths and no table-level
 * min-width, so between the phone card breakpoint (767.98px) and the point
 * where the admin content column hits its own max-width, every column
 * compresses below the pixel budget its `.col-*` comment documents. A
 * `.admin-study-status` pill's own box then renders narrower than its label
 * (`.admin-dashboard table.table-hover tbody td > *` caps a cell's direct
 * children at `max-width: 100%` of that squeezed cell), so the pill's colour
 * background clips its own text instead of framing it.
 *
 * Paths are relative so `use.baseURL` from the running config decides the
 * target, per the convention in the other e2e specs here.
 */

const WIDTHS = [1218, 1024, 856];

test.describe('Admin Research Studies table - chrome layout at 768-1220', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/auth/admin-login', { waitUntil: 'load', timeout: 15000 });
    await expect(page).toHaveURL(/\/admin/, { timeout: 8000 });
    await expect(page.locator('table.admin-data-table, .admin-data-table')).toBeVisible({ timeout: 10000 });
  });

  for (const width of WIDTHS) {
    test(`no page-level horizontal scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      // scrollWidth <= clientWidth, not === innerWidth: innerWidth includes a
      // classic (non-overlay) scrollbar, documentElement.scrollWidth does
      // not, so a CI runner with a visible vertical scrollbar would fail
      // this by ~15px with no actual horizontal-scroll defect present.
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });

    test(`every status pill contains its own label at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      // Positive control: an absence check on a selector that stopped
      // matching anything would pass just as well as a real fix.
      const pillCount = await page.locator('.admin-study-status').count();
      expect(pillCount).toBeGreaterThan(0);

      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('.admin-study-status')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => ({ text: el.textContent, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      );
      expect(clipped).toEqual([]);
    });
  }
});
