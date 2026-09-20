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

    // Lane E (icon system, row 24) added a lucide glyph plus a gap to the
    // Type column's `.lozenge` badge, widening it in the same fixed-layout,
    // percentage-width table the status pill test above exists for. Not
    // caught by that test, which only ever looked at `.admin-study-status`.
    test(`every type lozenge contains its own label and glyph at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);

      const lozengeCount = await page.locator('td.col-type .lozenge').count();
      expect(lozengeCount).toBeGreaterThan(0);

      const offenders = await page.evaluate(() =>
        [...document.querySelectorAll('td.col-type .lozenge')]
          .filter((el) => {
            const cell = el.closest('td');
            const clipped = el.scrollWidth > el.clientWidth + 1;
            const overflowsCell =
              !!cell && el.getBoundingClientRect().right > cell.getBoundingClientRect().right + 1;
            return clipped || overflowsCell;
          })
          .map((el) => ({ text: el.textContent, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      );
      expect(offenders).toEqual([]);
    });
  }
});

/**
 * #142 code review MEDIUM 3: the source-pin guard test
 * (`frontend/src/styles/__tests__/admin-pill-primitive.test.ts`) reads CSS
 * and JSX as strings, so it cannot see the cascade outcome - a later,
 * higher-specificity rule appended anywhere in `_components.css` can restore
 * the exact three-way misalignment #142 was filed against while every
 * source pin stays green (measured: it does, 9 passed (9), on a build with
 * one such rule appended). This is the one test that measures what #142 is
 * actually about: the three pills' real computed box in a real browser.
 *
 * Routes are mocked rather than driven through `/auth/admin-login`, so this
 * runs against a served build with no backend or database - see the other
 * `test.describe` in this file for the real-login variant.
 */
test.describe('admin studies table pills share one box (#142)', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!baseURL?.includes('localhost'), 'route mocks below assume the local stack, not a deployment');

    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'admin-1',
          name: 'Admin User',
          email: 'admin@example.com',
          role: 'researcher_admin',
          business_unit: 'Research',
          role_title: 'Admin',
        }),
      });
    });

    await page.route('**/api/bookings/pending-approvals**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });

    await page.route('**/api/feedback**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], has_more: false }) });
    });

    await page.route('**/api/admin/dashboard**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            total_opportunities: 2,
            published_opportunities: 1,
            draft_opportunities: 0,
            closed_opportunities: 1,
            total_bookings: 0,
            upcoming_bookings: 0,
            past_bookings: 0,
            total_participants: 0,
            total_sessions: 0,
            sessions_completed: 0,
            total_slots: 0,
            booked_slots: 0,
            available_slots: 0,
            recent_bookings: [],
          },
        }),
      });
    });
  });

  test('type, status and auto-closed pills compute the same display/height/font-size/vertical-align', async ({ page }) => {
    await page.route('**/api/opportunities**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'opp-closed',
            type: 'test',
            title: 'Closed study',
            purpose_one_liner: 'Fixture for #142',
            status: 'closed',
            default_duration_minutes: 30,
            created_at: '2026-07-01T10:00:00.000Z',
            updated_at: '2026-07-01T10:00:00.000Z',
            sessions: [],
          },
        ]),
      });
    });

    await page.goto('/admin', { waitUntil: 'load' });
    await expect(page.locator('table.admin-data-table')).toBeVisible({ timeout: 10000 });

    // Positive control: fail here, not on a selector match count of zero
    // reading as "no misalignment found".
    const pillCount = await page.locator(
      'td.col-type .lozenge, td.col-status .admin-study-status, td.col-status .admin-pill--auto-closed'
    ).count();
    expect(pillCount).toBe(3);

    const metrics = await page.evaluate(() => {
      const read = (el: Element) => {
        const cs = getComputedStyle(el);
        return {
          display: cs.display,
          height: el.getBoundingClientRect().height,
          fontSize: cs.fontSize,
          verticalAlign: cs.verticalAlign,
        };
      };
      const type = document.querySelector('td.col-type .lozenge');
      const status = document.querySelector('td.col-status .admin-study-status');
      const autoClosed = document.querySelector('td.col-status .admin-pill--auto-closed');
      return {
        type: type && read(type),
        status: status && read(status),
        autoClosed: autoClosed && read(autoClosed),
      };
    });

    expect(metrics.type).not.toBeNull();
    expect(metrics.status).not.toBeNull();
    expect(metrics.autoClosed).not.toBeNull();

    for (const pill of [metrics.type, metrics.status, metrics.autoClosed] as const) {
      expect(pill!.display).toBe('inline-flex');
      expect(pill!.verticalAlign).toBe('middle');
      expect(pill!.height).toBeGreaterThan(23);
      expect(pill!.height).toBeLessThan(25);
    }
    expect(metrics.status!.fontSize).toBe(metrics.type!.fontSize);
    expect(metrics.autoClosed!.fontSize).toBe(metrics.type!.fontSize);
  });

  test('a long "Published, not working" status label truncates instead of overlapping the Type column', async ({ page }) => {
    await page.route('**/api/opportunities**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'opp-not-working',
            type: 'test',
            title: 'Question study',
            purpose_one_liner: 'Fixture for #142 HIGH 2',
            status: 'published',
            delivery_mode: 'external',
            external_link_optional: null,
            meeting_location_optional: null,
            default_duration_minutes: 30,
            created_at: '2026-07-01T10:00:00.000Z',
            updated_at: '2026-07-01T10:00:00.000Z',
            sessions: [],
          },
        ]),
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'load' });
    await expect(page.locator('table.admin-data-table')).toBeVisible({ timeout: 10000 });

    const statusPill = page.locator('td.col-status .admin-study-status').first();
    await expect(statusPill).toHaveText(/published, not working/i);

    const overlap = await page.evaluate(() => {
      const status = document.querySelector('td.col-status .admin-study-status');
      const typeLozenge = document.querySelector('td.col-type .lozenge');
      if (!status || !typeLozenge) return null;
      const s = status.getBoundingClientRect();
      const t = typeLozenge.getBoundingClientRect();
      // Positive overlap in the horizontal axis means the two boxes'
      // extents intersect - the #142 HIGH 2 defect. Bounding boxes, not the
      // exact glyph ink range the code review measured, but the box is the
      // actionable, stable signal for a regression guard.
      return Math.max(0, Math.min(s.right, t.right) - Math.max(s.left, t.left));
    });

    expect(overlap).toBe(0);
  });
});
