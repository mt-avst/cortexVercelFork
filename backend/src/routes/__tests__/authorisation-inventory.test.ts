import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect, jest } from '@jest/globals';
import type { Router } from 'express';
import express from 'express';

// Only what the routers touch at import time. Nothing here executes a handler:
// this file reads mounted middleware stacks and nothing else.
//
// `config` is the REAL one, spread back in, because `index.ts` reads
// `config.NODE_ENV` and `config.PORT` at import time and this file imports the
// app to read its actual mount table. Only the pool is a double.
jest.mock('../../config', () => ({
  ...(jest.requireActual('../../config') as object),
  pool: { query: jest.fn(), connect: jest.fn() }
}));
jest.mock('../../utils/database', () => ({ isDatabaseAvailable: jest.fn() }));

import {
  requireAuth,
  requireAdmin,
  requireSuperadmin,
  withLiveRole,
  withLiveRoleIfPresent,
  optionalAuth
} from '../../middleware/authenticate';
import { bindParticipantSession } from '../../middleware/firsthand-session';

import apiRouter from '../api';
import authRouter from '../auth';
import cronRouter from '../cron';
// The assembled app, imported for its mount table and nothing else. `index.ts`
// guards `app.listen` and both cron schedules behind `NODE_ENV !== 'test'`
// precisely so a test can read the real wiring rather than a copy of it.
import app from '../../index';

/**
 * WHAT GUARDS EVERY ROUTE IN THE PRODUCT, written down as a decision. #13.
 *
 * THE DEFECT THIS CLOSES was not a missing gate, it was a NARROW INVENTORY.
 * `runtime-pool-admission-routes.test.ts` compares whole maps - so a route
 * added to a router it covers fails until somebody writes down a verdict - but
 * it imports exactly three routers. A security gate on !217 proved the cost by
 * paired mutation: an ungated `GET /:id/sessions/:sessionId/answers-probe`
 * returning raw responses, transcript and assets was added to
 * `session-outputs.ts` and NOTHING saw it (jest 843 passed, vitest 625 passed,
 * tsc clean), while the identical route on `firsthand.ts` failed two suites
 * immediately. The difference was entirely which routers the table imported.
 *
 * So this file does not take a list of routers. It DISCOVERS them:
 *
 *   1. every `*.ts` in `src/routes` is read off disk, so a router file cannot
 *      exist without being accounted for here;
 *   2. the mount graph is walked from the three routers `index.ts` mounts on
 *      the app, recursing through `router.use`, so a router reached at any
 *      depth contributes its routes at its real URL;
 *   3. every file from (1) must be reached by (2), which is what makes a
 *      hand-written import list impossible to fall behind. A new router that
 *      nobody mounted fails here, and so does a mounted router nobody listed.
 *
 * The verdict is derived from the middleware chain, which is the only thing a
 * stack walk can see. In-handler owner scoping is NOT visible here and is
 * pinned per route by its own suite (`session-outputs-internal.test.ts`,
 * `bookings.*-ownership.test.ts`, `opportunities.delete-sessions-is-scoped`,
 * `calendar.events-ownership`, and the shared-helper guard in
 * `owner-comparisons-go-through-the-helper.test.ts`). What this file guarantees
 * is that no route reaches production without somebody writing down which of
 * those regimes it is in.
 *
 * ponytail: the mount-graph walk decodes Express 4 layer regexps to recover a
 * mount prefix, and throws on a parameterised mount rather than guessing.
 *   -> if a parameterised `router.use('/:x', sub)` is ever wanted, extend
 *      mountPathOf using `layer.keys` (the names are already there).
 */

type Verdict =
  /** No middleware gate at all. Open to the internet, by decision. */
  | 'public'
  /** No middleware gate; the handler itself checks a shared secret. */
  | 'in-handler-secret'
  /** `optionalAuth`: a session is read when present and never required. */
  | 'optional-session'
  /**
   * `optionalAuth` + `withLiveRoleIfPresent`: still never requires a session,
   * but an ADMIN session's role is re-read from `users` before the handler's
   * own inline branch sees it (#45). A signed-out or participant caller is
   * handed straight on, with no extra query.
   */
  | 'optional-session+live-role'
  /** `requireAuth`: any signed-in user, role as SNAPSHOTTED at login. */
  | 'session'
  /** `requireAuth` + `withLiveRole`: handler decides, on the LIVE role (#37). */
  | 'session+live-role'
  /** `requireAuth` + `bindParticipantSession`: the caller's own session only. */
  | 'participant-token'
  /** `requireAdmin`: live role must be researcher_admin or superadmin (#14). */
  | 'admin'
  /** `requireSuperadmin`: live role must be superadmin (#14). */
  | 'superadmin';

type HandlerLayer = { handle: unknown; name?: string };
type Layer = {
  handle?: unknown;
  name?: string;
  keys?: Array<{ name: string | number }>;
  regexp?: RegExp & { fast_slash?: boolean };
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: HandlerLayer[];
  };
};

const layersOf = (router: Router): Layer[] =>
  (router as unknown as { stack: Layer[] }).stack;

const isRouter = (value: unknown): value is Router =>
  typeof value === 'function' &&
  Array.isArray((value as unknown as { stack?: unknown }).stack);

/**
 * The mount prefix of a `router.use` layer, recovered from its path regexp.
 *
 * Express 4 keeps no plain copy of the string, so this reverses the two shapes
 * it generates: `fast_slash` for a mount with no path, and a literal prefix
 * otherwise. A parameterised mount THROWS rather than being silently decoded
 * wrong - a wrong prefix would put a route in the table under a URL that does
 * not exist, which reads as green.
 */
function mountPathOf(layer: Layer): string {
  const regexp = layer.regexp;
  if (!regexp || regexp.fast_slash) return '';
  if (layer.keys && layer.keys.length > 0) {
    throw new Error(`parameterised mount not decodable: ${String(regexp)}`);
  }

  const source = regexp.source;
  const literal = /^\^((?:\\\/[\w\-.]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
  if (!literal) {
    throw new Error(`unrecognised mount regexp: ${source}`);
  }
  return literal[1].replace(/\\\//g, '/');
}

/**
 * WHO WRITES `req.user` FROM THE SESSION, AND WHO MUST RUN AFTER THEM. #56.
 *
 * `requireAuth` and `optionalAuth` COPY `req.session.user` onto `req.user`,
 * role included - and the role in a session is the one snapshotted at login.
 * Every other middleware in the vocabulary must run after that copy, but NOT
 * all for the same reason, and an earlier draft of this docblock gave one
 * reason for all five. Read off the source rather than remembered:
 *
 *   `requireAdmin` (authenticate.ts:83), `requireSuperadmin` (:105),
 *   `withLiveRole` (:150) and `withLiveRoleIfPresent` (:208) all read
 *   `req.session?.user` and never `req.user`. They do not NEED `req.user` set;
 *   they SET it, to the live role read from `users`. A copier after one of
 *   them therefore CLOBBERS that live role with the login snapshot, re-opening
 *   #14, #37 or #45 on that route.
 *
 *   `bindParticipantSession` is the only one that reads `req.user` outright
 *   (`middleware/firsthand-session.ts:33`). A copier after IT means `req.user`
 *   is still unset at the moment it reads.
 *
 * Two mechanisms, one rule - the copy comes first - and the throw says which
 * mechanism it hit, because "overwrites the live role" is simply untrue of the
 * bind pair and a message that lies is worse than a message that is vague.
 *
 * Named rather than anonymous so an ordering failure says WHICH pair.
 */
const SESSION_COPIERS = new Map<unknown, string>([
  [requireAuth, 'requireAuth'],
  [optionalAuth, 'optionalAuth']
]);

/** Why a session copy running after this one breaks it. */
type BreakageMode = 'clobbers-live-role' | 'reads-unset-req-user';

const MUST_RUN_AFTER_THE_COPY = new Map<unknown, [string, BreakageMode]>([
  [requireAdmin, ['requireAdmin', 'clobbers-live-role']],
  [requireSuperadmin, ['requireSuperadmin', 'clobbers-live-role']],
  [withLiveRole, ['withLiveRole', 'clobbers-live-role']],
  [withLiveRoleIfPresent, ['withLiveRoleIfPresent', 'clobbers-live-role']],
  [bindParticipantSession, ['bindParticipantSession', 'reads-unset-req-user']]
]);

const BREAKAGE_REASON: Record<BreakageMode, string> = {
  'clobbers-live-role': 'so it overwrites the live role with the session copy',
  'reads-unset-req-user': 'so req.user is still unset when it reads it'
};

/**
 * The verdict the middleware chain of one route earns.
 *
 * THE PRIMITIVE IS POSITIONAL, not membership (#56). The previous version's
 * only primitive was `stack.some(...)`, which says a handler is somewhere in
 * the chain and nothing about where - so reversing the real catalogue chain to
 * `withLiveRoleIfPresent, optionalAuth` left the verdict reading
 * `optional-session+live-role` when `optionalAuth` now ran last and overwrote
 * the live role with the session copy. A verdict that survives its own chain
 * being reversed is not a verdict, and this file writes verdicts down as fact.
 *
 * The ordering check covers every verdict at once rather than per route, and it
 * refuses rather than downgrading: an out-of-order chain is a bug on the route,
 * not a weaker regime somebody chose. `refuses a chain whose ORDER defeats the
 * gate it carries` and its control below prove both directions.
 *
 * WHAT "EVERY VERDICT" DOES NOT MEAN, so the claim is not read wider than the
 * check. It is every verdict in the VOCABULARY THIS FILE KNOWS - the seven
 * handlers in the two maps above. #56's fourth bullet, the limiter ordering, is
 * NOT covered: moving `surveyResultsLimiter` ahead of `requireAdmin` on
 * `GET /api/opportunities/:id/survey-results` leaves this file green, because
 * `perUserLimiter` and `boundResultsRead` read `req.user?.id` with a
 * shared-bucket fallback and are not middlewares this file has an identity for.
 * That reversal is red by name elsewhere - `opportunities.test.ts` and the
 * results-read gate, measured at five failures - and
 * `a-limiter-sits-after-the-auth-gate-not-before-it` is its canary.
 *
 * ponytail: the vocabulary is a hand-written pair of maps, so a middleware that
 * reads `req.user` and is not listed is invisible to the ordering check.
 *   -> a new one is only safe silently if it does not depend on the copy;
 *      anything that reads `req.user` or writes a live role belongs in
 *      MUST_RUN_AFTER_THE_COPY, and adding it there is a one-line diff.
 */
function verdictOf(stack: HandlerLayer[]): Verdict {
  const handlers = stack.map((entry) => entry.handle);
  const carries = (handler: unknown) => handlers.includes(handler);

  // LAST copy against FIRST dependant, which is the strictest reading of a
  // chain that mentions one of these twice - once router-level and once on the
  // route, say. Absent handlers drop out on the `-1` guards below rather than
  // by arithmetic.
  for (const [copier, copierName] of SESSION_COPIERS) {
    const copiedAt = handlers.lastIndexOf(copier);
    if (copiedAt === -1) continue;

    for (const [dependant, [dependantName, mode]] of MUST_RUN_AFTER_THE_COPY) {
      const runsAt = handlers.indexOf(dependant);
      if (runsAt !== -1 && runsAt < copiedAt) {
        throw new Error(
          `chain order: ${copierName} runs after ${dependantName}, ` +
            BREAKAGE_REASON[mode]
        );
      }
    }
  }

  if (carries(requireSuperadmin)) return 'superadmin';
  if (carries(requireAdmin)) return 'admin';
  if (carries(bindParticipantSession)) {
    if (!carries(requireAuth)) {
      throw new Error('token binding without requireAuth');
    }
    return 'participant-token';
  }
  if (carries(withLiveRole)) {
    if (!carries(requireAuth)) {
      throw new Error('withLiveRole without requireAuth');
    }
    return 'session+live-role';
  }
  if (carries(withLiveRoleIfPresent)) {
    // Its whole point is serving a signed-out caller, so it is only meaningful
    // behind `optionalAuth`. Chained after `requireAuth` it would be a
    // needlessly narrow `withLiveRole`, and the verdict below would understate
    // the gate - loud instead.
    if (!carries(optionalAuth)) {
      throw new Error('withLiveRoleIfPresent without optionalAuth');
    }
    return 'optional-session+live-role';
  }
  if (carries(requireAuth)) return 'session';
  if (carries(optionalAuth)) return 'optional-session';
  return 'public';
}

/**
 * `METHOD /full/path` -> verdict, for every route reachable from `router`.
 *
 * Recurses through `router.use`, so the inventory covers the whole graph rather
 * than the routers somebody remembered to import. Router-level middleware is
 * inherited by every route below it, which is how `firsthand-session`'s
 * `router.use(participantRuntimeWork)` and its per-route guards compose.
 *
 * IT THROWS RATHER THAN RECORDING A HALF-TRUTH, in three cases, and all three
 * are shapes a refute gate served a live unauthenticated 200 through while this
 * suite reported green:
 *
 *  1. A PARAMETERISED MOUNT, which cannot be decoded to a URL. Filing a real
 *     route under a URL that does not exist reads as coverage.
 *  2. A PATH-SCOPED TERMINAL HANDLER - `router.use('/probe', handler)`. It has
 *     no `.stack`, so it is not a router, and the obvious fallthrough treats it
 *     as router-level middleware: the endpoint vanishes from the map AND its
 *     handler is then wrongly credited as an inherited guard to every route
 *     registered after it. Two wrong answers from one missing branch.
 *  3. A DUPLICATE `METHOD /path`. Assignment into a map is last-wins; Express
 *     dispatches FIRST-wins. So an ungated duplicate registered ahead of a
 *     gated one is recorded with the gated verdict, the route count does not
 *     move, and the ungated handler is the one that serves. A duplicate key is
 *     either a bug or a shadow and is never something to overwrite quietly.
 *
 * CASE 2 REJECTS THREE LEGITIMATE SHAPES, and that is the intended trade
 * rather than a bug to file. Failing closed on an unrecognised registration is
 * correct for a security inventory - the alternative is a route nobody can
 * see - but the message alone will not tell you which of these you hit:
 *
 *   - `router.use('/x', subApp)` - an Express APP, not a Router. It keeps its
 *     stack on `_router`, so `isRouter` says no. This one arguably deserves to
 *     be walked; nothing in this repository mounts one, so it is not.
 *   - `router.use('/assets', express.static(...))` - a real endpoint serving
 *     real bytes, and flagging it is arguably right.
 *   - `router.use('/x', errorHandler)` - a path-scoped 4-arity error handler.
 *     A plain false positive.
 *
 * If you are here because one of those went red, widen the branch deliberately
 * and add the case to this list. Do not loosen it to `continue`.
 *
 * THE KNOWN RESIDUAL, named so the refusal above does not read as total:
 * `router.use('/', handler)` STILL HIDES A LIVE ENDPOINT. Express marks a `'/'`
 * mount as `fast_slash`, indistinguishable from `router.use(fn)`, so it is
 * filed as middleware - and appending one to `api.ts` serves
 * `GET /api/no-such-route` as a 200 with no cookie while this file stays green.
 * A stack walk cannot tell a terminal handler from a pass-through without
 * calling it, and the control test two hundred lines below depends on
 * `router.use(fn)` being treated as middleware. Deliberately not closed.
 *
 * ponytail: `use('/', handler)` is invisible to this inventory.
 *   -> closing it needs the middleware CALLED with a probe request to see
 *      whether it hands off to next(), which is a different kind of test.
 *
 * WHAT THIS FILE IS EXHAUSTIVE OVER, stated plainly so nobody has to infer it
 * from what the assertions happen to cover. It is exhaustive over every router
 * reachable from the app, over the routes on those routers, over app-level
 * routes, and over app-level path-scoped handlers - each compared as a whole
 * map or a whole list, in both directions. It is NOT exhaustive over
 * `use('/', handler)` on any router, nor over a mount behind a branch on the
 * `config` singleton as opposed to `process.env`. Both are named above with
 * what closing them would cost.
 */
function inventory(
  router: Router,
  prefix: string,
  inherited: HandlerLayer[] = [],
  into: Record<string, Verdict> = {}
): Record<string, Verdict> {
  const carriedDown = [...inherited];

  for (const layer of layersOf(router)) {
    if (layer.route) {
      const route = layer.route;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      const verdict = verdictOf([...carriedDown, ...route.stack]);
      for (const method of Object.keys(route.methods)) {
        for (const routePath of paths) {
          const full = `${prefix}${routePath === '/' ? '' : routePath}` || '/';
          const key = `${method.toUpperCase()} ${full}`;
          if (key in into) {
            throw new Error(`route registered twice, so one of them shadows the other: ${key}`);
          }
          into[key] = verdict;
        }
      }
      continue;
    }

    if (isRouter(layer.handle)) {
      inventory(
        layer.handle,
        `${prefix}${mountPathOf(layer)}`,
        carriedDown,
        into
      );
      continue;
    }

    if (layer.regexp && !layer.regexp.fast_slash) {
      throw new Error(
        `path-scoped handler is an endpoint, not middleware: ${String(layer.regexp)}`
      );
    }

    // A plain `router.use(fn)`: inherited by everything registered after it.
    carriedDown.push({ handle: layer.handle, name: layer.name });
  }

  return into;
}

/** Every router module reached from the app's three roots, by identity. */
function routersReachedFrom(roots: Router[]): Set<unknown> {
  const seen = new Set<unknown>(roots);
  const queue = [...roots];

  while (queue.length > 0) {
    for (const layer of layersOf(queue.pop()!)) {
      if (layer.route || !isRouter(layer.handle) || seen.has(layer.handle)) {
        continue;
      }
      seen.add(layer.handle);
      queue.push(layer.handle);
    }
  }

  return seen;
}

/**
 * THE THREE ROUTERS `index.ts` MOUNTS ON THE APP, and their URLs.
 *
 * A literal, because importing `index.ts` starts a server and a scheduler.
 *
 * IT IS THE PREFIXES THAT NEEDED THE GUARD, and an earlier version of this
 * docblock claimed one it did not have. It said the literal "is checked twice
 * below" and named the import list and the disk scan - neither of which looks
 * at a prefix at all. A refute gate changed `app.use('/api', apiRoutes)` to
 * `app.use('/v2', apiRoutes)` and this file stayed green while asserting 88
 * URLs that no longer existed. So `mountsMatchIndex` below reads the actual
 * `app.use` lines out of `index.ts` and compares the PATHS, and it is the
 * check this comment used to describe.
 */
const ROOTS: ReadonlyArray<readonly [string, Router]> = [
  ['/api', apiRouter],
  ['/auth', authRouter],
  ['/api/cron', cronRouter]
];

/** `/auth` is also mounted at `/api/auth`; same router, same verdicts. */
const AUTH_ALIAS_PREFIX = '/api/auth';

/**
 * THE ONLY ROUTES ALLOWED TO CARRY NO MIDDLEWARE GATE AND STILL BE GATED.
 *
 * A stack walk cannot see a check made inside a handler, so a route that
 * authenticates itself would otherwise be filed as `public` - a wrong verdict
 * written down as fact. This is the exception list, and it is deliberately a
 * list of one key and a reason rather than a rule: anything that wants to join
 * it has to be added by hand, in a diff, with the reason next to it.
 *
 * It cannot rot silently either: `overridesMatchRealRoutes` below fails if a
 * key here has no route, and the whole-map comparison fails if a route here
 * stops carrying its in-handler check's `public` middleware shape.
 */
const IN_HANDLER_GATES: Record<string, Verdict> = {
  // Constant-time `Bearer CRON_SECRET` compare in the handler, so that a
  // scheduler with no cookie can trigger the reminder job. Pinned by
  // `cron.constant-time-secret.test.ts`.
  'GET /api/cron/send-reminders': 'in-handler-secret',
  // Single-use, browser-bound OAuth `state` consumed in the handler, which
  // carries the initiating user's id server-side. It CANNOT use `requireAuth`:
  // the route is entered by a top-level navigation redirected from
  // accounts.google.com, and the app session cookie is SameSite=Strict in
  // production, so it is withheld across that redirect chain - `requireAuth`
  // would 401 the researcher after they had already granted Google access
  // (cto/AdaptaLabs#89). Pinned by `userCalendar.connect-flow.test.ts`.
  'GET /api/calendar/auth/callback': 'in-handler-secret'
};

const ROUTES_DIR = path.join(__dirname, '..');

/**
 * WHAT GUARDS WHAT. Exhaustive, and compared as a whole map in BOTH
 * directions: a route with no entry fails, and an entry with no route fails.
 *
 * Reading notes, per group, so the next reader does not have to re-derive the
 * ones that are not obvious:
 *
 * - `/api/opportunities/:id/sessions/:sessionId/...` is the answer surface the
 *   issue was about - responses, transcript, assets and the recording bytes.
 *   `admin` is the MIDDLEWARE verdict; both routes additionally run
 *   `assertOpportunityOwnership` in the handler, so a colleague's session is a
 *   403 rather than a read. That in-handler half is pinned by
 *   `session-outputs-internal.test.ts`.
 * - FIVE ROUTES ARE THE PARTICIPANT CATALOGUE, and they are the group most
 *   worth reading twice. All five serve a signed-out browser. FOUR of them
 *   additionally branch internally on `req.user?.role` to decide whether the
 *   caller sees drafts, unredacted rows and `clicks_total`: `GET
 *   /api/opportunities`, `GET /api/opportunities/:id`, `GET
 *   /api/opportunities/:id/sessions` and `GET
 *   /api/opportunities/:id/recorded-study-brief`, the last being the
 *   pre-consent landing-page brief.
 *
 *   That inline branch read the role SNAPSHOTTED AT LOGIN, which is the shape
 *   #14 and #37 closed elsewhere, and #45 closed it here. `withLiveRole` could
 *   not be dropped in: it 401s without a session, and these routes must answer
 *   without one. `withLiveRoleIfPresent` re-reads instead, and ONLY when the
 *   session's stored role is already an admin one - a re-read can only take
 *   privilege away, so a participant has nothing to gain from it and the hot
 *   catalogue load keeps its query count. The accepted trade is that a
 *   PROMOTION waits for the next login. Hence `optional-session+live-role`:
 *   still no session required, and no `admin` guarantee claimed that this chain
 *   does not deliver.
 *
 *   THE FIFTH, `POST /api/opportunities/:id/click`, stays plain
 *   `optional-session` and that is a decision rather than an omission: it reads
 *   `req.user?.id` and never the role, so there is no branch for a stale role
 *   to reach. `clicks_total` on the list route is the one branch already decided
 *   in the open, in `opportunities.clicks-total-scope.test.ts` (#19).
 * - THREE `session+live-role` ROUTES, all the same shape: the route admits
 *   non-admins as well, so `requireAdmin` cannot cover it, and the handler's own
 *   role branch reads the LIVE role rather than the one snapshotted at login.
 *   `POST /api/bookings/:id/cancel` admits participants and admins (#37);
 *   `GET /api/admin/dashboard` and `POST /api/admin/request` are the admin.ts
 *   pair (#38), covered below.
 * - Everything else on `/api/bookings` is `session` with the ownership decision
 *   inside the handler, except `GET /api/bookings/opportunities/:id/bookings`
 *   which is admin-only outright.
 * - `GET /api/admin/dashboard` and `POST /api/admin/request` carry no ADMIN gate
 *   despite the prefix: the dashboard is the "am I an admin" surface every
 *   signed-in user loads, and the request route is how a non-admin ASKS to
 *   become one. A prefix is not a gate, which is the sort of thing an inventory
 *   is for. They were `session` until #38, and the gap that verdict recorded was
 *   real: the dashboard makes THREE decisions from the role, and a superadmin
 *   demoted to researcher_admin passes its in-handler gate legitimately while
 *   both scope constants still read `superadmin` and widen to no filter at all -
 *   global counts and every other researcher's participant names and emails. The
 *   in-handler gate is unchanged; what moved is that the role it reads is live.
 * - `/api/gamification/leaderboard` and `/leaderboard/monthly` are `public` by
 *   decision: a leaderboard nobody can see before signing in is not a
 *   leaderboard. `/api/stats/platform` likewise.
 * - `POST /api/feedback` is `public` so a signed-out user can report that sign
 *   in is broken.
 * - `/auth/*` is `public` by necessity - it is what issues the session - and is
 *   the one group mounted twice, under `/auth` and `/api/auth`.
 * - `GET /api/cron/send-reminders` is `in-handler-secret`: no middleware, a
 *   constant-time `Bearer CRON_SECRET` comparison in the handler, pinned by
 *   `cron.constant-time-secret.test.ts`.
 */
const EXPECTED_AUTHORISATION: Record<string, Verdict> = {
  // api.ts - the root of everything under /api
  'GET /api/me': 'session',
  'GET /api/me/session-events': 'session',

  // opportunities.ts
  'GET /api/opportunities': 'optional-session+live-role',
  'POST /api/opportunities': 'admin',
  'GET /api/opportunities/:id': 'optional-session+live-role',
  'PATCH /api/opportunities/:id': 'admin',
  'DELETE /api/opportunities/:id': 'admin',
  'GET /api/opportunities/:id/analytics': 'admin',
  'POST /api/opportunities/:id/click': 'optional-session',
  'POST /api/opportunities/:id/close-if-past': 'admin',
  'POST /api/opportunities/:id/duplicate': 'admin',
  'POST /api/opportunities/:id/firsthand-handoff': 'session',
  'GET /api/opportunities/:id/recorded-study-brief': 'optional-session+live-role',
  'POST /api/opportunities/:id/recorded-study-session': 'session',
  'GET /api/opportunities/:id/session-events': 'admin',
  'GET /api/opportunities/:id/sessions': 'optional-session+live-role',
  'POST /api/opportunities/:id/sessions': 'admin',
  'DELETE /api/opportunities/:id/sessions': 'admin',
  'POST /api/opportunities/:id/survey-session': 'session',
  'GET /api/opportunities/:id/survey-results': 'admin',
  'GET /api/opportunities/:id/survey-results.csv': 'admin',

  // session-outputs.ts - the answer surface #13 was written about
  'GET /api/opportunities/:id/sessions/:sessionId/outputs': 'admin',
  'GET /api/opportunities/:id/sessions/:sessionId/assets/:assetId/media': 'admin',

  // sessions.ts
  'POST /api/sessions': 'admin',
  'PATCH /api/sessions/:id': 'admin',
  'DELETE /api/sessions/:id': 'admin',
  'POST /api/sessions/sync-booked-counts': 'superadmin',

  // bookings.ts
  'POST /api/bookings/sessions/:id/book': 'session',
  'POST /api/bookings/sessions/:id/complete': 'session',
  'POST /api/bookings/:id/cancel': 'session+live-role',
  'POST /api/bookings/:id/reschedule': 'session',
  // `POST /api/bookings/cleanup-cancelled` was here, verdict `session`, and the
  // verdict was accurate - one SELECT scoped by `WHERE b.user_id = $1`. The
  // route is DELETED rather than re-gated (#49): it mutated nothing, nothing
  // called it, and it carried a commented-out bulk DELETE. See
  // bookings.cleanup-cancelled-is-gone.test.ts.
  'GET /api/bookings/my/bookings': 'session',
  // `GET /api/bookings/my/bookings/debug` was here, same verdict, and the
  // verdict never changed: #54 RENAMED the route to `/my/bookings/all` and
  // touched nothing else. It is the route `bookings.cleanup-cancelled-is-gone
  // .test.ts` rests #49's "nothing is lost" argument on, so a name that told
  // the next reader it was disposable was the actual defect.
  'GET /api/bookings/my/bookings/all': 'session',
  'GET /api/bookings/opportunities/:id/bookings': 'admin',
  'GET /api/bookings/pending-approvals': 'session',
  'POST /api/bookings/:bookingId/approve': 'session',
  'POST /api/bookings/:bookingId/reject': 'session',
  // #79: the researcher-notes write. Same gate family as approve/reject one
  // line up - `requireAuth`, then the handler re-reads the LIVE role and
  // requires owner-or-superadmin on the opportunity. Owned by
  // bookings.researcher-notes.test.ts, both directions.
  'PUT /api/bookings/:bookingId/notes': 'session',

  // booking-artifacts.ts (#79 step 2) - researcher-side ingest of recordings
  // and transcripts of a moderated session. `requireAdmin` outright (the
  // uploader is never a participant), then owner-or-superadmin on the
  // opportunity through the booking join inside every handler, then the D3
  // consent-or-attestation gate on the two write routes. Owned by
  // booking-artifacts.test.ts, both directions.
  'POST /api/bookings/:bookingId/artifacts/presign': 'admin',
  'POST /api/bookings/:bookingId/artifacts/finalize': 'admin',
  'GET /api/bookings/:bookingId/artifacts': 'admin',
  'DELETE /api/bookings/:bookingId/artifacts/:artifactId': 'admin',

  // calendar.ts
  'GET /api/calendar/events': 'admin',
  'GET /api/calendar/availability': 'admin',
  'POST /api/calendar/check-conflicts': 'admin',

  // userCalendar.ts - same /api/calendar prefix, personal rather than admin
  'GET /api/calendar/auth/callback': 'in-handler-secret',
  'GET /api/calendar/auth/connect': 'session',
  'GET /api/calendar/my-events': 'session',
  'GET /api/calendar/connection-status': 'session',
  'DELETE /api/calendar/disconnect': 'session',

  // gamification.ts
  'GET /api/gamification/profile': 'session',
  'GET /api/gamification/achievements': 'session',
  'GET /api/gamification/leaderboard': 'public',
  'GET /api/gamification/leaderboard/monthly': 'public',
  'GET /api/gamification/points-history': 'session',

  // admin.ts
  'GET /api/admin/dashboard': 'session+live-role',
  'GET /api/admin/export/bookings': 'admin',
  'POST /api/admin/request': 'session+live-role',
  'GET /api/admin/requests': 'superadmin',
  'POST /api/admin/requests/:id/approve': 'superadmin',
  'POST /api/admin/requests/:id/deny': 'superadmin',
  'GET /api/admin/admins': 'superadmin',
  'DELETE /api/admin/admins': 'superadmin',
  'GET /api/admin/diagnostics/db-tls': 'superadmin',

  // notificationPreferences.ts
  'GET /api/notification-preferences': 'session',
  'PATCH /api/notification-preferences': 'session',

  // feedback.ts
  'POST /api/feedback': 'public',
  'GET /api/feedback': 'admin',
  'GET /api/feedback/export': 'admin',
  'DELETE /api/feedback/:id': 'superadmin',

  // stats.ts
  'GET /api/stats/platform': 'public',

  // firsthand-session.ts - the participant runtime, token-bound
  'GET /api/firsthand/session/:token': 'participant-token',
  'GET /api/firsthand/session/:token/runtime': 'participant-token',
  'POST /api/firsthand/session/:token/runtime': 'participant-token',
  'POST /api/firsthand/session/:token/recording': 'participant-token',
  'POST /api/firsthand/session/:token/recording/client-upload': 'participant-token',
  'POST /api/firsthand/session/:token/recording/finalize': 'participant-token',

  // firsthand.ts - admin studies
  'GET /api/firsthand/studies': 'admin',
  'POST /api/firsthand/studies': 'admin',
  'GET /api/firsthand/studies/:studyId': 'admin',
  'PUT /api/firsthand/studies/:studyId': 'admin',
  'DELETE /api/firsthand/studies/:studyId': 'admin',
  'GET /api/firsthand/studies/:studyId/results': 'admin',
  'GET /api/firsthand/studies/:studyId/results.csv': 'admin',

  // cron.ts - mounted straight on the app
  'GET /api/cron/send-reminders': 'in-handler-secret',

  // auth.ts - mounted at /auth AND /api/auth
  'GET /auth/login': 'public',
  'GET /auth/callback': 'public',
  'POST /auth/logout': 'public',
  'GET /auth/google-login': 'public',
  'GET /auth/google-callback': 'public',
  'GET /api/auth/login': 'public',
  'GET /api/auth/callback': 'public',
  'POST /api/auth/logout': 'public',
  'GET /api/auth/google-login': 'public',
  'GET /api/auth/google-callback': 'public'
};

/**
 * MEASURED, not derived: `Object.keys(EXPECTED_AUTHORISATION).length` at the
 * time of writing. A literal, because a count computed from the table it
 * guards cannot notice the table changing - which is the whole point of a
 * count here.
 */
const EXPECTED_ROUTE_COUNT = 95;

/** Every router file in `src/routes`, read off disk rather than listed. */
const ROUTER_FILES = fs
  .readdirSync(ROUTES_DIR)
  .filter((entry) => entry.endsWith('.ts'))
  .sort();

/** The assembled app's own middleware stack. Express 4 keeps it on `_router`. */
const appLayers = (): Layer[] =>
  (app as unknown as { _router: { stack: Layer[] } })._router.stack;

/**
 * `index.ts` re-evaluated under another NODE_ENV, and BOUNDED.
 *
 * Everything `index.ts` guards behind `NODE_ENV !== 'test'` fires here: both
 * cron schedules and `app.listen`. The naive version of this helper hung the
 * runner - a jest job timeout with no named failing test, which is the worst
 * kind of regression to read - so the two side effects are held rather than
 * hoped about. `node-cron` is stubbed, and `applyServerTimeouts` is replaced by
 * a capture so the socket `listen` opens is closed before this returns. PORT 0
 * means an ephemeral port, never a fixed one two suites could contend for.
 *
 * WHAT THIS ARM DOES AND DOES NOT REPRODUCE, measured rather than assumed.
 *
 * It re-evaluates every branch on `process.env`, which is what `index.ts` uses
 * for `app.listen` and both cron schedules, and what `ENABLE_CSRF` is read
 * from. So `ENABLE_CSRF=true` is set here to bring up the `if (csrfEnabled)`
 * block and its `GET /api/csrf-token` route - a real conditional endpoint the
 * `test`-time walk cannot see, and the reason this arm found something rather
 * than merely confirming something.
 *
 * It does NOT reproduce a branch on the `config` SINGLETON. `config` is
 * validated and built once at first import, and the file-level
 * `jest.mock('../../config')` above wins over a `jest.doMock` inside an
 * isolated registry - five attempts, each measured: overriding
 * `config.NODE_ENV` explicitly, re-deriving it via `requireActual`, and
 * supplying `DATABASE_URL` so a production config would not refuse to boot at
 * index.ts:61 all left `csrfEnabled` false. `ENABLE_CSRF` is the honest lever
 * because `index.ts` reads it straight off `process.env`.
 *
 * ponytail: a mount behind `if (config.NODE_ENV === 'production')` - as
 * distinct from `process.env.NODE_ENV` - is still invisible to this file.
 *   -> closing it needs `config` un-mocked in this suite, which means a real
 *      pg Pool at import, or a `getBackendConfig` seam to inject through.
 *
 * One more trap worth recording: `node-cron` stubbed without
 * `__esModule: true` makes the interop helper wrap the mock, leaves
 * `cron.schedule` undefined and fails the import - which would have left this
 * arm red for a reason having nothing to do with routes.
 */
function appStackUnder(nodeEnv: string): Layer[] {
  const previousEnv = process.env.NODE_ENV;
  const previousPort = process.env.PORT;
  const previousCsrf = process.env.ENABLE_CSRF;
  process.env.NODE_ENV = nodeEnv;
  process.env.PORT = '0';
  process.env.ENABLE_CSRF = 'true';

  let server: { close: (cb?: () => void) => void } | undefined;
  try {
    let stack: Layer[] = [];
    jest.isolateModules(() => {
      // `__esModule` matters: `index.ts` does `import cron from 'node-cron'`,
      // so without it the interop helper wraps the whole mock as `default` and
      // `cron.schedule` is undefined at import time.
      jest.doMock('node-cron', () => ({
        __esModule: true,
        default: { schedule: () => undefined }
      }));
      jest.doMock('../../server-timeouts', () => ({
        applyServerTimeouts: (listening: typeof server) => {
          server = listening;
          return listening;
        }
      }));
      const isolated = (require('../../index') as { default: unknown }).default;
      stack = (isolated as { _router: { stack: Layer[] } })._router.stack;
    });
    return stack;
  } finally {
    server?.close();
    process.env.NODE_ENV = previousEnv;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousCsrf === undefined) delete process.env.ENABLE_CSRF;
    else process.env.ENABLE_CSRF = previousCsrf;
  }
}

/** The stack-derived inventory of the whole app, before any override. */
const derived = (): Record<string, Verdict> => {
  const into: Record<string, Verdict> = {};
  for (const [prefix, router] of ROOTS) {
    inventory(router, prefix, [], into);
  }
  inventory(authRouter, AUTH_ALIAS_PREFIX, [], into);
  return into;
};

const discovered = (): Record<string, Verdict> => ({
  ...derived(),
  ...IN_HANDLER_GATES
});

describe('the authorisation inventory', () => {
  /** A throwaway route carrying `chain` in the given order, ready to walk. */
  const reversed = (...chain: express.RequestHandler[]) => {
    const probe = express.Router();
    probe.get('/x', ...chain, (_req, _res) => undefined);
    return () => inventory(probe, '');
  };

  it('has a written-down verdict for every route, and no verdict without a route', () => {
    // Whole-map equality, BOTH directions. A route added anywhere in the graph
    // fails until somebody writes down what guards it; an entry left behind by
    // a deleted route fails until the table is trimmed. The narrow version of
    // this test had the first property for three routers out of sixteen.
    expect(discovered()).toEqual(EXPECTED_AUTHORISATION);
  });

  it('overrides only routes that exist, and only where the stack says public', () => {
    // An override for a deleted route would sit here forever doing nothing, and
    // an override on a route that already carries a middleware gate would MASK
    // that gate - the verdict would come from this list rather than the code.
    // Both are silent failures without this.
    const stack = derived();

    for (const route of Object.keys(IN_HANDLER_GATES)) {
      expect({ route, derivedVerdict: stack[route] }).toEqual({
        route,
        derivedVerdict: 'public'
      });
    }
  });

  it('reaches every router file on disk from the app roots', () => {
    // THE PROPERTY THAT MAKES THE TABLE EXHAUSTIVE RATHER THAN LONG. A new
    // router file is a failure here whether or not anybody thought to import
    // it, because the list comes off the filesystem.
    const reached = routersReachedFrom(ROOTS.map(([, router]) => router));

    const unreached = ROUTER_FILES.filter((file) => {
      const module = require(path.join(ROUTES_DIR, file)) as { default?: unknown };
      return !reached.has(module.default);
    });

    expect(unreached).toEqual([]);
  });

  it('reaches only what the roots it is given can reach', () => {
    // CONTROL for the absence-assertion above, and the FIRST version of this
    // control did not work. It asserted an orphan `express.Router()` was absent
    // and pinned `reached.size` at 16 - but the sabotage it was written for
    // seeds `seen` with every router module's default, and "every router
    // module" IS 16, while a freshly built orphan is not a module default and
    // so is correctly absent either way. The arithmetic let it pass.
    //
    // What a seeded walk cannot fake is REACHING LESS FROM LESS. `cron.ts`
    // mounts nothing, so from that root alone the answer is one router; a set
    // pre-filled from disk answers 16 whatever it is handed.
    expect(routersReachedFrom([cronRouter]).size).toBe(1);
    expect(routersReachedFrom([apiRouter]).size).toBe(15);
    expect(routersReachedFrom(ROOTS.map(([, router]) => router)).size).toBe(17);

    // And it really is traversing rather than echoing its input: `api.ts` is
    // handed in alone and `session-outputs.ts` comes back with it.
    //
    // THIS DOES NOT PROVE RECURSION, and should not be read as if it does.
    // Deleting `queue.push(...)` - making the walk depth-1 with no recursion at
    // all - passes every assertion here, because the mount graph is FLAT today:
    // `api.ts` mounts all thirteen sub-routers directly, so depth-1 and depth-N
    // are indistinguishable. A router nested two deep would be missed by
    // `routersReachedFrom`, though `inventory()` recurses separately so its
    // routes would still reach the table.
    //
    // ponytail: no fixture nests a router two deep, so the recursion is
    // untested.
    //   -> if a sub-router ever mounts a sub-router, add a two-deep case here;
    //      until then a fixture would be testing the fixture.
    expect(
      routersReachedFrom([apiRouter]).has(
        (require('../session-outputs') as { default: unknown }).default
      )
    ).toBe(true);
  });

  it('finds the router files it claims to have scanned', () => {
    // CONTROL for the absence-assertion above: an empty `unreached` list is
    // also what a mistyped directory, a wrong extension filter or an empty
    // read produces. This proves the scan saw a real, populated routes
    // directory - so "nothing unreached" means something.
    expect(ROUTER_FILES).toEqual([
      'admin.ts',
      'api.ts',
      'auth.ts',
      'booking-artifacts.ts',
      'bookings.ts',
      'calendar.ts',
      'cron.ts',
      'feedback.ts',
      'firsthand-session.ts',
      'firsthand.ts',
      'gamification.ts',
      'notificationPreferences.ts',
      'opportunities.ts',
      'session-outputs.ts',
      'sessions.ts',
      'stats.ts',
      'userCalendar.ts'
    ]);
  });

  it('mounts exactly the four routers ROOTS claims, at exactly those prefixes', () => {
    // READ OFF THE ASSEMBLED APP, not out of `index.ts` as text. The previous
    // version matched `/^app\.use\(\s*'([^']+)'/gm` and a gate got five live
    // router mounts past it: double quotes, a template literal, a path held in
    // a variable, `app.use(router)` with no path at all, and - the realistic
    // one - an ordinary indented `app.use` inside an `if` block, which
    // `index.ts` already contains two of. A regex over source is a scanner, and
    // this campaign has now found three scanners narrower than their docblock.
    //
    // So this reads data. Every spelling above produces the same layer on
    // `app._router.stack`, and a mount with no path shows up as `''` rather
    // than not at all.
    const mounted = appLayers()
      .filter((layer) => isRouter(layer.handle))
      .map(mountPathOf);

    // In mount order, and `/api/auth` ahead of `/api` because the longer prefix
    // registered second would never win. The order is part of the claim.
    expect(mounted).toEqual(['/auth', '/api/auth', '/api/cron', '/api']);
  });

  it('serves exactly two endpoints straight off the app, both public', () => {
    // The other half of reading the real app, and a gap the router-only table
    // could not see: `/api/health` and `/health` are registered with `app.get`
    // and belong to no router file, so nothing above accounts for them. Both
    // are deliberately unauthenticated - a health check behind a session is
    // useless to monitoring - and `/api/health` is rate limited for it.
    //
    // Exhaustive and both directions, like the router table: a third app-level
    // route fails here until somebody writes down what guards it.
    //
    // EVERY method on the layer, not `methods[0]`. The first version printed
    // only the first, so `app.route('/x').get(...).post(...)` labelled itself
    // `GET /x` - it was still caught as a new entry, but the label lied about
    // what it had caught.
    const appRoutes = appLayers()
      .filter((layer) => layer.route)
      .map((layer) => {
        const route = layer.route!;
        const methods = Object.keys(route.methods).map((m) => m.toUpperCase()).sort();
        return `${methods.join('|')} ${String(route.path)}`;
      });

    expect(appRoutes).toEqual(['GET /api/health', 'GET /health']);
  });

  it('scopes exactly two path-scoped handlers to a prefix, both the auth limiter', () => {
    // THE THIRD BUCKET, and the reason it needed its own assertion is a lesson
    // rather than an oversight. The two checks above each enumerate a FILTERED
    // SUBSET - `isRouter(handle)` and `layer.route` - and nothing asserted over
    // the remainder, so a path-scoped non-router handler on the app fell
    // between them: `app.use('/answers-probe', handler)` served a live 200 with
    // no session while this file reported 19/19 green. The app-level twin of
    // the defect `inventory()` throws on.
    //
    // I ARGUED FOR LEAVING THIS OPEN AND WAS WRONG. The premise was right -
    // `inventory()`'s throw cannot be reused here, because `index.ts:200,202`
    // mount `authLimiter` as exactly this shape and throwing would break the
    // build - but the conclusion did not follow. Enumerating the bucket costs
    // one `expect` and turns `authLimiter` from the reason a check was skipped
    // into a written-down decision, which is the whole point of this file.
    //
    // Paths rather than handler identity, because `createAuthLimiter()`'s
    // result is a local in `index.ts` and is not exported to compare against.
    // An array, not a set, so a SECOND handler sneaked onto `/auth` fails too.
    const pathScoped = appLayers()
      .filter((layer) => !layer.route && !isRouter(layer.handle))
      .filter((layer) => layer.regexp && !layer.regexp.fast_slash)
      .map(mountPathOf);

    expect(pathScoped).toEqual(['/auth', '/api/auth']);
  });

  it('mounts the same four routers when NODE_ENV is production', () => {
    // READING THE REAL APP BOUGHT A DEPENDENCE ON *WHICH* REAL APP. The three
    // checks above import it once, under `NODE_ENV=test`, and `index.ts`
    // already branches on `NODE_ENV` three times - `app.listen` and both cron
    // schedules - so a mount inside `if (process.env.NODE_ENV !== 'test')` is
    // the idiomatic shape in that exact file and was invisible: two variants
    // both survived 19/19.
    //
    // Same tool as the dev-login routes below, pointed at `index.ts` instead of
    // `auth.ts`. `production` is the arm that matters; a `test`-only mount is
    // already covered, because the three checks above run under `test`.
    //
    // AND THE ARM FOUND A REAL ONE, not a hypothetical: `GET /api/csrf-token`
    // is registered inside `if (csrfEnabled)`, which defaults ON in production
    // and OFF under test. So production serves THREE app-level routes where
    // this file had written down two, and no arm existed that could see the
    // third. It is deliberately public - it is what issues the token an
    // authenticated caller needs - and now it is written down.
    const stack = appStackUnder('production');

    expect(stack.filter((layer) => isRouter(layer.handle)).map(mountPathOf)).toEqual([
      '/auth',
      '/api/auth',
      '/api/cron',
      '/api'
    ]);
    // The other two buckets too, so a production-only route or a
    // production-only path-scoped handler cannot hide either.
    expect(
      stack
        .filter((layer) => !layer.route && !isRouter(layer.handle))
        .filter((layer) => layer.regexp && !layer.regexp.fast_slash)
        .map(mountPathOf)
    ).toEqual(['/auth', '/api/auth']);
    expect(
      stack.filter((layer) => layer.route).map((layer) => String(layer.route!.path))
    ).toEqual(['/api/csrf-token', '/api/health', '/health']);
  });

  it('walks a non-empty set of routes', () => {
    // THE CONTROL THAT MATTERS MOST. Every assertion above is satisfied by a
    // walker that finds nothing: an empty map equals an empty table, and no
    // route means no missing verdict. A literal count is the only version of
    // this that cannot be fooled by the walker breaking.
    const found = discovered();

    expect(Object.keys(found)).toHaveLength(EXPECTED_ROUTE_COUNT);
    expect(Object.keys(EXPECTED_AUTHORISATION)).toHaveLength(EXPECTED_ROUTE_COUNT);

    // And a named route from the surface #13 was written about, so a walker
    // that finds the right NUMBER of the wrong things is caught too.
    expect(found['GET /api/opportunities/:id/sessions/:sessionId/outputs']).toBe(
      'admin'
    );
    expect(found['GET /api/cron/send-reminders']).toBe('in-handler-secret');
  });

  it('derives a different verdict for a different chain', () => {
    // CONTROL for the derivation itself. Every verdict above would still line
    // up if `verdictOf` returned a constant, or ranked its gates in the wrong
    // order - a route carrying requireAuth AND requireAdmin must read `admin`,
    // not `session`. Built on a throwaway router, so it asserts the function
    // rather than the product.
    const probe = express.Router();
    const noop = (_req: unknown, _res: unknown, next: () => void) => next();

    probe.get('/open', noop);
    probe.get('/optional', optionalAuth, noop);
    probe.get('/optional-live', optionalAuth, withLiveRoleIfPresent, noop);
    probe.get('/signed-in', requireAuth, noop);
    probe.get('/live', requireAuth, withLiveRole, noop);
    probe.get('/bound', requireAuth, bindParticipantSession, noop);
    probe.get('/admin', requireAuth, requireAdmin, noop);
    probe.get('/super', requireAuth, requireAdmin, requireSuperadmin, noop);

    expect(inventory(probe, '/probe')).toEqual({
      'GET /probe/open': 'public',
      'GET /probe/optional': 'optional-session',
      'GET /probe/optional-live': 'optional-session+live-role',
      'GET /probe/signed-in': 'session',
      'GET /probe/live': 'session+live-role',
      'GET /probe/bound': 'participant-token',
      'GET /probe/admin': 'admin',
      'GET /probe/super': 'superadmin'
    });
  });

  it('refuses a chain whose ORDER defeats the gate it carries', () => {
    // #56. `verdictOf`'s only primitive used to be `some`, which is MEMBERSHIP:
    // it said a handler was somewhere in the chain and nothing about where.
    // Express runs a chain in order, and every middleware in the vocabulary
    // either writes `req.user` or reads it, so several of these pairs work in
    // exactly one order.
    //
    // MEASURED before the fix, not assumed: reversing the real catalogue chain
    // to `router.get('/', withLiveRoleIfPresent, optionalAuth, ...)` in
    // `opportunities.ts:981` left this whole file at 21/21 green while the
    // verdict `optional-session+live-role` had become a false statement about
    // the route - `optionalAuth` ran last and overwrote the live role with the
    // session copy. One arm of
    // `opportunities.inline-admin-gates-read-live-role.test.ts` was the only
    // thing in 1309 backend tests that saw it.
    //
    // Each arm below is the WRONG order of a pair the product actually uses.
    expect(reversed(withLiveRoleIfPresent, optionalAuth)).toThrow(
      'chain order: optionalAuth runs after withLiveRoleIfPresent'
    );
    expect(reversed(withLiveRole, requireAuth)).toThrow(
      'chain order: requireAuth runs after withLiveRole'
    );
    expect(reversed(bindParticipantSession, requireAuth)).toThrow(
      'chain order: requireAuth runs after bindParticipantSession'
    );
    expect(reversed(requireAdmin, requireAuth)).toThrow(
      'chain order: requireAuth runs after requireAdmin'
    );
    expect(reversed(requireSuperadmin, optionalAuth)).toThrow(
      'chain order: optionalAuth runs after requireSuperadmin'
    );
  });

  it('names the right mechanism, which is not the same one for all five', () => {
    // A refute gate on !270 caught the message asserting "overwrites req.user
    // with the session copy" for EVERY pair, and that is simply untrue of the
    // bind pair. Read off the source: `requireAdmin` (authenticate.ts:83),
    // `requireSuperadmin` (:105), `withLiveRole` (:150) and
    // `withLiveRoleIfPresent` (:208) all read `req.session?.user` and never
    // `req.user` - a copier after them CLOBBERS the live role they wrote.
    // `bindParticipantSession` is the one that reads `req.user`
    // (firsthand-session.ts:33), so a copier after IT is an unset read.
    //
    // Pinned as two literals because the tails are the whole correction, and
    // the arm above passes on the prefix alone - it would go green again the
    // moment somebody collapsed both messages back into one.
    expect(reversed(withLiveRoleIfPresent, optionalAuth)).toThrow(
      'so it overwrites the live role with the session copy'
    );
    expect(reversed(bindParticipantSession, requireAuth)).toThrow(
      'so req.user is still unset when it reads it'
    );

    // And the two really are different, so a single shared message cannot
    // satisfy both assertions above by accident.
    expect(reversed(bindParticipantSession, requireAuth)).not.toThrow(
      'so it overwrites the live role with the session copy'
    );
  });

  it('accepts every one of those pairs the right way round', () => {
    // THE CONTROL FOR THE REFUSAL ABOVE, and it is the arm that matters most.
    // A check that throws on everything passes the five assertions above just
    // as well as a correct one, and it would make the whole inventory
    // unbuildable rather than strict. Same pairs, right order, each landing on
    // the verdict it should.
    const probe = express.Router();
    const noop = (_req: unknown, _res: unknown, next: () => void) => next();

    probe.get('/optional-live', optionalAuth, withLiveRoleIfPresent, noop);
    probe.get('/live', requireAuth, withLiveRole, noop);
    probe.get('/bound', requireAuth, bindParticipantSession, noop);
    probe.get('/admin', requireAuth, requireAdmin, noop);
    probe.get('/super', optionalAuth, requireSuperadmin, noop);

    expect(inventory(probe, '')).toEqual({
      'GET /optional-live': 'optional-session+live-role',
      'GET /live': 'session+live-role',
      'GET /bound': 'participant-token',
      'GET /admin': 'admin',
      'GET /super': 'superadmin'
    });
  });

  it('sees the order across the router-level and per-route halves of a chain', () => {
    // The chain a route really runs is `router.use` middleware FOLLOWED BY the
    // route's own handlers, and `inventory` concatenates them in that order
    // before asking for a verdict. A check that only looked at `route.stack`
    // would pass this: the reversal here spans the two halves.
    const outer = express.Router();
    outer.use(withLiveRole);
    outer.get('/late-auth', requireAuth, (_req, _res) => undefined);

    expect(() => inventory(outer, '')).toThrow(
      'chain order: requireAuth runs after withLiveRole'
    );
  });

  it('inherits a router-level gate down into a nested router', () => {
    // The walk credits `router.use` middleware to the routes below it. If it
    // did not, every route on a router gated once at the top would read
    // `public` - a verdict that would be written down as fact.
    const inner = express.Router();
    inner.get('/deep', (_req, _res) => undefined);

    const outer = express.Router();
    outer.use(requireAdmin);
    outer.use('/nested', inner);

    expect(inventory(outer, '')).toEqual({ 'GET /nested/deep': 'admin' });
  });

  it('refuses to guess a mount path it cannot decode', () => {
    // A parameterised mount decoded wrongly would file real routes under URLs
    // that do not exist, and the table would agree with itself. Loud instead.
    const inner = express.Router();
    inner.get('/x', (_req, _res) => undefined);

    const outer = express.Router();
    outer.use('/:tenant', inner);

    expect(() => inventory(outer, '')).toThrow('parameterised mount not decodable');
  });

  it('refuses a path-scoped handler that is an endpoint wearing middleware clothes', () => {
    // `router.use('/probe', handler)` serves GET, POST and everything else on
    // that path. It has no `.stack`, so the obvious walk files it as
    // router-level middleware: the endpoint disappears from the inventory AND
    // its handler is credited as an inherited guard to every route after it.
    // A gate served a live unauthenticated 200 through this shape with the
    // whole suite green.
    const outer = express.Router();
    outer.use('/answers-probe', (_req, res) => res.json({ transcript: 'leak' }));

    expect(() => inventory(outer, '')).toThrow('path-scoped handler is an endpoint');
  });

  it('does not mistake a plain router-level guard for a path-scoped endpoint', () => {
    // CONTROL for the refusal above: `router.use(fn)` with no path is the shape
    // `firsthand-session.ts` uses for `participantRuntimeWork`, and throwing on
    // it would make the whole inventory unbuildable rather than strict.
    const outer = express.Router();
    outer.use(requireAdmin);
    outer.get('/guarded', (_req, _res) => undefined);

    expect(inventory(outer, '')).toEqual({ 'GET /guarded': 'admin' });
  });

  it('refuses two registrations of one route rather than letting one shadow the other', () => {
    // Express dispatches to the FIRST match; assignment into a map keeps the
    // LAST. So an ungated duplicate placed ahead of a gated one is recorded
    // with the gated verdict, the route count does not move, and the ungated
    // handler is what serves. Proven twice by a gate - same file, and across
    // two routers sharing a mount prefix - both live 200s, both green.
    const outer = express.Router();
    outer.get('/thing', (_req, res) => res.json({ leak: true }));
    outer.get('/thing', requireAdmin, (_req, _res) => undefined);

    expect(() => inventory(outer, '')).toThrow('route registered twice');
  });
});

describe('the answer surfaces specifically', () => {
  /**
   * The routes that return a participant's own words or recording bytes.
   *
   * Pinned as a NAMED set on top of the table above, because these are the
   * ones where a wrong verdict is a disclosure rather than a nuisance, and
   * because #13's mutation added a route to exactly this file. `admin` here is
   * necessary and not sufficient - the owner gate lives in the handler - so the
   * value of this list is that it cannot grow silently.
   */
  const ANSWER_SURFACES: Record<string, Verdict> = {
    'GET /api/opportunities/:id/sessions/:sessionId/outputs': 'admin',
    'GET /api/opportunities/:id/sessions/:sessionId/assets/:assetId/media': 'admin',
    'GET /api/opportunities/:id/survey-results': 'admin',
    'GET /api/opportunities/:id/survey-results.csv': 'admin',
    'GET /api/firsthand/studies/:studyId/results': 'admin',
    'GET /api/firsthand/studies/:studyId/results.csv': 'admin'
  };

  it('admits nobody below admin to any route that returns answers', () => {
    const found = discovered();

    for (const [route, verdict] of Object.entries(ANSWER_SURFACES)) {
      expect({ route, verdict: found[route] }).toEqual({ route, verdict });
    }
  });

  it('has not grown a route under the session-outputs prefix without a verdict', () => {
    // The narrow-inventory defect, stated as its own assertion so the failure
    // NAMES the surface rather than showing an 89-key map diff.
    const underSessionPrefix = Object.keys(discovered())
      .filter((route) => /\/api\/opportunities\/:id\/sessions\/:sessionId\b/.test(route))
      .sort();

    expect(underSessionPrefix).toEqual([
      'GET /api/opportunities/:id/sessions/:sessionId/assets/:assetId/media',
      'GET /api/opportunities/:id/sessions/:sessionId/outputs'
    ]);
  });
});

/**
 * THE FOUR ROUTES THAT MINT A SESSION AT ANY ROLE, INCLUDING SUPERADMIN.
 *
 * `auth.ts` registers `/demo-login`, `/admin-login`, `/superadmin-login` and
 * `/demo-user-2-login` inside `if (process.env.NODE_ENV === 'development')`.
 * They take no credential and hand back a logged-in session at whatever role
 * their name says.
 *
 * THE TABLE ABOVE COULD NEVER HAVE SEEN THEM, and that is worse than not
 * covering them. `src/__tests__/setup.ts` sets `NODE_ENV = 'test'` in
 * `setupFilesAfterEach`, before `auth.ts` is first imported, so the `if` is
 * false for the whole run and the routes are never registered. An exhaustive
 * inventory that is structurally blind to the four highest-privilege endpoints
 * in the repository overstates itself exactly where being wrong costs most - a
 * refute gate made the point by running the whole suite green under
 * `NODE_ENV=development`, with all four live.
 *
 * So the property asserted here is not "what guards them". It is THAT THEY DO
 * NOT EXIST OUTSIDE DEVELOPMENT, which is the thing that actually matters and
 * which nothing tested before. The second test is its control: the same walk
 * with `NODE_ENV=development` must FIND all four, because an absence-assertion
 * over a module that never registers anything passes for the wrong reason.
 */
describe('the development-only login routes', () => {
  const DEV_LOGIN_PATHS = [
    'GET /auth/admin-login',
    'GET /auth/demo-login',
    'GET /auth/demo-user-2-login',
    'GET /auth/superadmin-login'
  ];

  /** `auth.ts`'s routes as they are registered under a given `NODE_ENV`. */
  const authRoutesUnder = (nodeEnv: string): string[] => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = nodeEnv;
    try {
      let router: Router | undefined;
      jest.isolateModules(() => {
        router = (require('../auth') as { default: Router }).default;
      });
      return Object.keys(inventory(router!, '/auth')).sort();
    } finally {
      process.env.NODE_ENV = previous;
    }
  };

  it('registers none of the four when NODE_ENV is production', () => {
    const registered = authRoutesUnder('production');

    for (const route of DEV_LOGIN_PATHS) {
      expect({ route, registered: registered.includes(route) }).toEqual({
        route,
        registered: false
      });
    }
  });

  it('registers none of the four when NODE_ENV is test, as this suite runs', () => {
    // The env the table above is actually built under, stated separately so the
    // 89-route inventory is not quietly resting on an unexamined assumption.
    expect(process.env.NODE_ENV).toBe('test');
    expect(
      DEV_LOGIN_PATHS.filter((route) => authRoutesUnder('test').includes(route))
    ).toEqual([]);
  });

  it('registers all four when NODE_ENV is development', () => {
    // THE CONTROL. Without this, both assertions above pass just as well when
    // the isolated re-import returns an empty router, when the paths in
    // DEV_LOGIN_PATHS are misspelled, or when somebody renames the routes and
    // leaves this list behind. It proves the check can still see what it is
    // looking for.
    const registered = authRoutesUnder('development');

    for (const route of DEV_LOGIN_PATHS) {
      expect({ route, registered: registered.includes(route) }).toEqual({
        route,
        registered: true
      });
    }

    // And they really are ungated, which is the reason the absence matters.
    // ponytail: asserted as a set difference against the production arm rather
    // than by verdict, because `verdictOf` reads middleware and these carry
    // none - `public` here is indistinguishable from the login routes beside
    // them.
    //   -> if a dev-login route ever grows a guard, assert its verdict instead.
    expect(
      registered.filter((route) => !authRoutesUnder('production').includes(route))
    ).toEqual(DEV_LOGIN_PATHS);
  });
});
