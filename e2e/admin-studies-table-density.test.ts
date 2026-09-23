import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  THEMES,
  SEEDED_STUDY_COUNT,
  SEEDED_STUDIES,
  contrastRatio,
  expectNoUnmockedCalls,
  openAdminDashboard,
  resizeTo,
  type Box,
} from './helpers/admin-dashboard';
import { FIXTURE_TIMEZONE } from './fixtures/admin-dashboard-seed';
import { measureGroundContrast } from './helpers/ground-contrast';

/**
 * Admin Research Studies table, Step 1 (density, width, column set, bands).
 * One named test per acceptance criterion in the build brief
 * (`~/.claude/plans/cortex-admin-table-2026-09-23/BRIEF.md`), measured in a
 * real browser against the seeded dev database's 13 owner-scoped studies for
 * admin@test.com, in dark AND light. The data is route-mocked from a capture of
 * that seed (`e2e/fixtures/admin-dashboard-seed.ts`), so the spec needs only a
 * frontend and runs in the `test-a11y` CI job.
 *
 * Every width, count and breakpoint below is a LITERAL. None is read from the
 * CSS: a test that derives its expectation from the stylesheet cannot see the
 * stylesheet change.
 *
 * Each measuring test collects its per-width failures into one array and
 * asserts it is empty, so a failure names the width and the value.
 *
 * Tests marked GUARD below hold on main as well as on the fix. They pin a
 * property main already has and so cannot be controls in the AC19 sense;
 * each carries an in-test arm proving its instrument can fail.
 */

/** The new column set, in order. No Type, no Clicks. */
const COLUMNS = ['Study', 'Status', 'Progress', 'Next session / deadline', 'Created', 'Actions'];
/** The sort fields reachable at every width, header buttons plus the Sort by control. */
const SORT_FIELDS = ['Created', 'Status', 'Study'];

const TABLE_WIDTHS_BELOW_1280 = [1024, 1100, 1152, 1219];
const TABLE_WIDTHS_FROM_1280 = [1280, 1440, 1920];

test.use({ timezoneId: FIXTURE_TIMEZONE });

// Any API call with no mock, made at any point in a test, fails that test by
// name - not only the calls made while the dashboard loaded.
test.afterEach(async ({ page }) => {
  expectNoUnmockedCalls(page);
});

const frame = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** thead computes table-header-group and every body row table-row. */
const layoutAt = async (page: Page, width: number) => {
  await resizeTo(page, width);
  return page.evaluate(() => {
    const p = window.__adminProbe;
    const t = p.table();
    return {
      thead: getComputedStyle(t.tHead!).display,
      rows: p.rows().map((r) => getComputedStyle(r).display),
    };
  });
};
const isTable = (l: { thead: string; rows: string[] }) =>
  l.thead === 'table-header-group' && l.rows.length > 0 && l.rows.every((d) => d === 'table-row');

for (const theme of THEMES) {
  test.describe(`Admin studies table density (${theme})`, () => {
    test(`AC1 renders a table, not cards, at 1024, 1100, 1152 and 1219 (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const width of TABLE_WIDTHS_BELOW_1280) {
        const l = await layoutAt(page, width);
        if (!isTable(l)) failures.push(`${width}px: thead ${l.thead}, rows ${[...new Set(l.rows)].join('/')}`);
      }
      expect(failures).toEqual([]);
    });

    test(`AC1 the card breakpoint sits between 1023 (cards) and 1024 (table) (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const at1023 = await layoutAt(page, 1023);
      const at1024 = await layoutAt(page, 1024);
      expect(isTable(at1023), `1023px should be cards: thead ${at1023.thead}`).toBe(false);
      expect(isTable(at1024), `1024px should be a table: thead ${at1024.thead}, rows ${at1024.rows[0]}`).toBe(true);
    });

    // GUARD: main already renders a table from 1220 up. The 1023/1024 pair
    // above is the arm proving this instrument tells the two layouts apart.
    test(`AC1 still renders a table at 1280, 1440 and 1920 (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const width of TABLE_WIDTHS_FROM_1280) {
        const l = await layoutAt(page, width);
        if (!isTable(l)) failures.push(`${width}px: thead ${l.thead}`);
      }
      expect(failures).toEqual([]);
    });

    // GUARD: phone keeps the card view (unchanged in Step 1).
    test(`AC1 keeps the card view at 390 (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 390, theme });
      const l = await layoutAt(page, 390);
      expect(isTable(l), `390px should be cards: thead ${l.thead}`).toBe(false);
    });

    test(`AC3 table is at least 1100px wide at 1280, 1440 and 1920 (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const width of TABLE_WIDTHS_FROM_1280) {
        await resizeTo(page, width);
        const w = await page.evaluate(() => window.__adminProbe.table().getBoundingClientRect().width);
        if (!(w >= 1100)) failures.push(`${width}px: table ${w.toFixed(1)}px`);
      }
      expect(failures).toEqual([]);
    });

    test(`AC4 Study column content box is >= 360px from 1280 and >= 300px at 1024-1279 (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const [width, min] of [
        [1024, 300],
        [1100, 300],
        [1219, 300],
        [1279, 300],
        [1280, 360],
        [1440, 360],
        [1920, 360],
      ] as const) {
        await resizeTo(page, width);
        const m = await page.evaluate(() => {
          const p = window.__adminProbe;
          const td = p.cell(p.rows()[0], 'Study');
          if (!td) return null;
          const cs = getComputedStyle(td);
          return {
            display: cs.display,
            content: td.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
          };
        });
        if (!m) failures.push(`${width}px: no Study column`);
        else if (m.display !== 'table-cell') failures.push(`${width}px: Study cell is ${m.display}, not a table column`);
        else if (!(m.content >= min)) failures.push(`${width}px: Study content box ${m.content.toFixed(1)}px < ${min}`);
      }
      expect(failures).toEqual([]);
    });

    test(`AC5 every row is <= 88px and the median <= 72px from 1024 up (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const width of [1024, 1100, 1219, 1280, 1440, 1920]) {
        await resizeTo(page, width);
        const m = await page.evaluate(() =>
          window.__adminProbe.rows().map((r) => ({ h: r.getBoundingClientRect().height, d: getComputedStyle(r).display }))
        );
        const heights = m.map((r) => r.h).sort((a, b) => a - b);
        const median = heights[Math.floor(heights.length / 2)];
        if (m.some((r) => r.d !== 'table-row')) failures.push(`${width}px: rows are not table rows`);
        if (heights[heights.length - 1] > 88) failures.push(`${width}px: tallest row ${heights[heights.length - 1].toFixed(1)}px`);
        if (median > 72) failures.push(`${width}px: median row ${median.toFixed(1)}px`);
      }
      expect(failures).toEqual([]);
    });

    test(`AC6 at least 10 rows visible at 1440 and 1280, 9 at 1024, in a 900px viewport (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const [width, min] of [
        [1440, 10],
        [1280, 10],
        [1024, 9],
      ] as const) {
        await resizeTo(page, width, 900);
        await page.evaluate(() => {
          const head = window.__adminProbe.table().tHead!;
          window.scrollTo(0, window.scrollY + head.getBoundingClientRect().top);
        });
        await frame(page);
        const m = await page.evaluate(() => {
          const p = window.__adminProbe;
          return {
            theadTop: p.table().tHead!.getBoundingClientRect().top,
            theadDisplay: getComputedStyle(p.table().tHead!).display,
            visible: p.rows().filter((r) => r.getBoundingClientRect().bottom <= window.innerHeight + 0.5).length,
          };
        });
        if (m.theadDisplay !== 'table-header-group') failures.push(`${width}px: no table header (${m.theadDisplay})`);
        if (m.visible < min) failures.push(`${width}px: ${m.visible} rows visible < ${min} (thead top ${m.theadTop.toFixed(0)})`);
      }
      expect(failures).toEqual([]);
    });

    // GUARD: main has no document-level horizontal scroll at these widths
    // either. The control arm at the end proves the instrument can see one.
    test(`AC8 no document-level horizontal scroll at 390, 768, 1023, 1024, 1219 and 1440 (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      // scrollWidth <= clientWidth, not innerWidth: innerWidth includes a
      // classic scrollbar, so a runner with one would fail by ~15px on no defect.
      const overflow = () =>
        page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
      const failures: string[] = [];
      for (const width of [390, 768, 1023, 1024, 1219, 1440]) {
        await resizeTo(page, width);
        const o = await overflow();
        if (o.scrollWidth > o.clientWidth) failures.push(`${width}px: scrollWidth ${o.scrollWidth} > ${o.clientWidth}`);
      }
      expect(failures).toEqual([]);

      await page.evaluate(() => {
        const wide = document.createElement('div');
        wide.style.cssText = 'width: 3000px; height: 1px;';
        document.body.appendChild(wide);
      });
      const control = await overflow();
      expect(control.scrollWidth, 'control: a 3000px child must register as horizontal scroll').toBeGreaterThan(
        control.clientWidth
      );
    });

    // GUARD: main's pills already contain their ink. The control arm proves
    // the instrument sees ink escaping a pill.
    test(`AC9 every pill's ink stays inside its pill at 1024, 1100, 1219, 1280 and 1440 (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const measure = () =>
        page.evaluate(() => {
          const p = window.__adminProbe;
          // A pill is an `.admin-pill` that paints a box. Step 1 turns the
          // auto-closed marker into plain text (it may keep the class), and
          // plain text has no box for its ink to stay inside.
          const pills = [...p.table().querySelectorAll('tbody .admin-pill')].filter((el) => p.paints(el));
          const offenders: string[] = [];
          for (const pill of pills) {
            const b = pill.getBoundingClientRect();
            for (const o of p.inkOutside(pill, b)) offenders.push(`${p.norm(pill.textContent)}: ${o.what}`);
            // Ink clipped away inside the pill is information lost too.
            for (const el of pill.querySelectorAll('*')) {
              const cs = getComputedStyle(el);
              if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 1) {
                offenders.push(`${p.norm(pill.textContent)}: truncated ${el.scrollWidth}px in ${el.clientWidth}px`);
              }
            }
          }
          return { count: pills.length, offenders };
        });
      const failures: string[] = [];
      for (const width of [1024, 1100, 1219, 1280, 1440]) {
        await resizeTo(page, width);
        const m = await measure();
        // 13 type pills plus 13 status pills.
        if (m.count < 2 * SEEDED_STUDY_COUNT) failures.push(`${width}px: only ${m.count} pills`);
        for (const o of m.offenders) failures.push(`${width}px: ${o}`);
      }
      expect(failures).toEqual([]);

      await page.evaluate(() => {
        const pill = document.querySelector('table.admin-data-table tbody .admin-pill') as HTMLElement;
        const escape = document.createElement('span');
        escape.textContent = 'ESCAPED';
        escape.style.cssText = 'position: absolute; margin-left: 400px;';
        pill.appendChild(escape);
      });
      const control = await measure();
      expect(control.offenders.length, 'control: ink placed outside a pill must be seen').toBeGreaterThan(0);
    });

    test(`AC10 meta line is one line, title at most two, full strings in title attributes (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const studies = SEEDED_STUDIES;
      const failures: string[] = [];
      for (const width of [1024, 1280, 1440]) {
        await resizeTo(page, width);
        const found = await page.evaluate((list) => {
          const p = window.__adminProbe;
          const lh = (el: Element) => {
            const cs = getComputedStyle(el);
            return cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
          };
          const hasTitleAttr = (root: Element, text: string) =>
            [root, ...root.querySelectorAll('[title]')].some((el) => el.getAttribute('title') === text);
          const out: string[] = [];
          for (const s of list) {
            const row = p.rows().find((r) => {
              const c = p.cell(r, 'Study');
              return c && p.elementWithText(c, s.title);
            });
            const cell = row && p.cell(row, 'Study');
            if (!cell) {
              out.push(`"${s.title}": no Study cell carries the title`);
              continue;
            }
            const titleEl = p.elementWithText(cell, s.title)!;
            const purposeEl = p.elementWithText(cell, s.purpose_one_liner);
            const titleLines = titleEl.getBoundingClientRect().height / lh(titleEl);
            if (titleLines > 2.1) out.push(`"${s.title}": title spans ${titleLines.toFixed(2)} lines`);
            if (!hasTitleAttr(cell, s.title)) out.push(`"${s.title}": no title attribute with the full title`);
            if (!purposeEl) out.push(`"${s.title}": purpose text not rendered as its own element`);
            else {
              const lines = purposeEl.getBoundingClientRect().height / lh(purposeEl);
              if (lines >= 1.5) out.push(`"${s.title}": meta line spans ${lines.toFixed(2)} lines`);
            }
            if (!hasTitleAttr(cell, s.purpose_one_liner)) out.push(`"${s.title}": no title attribute with the full purpose`);
          }
          return out;
        }, studies);
        for (const f of found) failures.push(`${width}px: ${f}`);
      }
      expect(failures).toEqual([]);
    });

    test(`AC14 sort parity: the same sort fields are reachable at every width (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const width of [390, 1023, 1024, 1100, 1279, 1280, 1440]) {
        await resizeTo(page, width);
        const reachable = await page.evaluate(() => {
          const p = window.__adminProbe;
          const fromHeaders = p
            .headerCells()
            .filter((th) => th.querySelector('button') && p.shown(th.querySelector('button')))
            .map((th) => p.norm(th.textContent));
          const control = document.querySelector('.admin-card-sort');
          const select = control?.querySelector('select');
          const fromControl =
            select && p.shown(control) && p.shown(select) ? [...select.options].map((o) => p.norm(o.textContent)) : [];
          return [...new Set([...fromHeaders, ...fromControl])].sort();
        });
        if (JSON.stringify(reachable) !== JSON.stringify(SORT_FIELDS)) {
          failures.push(`${width}px: reachable [${reachable.join(', ')}]`);
        }
      }
      expect(failures).toEqual([]);

      // Changing sort on one surface updates the other (1100: both shown).
      await resizeTo(page, 1100);
      const select = page.locator('.admin-card-sort select');
      const statusHeader = page.locator('table.admin-data-table thead th').filter({ hasText: /^\s*Status\s*$/ });
      await statusHeader.locator('button').click({ timeout: 3000 });
      await expect(select.locator('option:checked')).toHaveText('Status', { timeout: 3000 });
      await expect(statusHeader).toHaveAttribute('aria-sort', /ascending|descending/, { timeout: 3000 });
      await select.selectOption({ label: 'Study' }, { timeout: 3000 });
      await expect(page.locator('table.admin-data-table thead th').filter({ hasText: /^\s*Study\s*$/ })).toHaveAttribute(
        'aria-sort',
        /ascending|descending/,
        { timeout: 3000 }
      );
    });

    test(`Created is hidden and the Sort by control shown at 1024-1279, both reversed at 1280 (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const probe = () =>
        page.evaluate(() => {
          const p = window.__adminProbe;
          const created = p.headerCells().find((th) => p.norm(th.textContent) === 'Created') ?? null;
          const shownHeaders = p.headerCells().filter((th) => p.shown(th));
          return {
            createdHeaderShown: p.shown(created),
            createdCellsShown: p.rows().filter((r) => p.shown(p.cell(r, 'Created'))).length,
            sortControlShown: p.shown(document.querySelector('.admin-card-sort')),
            theadDisplay: getComputedStyle(p.table().tHead!).display,
            // A hidden <th>/<td> whose <col> still takes width leaves an empty
            // stripe: every pixel of the table should belong to a shown header.
            unclaimed:
              p.table().getBoundingClientRect().width -
              shownHeaders.reduce((sum, th) => sum + th.getBoundingClientRect().width, 0),
          };
        });
      const failures: string[] = [];
      for (const width of [1024, 1100, 1219, 1279]) {
        await resizeTo(page, width);
        const m = await probe();
        if (m.theadDisplay !== 'table-header-group') failures.push(`${width}px: not a table (${m.theadDisplay})`);
        if (m.createdHeaderShown) failures.push(`${width}px: Created header shown`);
        if (m.createdCellsShown > 0) failures.push(`${width}px: ${m.createdCellsShown} Created cells shown`);
        if (!m.sortControlShown) failures.push(`${width}px: Sort by control hidden`);
        if (m.unclaimed > 1) failures.push(`${width}px: ${m.unclaimed.toFixed(1)}px of table under no shown header`);
      }
      await resizeTo(page, 1280);
      const at1280 = await probe();
      if (!at1280.createdHeaderShown) failures.push('1280px: Created header hidden');
      if (at1280.createdCellsShown !== SEEDED_STUDY_COUNT) failures.push(`1280px: ${at1280.createdCellsShown} Created cells shown`);
      if (at1280.sortControlShown) failures.push('1280px: Sort by control still shown');
      expect(failures).toEqual([]);
    });

    test(`the column set is Study, Status, Progress, Next session / deadline, Created, Actions (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      for (const width of [1440, 1280, 1024]) {
        await resizeTo(page, width);
        const labels = await page.evaluate(() => window.__adminProbe.headerLabels());
        expect(labels, `${width}px header cells`).toEqual(COLUMNS);
        expect(labels).not.toContain('Type');
        expect(labels).not.toContain('Clicks');
        const cellCounts = await page.evaluate(() => window.__adminProbe.rows().map((r) => r.cells.length));
        expect(new Set(cellCounts), `${width}px cells per row`).toEqual(new Set([COLUMNS.length]));
      }
    });

    test(`the type pill sits on the meta line under the title, before the purpose (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const studies = SEEDED_STUDIES;
      const failures: string[] = [];
      for (const width of [1024, 1280, 1440]) {
        await resizeTo(page, width);
        const found = await page.evaluate((list) => {
          const p = window.__adminProbe;
          const out: string[] = [];
          for (const s of list) {
            const row = p.rows().find((r) => {
              const c = p.cell(r, 'Study');
              return c && p.elementWithText(c, s.title);
            });
            const cell = row && p.cell(row, 'Study');
            if (!row || !cell) {
              out.push(`"${s.title}": no Study cell carries the title`);
              continue;
            }
            const inRow = row.querySelectorAll('[class*="badge--"]').length;
            const pill = cell.querySelector(`.badge--${s.type}`);
            if (inRow !== 1) out.push(`"${s.title}": ${inRow} type pills in the row`);
            if (!pill) {
              out.push(`"${s.title}": no ${s.type} pill in the Study cell`);
              continue;
            }
            const t = p.elementWithText(cell, s.title)!.getBoundingClientRect();
            const pb = pill.getBoundingClientRect();
            const purpose = p.elementWithText(cell, s.purpose_one_liner);
            if (pb.top < t.bottom - 0.5) out.push(`"${s.title}": pill top ${pb.top.toFixed(0)} above title bottom ${t.bottom.toFixed(0)}`);
            if (!purpose) out.push(`"${s.title}": purpose not rendered as its own element`);
            else {
              const u = purpose.getBoundingClientRect();
              const mid = (u.top + u.bottom) / 2;
              if (u.left < pb.right - 0.5) out.push(`"${s.title}": purpose starts before the pill ends`);
              if (mid < pb.top || mid > pb.bottom) out.push(`"${s.title}": purpose is not on the pill's line`);
            }
          }
          return out;
        }, studies);
        for (const f of found) failures.push(`${width}px: ${f}`);
      }
      expect(failures).toEqual([]);
    });

    test(`Progress shows N / M for session studies, N clicks for clicked ones, a dash for drafts (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const studies = SEEDED_STUDIES;
      const withSessions = studies.filter((s) => (s.sessions ?? []).length > 0);
      const clicked = studies.filter((s) => (s.sessions ?? []).length === 0 && s.status !== 'draft' && (s.clicks_total ?? 0) > 0);
      const drafts = studies.filter((s) => s.status === 'draft');
      // Positive controls: the seed has every kind this test distinguishes.
      expect(withSessions.length).toBeGreaterThanOrEqual(1);
      expect(clicked.length).toBeGreaterThanOrEqual(1);
      expect(drafts.length).toBeGreaterThanOrEqual(1);

      const progressText = (titles: string[]) =>
        page.evaluate((ts) => {
          const p = window.__adminProbe;
          return ts.map((title) => {
            const row = p.rows().find((r) => {
              const c = p.cell(r, 'Study');
              return c && p.elementWithText(c, title);
            });
            const c = row && p.cell(row, 'Progress');
            return c ? p.norm(c.textContent) : null;
          });
        }, titles);

      const failures: string[] = [];
      const sessionTexts = await progressText(withSessions.map((s) => s.title));
      withSessions.forEach((s, i) => {
        const cap = (s.sessions ?? []).reduce((n, x) => n + x.capacity, 0);
        const booked = (s.sessions ?? []).reduce((n, x) => n + (x.booked_count ?? 0), 0);
        if (!sessionTexts[i]?.includes(`${booked} / ${cap}`)) failures.push(`"${s.title}": ${sessionTexts[i]}, want ${booked} / ${cap}`);
      });
      const clickTexts = await progressText(clicked.map((s) => s.title));
      clicked.forEach((s, i) => {
        if (clickTexts[i] !== `${s.clicks_total} clicks`) failures.push(`"${s.title}": ${clickTexts[i]}, want ${s.clicks_total} clicks`);
      });
      const draftTexts = await progressText(drafts.map((s) => s.title));
      drafts.forEach((s, i) => {
        if (draftTexts[i] !== '–') failures.push(`"${s.title}": ${draftTexts[i]}, want an en dash`);
      });
      expect(failures).toEqual([]);
    });

    test(`AUTO-CLOSED stays in closed rows as plain text, not a second pill (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const studies = SEEDED_STUDIES;
      const closed = studies.filter((s) => s.status === 'closed').map((s) => s.title);
      expect(closed.length, 'the seed has closed studies').toBeGreaterThanOrEqual(1);
      const failures: string[] = [];
      for (const width of [1024, 1280, 1440]) {
        await resizeTo(page, width);
        const found = await page.evaluate((closedTitles) => {
          const p = window.__adminProbe;
          const out: string[] = [];
          let marked = 0;
          for (const row of p.rows()) {
            const status = p.cell(row, 'Status');
            const study = p.cell(row, 'Study');
            if (!status || !study) {
              out.push('no Status or Study column');
              break;
            }
            const title = closedTitles.find((t) => p.elementWithText(study, t));
            const boxes = p.paintedBoxes(status);
            if (boxes.length !== 1) out.push(`${p.norm(study.textContent).slice(0, 30)}: ${boxes.length} pill-shaped boxes in Status`);
            if (!title) continue;
            const marker = [...status.querySelectorAll('*')].find((el) => /^auto-closed$/i.test(p.norm(el.textContent)));
            if (!marker) {
              out.push(`"${title}": AUTO-CLOSED is missing`);
              continue;
            }
            marked += 1;
            const cs = getComputedStyle(marker);
            const pill = boxes[0]?.getBoundingClientRect();
            const m = marker.getBoundingClientRect();
            if (p.rgba(cs.backgroundColor)[3] !== 0) out.push(`"${title}": marker has a fill ${cs.backgroundColor}`);
            if (['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0)) {
              out.push(`"${title}": marker has a border`);
            }
            if (cs.fontSize !== '12px') out.push(`"${title}": marker font-size ${cs.fontSize}`);
            if (cs.fontWeight !== '400') out.push(`"${title}": marker font-weight ${cs.fontWeight}`);
            if (pill && (m.top < pill.bottom - 0.5 || m.top - pill.bottom > 6)) {
              out.push(`"${title}": marker not directly under the pill (gap ${(m.top - pill.bottom).toFixed(1)}px)`);
            }
          }
          if (marked !== closedTitles.length) out.push(`${marked} of ${closedTitles.length} closed rows carry AUTO-CLOSED`);
          return out;
        }, closed);
        for (const f of found) failures.push(`${width}px: ${f}`);
      }
      expect(failures).toEqual([]);
    });

    test(`no text collision: every cell's content stays inside its cell at 1024, 1280 and 1440 (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const measure = () =>
        page.evaluate(() => {
          const p = window.__adminProbe;
          const out: string[] = [];
          const labels = p.headerLabels();
          let cells = 0;
          for (const row of p.rows()) {
            [...row.cells].forEach((td, i) => {
              if (!p.shown(td)) return;
              cells += 1;
              const r = td.getBoundingClientRect();
              const bounds: Box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
              for (const o of p.inkOutside(td, bounds)) {
                out.push(`${labels[i] ?? i} cell: ${o.what} at ${o.box.left.toFixed(0)}-${o.box.right.toFixed(0)} outside ${r.left.toFixed(0)}-${r.right.toFixed(0)}`);
              }
            });
          }
          return { cells, out };
        });
      const failures: string[] = [];
      for (const width of [1024, 1280, 1440]) {
        await resizeTo(page, width);
        const m = await measure();
        if (m.cells < SEEDED_STUDY_COUNT * 5) failures.push(`${width}px: only ${m.cells} cells measured`);
        const d = await page.evaluate(() => getComputedStyle(window.__adminProbe.table().tHead!).display);
        if (d !== 'table-header-group') failures.push(`${width}px: not a table (${d})`);
        for (const o of m.out) failures.push(`${width}px: ${o}`);
      }
      expect(failures).toEqual([]);

      // Control: an unbreakable run placed in a cell must register.
      await page.evaluate(() => {
        const td = window.__adminProbe.rows()[0].cells[1];
        const run = document.createElement('span');
        run.textContent = 'W'.repeat(80);
        run.style.whiteSpace = 'nowrap';
        td.appendChild(run);
      });
      const control = await measure();
      expect(control.out.length, 'control: an 80-character nowrap run must be seen escaping its cell').toBeGreaterThan(0);
    });

    test(`every header shares one style: 11px, 600, uppercase, 0.06em (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const width of [1024, 1440]) {
        await resizeTo(page, width);
        const styles = await page.evaluate(() => {
          const p = window.__adminProbe;
          return p
            .headerCells()
            .filter((th) => p.shown(th))
            .map((th) => {
              const el = th.querySelector('button') ?? th;
              const cs = getComputedStyle(el);
              return {
                label: p.norm(th.textContent),
                fontSize: cs.fontSize,
                fontWeight: cs.fontWeight,
                textTransform: cs.textTransform,
                letterSpacing: cs.letterSpacing,
              };
            });
        });
        if (styles.length < 5) failures.push(`${width}px: only ${styles.length} headers shown`);
        for (const s of styles) {
          const bad: string[] = [];
          if (s.fontSize !== '11px') bad.push(`font-size ${s.fontSize}`);
          if (s.fontWeight !== '600') bad.push(`weight ${s.fontWeight}`);
          if (s.textTransform !== 'uppercase') bad.push(`transform ${s.textTransform}`);
          if (!(Math.abs(parseFloat(s.letterSpacing) - 0.66) < 0.02)) bad.push(`letter-spacing ${s.letterSpacing}`);
          if (bad.length) failures.push(`${width}px ${s.label}: ${bad.join(', ')}`);
        }
      }
      expect(failures).toEqual([]);
    });

    test(`every tab is the same height as the first at 1024, 1240 and 1440 (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const width of [1024, 1240, 1440]) {
        await resizeTo(page, width);
        const tabs = await page.evaluate(() =>
          [...document.querySelectorAll('.admin-tabs-card .custom-tab-button')].map((b) => ({
            label: window.__adminProbe.norm(b.textContent),
            h: b.getBoundingClientRect().height,
          }))
        );
        if (tabs.length !== 4) failures.push(`${width}px: ${tabs.length} tabs, want 4`);
        for (const t of tabs.slice(1)) {
          if (Math.abs(t.h - tabs[0].h) > 0.5) failures.push(`${width}px: "${t.label}" ${t.h}px vs first ${tabs[0].h}px`);
        }
      }
      expect(failures).toEqual([]);
    });

    /**
     * Mav 4.2: `nav-fill` forced four equal-width tabs, which is what wrapped
     * "Completion Approvals". The fix packs them left at their own content
     * width, on one row. Equal heights alone cannot see a regression here:
     * mutation-tested, reverting `width: auto` / `flex: 0 0 auto` brought the
     * equal-width tabs back (218/240/218/218px at 1024) with every height
     * still 50px, because `white-space: nowrap` kept the labels on one line.
     */
    test(`tabs pack left at their content width, on one row, at 1024, 1240 and 1440 (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const failures: string[] = [];
      for (const width of [1024, 1240, 1440]) {
        await resizeTo(page, width);
        const tabs = await page.evaluate(() =>
          [...document.querySelectorAll('.admin-tabs-card .custom-tab-button')].map((b) => {
            const el = b as HTMLElement;
            const r = el.getBoundingClientRect();
            const inline = el.style.width;
            el.style.width = 'max-content';
            const content = el.getBoundingClientRect().width;
            el.style.width = inline;
            return { label: window.__adminProbe.norm(el.textContent), left: r.left, right: r.right, top: r.top, width: r.width, content };
          })
        );
        if (tabs.length !== 4) failures.push(`${width}px: ${tabs.length} tabs, want 4`);
        for (const t of tabs) {
          if (Math.abs(t.top - tabs[0].top) > 0.5) failures.push(`${width}px: "${t.label}" on a second row`);
          if (t.width > t.content + 1) failures.push(`${width}px: "${t.label}" stretched to ${t.width.toFixed(0)}px for ${t.content.toFixed(0)}px of content`);
        }
        tabs.slice(1).forEach((t, i) => {
          const gap = t.left - tabs[i].right;
          if (gap < 0 || gap > 16) failures.push(`${width}px: ${gap.toFixed(1)}px between "${tabs[i].label}" and "${t.label}"`);
        });
      }
      expect(failures).toEqual([]);
    });

    test(`the Completion Approvals count badge has >= 4.5:1 computed contrast (${theme})`, async ({ page, baseURL }) => {
      await openAdminDashboard(page, baseURL, { width: 1440, theme });
      const badge = page.locator('#completion-approvals-tab-button .admin-tab-count--alert');
      await expect(badge, 'the seed has a pending approval, so the alert badge renders').toHaveCount(1, { timeout: 5000 });
      const m = await badge.evaluate((el) => {
        const p = window.__adminProbe;
        return { fg: p.effectiveText(el), bg: p.effectiveBackground(el), color: getComputedStyle(el).color };
      });
      const ratio = contrastRatio(m.fg, m.bg);
      expect(ratio, `badge ink rgb(${m.fg.map(Math.round)}) on rgb(${m.bg.map(Math.round)}) (${m.color})`).toBeGreaterThanOrEqual(
        4.5
      );
    });

    /**
     * The dark page ground (bloom plus 24px grid) is painted on the body under
     * an admin page. The app-wide atmosphere it replaced (`.App::before` glow,
     * `.App::after` 40px grid) must be off there, or it paints a second grid
     * and glow over the first. Dark only: light has no such layer pair here.
     */
    if (theme === 'dark') {
      test('the app-wide glow and 40px grid are switched off over the admin ground (dark)', async ({ page, baseURL }) => {
        await openAdminDashboard(page, baseURL, { width: 1440, theme });
        const layers = await page.evaluate(() => {
          const app = document.querySelector('.App');
          if (!app) return null;
          return {
            before: getComputedStyle(app, '::before').content,
            after: getComputedStyle(app, '::after').content,
            appBackground: getComputedStyle(app).backgroundImage,
          };
        });
        expect(layers, 'no .App element').not.toBeNull();
        expect(layers!.before, '.App::before glow still renders').toBe('none');
        expect(layers!.after, '.App::after grid still renders').toBe('none');
      });
    }

    /**
     * The dark Admin ground is a gradient `background-image` on the body (Step
     * 1's seam fix), and axe will not judge contrast over a background image:
     * on 6282291c it filed 32-35 Admin text nodes (the h1, the subtitle, the
     * attention cards, the tab labels) under `incomplete`, where main had 0,
     * and nothing failed on that bucket. So every node axe declines is measured
     * here by hand - against its nearest opaque background and against the
     * lightest colour the gradient's own stops can reach - plus a fixed set
     * (the page heading and every tab) so the instrument is exercised even on
     * a day axe declines nothing. Brightening a stop fails this by name.
     */
    if (theme === 'dark') {
      test('text axe cannot judge over the dark Admin ground still clears AA against its lightest colour (dark)', async ({
        page,
        baseURL,
      }) => {
        await openAdminDashboard(page, baseURL, { width: 1440, theme });
        const scan = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
        const declined = scan.incomplete.flatMap((rule) =>
          rule.nodes.map((node) => node.target[0]).filter((t): t is string => typeof t === 'string')
        );
        const m = await measureGroundContrast(page, [...declined, 'main h1', '.admin-tabs-card .custom-tab-button']);
        console.log(
          `Admin dark ground: axe declined ${declined.length}; measured ${m.measured}; lightest ${m.lightestGround}; ` +
            `lowest ${Math.min(...m.rows.map((r) => r.overLightestGround))}`
        );
        // The fixed set alone is the heading plus four tab labels and counts.
        expect(m.measured, 'text nodes measured').toBeGreaterThanOrEqual(5);
        // Control: an unparseable gradient would read no stops and fall back to
        // the flat body colour, passing every node against a darker ground than
        // the page really paints.
        expect(m.stopsRead.length, 'colour stops read from the dark ground').toBeGreaterThan(0);
        expect(m.failures).toEqual([]);
      });
    }

    /**
     * The Feedback tab's sortable headers are `<button>`s, which reset
     * text-transform and letter-spacing, so Date / Category / User rendered
     * mixed case beside the uppercase FEEDBACK header - the same defect the
     * studies table had. Every header's label must share the non-sortable
     * header's case and tracking, and the category pills must fit their column.
     */
    test(`Feedback tab headers share one case and tracking, and category pills fit (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await openAdminDashboard(page, baseURL, { width: 1280, theme });
      await page.locator('#feedback-tab-button').click({ timeout: 3000 });
      const table = page.locator('.admin-feedback table');
      await expect(table.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });
      const m = await table.evaluate((t) => {
        const heads = [...t.querySelectorAll('thead th')].map((th) => {
          const el = th.querySelector('button') ?? th;
          const cs = getComputedStyle(el);
          return { label: (th.textContent ?? '').trim(), transform: cs.textTransform, spacing: cs.letterSpacing };
        });
        const pills = [...t.querySelectorAll('tbody .badge')].map((b) => {
          const cell = b.closest('td')!.getBoundingClientRect();
          const r = b.getBoundingClientRect();
          return {
            text: (b.textContent ?? '').trim(),
            clipped: b.scrollWidth > b.clientWidth + 1,
            outside: r.left < cell.left - 0.5 || r.right > cell.right + 0.5,
          };
        });
        return { heads, pills };
      });
      const reference = m.heads.find((h) => h.label === 'Feedback');
      expect(reference, 'the non-sortable Feedback header').toBeTruthy();
      expect(m.heads.length).toBeGreaterThanOrEqual(4);
      const mismatched = m.heads
        .filter((h) => h.transform !== reference!.transform || h.spacing !== reference!.spacing)
        .map((h) => `${h.label}: ${h.transform} / ${h.spacing} vs ${reference!.transform} / ${reference!.spacing}`);
      expect(mismatched).toEqual([]);
      expect(reference!.transform).toBe('uppercase');
      expect(m.pills.length).toBe(2);
      expect(m.pills.filter((p) => p.clipped || p.outside).map((p) => p.text)).toEqual([]);
    });

    /**
     * B1 (visual gate, 2026-09-23): on the LAST study row the kebab menu opens
     * downward into the site feedback footer, and the footer paints over it:
     * `elementFromPoint` at the Delete item's centre returned
     * `footer.feedback-footer` / `p.feedback-footer__prompt` at 1024, 1280 and
     * 1440 in both themes on c1a8cdd4, so Delete could not be clicked. The
     * hit-test names the defect; the click proves the user outcome.
     */
    for (const width of [1024, 1280, 1440]) {
      test(`B1 the last row's Delete menu item is on top and opens the delete confirmation at ${width}px (${theme})`, async ({
        page,
        baseURL,
      }) => {
        await openAdminDashboard(page, baseURL, { width, theme });
        const kebab = page.locator('table.admin-data-table tbody tr').last().locator('.admin-action-btn-kebab');
        await kebab.scrollIntoViewIfNeeded({ timeout: 3000 });
        await kebab.click({ timeout: 3000 });
        const del = page.getByRole('menuitem', { name: /^Delete$/ });
        await expect(del).toBeVisible({ timeout: 3000 });
        await del.scrollIntoViewIfNeeded({ timeout: 3000 });

        const hit = await del.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            onTop: !!top && (top === el || el.contains(top)),
            what: top ? `${top.tagName.toLowerCase()}.${[...top.classList].join('.')}` : 'nothing',
          };
        });
        expect(hit.onTop, `Delete's centre is covered by ${hit.what}`).toBe(true);

        // Bounded: an intercepted click retries until its timeout and then
        // fails by name here rather than stalling the run.
        await del.click({ timeout: 3000 });
        await expect(page.getByText('Delete Research Study'), 'the delete confirmation did not open').toBeVisible({
          timeout: 3000,
        });
      });
    }
  });
}
