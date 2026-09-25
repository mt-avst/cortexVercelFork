import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The study overview page (cto/AdaptaLabs#163), `/admin/opportunities/:id`:
 * an axe pass in both themes, no sideways scroll at 390px, and the Research
 * Studies table's own row click landing here for a manager.
 *
 * Every route is mocked - no backend, no database - which is what lets
 * `playwright.accessibility.config.ts` run this (and so the `test-a11y` CI
 * job, `vite preview` with no backend on localhost:3100). Follows the
 * convention `admin-pill-primitive.test.ts` set: this spec's own file, named
 * in that config's `testMatch` allow-list, rather than folded into
 * `accessibility.test.ts` - a spec not named there runs in no pipeline at
 * all.
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

const OTHER_OWNER = { id: 'other-1', name: 'Dana Owner', email: 'dana@example.com' };

const sessionFixture = (id: string, startIso: string, endIso: string, capacity: number, booked: number): Fixture => ({
  id,
  opportunity_id: 'opp-sessions',
  start_time: startIso,
  end_time: endIso,
  capacity,
  booked_count: booked,
  remaining: capacity - booked,
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
});

const opportunity = (over: Fixture): Fixture => ({
  id: 'opp-1',
  purpose_one_liner: 'See where participants stumble',
  default_duration_minutes: 30,
  status: 'published',
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
  owner_user_id: ME.id,
  owner_name: ME.name,
  owner_email: ME.email,
  sessions: [],
  ...over,
});

// Each fixture carries its OWN id, deliberately distinct - a shared id across
// independent fixtures is one accidental route-glob collision away from one
// test's mock answering another's request.
const READY = opportunity({
  id: 'opp-ready',
  title: 'Ready study',
  type: 'unmoderated',
  firsthand_study_id: 'fh-1',
});

const BROKEN = opportunity({
  id: 'opp-broken',
  title: 'Broken study, no bookable slot',
  type: 'test',
  meeting_location_optional: 'Room 4',
  sessions: [],
});

const WITH_SESSIONS = opportunity({
  id: 'opp-sessions',
  title: 'Study with sessions and bookings',
  type: 'test',
  meeting_location_optional: 'Room 4',
  sessions: [
    sessionFixture('s-upcoming', '2026-12-01T10:00:00.000Z', '2026-12-01T11:00:00.000Z', 4, 1),
    sessionFixture('s-past', '2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z', 2, 2),
  ],
});

const BOOKINGS: Fixture[] = [
  {
    id: 'booking-1',
    user_id: 'user-1',
    session_id: 's-upcoming',
    status: 'confirmed',
    completion_status: null,
    session_start_time: '2026-12-01T10:00:00.000Z',
    session_end_time: '2026-12-01T11:00:00.000Z',
    participant_name: 'Participant One',
    participant_email: 'p1@example.com',
    business_unit: null,
    role_title: null,
    researcher_notes: null,
    researcher_notes_updated_at: null,
    consent_accepted_at: null,
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-07-01T10:00:00.000Z',
  },
];

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Mocks every route the overview page itself calls, plus a catch-all 500 for
 * anything else - the same defence `accessibility.test.ts` uses: without it a
 * local run with a real backend on :3001 answers an unmocked call for real,
 * with no session, and the app's own sign-in redirect takes the page
 * somewhere this spec never sent it.
 */
const mockOverviewApi = async (
  page: Page,
  opts: { me?: Fixture; study: Fixture; bookings?: Fixture[] | 'error' | 'forbidden'; meDelayMs?: number }
): Promise<void> => {
  await page.route((url) => url.pathname.startsWith('/api/'), (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"unmocked in e2e"}' })
  );
  await page.route('**/api/me', async (route) => {
    // `meDelayMs` makes `/api/me` answer well after `/api/opportunities/:id`
    // does, so a caller can drive the cold-load auth race deliberately: the
    // study loading while the signed-in user is still unknown.
    if (opts.meDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.meDelayMs));
    await route.fulfill(json(opts.me ?? ME));
  });
  await page.route(`**/api/opportunities/${opts.study.id}`, (route) => route.fulfill(json(opts.study)));
  await page.route(`**/api/bookings/opportunities/${opts.study.id}/bookings`, (route) => {
    if (opts.bookings === 'error') {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"e2e: bookings failed"}' });
    }
    if (opts.bookings === 'forbidden') {
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"owner only"}' });
    }
    return route.fulfill(json(opts.bookings ?? []));
  });
};

const openOverview = async (page: Page, id: string): Promise<void> => {
  await page.goto(`/admin/opportunities/${id}`, { waitUntil: 'load' });
  await expect(page.getByRole('heading', { level: 2, name: 'Setup status' })).toBeVisible({ timeout: 15000 });
};

const THEMES = ['light', 'dark'] as const;

test.describe('Study overview page - accessibility', () => {
  for (const theme of THEMES) {
    test(`Ready state is axe-clean in ${theme} mode`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
      await mockOverviewApi(page, { study: READY });
      await openOverview(page, READY.id as string);
      await expect(page.locator(`body.theme-${theme}`)).toHaveCount(1);

      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });

    test(`Broken state (Setup status reasons) is axe-clean in ${theme} mode`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
      await mockOverviewApi(page, { study: BROKEN });
      await openOverview(page, BROKEN.id as string);
      await expect(page.getByText('Broken', { exact: true })).toBeVisible();

      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });

    test(`Sessions and bookings content is axe-clean in ${theme} mode`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
      await mockOverviewApi(page, { study: WITH_SESSIONS, bookings: BOOKINGS });
      await openOverview(page, WITH_SESSIONS.id as string);
      await expect(page.getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
      await expect(page.getByText('Participant One')).toBeVisible();

      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('the owner-only state is axe-clean', async ({ page }) => {
    const danasStudy = opportunity({
      id: 'opp-dana',
      title: "Dana's poll",
      type: 'poll',
      delivery_mode: 'external',
      external_link_optional: 'https://example.com',
      owner_user_id: OTHER_OWNER.id,
      owner_name: OTHER_OWNER.name,
      owner_email: OTHER_OWNER.email,
    });
    await mockOverviewApi(page, { me: { ...ME }, study: danasStudy });
    await page.goto(`/admin/opportunities/${danasStudy.id}`, { waitUntil: 'load' });
    await expect(page.getByText('Study overview is owner-only')).toBeVisible({ timeout: 15000 });

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('no page-level horizontal scroll at 390px, with the richest content (sessions + bookings)', async ({ page }) => {
    await mockOverviewApi(page, { study: WITH_SESSIONS, bookings: BOOKINGS });
    await page.setViewportSize({ width: 390, height: 900 });
    await openOverview(page, WITH_SESSIONS.id as string);
    await expect(page.getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});

test.describe('Study overview page - reached from the table', () => {
  test('a manager\'s row click on the Research Studies table lands on the study overview', async ({ page }) => {
    await page.route((url) => url.pathname.startsWith('/api/'), (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"unmocked in e2e"}' })
    );
    await page.route('**/api/me', (route) => route.fulfill(json(ME)));
    await page.route(
      (url) => url.pathname === '/api/opportunities',
      (route) => route.fulfill(json([READY]))
    );
    await page.route(`**/api/opportunities/${READY.id}`, (route) => route.fulfill(json(READY)));
    await page.route('**/api/admin/dashboard**', (route) =>
      route.fulfill(
        json({
          total_opportunities: 1,
          published_opportunities: 1,
          draft_opportunities: 0,
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
    await page.route('**/api/bookings/pending-approvals**', (route) => route.fulfill(json([])));
    await page.route('**/api/feedback**', (route) => route.fulfill(json({ data: [], has_more: false })));

    await page.goto('/admin', { waitUntil: 'load' });
    await expect(page.locator('table.admin-data-table')).toBeVisible({ timeout: 15000 });

    const titleLink = page.locator('a.row-title', { hasText: 'Ready study' });
    await titleLink.click();

    await expect(page).toHaveURL(new RegExp(`/admin/opportunities/${READY.id}$`), { timeout: 5000 });
    await expect(page.getByRole('heading', { level: 2, name: 'Setup status' })).toBeVisible();
  });
});

test.describe('Study overview page - the cold-load auth race (cto/AdaptaLabs#163)', () => {
  test('an owner opening the overview before auth settles still gets the full page, never a stuck owner-only state', async ({
    page,
  }) => {
    // `/api/me` answers well after `/api/opportunities/:id` does, so the
    // study is already loaded while the real signed-in user is still
    // unknown - the fetch effect waits for both to be settled before
    // deciding whether this visitor can manage the study, so nothing here
    // renders off a `null` user.
    await mockOverviewApi(page, { study: BROKEN, meDelayMs: 400 });
    await page.goto(`/admin/opportunities/${BROKEN.id}`, { waitUntil: 'load' });

    await expect(page.getByRole('heading', { level: 2, name: 'Setup status' })).toBeVisible({ timeout: 10000 });
    expect(await page.getByText('Study overview is owner-only').count()).toBe(0);
  });
});
