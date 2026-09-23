import { test, expect, type Page, type Route } from '@playwright/test';
import {
  THEMES,
  expectNoUnmockedCalls,
  openAdminDashboard,
  resizeTo,
  type StudySource,
  type Theme,
} from './helpers/admin-dashboard';
import {
  ADMIN_ME,
  FIXTURE_TIMEZONE,
  OPPORTUNITIES,
  STEP2_ALL,
  SUPERADMIN_ME,
  type WireOpportunity,
} from './fixtures/admin-dashboard-seed';
import { measureGroundContrast } from './helpers/ground-contrast';

/**
 * Admin Research Studies table, Step 2 MR B: triage behaviour.
 * Brief: `~/.claude/plans/cortex-admin-table-2026-09-23/BRIEF-STEP2.md`, "MR B";
 * acceptance: Petra's section 4 (AC11-AC16, AC18) plus the brief's own list.
 *
 * Route-mocked like the Step 1 specs, so it runs in the `test-a11y` CI job (a
 * frontend-only `vite preview`). The list endpoint here is STATEFUL and honours
 * the query: `scope=mine` serves admin@test.com's 20 studies, `scope=all` adds
 * two other researchers', and `status` / `type` filter as the server does. A
 * PATCH to one study updates that store, so a reload after Close shows what
 * the server would.
 *
 * Every policy value is a LITERAL: the 3-day warning horizon (a deadline at
 * now + 2d 23h warns, one at now + 3d 1h does not), the 8000ms undo window,
 * the chip counts, the "N of M studies" count and every expected order.
 *
 * Tests marked GUARD hold on main as well; each names its control arm.
 */

test.use({ timezoneId: FIXTURE_TIMEZONE });

test.afterEach(async ({ page }) => {
  expectNoUnmockedCalls(page);
});

// --- Literals --------------------------------------------------------------

const MINE_COUNT = 20;
const ALL_COUNT = 23;
/**
 * The Next column's header, and its Sort by option. "Next session / deadline"
 * until the Step 2 fix round, which shortened it so the header row fits on one
 * line (REVIEW-STEP2B-visual M1).
 */
const NEXT_HEADER = 'Next / deadline';
const UNDO_MS = 8000;

const BROKEN = [
  'Interview: admin automation workflows',
  'Test the new Jira board view',
  'Quick take: naming the new space',
];
const DRAFT = 'Support escalation workflows';

/**
 * Status ascending, the default (AC11, AC12): Broken, Draft, Published,
 * Closed; ties by next milestone soonest (none last), then title A-Z without
 * regard to case. A past closing time ("Completed") is not a NEXT milestone.
 */
const STATUS_ASC_ORDER = [
  // Broken, by deadline: 28 Sept, 6 Oct, 15 Nov.
  ...BROKEN,
  DRAFT,
  // Published, soonest milestone first.
  'Server to Cloud migration: what actually hurt', // session Thu 24 Sept 16:00
  'Developer experience pulse, Q3', // closes Fri 25 Sept 00:32
  'Release notes: what do you read?', // closes Sat 26 Sept 09:00
  'Release cadence: monthly or quarterly?', // closes Sat 26 Sept 11:00
  'Which editor do you write Groovy in?', // 3 Oct
  'ScriptRunner for Jira: the new script editor', // 8 Oct
  'What would you automate first with AI in Jira?', // 9 Oct
  'Triage a failing Bitbucket pipeline', // 11 Oct
  'accessibility audit follow-up', // 14 Oct 13:00 - same instant as the next;
  'Billing page first impressions', //   "a" before "B" only without case
  'Developer experience pulse', // 26 Oct
  '2027 roadmap interviews', // Thu 14 Jan 2027
  'Open question: what slows your code reviews?', // no milestone: last
  // Closed: no closed study has an upcoming milestone (round 3, even with a
  // future end date), so the three order by title.
  'Bitbucket pipeline templates',
  'Recorded: first-run onboarding',
  'Search relevance: which result did you want?',
];

/** Rows with no upcoming milestone: a dash, "Completed", or any closed study. */
const NO_MILESTONE = [
  'Bitbucket pipeline templates',
  'Open question: what slows your code reviews?',
  'Recorded: first-run onboarding',
  'Search relevance: which result did you want?',
  DRAFT,
];

/** Next / deadline ascending; each inner group shares one instant. */
const NEXT_ASC_GROUPS: string[][] = [
  ['Server to Cloud migration: what actually hurt'],
  ['Developer experience pulse, Q3'],
  ['Release notes: what do you read?'],
  ['Release cadence: monthly or quarterly?'],
  ['Interview: admin automation workflows'],
  ['Which editor do you write Groovy in?'],
  ['Test the new Jira board view'],
  ['ScriptRunner for Jira: the new script editor'],
  ['What would you automate first with AI in Jira?'],
  ['Triage a failing Bitbucket pipeline'],
  ['accessibility audit follow-up', 'Billing page first impressions'],
  ['Developer experience pulse'],
  ['Quick take: naming the new space'],
  ['2027 roadmap interviews'],
];

/** Chip labels and counts over the 20 owner-scoped studies, in display order. */
const CHIPS: Array<[string, number]> = [
  ['Broken', 3],
  ['Needs recruitment', 3],
  ['Draft', 1],
  ['Closing soon', 3],
  ['Fully booked', 0],
];

/** Next-note warning horizon: inside and outside, per milestone kind. */
const WARNED = {
  session: 'Server to Cloud migration: what actually hurt', // now + 1d 6h
  deadline: 'Release notes: what do you read?', // now + 2d 23h
  deadline2: 'Developer experience pulse, Q3', // now + 1d 14h
};
/** Closed by hand, end date at now + 2d 7h: closed, so never warned. */
const CLOSED_INSIDE_HORIZON = 'Search relevance: which result did you want?';
const NOT_WARNED = {
  session: '2027 roadmap interviews', // next year
  deadline: 'Release cadence: monthly or quarterly?', // now + 3d 1h
  deadline2: 'Interview: admin automation workflows', // now + 5d 14h
};

const PUBLISHED_MINE = 'Which editor do you write Groovy in?';
const OTHER_PUBLISHED = 'Pricing page: how teams choose a tier';
const OTHER_BROKEN = 'Onboarding checklist interviews';
const UNNAMED_OWNER_STUDY = 'One word for our new dashboard';
const REOPEN_REFUSED_STUDY = 'Server to Cloud migration: what actually hurt';
const REOPEN_REFUSAL = 'Add at least one upcoming time slot before publishing a live session or interview';

// --- Mocked API ------------------------------------------------------------

interface Api {
  source: StudySource;
  /** Every list query the page sent, as `URLSearchParams.toString()`. */
  listQueries: string[];
  /** Every PATCH to one study: its id and parsed body. */
  patches: Array<{ id: string; body: Record<string, unknown> }>;
  /** List requests still to fail with a 500 (a failed reload). */
  failLists: number;
}

const idOf = (title: string): string => {
  const study = STEP2_ALL.find((s) => s.title === title);
  if (!study?.id) throw new Error(`no fixture study titled "${title}"`);
  return study.id;
};

/**
 * A per-test copy of the Step 2 studies, served the way the server scopes and
 * filters them, and mutated by PATCH.
 */
function makeApi(
  studies: readonly WireOpportunity[] = STEP2_ALL,
  /** Whose studies `scope=mine` returns; null serves every study for it. */
  mineOwner: string | null = ADMIN_ME.id
): Api & { store: WireOpportunity[] } {
  const store: WireOpportunity[] = structuredClone([...studies]);
  const listQueries: string[] = [];
  const api = { listQueries, patches: [] as Api['patches'], store, failLists: 0 } as Api & { store: WireOpportunity[] };
  const source: StudySource = (query) => {
    listQueries.push(query.toString());
    if (api.failLists > 0) {
      api.failLists -= 1;
      return null;
    }
    const scope = query.get('scope') ?? 'mine';
    const status = query.get('status');
    const type = query.get('type');
    return store.filter(
      (s) =>
        (scope === 'all' || mineOwner === null || s.owner_user_id === mineOwner) &&
        (!status || s.status === status) &&
        (!type || s.type === type)
    );
  };
  api.source = source;
  return api;
}

/** The client fetches a CSRF token before its first mutating request. */
const mockCsrf = (page: Page) =>
  page.route('**/api/csrf-token', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"csrfToken":"e2e-csrf-token"}' })
  );

/**
 * POST /api/opportunities/:id/duplicate: adds a draft copy to the store, as the
 * server does. `failRefresh` makes the list request after it fail with a 500.
 */
async function mockDuplicate(
  page: Page,
  api: Api & { store: WireOpportunity[] },
  opts: { failRefresh?: boolean } = {}
): Promise<string[]> {
  await mockCsrf(page);
  const copied: string[] = [];
  await page.route(
    (url) => /^\/api\/opportunities\/[^/]+\/duplicate$/.test(url.pathname),
    async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const id = new URL(route.request().url()).pathname.split('/')[3];
      const source = api.store.find((s) => s.id === id);
      if (!source) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' });
      const copy = {
        ...structuredClone(source),
        id: `${id.slice(0, -4)}c0de`,
        title: `${source.title} (copy)`,
        status: 'draft',
        sessions: [],
      } as WireOpportunity;
      api.store.push(copy);
      copied.push(id);
      if (opts.failRefresh) api.failLists = 1;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(copy) });
    }
  );
  return copied;
}

/**
 * PATCH /api/opportunities/:id against the store. `refuseReopen` answers a
 * `status: 'published'` for that study with the publish guard's 400, in the
 * error handler's shape (`{ error, code }`).
 */
async function mockPatch(
  page: Page,
  api: Api & { store: WireOpportunity[] },
  opts: { refuseReopen?: string; failClose?: string; holdReopen?: Promise<void> } = {}
): Promise<void> {
  await mockCsrf(page);
  await page.route(
    (url) => /^\/api\/opportunities\/[^/]+$/.test(url.pathname),
    async (route: Route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const id = new URL(route.request().url()).pathname.split('/').pop()!;
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      api.patches.push({ id, body });
      if (opts.holdReopen && body.status === 'published') await opts.holdReopen;
      const study = api.store.find((s) => s.id === id);
      if (!study) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' });
      if (opts.failClose === id && body.status === 'closed') {
        // A failure with no reason in the body: the client's own fallback copy.
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      if (opts.refuseReopen === id && body.status === 'published') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: REOPEN_REFUSAL, code: 'VALIDATION_ERROR' }),
        });
      }
      // MR A: any status write through PATCH records a manual change.
      Object.assign(study, body, typeof body.status === 'string' ? { auto_closed: false } : {});
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(study) });
    }
  );
}

/**
 * Before leaving the dashboard: the page navigated to loads its own data,
 * which these specs do not model. Registered last, so it wins over the
 * recorder; only the URL is asserted after it.
 */
const sinkApiForNavigation = (page: Page) =>
  page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"left the dashboard"}' })
  );

async function open(
  page: Page,
  baseURL: string | undefined,
  opts: {
    width?: number;
    height?: number;
    theme?: Theme;
    api?: Api;
    expectedRows?: number;
    me?: { id: string; role: string } & Record<string, unknown>;
  } = {}
): Promise<Api & { store: WireOpportunity[] }> {
  const api = (opts.api as Api & { store: WireOpportunity[] }) ?? makeApi();
  await openAdminDashboard(page, baseURL, {
    width: opts.width ?? 1440,
    height: opts.height,
    theme: opts.theme,
    studies: api.source,
    expectedRows: opts.expectedRows ?? MINE_COUNT,
    me: opts.me,
  });
  return api;
}

// --- Page readers ----------------------------------------------------------

/** Study rows. Close study's notices are rows in the same <tbody>, and are not studies. */
const rows = (page: Page) => page.locator('table.admin-data-table tbody tr:not(.admin-inline-notice-row)');
/** The row whose Study cell carries this exact title (AC10 keeps it in `title`). */
const row = (page: Page, title: string) => rows(page).filter({ has: page.getByTitle(title, { exact: true }) });
const titleLink = (page: Page, title: string) => row(page, title).getByRole('link', { name: title, exact: true });
const header = (page: Page, label: string) =>
  page.locator('table.admin-data-table thead th').filter({ hasText: new RegExp(`^\\s*${label.replace(/[/]/g, '\\/')}\\s*$`) });
const kebab = (page: Page, title: string) => row(page, title).locator('.admin-action-btn-kebab');
const chipRow = (page: Page) => page.locator('.admin-quick-filters');
const chips = (page: Page) => chipRow(page).locator('button.admin-chip');
const chip = (page: Page, label: string) => chips(page).filter({ hasText: new RegExp(`^\\s*${label}\\s*\\d*\\s*$`) });

/** Titles in table order: the first element in each Study cell with a `title`. */
const titles = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const p = window.__adminProbe;
    return p.rows().map((r) => p.cell(r, 'Study')?.querySelector('[title]')?.getAttribute('title') ?? '(no title)');
  });

/**
 * The study rows either side of study `title`'s notice or error slot, read
 * BEFORE the hand-off: where focus should land if the study moves away.
 */
const slotNeighbours = (page: Page, title: string): Promise<{ next: string | null; prev: string | null }> =>
  page.evaluate((t) => {
    const notices = [...document.querySelectorAll('table.admin-data-table tbody tr.admin-inline-notice-row')];
    const slot = notices.find((tr) => tr.textContent?.includes(`“${t}”`));
    const titleOf = (tr: Element | null) =>
      tr && !tr.classList.contains('admin-inline-notice-row')
        ? (tr.querySelector('td [title]')?.getAttribute('title') ?? null)
        : null;
    if (!slot) return { next: null, prev: null };
    let next = slot.nextElementSibling;
    while (next && !titleOf(next)) next = next.nextElementSibling;
    let prev = slot.previousElementSibling;
    while (prev && (!titleOf(prev) || titleOf(prev) === t)) prev = prev.previousElementSibling;
    return { next: titleOf(next), prev: titleOf(prev) };
  }, title);

/**
 * After a lapse or Dismiss hands focus back: it lands on the study's own title
 * link when that is (at least partly) in view, else on the neighbour now at the
 * notice's old slot (the next row, else the previous one). The focused link is
 * in view, and the next Tab does not scroll the page.
 */
async function expectHandOff(
  page: Page,
  title: string,
  neighbours: { next: string | null; prev: string | null },
  what: string
): Promise<{ focused: string | null; ownInView: boolean }> {
  await expect
    .poll(() => page.evaluate(() => Boolean((document.activeElement as HTMLElement | null)?.matches('a.row-title'))), {
      message: `${what}: focus lands on a study title link`,
      timeout: 3000,
    })
    .toBe(true);
  const f = await page.evaluate((t) => {
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    };
    const el = document.activeElement as HTMLElement;
    const own = [...document.querySelectorAll('table.admin-data-table a.row-title')].find((a) => a.getAttribute('title') === t);
    return { focused: el.getAttribute('title'), inView: inView(el), ownInView: own ? inView(own) : false };
  }, title);
  const want = f.ownInView ? title : (neighbours.next ?? neighbours.prev);
  expect({ focused: f.focused, inView: f.inView }, `${what}: focus`).toEqual({ focused: want, inView: true });
  const y0 = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Tab');
  const y1 = await page.evaluate(() => window.scrollY);
  expect(y1 - y0, `${what}: the next Tab scrolled the page`).toBe(0);
  return { focused: f.focused, ownInView: f.ownInView };
}

/** The visible status label of a row ("Broken", "PUBLISHED", ...). */
const statusLabel = (page: Page, title: string) =>
  row(page, title).locator('.admin-study-status__label').innerText();

/** The items of the open row menu, with separators, as rendered. */
const menuSequence = (page: Page): Promise<string[]> =>
  page.locator('.admin-action-dropdown-menu').evaluate((menu) =>
    [...menu.children]
      .filter((el) => el.checkVisibility())
      .map((el) =>
        el.getAttribute('role') === 'separator'
          ? '|'
          : `${(el.textContent ?? '').replace(/\s+/g, ' ').trim()}${
              el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' ? ' (disabled)' : ''
            }`
      )
  );

async function openMenu(page: Page, title: string): Promise<void> {
  const trigger = kebab(page, title);
  await trigger.scrollIntoViewIfNeeded({ timeout: 3000 });
  await trigger.click({ timeout: 3000 });
  await expect(page.locator('.admin-action-dropdown-menu'), `the row menu for "${title}" did not open`).toBeVisible({
    timeout: 3000,
  });
}

async function toggleShowAll(page: Page, expectedRows: number): Promise<void> {
  await page.getByRole('button', { name: 'Show all researchers' }).click({ timeout: 3000 });
  await expect(rows(page), 'rows after Show all researchers').toHaveCount(expectedRows, { timeout: 5000 });
}

/** Asserts `actual` is `groups` in order, each group's members in any order. */
function expectGroupedOrder(actual: string[], groups: string[][], what: string): void {
  const flat = groups.flat();
  expect(actual.length, `${what}: row count`).toBe(flat.length);
  let i = 0;
  const problems: string[] = [];
  for (const group of groups) {
    const got = actual.slice(i, i + group.length);
    if ([...got].sort().join('|') !== [...group].sort().join('|')) {
      problems.push(`rows ${i + 1}-${i + group.length}: got [${got.join(', ')}], want {${group.join(', ')}}`);
    }
    i += group.length;
  }
  expect(problems, `${what}: order`).toEqual([]);
}

// ===========================================================================

test.describe('Admin studies table triage: sort (AC11-AC14)', () => {
  test('AC11 the default sort is Status ascending: the three broken studies, then the draft, lead', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await expect(header(page, 'Status'), 'Status carries the default sort').toHaveAttribute('aria-sort', 'ascending');
    for (const other of ['Study', NEXT_HEADER, 'Created']) {
      await expect(header(page, other), `${other} is not the sorted column`).not.toHaveAttribute(
        'aria-sort',
        /ascending|descending/
      );
    }
    const order = await titles(page);
    expect(order.slice(0, 4), 'the first four rows').toEqual([...BROKEN, DRAFT]);
    for (const title of BROKEN) expect(await statusLabel(page, title), `"${title}" reads Broken`).toMatch(/^broken$/i);

    // The Sort by control (shown below 1280) reports the same default.
    await resizeTo(page, 1100);
    await expect(page.locator('.admin-card-sort select option:checked')).toHaveText('Status', { timeout: 3000 });
    await expect(page.locator('.admin-card-sort-dir')).toContainText('Ascending', { timeout: 3000 });
  });

  test('AC12 Status ranks Broken, Draft, Published, Closed; ties by next milestone, then title regardless of case', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    expect(await titles(page), 'Status ascending, the default').toEqual(STATUS_ASC_ORDER);
  });

  test('AC12 sorting by the same key twice gives the same order', async ({ page, baseURL }) => {
    await open(page, baseURL);
    const first = await titles(page);
    expect(first, 'the default order').toEqual(STATUS_ASC_ORDER);
    // Away and back: a new field sorts ascending.
    await header(page, 'Study').locator('button').click({ timeout: 3000 });
    await expect(header(page, 'Study')).toHaveAttribute('aria-sort', 'ascending', { timeout: 3000 });
    await header(page, 'Status').locator('button').click({ timeout: 3000 });
    await expect(header(page, 'Status')).toHaveAttribute('aria-sort', 'ascending', { timeout: 3000 });
    expect(await titles(page), 'Status ascending after Study').toEqual(first);
    // Through descending and back.
    await header(page, 'Status').locator('button').click({ timeout: 3000 });
    await expect(header(page, 'Status')).toHaveAttribute('aria-sort', 'descending', { timeout: 3000 });
    await header(page, 'Status').locator('button').click({ timeout: 3000 });
    await expect(header(page, 'Status')).toHaveAttribute('aria-sort', 'ascending', { timeout: 3000 });
    expect(await titles(page), 'Status ascending after descending').toEqual(first);
  });

  test('AC13 Next / deadline sorts soonest first, with no-milestone rows last in both directions', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    const next = header(page, NEXT_HEADER);
    await expect(next.locator('button'), 'the Next / deadline header is a sort button').toHaveCount(1, {
      timeout: 3000,
    });
    await expect(next, 'an unsorted Next header says so').toHaveAttribute('aria-sort', 'none');

    await next.locator('button').click({ timeout: 3000 });
    await expect(next).toHaveAttribute('aria-sort', 'ascending', { timeout: 3000 });
    await expect(header(page, 'Status')).toHaveAttribute('aria-sort', 'none');
    expectGroupedOrder(await titles(page), [...NEXT_ASC_GROUPS, NO_MILESTONE], 'Next ascending');

    await next.locator('button').click({ timeout: 3000 });
    await expect(next).toHaveAttribute('aria-sort', 'descending', { timeout: 3000 });
    expectGroupedOrder(await titles(page), [...[...NEXT_ASC_GROUPS].reverse(), NO_MILESTONE], 'Next descending');
  });

  test('AC14 the Sort by control offers Next / deadline and moves the header sort with it', async ({ page, baseURL }) => {
    await open(page, baseURL, { width: 1100 });
    const select = page.locator('.admin-card-sort select');
    await expect(select.locator('option'), 'Sort by options').toHaveText(['Study', 'Status', NEXT_HEADER, 'Created']);
    await select.selectOption({ label: NEXT_HEADER }, { timeout: 3000 });
    await expect(header(page, NEXT_HEADER)).toHaveAttribute('aria-sort', 'ascending', { timeout: 3000 });
    await header(page, 'Status').locator('button').click({ timeout: 3000 });
    await expect(select.locator('option:checked')).toHaveText('Status', { timeout: 3000 });
  });
});

test.describe('Admin studies table triage: Next note warning horizon', () => {
  for (const theme of THEMES) {
    test(`the Next note turns warning colour inside 3 days, not at 3 days 1 hour and never on a closed study, at >= 4.5:1 (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await open(page, baseURL, { theme });
      const colours = await page.evaluate(
        ({ warned, notWarned, nextHeader, closedTitle }) => {
          const p = window.__adminProbe;
          const noteOf = (title: string) => {
            const r = p.rows().find((tr) => p.cell(tr, 'Study')?.querySelector(`[title="${CSS.escape(title)}"]`));
            const note = r ? p.cell(r, nextHeader)?.querySelector('.admin-next__note') : null;
            return note as HTMLElement | null;
          };
          const read = (titles: Record<string, string>) =>
            Object.fromEntries(
              Object.entries(titles).map(([k, t]) => {
                const note = noteOf(t);
                return [k, note ? getComputedStyle(note).color : 'no note'];
              })
            );
          // Tagged for the contrast measurement below.
          for (const t of Object.values(warned)) noteOf(t)?.setAttribute('data-e2e-warned', '');
          return { warned: read(warned), notWarned: read(notWarned), closed: read({ closed: closedTitle }).closed };
        },
        { warned: WARNED, notWarned: NOT_WARNED, nextHeader: NEXT_HEADER, closedTitle: CLOSED_INSIDE_HORIZON }
      );
      const failures: string[] = [];
      const w = colours.warned;
      const n = colours.notWarned;
      if (Object.values({ ...w, ...n }).includes('no note')) failures.push(`a Next note is missing: ${JSON.stringify(colours)}`);
      if (new Set(Object.values(w)).size !== 1) failures.push(`warned notes disagree: ${JSON.stringify(w)}`);
      // Same kind, either side of the horizon: the colour must differ.
      if (w.deadline === n.deadline) failures.push(`deadline at +2d23h and +3d1h share ${w.deadline}`);
      if (w.deadline2 === n.deadline2) failures.push(`deadline at +1d14h and +5d14h share ${w.deadline2}`);
      if (w.session === n.session) failures.push(`session at +1d6h and next year share ${w.session}`);
      // A closed study inside the horizon: no note at all, or not the warning ink.
      if (colours.closed === w.deadline) failures.push(`the closed study closing at +2d7h is warning-coloured (${colours.closed})`);
      expect(failures).toEqual([]);

      // Contrast of the warning colour, against the lightest ground it can sit on.
      const contrast = await measureGroundContrast(page, ['[data-e2e-warned]']);
      expect(contrast.measured, 'warned notes measured').toBeGreaterThanOrEqual(3);
      expect(contrast.failures, 'warning note contrast').toEqual([]);
    });
  }
});

test.describe('Admin studies table triage: Broken, three ways (AC16)', () => {
  test('AC16 the Status filter has a Broken option, applied client-side: no status goes over the wire', async ({
    page,
    baseURL,
  }) => {
    const api = await open(page, baseURL);
    const select = page.locator('#statusFilter');
    await expect(select.locator('option'), 'Status options').toHaveText([
      'All Statuses',
      'Broken',
      'Draft',
      'Published',
      'Closed',
    ]);
    const before = api.listQueries.length;
    await select.selectOption({ label: 'Broken' }, { timeout: 3000 });
    await expect(rows(page), 'rows under Status: Broken').toHaveCount(BROKEN.length, { timeout: 5000 });
    expect([...(await titles(page))].sort(), 'the broken studies').toEqual([...BROKEN].sort());
    // The Status select filters the loaded list (so "N of M" and Needs
    // attention read one list): no list request carries a status, then or before.
    const withStatus = api.listQueries.filter((q) => new URLSearchParams(q).has('status'));
    expect(withStatus, 'list requests carrying a status filter').toEqual([]);
    expect(api.listQueries.length, 'list requests (the load, and at most a refetch)').toBeGreaterThanOrEqual(before);
  });

  test('AC16 a Broken chip leads the quick filters, every chip shows its count, and Broken shows the broken rows', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    const shown = await chips(page).evaluateAll((els) =>
      els.map((el) => {
        const m = (el.textContent ?? '').replace(/\s+/g, ' ').trim().match(/^(.*?)\s*(\d+)$/);
        return m ? [m[1], Number(m[2])] : [(el.textContent ?? '').trim(), null];
      })
    );
    expect(shown, 'chips, in order, with counts').toEqual(CHIPS);
    await chip(page, 'Broken').click({ timeout: 3000 });
    await expect(chip(page, 'Broken')).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
    await expect(rows(page)).toHaveCount(BROKEN.length, { timeout: 3000 });
    expect([...(await titles(page))].sort()).toEqual([...BROKEN].sort());
  });

  test('a zero-count chip is disabled, not hidden, and no chip moves between filter states', async ({ page, baseURL }) => {
    await open(page, baseURL);
    const empty = chip(page, 'Fully booked');
    await expect(empty, 'the zero-count chip is still shown').toBeVisible();
    const disabled = await empty.evaluate(
      (el) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
    );
    expect(disabled, 'the Fully booked chip (0) is disabled').toBe(true);
    await empty.click({ force: true, timeout: 3000 });
    await expect(empty, 'a disabled chip does not press').toHaveAttribute('aria-pressed', 'false');
    await expect(rows(page)).toHaveCount(MINE_COUNT);

    const boxes = () =>
      chips(page).evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return `${(el.textContent ?? '').replace(/\d+/g, '').trim()} ${r.left.toFixed(1)},${r.top.toFixed(1)} ${r.width.toFixed(1)}x${r.height.toFixed(1)}`;
        })
      );
    const rest = await boxes();
    const failures: string[] = [];
    for (const label of ['Broken', 'Draft', 'Closing soon', 'Needs recruitment']) {
      await chip(page, label).click({ timeout: 3000 });
      await expect(chip(page, label)).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
      const pressed = await boxes();
      if (JSON.stringify(pressed) !== JSON.stringify(rest)) failures.push(`${label} pressed: ${pressed.join('; ')}`);
      await chip(page, label).click({ timeout: 3000 });
      await expect(chip(page, label)).toHaveAttribute('aria-pressed', 'false', { timeout: 3000 });
    }
    expect(failures, `chip boxes at rest: ${rest.join('; ')}`).toEqual([]);
  });

  test('AC16 Needs attention shows "3 studies broken" and its link applies the Broken chip', async ({ page, baseURL }) => {
    await open(page, baseURL);
    const card = page.locator('.admin-attention button, .admin-attention a').filter({ hasText: /studies broken/ });
    await expect(card, 'the broken card').toHaveCount(1, { timeout: 3000 });
    await expect(card).toContainText('3 studies broken');
    await card.click({ timeout: 3000 });
    await expect(chip(page, 'Broken')).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
    await expect(rows(page)).toHaveCount(BROKEN.length, { timeout: 3000 });
    expect(new URL(page.url()).pathname).toBe('/admin');
  });

  test('AC16 one broken study reads "1 study broken" and opens that study', async ({ page, baseURL }) => {
    // The seed with two of its three broken studies left out.
    const oneBroken = OPPORTUNITIES.filter((s) => s.title !== BROKEN[0] && s.title !== BROKEN[1]);
    await open(page, baseURL, { api: makeApi(oneBroken), expectedRows: oneBroken.length });
    const card = page.locator('.admin-attention button, .admin-attention a').filter({ hasText: /broken/ });
    await expect(card).toHaveCount(1, { timeout: 3000 });
    await expect(card).toContainText('1 study broken');
    await expect(chip(page, 'Broken')).toHaveText(/^\s*Broken\s*1\s*$/);
    await sinkApiForNavigation(page);
    await card.click({ timeout: 3000 });
    await expect(page).toHaveURL(new RegExp(`/admin/opportunities/${idOf(BROKEN[2])}/edit$`), { timeout: 5000 });
  });

  test('AC16 with nothing broken there is no broken card, and the Broken chip is 0 and disabled', async ({
    page,
    baseURL,
  }) => {
    const noneBroken = OPPORTUNITIES.filter((s) => !BROKEN.includes(s.title));
    await open(page, baseURL, { api: makeApi(noneBroken), expectedRows: noneBroken.length });
    // Arm: the panel rendered its other cards, so an absent card is absent, not unrendered.
    await expect(page.locator('.admin-attention').getByText(/approval waiting/)).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.admin-attention').getByText(/broken/i)).toHaveCount(0);
    await expect(chip(page, 'Broken')).toHaveText(/^\s*Broken\s*0\s*$/);
    await expect(chip(page, 'Broken')).toBeDisabled();
  });

  test('a filtered list says "N of M studies"; an unfiltered one does not', async ({ page, baseURL }) => {
    await open(page, baseURL);
    const count = page.getByText(/^\s*\d+ of \d+ stud(y|ies)\s*$/);
    await expect(count, 'no count without a filter').toHaveCount(0);
    // Search first: it exists on main too, so main fails here on the count
    // itself rather than on a missing chip.
    await page.locator('#searchFilter').fill('release');
    await expect(rows(page), 'the search narrowed the table').toHaveCount(2, { timeout: 3000 });
    await expect(count, 'count under a search').toHaveText('2 of 20 studies', { timeout: 3000 });
    await page.getByRole('button', { name: 'Clear filters' }).first().click({ timeout: 3000 });
    await expect(count, 'no count once cleared').toHaveCount(0, { timeout: 3000 });
    await chip(page, 'Broken').click({ timeout: 3000 });
    await expect(count, 'count under the Broken chip').toHaveText('3 of 20 studies', { timeout: 3000 });
  });
});

test.describe('Admin studies table triage: row actions (AC15)', () => {
  test('AC15 every title is a link to its edit page, and a row click opens the same URL', async ({ page, baseURL }) => {
    await open(page, baseURL);
    const links = await page.evaluate(() => {
      const p = window.__adminProbe;
      return p.rows().map((r) => {
        const a = p.cell(r, 'Study')?.querySelector('a[href]') as HTMLAnchorElement | null;
        return a ? [p.norm(a.textContent), new URL(a.href).pathname] : ['(no link)', ''];
      });
    });
    const want = STATUS_ASC_ORDER.map((t) => [t, `/admin/opportunities/${idOf(t)}/edit`]);
    expect(links, 'title links, in table order').toEqual(want);

    await sinkApiForNavigation(page);
    // A plain cell, away from every control.
    await row(page, PUBLISHED_MINE).locator('td').nth(2).click({ timeout: 3000 });
    await expect(page).toHaveURL(new RegExp(`/admin/opportunities/${idOf(PUBLISHED_MINE)}/edit$`), { timeout: 5000 });
  });

  test('AC15 Tab goes title link, action link, kebab, row by row; Enter on a title opens its edit page', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    // The last header control before the body.
    await header(page, 'Created').locator('button').focus();
    const stops: string[] = [];
    for (let i = 0; i < MINE_COUNT * 3; i += 1) {
      await page.keyboard.press('Tab');
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || !el.closest('table.admin-data-table tbody')) return `outside: ${el?.tagName ?? 'nothing'}`;
          const row = el.closest('tr')!;
          const title = row.querySelector('td [title]')?.getAttribute('title') ?? '?';
          const kind = el.matches('.row-title')
            ? 'title'
            : el.matches('.admin-action-btn-kebab')
              ? 'kebab'
              : el.matches('.admin-action-primary')
                ? `action ${el.tagName.toLowerCase()}`
                : `other ${el.tagName.toLowerCase()}`;
          return `${title} > ${kind}`;
        })
      );
    }
    const want = STATUS_ASC_ORDER.flatMap((t) => [`${t} > title`, `${t} > action a`, `${t} > kebab`]);
    expect(stops, 'Tab stops through the table body, in order').toEqual(want);

    const link = row(page, PUBLISHED_MINE).getByRole('link', { name: PUBLISHED_MINE, exact: true });
    await link.focus();
    await sinkApiForNavigation(page);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/admin/opportunities/${idOf(PUBLISHED_MINE)}/edit$`), { timeout: 5000 });
  });

  test('AC15 the kebab opens on Enter and Space, arrows move, Escape closes and returns focus', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    const trigger = kebab(page, PUBLISHED_MINE);
    const menu = page.locator('.admin-action-dropdown-menu');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(menu, 'Enter opens the menu').toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true }), 'focus starts on Edit').toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Preview as participant' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu, 'Escape closes the menu').toHaveCount(0, { timeout: 3000 });
    await expect(trigger, 'Escape returns focus to the kebab').toBeFocused();
    await page.keyboard.press(' ');
    await expect(menu, 'Space opens the menu').toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  test("the inline action is the state's next verb for a manager (Fix, Edit, Analytics) and Preview for anyone else", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await toggleShowAll(page, ALL_COUNT);
    const verbs = await page.evaluate(() => {
      const p = window.__adminProbe;
      return Object.fromEntries(
        p.rows().map((r) => {
          const title = p.cell(r, 'Study')?.querySelector('[title]')?.getAttribute('title') ?? '?';
          const actions = p.cell(r, 'Actions');
          const primary = actions
            ? [...actions.querySelectorAll('a[href], button')].find((el) => !el.closest('.dropdown'))
            : null;
          return [title, primary ? p.norm(primary.textContent) : '(none)'];
        })
      );
    });
    const want = Object.fromEntries(
      STEP2_ALL.map((s) => [
        s.title,
        s.owner_user_id !== ADMIN_ME.id
          ? 'Preview'
          : BROKEN.includes(s.title ?? '')
            ? 'Fix'
            : s.status === 'draft'
              ? 'Edit'
              : 'Analytics',
      ])
    );
    expect(verbs).toEqual(want);
  });

  for (const [verb, title, path] of [
    ['Fix', BROKEN[2], (id: string) => `/admin/opportunities/${id}/edit`],
    ['Analytics', PUBLISHED_MINE, (id: string) => `/admin/opportunities/${id}/analytics`],
    ['Preview', OTHER_PUBLISHED, (id: string) => `/opportunities/${id}`],
  ] as const) {
    test(`the inline ${verb} opens ${path(':id')}`, async ({ page, baseURL }) => {
      await open(page, baseURL);
      if (verb === 'Preview') await toggleShowAll(page, ALL_COUNT);
      const button = row(page, title).locator('td').last().getByText(verb, { exact: true });
      await sinkApiForNavigation(page);
      await button.click({ timeout: 3000 });
      await expect(page).toHaveURL(new RegExp(`${path(idOf(title)).replace(/\//g, '\\/')}$`), { timeout: 5000 });
    });
  }

  test('the row menu reads Edit, Preview as participant, Analytics, Copy | Close study | Delete on your published study', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await openMenu(page, PUBLISHED_MINE);
    expect(await menuSequence(page)).toEqual([
      'Edit',
      'Preview as participant',
      'Analytics',
      'Copy',
      '|',
      'Close study',
      '|',
      'Delete',
    ]);
  });

  test('Close study is offered on a published study you own, and on no draft, closed or other researcher\'s study', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await toggleShowAll(page, ALL_COUNT);
    const failures: string[] = [];
    for (const [title, offered] of [
      [PUBLISHED_MINE, true],
      [DRAFT, false],
      ['Bitbucket pipeline templates', false],
      ['Search relevance: which result did you want?', false],
      [OTHER_PUBLISHED, false],
      [UNNAMED_OWNER_STUDY, false],
    ] as const) {
      await openMenu(page, title);
      const seq = await menuSequence(page);
      const live = seq.includes('Close study');
      if (live !== offered) failures.push(`"${title}": [${seq.join(', ')}]`);
      await page.keyboard.press('Escape');
      await expect(page.locator('.admin-action-dropdown-menu')).toHaveCount(0, { timeout: 3000 });
    }
    expect(failures).toEqual([]);
  });
});

test.describe('Admin studies table triage: Close study and Undo', () => {
  const closeFromMenu = async (page: Page, title: string) => {
    await openMenu(page, title);
    await page.getByRole('menuitem', { name: 'Close study' }).click({ timeout: 3000 });
  };
  const notice = (page: Page, title: string) =>
    page.getByRole('status').filter({ hasText: `Closed “${title}”` });

  test('Close study closes the row in place and offers a focused Undo in a status notice', async ({ page, baseURL }) => {
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api);
    await closeFromMenu(page, PUBLISHED_MINE);

    await expect(notice(page, PUBLISHED_MINE), 'the undo notice').toBeVisible({ timeout: 3000 });
    const undo = notice(page, PUBLISHED_MINE).getByRole('button', { name: 'Undo' });
    await expect(undo, 'focus moves to Undo').toBeFocused({ timeout: 3000 });
    expect(api.patches, 'one PATCH, closing the study').toEqual([{ id: idOf(PUBLISHED_MINE), body: { status: 'closed' } }]);
    await expect(row(page, PUBLISHED_MINE).locator('.admin-study-status__label')).toHaveText(/^closed$/i, { timeout: 3000 });
    await expect(row(page, PUBLISHED_MINE).getByText(/auto-closed/i), 'a hand close is not captioned Auto-closed').toHaveCount(0);
    await expect(rows(page)).toHaveCount(MINE_COUNT);
  });

  test('Undo reopens the study', async ({ page, baseURL }) => {
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api);
    await closeFromMenu(page, PUBLISHED_MINE);
    await notice(page, PUBLISHED_MINE).getByRole('button', { name: 'Undo' }).click({ timeout: 3000 });
    await expect(notice(page, PUBLISHED_MINE), 'the notice goes once undone').toHaveCount(0, { timeout: 3000 });
    expect(api.patches.map((p) => p.body), 'close, then reopen').toEqual([{ status: 'closed' }, { status: 'published' }]);
    await expect(row(page, PUBLISHED_MINE).locator('.admin-study-status__label')).toHaveText(/^published$/i, {
      timeout: 3000,
    });
    await expect(titleLink(page, PUBLISHED_MINE), 'focus returns to the study, not <body>').toBeFocused({ timeout: 3000 });
  });

  test('the undo notice dismisses itself after 8 seconds', async ({ page, baseURL }) => {
    test.setTimeout(45000);
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api);
    // Timed in the page, from the notice's insertion to its removal.
    await page.evaluate((title) => {
      const w = window as unknown as { __undoTimes: { shown?: number; gone?: number } };
      w.__undoTimes = {};
      const find = () =>
        [...document.querySelectorAll('[role="status"]')].find((el) => el.textContent?.includes(`Closed “${title}”`));
      new MutationObserver(() => {
        const present = Boolean(find());
        if (present && w.__undoTimes.shown === undefined) w.__undoTimes.shown = performance.now();
        if (!present && w.__undoTimes.shown !== undefined && w.__undoTimes.gone === undefined) {
          w.__undoTimes.gone = performance.now();
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, PUBLISHED_MINE);
    await closeFromMenu(page, PUBLISHED_MINE);
    await expect(notice(page, PUBLISHED_MINE)).toBeVisible({ timeout: 3000 });
    await expect(notice(page, PUBLISHED_MINE), 'the notice never dismissed itself').toHaveCount(0, { timeout: 15000 });
    const t = await page.evaluate(() => (window as unknown as { __undoTimes: { shown: number; gone: number } }).__undoTimes);
    const shownFor = t.gone - t.shown;
    expect(shownFor, `notice shown for ${shownFor.toFixed(0)}ms`).toBeGreaterThanOrEqual(UNDO_MS - 100);
    expect(shownFor, `notice shown for ${shownFor.toFixed(0)}ms`).toBeLessThanOrEqual(UNDO_MS + 1000);
    // Lapsing is not undoing: still closed, and no reopen was sent.
    expect(api.patches.map((p) => p.body)).toEqual([{ status: 'closed' }]);
    await expect(row(page, PUBLISHED_MINE).locator('.admin-study-status__label')).toHaveText(/^closed$/i);
  });

  test("an Undo the server refuses shows the server's reason and leaves the row closed", async ({ page, baseURL }) => {
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api, { refuseReopen: idOf(REOPEN_REFUSED_STUDY) });
    await closeFromMenu(page, REOPEN_REFUSED_STUDY);
    await notice(page, REOPEN_REFUSED_STUDY).getByRole('button', { name: 'Undo' }).click({ timeout: 3000 });
    const alert = page.getByRole('alert').filter({ hasText: `Could not reopen “${REOPEN_REFUSED_STUDY}”: ${REOPEN_REFUSAL}` });
    await expect(alert, "the server's reason, in an alert").toBeVisible({ timeout: 3000 });
    expect(api.patches.map((p) => p.body)).toEqual([{ status: 'closed' }, { status: 'published' }]);
    await expect(row(page, REOPEN_REFUSED_STUDY).locator('.admin-study-status__label')).toHaveText(/^closed$/i);
    await expect(alert, 'the alert takes focus').toBeFocused({ timeout: 3000 });
    const neighbours = await slotNeighbours(page, REOPEN_REFUSED_STUDY);
    await alert.getByRole('button', { name: 'Dismiss' }).click({ timeout: 3000 });
    await expect(alert).toHaveCount(0, { timeout: 3000 });
    await expectHandOff(page, REOPEN_REFUSED_STUDY, neighbours, 'Dismiss');
  });

  test('a Close the server fails shows "Could not close" and leaves the row published', async ({ page, baseURL }) => {
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api, { failClose: idOf(PUBLISHED_MINE) });
    await closeFromMenu(page, PUBLISHED_MINE);
    const alert = page.getByRole('alert').filter({ hasText: `Could not close “${PUBLISHED_MINE}”. Please try again.` });
    await expect(alert, 'the close failure, in an alert').toBeVisible({ timeout: 3000 });
    await expect(notice(page, PUBLISHED_MINE), 'no undo notice for a close that did not happen').toHaveCount(0);
    expect(api.patches.map((p) => p.body)).toEqual([{ status: 'closed' }]);
    await expect(row(page, PUBLISHED_MINE).locator('.admin-study-status__label')).toHaveText(/^published$/i);
  });
});

test.describe('Admin studies table triage: owner, caption and dates', () => {
  test('AC18 the owner joins the meta line only under Show all researchers, between the type pill and the purpose', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    const read = () =>
      page.evaluate((studies) => {
        const p = window.__adminProbe;
        return p.rows().map((r) => {
          const study = p.cell(r, 'Study')!;
          const title = study.querySelector('[title]')?.getAttribute('title') ?? '?';
          const s = studies.find((x) => x.title === title);
          const ownerText = s ? s.owner_name || s.owner_email || '' : '';
          const link = study.querySelector('[title]');
          const pill = study.querySelector('.admin-pill');
          const purpose = s?.purpose_one_liner
            ? study.querySelector(`[title="${CSS.escape(s.purpose_one_liner)}"]`)
            : null;
          // The deepest element naming the owner outside the title and the
          // purpose (it may carry a visually hidden "Owner: " prefix).
          const naming = ownerText
            ? [...study.querySelectorAll('*')].filter(
                (el) =>
                  p.norm(el.textContent).includes(ownerText) &&
                  !(link && (el === link || el.contains(link) || link.contains(el))) &&
                  !(purpose && (el === purpose || el.contains(purpose) || purpose.contains(el)))
              )
            : [];
          const owner = naming.find((el) => !naming.some((o) => o !== el && el.contains(o))) ?? null;
          const before = (a: Element | null, b: Element | null) =>
            Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
          const sameLine = (a: Element | null, b: Element | null) => {
            if (!a || !b) return false;
            const x = a.getBoundingClientRect();
            const y = b.getBoundingClientRect();
            return Math.abs(x.top + x.height / 2 - (y.top + y.height / 2)) < 6;
          };
          return {
            title,
            ownerText,
            shown: Boolean(owner && p.shown(owner)),
            ordered: before(pill, owner) && before(owner, purpose),
            oneLine: sameLine(pill, owner) && sameLine(owner, purpose),
          };
        });
      }, STEP2_ALL.map((s) => ({ title: s.title, owner_name: s.owner_name, owner_email: s.owner_email, purpose_one_liner: s.purpose_one_liner })));

    const off = await read();
    expect(off.filter((r) => r.shown).map((r) => r.title), 'owners shown with Show all researchers OFF').toEqual([]);

    await toggleShowAll(page, ALL_COUNT);
    const on = await read();
    const failures = on
      .filter((r) => !r.shown || !r.ordered || !r.oneLine)
      .map((r) => `"${r.title}": owner "${r.ownerText}" shown ${r.shown}, pill<owner<purpose ${r.ordered}, one line ${r.oneLine}`);
    expect(failures, 'owner on every meta line with Show all researchers ON').toEqual([]);
    expect(on.find((r) => r.title === UNNAMED_OWNER_STUDY)?.ownerText, 'no name: the email').toBe('sam.lee@adaptavist.com');

    await toggleShowAll(page, MINE_COUNT);
    expect((await read()).filter((r) => r.shown).map((r) => r.title), 'owners after switching back OFF').toEqual([]);
  });

  test('the Auto-closed caption shows for a study the sweep closed, and not for one closed by hand', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    const caption = (title: string) => row(page, title).getByText(/^\s*auto-closed\s*$/i);
    await expect(caption('Recorded: first-run onboarding'), 'auto_closed true').toHaveCount(1);
    await expect(caption('Bitbucket pipeline templates'), 'auto_closed true').toHaveCount(1);
    await expect(row(page, 'Search relevance: which result did you want?').locator('.admin-study-status__label')).toHaveText(
      /^closed$/i
    );
    await expect(caption('Search relevance: which result did you want?'), 'auto_closed false').toHaveCount(0);
  });

  test('dates read "Thu 24 Sept" this year and carry the year otherwise; a session time stays on line 2', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    const lines = (title: string, column: string) =>
      page.evaluate(
        ({ title, column }) => {
          const p = window.__adminProbe;
          const r = p.rows().find((tr) => p.cell(tr, 'Study')?.querySelector(`[title="${CSS.escape(title)}"]`));
          const c = r ? p.cell(r, column) : null;
          return c ? c.innerText.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean) : ['(no cell)'];
        },
        { title, column }
      );
    const got = {
      nextThisYear: await lines('Server to Cloud migration: what actually hurt', NEXT_HEADER),
      createdThisYear: await lines('Server to Cloud migration: what actually hurt', 'Created'),
      deadlineThisYear: (await lines('Developer experience pulse, Q3', NEXT_HEADER))[0],
      nextNextYear: await lines('2027 roadmap interviews', NEXT_HEADER),
      createdLastYear: await lines('2027 roadmap interviews', 'Created'),
    };
    expect(got).toEqual({
      nextThisYear: ['Thu 24 Sept', '16:00 · Tomorrow'],
      createdThisYear: ['Mon 14 Sept'],
      deadlineThisYear: 'Fri 25 Sept',
      nextNextYear: ['Thu 14 Jan 2027', '10:00'],
      createdLastYear: ['Tue 4 Nov 2025'],
    });

    // GUARD (holds on main): the Next cell's ink stays inside it at each table width.
    const failures: string[] = [];
    for (const width of [1024, 1280, 1440]) {
      await resizeTo(page, width);
      const out = await page.evaluate((nextHeader) => {
        const p = window.__adminProbe;
        return p.rows().flatMap((r) => {
          const c = p.cell(r, nextHeader);
          if (!c) return ['no Next column'];
          const b = c.getBoundingClientRect();
          const cs = getComputedStyle(c);
          const box = {
            left: b.left + parseFloat(cs.paddingLeft),
            right: b.right - parseFloat(cs.paddingRight),
            top: b.top,
            bottom: b.bottom,
          };
          return p.inkOutside(c, box).map((o) => `${o.what} ${o.box.left.toFixed(0)}-${o.box.right.toFixed(0)} outside ${box.left.toFixed(0)}-${box.right.toFixed(0)}`);
        });
      }, NEXT_HEADER);
      for (const f of out) failures.push(`${width}px: ${f}`);
    }
    expect(failures).toEqual([]);
  });
});

test.describe('Admin studies table triage: sticky header and menu placement', () => {
  /** The bottom of a fixed or sticky site header in view, else 0: where a sticky thead should sit. */
  const stickyTopFor = (page: Page) =>
    page.evaluate(() => {
      const candidates = [...document.querySelectorAll('header, nav, .navbar, .app-header')].filter(
        (el) => !el.closest('table')
      );
      let top = 0;
      for (const el of candidates) {
        const pos = getComputedStyle(el).position;
        const r = el.getBoundingClientRect();
        if ((pos === 'fixed' || pos === 'sticky') && r.top <= 0.5 && r.bottom > top && r.height > 0) top = r.bottom;
      }
      return top;
    });

  const scrollTableUnder = async (page: Page, by: number) => {
    await page.evaluate((px) => {
      const thead = document.querySelector('table.admin-data-table thead')!;
      window.scrollTo(0, thead.getBoundingClientRect().top + window.scrollY + px);
    }, by);
    await resizeTo(page, page.viewportSize()!.width, page.viewportSize()!.height);
  };

  for (const theme of THEMES) {
    for (const width of [1024, 1280, 1440, 1920]) {
      test(`the header row sticks under the site header while the table scrolls at ${width}px (${theme})`, async ({
        page,
        baseURL,
      }) => {
        await open(page, baseURL, { width, theme });
        await scrollTableUnder(page, 400);
        const offset = await stickyTopFor(page);
        // Every header CELL, not the <thead> box: sticky may sit on either,
        // and the cells are what the reader sees and clicks.
        const cells = await page.evaluate(() =>
          [...document.querySelectorAll('table.admin-data-table thead th')]
            .filter((th) => th.getBoundingClientRect().width > 0)
            .map((th) => {
              const r = th.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return {
                label: (th.textContent ?? '').replace(/\s+/g, ' ').trim(),
                top: r.top,
                onTop: Boolean(hit && th.contains(hit)),
                hit: hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}` : 'nothing',
              };
            })
        );
        expect(cells.length, 'header cells shown').toBeGreaterThanOrEqual(5);
        const failures = cells.flatMap((c) => [
          ...(Math.abs(c.top - offset) > 1 ? [`${c.label}: top ${c.top.toFixed(1)} vs sticky offset ${offset.toFixed(1)}`] : []),
          ...(c.onTop ? [] : [`${c.label}: covered by ${c.hit}`]),
        ]);
        expect(failures).toEqual([]);
      });
    }
  }

  // GUARD on main (no sticky header there). Control arm: the sticky test above.
  test('a row menu opened just under the sticky header paints above it', async ({ page, baseURL }) => {
    await open(page, baseURL, { width: 1440 });
    await scrollTableUnder(page, 400);
    // The first row whose kebab is fully below the header row.
    const title = await page.evaluate(() => {
      const p = window.__adminProbe;
      const theadBottom = Math.max(
        ...[...document.querySelectorAll('table.admin-data-table thead th')].map((th) => th.getBoundingClientRect().bottom)
      );
      const r = p
        .rows()
        .find((tr) => tr.querySelector('.admin-action-btn-kebab')!.getBoundingClientRect().top >= Math.max(theadBottom, 0) + 2);
      return r ? p.cell(r, 'Study')!.querySelector('[title]')!.getAttribute('title') : null;
    });
    expect(title, 'a row just under the header').toBeTruthy();
    await kebab(page, title!).click({ timeout: 3000 });
    const covered = await page.locator('.admin-action-dropdown-menu [role="menuitem"]').evaluateAll((items) =>
      items
        .map((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit && (hit === el || el.contains(hit)) ? null : `${el.textContent?.trim()} under ${hit?.tagName ?? 'nothing'}`;
        })
        .filter(Boolean)
    );
    expect(covered).toEqual([]);
  });

  for (const theme of THEMES) {
    for (const width of [1024, 1280, 1440, 1920]) {
      test(`a row menu near the bottom of the viewport opens upward, on screen and clear of the footer, at ${width}px (${theme})`, async ({
        page,
        baseURL,
      }) => {
        await open(page, baseURL, { width, theme });
        const title = STATUS_ASC_ORDER[10];
        const trigger = kebab(page, title);
        await trigger.scrollIntoViewIfNeeded({ timeout: 3000 });
        // Put the kebab 40px above whatever ends the usable viewport.
        const limit = await page.evaluate(() => {
          const footer = document.querySelector('footer.feedback-footer');
          const top = footer ? footer.getBoundingClientRect().top : Infinity;
          return top > 0 && top < window.innerHeight ? top : window.innerHeight;
        });
        const k0 = await trigger.boundingBox();
        await page.evaluate((dy) => window.scrollBy(0, dy), k0!.y + k0!.height - (limit - 40));
        const k = (await trigger.boundingBox())!;
        expect(Math.abs(k.y + k.height - (limit - 40)), `kebab placed ${(k.y + k.height).toFixed(0)} vs ${limit - 40}`).toBeLessThanOrEqual(2);

        await trigger.click({ timeout: 3000 });
        const menu = page.locator('.admin-action-dropdown-menu');
        await expect(menu).toBeVisible({ timeout: 3000 });
        const m = await menu.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const footer = document.querySelector('footer.feedback-footer');
          const ft = footer ? footer.getBoundingClientRect().top : Infinity;
          const covered = [...el.querySelectorAll('[role="menuitem"]')]
            .map((item) => {
              const b = item.getBoundingClientRect();
              const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              return hit && (hit === item || item.contains(hit)) ? null : `${item.textContent?.trim()} under ${hit?.tagName.toLowerCase() ?? 'nothing'}`;
            })
            .filter(Boolean);
          return { top: r.top, bottom: r.bottom, innerHeight: window.innerHeight, footerTop: ft, covered };
        });
        const failures: string[] = [];
        if (m.bottom > k.y + 1) failures.push(`menu bottom ${m.bottom.toFixed(0)} is below the kebab top ${k.y.toFixed(0)}: it opened downward`);
        if (m.top < 0) failures.push(`menu top ${m.top.toFixed(0)} is off the top of the viewport`);
        if (m.bottom > Math.min(m.innerHeight, m.footerTop) + 0.5) failures.push(`menu bottom ${m.bottom.toFixed(0)} runs past ${Math.min(m.innerHeight, m.footerTop).toFixed(0)}`);
        failures.push(...(m.covered as string[]));
        expect(failures).toEqual([]);
        // The user outcome: Delete opens its confirmation.
        await page.getByRole('menuitem', { name: 'Delete' }).click({ timeout: 3000 });
        await expect(page.getByText('Delete Research Study')).toBeVisible({ timeout: 3000 });
      });
    }
  }

  // GUARD on main. Control arm: the flip-up tests above, which fail there.
  test('a row menu with room below still opens downward', async ({ page, baseURL }) => {
    await open(page, baseURL, { width: 1440 });
    const trigger = kebab(page, STATUS_ASC_ORDER[0]);
    await trigger.scrollIntoViewIfNeeded({ timeout: 3000 });
    const k0 = (await trigger.boundingBox())!;
    await page.evaluate((dy) => window.scrollBy(0, dy), k0.y - 250);
    const k = (await trigger.boundingBox())!;
    await trigger.click({ timeout: 3000 });
    const r = await page.locator('.admin-action-dropdown-menu').evaluate((el) => el.getBoundingClientRect().toJSON());
    expect(r.top, `menu top ${r.top} vs kebab bottom ${k.y + k.height}`).toBeGreaterThanOrEqual(k.y + k.height - 1);
  });

  // GUARD on main: the other Dropdown users - the header's profile menu.
  test('the header profile menu still opens downward and on screen', async ({ page, baseURL }) => {
    await open(page, baseURL, { width: 1440 });
    const trigger = page.locator('.header-actions--desktop .dropdown-toggle, header .nav-items .dropdown-toggle').first();
    await expect(trigger, 'the profile menu trigger').toBeVisible({ timeout: 3000 });
    await trigger.click({ timeout: 3000 });
    const menu = page.locator('header .dropdown-menu.show, .nav-items .dropdown-menu.show').first();
    await expect(menu).toBeVisible({ timeout: 3000 });
    const t = (await trigger.boundingBox())!;
    const m = (await menu.boundingBox())!;
    expect(m.y, 'opens below its trigger').toBeGreaterThanOrEqual(t.y + t.height - 1);
    expect(m.y + m.height, 'fits the viewport').toBeLessThanOrEqual(900);
  });
});

test.describe('Admin studies table triage: fix round (REVIEW-STEP2B-visual)', () => {
  const closeFromMenu = async (page: Page, title: string) => {
    await openMenu(page, title);
    await page.getByRole('menuitem', { name: 'Close study' }).click({ timeout: 3000 });
  };
  const statusNotice = (page: Page) => page.locator('table.admin-data-table tbody [role="status"]');
  const alertNotice = (page: Page) => page.locator('table.admin-data-table tbody [role="alert"]');

  for (const theme of THEMES) {
    test(`the undo notice and the error alert clear AA against the lightest ground they sit on (${theme})`, async ({
      page,
      baseURL,
    }) => {
      const api = makeApi();
      await open(page, baseURL, { theme, api });
      await mockPatch(page, api, { refuseReopen: idOf(REOPEN_REFUSED_STUDY) });
      await closeFromMenu(page, REOPEN_REFUSED_STUDY);
      await expect(statusNotice(page), 'the undo notice, in the table').toBeVisible({ timeout: 3000 });
      const undoContrast = await measureGroundContrast(page, ['table.admin-data-table tbody [role="status"]']);
      // Its text and the Undo button's label.
      expect(undoContrast.measured, 'undo notice text nodes measured').toBeGreaterThanOrEqual(2);
      expect(undoContrast.failures, 'undo notice contrast').toEqual([]);

      await statusNotice(page).getByRole('button', { name: 'Undo' }).click({ timeout: 3000 });
      await expect(alertNotice(page), 'the error alert, in the table').toBeVisible({ timeout: 3000 });
      const alertContrast = await measureGroundContrast(page, ['table.admin-data-table tbody [role="alert"]']);
      expect(alertContrast.measured, 'error alert text nodes measured').toBeGreaterThanOrEqual(1);
      expect(alertContrast.failures, 'error alert contrast').toEqual([]);
    });
  }

  for (const width of [1024, 1440]) {
    test(`Close study does not move the page or the row, and its notice sits directly under the row at ${width}px`, async ({
      page,
      baseURL,
    }) => {
      const api = makeApi();
      await open(page, baseURL, { width, api });
      await mockPatch(page, api);
      const target = row(page, PUBLISHED_MINE);
      await target.scrollIntoViewIfNeeded({ timeout: 3000 });
      // The row mid-viewport, where a jump would be seen.
      await page.evaluate((title) => {
        const tr = [...document.querySelectorAll('table.admin-data-table tbody tr')].find((r) =>
          r.querySelector(`[title="${CSS.escape(title)}"]`)
        )!;
        const r = tr.getBoundingClientRect();
        window.scrollBy(0, r.top - window.innerHeight / 2);
      }, PUBLISHED_MINE);
      const measure = () =>
        page.evaluate((title) => {
          const p = window.__adminProbe;
          const all = p.rows();
          const index = all.findIndex((r) => r.querySelector(`[title="${CSS.escape(title)}"]`));
          const tr = all[index];
          const next = tr?.nextElementSibling as HTMLTableRowElement | null;
          const noticeCell = next?.querySelector('[role="status"]') ? next.cells[0] : null;
          return {
            scrollY: window.scrollY,
            index,
            top: tr ? tr.getBoundingClientRect().top : NaN,
            tableWidth: p.table().getBoundingClientRect().width,
            noticeUnder: Boolean(noticeCell),
            noticeWidth: noticeCell ? noticeCell.getBoundingClientRect().width : 0,
            studyCellWidth: tr ? p.cell(tr, 'Study')!.getBoundingClientRect().width : 0,
          };
        }, PUBLISHED_MINE);
      const before = await measure();
      expect(before.noticeUnder, 'no notice before Close').toBe(false);

      await closeFromMenu(page, PUBLISHED_MINE);
      await expect(statusNotice(page)).toBeVisible({ timeout: 3000 });
      await expect(statusNotice(page).getByRole('button', { name: 'Undo' })).toBeFocused({ timeout: 3000 });
      const after = await measure();
      const failures: string[] = [];
      if (Math.abs(after.scrollY - before.scrollY) > 1) failures.push(`page scrolled ${before.scrollY} -> ${after.scrollY}`);
      if (after.index !== before.index) failures.push(`row moved from index ${before.index} to ${after.index}`);
      if (Math.abs(after.top - before.top) > 1) failures.push(`row top ${before.top.toFixed(1)} -> ${after.top.toFixed(1)}`);
      if (!after.noticeUnder) failures.push('the notice is not the row directly under the closed study');
      // It spans the columns on screen: a span wider than the grid adds a
      // phantom column and squeezes every row (colSpan 6 while Created is hidden).
      if (Math.abs(after.noticeWidth - after.tableWidth) > 2) failures.push(`notice ${after.noticeWidth.toFixed(1)}px across a ${after.tableWidth.toFixed(1)}px table`);
      if (Math.abs(after.studyCellWidth - before.studyCellWidth) > 0.5) failures.push(`Study column ${before.studyCellWidth.toFixed(1)} -> ${after.studyCellWidth.toFixed(1)}px`);
      expect(failures).toEqual([]);
    });
  }

  test('a double-click on Close study sends exactly one PATCH and does not navigate', async ({ page, baseURL }) => {
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api);
    // What the second click of the double-click hits: a study row's cell,
    // not a control, with nothing selected. A double-click on a word selects
    // it, and the row's text-selection guard would then hide a missing
    // double-click guard - so the click is aimed at empty cell padding.
    await page.evaluate(() => {
      const w = window as unknown as { __second?: { onRow: boolean; interactive: boolean; selection: string } };
      document.addEventListener(
        'click',
        (e) => {
          if (e.detail !== 2) return;
          const t = e.target as Element;
          w.__second = {
            onRow: Boolean(t.closest('table.admin-data-table tbody tr:not(.admin-inline-notice-row) td')),
            interactive: Boolean(t.closest('a, button, input, select, textarea, [role="button"], .dropdown')),
            selection: window.getSelection()?.toString() ?? '',
          };
        },
        true
      );
    });
    await openMenu(page, PUBLISHED_MINE);
    const item = page.getByRole('menuitem', { name: 'Close study' });
    // Bounded: boundingBox() waits for its element with no timeout of its own.
    await expect(item, 'Close study in the row menu').toBeVisible({ timeout: 3000 });
    const box = (await item.boundingBox())!;
    // The menu overhangs the Created column: aim inside the item, over
    // Created's right padding (its date is left-aligned).
    const createdRight = await header(page, 'Created').evaluate((th) => th.getBoundingClientRect().right);
    const x = createdRight - 4 - box.x;
    expect(x, `a point inside the item over Created's padding (item ${box.x.toFixed(0)}-${(box.x + box.width).toFixed(0)}, Created ends ${createdRight.toFixed(0)})`).toBeGreaterThan(1);
    await item.dblclick({ position: { x, y: box.height / 2 }, timeout: 3000 });
    await expect(page.getByRole('status').filter({ hasText: `Closed “${PUBLISHED_MINE}”` })).toBeVisible({ timeout: 3000 });
    const second = await page.evaluate(() => (window as unknown as { __second?: unknown }).__second);
    expect(second, 'control: the second click hit an empty study cell with nothing selected').toEqual({
      onRow: true,
      interactive: false,
      selection: '',
    });
    expect(new URL(page.url()).pathname, 'the second click navigated').toBe('/admin');
    expect(api.patches, 'PATCHes sent').toEqual([{ id: idOf(PUBLISHED_MINE), body: { status: 'closed' } }]);
  });

  test('a modifier-click on a row cell does not navigate the current tab; a plain click does', async ({
    page,
    baseURL,
    context,
  }) => {
    await open(page, baseURL);
    const cell = row(page, PUBLISHED_MINE).locator('td').nth(2);
    for (const modifiers of [['ControlOrMeta'], ['Shift']] as const) {
      await cell.click({ modifiers: [...modifiers], timeout: 3000 });
      expect(new URL(page.url()).pathname, `${modifiers.join('+')}-click navigated this tab`).toBe('/admin');
    }
    expect(context.pages().length, 'a row cell opened a tab').toBe(1);
    // Control: the same cell, clicked plainly, does navigate.
    await sinkApiForNavigation(page);
    await cell.click({ timeout: 3000 });
    await expect(page).toHaveURL(new RegExp(`/admin/opportunities/${idOf(PUBLISHED_MINE)}/edit$`), { timeout: 5000 });
  });

  test('under the Status select the count keeps its denominator (13) and Needs attention keeps its cards', async ({
    page,
    baseURL,
  }) => {
    // The 13-study seed, as the review measured it.
    await open(page, baseURL, { api: makeApi(OPPORTUNITIES), expectedRows: OPPORTUNITIES.length });
    const count = page.getByText(/^\s*\d+ of \d+ stud(y|ies)\s*$/);
    const attention = page.locator('.admin-attention');
    const select = page.locator('#statusFilter');
    await select.selectOption({ label: 'Draft' }, { timeout: 3000 });
    await expect(rows(page)).toHaveCount(1, { timeout: 5000 });
    await expect(count, 'Status: Draft').toHaveText('1 of 13 studies', { timeout: 3000 });
    await expect(attention.getByText('3 studies broken'), 'the Broken card under Status: Draft').toBeVisible();
    await expect(attention.getByText('2 studies close soon'), 'the closing-soon card under Status: Draft').toBeVisible();
    await select.selectOption({ label: 'Published' }, { timeout: 3000 });
    await expect(rows(page)).toHaveCount(10, { timeout: 5000 });
    await expect(count, 'Status: Published').toHaveText('10 of 13 studies', { timeout: 3000 });
    await select.selectOption({ label: 'Broken' }, { timeout: 3000 });
    await expect(count, 'Status: Broken').toHaveText('3 of 13 studies', { timeout: 3000 });
  });

  for (const theme of THEMES) {
    test(`the Next / deadline header is a sort button and the header row is one line, <= 42px, at 1024-1920 (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await open(page, baseURL, { theme });
      await expect(header(page, NEXT_HEADER).locator('button'), `the "${NEXT_HEADER}" header`).toHaveCount(1);
      const failures: string[] = [];
      for (const width of [1024, 1280, 1440, 1920]) {
        await resizeTo(page, width);
        const h = await page.evaluate(() => document.querySelector('table.admin-data-table thead tr')!.getBoundingClientRect().height);
        if (h > 42) failures.push(`${width}px: header row ${h.toFixed(1)}px`);
      }
      expect(failures).toEqual([]);
    });

    test(`Fix carries its own ink, at >= 4.5:1 at rest and on hover (${theme})`, async ({ page, baseURL }) => {
      await open(page, baseURL, { theme });
      const tagged = await page.evaluate(() => {
        const p = window.__adminProbe;
        const inks: Record<string, string[]> = { Fix: [], Analytics: [] };
        for (const r of p.rows()) {
          const actions = p.cell(r, 'Actions');
          const primary = actions
            ? ([...actions.querySelectorAll('a[href], button')].find((el) => !el.closest('.dropdown')) as HTMLElement | undefined)
            : undefined;
          const label = primary ? p.norm(primary.textContent) : '';
          if (primary && label === 'Fix') primary.setAttribute('data-e2e-fix', '');
          if (primary && label in inks) inks[label].push(getComputedStyle(primary).color);
        }
        return inks;
      });
      expect(tagged.Fix.length, 'Fix actions on the three broken rows').toBe(3);
      expect(new Set(tagged.Fix).size, 'every Fix shares one ink').toBe(1);
      expect(tagged.Analytics.length, 'Analytics actions to compare against').toBeGreaterThan(0);
      expect(tagged.Fix[0], 'Fix is not dressed like Analytics').not.toBe(tagged.Analytics[0]);
      const rest = await measureGroundContrast(page, ['[data-e2e-fix]']);
      expect(rest.measured, 'Fix labels measured').toBeGreaterThanOrEqual(3);
      expect(rest.failures, 'Fix contrast at rest').toEqual([]);
      const first = page.locator('[data-e2e-fix]').first();
      await first.hover({ timeout: 3000 });
      await first.evaluate((el) => el.setAttribute('data-e2e-fix-hover', ''));
      const hover = await measureGroundContrast(page, ['[data-e2e-fix-hover]']);
      expect(hover.failures, 'Fix contrast on hover').toEqual([]);
    });
  }

  test('the row action and the kebab sit 8px apart at 1024-1920', async ({ page, baseURL }) => {
    await open(page, baseURL);
    const failures: string[] = [];
    for (const width of [1024, 1280, 1440, 1920]) {
      await resizeTo(page, width);
      const gaps = await page.evaluate(() =>
        window.__adminProbe.rows().map((r) => {
          const action = r.querySelector('.admin-action-primary')!.getBoundingClientRect();
          const kebab = r.querySelector('.admin-action-btn-kebab')!.getBoundingClientRect();
          return +(kebab.left - action.right).toFixed(1);
        })
      );
      const off = gaps.filter((g) => Math.abs(g - 8) > 0.5);
      if (off.length) failures.push(`${width}px: gaps ${[...new Set(off)].join(', ')}px`);
    }
    expect(failures).toEqual([]);
  });

  test("another researcher's broken study: a researcher_admin gets Preview, and Edit, Analytics, Copy and Delete disabled", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await toggleShowAll(page, ALL_COUNT);
    const action = row(page, OTHER_BROKEN).locator('.admin-action-primary');
    await expect(action, 'the inline action').toHaveText('Preview');
    expect(new URL(await action.evaluate((el) => (el as HTMLAnchorElement).href)).pathname).toBe(
      `/opportunities/${idOf(OTHER_BROKEN)}`
    );
    await openMenu(page, OTHER_BROKEN);
    expect(await menuSequence(page)).toEqual([
      'Edit (disabled)',
      'Preview as participant',
      'Analytics (disabled)',
      'Copy (disabled)',
      '|',
      'Delete (disabled)',
    ]);
  });

  test("another researcher's broken study: a superadmin gets Fix, and Edit, Analytics, Close and Delete live", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL, { me: SUPERADMIN_ME, api: makeApi(STEP2_ALL, null), expectedRows: ALL_COUNT });
    const action = row(page, OTHER_BROKEN).locator('.admin-action-primary');
    await expect(action, 'the inline action').toHaveText('Fix');
    expect(new URL(await action.evaluate((el) => (el as HTMLAnchorElement).href)).pathname).toBe(
      `/admin/opportunities/${idOf(OTHER_BROKEN)}/edit`
    );
    await openMenu(page, OTHER_BROKEN);
    expect(await menuSequence(page)).toEqual([
      'Edit',
      'Preview as participant',
      'Analytics',
      'Copy',
      '|',
      'Close study',
      '|',
      'Delete',
    ]);
  });
});

test.describe('Admin studies table triage: round 3', () => {
  const closeFromMenu = async (page: Page, title: string) => {
    await openMenu(page, title);
    await page.getByRole('menuitem', { name: 'Close study' }).click({ timeout: 3000 });
  };
  const notice = (page: Page, title: string) => page.getByRole('status').filter({ hasText: `Closed “${title}”` });
  /** Scroll so the row sits mid-viewport, where a jump would show. */
  const centreRow = async (page: Page, title: string) => {
    await row(page, title).scrollIntoViewIfNeeded({ timeout: 3000 });
    await page.evaluate((t) => {
      const tr = [...document.querySelectorAll('table.admin-data-table tbody tr')].find((r) =>
        r.querySelector(`[title="${CSS.escape(t)}"]`)
      )!;
      window.scrollBy(0, tr.getBoundingClientRect().top - window.innerHeight / 2);
    }, title);
  };
  const scrollY = (page: Page) => page.evaluate(() => window.scrollY);
  const FAIL_CLOSE_STUDY = 'ScriptRunner for Jira: the new script editor';

  for (const [width, showAll] of [
    [1440, false],
    [1440, true],
    [1023, false],
    [800, false],
    [390, false],
  ] as const) {
    const label = `${width}px${showAll ? ' with Show all researchers' : ''}`;
    test(`a lapse or Dismiss hands focus on without moving the page, and the next Tab does not scroll, at ${label}`, async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(45000);
      const api = makeApi();
      await open(page, baseURL, { width, height: width === 390 ? 844 : 900, api });
      if (showAll) await toggleShowAll(page, ALL_COUNT);
      await mockPatch(page, api, { failClose: idOf(FAIL_CLOSE_STUDY) });

      await centreRow(page, PUBLISHED_MINE);
      await closeFromMenu(page, PUBLISHED_MINE);
      await expect(notice(page, PUBLISHED_MINE)).toBeVisible({ timeout: 3000 });
      await expect(notice(page, PUBLISHED_MINE).getByRole('button', { name: 'Undo' })).toBeFocused({ timeout: 3000 });
      const lapseNeighbours = await slotNeighbours(page, PUBLISHED_MINE);
      expect(lapseNeighbours.next, 'the row under the notice').toBe('ScriptRunner for Jira: the new script editor');
      const beforeLapse = await scrollY(page);
      await expect(notice(page, PUBLISHED_MINE), 'the notice lapses').toHaveCount(0, { timeout: 12000 });
      const afterLapse = await scrollY(page);
      const lapse = await expectHandOff(page, PUBLISHED_MINE, lapseNeighbours, 'lapse');
      // The closed study re-sorts into the Closed group, off screen: this is
      // the neighbour case, not the study's own link.
      expect(lapse, 'lapse hand-off').toEqual({ focused: 'ScriptRunner for Jira: the new script editor', ownInView: false });

      await centreRow(page, FAIL_CLOSE_STUDY);
      await closeFromMenu(page, FAIL_CLOSE_STUDY);
      const alert = page.getByRole('alert').filter({ hasText: `Could not close “${FAIL_CLOSE_STUDY}”` });
      await expect(alert).toBeFocused({ timeout: 3000 });
      const dismissNeighbours = await slotNeighbours(page, FAIL_CLOSE_STUDY);
      const beforeDismiss = await scrollY(page);
      await alert.getByRole('button', { name: 'Dismiss' }).click({ timeout: 3000 });
      const afterDismiss = await scrollY(page);
      // A failed close leaves the study where it was: its own link.
      expect((await expectHandOff(page, FAIL_CLOSE_STUDY, dismissNeighbours, 'Dismiss')).focused).toBe(FAIL_CLOSE_STUDY);

      expect({ lapse: afterLapse - beforeLapse, dismiss: afterDismiss - beforeDismiss }, 'page scroll, px').toEqual({
        lapse: 0,
        dismiss: 0,
      });
    });
  }

  test('Space activates a link item in the row menu, and the page does not take it as a scroll', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await centreRow(page, PUBLISHED_MINE);
    await kebab(page, PUBLISHED_MINE).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    const preview = page.getByRole('menuitem', { name: 'Preview as participant' });
    await expect(preview, 'the second item').toBeFocused({ timeout: 3000 });
    expect(await preview.evaluate((el) => el.tagName), 'Preview as participant is a link item').toBe('A');
    // Space scrolls the page unless its keydown is prevented; record that.
    await page.evaluate(() => {
      const w = window as unknown as { __spacePrevented?: boolean };
      window.addEventListener('keydown', (e) => {
        if (e.key === ' ') w.__spacePrevented = e.defaultPrevented;
      });
    });
    await sinkApiForNavigation(page);
    await page.keyboard.press(' ');
    await expect(page, 'Space opened the item').toHaveURL(new RegExp(`/opportunities/${idOf(PUBLISHED_MINE)}$`), {
      timeout: 5000,
    });
    const prevented = await page.evaluate(() => (window as unknown as { __spacePrevented?: boolean }).__spacePrevented);
    expect(prevented, 'the Space keydown was left to scroll the page').toBe(true);
  });

  test("for another researcher's study the title link and a row click open the participant preview", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await toggleShowAll(page, ALL_COUNT);
    // Bounded: a missing link fails here by name, not at the test timeout.
    await expect(titleLink(page, OTHER_PUBLISHED), 'the title is a link').toHaveCount(1, { timeout: 3000 });
    await expect(titleLink(page, PUBLISHED_MINE), 'your own title is a link').toHaveCount(1, { timeout: 3000 });
    const href = await titleLink(page, OTHER_PUBLISHED).evaluate((a) => new URL((a as HTMLAnchorElement).href).pathname);
    expect(href, 'title link').toBe(`/opportunities/${idOf(OTHER_PUBLISHED)}`);
    // Control: your own study's title still opens its edit page.
    const own = await titleLink(page, PUBLISHED_MINE).evaluate((a) => new URL((a as HTMLAnchorElement).href).pathname);
    expect(own, 'your own title link').toBe(`/admin/opportunities/${idOf(PUBLISHED_MINE)}/edit`);
    await sinkApiForNavigation(page);
    await row(page, OTHER_PUBLISHED).locator('td').nth(2).click({ timeout: 3000 });
    await expect(page, 'row click').toHaveURL(new RegExp(`/opportunities/${idOf(OTHER_PUBLISHED)}$`), { timeout: 5000 });
  });

  test('while an Undo is in flight every Undo button is disabled, and a second press sends nothing', async ({
    page,
    baseURL,
  }) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api, { holdReopen: hold });
    const second = 'What would you automate first with AI in Jira?';
    await closeFromMenu(page, PUBLISHED_MINE);
    await expect(notice(page, PUBLISHED_MINE)).toBeVisible({ timeout: 3000 });
    await closeFromMenu(page, second);
    await expect(notice(page, second)).toBeVisible({ timeout: 3000 });
    const undos = page.locator('table.admin-data-table tbody [role="status"]').getByRole('button', { name: 'Undo' });
    const shown = await undos.count();
    test.info().annotations.push({ type: 'undo buttons on screen', description: String(shown) });
    await notice(page, second).getByRole('button', { name: 'Undo' }).click({ timeout: 3000 });
    for (let i = 0; i < shown; i += 1) await expect(undos.nth(i), `Undo ${i + 1} of ${shown}`).toBeDisabled({ timeout: 3000 });
    await notice(page, second).getByRole('button', { name: 'Undo' }).click({ force: true, timeout: 3000 });
    expect(api.patches.filter((p) => p.body.status === 'published'), 'reopen PATCHes in flight').toHaveLength(1);
    release();
    await expect(notice(page, second), 'the reopened study\'s notice goes').toHaveCount(0, { timeout: 3000 });
  });

  for (const theme of THEMES) {
    test(`the row menu shows a visible focus and hover state, with text >= 4.5:1 (${theme})`, async ({ page, baseURL }) => {
      await open(page, baseURL, { theme });
      await centreRow(page, PUBLISHED_MINE);
      await kebab(page, PUBLISHED_MINE).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused({ timeout: 3000 });
      const analytics = page.getByRole('menuitem', { name: 'Analytics', exact: true });
      await analytics.hover({ timeout: 3000 });
      const m = await page.evaluate(() => {
        const p = window.__adminProbe;
        const items = [...document.querySelectorAll('.admin-action-dropdown-menu [role="menuitem"]')] as HTMLElement[];
        const byText = (t: string) => items.find((el) => p.norm(el.textContent) === t)!;
        const look = (el: HTMLElement) => {
          const cs = getComputedStyle(el);
          return {
            bg: p.effectiveBackground(el).map((v) => Math.round(v)).join(','),
            ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? `${cs.outlineWidth} ${cs.outlineColor}` : '',
            shadow: cs.boxShadow === 'none' ? '' : cs.boxShadow,
          };
        };
        const focused = byText('Edit');
        const hovered = byText('Analytics');
        focused.setAttribute('data-e2e-menu-focus', '');
        hovered.setAttribute('data-e2e-menu-hover', '');
        return { focused: look(focused), hovered: look(hovered), rest: look(byText('Copy')) };
      });
      const differs = (a: typeof m.rest) => a.bg !== m.rest.bg || a.ring !== m.rest.ring || a.shadow !== m.rest.shadow;
      expect({ focus: differs(m.focused), hover: differs(m.hovered) }, `visible states: ${JSON.stringify(m)}`).toEqual({
        focus: true,
        hover: true,
      });
      const focus = await measureGroundContrast(page, ['[data-e2e-menu-focus]']);
      const hover = await measureGroundContrast(page, ['[data-e2e-menu-hover]']);
      expect(focus.measured + hover.measured, 'menu labels measured').toBeGreaterThanOrEqual(2);
      expect([...focus.failures, ...hover.failures], 'focused and hovered item contrast').toEqual([]);
    });
  }

  test('the closing-soon card says "in the next 3 days"', async ({ page, baseURL }) => {
    await open(page, baseURL);
    const card = page.locator('.admin-attention button, .admin-attention a').filter({ hasText: /studies close soon/ });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('in the next 3 days');
  });

  // GUARD on main, which already rounds down. Control: the day-label mutation.
  test('the Closes note rounds days DOWN: +2d 23h reads "2 days left", +3d 1h "3 days left"', async ({ page, baseURL }) => {
    await open(page, baseURL);
    const note = (title: string) =>
      page.evaluate(
        ({ t, nextHeader }) => {
          const p = window.__adminProbe;
          const r = p.rows().find((tr) => p.cell(tr, 'Study')?.querySelector(`[title="${CSS.escape(t)}"]`));
          return r ? p.norm(p.cell(r, nextHeader)?.querySelector('.admin-next__note')?.textContent) : '(no row)';
        },
        { t: title, nextHeader: NEXT_HEADER }
      );
    expect({
      inside: await note(WARNED.deadline),
      outside: await note(NOT_WARNED.deadline),
    }).toEqual({ inside: 'Closes · 2 days left', outside: 'Closes · 3 days left' });
  });

  test('chip counts and Needs attention follow the live status at once, and a refused Undo freezes nothing', async ({
    page,
    baseURL,
  }) => {
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api, { refuseReopen: idOf(REOPEN_REFUSED_STUDY) });
    const closingSoonCard = page.locator('.admin-attention').getByText(/\d+ stud(y|ies) closes? soon/);
    await expect(chip(page, 'Closing soon')).toHaveText(/^\s*Closing soon\s*3\s*$/);
    await expect(closingSoonCard).toHaveText('3 studies close soon');
    const at = STATUS_ASC_ORDER.indexOf(REOPEN_REFUSED_STUDY);

    await closeFromMenu(page, REOPEN_REFUSED_STUDY);
    await expect(notice(page, REOPEN_REFUSED_STUDY)).toBeVisible({ timeout: 3000 });
    await expect(chip(page, 'Closing soon'), 'chip, live, while the notice shows').toHaveText(/^\s*Closing soon\s*2\s*$/, {
      timeout: 3000,
    });
    await expect(closingSoonCard, 'card, live, while the notice shows').toHaveText('2 studies close soon');
    expect((await titles(page)).indexOf(REOPEN_REFUSED_STUDY), 'sort position held while the notice shows').toBe(at);

    await notice(page, REOPEN_REFUSED_STUDY).getByRole('button', { name: 'Undo' }).click({ timeout: 3000 });
    await expect(page.getByRole('alert').filter({ hasText: REOPEN_REFUSAL })).toBeVisible({ timeout: 3000 });
    // The refused study is closed, and nothing holds it where it was.
    expect(await titles(page), 'order after the refused Undo').toEqual([
      ...STATUS_ASC_ORDER.filter((t) => t !== REOPEN_REFUSED_STUDY),
      REOPEN_REFUSED_STUDY,
    ]);
    await page.locator('#statusFilter').selectOption({ label: 'Published' }, { timeout: 3000 });
    await expect(row(page, REOPEN_REFUSED_STUDY), 'a closed study under Status: Published').toHaveCount(0, { timeout: 3000 });
    await expect(page.getByText(/^\s*\d+ of \d+ stud(y|ies)\s*$/)).toHaveText('15 of 20 studies', { timeout: 3000 });
  });
});

test.describe('Admin studies table triage: round 4', () => {
  const closeFromMenu = async (page: Page, title: string) => {
    await openMenu(page, title);
    await page.getByRole('menuitem', { name: 'Close study' }).click({ timeout: 3000 });
  };
  const notice = (page: Page, title: string) => page.getByRole('status').filter({ hasText: `Closed “${title}”` });
  const scrollY = (page: Page) => page.evaluate(() => window.scrollY);
  const copyFromMenu = async (page: Page, title: string) => {
    await openMenu(page, title);
    await page.getByRole('menuitem', { name: 'Copy' }).click({ timeout: 3000 });
  };
  const topOf = (page: Page, title: string) =>
    page.evaluate((t) => {
      const tr = [...document.querySelectorAll('table.admin-data-table tbody tr')].find((r) =>
        r.querySelector(`[title="${CSS.escape(t)}"]`)
      );
      return tr ? tr.getBoundingClientRect().top : NaN;
    }, title);

  test('at 390 the card being read does not jump when a notice it left behind lapses', async ({ page, baseURL }) => {
    test.setTimeout(45000);
    const api = makeApi();
    await open(page, baseURL, { width: 390, height: 844, api });
    await mockPatch(page, api);
    await closeFromMenu(page, PUBLISHED_MINE);
    await expect(notice(page, PUBLISHED_MINE)).toBeVisible({ timeout: 3000 });
    // The reader moves on, down the list, to a card below the closed one.
    const reading = 'Developer experience pulse';
    await page.evaluate((t) => {
      const tr = [...document.querySelectorAll('table.admin-data-table tbody tr')].find((r) =>
        r.querySelector(`[title="${CSS.escape(t)}"]`)
      )!;
      window.scrollBy(0, tr.getBoundingClientRect().top - 200);
    }, reading);
    const before = await topOf(page, reading);
    expect(Math.abs(before - 200), `the card being read sits at y=200 (${before.toFixed(0)})`).toBeLessThanOrEqual(2);
    const closedAbove = (await topOf(page, PUBLISHED_MINE)) < before;
    expect(closedAbove, 'control: the closed card is above the one being read, so its re-sort moves content').toBe(true);
    await expect(notice(page, PUBLISHED_MINE), 'the notice lapses').toHaveCount(0, { timeout: 12000 });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const after = await topOf(page, reading);
    expect(after - before, 'the card being read moved, px').toBeCloseTo(0, 0);
  });

  test('a Copy says Copied “title” in place, and the copy appears', async ({ page, baseURL }) => {
    const api = makeApi();
    await open(page, baseURL, { api });
    const copied = await mockDuplicate(page, api);
    await copyFromMenu(page, PUBLISHED_MINE);
    await expect(page.getByRole('status').filter({ hasText: `Copied “${PUBLISHED_MINE}”` }), 'the copy notice').toBeVisible({
      timeout: 3000,
    });
    expect(copied, 'one duplicate request').toEqual([idOf(PUBLISHED_MINE)]);
    await expect(rows(page), 'the copy joins the table').toHaveCount(MINE_COUNT + 1, { timeout: 5000 });
    await expect(row(page, `${PUBLISHED_MINE} (copy)`)).toHaveCount(1);
  });

  test('a Copy whose reload fails still says Copied “title”, keeps the table, and Retry recovers and hands focus back', async ({
    page,
    baseURL,
  }) => {
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockDuplicate(page, api, { failRefresh: true });
    await row(page, PUBLISHED_MINE).scrollIntoViewIfNeeded({ timeout: 3000 });
    const y0 = await scrollY(page);
    await copyFromMenu(page, PUBLISHED_MINE);
    const failed = page
      .locator('table.admin-data-table tbody')
      .getByRole('alert')
      .filter({ hasText: `Copied “${PUBLISHED_MINE}”, but the list could not be refreshed` });
    await expect(failed, 'the copy is reported, and so is the failed reload').toBeVisible({ timeout: 3000 });
    await expect(rows(page), 'the table is kept').toHaveCount(MINE_COUNT);
    await expect(page.getByText('Failed to load studies'), 'no load-failure state').toHaveCount(0);
    expect((await scrollY(page)) - y0, 'page scroll, px').toBe(0);
    await failed.getByRole('button', { name: 'Retry' }).click({ timeout: 3000 });
    await expect(rows(page), 'Retry loads the list with the copy').toHaveCount(MINE_COUNT + 1, { timeout: 5000 });
    await expect(failed).toHaveCount(0, { timeout: 3000 });
    // L-A: after a good Retry the notice reads plain "Copied", clears in its
    // 8 seconds, and hands focus back to the study - not to <body>.
    const copiedNotice = page.locator('table.admin-data-table tbody').getByRole('status').filter({ hasText: `Copied “${PUBLISHED_MINE}”` });
    await expect(copiedNotice, 'the notice after Retry').toBeVisible({ timeout: 3000 });
    const neighbours = await slotNeighbours(page, PUBLISHED_MINE);
    const y1 = await scrollY(page);
    await expect(copiedNotice, 'the Copied notice clears').toHaveCount(0, { timeout: UNDO_MS + 3000 });
    expect((await scrollY(page)) - y1, 'page scroll across the clear, px').toBe(0);
    await expectHandOff(page, PUBLISHED_MINE, neighbours, 'Copied notice cleared');
  });

  test('scroll anchoring comes back on once no notice is up, even after an Undo refused under a newer notice', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(45000);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const api = makeApi();
    await open(page, baseURL, { api });
    await mockPatch(page, api, { refuseReopen: idOf(PUBLISHED_MINE), holdReopen: hold });
    const anchoring = () =>
      page.evaluate(() => getComputedStyle(document.querySelector('table.admin-data-table')!).overflowAnchor);
    expect(await anchoring(), 'at rest').toBe('auto');
    const newer = 'What would you automate first with AI in Jira?';
    await closeFromMenu(page, PUBLISHED_MINE);
    await notice(page, PUBLISHED_MINE).getByRole('button', { name: 'Undo' }).click({ timeout: 3000 });
    await closeFromMenu(page, newer);
    await expect(notice(page, newer)).toBeVisible({ timeout: 3000 });
    expect(await anchoring(), 'while a notice is up').toBe('none');
    await page.locator('#statusFilter').focus();
    release();
    await expect(page.getByRole('alert').filter({ hasText: REOPEN_REFUSAL }), 'the refused Undo').toBeVisible({ timeout: 3000 });
    await expect(notice(page, newer), 'the newer notice lapses').toHaveCount(0, { timeout: UNDO_MS + 3000 });
    // Not dismissed: Dismiss hands focus back, which releases any hold, and
    // would hide a hold the refusal left stuck. The error stays up; no notice is.
    await expect(page.getByRole('alert').filter({ hasText: REOPEN_REFUSAL }), 'the error is still up').toBeVisible();
    await expect.poll(anchoring, { message: 'no notice up: anchoring back on', timeout: 3000 }).toBe('auto');
  });

  test('the Next note is warning-coloured exactly when the study counts as closing soon', async ({ page, baseURL }) => {
    // Closes in 2 days, but its next session is in 5: the note shows the
    // session, and the study still counts as closing soon.
    const closesBeforeLastSlot: WireOpportunity = {
      ...structuredClone(STEP2_ALL.find((s) => s.title === '2027 roadmap interviews')!),
      id: '0aa00002-0000-4000-8000-000000000011',
      title: 'Usability round: closes before its last slot',
      end_date: '2026-09-25T09:00:00.000Z',
      created_at: '2026-09-15T09:00:00.000Z',
      sessions: [
        {
          id: '05e00002-0000-4000-8000-000000000011',
          opportunity_id: '0aa00002-0000-4000-8000-000000000011',
          start_time: '2026-09-28T10:00:00.000Z',
          end_time: '2026-09-28T10:30:00.000Z',
          capacity: 2,
          booked_count: 0,
          location_or_meet_link_optional: 'https://meet.google.com/usa-bili-ty1',
          created_at: '2026-09-15T09:00:00.000Z',
          updated_at: '2026-09-15T09:00:00.000Z',
          remaining: 2,
        },
      ],
    };
    await open(page, baseURL, { api: makeApi([...STEP2_ALL, closesBeforeLastSlot]), expectedRows: MINE_COUNT + 1 });
    await chip(page, 'Closing soon').click({ timeout: 3000 });
    const closingSoon = [...(await titles(page))].sort();
    await chip(page, 'Closing soon').click({ timeout: 3000 });
    await expect(rows(page)).toHaveCount(MINE_COUNT + 1, { timeout: 3000 });
    expect(closingSoon, 'the Closing soon set').toEqual(
      [WARNED.session, WARNED.deadline, WARNED.deadline2, closesBeforeLastSlot.title!].sort()
    );
    const warned = await page.evaluate(
      ({ nextHeader, reference }) => {
        const p = window.__adminProbe;
        const noteOf = (tr: HTMLTableRowElement) => p.cell(tr, nextHeader)?.querySelector('.admin-next__note') as HTMLElement | null;
        const ref = p.rows().find((tr) => tr.querySelector(`[title="${CSS.escape(reference)}"]`))!;
        const warnInk = getComputedStyle(noteOf(ref)!).color;
        return p
          .rows()
          .filter((tr) => {
            const note = noteOf(tr);
            return note !== null && getComputedStyle(note).color === warnInk;
          })
          .map((tr) => tr.querySelector('td [title]')!.getAttribute('title')!)
          .sort();
      },
      { nextHeader: NEXT_HEADER, reference: WARNED.deadline }
    );
    expect(warned, 'warning-coloured notes').toEqual(closingSoon);
  });
});

test.describe('Admin studies table triage: the 390px card view', () => {
  /**
   * MR C replaces the phone cards; MR B must not break them meanwhile. At
   * 390 the chips carry counts and a filter adds the result count, so the
   * row that already wrapped must still fit, and a row menu must open on
   * screen.
   */
  for (const theme of THEMES) {
    test(`at 390px the counted chips, the result count and a row menu fit the viewport (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await open(page, baseURL, { width: 390, height: 844, theme });
      await chip(page, 'Broken').click({ timeout: 3000 });
      await expect(page.getByText('3 of 20 studies')).toBeVisible({ timeout: 3000 });
      const overflow = await page.evaluate(() => ({
        scroll: document.scrollingElement!.scrollWidth,
        inner: window.innerWidth,
        offRight: [...document.querySelectorAll('.admin-quick-filters *')]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`),
      }));
      expect(overflow.offRight, 'quick-filter row content past the right edge').toEqual([]);
      expect(overflow.scroll, 'document scrolls sideways').toBeLessThanOrEqual(overflow.inner);

      await openMenu(page, BROKEN[0]);
      const r = await page.locator('.admin-action-dropdown-menu').evaluate((el) => el.getBoundingClientRect().toJSON());
      expect(r.left, 'menu left edge').toBeGreaterThanOrEqual(0);
      expect(r.right, 'menu right edge').toBeLessThanOrEqual(390);
    });
  }
});

test.describe('Admin studies table triage: Sort by control', () => {
  for (const theme of THEMES) {
    test(`the Sort by control matches the chips' height and corner radius at 1100px (${theme})`, async ({
      page,
      baseURL,
    }) => {
      await open(page, baseURL, { width: 1100, theme });
      const m = await page.evaluate(() => {
        const measure = (el: Element | null) => {
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { h: +el.getBoundingClientRect().height.toFixed(1), radius: cs.borderTopLeftRadius };
        };
        return {
          chip: measure(document.querySelector('.admin-quick-filters button.admin-chip')),
          select: measure(document.querySelector('.admin-card-sort select')),
          direction: measure(document.querySelector('.admin-card-sort-dir')),
        };
      });
      expect(m.chip, 'a chip').toBeTruthy();
      const failures: string[] = [];
      for (const [name, got] of Object.entries({ select: m.select, direction: m.direction })) {
        if (!got) failures.push(`${name}: not rendered`);
        else if (Math.abs(got.h - m.chip!.h) > 0.5 || got.radius !== m.chip!.radius) {
          failures.push(`${name}: ${got.h}px / ${got.radius} vs chip ${m.chip!.h}px / ${m.chip!.radius}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
