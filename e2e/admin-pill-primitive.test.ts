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

  /**
   * The row menu's trigger is an icon-only button, so an icon squeezed to 0px
   * leaves an empty outlined box with nothing saying it is a menu. That is what
   * the Actions column did at 11%: 83px of cell for ~102px of View plus kebab,
   * and the kebab's flex-shrink took the difference out of its icon. The box
   * never looked broken to a box comparison - it measured the button, not the
   * icon - so this measures the icon's painted width.
   */
  for (const [width, font] of [[1240, 'web'], [1440, 'web'], [1240, 'fallback'], [1440, 'fallback']] as const) {
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
        // Created column.
        const buttons = [...cell.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
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
      expect(m.buttonCount, 'View and the kebab').toBe(2);
      expect(m.rightmost, 'the row actions overflow the Actions cell on the right').toBeLessThanOrEqual(m.cellContentRight);
      expect(m.leftmost, 'the row actions overflow the Actions cell on the left').toBeGreaterThanOrEqual(m.cellContentLeft);
      // Slack, not a fit by a fraction of a pixel.
      expect(m.cellContentRight - m.rightmost + (m.leftmost - m.cellContentLeft), 'the row actions fit with under 3px to spare').toBeGreaterThanOrEqual(3);
    });
  }

  /**
   * #149: a published study that is not working must read as broken without
   * relying on its label. Above 1220px the label truncates to PUBLISHED
   * followed by an ellipsis - the word is not the mark - so the mark is an
   * amber fill plus a warning glyph that sits outside the truncating label.
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
      for (const width of [1240, 1440]) {
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

          // The case #149 exists for: at 1440 the label really is truncated,
          // so the glyph is doing the work the word cannot.
          if (width === 1440) expect(m.labelTruncated).toBe(true);
        });
      }
    }
  });
});
