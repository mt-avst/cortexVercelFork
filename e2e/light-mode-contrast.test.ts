import { test, expect } from '@playwright/test';

/**
 * Light-mode form contrast (WCAG AA) on Create New Opportunity page.
 * Verifies that entered text and select values use dark color on white background.
 */

/**
 * Paths are relative so `use.baseURL` from the running config decides the
 * target. A module-level BASE_URL here would silently win over the config -
 * that is how `test:a11y:prod` ended up grading a different application.
 */

// Dark text we expect in light mode: #374151 = rgb(55, 65, 81), #334155 = rgb(51, 65, 85)
const EXPECTED_DARK_RGB = [
  'rgb(55, 65, 81)',   // #374151
  'rgb(51, 65, 85)',   // #334155
  'rgb(26, 26, 26)',   // #1A1A1A
];

function parseRgb(rgb: string): { r: number; g: number; b: number } | null {
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return null;
  return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
}

function isDarkEnoughForContrast(rgb: string): boolean {
  const c = parseRgb(rgb);
  if (!c) return false;
  // Luminance (relative): (0.299*R + 0.587*G + 0.114*B) / 255. For 4.5:1 on white, need luminance < ~0.4
  const luminance = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  return luminance < 0.5; // dark text
}

test.describe('Light-mode form contrast (Create New Opportunity)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Mock admin user so we can open /admin/opportunities/new
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'admin-1',
          name: 'Admin User',
          email: 'admin@example.com',
          role: 'researcher_admin',
        }),
      });
    });
    // AuthContext only calls /api/me when sessionStorage has loginRedirect (return from login).
    // Set it so the app will fetch user and our mock will return researcher_admin.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
  });

  test('Create New Opportunity form: input text color is dark in light mode', async ({ page }) => {
    await page.goto('/admin/opportunities/new', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // Ensure light theme (toggle if body has theme-dark)
    const body = page.locator('body');
    const themeClass = await body.getAttribute('class');
    if (themeClass?.includes('theme-dark')) {
      const themeToggle = page.locator('button[aria-label="Switch to light mode"]');
      await themeToggle.click();
      await page.waitForTimeout(500);
    }
    await expect(body).toHaveClass(/theme-light/);

    // Find Title input and type
    const titleInput = page.locator('input#title').first();
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Test contrast');
    await page.waitForTimeout(300);

    // Get computed color of the input (the typed value)
    const inputColor = await titleInput.evaluate((el: HTMLInputElement) => {
      const style = window.getComputedStyle(el);
      return style.color;
    });

    expect(isDarkEnoughForContrast(inputColor), `Title input color should be dark (WCAG AA). Got: ${inputColor}`).toBe(true);
  });

  test('Create New Opportunity form: select displayed value color is dark in light mode', async ({ page }) => {
    await page.goto('/admin/opportunities/new', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const body = page.locator('body');
    const themeClass = await body.getAttribute('class');
    if (themeClass?.includes('theme-dark')) {
      await page.locator('button[aria-label="Switch to light mode"]').click();
      await page.waitForTimeout(500);
    }
    await expect(body).toHaveClass(/theme-light/);

    // First form-select (Research Study Type)
    const firstSelect = page.locator('.opportunity-form select.form-select').first();
    await expect(firstSelect).toBeVisible({ timeout: 5000 });
    const selectColor = await firstSelect.evaluate((el: HTMLSelectElement) => window.getComputedStyle(el).color);
    expect(isDarkEnoughForContrast(selectColor), `Select color should be dark. Got: ${selectColor}`).toBe(true);
  });

  test('Create New Opportunity form: placeholder color is readable in light mode', async ({ page }) => {
    await page.goto('/admin/opportunities/new', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const body = page.locator('body');
    const themeClass = await body.getAttribute('class');
    if (themeClass?.includes('theme-dark')) {
      await page.locator('button[aria-label="Switch to light mode"]').click();
      await page.waitForTimeout(500);
    }
    await expect(body).toHaveClass(/theme-light/);

    const titleInput = page.locator('input#title').first();
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    // Placeholder pseudo-element: get color via JS (getComputedStyle on input gives placeholder when empty)
    const placeholderColor = await titleInput.evaluate((el: HTMLInputElement) => {
      const style = window.getComputedStyle(el, '::placeholder');
      return style?.color || window.getComputedStyle(el).color;
    });
    expect(isDarkEnoughForContrast(placeholderColor), `Placeholder should be readable (dark enough). Got: ${placeholderColor}`).toBe(true);
  });
});
