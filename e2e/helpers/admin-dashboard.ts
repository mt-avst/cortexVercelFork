import { expect, type Page, type Route } from '@playwright/test';
import {
  ADMIN_ME,
  DASHBOARD,
  FEEDBACK,
  FIXTURE_NOW,
  OPPORTUNITIES,
  PENDING_APPROVALS,
} from '../fixtures/admin-dashboard-seed';

/**
 * Shared set-up and in-page measuring instruments for the Admin Research
 * Studies table specs `admin-studies-table-density.test.ts`,
 * `admin-table-chrome-layout.test.ts` and (Step 2)
 * `admin-studies-table-triage.test.ts`.
 *
 * Every API route the dashboard calls is mocked from
 * `e2e/fixtures/admin-dashboard-seed.ts` (the seeded dev database, captured),
 * so these specs need a frontend and nothing else. That is what lets
 * `playwright.accessibility.config.ts` - and so the `test-a11y` CI job, which
 * serves `vite preview` with no backend - run them. Before this they drove the
 * real seeded stack and ran in no pipeline at all.
 *
 * Paths are relative so `use.baseURL` from the running config decides the
 * target, per the convention in the other e2e specs here. Specs using this set
 * `test.use({ timezoneId: FIXTURE_TIMEZONE })` so a UTC runner renders the
 * fixture's 16:00 session as 16:00.
 */

export type Theme = 'dark' | 'light';
export const THEMES: readonly Theme[] = ['dark', 'light'];

/**
 * admin@test.com owns 13 studies in the seeded dev database, and the fixture
 * reproduces them. Every row-counting criterion (AC6 in particular) was written
 * against exactly this set, so a different count fails here, by name, rather
 * than quietly changing what "10 rows visible" means.
 */
export const SEEDED_STUDY_COUNT = 13;

export interface SeededStudy {
  id: string;
  type: string;
  status: string;
  title: string;
  purpose_one_liner: string;
  clicks_total?: number | null;
  sessions?: Array<{ capacity: number; booked_count?: number | null }>;
}

/** The study list the mocked API serves: the oracle for full strings. */
export const SEEDED_STUDIES: readonly SeededStudy[] = OPPORTUNITIES;

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Serve every API call the dashboard makes from the fixture. Anything else
 * under `/api/` is answered 404 and recorded, and `openAdminDashboard` asserts
 * that list is empty: if the page grows a new backend dependency these specs
 * fail by name instead of measuring an error state (a frontend-only CI server
 * has no backend to fall through to).
 */
/**
 * Unmocked API calls per page, for `expectNoUnmockedCalls`. Keyed by page so
 * a call made at ANY point in a test - a tab switch, a Delete, a later fetch -
 * is still attributed to that test, not only the ones made while it loaded.
 */
const unmockedByPage = new WeakMap<Page, string[]>();

/**
 * Fails the current test, by name, if its page made any API call with no mock
 * at any point. Specs using `openAdminDashboard` call it from `test.afterEach`.
 * A page that never opened the dashboard has nothing recorded and passes.
 */
export function expectNoUnmockedCalls(page: Page): void {
  expect(unmockedByPage.get(page) ?? [], 'API calls with no mock - the page has a new backend dependency').toEqual([]);
}

/**
 * What `GET /api/opportunities` answers, given the request's query string.
 * The default is the Step 1 behaviour: the 13-study seed for any query.
 * `null` answers that request with a 500, for a failed reload.
 */
export type StudySource = (query: URLSearchParams) => readonly unknown[] | null;

const seedSource: StudySource = () => OPPORTUNITIES;

async function mockDashboardApi(
  page: Page,
  studies: StudySource = seedSource,
  me: unknown = ADMIN_ME
): Promise<string[]> {
  const unmocked: string[] = [];
  unmockedByPage.set(page, unmocked);
  // Registered first so it matches last: Playwright tries routes in reverse
  // registration order.
  // A pathname predicate, not the glob '**/api/**', which under the Vite dev
  // server also matches the app's own /src/api/*.ts modules.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    unmocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unmocked in e2e"}' });
  });
  await page.route('**/api/me', (route) => json(route, me));
  // The list endpoint only (GET, no id segment); anything else under
  // /api/opportunities/ falls through to the recorder above unless a spec
  // mocks it.
  await page.route(
    (url) => url.pathname === '/api/opportunities',
    (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const body = studies(new URL(route.request().url()).searchParams);
      return body === null
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"e2e: list failed"}' })
        : json(route, body);
    }
  );
  await page.route('**/api/admin/dashboard**', (route) => json(route, DASHBOARD));
  await page.route('**/api/bookings/pending-approvals**', (route) => json(route, PENDING_APPROVALS));
  await page.route('**/api/feedback**', (route) => json(route, FEEDBACK));
  return unmocked;
}

/**
 * Open `/admin` on `baseURL` as the fixture's researcher_admin, every route
 * mocked and the clock pinned to FIXTURE_NOW.
 */
export async function openAdminDashboard(
  page: Page,
  baseURL: string | undefined,
  opts: {
    width: number;
    height?: number;
    theme?: Theme;
    /**
     * Serve a different study list (the Step 2 spec does, and honours the
     * query). Omitted: the 13-study seed, which the Step 1 specs pin.
     */
    studies?: StudySource;
    /** Rows the table must render before the page counts as loaded. Default SEEDED_STUDY_COUNT. */
    expectedRows?: number;
    /** The signed-in user `/api/me` returns. Default ADMIN_ME, a researcher_admin. */
    me?: { id: string; role: string } & Record<string, unknown>;
  }
): Promise<void> {
  expect(baseURL, 'baseURL must be set - these specs drive a running frontend').toBeTruthy();
  expect(OPPORTUNITIES, 'fixture study count').toHaveLength(SEEDED_STUDY_COUNT);
  const expectedRows = opts.expectedRows ?? SEEDED_STUDY_COUNT;
  if (opts.theme) {
    await page.addInitScript((t) => localStorage.setItem('theme', t), opts.theme);
  }
  await page.addInitScript(installProbes);
  await page.clock.setFixedTime(new Date(FIXTURE_NOW));
  const unmocked = await mockDashboardApi(page, opts.studies, opts.me);
  await page.setViewportSize({ width: opts.width, height: opts.height ?? 900 });

  await page.goto('/admin', { waitUntil: 'load', timeout: 15000 });
  expect(new URL(page.url()).origin, 'the dashboard must be served by BASE_URL').toBe(new URL(baseURL!).origin);
  expect(new URL(page.url()).pathname).toBe('/admin');

  await expect(page.locator('table.admin-data-table')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('table.admin-data-table tbody tr'), 'fixture study count rendered').toHaveCount(
    expectedRows,
    { timeout: 10000 }
  );
  // The approvals count drives the tab badge; wait for it so the badge and
  // tab tests never race the fetch.
  await expect(page.locator('#completion-approvals-tab-button .admin-tab-count')).toHaveText(
    String(PENDING_APPROVALS.length),
    { timeout: 5000 }
  );
  if (opts.theme) {
    await expect(page.locator(`body.theme-${opts.theme}`)).toHaveCount(1, { timeout: 5000 });
  }
  await page.evaluate(() => document.fonts.ready);
  // Checked here too, so a load-time dependency fails before any measurement
  // runs against an error state; `expectNoUnmockedCalls` in each spec's
  // afterEach covers everything after this point.
  expect(unmocked, 'API calls with no mock - the page has a new backend dependency').toEqual([]);
}

/** Resize and wait two frames so layout has settled before measuring. */
export async function resizeTo(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

/** WCAG 2.x relative luminance of an sRGB triple, 0-255 per channel. */
export const luminance = ([r, g, b]: number[]): number => {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export const contrastRatio = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * In-page instruments, installed on `window.__adminProbe` by an init script so
 * every `page.evaluate` in these specs measures the same way. Columns are
 * located by their HEADER TEXT, never by class name, so a renamed `.col-*`
 * class cannot make a measurement silently read the wrong column.
 */
export interface AdminProbe {
  norm(s: string | null | undefined): string;
  table(): HTMLTableElement;
  headerCells(): HTMLTableCellElement[];
  headerLabels(): string[];
  colIndex(label: string): number;
  rows(): HTMLTableRowElement[];
  cell(row: HTMLTableRowElement, label: string): HTMLTableCellElement | null;
  shown(el: Element | null): boolean;
  /** Deepest element under `root` whose trimmed text is exactly `text`. */
  elementWithText(root: Element, text: string): HTMLElement | null;
  /** Painted parts of `root`'s content that fall outside `bounds`, after clipping by any clip box strictly inside `root`. */
  inkOutside(root: Element, bounds: Box): Array<{ what: string; box: Box }>;
  /** A CSS colour string resolved to [r, g, b, a] through a canvas. */
  rgba(css: string): number[];
  /** The opaque colour actually behind `el`, compositing translucent ancestor backgrounds. */
  effectiveBackground(el: Element): number[];
  /** `el`'s text colour composited over its effective background. */
  effectiveText(el: Element): number[];
  /** Whether `el` is shown and paints a box of its own: a fill or a border. */
  paints(el: Element): boolean;
  /** Elements under `root` that paint a box (fill or border), not nested inside another such element. */
  paintedBoxes(root: Element): HTMLElement[];
}

declare global {
  interface Window {
    __adminProbe: AdminProbe;
  }
}

/** Runs in the page. Self-contained: it is serialised into an init script. */
function installProbes(): void {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const table = () => document.querySelector('table.admin-data-table') as HTMLTableElement;
  const headerCells = () => {
    const head = table()?.tHead;
    return head && head.rows[0] ? ([...head.rows[0].cells] as HTMLTableCellElement[]) : [];
  };
  const headerLabels = () => headerCells().map((th) => norm(th.textContent));
  const colIndex = (label: string) => headerLabels().indexOf(label);
  // Study rows only. Step 2's Close study notices are full-width rows in the
  // same <tbody> (`.admin-inline-notice-row`), and are not studies.
  const rows = () => {
    const body = table()?.tBodies[0];
    return body
      ? ([...body.rows] as HTMLTableRowElement[]).filter((r) => !r.classList.contains('admin-inline-notice-row'))
      : [];
  };
  const cell = (row: HTMLTableRowElement, label: string) => {
    const i = colIndex(label);
    return i >= 0 ? (row.cells[i] as HTMLTableCellElement) ?? null : null;
  };
  const shown = (el: Element | null) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const elementWithText = (root: Element, text: string) => {
    const want = norm(text);
    const matches = [root, ...root.querySelectorAll('*')].filter((el) => norm(el.textContent) === want);
    // Deepest: the match none of whose descendants also matches.
    return (matches.find((el) => !matches.some((other) => other !== el && el.contains(other))) as HTMLElement) ?? null;
  };
  const box = (r: DOMRect | Box): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const intersect = (a: Box, b: Box): Box | null => {
    const out = {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    };
    return out.right - out.left > 0.5 && out.bottom - out.top > 0.5 ? out : null;
  };
  const clips = (el: Element) => {
    const cs = getComputedStyle(el);
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  };
  const TOL = 0.5;
  const inkOutside = (root: Element, bounds: Box) => {
    const out: Array<{ what: string; box: Box }> = [];
    const clipChain = (from: Element | null): Box | null | 'hidden' => {
      let acc: Box | null = null;
      for (let el = from; el && el !== root; el = el.parentElement) {
        if (!el.checkVisibility({ visibilityProperty: true })) return 'hidden';
        // `.visually-hidden`: screen-reader text, clipped to nothing by `clip`.
        if (getComputedStyle(el).clip !== 'auto') return 'hidden';
        if (clips(el)) {
          const b = box(el.getBoundingClientRect());
          acc = acc ? intersect(acc, b) : b;
          if (!acc) return 'hidden';
        }
      }
      return acc;
    };
    const check = (what: string, fragment: Box, clip: Box | null) => {
      const visible = clip ? intersect(fragment, clip) : fragment;
      if (!visible) return;
      if (
        visible.left < bounds.left - TOL ||
        visible.right > bounds.right + TOL ||
        visible.top < bounds.top - TOL ||
        visible.bottom > bounds.bottom + TOL
      ) {
        out.push({ what, box: visible });
      }
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!norm(n.textContent)) continue;
      const clip = clipChain(n.parentElement);
      if (clip === 'hidden') continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) check(`text "${norm(n.textContent).slice(0, 40)}"`, box(r), clip);
    }
    for (const el of root.querySelectorAll('svg, button, img, input, select')) {
      const clip = clipChain(el.parentElement);
      if (clip === 'hidden' || !el.checkVisibility({ visibilityProperty: true })) continue;
      check(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">`, box(el.getBoundingClientRect()), clip);
    }
    return out;
  };
  const rgba = (css: string) => {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[3] * top[i] + (1 - top[3]) * under[i]);
  const effectiveBackground = (el: Element) => {
    const layers: number[][] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    // Canvas white is what a browser paints under an unpainted root.
    return layers.reverse().reduce((acc, layer) => over(layer, acc), [255, 255, 255]);
  };
  const effectiveText = (el: Element) => over(rgba(getComputedStyle(el).color), effectiveBackground(el));
  const paints = (el: Element) => {
    const cs = getComputedStyle(el);
    const fill = rgba(cs.backgroundColor)[3] > 0;
    const border = ['Top', 'Right', 'Bottom', 'Left'].some(
      (side) =>
        parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
        cs.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' &&
        rgba(cs.getPropertyValue(`border-${side.toLowerCase()}-color`))[3] > 0
    );
    return (fill || border) && shown(el);
  };
  const paintedBoxes = (root: Element) => {
    const all = [...root.querySelectorAll('*')].filter(paints) as HTMLElement[];
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  };
  window.__adminProbe = {
    norm,
    table,
    headerCells,
    headerLabels,
    colIndex,
    rows,
    cell,
    shown,
    elementWithText,
    inkOutside,
    rgba,
    effectiveBackground,
    effectiveText,
    paints,
    paintedBoxes,
  };
}
