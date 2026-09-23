import { test, expect } from '@playwright/test';

/**
 * #142: the studies table's pills - the Type lozenge and the status pill -
 * share one box primitive (`.admin-pill`). Until admin table Step 1
 * (2026-09-23) the "Auto-closed" marker was a third pill stacked beside the
 * status pill; it is now plain muted text under the status pill, and Step 1
 * moved the Type lozenge out of its own column into the Study cell (the first
 * column), so the lozenge is located there. Table from 1024px up, cards below.
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

/**
 * A closed study renders the status pill AND the "Auto-closed" marker.
 * `auto_closed: true` since admin table Step 2: the caption is the server's
 * record of an automatic close (MR A), not every closed study.
 */
const CLOSED = study('Closed study', 'closed', { auto_closed: true });

/**
 * `isPublishedButNotWorking` resolves true for an external-delivery study
 * with no link, which is what renders `PUBLISHED_NOT_WORKING_LABEL`. That was
 * "Published, not working" - the one status label long enough to overflow the
 * fixed-width Status column - until #157 shortened it to "Broken", which fits.
 */
const NOT_WORKING = study('Question study', 'published', {
  delivery_mode: 'external',
  external_link_optional: null,
  meeting_location_optional: null,
});

/** The pre-#157 label, 147px in the pill's type - long enough to overflow it. */
const LONG_STATUS_LABEL = 'Published, not working';

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

  test('the type pill (in the Study cell) and the status pill compute the same display/height/font-size/vertical-align', async ({ page }) => {
    await serve(page, [CLOSED]);
    await openAdmin(page);

    // Positive control: fail here, not on a selector match count of zero
    // reading as "no misalignment found".
    const pillCount = await page.locator('td:first-child .lozenge, td.col-status .admin-study-status').count();
    expect(pillCount).toBe(2);

    const metrics = await page.evaluate(() => {
      const read = (el: Element) => {
        const cs = getComputedStyle(el);
        return {
          display: cs.display,
          parentDisplay: el.parentElement ? getComputedStyle(el.parentElement).display : '',
          height: el.getBoundingClientRect().height,
          fontSize: cs.fontSize,
          verticalAlign: cs.verticalAlign,
        };
      };
      const type = document.querySelector('td:first-child .lozenge');
      const status = document.querySelector('td.col-status .admin-study-status');
      return {
        type: type && read(type),
        status: status && read(status),
      };
    });

    expect(metrics.type).not.toBeNull();
    expect(metrics.status).not.toBeNull();

    for (const pill of [metrics.type, metrics.status] as const) {
      // A pill declared inline-flex is blockified to `flex` when its parent is
      // a flex container (CSS Display 3, "blockification of flex items") - the
      // type pill sits in the flex meta line under the title. The box is the
      // same; only an inline-flex pill in a non-flex parent, or a flex pill in
      // a non-flex parent, is a real drift.
      const parentIsFlex = /^(inline-)?flex$/.test(pill!.parentDisplay);
      expect(pill!.display).toBe(parentIsFlex ? 'flex' : 'inline-flex');
      expect(pill!.verticalAlign).toBe('middle');
      expect(pill!.height).toBeGreaterThan(23);
      expect(pill!.height).toBeLessThan(25);
    }
    expect(metrics.status!.fontSize).toBe(metrics.type!.fontSize);
  });

  /**
   * Step 1 (Mav 3.4): "Auto-closed" was a second pill stacked against the
   * status pill. It keeps its information but loses the box: plain muted
   * text, 12px / 400, no fill, no border, directly under the status pill.
   * Measured at both edges of the table band and a common desktop width.
   */
  for (const width of [1024, 1279, 1440]) {
    test(`the auto-closed marker is plain text under the status pill, not a second pill, at ${width}px`, async ({ page }) => {
      await serve(page, [CLOSED]);
      await page.setViewportSize({ width, height: 900 });
      await openAdmin(page);

      const marker = page.locator('td.col-status').getByText(/^auto-closed$/i);
      // Information is not lost: the marker still renders, once.
      await expect(marker).toHaveCount(1);

      const m = await marker.evaluate((el) => {
        const cs = getComputedStyle(el);
        const pill = el.closest('td')!.querySelector('.admin-study-status')!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const alpha = (css: string) => {
          const c = document.createElement('canvas').getContext('2d')!;
          c.fillStyle = css;
          c.fillRect(0, 0, 1, 1);
          return c.getImageData(0, 0, 1, 1).data[3];
        };
        return {
          fillAlpha: alpha(cs.backgroundColor),
          borders: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat),
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          gapBelowPill: r.top - pill.bottom,
        };
      });

      expect(m.fillAlpha, 'the auto-closed marker still paints a pill fill').toBe(0);
      expect(m.borders, 'the auto-closed marker still paints a pill border').toEqual([0, 0, 0, 0]);
      expect(m.fontSize).toBe('12px');
      expect(m.fontWeight).toBe('400');
      // Under the pill (not beside it), and close under it.
      expect(m.gapBelowPill).toBeGreaterThanOrEqual(-0.5);
      expect(m.gapBelowPill).toBeLessThanOrEqual(6);
    });
  }

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
   *
   * No shipped status label overflows since #157 ("Broken" fits), so this
   * test writes the old 147px label into the span itself: the clip is kept as
   * the guard for the next long label, and this is what proves it still holds.
   */
  // 1024 is the narrowest the table renders at since Step 1; 1440 a common desktop.
  for (const width of [1024, 1440]) {
    test(`a status label too long for its pill truncates inside it at ${width}px`, async ({ page }) => {
      await serve(page, [NOT_WORKING]);
      await page.setViewportSize({ width, height: 900 });
      await openAdmin(page);

      const statusPill = page.locator('td.col-status .admin-study-status').first();
      await expect(statusPill).toHaveText(/broken/i);
      // Fails by name when the label span is unwrapped rather than by a
      // measurement that quietly reads the pill instead.
      await expect(page.locator('td.col-status .admin-study-status__label')).toHaveCount(1);
      await page.evaluate((text) => {
        const label = document.querySelector('td.col-status .admin-study-status__label');
        if (label) label.textContent = text;
      }, LONG_STATUS_LABEL);
      // `elementsFromPoint` below takes VIEWPORT coordinates, and this row
      // sits well below the fold of a 900px-tall window: unscrolled, every
      // probe lands outside the viewport, returns an empty stack and the
      // hit-test can never fail (measured - it did exactly that).
      await statusPill.scrollIntoViewIfNeeded();

      const measured = await page.evaluate(() => {
        const pill = document.querySelector('td.col-status .admin-study-status') as HTMLElement | null;
        const label = document.querySelector('td.col-status .admin-study-status__label') as HTMLElement | null;
        const typeLozenge = document.querySelector('td:first-child .lozenge');
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
  }

  /**
   * #157: the published-but-broken label reads in full at every width the
   * table renders at. Since admin table Step 1 the table renders from 1024px
   * up (Status a fixed 128px column), so the widths are the AC9 set: both
   * edges of the 1024-1279 band, 1100, 1280 and 1440. When written (table
   * from 1220), measured "Broken" was 45px of
   * text where the pill leaves its label 53px beside the warning glyph, and
   * "Published, not working" was 147px and read "PUBLIS...". The pill's text
   * also carries a visually hidden "Published, " for a screen reader.
   */
  for (const width of [1024, 1100, 1219, 1280, 1440]) {
    test(`the "Broken" status label renders in full inside its pill at ${width}px`, async ({ page }) => {
      await serve(page, [NOT_WORKING]);
      await page.setViewportSize({ width, height: 900 });
      await openAdmin(page);

      const statusPill = page.locator('td.col-status .admin-study-status').first();
      await expect(statusPill).toHaveText(/^\s*published,\s+broken\s*$/i);
      await expect(page.locator('td.col-status .admin-study-status__label')).toHaveCount(1);

      const measure = () =>
        page.evaluate(() => {
          const pill = document.querySelector('td.col-status .admin-study-status');
          const label = document.querySelector('td.col-status .admin-study-status__label') as HTMLElement | null;
          const typeLozenge = document.querySelector('td:first-child .lozenge');
          if (!pill || !label || !typeLozenge) return null;
          const p = pill.getBoundingClientRect();
          const l = label.getBoundingClientRect();
          const t = typeLozenge.getBoundingClientRect();
          return {
            scrollWidth: label.scrollWidth,
            clientWidth: label.clientWidth,
            insidePill: l.left >= p.left - 0.5 && l.right <= p.right + 0.5,
            overlapWithType: Math.max(0, Math.min(l.right, t.right) - Math.max(l.left, t.left)),
          };
        });

      const m = await measure();
      expect(m).not.toBeNull();
      expect(
        m!.scrollWidth,
        `"Broken" is truncated: ${m!.scrollWidth}px of text in a ${m!.clientWidth}px label`
      ).toBeLessThanOrEqual(m!.clientWidth);
      expect(m!.insidePill).toBe(true);
      expect(m!.overlapWithType).toBe(0);

      // Control: the same instrument, on the same label, does see a
      // truncation when there is one - so "fits" above is a measurement,
      // not a probe that can only ever read equal.
      await page.evaluate((text) => {
        const label = document.querySelector('td.col-status .admin-study-status__label');
        if (label) label.textContent = text;
      }, LONG_STATUS_LABEL);
      const control = await measure();
      expect(control!.scrollWidth, 'the control label must overflow').toBeGreaterThan(control!.clientWidth + 1);
    });
  }

  /**
   * The Status column's width is what decides whether "Auto-closed" fits on
   * one line: at 10% the text escaped its background, at 12% it did not
   * (measured 92px of pill for 81px of ink). Nothing but a source string pin
   * saw that before this test - and a string pin cannot see a width the
   * cascade overrides elsewhere.
   *
   * Since Step 1 the marker is plain text with no box of its own, so what is
   * guarded is its ink: inside its own element, inside the Status cell's
   * content box (not spilling into Progress), and on ONE line. It has no
   * truncating inner span, so the Range over its text node IS the painted
   * ink. Widths are the AC9 set.
   */
  for (const width of [1024, 1100, 1219, 1280, 1440]) {
    test(`the "Auto-closed" marker's text ink stays inside its Status cell on one line at ${width}px`, async ({ page }) => {
      await serve(page, [CLOSED]);
      await page.setViewportSize({ width, height: 900 });
      await openAdmin(page);

      await expect(page.locator('td.col-status').getByText(/^auto-closed$/i)).toHaveCount(1);

      const measured = await page.evaluate(() => {
        const marker = [...document.querySelectorAll('td.col-status *')].find((el) =>
          [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && /^auto-closed$/i.test(n.textContent!.trim()))
        ) as HTMLElement | undefined;
        if (!marker) return null;
        const cell = marker.closest('td')!;
        const textNode = [...marker.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
        if (!textNode) return null;
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const ink = range.getBoundingClientRect();
        const lineTops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
        const own = marker.getBoundingClientRect();
        const c = cell.getBoundingClientRect();
        const cs = getComputedStyle(cell);
        return {
          inkLeft: ink.left,
          inkRight: ink.right,
          inkWidth: ink.width,
          ownLeft: own.left,
          ownRight: own.right,
          lines: lineTops.size,
          cellContentLeft: c.left + parseFloat(cs.paddingLeft),
          cellContentRight: c.right - parseFloat(cs.paddingRight),
        };
      });

      expect(measured).not.toBeNull();
      const m = measured!;

      // Positive control: a zero-width ink range would sit inside anything.
      expect(m.inkWidth).toBeGreaterThan(40);
      expect(m.inkLeft).toBeGreaterThanOrEqual(m.ownLeft - 0.5);
      expect(m.inkRight).toBeLessThanOrEqual(m.ownRight + 0.5);
      // One line.
      expect(m.lines, '"Auto-closed" wraps').toBe(1);
      // And the ink inside its column.
      expect(m.inkLeft).toBeGreaterThanOrEqual(m.cellContentLeft - 0.5);
      expect(m.inkRight).toBeLessThanOrEqual(m.cellContentRight + 0.5);
    });
  }

  /**
   * The status pill and the "Auto-closed" marker must never touch. On main
   * they sat side by side in the card view with a 3.5px gutter (`margin: 0`
   * in the shared primitive's own ancestor-scoped rule had once removed it:
   * measured 0px, the two backgrounds touching). Step 1 puts the marker
   * directly under the pill in the table; the card view (below 1024, see the
   * `max-width: 1023.98px` block in `_components.css`) is "unchanged for
   * today", so at 1023 either arrangement passes as long as there is a gap.
   */
  const pillAndMarker = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const status = document.querySelector('td.col-status .admin-study-status');
      const autoClosed = [...document.querySelectorAll('td.col-status *')].find((el) =>
        /^auto-closed$/i.test((el.textContent ?? '').trim())
      );
      if (!status || !autoClosed) return null;
      const s = status.getBoundingClientRect();
      const a = autoClosed.getBoundingClientRect();
      return {
        sideGap: a.left - s.right,
        belowGap: a.top - s.bottom,
        sameLine: Math.abs(a.top - s.top) < 1,
      };
    });

  test('the status pill and the auto-closed marker keep a gutter in the card view at 1023px', async ({ page }) => {
    await serve(page, [CLOSED]);
    await page.setViewportSize({ width: 1023, height: 900 });
    await openAdmin(page);

    const m = await pillAndMarker(page);
    expect(m).not.toBeNull();
    // Side by side with a gutter, or stacked with a gap; never touching.
    if (m!.sameLine) expect(m!.sideGap).toBeGreaterThanOrEqual(3.5);
    else expect(m!.belowGap).toBeGreaterThanOrEqual(1);
  });

  test('the auto-closed marker sits under the status pill, not beside it, at 1024px', async ({ page }) => {
    await serve(page, [CLOSED]);
    await page.setViewportSize({ width: 1024, height: 900 });
    await openAdmin(page);

    const m = await pillAndMarker(page);
    expect(m).not.toBeNull();
    expect(m!.sameLine, 'the marker is beside the pill, not under it').toBe(false);
    expect(m!.belowGap).toBeGreaterThanOrEqual(1);
    expect(m!.belowGap).toBeLessThanOrEqual(6);
  });

  /**
   * The row menu's trigger is an icon-only button, so an icon squeezed to 0px
   * leaves an empty outlined box with nothing saying it is a menu. That is what
   * the Actions column did at 11%: 83px of cell for ~102px of View plus kebab,
   * and the kebab's flex-shrink took the difference out of its icon. The box
   * never looked broken to a box comparison - it measured the button, not the
   * icon - so this measures the icon's painted width.
   */
  // Widths: 1024 and 1240 are the 1024-1279 band (Created hidden), 1280 the
  // narrowest full table, 1440 a common desktop. Actions is a fixed 120px.
  for (const [width, font] of [
    [1024, 'web'],
    [1240, 'web'],
    [1280, 'web'],
    [1440, 'web'],
    [1024, 'fallback'],
    [1240, 'fallback'],
    [1280, 'fallback'],
    [1440, 'fallback'],
  ] as const) {
    test(`the row menu's icon paints and the actions fit their cell at ${width}px on the ${font} font`, async ({ page }) => {
      if (font === 'fallback') {
        // What a runner without egress to Google Fonts renders.
        await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
      }
      await serve(page, [CLOSED]);
      await page.setViewportSize({ width, height: 900 });
      await openAdmin(page);

      const kebab = page.locator('td.col-actions .admin-action-btn-kebab');
      await expect(kebab).toHaveCount(1);
      // Measured on the web font. The group's width is text width, and the
      // fallback font is wider - the same layout fitted by 0.1px on Manrope
      // and overflowed by 1.1px without it. The test below runs this again
      // with the font blocked.
      await page.evaluate(() => document.fonts.ready);
      await kebab.scrollIntoViewIfNeeded();

      const m = await kebab.evaluate((button) => {
        const icon = button.querySelector('svg');
        const cell = button.closest('td')!;
        const c = cell.getBoundingClientRect();
        const cs = getComputedStyle(cell);
        // The BUTTONS' edges, not the action group's: the group is capped at
        // the cell by `max-width: 100%`, so a button overflowing it leaves the
        // group's own box where it was (measured - asserting on the group
        // passed with the column back at 11%). And BOTH edges: the group is
        // centred, so an overflow splits and half of it goes left, into the
        // Created column. The row's action is a link since Step 2's fix round
        // (it opens a page, so a modifier-click opens a tab); it and the
        // kebab button are the two controls, whatever their tags.
        const buttons = [...cell.querySelectorAll('.admin-action-primary, .admin-action-btn-kebab')].map((b) =>
          b.getBoundingClientRect()
        );
        return {
          iconWidth: icon ? icon.getBoundingClientRect().width : -1,
          buttonWidth: button.getBoundingClientRect().width,
          buttonCount: buttons.length,
          leftmost: Math.min(...buttons.map((r) => r.left)),
          rightmost: Math.max(...buttons.map((r) => r.right)),
          cellContentLeft: c.left + parseFloat(cs.paddingLeft),
          cellContentRight: c.right - parseFloat(cs.paddingRight),
        };
      });

      // Control first: the button itself has always had a box, which is why
      // nothing noticed. The icon inside it is the thing that vanished.
      expect(m.buttonWidth).toBeGreaterThan(20);
      expect(m.iconWidth, 'the kebab icon is squeezed to nothing - the row menu renders as an empty box').toBeGreaterThanOrEqual(14);
      // No tolerance: the fix gives the pair several pixels of slack, and a
      // half-pixel allowance is exactly what hid a pair that fitted by 0.1px.
      expect(m.buttonCount, "the row state's action (Step 2: Fix / Edit / Analytics / Preview) and the kebab").toBe(2);
      expect(m.rightmost, 'the row actions overflow the Actions cell on the right').toBeLessThanOrEqual(m.cellContentRight);
      expect(m.leftmost, 'the row actions overflow the Actions cell on the left').toBeGreaterThanOrEqual(m.cellContentLeft);
      // Slack, not a fit by a fraction of a pixel.
      expect(m.cellContentRight - m.rightmost + (m.leftmost - m.cellContentLeft), 'the row actions fit with under 3px to spare').toBeGreaterThanOrEqual(3);
    });
  }

  /**
   * #149: a published study that is not working must read as broken without
   * relying on its label. When this was written the label ("Published, not
   * working") truncated above 1220px, so the word could not be the mark; the
   * mark is an amber fill plus a warning glyph that sits outside the label.
   * Since #157 the label is "Broken" and fits in full. The fill and glyph are
   * the Draft pill's, so "published" is carried by a visually hidden prefix
   * and the label's `title` instead.
   *
   * Asserted in a real browser because #142's lesson was that a source-pin
   * guard stayed green through the real defect. Every property here is a
   * rendered outcome: the glyph's painted box and hit-test, the computed fill
   * against a healthy published pill, and contrast read off the pill's
   * screenshot pixels rather than from declared CSS.
   */
  test.describe('a published study that is not working is marked beyond its label (#149)', () => {
    /** Published and ready: an external poll with a link. The control row. */
    /** The draft pill carries the amber the broken pill is meant to share. */
    const DRAFT = study('Draft study', 'draft');

    const HEALTHY = study('Healthy study', 'published', {
      type: 'poll',
      delivery_mode: 'external',
      external_link_optional: 'https://example.com/poll',
    });

    /** WCAG relative luminance of an sRGB triple, 0-255 per channel. */
    const luminance = ([r, g, b]: number[]) => {
      const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrast = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    for (const theme of ['light', 'dark'] as const) {
      for (const width of [1024, 1240, 1440]) {
        test(`the not-working pill shows its warning glyph and amber fill in ${theme} at ${width}px`, async ({ page }) => {
          await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
          await serve(page, [NOT_WORKING, HEALTHY, DRAFT]);
          await page.setViewportSize({ width, height: 900 });
          await openAdmin(page);
          await expect(page.locator(`body.theme-${theme}`)).toHaveCount(1);

          const broken = page.locator('td.col-status .admin-study-status--not-working');
          await expect(broken).toHaveCount(1);
          await broken.scrollIntoViewIfNeeded();

          const measured = await page.evaluate(() => {
            const pills = [...document.querySelectorAll('td.col-status .admin-study-status')] as HTMLElement[];
            const brokenPill = pills.find((p) => p.classList.contains('admin-study-status--not-working'));
            const healthyPill = pills.find(
              (p) => p.classList.contains('admin-study-status--published') && !p.classList.contains('admin-study-status--not-working')
            );
            const draftPill = pills.find((p) => p.classList.contains('admin-study-status--draft'));
            if (!draftPill) return null;
            if (!brokenPill || !healthyPill) return null;
            const glyph = brokenPill.querySelector('.admin-study-status__glyph');
            const label = brokenPill.querySelector('.admin-study-status__label') as HTMLElement | null;
            const p = brokenPill.getBoundingClientRect();
            const g = glyph?.getBoundingClientRect();
            const l = label?.getBoundingClientRect();
            const hit = g ? document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2) : null;
            return {
              glyphCount: brokenPill.querySelectorAll('.admin-study-status__glyph').length,
              healthyGlyphCount: healthyPill.querySelectorAll('.admin-study-status__glyph').length,
              glyph: g && { left: g.left, right: g.right, top: g.top, bottom: g.bottom, width: g.width, height: g.height },
              pill: { left: p.left, right: p.right, top: p.top, bottom: p.bottom, height: p.height },
              glyphHit: Boolean(hit && glyph && (hit === glyph || glyph.contains(hit))),
              labelTruncated: label ? label.scrollWidth > label.clientWidth + 1 : null,
              brokenFill: getComputedStyle(brokenPill).backgroundColor,
              healthyFill: getComputedStyle(healthyPill).backgroundColor,
              draftFill: getComputedStyle(draftPill).backgroundColor,
              // The ink regions, relative to the pill, for the pixel sampling
              // below: the glyph's box and the label's box and nothing else.
              inkRects: [g, l]
                .filter((r): r is DOMRect => Boolean(r))
                .map((r) => ({ x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height })),
            };
          });

          expect(measured).not.toBeNull();
          const m = measured!;

          // The glyph exists on the broken row only. The healthy row is the
          // control: a glyph on every published pill would mark nothing.
          expect(m.glyphCount, 'the not-working pill has lost its warning glyph').toBe(1);
          expect(m.healthyGlyphCount).toBe(0);

          // It PAINTS: a real box, inside the pill, and on top at its centre -
          // not clipped away by the pill or collapsed by the flex row.
          expect(m.glyph).not.toBeNull();
          expect(m.glyph!.width, 'the glyph has collapsed').toBeGreaterThanOrEqual(12);
          expect(m.glyph!.height, 'the glyph has collapsed').toBeGreaterThanOrEqual(12);
          expect(m.glyph!.left).toBeGreaterThanOrEqual(m.pill.left - 0.5);
          expect(m.glyph!.right).toBeLessThanOrEqual(m.pill.right + 0.5);
          expect(m.glyph!.top).toBeGreaterThanOrEqual(m.pill.top - 0.5);
          expect(m.glyph!.bottom).toBeLessThanOrEqual(m.pill.bottom + 0.5);
          expect(m.glyphHit, 'the glyph is covered or clipped at its own centre').toBe(true);

          // The shared primitive's height is unchanged by the glyph.
          expect(m.pill.height).toBeGreaterThan(23);
          expect(m.pill.height).toBeLessThan(25);

          // Colour as well as the glyph: the draft pill's amber, and so not
          // the healthy published pill's green. Equal to the draft fill rather
          // than merely "not green", which any other colour would satisfy.
          expect(m.brokenFill, 'the broken pill has lost its amber fill').toBe(m.draftFill);
          expect(m.brokenFill).not.toBe(m.healthyFill);

          // RENDERED CONTRAST, from the pill's own pixels. The fill is the
          // commonest colour in the screenshot; the ink is the pixel furthest
          // from it in luminance (the cores of bold text and a 2px stroke
          // reach the full colour; anti-aliased edges only sit between).
          const shot = await broken.screenshot({ animations: 'disabled' });
          const pixels = await page.evaluate(async ({ b64, rects }) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, img.width, img.height).data;
            // ONLY inside the glyph's and the label's own boxes. Sampling the
            // whole pill let the rounded BORDER stand in for the ink: with the
            // text failing AA and a black border, the check passed (measured).
            // Inside these boxes there is only fill and ink.
            const scale = img.width / rects.pillWidth;
            const out: number[][] = [];
            for (const r of rects.boxes) {
              const x0 = Math.max(0, Math.ceil(r.x * scale));
              const y0 = Math.max(0, Math.ceil(r.y * scale));
              const x1 = Math.min(img.width, Math.floor((r.x + r.w) * scale));
              const y1 = Math.min(img.height, Math.floor((r.y + r.h) * scale));
              for (let y = y0; y < y1; y += 1) {
                for (let x = x0; x < x1; x += 1) {
                  const i = (y * img.width + x) * 4;
                  out.push([data[i], data[i + 1], data[i + 2]]);
                }
              }
            }
            return out;
          }, {
            b64: shot.toString('base64'),
            rects: { pillWidth: m.pill.right - m.pill.left, boxes: m.inkRects },
          });

          const counts = new Map<string, number>();
          for (const px of pixels) counts.set(px.join(','), (counts.get(px.join(',')) ?? 0) + 1);
          const fill = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
          const fillL = luminance(fill);
          const ink = pixels.reduce((best, px) =>
            Math.abs(luminance(px) - fillL) > Math.abs(luminance(best) - fillL) ? px : best
          );

          // Positive control: a pill with no ink would score 1:1 and fail
          // below anyway, but this names that case.
          expect(pixels.length).toBeGreaterThan(200);
          expect(
            contrast(ink, fill),
            `rendered ink rgb(${ink}) on fill rgb(${fill}) in ${theme} at ${width}px`
          ).toBeGreaterThanOrEqual(4.5);

          // #157: the label no longer truncates at any width the table renders
          // at, so the word and the glyph now both read. The "Broken" test
          // above carries the control proving this instrument sees a
          // truncation when there is one.
          expect(m.labelTruncated, 'the not-working label is truncated again').toBe(false);
        });
      }
    }
  });
});
