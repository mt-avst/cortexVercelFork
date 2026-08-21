import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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

test.describe('Accessibility Tests', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    // Set viewport size
    await page.setViewportSize({ width: 1280, height: 720 });
    
    // Mock API responses for consistency (only against a local stack - against
    // a deployment the real API is the thing under test).
    if (baseURL?.includes('localhost')) {
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
    await page.waitForTimeout(500);
    
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
    await page.waitForTimeout(500);
    
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
    await page.waitForTimeout(500);
    
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

    await page.route('**/api/dashboard', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalOpportunities: 5,
          totalBookings: 10,
          totalParticipants: 8,
          availableSlots: 25
        }),
      });
    });

    await page.goto('/admin');
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
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
    await page.waitForTimeout(500);
    
    // Test form accessibility
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Header navigation should be accessible', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    
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
    await page.waitForTimeout(500);
    
    // Check if skip link exists
    const skipLink = page.locator('a.skip-link');
    const skipLinkCount = await skipLink.count();
    
    // Skip link should exist
    expect(skipLinkCount).toBeGreaterThan(0);
    
    // Focus skip link (Tab key focuses it)
    // Skip link should be the first focusable element
    await page.keyboard.press('Tab');
    
    // Wait a moment for CSS transition
    await page.waitForTimeout(200);
    
    // Skip link should be visible when focused
    await expect(skipLink).toBeVisible({ timeout: 2000 });
    
    // Verify skip link is focused or has the correct href
    const focusedElement = page.locator(':focus');
    const focusedHref = await focusedElement.getAttribute('href');
    expect(focusedHref).toBe('#main-content');
    
    // Activate skip link
    await page.keyboard.press('Enter');
    
    // Wait for navigation
    await page.waitForTimeout(100);
    
    // Should focus main content
    const mainContent = page.locator('#main-content');
    await expect(mainContent).toBeVisible();
  });

  test('Keyboard navigation should work', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    
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
    await page.waitForTimeout(500);
    
    // Check accessibility with color contrast rules
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Images should have alt text', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    
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
    await page.waitForTimeout(500);
    
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
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(200);
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
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

