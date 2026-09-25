import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Participate's "New since your last visit" badge (cto/AdaptaLabs#168),
 * against a real browser.
 *
 * `POST /api/participate/visit` returns `{ newOpportunityIds }`; Home
 * intersects those ids with what it actually rendered and the row only draws
 * the badge (see `OpportunityRow.test.tsx` and `Home.new-badge.test.tsx` for
 * the mocked-render unit coverage). This spec is the one place that proves a
 * REAL browser paints exactly those rows, with no other CSS regression riding
 * along, in both themes, and that the badge does not break a participant's
 * 390px kicker onto a third line.
 *
 * Route-mocked (no backend), same pattern as `accessibility.test.ts`'s
 * Home tests, which is what lets `playwright.accessibility.config.ts` - and
 * so the `test-a11y` CI job (`vite preview`, no backend) - run this.
 */

type Theme = 'dark' | 'light';
const THEMES: readonly Theme[] = ['dark', 'light'];

const STUDY = (over: Record<string, unknown>) => ({
  id: over.id,
  type: over.type ?? 'test',
  title: over.title,
  purpose_one_liner: 'Fixture study for the #168 badge e2e spec',
  status: 'published',
  default_duration_minutes: 30,
  participant_type_required: 'any',
  sessions: [],
  ...over,
});

/** Three published studies; the visit response marks the first two "new". */
const STUDIES = [
  STUDY({ id: 'opp-new-1', type: 'test', title: 'Newly published usability walkthrough' }),
  STUDY({ id: 'opp-new-2', type: 'unmoderated', title: 'Newly published recorded session' }),
  STUDY({ id: 'opp-old-1', type: 'survey', title: 'Already-seen survey' }),
];
const NEW_IDS = ['opp-new-1', 'opp-new-2'];

const mockParticipate = async (page: Page, theme: Theme): Promise<void> => {
  await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
  // Every unmocked API call fails the way the backend-less `test-a11y` preview
  // does, so a route this spec forgot to mock shows up as a page error rather
  // than silently falling through to a real server.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no backend in e2e"}' });
  });
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'user-1', name: 'Demo User', email: 'demo@example.com', role: 'employee' }),
    })
  );
  await page.route('**/api/opportunities**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUDIES) })
  );
  await page.route('**/api/participate/visit', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ newOpportunityIds: NEW_IDS }),
    })
  );
};

const rowFor = (page: Page, title: string) => page.locator('li.opportunity-row', { hasText: title });

for (const theme of THEMES) {
  test.describe(`Participate "New" badge (${theme})`, () => {
    test(`badges exactly the rows the visit endpoint names, axe clean (${theme})`, async ({ page }) => {
      await mockParticipate(page, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('/');
      await page.waitForLoadState('load');

      await expect(page.getByRole('heading', { level: 1, name: 'Participate' })).toBeVisible();
      await expect(rowFor(page, 'Already-seen survey')).toBeVisible();
      if (theme === 'dark') {
        await expect(page.locator('body.theme-dark')).toHaveCount(1);
      }

      // Exactly the two new-since-last-visit ids get a badge; the third never
      // does - the intersection is real, not "badge everything" or "badge
      // nothing".
      for (const title of ['Newly published usability walkthrough', 'Newly published recorded session']) {
        await expect(rowFor(page, title).locator('.opportunity-row__badge-new')).toHaveText('New');
      }
      await expect(rowFor(page, 'Already-seen survey').locator('.opportunity-row__badge-new')).toHaveCount(0);

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    });

    test(`at 390px a badged row's kicker stays one line for a participant (${theme})`, async ({ page }) => {
      await mockParticipate(page, theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      await page.waitForLoadState('load');
      await expect(page.getByRole('heading', { level: 1, name: 'Participate' })).toBeVisible();

      const kicker = rowFor(page, 'Newly published usability walkthrough').locator('.opportunity-row__kind');
      await expect(kicker.locator('.opportunity-row__badge-new')).toBeVisible();

      const box = await kicker.boundingBox();
      expect(box, 'the badged kicker must have a measurable box').not.toBeNull();
      // One line of this kicker's own text is well under 24px; two lines would
      // roughly double it. A participant never sees the admin " · status"
      // suffix (Participate only lists published studies), so this is the
      // whole of what could wrap here.
      expect((box as { height: number }).height).toBeLessThan(24);
    });
  });
}

/**
 * Every existing e2e spec that renders `/` and does NOT mock
 * `/api/participate/visit` (cto/AdaptaLabs#168) must still pass - the call
 * has to fail closed. This is the one spec that deliberately reproduces that
 * shape rather than relying on `accessibility.test.ts` continuing to pass as
 * indirect proof.
 */
test.describe('a page that never mocks /api/participate/visit', () => {
  test('still renders the list, with no badge and no error', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no backend in e2e"}' });
    });
    await page.route('**/api/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'user-1', name: 'Demo User', email: 'demo@example.com', role: 'employee' }),
      })
    );
    await page.route('**/api/opportunities**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUDIES) })
    );
    // No route for /api/participate/visit at all - it falls through to the
    // catch-all 500 above, the same shape a mock file that predates #168 has.

    await page.goto('/');
    await page.waitForLoadState('load');

    await expect(page.getByRole('heading', { level: 1, name: 'Participate' })).toBeVisible();
    await expect(rowFor(page, 'Already-seen survey')).toBeVisible();
    await expect(page.locator('.opportunity-row__badge-new')).toHaveCount(0);
    await expect(page.locator('main .alert-danger')).toHaveCount(0);
  });
});
