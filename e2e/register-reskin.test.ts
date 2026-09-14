import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PARTICIPANT_E2E_ENABLED, loginAsParticipant } from './helpers/participant-recording';

/**
 * Decision 4/5 (Lane H): one light ground, the recording register's cream
 * promoted to the light theme and given a dark half, orange primary in both
 * themes. Paths are relative so `use.baseURL` decides the target, per the
 * other specs here.
 */

const outputsFixture = {
  contract_version: '1',
  session: {
    session_id: 'session-1',
    logical_session_id: 'session_1',
    attempt_number: 1,
    study_id: 'opp-1',
    study_title: 'Register reskin fixture study',
    participant: { participant_id: 'user-1', display_name: 'Demo User' },
    session_status: 'completed',
    started_at: '2026-09-13T13:34:00.000Z',
    completed_at: '2026-09-13T13:40:00.000Z',
    transcript_status: 'not_requested',
    transcript_failure_message: null,
  },
  attempts: [
    {
      attempt_number: 1,
      session_id: 'session-1',
      session_status: 'completed',
      started_at: '2026-09-13T13:34:00.000Z',
      completed_at: '2026-09-13T13:40:00.000Z',
      transcript_status: 'not_requested',
    },
  ],
  steps: [
    {
      step_id: 'step-1',
      order: 1,
      type: 'single_choice',
      prompt: 'How often should we ship to the Marketplace?',
      response: { text: null, selected_option: 'Weekly', saved_at: '2026-09-13T13:35:00.000Z' },
    },
  ],
  transcript: null,
  assets: [],
};

const mockSessionReview = async (page: import('@playwright/test').Page) => {
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
        role_title: 'Researcher',
      }),
    });
  });
  await page.route('**/api/opportunities/opp-1/sessions/session-1/outputs*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(outputsFixture) });
  });
  await page.route('**/api/opportunities/opp-1/session-events', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
};

interface AxeNode {
  target: unknown[];
  html?: string;
  any?: { message?: string }[];
}
interface AxeViolation {
  id: string;
  nodes: AxeNode[];
}

/** Relative luminance and WCAG contrast ratio - the same formula axe itself
 * uses, run here by hand for a node axe declined to measure. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * Direct measurement for the one node axe's gradient-flattening gap (see
 * expectContrastActuallyMeasured below) leaves genuinely unmeasured: composes
 * the actual rendered colours (read from the page, not guessed) the way axe
 * would if it could see through `.App`'s gradient background-image, so this
 * does not silently trust an "it looked fine in a screenshot" judgement call.
 */
async function expectNoDataParagraphMeasuresAA(page: import('@playwright/test').Page, label: string): Promise<void> {
  const parseRgb = (css: string): [number, number, number] | null => {
    const m = css.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const measured = await page.evaluate(() => {
    const p = document.querySelector('.cortex-no-data p, .session-review-page .cortex-no-data');
    const card = document.querySelector('.session-review-page .cortex-analytics-card');
    const app = document.querySelector('.App');
    if (!p || !card || !app) return null;
    const textColor = getComputedStyle(p).color;
    const cardBg = getComputedStyle(card).backgroundColor;
    // .App's own background-image gradient - its first stop is the
    // representative page ground colour behind a card near the top of the
    // document, which .cortex-no-data is.
    const appGradient = getComputedStyle(app).backgroundImage;
    const stopMatch = appGradient.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
    return { textColor, cardBg, appStop: stopMatch ? stopMatch[0] : null };
  });
  if (!measured || !measured.appStop) {
    throw new Error(`${label}: could not read the elements needed to measure .cortex-no-data p directly`);
  }
  const text = parseRgb(measured.textColor);
  const card = parseRgb(measured.cardBg) ?? [0, 0, 0];
  const cardAlphaMatch = measured.cardBg.match(/,\s*([\d.]+)\)$/);
  const cardAlpha = cardAlphaMatch ? Number(cardAlphaMatch[1]) : 1;
  const appBg = parseRgb(measured.appStop);
  if (!text || !appBg) {
    throw new Error(`${label}: could not parse colours from "${measured.textColor}" / "${measured.appStop}"`);
  }
  const composited: [number, number, number] = [0, 1, 2].map(
    (i) => card[i] * cardAlpha + appBg[i] * (1 - cardAlpha)
  ) as [number, number, number];
  const ratio = contrastRatio(text, composited);
  expect(ratio, `${label}: .cortex-no-data text ${measured.textColor} on composited ${JSON.stringify(composited)} must clear AA (4.5:1)`).toBeGreaterThanOrEqual(4.5);
}

test.describe('Session Review page - register re-skin (Decision 4)', () => {
  /**
   * SessionReview's own heading structure (an <h1> page title followed
   * directly by SessionSummaryCard's <h5>) skips levels regardless of theme -
   * a pre-existing structural gap in a component-logic file this lane does
   * not own (session-review/*.tsx is Lane D's), not something Decision 4
   * introduced or can fix from a styles-only pass. Named to the exact node
   * rather than excluding the whole rule id, so a heading-order fault
   * anywhere else on this page this lane DOES cause still fails (code-reviewer
   * finding: filtering the bare rule id was too wide).
   */
  const isPreExistingHeadingOrder = (v: AxeViolation) =>
    v.id === 'heading-order' &&
    v.nodes.every((n) => (n.html ?? '').includes('cortex-chart-title'));

  /**
   * axe puts a node it cannot compute a background for into `incomplete`, not
   * `violations` - `expectBookingContrastActuallyMeasured` in
   * accessibility.test.ts exists because a real failure hid there once
   * already on this same app, and the instinct to check this bucket here is
   * the same (code-reviewer finding).
   *
   * What is actually IN this bucket on this page is different from that
   * precedent, though: every reason given is "background color could not be
   * determined due to a background gradient" - `.App`'s own
   * --bg-app-gradient-top/bottom (defined in _themes.css, owned by this
   * lane's ground work but pre-existing on every light-theme page, not new
   * here), with nothing opaque between it and any translucent card on this
   * route to flatten through. That is a structural gap in
   * .analytics-page-wrapper's own light-mode stacking this page inherits
   * from OpportunityAnalytics, not something Decision 4 introduced - this is
   * the first axe coverage this page has ever had. Verified NOT a real
   * failure below by compositing the actual computed colours by hand
   * (measured 5.24:1 for .cortex-no-data p, the specific node this lane's
   * own specificity fix targets); logged, not hard-failed, so a genuinely
   * NEW reason for a node landing here still shows up for a human to read.
   */
  const expectContrastActuallyMeasured = (
    results: { incomplete: AxeViolation[] },
    label: string
  ): void => {
    const deferred = results.incomplete
      .filter((rule) => rule.id === 'color-contrast')
      .flatMap((rule) =>
        rule.nodes.map((node) => ({
          target: node.target.map(String).join(' '),
          reason: (node.any ?? []).map((c: { message?: string }) => c.message).join('; '),
        }))
      )
      .filter((n) => /cortex-|session-review-page/.test(n.target));
    // `.cortex-no-data > p` sits alongside `.empty-icon` (a pre-existing,
    // absolutely-positioned sibling in _components.css, nothing this lane
    // touches) which axe's overlap heuristic reads as covering the text -
    // the same false-overlap shape the codebase's own precedent for this
    // bucket already names for a different element. Directly measured by
    // expectNoDataParagraphMeasuresAA above rather than trusted blind.
    const isKnownGap = (n: { target: string; reason: string }) =>
      /background gradient/.test(n.reason) ||
      (n.target === '.cortex-no-data > p' && /overlapped by another element/.test(n.reason));
    const unexplained = deferred.filter((n) => !isKnownGap(n));
    if (deferred.length > 0) {
      console.log(
        `\n${label}: axe declined to measure ${deferred.length} register node(s) (gradient-flattening gap, see comment above)\n  ${deferred.map((n) => n.target).join('\n  ')}\n`
      );
    }
    expect(unexplained, 'a node deferred for a reason OTHER than the known gradient gap').toEqual([]);
  };

  test('carries the register look and is accessible in light mode', async ({ page }) => {
    await mockSessionReview(page);
    await page.goto('/admin/opportunities/opp-1/sessions/session-1/review');
    await page.waitForLoadState('load');
    // The card-mount transition (.cortex-analytics-card's `transition:
    // transform 0.2s, box-shadow 0.25s...`) leaves nearly every node
    // mid-transition at `load`, and axe defers colour-contrast on anything
    // still animating - settle before scanning, same wait the rest of this
    // suite uses.
    await page.waitForTimeout(500);
    await expect(page.locator('.session-review-page')).toHaveCount(1);
    await expect(page.locator('.cortex-analytics-card').first()).toBeVisible();

    // Pinned: the card reads as the register's flat, hairline-bordered card,
    // not the generic Sci-Fi-glass card OpportunityAnalytics still uses -
    // proves the .session-review-page scope actually applied, not just that
    // the page rendered.
    const card = page.locator('.cortex-analytics-card').first();
    const boxShadow = await card.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow, 'register card must not carry the analytics glass shadow').toBe('none');

    await expectNoDataParagraphMeasuresAA(page, 'light');

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => !isPreExistingHeadingOrder(v))).toEqual([]);
    expectContrastActuallyMeasured(results, 'Session Review (light)');
  });

  test('carries the register look and is accessible in dark mode', async ({ page }) => {
    await mockSessionReview(page);
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/admin/opportunities/opp-1/sessions/session-1/review');
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    await expect(page.locator('body.theme-dark')).toHaveCount(1);
    await expect(page.locator('.session-review-page')).toHaveCount(1);

    await expectNoDataParagraphMeasuresAA(page, 'dark');

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => !isPreExistingHeadingOrder(v))).toEqual([]);
    expectContrastActuallyMeasured(results, 'Session Review (dark)');
  });

  test('does not leak into OpportunityAnalytics, which shares the same card classes', async ({ page }) => {
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
          role_title: 'Researcher',
        }),
      });
    });
    await page.route('**/api/opportunities/opp-1/analytics*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          views: { total: 0, unique: 0, by_period: [] },
          actions: { total: 0, by_period: [] },
          conversion_rate: 0,
        }),
      });
    });
    await page.route('**/api/opportunities/opp-1*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'opp-1', title: 'Fixture study', type: 'poll', status: 'published' }),
      });
    });
    await page.goto('/admin/opportunities/opp-1/analytics');
    await page.waitForLoadState('load');
    await expect(page.locator('.session-review-page')).toHaveCount(0);

    // The marker's absence alone would pass even if the scoping rules were
    // deleted outright - this is the actual positive control (code-reviewer
    // finding): Analytics must still carry its own glass shadow, which the
    // register re-skin explicitly zeroes out on session-review-page.
    const shadow = await page
      .locator('.cortex-analytics-card')
      .first()
      .evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow, 'Analytics must keep its own glass shadow, not the register\'s flat card').not.toBe('none');
  });
});

test.describe('One light ground (Decision 4): study listing page', () => {
  test('sits on the standard cream --bg-app, not a bespoke surface', async ({ page }) => {
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
          role_title: 'Developer',
        }),
      });
    });
    await page.route('**/api/opportunities**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.goto('/');
    await page.waitForLoadState('load');

    const listing = page.locator('.study-listing-page');
    await expect(listing).toBeVisible();
    const bg = await listing.evaluate((el) => getComputedStyle(el).backgroundColor);
    const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
    // Pinned: the old --surface-page-study-listing carved out #f8fafc (a cool
    // grey), rgb(248, 250, 252) - distinct from the cream body ground. That
    // token and its rules are gone; the listing page now shows through to the
    // same cream body paints everywhere else in light theme.
    expect(bg, 'study-listing-page must not paint its own background over the cream body').toBe('rgba(0, 0, 0, 0)');
    expect(bodyBg).not.toBe('rgb(248, 250, 252)');
  });
});

test.describe('Orange primary in both themes (Decision 5)', () => {
  test('--cta-bg resolves orange, not navy ink, in light theme', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const isDark = await page.locator('body').evaluate((el) => el.classList.contains('theme-dark'));
    if (isDark) {
      await page.getByRole('button', { name: /Switch to light mode/i }).click();
      await expect(page.locator('body')).toHaveClass(/theme-light/, { timeout: 5000 });
    }
    const ctaBg = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--cta-bg').trim());
    // Pinned: was var(--fs-ink), #14213d (navy). Now the light-safe orange
    // fill, #BF4417 (--accent-fill-on-light / --brand-orange-700).
    expect(ctaBg.toLowerCase()).toBe('#bf4417');
  });

  /**
   * recording-session.css is a lazy chunk that only registers once
   * ParticipantSessionFlow itself has actually rendered - a probe on any
   * other route, or on this route's own "session unavailable" state (a
   * lighter component that does not import it), reads an empty custom
   * property, not a wrong one. Needs a real, DB-backed session token, so it
   * follows the same gate as the rest of the participant recording e2e
   * suite - skipped unless FIRSTHAND_PARTICIPANT_E2E=1 - but mints its own
   * token rather than also requiring a pre-seeded FIRSTHAND_E2E_SESSION_TOKEN,
   * since sessions expire and this only needs the flow to mount, not to
   * complete a real recording.
   */
  test('.fh-recording --accent resolves the one brand orange, not its old terracotta', async ({ page, baseURL }) => {
    test.skip(!PARTICIPANT_E2E_ENABLED, 'Set FIRSTHAND_PARTICIPANT_E2E=1 to run against a real local backend.');

    // A fresh Playwright context carries no localStorage, so ThemeContext
    // falls back to light - the register's dark half (this test's whole
    // point, code-reviewer HIGH finding) would go untested without this.
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await loginAsParticipant(page);
    const mint = await page.request.post(
      `${baseURL}/api/opportunities/0aa00001-0000-4000-8000-00000000000c/recorded-study-session`,
      { headers: { 'Content-Type': 'application/json' } }
    );
    expect(mint.ok(), 'minting a recorded-study session token').toBeTruthy();
    const { session_url } = await mint.json();

    await page.goto(session_url);
    await expect(page.locator('.fh-recording').first()).toBeVisible();
    const style = await page
      .locator('.fh-recording')
      .first()
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { accent: cs.getPropertyValue('--accent').trim(), accentText: cs.getPropertyValue('--accent-text').trim(), bg: cs.getPropertyValue('--bg').trim() };
      });
    // Pinned: was the literal #dd6e42 (terracotta), a different hue from the
    // rest of the brand. Now var(--brand-orange-500), #FF5A1F - resolved.
    expect(style.accent.toLowerCase()).toBe('#ff5a1f');

    // code-reviewer HIGH finding: --accent-strong (a fill-safe token) was
    // being read as text colour on this surface, measuring 3.41:1 in dark -
    // below AA. --accent-text is the split-out text role; pin it AND prove
    // it actually clears AA against the register ground it is read on,
    // rather than only pinning the hex (a hex pin alone would not have
    // caught the original bug - the wrong TOKEN was AA-safe too, just for a
    // different background).
    const parseHex = (hex: string): [number, number, number] => {
      const h = hex.replace('#', '');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };
    const ratio = contrastRatio(parseHex(style.accentText), parseHex(style.bg));
    expect(ratio, `--accent-text ${style.accentText} on --bg ${style.bg} must clear AA (4.5:1)`).toBeGreaterThanOrEqual(4.5);
  });
});
