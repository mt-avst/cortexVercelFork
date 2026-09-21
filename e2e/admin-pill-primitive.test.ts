import { test, expect } from '@playwright/test';

/**
 * #142: the studies table's three pills - the Type lozenge, the status pill
 * and the "Auto-closed" marker - share one box primitive (`.admin-pill`).
 *
 * This spec is the one place that measures that in a real browser. The
 * source-pin guard beside it
 * (`frontend/src/styles/__tests__/admin-pill-primitive.test.ts`) reads CSS and
 * JSX as strings, so it cannot see a cascade outcome: a later,
 * higher-specificity rule appended anywhere in `_components.css` can restore
 * the exact three-way misalignment #142 was filed against while every source
 * pin stays green (measured: it does).
 *
 * It lives in its OWN file, separate from `admin-table-chrome-layout.test.ts`,
 * because every route it needs is mocked - no backend, no database, no seed
 * data - which is what lets `playwright.accessibility.config.ts` run it (and
 * therefore the `test-a11y` CI job, against `vite preview` on localhost:3100).
 * Sitting in a file the a11y config's `testMatch` could not name is how this
 * guard came to run nowhere at all: it passed on a developer's machine and
 * no pipeline ever executed it.
 *
 * Routes are mocked rather than driven through `/auth/admin-login`, so the
 * real-login variants of these layout checks stay in
 * `admin-table-chrome-layout.test.ts`.
 */

type Fixture = Record<string, unknown>;

const study = (id: string, status: string, extra: Fixture = {}): Fixture => ({
  id,
  type: 'test',
  title: id,
  purpose_one_liner: 'Fixture for #142',
  status,
  default_duration_minutes: 30,
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
  sessions: [],
  ...extra,
});

/** A closed study renders the status pill AND the "Auto-closed" marker. */
const CLOSED = study('Closed study', 'closed');

/**
 * `isPublishedButNotWorking` resolves true for an external-delivery study
 * with no link, which is what renders `PUBLISHED_NOT_WORKING_LABEL`
 * ("Published, not working") - the one status label long enough to overflow
 * the fixed-width Status column.
 */
const NOT_WORKING = study('Question study', 'published', {
  delivery_mode: 'external',
  external_link_optional: null,
  meeting_location_optional: null,
});

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.describe('admin studies table pills share one box (#142)', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    // LOUD IN CI, quiet locally. A bare skip on a baseURL predicate is the
    // shape this spec was moved here to stop: point BASE_URL at 127.0.0.1 or
    // a service hostname and all five tests vanish while the job stays green.
    // In CI the skip is the failure, so assert it cannot happen.
    if (process.env.CI) {
      expect(baseURL, 'CI must run this spec against the local preview, not skip it').toContain('localhost');
    } else {
      test.skip(!baseURL?.includes('localhost'), 'route mocks below assume the local stack, not a deployment');
    }

    await page.route('**/api/me', async (route) => {
      await route.fulfill(
        json({
          id: 'admin-1',
          name: 'Admin User',
          email: 'admin@example.com',
          role: 'researcher_admin',
          business_unit: 'Research',
          role_title: 'Admin',
        })
      );
    });

    await page.route('**/api/bookings/pending-approvals**', async (route) => {
      await route.fulfill(json([]));
    });

    await page.route('**/api/feedback**', async (route) => {
      await route.fulfill(json({ data: [], has_more: false }));
    });

    await page.route('**/api/admin/dashboard**', async (route) => {
      await route.fulfill(
        json({
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
        })
      );
    });
  });

  const serve = async (page: import('@playwright/test').Page, studies: Fixture[]) => {
    await page.route('**/api/opportunities**', async (route) => {
      await route.fulfill(json(studies));
    });
  };

  const openAdmin = async (page: import('@playwright/test').Page) => {
    await page.goto('/admin', { waitUntil: 'load' });
    await expect(page.locator('table.admin-data-table')).toBeVisible({ timeout: 10000 });
  };

  test('type, status and auto-closed pills compute the same display/height/font-size/vertical-align', async ({ page }) => {
    await serve(page, [CLOSED]);
    await openAdmin(page);

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

  /**
   * Measured on the fix's own branch, and the reason this test asserts on the
   * LABEL rather than on the pill's box: the pill never moves. `td > *` caps a
   * cell's direct children at `max-width: 100%`, so a status pill whose label
   * is too long stays exactly as wide as its cell allows and the label's text
   * spills out of it. A test comparing the pill's box to the Type lozenge's
   * box therefore stays green with the truncation removed entirely (verified:
   * dropping `overflow`/`text-overflow` lets the label grow to its full
   * 147px inside a 92px pill, ~27px of text hanging off each end, and that
   * comparison still passes).
   *
   * A Range over the label's text node is no good either: Chrome reports the
   * UNCLIPPED text geometry (measured 147px of text inside a 70px label), so
   * the range extends past the pill even when the ellipsis is painting
   * correctly. What does hold is the clip itself: content of a box with
   * `overflow: hidden` cannot paint outside that box, so a label clip-box
   * inside the pill's box plus a live `overflow: hidden`/`text-overflow:
   * ellipsis` on an actually-overflowing label is the ink assertion.
   */
  test('a long "Published, not working" status label truncates inside its own pill', async ({ page }) => {
    await serve(page, [NOT_WORKING]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAdmin(page);

    const statusPill = page.locator('td.col-status .admin-study-status').first();
    await expect(statusPill).toHaveText(/published, not working/i);
    // Fails by name when the label span is unwrapped rather than by a
    // measurement that quietly reads the pill instead.
    await expect(page.locator('td.col-status .admin-study-status__label')).toHaveCount(1);
    // `elementsFromPoint` below takes VIEWPORT coordinates, and this row
    // sits well below the fold of a 900px-tall window: unscrolled, every
    // probe lands outside the viewport, returns an empty stack and the
    // hit-test can never fail (measured - it did exactly that).
    await statusPill.scrollIntoViewIfNeeded();

    const measured = await page.evaluate(() => {
      const pill = document.querySelector('td.col-status .admin-study-status') as HTMLElement | null;
      const label = document.querySelector('td.col-status .admin-study-status__label') as HTMLElement | null;
      const typeLozenge = document.querySelector('td.col-type .lozenge');
      if (!pill || !label || !typeLozenge) return null;
      const cs = getComputedStyle(label);
      const p = pill.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      const t = typeLozenge.getBoundingClientRect();
      // Chrome hit-tests the overflowing part of an unclipped inline text
      // run, so a point beyond the pill that resolves to the label means
      // the label's ink is painting out there. Measured with the clip
      // removed: the label box grows to its full 147px and reaches ~27px
      // past each end of the pill, which both probes below land inside.
      const probeY = (p.top + p.bottom) / 2;
      const hitsBeyondPill = [6, 16].some((dx) =>
        document
          .elementsFromPoint(p.right + dx, probeY)
          .some((el) => el === label || el.classList.contains('admin-study-status__label'))
      );
      return {
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
        scrollWidth: label.scrollWidth,
        clientWidth: label.clientWidth,
        labelLeft: l.left,
        labelRight: l.right,
        pillLeft: p.left,
        pillRight: p.right,
        hitsBeyondPill,
        // Measured on the LABEL, not the pill. The pill boxes are capped at
        // their cells (see the docblock above) so they never move, and a
        // pill-to-pill comparison therefore read 0 even with the clip removed
        // and the ink hanging ~27px off each end - a witness that could not
        // testify. The label's own box is the thing that grows.
        overlapWithType: Math.max(0, Math.min(l.right, t.right) - Math.max(l.left, t.left)),
      };
    });

    expect(measured).not.toBeNull();
    const m = measured!;

    // The clip that keeps the overflow inside the pill, and the ellipsis
    // that marks it as truncated rather than cut off.
    expect(m.overflowX).toBe('hidden');
    expect(m.overflowY).toBe('hidden');
    expect(m.textOverflow).toBe('ellipsis');
    expect(m.whiteSpace).toBe('nowrap');

    // The clip box itself sits inside the pill, so clipped ink cannot reach
    // the neighbouring columns.
    expect(m.labelLeft).toBeGreaterThanOrEqual(m.pillLeft - 0.5);
    expect(m.labelRight).toBeLessThanOrEqual(m.pillRight + 0.5);

    expect(m.hitsBeyondPill, "the label's own box is hit-testable beyond the pill's right edge - its ink is painting outside the pill").toBe(false);
    expect(m.overlapWithType).toBe(0);

    // Positive control, last because the assertions above name the defect
    // more precisely when they are the ones that break: without a real
    // overflow here every one of them is vacuous. Reads `${m.scrollWidth}px
    // of text in a ${m.clientWidth}px label` - if those are equal the
    // fixture stopped being the long label this test exists for, or the
    // label grew to fit its text and is no longer being clipped at all.
    expect(
      m.scrollWidth,
      `the label must overflow for this test to mean anything: ${m.scrollWidth}px of text in a ${m.clientWidth}px label`
    ).toBeGreaterThan(m.clientWidth + 1);
  });

  /**
   * The Status column's width is what decides whether "Auto-closed" fits its
   * own pill on one line: at 10% the text escapes its background, at 12% it
   * does not (measured 92px of pill for 81px of ink). Nothing but a source
   * string pin saw that before this test - and a string pin cannot see a
   * width the cascade overrides elsewhere.
   *
   * "Auto-closed" has no truncating inner span, so here the Range over its
   * text node IS the painted ink.
   */
  for (const width of [1240, 1440]) {
    test(`the "Auto-closed" marker's text ink stays inside its pill at ${width}px`, async ({ page }) => {
      await serve(page, [CLOSED]);
      await page.setViewportSize({ width, height: 900 });
      await openAdmin(page);

      await expect(page.locator('td.col-status .admin-pill--auto-closed')).toHaveCount(1);

      const measured = await page.evaluate(() => {
        const pill = document.querySelector('td.col-status .admin-pill--auto-closed') as HTMLElement | null;
        if (!pill) return null;
        const cell = pill.closest('td')!;
        const textNode = [...pill.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
        if (!textNode) return null;
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const ink = range.getBoundingClientRect();
        const p = pill.getBoundingClientRect();
        const c = cell.getBoundingClientRect();
        return {
          inkLeft: ink.left,
          inkRight: ink.right,
          inkWidth: ink.width,
          pillLeft: p.left,
          pillRight: p.right,
          pillHeight: p.height,
          cellLeft: c.left,
          cellRight: c.right,
        };
      });

      expect(measured).not.toBeNull();
      const m = measured!;

      // Positive control: a zero-width ink range would sit inside anything.
      expect(m.inkWidth).toBeGreaterThan(40);
      expect(m.inkLeft).toBeGreaterThanOrEqual(m.pillLeft - 0.5);
      expect(m.inkRight).toBeLessThanOrEqual(m.pillRight + 0.5);
      // One line, at the shared primitive's height.
      expect(m.pillHeight).toBeGreaterThan(23);
      expect(m.pillHeight).toBeLessThan(25);
      // And the pill itself inside its column.
      expect(m.pillLeft).toBeGreaterThanOrEqual(m.cellLeft - 0.5);
      expect(m.pillRight).toBeLessThanOrEqual(m.cellRight + 0.5);
    });
  }

  /**
   * Below 1220px the table reflows to cards (see the `max-width: 1219.98px`
   * block in `_components.css`) and the status pill and the "Auto-closed"
   * marker sit side by side on one line. `margin: 0` in the shared
   * primitive's own ancestor-scoped rule removed the gutter main had between
   * them: measured 0px, the two backgrounds touching.
   */
  test('the status pill and the auto-closed marker keep a gutter side by side at 1024px', async ({ page }) => {
    await serve(page, [CLOSED]);
    await page.setViewportSize({ width: 1024, height: 900 });
    await openAdmin(page);

    const measured = await page.evaluate(() => {
      const status = document.querySelector('td.col-status .admin-study-status');
      const autoClosed = document.querySelector('td.col-status .admin-pill--auto-closed');
      if (!status || !autoClosed) return null;
      const s = status.getBoundingClientRect();
      const a = autoClosed.getBoundingClientRect();
      return { gap: a.left - s.right, sameLine: Math.abs(a.top - s.top) < 1, sTop: s.top, aTop: a.top };
    });

    expect(measured).not.toBeNull();
    // Positive control: a gap measured between pills on two different lines
    // says nothing about the gutter.
    expect(measured!.sameLine).toBe(true);
    expect(measured!.gap).toBeGreaterThanOrEqual(3.5);
  });
});
