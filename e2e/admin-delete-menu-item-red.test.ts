import { test, expect } from '@playwright/test';

/**
 * Row 15 "Then" (second-pass fix-first register): in light mode, the
 * Research Studies row menu's "Delete" item rendered the same grey as
 * View/Edit/Copy/Analytics instead of red.
 *
 * Root cause: `.admin-action-dropdown button { color: #E0E0E0 !important; }`
 * (an unscoped "ALWAYS apply" base rule) and its `body.theme-light
 * .admin-action-dropdown button { color: #374151 !important; }` sibling both
 * live in the THEMES cascade layer (`@import './_themes.css' layer(themes)`
 * is the last layer declared in main.css, so a themes-layer rule always
 * outranks a rule in any other layer, regardless of selector specificity -
 * layer order is resolved before specificity in the cascade). Neither had a
 * `.text-danger` exception, so with both excluded from matching Delete, the
 * cascade falls through past the components-layer "Danger item styling
 * (Light Mode)" rule (`color: #DC2626`, no `!important`, so it never had a
 * chance against the themes-layer `!important` rules regardless of its own
 * specificity) to the next-highest layer that still targets `.text-danger`:
 * the generic `.text-danger { color: var(--status-danger-text) }` utility,
 * which resolves to a legible brick red (`--fs-danger`, #A63D40) in light
 * mode. Dark mode never showed this: its own `.text-danger` override in the
 * SAME themes layer IS `!important`, with higher selector specificity than
 * the theme-dark button rule, so it wins there directly.
 *
 * Paths are relative so `use.baseURL` from the running config decides the
 * target, per the convention in the other e2e specs here.
 */

test.describe('Admin row menu - Delete reads as a destructive action in light mode', () => {
  test('Delete is red while its siblings stay neutral', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/auth/admin-login', { waitUntil: 'load', timeout: 15000 });
    await expect(page).toHaveURL(/\/admin/, { timeout: 8000 });

    // Force light mode through the app's own toggle (a direct classList
    // edit races the React theme provider, which re-asserts its own class
    // on the next render). The defect is light-mode only. The demo login's
    // starting theme is not pinned, so check before toggling.
    const isDark = await page.locator('body').evaluate((el) => el.classList.contains('theme-dark'));
    if (isDark) {
      await page.getByRole('button', { name: /Switch to light mode/i }).click();
    }
    await expect(page.locator('body')).toHaveClass(/theme-light/, { timeout: 5000 });

    const row = page.locator('tr.admin-row-clickable').first();
    await row.locator('.col-actions .dropdown-toggle').click();

    const deleteItem = page.getByRole('menuitem', { name: /^Delete$/ });
    const editItem = page.getByRole('menuitem', { name: /^Edit$|^View$/ }).first();
    await expect(deleteItem).toBeVisible();

    const [deleteColor, editColor] = await Promise.all([
      deleteItem.evaluate((el) => getComputedStyle(el).color),
      editItem.evaluate((el) => getComputedStyle(el).color),
    ]);

    expect(deleteColor, 'Delete must not render the same colour as a non-destructive item').not.toBe(editColor);

    const [r, g, b] = deleteColor.match(/\d+/g)!.map(Number);
    expect(r, `Delete's colour ${deleteColor} must read as red (R clearly dominant), not neutral grey`).toBeGreaterThan(g + 30);
    expect(r).toBeGreaterThan(b + 30);
  });
});
