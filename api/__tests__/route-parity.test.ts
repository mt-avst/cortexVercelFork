/**
 * Route parity guard (Phase B6)
 *
 * Purpose: fail CI if the frontend (`frontend/src/api/client.ts`) calls an
 * `/api/...` path+method pair that has no corresponding Vercel serverless
 * function under `api/`. This is exactly the class of drift that produced
 * the gaps closed in Phase B1 (missing CRUD) and Phase B3 (gamification).
 *
 * How it works:
 *   1. Statically scan `frontend/src/api/client.ts` for every call made
 *      through the shared axios instance (`api.get/post/patch/put/delete`),
 *      plus the two call sites that bypass it (`axios.post(getAuthUrl(...))`
 *      for logout, and `redirectTo(`${getApiBaseUrl()}/api/...`)` for CSV
 *      exports). Dynamic template segments (e.g. `${id}`) are normalized to
 *      a generic `:param` placeholder.
 *   2. Walk every `.ts` file under `api/` (excluding test files, non-route
 *      utilities like `api/db.ts`, `api/utils/*`, `api/services/*`, and
 *      macOS resource-fork artifacts) and, for files that are real Vercel
 *      handlers (they import types from `@vercel/node` and `export default`
 *      a handler function), derive the path Vercel will route to them from
 *      the file path (`[id]` -> `:param`, `[...slug]` -> catch-all, `index`/
 *      bare files -> the parent path).
 *   3. For each handler file, figure out which HTTP methods it actually
 *      covers by grepping for `req.method === '...'` / `req.method !== '...'`
 *      comparisons in its body — most handlers 405 on anything they don't
 *      explicitly check for, so "covers" == "the methods it names".
 *      `api/calendar/[...slug].ts` is a special case: it's a catch-all that
 *      internally dispatches on a `route === '...'` literal, so each
 *      sub-route's methods are derived independently instead of treating
 *      the whole catch-all as blanket coverage (otherwise a real gap like
 *      the missing `disconnect` sub-route would be silently hidden).
 *   4. Assert every frontend-called path+method resolves to a covering
 *      handler, with a short, documented allowlist for endpoints that are
 *      *known* to not exist yet on this branch (see KNOWN_GAPS below) so
 *      the guard stays actionable instead of permanently red.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const API_ROOT = path.resolve(__dirname, '..');
const CLIENT_TS_PATH = path.join(REPO_ROOT, 'frontend', 'src', 'api', 'client.ts');

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface FrontendCall {
  method: Method;
  routePath: string; // normalized, e.g. /api/opportunities/:param
}

interface HandlerRoute {
  file: string; // path relative to api/
  routePath: string; // normalized, e.g. /api/opportunities/:param, or /api/calendar/* for a blanket catch-all
  methods: Set<Method> | 'ALL';
  isWildcard: boolean; // true => routePath is a prefix, matches routePath + '/*'
}

// ---------------------------------------------------------------------------
// Known, documented gaps — endpoints the frontend calls that do NOT yet have
// a Vercel handler on this branch. Each entry must say *why* so this list
// doesn't silently accumulate.
// ---------------------------------------------------------------------------
const KNOWN_GAPS: Array<{ method: Method; routePath: string; reason: string }> = [
  // --- Phase B4 (booking lifecycle + calendar) — not yet built ---
  // See ~/.claude-work/plans/can-you-please-plan-snuggly-noodle.md, "Phase B4".
  { method: 'POST', routePath: '/api/bookings/:param/reschedule', reason: 'Phase B4 (not yet built)' },
  { method: 'POST', routePath: '/api/bookings/sessions/:param/complete', reason: 'Phase B4 (not yet built)' },
  { method: 'POST', routePath: '/api/bookings/:param/approve', reason: 'Phase B4 (not yet built)' },
  { method: 'POST', routePath: '/api/bookings/:param/reject', reason: 'Phase B4 (not yet built)' },
  { method: 'DELETE', routePath: '/api/calendar/disconnect', reason: 'Phase B4 (no calendar service in api/ yet)' },
];

const KNOWN_GAP_KEYS = new Set(KNOWN_GAPS.map((g) => `${g.method} ${g.routePath}`));

// ---------------------------------------------------------------------------
// Step 1: extract every API call the frontend makes from client.ts
// ---------------------------------------------------------------------------

function normalizePath(raw: string): string {
  // Drop query strings (e.g. `/calendar/events?${params}` or `?id=${x}`)
  let p = raw.split('?')[0];
  // Collapse any ${...} template expression into a generic :param placeholder
  p = p.replace(/\$\{[^}]*\}/g, ':param');
  if (!p.startsWith('/api')) {
    p = `/api${p}`;
  }
  // Collapse duplicate slashes just in case
  p = p.replace(/\/{2,}/g, '/');
  return p;
}

function extractFrontendCalls(clientSource: string): FrontendCall[] {
  const calls: FrontendCall[] = [];

  // 1. api.get(...)/api.post(...)/api.patch(...)/api.put(...)/api.delete(...)
  //    on the shared axios instance — paths are relative (baseURL already
  //    includes /api).
  const apiCallRegex = /\bapi\.(get|post|put|patch|delete)\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  let match: RegExpExecArray | null;
  while ((match = apiCallRegex.exec(clientSource)) !== null) {
    const method = match[1].toUpperCase() as Method;
    const rawPath = match[2].slice(1, -1); // strip quote/backtick delimiters
    calls.push({ method, routePath: normalizePath(rawPath) });
  }

  // 2. axios.post(getAuthUrl('/api/auth/logout'), ...) — bypasses the shared
  //    instance because logout may hit a separate auth host; path is already
  //    absolute (/api/...).
  const authUrlRegex = /\baxios\.(get|post|put|patch|delete)\(\s*getAuthUrl\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = authUrlRegex.exec(clientSource)) !== null) {
    const method = match[1].toUpperCase() as Method;
    calls.push({ method, routePath: normalizePath(match[2]) });
  }

  // 3. redirectTo(`${getApiBaseUrl()}/api/...`) — full-page navigation (CSV
  //    export downloads), still a real GET against an api/ route.
  const redirectRegex = /redirectTo\(\s*`\$\{getApiBaseUrl\(\)\}([^`]*)`/g;
  while ((match = redirectRegex.exec(clientSource)) !== null) {
    calls.push({ method: 'GET', routePath: normalizePath(match[1]) });
  }

  return calls;
}

// ---------------------------------------------------------------------------
// Step 2 + 3: walk api/ and build the set of routes Vercel will actually serve
// ---------------------------------------------------------------------------

const EXCLUDED_DIR_NAMES = new Set(['node_modules', '__tests__', 'utils', 'services']);
const EXCLUDED_FILES = new Set(['db.ts']);

function walkApiFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Skip macOS AppleDouble resource-fork files (e.g. "._foo.ts")
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkApiFiles(fullPath, out);
      continue;
    }

    if (!entry.name.endsWith('.ts')) continue;
    if (EXCLUDED_FILES.has(entry.name)) continue;

    out.push(fullPath);
  }
  return out;
}

function isVercelHandlerFile(source: string): boolean {
  return source.includes('@vercel/node') && /export default/.test(source);
}

/** Convert an api/-relative file path into its Vercel-routed URL path. */
function fileToRoutePath(relFile: string): { routePath: string; isCatchAll: boolean } {
  const noExt = relFile.replace(/\.ts$/, '');
  const segments = noExt.split(path.sep);

  let isCatchAll = false;
  const routeSegments = segments
    .map((seg, idx) => {
      const isLast = idx === segments.length - 1;
      if (isLast && seg === 'index') return null; // index.ts -> parent path
      const catchAllMatch = seg.match(/^\[\.\.\.(.+)\]$/);
      if (catchAllMatch) {
        isCatchAll = true;
        return '*';
      }
      const paramMatch = seg.match(/^\[(.+)\]$/);
      if (paramMatch) return ':param';
      return seg;
    })
    .filter((seg): seg is string => seg !== null);

  // Drop a trailing catch-all marker; the prefix before it is what we match against.
  if (isCatchAll && routeSegments[routeSegments.length - 1] === '*') {
    routeSegments.pop();
  }

  const routePath = `/api/${routeSegments.join('/')}`.replace(/\/{2,}/g, '/');
  return { routePath, isCatchAll };
}

/** Extract the set of HTTP methods a handler body explicitly checks `req.method` against. */
function extractMethodsFromSource(source: string): Set<Method> {
  const methods = new Set<Method>();
  const methodRegex = /req\.method\s*(?:===|!==)\s*['"]([A-Z]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(source)) !== null) {
    methods.add(m[1] as Method);
  }
  return methods;
}

/**
 * Special-case handling for catch-all handlers that internally dispatch on a
 * literal sub-route name (the only one on this branch is
 * `api/calendar/[...slug].ts`, which branches on `route === 'availability'`
 * etc.). We derive per-sub-route method coverage from each dispatch block
 * instead of assuming the whole catch-all covers every method for every
 * possible sub-path — that would hide real gaps like the missing
 * `disconnect` sub-route.
 */
function extractCatchAllSubRoutes(basePath: string, source: string): HandlerRoute[] {
  const dispatchRegex = /route\s*===\s*['"]([^'"]+)['"]/g;
  const matches: Array<{ literal: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = dispatchRegex.exec(source)) !== null) {
    matches.push({ literal: m[1], index: m.index });
  }

  if (matches.length === 0) {
    // No literal-dispatch pattern found — fall back to a genuine blanket
    // catch-all (matches any sub-path, any method).
    return [{ file: '', routePath: basePath, methods: 'ALL', isWildcard: true }];
  }

  return matches.map((mm, i) => {
    const blockEnd = i + 1 < matches.length ? matches[i + 1].index : source.length;
    const block = source.slice(mm.index, blockEnd);
    return {
      file: '',
      routePath: `${basePath}/${mm.literal}`.replace(/\/{2,}/g, '/'),
      methods: extractMethodsFromSource(block),
      isWildcard: false,
    };
  });
}

function buildHandlerRoutes(): HandlerRoute[] {
  const files = walkApiFiles(API_ROOT);
  const routes: HandlerRoute[] = [];

  for (const absFile of files) {
    const source = fs.readFileSync(absFile, 'utf8');
    if (!isVercelHandlerFile(source)) continue;

    const relFile = path.relative(API_ROOT, absFile);
    const { routePath, isCatchAll } = fileToRoutePath(relFile);

    if (isCatchAll) {
      routes.push(...extractCatchAllSubRoutes(routePath, source).map((r) => ({ ...r, file: relFile })));
      continue;
    }

    const methods = extractMethodsFromSource(source);
    routes.push({
      file: relFile,
      routePath,
      // A handler with no req.method checks at all responds regardless of
      // method (no guard clause), so treat it as covering everything.
      methods: methods.size > 0 ? methods : 'ALL',
      isWildcard: false,
    });
  }

  return routes;
}

function resolveCall(call: FrontendCall, routes: HandlerRoute[]): HandlerRoute | undefined {
  // Exact path match first.
  const exact = routes.find(
    (r) => !r.isWildcard && r.routePath === call.routePath && (r.methods === 'ALL' || r.methods.has(call.method))
  );
  if (exact) return exact;

  // Wildcard/catch-all prefix match.
  return routes.find(
    (r) =>
      r.isWildcard &&
      (call.routePath === r.routePath || call.routePath.startsWith(`${r.routePath}/`)) &&
      (r.methods === 'ALL' || r.methods.has(call.method))
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('route parity: frontend client.ts calls vs. api/ handlers', () => {
  const clientSource = fs.readFileSync(CLIENT_TS_PATH, 'utf8');
  const frontendCalls = extractFrontendCalls(clientSource);
  const handlerRoutes = buildHandlerRoutes();

  test('sanity check: extracted a non-trivial number of frontend calls and handler routes', () => {
    // Guards against the regexes silently matching nothing if client.ts's
    // call style changes and this test's parser needs updating too.
    expect(frontendCalls.length).toBeGreaterThan(20);
    expect(handlerRoutes.length).toBeGreaterThan(20);
  });

  test('every frontend-called path+method resolves to a real api/ handler (or is a documented gap)', () => {
    const missing: string[] = [];

    for (const call of frontendCalls) {
      const key = `${call.method} ${call.routePath}`;
      const resolved = resolveCall(call, handlerRoutes);
      if (!resolved && !KNOWN_GAP_KEYS.has(key)) {
        missing.push(key);
      }
    }

    // De-dupe (client.ts may call the same endpoint from multiple functions).
    const uniqueMissing = Array.from(new Set(missing)).sort();

    if (uniqueMissing.length > 0) {
      const details = uniqueMissing
        .map((k) => {
          const [method, p] = k.split(' ');
          return `  - Frontend calls ${method} ${p} but no api/ handler covers ${method} for that path`;
        })
        .join('\n');
      throw new Error(
        `Route parity check failed — frontend/backend drift detected:\n${details}\n\n` +
          `If this is a genuinely new, temporarily-missing endpoint, add it to KNOWN_GAPS in ` +
          `api/__tests__/route-parity.test.ts with a comment explaining why. Otherwise, add the ` +
          `missing api/ handler.`
      );
    }
  });

  test('KNOWN_GAPS entries are still actually missing (flag stale allowlist entries)', () => {
    const stillMissing = KNOWN_GAPS.filter((gap) => {
      const resolved = resolveCall({ method: gap.method, routePath: gap.routePath }, handlerRoutes);
      return !resolved;
    });

    const nowResolved = KNOWN_GAPS.filter((gap) => !stillMissing.includes(gap));
    if (nowResolved.length > 0) {
      const list = nowResolved.map((g) => `  - ${g.method} ${g.routePath} (${g.reason})`).join('\n');
      // eslint-disable-next-line no-console
      console.warn(
        `Some KNOWN_GAPS entries now have a matching api/ handler and can be removed from the ` +
          `allowlist in api/__tests__/route-parity.test.ts:\n${list}`
      );
    }

    // This test intentionally never fails the build — it's a heads-up, not a
    // gate. Failing here would punish someone for closing a gap early.
    expect(true).toBe(true);
  });
});
