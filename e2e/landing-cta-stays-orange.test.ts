import { test, expect } from '@playwright/test';

/**
 * Row 15 regression guard: `.btn-power` (the landing hero CTA and the
 * `DoorCard` CTA) moved from a literal `#C2410C` to `var(--brand-orange-700)`
 * in this lane. An earlier draft read `var(--cta-bg)` instead - visually
 * identical in dark mode (both resolve to an orange), but at the time
 * `--cta-bg` was rebound to `var(--fs-ink)` (navy) under `body.theme-light`,
 * which would have turned the primary landing CTA navy in light mode.
 * `--cta-bg` is orange in both themes too now (Decision 5, Lane H) - the two
 * tokens read the same colour family today - but `.btn-power` keeps its own
 * name for the independent AA-safe guarantee `--accent-fill-text-safe`
 * carries, not to dodge a navy fill that no longer exists. This still pins
 * the CTA as orange, measured, in both themes.
 *
 * Paths are relative so `use.baseURL` from the running config decides the
 * target, per the convention in the other e2e specs here.
 */

test.describe('Landing CTA stays orange in both themes', () => {
  test('the .btn-power background reads as orange, not navy, in light and dark', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const cta = page.locator('.btn-power').first();
    await expect(cta).toBeVisible();

    const isDark = await page.locator('body').evaluate((el) => el.classList.contains('theme-dark'));
    const colorFor = async () => cta.evaluate((el) => getComputedStyle(el).backgroundColor);

    const firstColor = await colorFor();
    assertOrange(firstColor, isDark ? 'dark' : 'light');

    const toggleLabel = isDark ? /Switch to light mode/i : /Switch to dark mode/i;
    await page.getByRole('button', { name: toggleLabel }).click();
    await expect(page.locator('body')).toHaveClass(isDark ? /theme-light/ : /theme-dark/, { timeout: 5000 });

    const secondColor = await colorFor();
    assertOrange(secondColor, isDark ? 'light' : 'dark');
  });
});

function assertOrange(rgbString: string, themeLabel: string) {
  const [r, g, b] = rgbString.match(/\d+/g)!.map(Number);
  expect(r, `${themeLabel} theme: ${rgbString} must be orange (R clearly dominant over B) - navy fails this`).toBeGreaterThan(b + 60);
  expect(r, `${themeLabel} theme: ${rgbString} must not be a neutral/grey/navy - R must lead G too`).toBeGreaterThan(g);
}
