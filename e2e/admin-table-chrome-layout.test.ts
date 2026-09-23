import { test, expect } from '@playwright/test';
import { SEEDED_STUDY_COUNT, openAdminDashboard, resizeTo } from './helpers/admin-dashboard';

/**
 * Row 16 (second-pass fix-first register): the Research Studies table is
 * `table-layout: fixed`, so at its narrowest widths every column compresses.
 * A `.admin-study-status` pill's own box then renders narrower than its label
 * (`.admin-dashboard table.table-hover tbody td > *` caps a cell's direct
 * children at `max-width: 100%` of that squeezed cell), so the pill's colour
 * background clips its own text instead of framing it.
 *
 * Admin table Step 1 (2026-09-23) moved the bands: the table now renders from
 * 1024px up (Created hidden at 1024-1279), cards below 1024. The narrowest
 * table is 1024 and the widest card is 1023, so both sides of that edge are
 * measured here, plus the old 856 mid-card width and the 1219 that sat just
 * under the retired 1220 breakpoint. The type lozenge moved out of its own
 * column into the Study cell's meta line, so it is measured there.
 *
 * Runs against the real seeded dev database. The login helper pins the
 * dashboard to BASE_URL: `/auth/admin-login` redirects to the backend's own
 * FRONTEND_URL, so the previous `goto('/auth/admin-login')` measured
 * localhost:3000 whatever BASE_URL said.
 */

const SCROLL_WIDTHS = [390, 768, 856, 1023, 1024, 1219, 1440];
const PILL_WIDTHS = [856, 1023, 1024, 1100, 1219, 1279, 1280, 1440];

test.describe('Admin Research Studies table - chrome layout across the card and narrow-table bands', () => {
  for (const width of SCROLL_WIDTHS) {
    test(`no page-level horizontal scroll at ${width}px`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width });
      await resizeTo(page, width);
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
  }

  for (const width of PILL_WIDTHS) {
    test(`every status pill contains its own label at ${width}px`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width });
      await resizeTo(page, width);
      // Positive control: an absence check on a selector that stopped
      // matching anything would pass just as well as a real fix.
      const pillCount = await page.locator('.admin-study-status').count();
      expect(pillCount).toBe(SEEDED_STUDY_COUNT);

      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('.admin-study-status')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => ({ text: el.textContent, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      );
      expect(clipped).toEqual([]);
    });

    // Lane E (icon system, row 24) added a lucide glyph plus a gap to the
    // type `.lozenge`, widening it in the same fixed-layout table the status
    // pill test above exists for. Step 1 moved it into the Study cell, so the
    // cell it must stay inside is the Study cell (located by header text).
    test(`every type lozenge in the Study cell contains its own label and glyph at ${width}px`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width });
      await resizeTo(page, width);

      const measured = await page.evaluate(() => {
        const p = window.__adminProbe;
        const lozenges = p
          .rows()
          .map((r) => p.cell(r, 'Study')?.querySelector('.lozenge'))
          .filter((el): el is Element => Boolean(el));
        const offenders = lozenges
          .filter((el) => {
            const cell = el.closest('td')!;
            const clipped = el.scrollWidth > el.clientWidth + 1;
            const c = cell.getBoundingClientRect();
            const b = el.getBoundingClientRect();
            const overflowsCell = b.right > c.right + 1 || b.left < c.left - 1;
            const glyph = el.querySelector('svg');
            const glyphGone = !glyph || glyph.getBoundingClientRect().width < 10;
            return clipped || overflowsCell || glyphGone;
          })
          .map((el) => ({ text: el.textContent, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
        return { count: lozenges.length, offenders };
      });
      // One per study, and all of them in the Study cell.
      expect(measured.count, 'type lozenges found in the Study cell').toBe(SEEDED_STUDY_COUNT);
      expect(measured.offenders).toEqual([]);
    });
  }
});
