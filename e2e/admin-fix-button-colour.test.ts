import { test, expect, type Page } from '@playwright/test';

/**
 * The Fix action's amber treatment (cto/AdaptaLabs#163): the Research
 * Studies table's own Fix link and the study overview page's Fix link share
 * one class, `.admin-action-primary--fix`, and one pair of rules in
 * `_themes.css` - `.btn.btn-outline-secondary.admin-action-primary--fix`,
 * specific enough to out-rank `.admin-dashboard table .btn-outline-
 * secondary` for the TABLE's own Fix button, which would otherwise read as
 * the same grey as every other row action in dark mode. This reads the
 * COMPUTED colour in a real browser on both surfaces, in both themes - the
 * one thing neither the CSS source pin (`admin-pill-primitive.test.ts`,
 * styles/__tests__) nor jsdom can see, a cascade outcome.
 *
 * Every route is mocked - no backend, no database - so this runs in the
 * `test-a11y` CI job like the rest of `playwright.accessibility.config.ts`'s
 * `testMatch` list.
 */

type Fixture = Record<string, unknown>;

const ME = {
  id: 'admin-1',
  name: 'Admin User',
  email: 'admin@example.com',
  role: 'researcher_admin',
  business_unit: 'Research',
  role_title: 'Admin',
};

const BROKEN_STUDY: Fixture = {
  id: 'opp-fix-broken',
  type: 'test',
  title: 'Broken study for the Fix colour check',
  purpose_one_liner: 'Fixture for cto/AdaptaLabs#163',
  status: 'published',
  default_duration_minutes: 30,
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
  owner_user_id: ME.id,
  owner_name: ME.name,
  owner_email: ME.email,
  meeting_location_optional: 'Room 4',
  sessions: [],
};

// A second, unbroken study - plain Edit primary action - is the table's own
// negative control: another `.btn-outline-secondary` link on the exact same
// page, sharing every rule except `.admin-action-primary--fix`.
const DRAFT_STUDY: Fixture = {
  ...BROKEN_STUDY,
  id: 'opp-fix-control',
  title: 'Draft study, the negative control',
  status: 'draft',
};

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const mockCommon = async (page: Page): Promise<void> => {
  await page.route((url) => url.pathname.startsWith('/api/'), (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"unmocked in e2e"}' })
  );
  await page.route('**/api/me', (route) => route.fulfill(json(ME)));
  await page.route('**/api/bookings/pending-approvals**', (route) => route.fulfill(json([])));
  await page.route('**/api/feedback**', (route) => route.fulfill(json({ data: [], has_more: false })));
  await page.route('**/api/admin/dashboard**', (route) =>
    route.fulfill(
      json({
        total_opportunities: 2,
        published_opportunities: 1,
        draft_opportunities: 1,
        closed_opportunities: 0,
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
      })
    )
  );
};

/** `{color, borderColor}` at rest - no hover, no focus. */
const restingColours = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, borderColor: cs.borderColor };
  });

const THEMES = ['light', 'dark'] as const;

test.describe('the Fix action reads the same amber on the table and the overview page', () => {
  for (const theme of THEMES) {
    test(`${theme} mode: both Fix buttons share a colour that differs from a plain outline button`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
      await mockCommon(page);

      // --- The table ---
      await page.route(
        (url) => url.pathname === '/api/opportunities',
        (route) => route.fulfill(json([BROKEN_STUDY, DRAFT_STUDY]))
      );
      await page.goto('/admin', { waitUntil: 'load' });
      await expect(page.locator('table.admin-data-table')).toBeVisible({ timeout: 10000 });
      await expect(page.locator(`body.theme-${theme}`)).toHaveCount(1);

      const tableFix = await restingColours(page.locator('a.admin-action-primary--fix'));
      // The negative control: DRAFT_STUDY's own primary action ("Edit"),
      // the same `.admin-action-primary` link minus the Fix modifier class.
      const tableControl = await restingColours(
        page.locator('a.admin-action-primary:not(.admin-action-primary--fix)')
      );
      expect(tableFix, `table Fix vs plain control in ${theme} mode`).not.toEqual(tableControl);

      // --- The overview page ---
      await page.route(`**/api/opportunities/${BROKEN_STUDY.id}`, (route) => route.fulfill(json(BROKEN_STUDY)));
      await page.route(`**/api/bookings/opportunities/${BROKEN_STUDY.id}/bookings`, (route) => route.fulfill(json([])));
      await page.goto(`/admin/opportunities/${BROKEN_STUDY.id}`, { waitUntil: 'load' });
      await expect(page.getByRole('heading', { level: 2, name: 'Setup status' })).toBeVisible({ timeout: 10000 });

      const overviewFix = await restingColours(page.locator('a.admin-action-primary--fix'));
      // The negative control: the header's own "Preview as participant"
      // link, the same `.btn.btn-outline-secondary` base with no Fix class.
      const overviewControl = await restingColours(page.getByRole('link', { name: 'Preview as participant' }));
      expect(overviewFix, `overview Fix vs plain control in ${theme} mode`).not.toEqual(overviewControl);

      // The two surfaces read the SAME amber, not two different one-off
      // colours that both merely happen to differ from grey.
      expect(overviewFix, `table Fix vs overview Fix in ${theme} mode`).toEqual(tableFix);
    });
  }
});
