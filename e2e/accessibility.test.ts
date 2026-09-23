import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD, FEEDBACK, PENDING_APPROVALS } from './fixtures/admin-dashboard-seed';

/**
 * Automated Accessibility Testing Suite
 * 
 * Tests WCAG 2.2 AA compliance using axe-core
 * Runs on all major pages of the application
 */

/**
 * Paths below are relative, so `use.baseURL` from whichever config is running
 * decides the target.
 *
 * This file used to read its own module-level constant defaulting to
 * localhost:3000, which no config could override. `npm run test:a11y:prod` sets
 * PRODUCTION_URL and the prod config reads that into baseURL, but nothing here
 * ever looked at it - so the "production" accessibility run silently tested
 * localhost. On a machine with an unrelated app on port 3000 it reports
 * confident failures for somebody else's application.
 */

/**
 * Assert a clean scan, and say what failed in a form somebody can act on.
 *
 * `expect(violations).toEqual([])` on a failing scan prints the whole axe result
 * object - upwards of a thousand lines of nested JSON for a page with a handful
 * of contrast failures - and the CSS selector you actually need is buried in it.
 * This logs one line per node first: rule, impact, selector, and the measured
 * reason. The assertion underneath is unchanged, so the test still fails on
 * exactly what it failed on before.
 */
interface AxeNode {
  target: unknown[];
  failureSummary?: string;
}

interface AxeViolation {
  id: string;
  impact?: string | null;
  nodes: AxeNode[];
}

const expectNoViolations = (results: { violations: AxeViolation[] }, label: string): void => {
  if (results.violations.length > 0) {
    const lines = results.violations.flatMap((violation) =>
      violation.nodes.map((node) => {
        const target = node.target.map((part) => String(part)).join(' ');
        const reason = (node.failureSummary || '').replace(/\s+/g, ' ').trim();
        return `  [${violation.impact || 'unknown'}] ${violation.id} - ${target}\n      ${reason}`;
      })
    );
    console.log(
      `\n${label}: ${lines.length} axe node(s) across ${results.violations.length} rule(s)\n${lines.join('\n')}\n`
    );
  }
  expect(results.violations).toEqual([]);
};

/**
 * Refuse a green result that was green because axe declined to look.
 *
 * axe puts a node in `incomplete` - not `violations` - when it cannot work out
 * what is behind it, and nothing here has ever asserted on that bucket. In dark
 * mode that is not a rare edge case: the decorative neural canvas is a fixed,
 * full-viewport element, so axe called the entire upcoming card "overlapped by
 * another element" and reported ZERO violations for a page carrying a 3.87
 * contrast failure on its only primary button.
 *
 * A handful of `incomplete` entries are unavoidable and unrelated - the header's
 * gradient-filled nav buttons among them - so this does not demand an empty
 * bucket. It demands that nothing this page exists to render ended up in it.
 */
const expectBookingContrastActuallyMeasured = (
  results: { incomplete: AxeViolation[] },
  label: string
): void => {
  /* One element axe will not judge in either theme, and it is not a defect.
     It reports `.booking-reschedule-note` as "partially overlaps other
     elements", but the footer's boxes do not overlap - the actions row ends at
     698.3 and the note starts at 708.3 - so this is axe's heuristic, not a
     layout fault. Measured directly instead: #4b5563 on #f8fafc is 7.22 in
     light, #cbcbcb on #09090b is 12.2 in dark.

     Named individually rather than loosening the pattern, so that a new booking
     element sliding into the `incomplete` bucket still fails this. */
  const knownUnmeasurable = ['.booking-reschedule-note'];

  const deferred = results.incomplete
    .filter((rule) => rule.id === 'color-contrast')
    .flatMap((rule) => rule.nodes.map((node) => node.target.map(String).join(' ')))
    .filter((target) => /\.booking-|\.btn-booking-|\.my-bookings-/.test(target))
    .filter((target) => !knownUnmeasurable.includes(target));
  if (deferred.length > 0) {
    console.log(`\n${label}: axe declined to measure ${deferred.length} booking node(s)\n  ${deferred.join('\n  ')}\n`);
  }
  expect(deferred).toEqual([]);
};

/**
 * Wait for the page this test scans to have actually rendered, instead of a
 * fixed sleep. A `waitForTimeout(500)` here scanned whatever had painted by
 * then: under the CI config's parallel workers the SPA had often not mounted
 * its route yet, and axe reported `landmark-one-main` / `page-has-heading-one`
 * on a half-painted page (measured 16/20 and 17/20 failures at 5 workers on
 * main and the branch). On `/` it could also scan the signed-out landing that
 * shows before the mocked `/api/me` resolves, not the signed-in page mocked
 * for it. Each test now names its page's own heading plus one element the
 * mocked data renders, and a render problem fails here, by name, within 10s.
 */
/**
 * Admin's panels beyond the studies list (which the beforeEach mocks). Both
 * Admin scans used to mock `/api/dashboard`, a path the page no longer calls,
 * and nothing mocked pending approvals or feedback: under the catch-all 500
 * they scanned Admin with "Failed to load pending approvals" showing. The data
 * is the typed fixture the Admin table specs use.
 */
const mockAdminPanels = async (page: import('@playwright/test').Page): Promise<void> => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/admin/dashboard**', (route) => route.fulfill(json(DASHBOARD)));
  await page.route('**/api/bookings/pending-approvals**', (route) => route.fulfill(json(PENDING_APPROVALS)));
  await page.route('**/api/feedback**', (route) => route.fulfill(json(FEEDBACK)));
};

const expectRendered = async (
  page: import('@playwright/test').Page,
  heading: import('@playwright/test').Locator,
  content: import('@playwright/test').Locator
): Promise<void> => {
  await expect(heading, 'the page heading never rendered').toBeAttached({ timeout: 10000 });
  await expect(content, 'the page content never rendered').toBeVisible({ timeout: 10000 });
  await expect(page.locator('main .spinner-border'), 'the page is still loading').toHaveCount(0, { timeout: 10000 });
  // Every unmocked call gets a 500, so a page whose own mock stopped matching
  // renders its error state - and some error states still show the content
  // being waited for (My Bookings keeps its empty cards under the alert).
  await expect(page.locator('main .alert-danger'), 'the page rendered an error').toHaveCount(0);
};

test.describe('Accessibility Tests', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    // Set viewport size
    await page.setViewportSize({ width: 1280, height: 720 });
    
    // Mock API responses for consistency (only against a local stack - against
    // a deployment the real API is the thing under test).
    if (baseURL?.includes('localhost')) {
      // Every API call a test does not mock is answered here, the way the
      // test-a11y job answers it: that job serves `vite preview` with no
      // backend, so the preview's /api proxy fails every unmocked call with a
      // 500. Without this, a local run with a backend on :3001 sent those calls
      // to it with no session; the 401 tripped the app's sign-in redirect,
      // which the backend points at ITS frontend (:3000), so the page left the
      // server under test mid-test and axe scanned a blank document - measured
      // 16-17/20 `landmark-one-main` failures at 5 workers, on main and the
      // branch alike, and 0/990 against a backend-less preview. Registered
      // first so every mock below and in a test takes precedence (Playwright
      // tries routes in reverse registration order).
      // A pathname predicate, not the glob '**/api/**': under the Vite dev
      // server that glob also matches the app's own source modules
      // (/src/api/client.ts), so the app never booted in a local dev run.
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no backend in e2e"}' });
      });
      await page.route('**/api/me', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'user-1',
            name: 'Demo User',
            email: 'demo@example.com',
            role: 'employee',
            business_unit: 'Engineering',
            role_title: 'Developer'
          }),
        });
      });

      await page.route('**/api/opportunities**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'opp-1',
              type: 'test',
              title: 'Accessibility Test Opportunity',
              purpose_one_liner: 'Testing accessibility features',
              description_optional: 'This is a test opportunity for accessibility testing',
              status: 'published',
              default_duration_minutes: 30,
              sessions: [
                {
                  id: 'session-1',
                  opportunity_id: 'opp-1',
                  start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                  end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
                  capacity: 5,
                  booked_count: 0
                }
              ]
            }
          ]),
        });
      });
    }
  });

  test('Home page should be accessible', async ({ page }) => {
    await page.goto('/');
    
    // Wait for page to load (use 'load' not 'networkidle' - production often has ongoing requests)
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Browse studies' }), page.getByText('Accessibility Test Opportunity').first());
    
    // Run accessibility check
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Home page (logged in) should be accessible', async ({ page }) => {
    // Mock logged-in state
    await page.goto('/');
    
    // Set cookie to simulate logged-in user
    await page.context().addCookies([{
      name: 'session',
      value: 'mock-session-cookie',
      domain: 'localhost',
      path: '/',
    }]);
    
    await page.reload();
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Browse studies' }), page.getByText('Accessibility Test Opportunity').first());
    
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Opportunity Detail page should be accessible', async ({ page }) => {
    await page.route('**/api/opportunities/opp-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'opp-1',
          type: 'test',
          title: 'Accessibility Test Opportunity',
          purpose_one_liner: 'Testing accessibility features',
          description_optional: 'This is a test opportunity',
          status: 'published',
          default_duration_minutes: 30,
          sessions: [
            {
              id: 'session-1',
              opportunity_id: 'opp-1',
              start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
              capacity: 5,
              booked_count: 0
            }
          ]
        }),
      });
    });

    await page.goto('/opportunities/opp-1');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Accessibility Test Opportunity' }), page.getByRole('heading', { level: 2, name: 'Available Sessions' }));
    
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Admin Dashboard should be accessible', async ({ page }) => {
    // Mock admin user
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
          role_title: 'Researcher'
        }),
      });
    });

    await mockAdminPanels(page);

    await page.goto('/admin');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Admin' }), page.locator('.admin-data-table tbody tr').first());

    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });

  // Audit #121. The admin Research Studies table renders a type lozenge per
  // study type and a status pill per lifecycle status. Several failed WCAG AA
  // contrast, but the check above never caught it: the beforeEach study is type
  // `test` + status `published`, whose badges happen to pass. This renders EVERY
  // type and EVERY status so the color-contrast rule has teeth over the whole
  // badge set - a future palette change that dips any badge below 4.5:1 fails
  // here by name.
  test('Admin study type and status badges meet WCAG AA contrast', async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'admin-1', name: 'Admin User', email: 'admin@example.com', role: 'researcher_admin' }),
      });
    });
    await page.route('**/api/admin/dashboard**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }) });
    });

    // One study per type, statuses cycled so all three lifecycle pills render.
    const types = ['test', 'interview', 'poll', 'survey', 'question', 'unmoderated'];
    const statuses = ['draft', 'published', 'closed'];
    const studies = types.map((type, i) => ({
      id: `opp-${i}`,
      type,
      title: `${type} study`,
      purpose_one_liner: 'Badge contrast fixture',
      status: statuses[i % statuses.length],
      default_duration_minutes: 30,
      sessions: [],
    }));
    await page.route('**/api/opportunities**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(studies) });
    });

    await page.goto('/admin');
    await page.waitForLoadState('load');
    // Wait on the rendered badges, not the clock, so the scan cannot race an
    // empty table.
    await expect(page.locator('.admin-study-status').first()).toBeVisible();
    // Admin table Step 1 moved the type lozenge from its own column into the
    // Study cell's meta line (the first column).
    await expect(page.locator('td:first-child .lozenge')).toHaveCount(types.length);

    // Scope the scan to the studies table and assert specifically on contrast,
    // so an unrelated admin a11y issue elsewhere cannot mask or be blamed for a
    // badge regression.
    const scan = await new AxeBuilder({ page })
      .include('.admin-data-table')
      .withRules(['color-contrast'])
      .analyze();
    expect(scan.violations).toEqual([]);
  });

  // Audit row 14. At 390px the Research Studies table forced a ~530px document,
  // so the row-action kebab sat off the right edge, unreachable. The fix reflows
  // the table to cards below 768px. jsdom (the vitest suite) applies no CSS and
  // the scans above run at 1280px, so this is the ONLY place the phone reflow
  // can fail by name: it asserts the document does not scroll sideways and the
  // actions cell stays within the viewport. Kept a layout assertion rather than
  // only an axe pass because the regression is geometric, not an axe rule.
  test('Admin dashboard fits a 390px phone with the row actions reachable', async ({ page }) => {
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
    await mockAdminPanels(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Admin' }), page.locator('.admin-data-table td.col-actions').first());

    // The studies table must have reflowed to cards (a real table would carry
    // its intrinsic min-width and re-open the horizontal scroll).
    const actions = page.locator('.admin-data-table td.col-actions').first();
    await expect(actions).toBeVisible();

    const metrics = await page.evaluate(() => {
      const de = document.documentElement;
      const cell = document.querySelector('.admin-data-table td.col-actions');
      const rect = cell?.getBoundingClientRect();
      return {
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        actionsRight: rect ? rect.right : null,
      };
    });

    // No horizontal document overflow - the "530px document at 390px" symptom.
    expect(metrics.scrollW).toBeLessThanOrEqual(metrics.clientW + 1);
    // The row actions are within the viewport, not off the right edge.
    expect(metrics.actionsRight).not.toBeNull();
    expect(metrics.actionsRight as number).toBeLessThanOrEqual(metrics.clientW + 1);

    // The reflowed cards stay accessible at phone width.
    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations).toEqual([]);
  });

  // Audit #122. Tail of row 14. The Research Studies table moved to cards, but
  // the Recent bookings and Feedback tables kept the older phone treatment -
  // hide columns by :nth-child, then scroll sideways inside .table-responsive.
  // Recent bookings HID its Status column below 768px outright. Both now reflow
  // to cards like the studies table. jsdom (the vitest suite) applies no CSS
  // and the scans above run at 1280px, so this is the only place the reflow can
  // fail by name: it asserts the once-hidden Status cell is visible and within
  // the viewport, the Feedback cells render, and neither tab scrolls sideways.
  test('Recent bookings and Feedback tables reflow to cards on a 390px phone', async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'admin-1', name: 'Admin User', email: 'admin@example.com', role: 'researcher_admin' }),
      });
    });
    await page.route('**/api/admin/dashboard**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            total_bookings: 3,
            recent_bookings: [
              {
                id: 'bk-1',
                opportunity_id: 'opp-1',
                opportunity_title: 'Checkout usability test',
                session_start: new Date('2026-09-15T09:30:00Z').toISOString(),
                participant_name: 'Sam Participant',
                participant_email: 'sam@example.com',
                status: 'booked',
                booked_at: new Date('2026-09-14T09:30:00Z').toISOString(),
              },
            ],
          },
        }),
      });
    });
    await page.route('**/api/feedback', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'fb-1',
              user_id: 'u1',
              user_name: 'Sam Participant',
              user_email: 'sam@example.com',
              category: 'bug',
              feedback: 'The book button did not respond on my phone.',
              url: '/opportunities/opp-1',
              user_agent: 'test',
              created_at: new Date('2026-09-14T12:00:00Z').toISOString(),
            },
          ],
          has_more: false,
        }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin');
    await page.waitForLoadState('load');

    // Bookings tab: the Status column (nth-child(4)) was hidden below 768px by
    // the old rule. If the reflow regresses, the cell is display:none and this
    // toBeVisible fails by name.
    await page.getByRole('tab', { name: /Bookings/ }).click();
    const statusCell = page.locator('.admin-cards-phone td.col-recent-status').first();
    await expect(statusCell).toBeVisible();

    const bookingMetrics = await page.evaluate(() => {
      const de = document.documentElement;
      const status = document.querySelector('.admin-cards-phone td.col-recent-status');
      const session = document.querySelector('.admin-cards-phone td.col-recent-session');
      const statusRect = status?.getBoundingClientRect();
      return {
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        statusRight: statusRect ? statusRect.right : null,
        statusWidth: statusRect ? statusRect.width : null,
        sessionWidth: session ? session.getBoundingClientRect().width : null,
      };
    });
    expect(bookingMetrics.scrollW).toBeLessThanOrEqual(bookingMetrics.clientW + 1);
    expect(bookingMetrics.statusRight).not.toBeNull();
    expect(bookingMetrics.statusRight as number).toBeLessThanOrEqual(bookingMetrics.clientW + 1);
    // Every card cell spans the full card width. The first cell used to be
    // clamped to the old `table-hover tbody td:nth-child(1)` min-width:150px/
    // max-width:40% rule, which outranks the reflow unless the reflow's width
    // rules carry !important (as the studies table's do). If that !important is
    // dropped the first cell shrinks to 150px while the others stay full width,
    // so assert the first cell matches the last rather than a fixed pixel size.
    expect(bookingMetrics.sessionWidth).not.toBeNull();
    expect(bookingMetrics.statusWidth).not.toBeNull();
    expect(Math.abs((bookingMetrics.sessionWidth as number) - (bookingMetrics.statusWidth as number))).toBeLessThanOrEqual(1);

    // Feedback tab.
    await page.getByRole('tab', { name: /Feedback/ }).click();
    const feedbackCell = page.locator('.feedback-table td[data-label="Feedback"]').first();
    await expect(feedbackCell).toBeVisible();

    const feedbackMetrics = await page.evaluate(() => {
      const de = document.documentElement;
      return { scrollW: de.scrollWidth, clientW: de.clientWidth };
    });
    expect(feedbackMetrics.scrollW).toBeLessThanOrEqual(feedbackMetrics.clientW + 1);
  });

  // Audit #114. At 390px the participant study page forced the document wider
  // than the viewport twice over: the calendar grid (a full week of >=128px
  // columns ~= 968px, measured 1160px document) and, in the default table view,
  // the Available Sessions legend + controls row that would not wrap (~655px).
  // jsdom applies no CSS and the scans above run at 1280px, so this is the only
  // place the phone containment can fail by name. It asserts the document does
  // not scroll sideways in EITHER view, and that the calendar is contained by
  // its own horizontal scroll container rather than by squashing the columns.
  test('Participant study page fits a 390px phone in both table and calendar view', async ({ page }) => {
    // A week of sessions on distinct days so the calendar renders its full,
    // widest grid - a single session would collapse to one column and hide the
    // overflow this guards against.
    const day = 24 * 60 * 60 * 1000;
    const sessions = Array.from({ length: 7 }, (_, i) => ({
      id: `session-${i + 1}`,
      opportunity_id: 'opp-1',
      start_time: new Date(Date.now() + (i + 1) * day + 17 * 60 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() + (i + 1) * day + 17.5 * 60 * 60 * 1000).toISOString(),
      capacity: 5,
      booked_count: 0,
    }));
    const opportunity = {
      id: 'opp-1',
      type: 'test',
      title: 'Phone Containment Study',
      purpose_one_liner: 'Guards the 390px calendar containment',
      status: 'published',
      default_duration_minutes: 30,
      sessions,
    };
    // One URL-aware handler for both the list (array) and the detail (object),
    // registered after the beforeEach list mock so it wins. Both must carry the
    // full week or the calendar collapses to one column.
    await page.route('**/api/opportunities**', async (route) => {
      const isDetail = /\/api\/opportunities\/opp-1(\?|$)/.test(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isDetail ? opportunity : [opportunity]),
      });
    });
    // The calendar grid fetches these on mount; stub them so it renders with no
    // backend (the a11y job has none) rather than erroring into an empty state.
    await page.route('**/api/bookings/my/bookings', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ upcoming: [], past: [] }) }));
    await page.route('**/api/calendar/connection-status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false }) }));
    await page.route('**/api/calendar/my-events**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/opportunities/opp-1');
    await page.waitForLoadState('load');

    const docContained = () => page.evaluate(() => {
      const de = document.documentElement;
      return { scrollW: de.scrollWidth, clientW: de.clientWidth };
    });

    // Default (table) view - the legend + controls row must have wrapped. Wait
    // on the panel, not the clock, so a slow shard cannot flake this gate.
    await expect(page.getByRole('heading', { name: /available sessions/i })).toBeVisible();
    const table = await docContained();
    expect(table.scrollW).toBeLessThanOrEqual(table.clientW + 1);

    // Calendar view - the grid must be contained by its own scroller.
    await page.getByRole('button', { name: /switch to calendar view/i }).click();
    await expect(page.locator('.calendar-timeline')).toBeVisible();
    // The full week must render, or the containment is not actually exercised.
    await expect(page.locator('.calendar-days-container .calendar-day-column')).toHaveCount(7);

    const calendar = await page.evaluate(() => {
      const de = document.documentElement;
      const timeline = document.querySelector('.calendar-timeline') as HTMLElement;
      // Scroll the week and measure header<->column alignment mid-week: the
      // whole point of the shared --cal-content-w is that the two independent
      // grids resolve to identical column widths and stay aligned. Containment
      // can hold while alignment silently drifts, so it needs its own check.
      timeline.scrollLeft = 300;
      const headers = Array.from(document.querySelectorAll('.calendar-sticky-header-row .calendar-day-header-cell'));
      const cols = Array.from(document.querySelectorAll('.calendar-days-container .calendar-day-column'));
      let maxDelta = 0;
      for (let i = 0; i < Math.min(headers.length, cols.length); i++) {
        maxDelta = Math.max(maxDelta, Math.abs(headers[i].getBoundingClientRect().left - cols[i].getBoundingClientRect().left));
      }
      return {
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        timelineScrolls: timeline.scrollWidth > timeline.clientWidth + 1,
        maxHeaderColumnDelta: Math.round(maxDelta),
      };
    });
    // No horizontal document overflow - the 1160px-at-390px symptom.
    expect(calendar.scrollW).toBeLessThanOrEqual(calendar.clientW + 1);
    // Contained by scroll, not by squashing: the full-width week still overflows
    // its own timeline container (so the columns keep their readable floor).
    expect(calendar.timelineScrolls).toBe(true);
    // Day headers stay column-aligned with day columns while scrolled - guards
    // the shared-width mechanism against drift (a broken identity keeps the page
    // contained and scrollable, so only this check catches it). The tolerance
    // absorbs sub-pixel rounding accumulated across 7 fractional columns (~3px);
    // a broken shared width sizes the text-filled header grid ~37px/column wider
    // than the body, i.e. hundreds of px total, so 8px cleanly separates them.
    expect(calendar.maxHeaderColumnDelta).toBeLessThanOrEqual(8);

    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations).toEqual([]);
  });

  // Fix-first row 6 (second-pass review). `.calendar-content-row` is
  // `width: 100%` of `.calendar-timeline`, but its day-grid child carries a
  // >=128px-per-column inline min-width floor that can exceed the space the
  // row actually has - a flex child's min-width wins over its row's own box.
  // Below 768px `.calendar-timeline` scrolled to absorb that, so it was
  // contained; above it there was no scroller anywhere in the chain, so the
  // excess painted straight through `.calendar-content-row` and the card
  // border, out into the page (measured live: slots reaching x=1317 against a
  // card ending at x=1248 at 1440x900). A narrow desktop window reproduces the
  // identical overflow without needing a phone.
  const mockWeekOfSessionsStudy = async (page: import('@playwright/test').Page) => {
    const day = 24 * 60 * 60 * 1000;
    const sessions = Array.from({ length: 7 }, (_, i) => ({
      id: `session-${i + 1}`,
      opportunity_id: 'opp-1',
      start_time: new Date(Date.now() + (i + 1) * day + 17 * 60 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() + (i + 1) * day + 17.5 * 60 * 60 * 1000).toISOString(),
      capacity: 5,
      booked_count: 0,
    }));
    const opportunity = {
      id: 'opp-1',
      type: 'test',
      title: 'Calendar Containment Study',
      purpose_one_liner: 'Guards calendar containment at desktop and phone widths',
      status: 'published',
      default_duration_minutes: 30,
      sessions,
    };
    await page.route('**/api/opportunities**', async (route) => {
      const isDetail = /\/api\/opportunities\/opp-1(\?|$)/.test(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isDetail ? opportunity : [opportunity]),
      });
    });
    await page.route('**/api/bookings/my/bookings', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ upcoming: [], past: [] }) }));
    await page.route('**/api/calendar/connection-status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false }) }));
    await page.route('**/api/calendar/my-events**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  };

  test('Calendar view stays inside its own card at 1440 desktop', async ({ page }) => {
    await mockWeekOfSessionsStudy(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/opportunities/opp-1');
    await page.waitForLoadState('load');

    await page.getByRole('button', { name: /switch to calendar view/i }).click();
    await expect(page.locator('.calendar-timeline')).toBeVisible();
    await expect(page.locator('.calendar-days-container .calendar-day-column')).toHaveCount(7);
    // The measurement that decides scroll-containment (ResizeObserver) is
    // async; give it a tick before reading the class or the geometry below.
    await expect(page.locator('.calendar-timeline.calendar-timeline--scrolls')).toBeVisible();

    // A raw slot/column rect is unaffected by ancestor clipping
    // (getBoundingClientRect ignores overflow), and the scroller's own border
    // box is unaffected by whether ITS content overflows - neither proves
    // anything painted past the card. What actually renders at a point just
    // past the card's right edge does: contained, that point hits the page
    // background; broken, it hits the calendar itself.
    const hitsCalendar = await page.evaluate(() => {
      const card = document.querySelector('.mission-scheduler') as HTMLElement;
      const timeline = document.querySelector('.calendar-timeline') as HTMLElement;
      const cardRect = card.getBoundingClientRect();
      const y = timeline.getBoundingClientRect().top + 20;
      const el = document.elementFromPoint(cardRect.right + 30, y);
      return Boolean(el && (el.closest('.calendar-timeline') || el.closest('.calendar-days-container')));
    });
    expect(hitsCalendar).toBe(false);

    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations).toEqual([]);
  });

  // The fix for the finding above (a real measurement-driven
  // `.calendar-timeline--scrolls` class, not a bare `overflow-x: auto` on
  // every width) exists because a blanket rule broke `position: sticky` on
  // the desktop day-header for every week, including ones with room to
  // spare - `position: sticky` computes against the nearest scroll
  // container, not the viewport, so ANY overflow rule on `.calendar-timeline`
  // silently detaches the header the moment it exists. This is the control:
  // a week that comfortably fits must keep its sticky header exactly as
  // before.
  test('Calendar view keeps its sticky day header on desktop when the week comfortably fits', async ({ page }) => {
    const day = 24 * 60 * 60 * 1000;
    const opportunity = {
      id: 'opp-1',
      type: 'test',
      title: 'Comfortable Week Study',
      purpose_one_liner: 'A single session, nowhere near the day-grid floor',
      status: 'published',
      default_duration_minutes: 30,
      sessions: [{
        id: 'session-1',
        opportunity_id: 'opp-1',
        start_time: new Date(Date.now() + day + 17 * 60 * 60 * 1000).toISOString(),
        end_time: new Date(Date.now() + day + 17.5 * 60 * 60 * 1000).toISOString(),
        capacity: 5,
        booked_count: 0,
      }],
    };
    await page.route('**/api/opportunities**', async (route) => {
      const isDetail = /\/api\/opportunities\/opp-1(\?|$)/.test(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(isDetail ? opportunity : [opportunity]) });
    });
    await page.route('**/api/bookings/my/bookings', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ upcoming: [], past: [] }) }));
    await page.route('**/api/calendar/connection-status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false }) }));
    await page.route('**/api/calendar/my-events**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/opportunities/opp-1');
    await page.waitForLoadState('load');

    await page.getByRole('button', { name: /switch to calendar view/i }).click();
    await expect(page.locator('.calendar-timeline')).toBeVisible();
    // One session, one column - nowhere near the 968px day-grid floor at a
    // 1440px viewport, so the measurement must NOT switch this into
    // scroll-contained mode.
    await expect(page.locator('.calendar-timeline.calendar-timeline--scrolls')).toHaveCount(0);

    await page.evaluate(() => window.scrollBy(0, 600));
    const headerTop = await page.locator('.calendar-sticky-header-row').evaluate((el) => el.getBoundingClientRect().top);
    // Pinned near the viewport top, not scrolled away with the page.
    expect(headerTop).toBeGreaterThanOrEqual(0);
    expect(headerTop).toBeLessThan(100);
  });

  // A 390px phone still has to scroll seven >=128px columns sideways, and the
  // only affordance for that was an unlabelled native scrollbar the width of a
  // sliver at the top of the grid - discoverable only by an accidental swipe.
  // The existing "N active studies"-style Previous/Next week nav does not
  // help here either: it only renders once a study has MORE session days than
  // fit in one page (MAX_VISIBLE_DAYS), so a plain one-week study shows no
  // pager at all on phone.
  test('Calendar view offers a visible day pager at 390 phone width', async ({ page }) => {
    await mockWeekOfSessionsStudy(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/opportunities/opp-1');
    await page.waitForLoadState('load');

    await page.getByRole('button', { name: /switch to calendar view/i }).click();
    await expect(page.locator('.calendar-timeline')).toBeVisible();

    const nextDay = page.getByRole('button', { name: /next day/i });
    const previousDay = page.getByRole('button', { name: /previous day/i });
    await expect(nextDay).toBeVisible();
    await expect(previousDay).toBeVisible();
    await expect(previousDay).toBeDisabled();

    const scrollBefore = await page.locator('.calendar-timeline').evaluate((el) => el.scrollLeft);
    await nextDay.click();
    await expect.poll(() => page.locator('.calendar-timeline').evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(scrollBefore);

    const doc = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
    expect(doc.scrollW).toBeLessThanOrEqual(doc.clientW + 1);
  });

  test('Forms should be accessible', async ({ page }) => {
    // Mock admin user for form access
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

    await page.goto('/admin/opportunities/new');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Untitled study' }), page.locator('main form').first());
    
    // Test form accessibility
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Header navigation should be accessible', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Browse studies' }), page.getByText('Accessibility Test Opportunity').first());
    
    // Test header specifically
    const header = page.locator('header');
    await expect(header).toBeVisible();
    
    // Check skip link
    const skipLink = page.locator('a.skip-link');
    await expect(skipLink).toHaveAttribute('href', '#main-content');
    
    // Verify skip link works
    await skipLink.focus();
    await expect(skipLink).toBeVisible();
    
    // Test accessibility of header only
    const accessibilityScanResults = await new AxeBuilder({ page })
      .include('header')
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Skip link should be functional', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Browse studies' }), page.getByText('Accessibility Test Opportunity').first());
    
    // Check if skip link exists
    const skipLink = page.locator('a.skip-link');
    const skipLinkCount = await skipLink.count();
    
    // Skip link should exist
    expect(skipLinkCount).toBeGreaterThan(0);
    
    // Focus skip link (Tab key focuses it)
    // Skip link should be the first focusable element
    await page.keyboard.press('Tab');
    
    
    // Skip link should be visible when focused
    await expect(skipLink).toBeVisible({ timeout: 2000 });
    
    // Verify skip link is focused or has the correct href
    const focusedElement = page.locator(':focus');
    const focusedHref = await focusedElement.getAttribute('href');
    expect(focusedHref).toBe('#main-content');
    
    // Activate skip link
    await page.keyboard.press('Enter');
    
    
    // Should focus main content
    const mainContent = page.locator('#main-content');
    await expect(mainContent).toBeVisible();
  });

  test('Keyboard navigation should work', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Browse studies' }), page.getByText('Accessibility Test Opportunity').first());
    
    // Tab through interactive elements
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    
    // All elements should be focusable
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();
  });

  test('Color contrast should meet WCAG AA standards', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Browse studies' }), page.getByText('Accessibility Test Opportunity').first());
    
    // Check accessibility with color contrast rules
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Images should have alt text', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Browse studies' }), page.getByText('Accessibility Test Opportunity').first());
    
    // Check image accessibility
    const images = page.locator('img');
    const count = await images.count();
    
    for (let i = 0; i < count; i++) {
      const img = images.nth(i);
      const alt = await img.getAttribute('alt');
      // Alt should exist (can be empty string for decorative images)
      expect(alt).not.toBeNull();
    }
  });

  test('Form inputs should have labels', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Browse studies' }), page.getByText('Accessibility Test Opportunity').first());
    
    // Check form accessibility
    const inputs = page.locator('input[type="text"], input[type="email"], input[type="number"], select, textarea');
    const count = await inputs.count();
    
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const id = await input.getAttribute('id');
      const ariaLabel = await input.getAttribute('aria-label');
      const ariaLabelledBy = await input.getAttribute('aria-labelledby');
      
      // Should have either id (for label association), aria-label, or aria-labelledby
      const hasLabel = id || ariaLabel || ariaLabelledBy;
      expect(hasLabel).toBeTruthy();
    }
  });

  /**
   * My Bookings, empty and populated.
   *
   * The stub used to be `**\/api\/bookings\/me**`, and the page calls
   * `/bookings/my/bookings`. Nothing matched, the request failed, and the test
   * scanned the "Failed to load bookings" error state believing it was scanning
   * the empty state - so an empty My Bookings had never actually been checked
   * either.
   *
   * Both states now get a scan. The populated one matters most: every card on
   * this page is data, so with no fixture the whole card - title, description,
   * metadata list, badges, outcome - is a region axe has never once looked at.
   * A local run against a seeded stack found 38 colour-contrast nodes there
   * that no backend-free run could reach.
   */

  const bookingsRoute = '**/api/bookings/my/bookings';
  const sessionEventsRoute = '**/api/me/session-events';

  const hoursFromNow = (hours: number) =>
    new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  /* Relative, never literal: a fixture dated `2026-01-05` stops being a past
     booking the moment the clock passes it, and the card it was there to render
     quietly disappears from the scan. */
  const populatedBookings = {
    upcoming: [
      {
        id: 'booking-upcoming-1',
        user_id: 'user-1',
        session_id: 'session-upcoming-1',
        status: 'booked',
        created_at: hoursFromNow(-72),
        updated_at: hoursFromNow(-72),
        session_start_time: hoursFromNow(48),
        session_end_time: hoursFromNow(49),
        session_capacity: 5,
        session_location: 'https://meet.google.com/abc-defg-hij',
        opportunity_title: 'Upcoming moderated interview',
        opportunity_type: 'interview',
        opportunity_purpose: 'Understand how researchers plan a round of sessions.',
        owner_name: 'Ada Researcher',
        owner_email: 'ada@example.com',
      },
    ],
    /* The past section is where the contrast failures live, because it is the
       only place `.booking-card-past` is applied. One card per visual variant
       the section can produce: a confirmed attendance, a rejected one, an
       unresolved one, and a cancellation. */
    past: [
      {
        id: 'booking-past-approved',
        user_id: 'user-1',
        session_id: 'session-past-1',
        status: 'booked',
        completion_status: 'approved',
        completed_at: hoursFromNow(-48),
        created_at: hoursFromNow(-240),
        updated_at: hoursFromNow(-48),
        session_start_time: hoursFromNow(-72),
        session_end_time: hoursFromNow(-71),
        session_capacity: 5,
        opportunity_title: 'Past usability test, attendance confirmed',
        opportunity_type: 'test',
        opportunity_purpose: 'Check whether the booking flow reads clearly on a phone.',
        owner_name: 'Ada Researcher',
        owner_email: 'ada@example.com',
      },
      {
        id: 'booking-past-rejected',
        user_id: 'user-1',
        session_id: 'session-past-2',
        status: 'booked',
        completion_status: 'rejected',
        created_at: hoursFromNow(-360),
        updated_at: hoursFromNow(-120),
        session_start_time: hoursFromNow(-168),
        session_end_time: hoursFromNow(-167),
        session_capacity: 8,
        opportunity_title: 'Past poll, not confirmed',
        opportunity_type: 'poll',
        opportunity_purpose: 'Gauge which onboarding step people abandon.',
        owner_name: 'Grace Researcher',
        owner_email: 'grace@example.com',
      },
      {
        id: 'booking-past-pending',
        user_id: 'user-1',
        session_id: 'session-past-3',
        status: 'booked',
        created_at: hoursFromNow(-400),
        updated_at: hoursFromNow(-200),
        session_start_time: hoursFromNow(-200),
        session_end_time: hoursFromNow(-199),
        session_capacity: 3,
        opportunity_title: 'Past survey, awaiting confirmation',
        opportunity_type: 'survey',
        opportunity_purpose: 'Collect views on the new results export.',
        owner_name: 'Grace Researcher',
        owner_email: 'grace@example.com',
      },
      {
        id: 'booking-past-cancelled',
        user_id: 'user-1',
        session_id: 'session-past-4',
        status: 'cancelled',
        cancelled_at: hoursFromNow(-300),
        created_at: hoursFromNow(-500),
        updated_at: hoursFromNow(-300),
        session_start_time: hoursFromNow(-264),
        session_end_time: hoursFromNow(-263),
        session_capacity: 4,
        opportunity_title: 'Cancelled question session',
        opportunity_type: 'question',
        opportunity_purpose: 'Ask five people what they expect the Cortex tab to do.',
        owner_name: 'Ada Researcher',
        owner_email: 'ada@example.com',
      },
    ],
  };

  /* Self-guided sessions render `.booking-card-past` too, from a different
     endpoint and in a section that only appears when this array is non-empty -
     so an empty stub leaves it unscanned exactly as an empty bookings stub
     leaves the cards unscanned. */
  const populatedSessionEvents = [
    {
      id: 'event-1',
      opportunity_id: 'opp-1',
      opportunity_title: 'Self-guided unmoderated walkthrough',
      firsthand_session_id: 'fh-session-1',
      event_type: 'session_completed',
      occurred_at: hoursFromNow(-96),
      received_at: hoursFromNow(-96),
    },
    {
      id: 'event-2',
      opportunity_id: 'opp-2',
      opportunity_title: 'Self-guided session that was abandoned',
      firsthand_session_id: 'fh-session-2',
      event_type: 'session_abandoned',
      occurred_at: hoursFromNow(-140),
      received_at: hoursFromNow(-140),
    },
  ];

  const stubParticipant = async (
    page: import('@playwright/test').Page,
    bookings: unknown,
    sessionEvents: unknown
  ) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'user-1',
          name: 'Demo User',
          email: 'demo@example.com',
          role: 'employee',
        }),
      });
    });
    await page.route(bookingsRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(bookings),
      });
    });
    await page.route(sessionEventsRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sessionEvents),
      });
    });
  };

  /**
   * Prove the fixture actually rendered before trusting a clean scan.
   *
   * axe reports no violations on a page with no cards on it, so a stub that
   * silently stopped matching - a renamed route, a changed response shape -
   * would turn this test green while deleting everything it exists to cover.
   * That is the failure the old `bookings/me` stub had, undetected.
   */
  const expectPopulatedBookings = async (page: import('@playwright/test').Page) => {
    await expect(page.locator('.booking-card-upcoming')).toHaveCount(1);
    await expect(page.locator('.booking-card-past')).toHaveCount(
      populatedBookings.past.length + populatedSessionEvents.length
    );
    /* Two, not one: the cancelled booking and the abandoned self-guided
       session share this badge class. */
    await expect(page.locator('.booking-badge-cancelled')).toHaveCount(2);
    await expect(page.locator('.booking-outcome-approved')).toHaveCount(1);
  };

  test('My Bookings page (empty) should be accessible', async ({ page }) => {
    await stubParticipant(page, { upcoming: [], past: [] }, []);
    await page.goto('/');
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/my-bookings');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'My bookings' }), page.locator('.booking-card-empty').first());
    await expect(page.locator('.booking-card-empty')).toHaveCount(2);
    const results = await new AxeBuilder({ page }).analyze();
    expectNoViolations(results, 'My Bookings (empty)');
  });

  test('My Bookings page (populated) should be accessible', async ({ page }) => {
    await stubParticipant(page, populatedBookings, populatedSessionEvents);
    await page.goto('/');
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/my-bookings');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'My bookings' }), page.locator('.booking-card').first());
    await expectPopulatedBookings(page);
    const results = await new AxeBuilder({ page }).analyze();
    expectNoViolations(results, 'My Bookings (populated, light)');
    expectBookingContrastActuallyMeasured(results, 'My Bookings (populated, light)');
  });

  /**
   * The same page in dark mode.
   *
   * Past cards are dimmed in both themes, by two different rules, so a fix
   * verified in one theme says nothing about the other. The theme is read from
   * localStorage at first render, so it has to be set on the origin before the
   * app mounts.
   */
  test('My Bookings page (populated, dark mode) should be accessible', async ({ page }) => {
    await stubParticipant(page, populatedBookings, populatedSessionEvents);
    await page.goto('/');
    await page.evaluate(() => {
      sessionStorage.setItem('loginRedirect', 'true');
      localStorage.setItem('theme', 'dark');
    });
    await page.goto('/my-bookings');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'My bookings' }), page.locator('.booking-card').first());
    await expect(page.locator('body.theme-dark')).toHaveCount(1);
    await expectPopulatedBookings(page);
    /* Remove the decorative background before scanning. It is a fixed,
       full-viewport canvas, and with it in place axe defers on every card
       instead of measuring it - 22 nodes `incomplete`, 0 violations, on a page
       that had a real failure. Its own fill is #030305, the exact colour
       `body.theme-dark .my-bookings-page` paints underneath it, so taking it
       out changes no composited background: it changes only whether axe is
       willing to compute one. */
    await page.evaluate(() => {
      document.querySelectorAll('.slow-neural-background').forEach((node) => node.remove());
    });
    /* The same reason, second instance. Admin table Step 1 (2026-09-23)
       deleted the `body.theme-dark .my-bookings-page { background: #030305 }`
       fill cited above and moved the dark ground - #030305 plus a faint
       orange bloom and 24px grid - onto the BODY as a `background-image`
       (search "painted on the BODY" in _themes.css). axe will not judge
       contrast over a background image, so it put 11 booking nodes in
       `incomplete` (4 interleaved runs against main). Removing the image
       leaves the #030305 fill it sits on. Measured by hand before this line
       was added (recorded in the MR): all 11 nodes stay >= 5.37:1 against
       the LIGHTEST colour the image can reach (bloom peak plus both grid
       lines, read from the computed gradient stops), so this does not hide a
       failure among them. */
    await page.evaluate(() => {
      document.body.style.backgroundImage = 'none';
    });
    const results = await new AxeBuilder({ page }).analyze();
    expectNoViolations(results, 'My Bookings (populated, dark)');
    expectBookingContrastActuallyMeasured(results, 'My Bookings (populated, dark)');
  });

  /**
   * The accent fill that is allowed to carry text must actually be able to.
   *
   * Nothing else in this file can catch this. axe scans a resting DOM, so it
   * never sees a `:hover` fill, and it only judges what is on the page - the
   * leaderboard's active tab and the period buttons are not on any route
   * scanned here. That is how `--brand-primary` sat at 3.87 under white text in
   * dark mode while carrying a comment in _tokens.css claiming it was AA, and
   * how the skip link's own fallback arm resolved to it.
   *
   * So this asserts the token rather than a rendering: resolve it in a real
   * browser in both themes and measure it against white. Every rule that fills
   * behind white text uses this one token, so one assertion per theme covers
   * all of them - including the states no scan can reach.
   */
  const WHITE: [number, number, number] = [255, 255, 255];

  const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
    const channel = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  const contrastRatio = (a: [number, number, number], b: [number, number, number]): number => {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const resolveColourToken = async (
    page: import('@playwright/test').Page,
    token: string
  ): Promise<[number, number, number]> => {
    const rgb = await page.evaluate((name) => {
      /* Paint the token on a throwaway element and read back what the browser
         actually resolved, rather than trusting the stylesheet source - that is
         the whole difference between the two halves of this defect. */
      const probe = document.createElement('div');
      probe.style.position = 'fixed';
      probe.style.left = '-9999px';
      probe.style.backgroundColor = `var(${name})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    }, token);
    const parts = rgb.match(/[\d.]+/g);
    if (!parts || parts.length < 3) {
      throw new Error(`${token} did not resolve to a colour (got "${rgb}") - it is probably undefined in this theme`);
    }
    return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  };

  for (const theme of ['light', 'dark'] as const) {
    test(`Accent fill carries white text at AA in ${theme} mode`, async ({ page }) => {
      await page.goto('/');
      await page.evaluate((t) => localStorage.setItem('theme', t), theme);
      await page.goto('/');
      await page.waitForLoadState('load');
      await expect(page.locator(`body.theme-${theme}`)).toHaveCount(1);

      const fill = await resolveColourToken(page, '--accent-fill-text-safe');
      const ratio = contrastRatio(WHITE, fill);
      const asHex = `#${fill.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      console.log(`  --accent-fill-text-safe in ${theme}: ${asHex}, white text ${ratio.toFixed(2)}:1`);

      expect(
        ratio,
        `white text on --accent-fill-text-safe (${asHex}) measures ${ratio.toFixed(2)} in ${theme} mode, below the 4.5 AA threshold for small text`
      ).toBeGreaterThanOrEqual(4.5);

      /* And prove the check has teeth: the identity colour it replaced must
         still be the thing that fails, so a future edit collapsing the two back
         into one token cannot pass this test quietly. */
      const identity = await resolveColourToken(page, '--brand-primary');
      expect(contrastRatio(WHITE, identity)).toBeLessThan(4.5);
    });
  }

  test('Feedback page should be accessible', async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'user-1',
          name: 'Demo User',
          email: 'demo@example.com',
          role: 'employee',
        }),
      });
    });
    await page.goto('/');
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/feedback');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Feedback' }), page.locator('main form').first());
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('Settings page should be accessible', async ({ page }) => {
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
    await page.route('**/api/notification-preferences**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ on_book_email: true, on_cancel_email: true }),
      });
    });
    await page.goto('/');
    await page.evaluate(() => sessionStorage.setItem('loginRedirect', 'true'));
    await page.goto('/admin/settings');
    await page.waitForLoadState('load');
    await expectRendered(page, page.getByRole('heading', { level: 1, name: 'Settings' }), page.getByRole('heading', { level: 2, name: 'Profile' }));
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  /**
   * Fix-first row 1 (migrated). The signed-out landing's brand wordmark is now
   * the hero `<h1 class="landing-product-name">`, not a header wordmark: the
   * header states the brand once via its mark and drops the wordmark when signed
   * out (the hero carries the name), so this asserts no header wordmark is present
   * and measures the hero instead. The original defect was a near-white wordmark
   * on the near-white LIGHT ground (~1.1:1); this still measures the REAL rendered
   * ink against the landing ground in both themes:
   *   - light: a solid #0f172a fill on the #FFFFFF ground
   *   - dark:  a white -> #D4D4D4 gradient the text is clipped to, so
   *            `-webkit-text-fill-color` is transparent and getComputedStyle().color
   *            does not describe what is on screen - read every gradient stop and
   *            take the worst contrast.
   * `.landing-page-wrapper` is the opaque, full-height, z-index:50 ground each
   * theme paints solid (#030305 dark / #FFFFFF light, per _components.css).
   */
  for (const theme of ['light', 'dark'] as const) {
    test(`Landing hero wordmark meets AA contrast in ${theme} mode (row 1)`, async ({ page }) => {
      // A genuine 401 - Home only renders Landing when signed out, the state
      // row 1 is about.
      await page.route('**/api/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
      await page.goto('/');
      await page.evaluate((t) => localStorage.setItem('theme', t), theme);
      await page.goto('/');
      await page.waitForLoadState('load');
      await expect(page.locator(`body.theme-${theme}`)).toHaveCount(1);
      await expect(page.locator('body.landing-page')).toHaveCount(1);

      // Signed out, the header carries only its mark - the wordmark is dropped so
      // the hero is the single place the brand name is stated.
      await expect(page.locator('.header .logo-word')).toHaveCount(0);

      const wordmark = page.locator('.landing-product-name').first();
      await expect(wordmark).toBeVisible();

      // The visible ink: a solid fill in light; in dark the gradient the text is
      // clipped to (the fill is transparent there). Collect every candidate colour.
      const inks: string[] = await wordmark.evaluate((el) => {
        const cs = getComputedStyle(el);
        const fill = cs.getPropertyValue('-webkit-text-fill-color') || cs.color;
        const clip = cs.getPropertyValue('-webkit-background-clip') || cs.backgroundClip;
        const isTransparent = fill === 'transparent' || /,\s*0\s*\)$/.test(fill.replace(/\s+/g, ''));
        if (isTransparent && clip === 'text' && cs.backgroundImage && cs.backgroundImage !== 'none') {
          const stops = cs.backgroundImage.match(/rgba?\([^)]*\)/g);
          if (stops && stops.length) return stops;
        }
        return [fill];
      });
      const bg = await page.locator('.landing-page-wrapper').evaluate((el) => getComputedStyle(el).backgroundColor);
      const toRgbTuple = (rgb: string): [number, number, number] => {
        const parts = rgb.match(/[\d.]+/g);
        if (!parts || parts.length < 3) throw new Error(`not a color: ${rgb}`);
        return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
      };
      const bgTuple = toRgbTuple(bg);
      const worst = Math.min(...inks.map((c) => contrastRatio(toRgbTuple(c), bgTuple)));
      expect(
        worst,
        `.landing-product-name ink [${inks.join(', ')}] on .landing-page-wrapper (${bg}) measures ${worst.toFixed(2)} in ${theme} mode, below the 4.5 AA threshold`
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  /**
   * Fix-first row 13. index.html shipped a commented-out favicon link and a
   * plain "AdaptaLabs" <title> with no product icon anywhere - the browser
   * tab carried no visual identity at all. This is the one place a fresh
   * <title>/<link rel="icon"> can fail by name; jsdom never loads index.html.
   */
  test('Signed-out landing carries the Cortex tab identity (row 13)', async ({ page }) => {
    // Override the beforeEach's blanket /api/me mock so this is genuinely
    // the signed-out landing, not the logged-in Home page.
    await page.route('**/api/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
    const response = await page.goto('/');
    await page.waitForLoadState('load');
    expect(response?.ok()).toBe(true);

    await expect(page).toHaveTitle(/^Cortex/);

    const description = await page.evaluate(
      () => document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null
    );
    expect(description).toMatch(/^Cortex/);

    const iconHref = await page.evaluate(() => {
      const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
      return link?.getAttribute('href') ?? null;
    });
    expect(iconHref).toBe('/favicon.svg');

    const iconResponse = await page.request.get(new URL(iconHref!, page.url()).toString());
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()['content-type'] || '').toContain('svg');

    const touchIconHref = await page.evaluate(() => {
      const link = document.querySelector('link[rel="apple-touch-icon"]') as HTMLLinkElement | null;
      return link?.getAttribute('href') ?? null;
    });
    expect(touchIconHref).toBe('/apple-touch-icon.png');
    const touchIconResponse = await page.request.get(new URL(touchIconHref!, page.url()).toString());
    expect(touchIconResponse.ok()).toBe(true);
  });

  /**
   * Fix-first row 20 (dropdown half). `.admin-action-dropdown-menu` opened
   * leftward (`right: 0`) at every width. Correct on desktop, where the kebab
   * sits at the right of a wide row - but below 768px the table reflows to
   * stacked cards and the kebab moves to the LEFT of a narrow card, so the
   * same anchor opened the menu off the LEFT edge of the viewport (confirmed
   * live at 390px: the menu's left half went negative and its text clipped).
   * jsdom applies no layout, so this geometry can only be proven here.
   */
  test('Row-actions dropdown stays within the viewport at 390px (row 20)', async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'admin-1', name: 'Admin User', email: 'admin@example.com', role: 'researcher_admin' }),
      });
    });
    await mockAdminPanels(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin');
    await page.waitForLoadState('load');

    const kebab = page.locator('.admin-data-table .admin-action-btn-kebab').first();
    await expect(kebab).toBeVisible();
    await kebab.click();

    const menu = page.locator('.admin-action-dropdown-menu.show, .admin-action-dropdown-menu').first();
    await expect(menu).toBeVisible();

    const rect = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    expect(rect.left, `menu left edge ${rect.left} must not be negative`).toBeGreaterThanOrEqual(0);
    expect(rect.right, `menu right edge ${rect.right} must not exceed the 390px viewport`).toBeLessThanOrEqual(391);
  });

  /**
   * Fix-first rows 19, 20 (detail half), 27. The Completion Approvals card:
   * the rejection-reason textarea had a near-invisible border (row 19), the
   * session-details grid clipped instead of wrapped at narrow widths (row
   * 20), and the Approve button (`.btn-success`) failed AA in dark before the
   * status-color unification (row 27). One long study title reproduces the
   * clip; both themes exercise the Approve button fill.
   */
  const longApproval = {
    booking_id: 'booking-1',
    user_id: 'user-1',
    session_id: 'session-1',
    completed_at: new Date().toISOString(),
    admin_notes: null,
    user_name: 'Demo User',
    user_email: 'demo@example.com',
    start_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    end_time: new Date().toISOString(),
    opportunity_title: 'ScriptRunner for Jira: the next-generation script editor experience',
    opportunity_type: 'test',
    owner_user_id: 'admin-1',
  };

  for (const theme of ['light', 'dark'] as const) {
    test(`Completion Approvals card is accessible in ${theme} mode, with no clipped text (rows 19, 20, 27)`, async ({ page }) => {
      await page.route('**/api/me', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'admin-1', name: 'Admin User', email: 'admin@example.com', role: 'researcher_admin' }),
        });
      });
      // The fixture panels first, so this test's own long approval (registered
      // after, so matched first) replaces the fixture's approvals.
      await mockAdminPanels(page);
      await page.route('**/api/bookings/pending-approvals', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([longApproval]) }));

      await page.goto('/');
      await page.evaluate((t) => localStorage.setItem('theme', t), theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/admin');
      await page.waitForLoadState('load');
      await expect(page.locator(`body.theme-${theme}`)).toHaveCount(1);

      await page.getByRole('tab', { name: /Completion Approvals/ }).click();
      await expect(page.locator('.pending-approvals__card')).toHaveCount(1);

      // Row 20: no detail line clips - every one fits its own card width.
      const overflow = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('.pending-approvals__detail'));
        return nodes
          .map((el) => ({ text: el.textContent, scrollW: el.scrollWidth, clientW: el.clientWidth }))
          .filter((n) => n.scrollW > n.clientW + 1);
      });
      expect(overflow, `clipped detail line(s): ${JSON.stringify(overflow)}`).toEqual([]);

      // Row 19: the textarea border clears the 3:1 UI-component minimum
      // against its own background, computed from the real rendered styles.
      const border = await page.locator('.pending-approvals__textarea').evaluate((el) => {
        const s = getComputedStyle(el);
        return { border: s.borderTopColor, bg: s.backgroundColor };
      });
      const toRgbTuple = (rgb: string): [number, number, number] => {
        const parts = rgb.match(/[\d.]+/g);
        if (!parts || parts.length < 3) throw new Error(`not a color: ${rgb}`);
        return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
      };
      const borderRatio = contrastRatio(toRgbTuple(border.border), toRgbTuple(border.bg));
      expect(
        borderRatio,
        `textarea border (${border.border}) on its background (${border.bg}) measures ${borderRatio.toFixed(2)} in ${theme} mode, below the 3:1 minimum`
      ).toBeGreaterThanOrEqual(3);

      // Row 27: the Approve button (--status-success fill + white text).
      // Scoped to color-contrast: this card sits inside the admin page's
      // pre-existing (unrelated) heading-order structure, which a full scan
      // would otherwise blame on this fix.
      const scan = await new AxeBuilder({ page })
        .include('.pending-approvals__card')
        .withRules(['color-contrast'])
        .analyze();
      // A scan that resolves nothing reports zero violations too - assert it
      // actually measured something before trusting the empty violations list.
      // One pre-existing, unrelated exception: axe cannot resolve the
      // textarea's placeholder-text background ("partially obscured") on
      // this markup regardless of theme or this diff's changes - it is not
      // the border (row 19, measured directly above) or the Approve button
      // (row 27, the actual subject of this scan).
      const unexpectedIncomplete = scan.incomplete
        .flatMap((rule) => rule.nodes.map((node) => node.target.map(String).join(' ')))
        .filter((target) => target !== '#notes-booking-1');
      expect(
        unexpectedIncomplete,
        `axe could not resolve ${unexpectedIncomplete.length} unexpected node(s) in ${theme} mode - the scan may be blind: ${unexpectedIncomplete.join(', ')}`
      ).toEqual([]);
      expectNoViolations(scan, `Completion Approvals card (${theme})`);
    });
  }

  /**
   * Fix-first row 23. All six `--lozenge-<type>-text` tokens were flat
   * #FFFFFF at :root (dark) regardless of type. The light-mode counterpart of
   * this scan already exists above; this is its dark-mode twin, proving axe
   * measures every type's badge as passing once each carries its own hue.
   */
  test('Admin study type badges meet WCAG AA contrast in dark mode (row 23)', async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'admin-1', name: 'Admin User', email: 'admin@example.com', role: 'researcher_admin' }),
      });
    });
    await page.route('**/api/admin/dashboard**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }) });
    });
    const types = ['test', 'interview', 'poll', 'survey', 'question', 'unmoderated'];
    const statuses = ['draft', 'published', 'closed'];
    const studies = types.map((type, i) => ({
      id: `opp-${i}`,
      type,
      title: `${type} study`,
      purpose_one_liner: 'Badge contrast fixture',
      status: statuses[i % statuses.length],
      default_duration_minutes: 30,
      sessions: [],
    }));
    await page.route('**/api/opportunities**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(studies) });
    });

    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/admin');
    await page.waitForLoadState('load');
    await expect(page.locator('body.theme-dark')).toHaveCount(1);
    await expect(page.locator('.admin-study-status').first()).toBeVisible();
    // Admin table Step 1 moved the type lozenge from its own column into the
    // Study cell's meta line (the first column).
    await expect(page.locator('td:first-child .lozenge')).toHaveCount(types.length);

    const scan = await new AxeBuilder({ page })
      .include('.admin-data-table')
      .withRules(['color-contrast'])
      .analyze();
    // A scan that resolves nothing reports zero violations too - assert it
    // actually measured something before trusting the empty violations list.
    // Three pre-existing, unrelated exceptions on this table's markup, none
    // touched by row 23 (the TYPE lozenges, now td:first-child .lozenge, which DO
    // get fully measured with zero incompletes - this filter would not hide
    // a regression there): the sort-caret and kebab icons are decorative
    // glyphs axe cannot contrast-check at all ("non-text characters"), and
    // the STATUS pills (draft/published/closed - a different fix, row 27) hit
    // axe's "partially obscured" heuristic regardless of their color.
    // No clause for `.admin-pill--auto-closed` (#142): measured with this
    // regex back in its pre-#142 form, the filter stays green, so the
    // marker resolves cleanly and an exception for it would be an
    // unexercised clause hiding whatever lands there next.
    const unexpectedIncomplete = scan.incomplete
      .flatMap((rule) => rule.nodes.map((node) => node.target.map(String).join(' ')))
      .filter((target) => !/admin-th-sort-caret|Actions for .* study.*aria-hidden|admin-study-status/.test(target));
    expect(
      unexpectedIncomplete,
      `axe could not resolve ${unexpectedIncomplete.length} unexpected node(s) - the scan may be blind: ${unexpectedIncomplete.join(', ')}`
    ).toEqual([]);
    expectNoViolations(scan, 'Admin study badges (dark)');
  });

  /**
   * Fix-first row 27 (HIGH follow-up). The status-color unification promoted
   * light's FILL values to :root, but --status-success/-danger are also used
   * as bare TEXT in several places (.text-success, .alert-success, the admin
   * status pills, .cortex-stat-trend--negative) - and light's fill values
   * measure only 3.33/3.15 as text directly on the dark app background, below
   * AA. --status-success-text/--status-danger-text are the separate TEXT-role
   * tokens this needed (mirroring the --status-info split already made for
   * exactly this reason). The admin status pill this affects hits axe's
   * "partially obscured" heuristic regardless of color (filtered out above),
   * so this resolves the tokens directly in a real browser instead - the same
   * technique the accent-fill loop above uses - sidestepping that heuristic
   * entirely.
   */
  test('Status text tokens clear AA against the dark app background (row 27)', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/');
    await page.waitForLoadState('load');
    await expect(page.locator('body.theme-dark')).toHaveCount(1);

    const darkAppBg: [number, number, number] = [10, 9, 26]; // #0A091A
    for (const token of ['--status-success-text', '--status-danger-text']) {
      const rgb = await resolveColourToken(page, token);
      const ratio = contrastRatio(rgb, darkAppBg);
      const asHex = `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      expect(
        ratio,
        `${token} (${asHex}) on the dark app background measures ${ratio.toFixed(2)}, below the 4.5 AA threshold`
      ).toBeGreaterThanOrEqual(4.5);
    }

    // Teeth: the FILL tokens they were split from must still be the thing
    // that fails as text in dark, or a future edit collapsing them back into
    // one token passes this file quietly.
    const successFill = await resolveColourToken(page, '--status-success');
    expect(contrastRatio(successFill, darkAppBg)).toBeLessThan(4.5);
  });
});

