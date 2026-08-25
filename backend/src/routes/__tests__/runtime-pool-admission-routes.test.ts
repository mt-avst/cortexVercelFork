import { describe, it, expect, jest } from '@jest/globals';

// Only what the routers touch at import time. Nothing here executes a handler:
// this file reads the mounted middleware stacks and nothing else.
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() }
}));
jest.mock('../../utils/database', () => ({ isDatabaseAvailable: jest.fn() }));

import fs from 'node:fs';
import path from 'node:path';

import type { Router } from 'express';

import opportunitiesRouter from '../opportunities';
import firsthandSessionRouter from '../firsthand-session';
import firsthandRouter from '../firsthand';
import {
  participantRuntimeWork,
  publicRuntimeWork
} from '../../middleware/runtime-work-class';
import { boundResultsRead } from '../../middleware/results-read-concurrency';

/**
 * WHICH LANE EVERY ROUTE RUNS IN, written down as a decision.
 *
 * The admission cap in firsthand/runtime-pool-admission.ts defaults unmarked
 * work to admin, which is fail-safe: work nobody classified is capped rather
 * than free to starve participants. The cost is that a participant route
 * somebody forgets to mark goes quietly SLOWER rather than loudly wrong, and
 * quiet is not something a test discovers by accident.
 *
 * THE FIRST VERSION OF THIS FILE DID NOT CLOSE THAT, and said in three
 * comments that it did. It enumerated only the routes that ALREADY carried a
 * marker, so it caught a marker removed and a marker misplaced - and was
 * completely blind to a NEW ROUTE ADDED WITHOUT ONE, which is the case all
 * three comments claimed. A peer review caught it; it is the third time this
 * exact shape has landed in this repository.
 *
 * So the tables below are EXHAUSTIVE. Every route on both routers appears with
 * an explicit verdict, and the test compares whole maps. A route added, removed
 * or renamed fails until somebody writes down which lane it belongs in - which
 * is the only version of this test that does what its name says.
 */

type HandlerLayer = { handle: unknown; name?: string };
type RouteLayer = {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: HandlerLayer[];
  };
  handle?: unknown;
};

type Lane = 'participant' | 'public' | 'admin';

function layersOf(router: Router): RouteLayer[] {
  return (router as unknown as { stack: RouteLayer[] }).stack;
}

/** Every route on a router, with the lane its middleware puts it in. */
function lanesOf(router: Router): Record<string, Lane> {
  const lanes: Record<string, Lane> = {};

  for (const layer of layersOf(router)) {
    const route = layer.route;
    if (!route) continue;

    const carries = (handler: unknown) =>
      route.stack.some((entry) => entry.handle === handler);

    const lane: Lane = carries(participantRuntimeWork)
      ? 'participant'
      : carries(publicRuntimeWork)
        ? 'public'
        : 'admin';

    const paths = Array.isArray(route.path) ? route.path : [route.path];
    for (const method of Object.keys(route.methods)) {
      for (const path of paths) {
        lanes[`${method.toUpperCase()} ${path}`] = lane;
      }
    }
  }

  return lanes;
}

/** `METHOD /path` for every route carrying `handler`. */
function routesCarrying(router: Router, handler: unknown): string[] {
  return Object.entries(lanesOf(router))
    .filter(([route]) =>
      layersOf(router).some(
        (layer) =>
          layer.route &&
          `${Object.keys(layer.route.methods)[0]?.toUpperCase()} ${
            Array.isArray(layer.route.path) ? layer.route.path[0] : layer.route.path
          }` === route &&
          layer.route.stack.some((entry) => entry.handle === handler)
      )
    )
    .map(([route]) => route)
    .sort();
}

describe('the opportunities router', () => {
  /**
   * Every route, and why each non-admin one is non-admin.
   *
   * `participant` is uncapped, so it is only for a request an authenticated
   * participant makes about their OWN session - the two mint paths. A refusal
   * there loses answers somebody has already given.
   *
   * `public` is the pre-consent landing-page brief, which is `optionalAuth` and
   * therefore reachable with no credential. It gets its own sub-budget of one
   * connection and never queues. It was `participant` until both review gates
   * and a peer independently called that wrong: it handed the uncapped lane to
   * the open internet, behind a limiter that `trust proxy: 1` collapses to a
   * single shared key.
   *
   * Everything else is authoring or reporting, and capped.
   */
  const EXPECTED_LANES: Record<string, Lane> = {
    'DELETE /:id': 'admin',
    'DELETE /:id/sessions': 'admin',
    'GET /': 'admin',
    'GET /:id': 'admin',
    'GET /:id/analytics': 'admin',
    'GET /:id/recorded-study-brief': 'public',
    'GET /:id/session-events': 'admin',
    'GET /:id/sessions': 'admin',
    'GET /:id/survey-results': 'admin',
    'GET /:id/survey-results.csv': 'admin',
    'PATCH /:id': 'admin',
    'POST /': 'admin',
    'POST /:id/click': 'admin',
    'POST /:id/close-if-past': 'admin',
    'POST /:id/duplicate': 'admin',
    'POST /:id/firsthand-handoff': 'participant',
    'POST /:id/recorded-study-session': 'participant',
    'POST /:id/sessions': 'admin',
    'POST /:id/survey-session': 'participant'
  };

  it('puts every route in the lane that was decided for it', () => {
    // Whole-map equality, so a route ADDED here fails until it is classified.
    // That is the property the previous version of this file claimed and did
    // not have.
    expect(lanesOf(opportunitiesRouter)).toEqual(EXPECTED_LANES);
  });

  it('marks the uncapped lane after the auth middleware, never before it', () => {
    for (const layer of layersOf(opportunitiesRouter)) {
      const stack = layer.route?.stack;
      if (!stack) continue;

      const marker = stack.findIndex(
        (entry) =>
          entry.handle === participantRuntimeWork ||
          entry.handle === publicRuntimeWork
      );
      if (marker === -1) continue;

      const auth = stack.findIndex(
        (entry) => entry.name === 'requireAuth' || entry.name === 'optionalAuth'
      );
      expect(auth).toBeGreaterThanOrEqual(0);
      expect(marker).toBeGreaterThan(auth);
    }
  });

  it('gives the uncapped lane only to routes that require a session', () => {
    // `optionalAuth` satisfies the ordering assertion above while guaranteeing
    // nothing, which is exactly how the brief route came to be uncapped. The
    // uncapped lane needs `requireAuth` specifically.
    for (const layer of layersOf(opportunitiesRouter)) {
      const stack = layer.route?.stack;
      if (!stack?.some((entry) => entry.handle === participantRuntimeWork)) {
        continue;
      }

      expect(stack.some((entry) => entry.name === 'requireAuth')).toBe(true);
      expect(stack.some((entry) => entry.name === 'optionalAuth')).toBe(false);
    }
  });
});

describe('the participant runtime router', () => {
  it('classifies the whole router, so a route added later cannot be missed', () => {
    const [first] = layersOf(firsthandSessionRouter);

    // A router-level `use`, FIRST in the stack. This is the one router where
    // exhaustive enumeration is not needed, because the classification is
    // structural: every route on it inherits the marker.
    expect(first.route).toBeUndefined();
    expect(first.handle).toBe(participantRuntimeWork);
  });

  it('has no route that individually re-declares what the router already said', () => {
    expect(
      Object.values(lanesOf(firsthandSessionRouter)).every(
        (lane) => lane === 'admin'
      )
    ).toBe(true);
  });

  it('authenticates before any handler runs, despite the marker being first', () => {
    // The marker is mounted ahead of `requireAuth`, which is safe only because
    // every route carries the guard itself. Asserted rather than assumed.
    for (const layer of layersOf(firsthandSessionRouter)) {
      const stack = layer.route?.stack;
      if (!stack) continue;
      expect(stack.some((entry) => entry.name === 'requireAuth')).toBe(true);
    }
  });
});

describe('the admin studies router', () => {
  const EXPECTED_LANES: Record<string, Lane> = {
    'DELETE /studies/:studyId': 'admin',
    'GET /studies': 'admin',
    'GET /studies/:studyId': 'admin',
    'GET /studies/:studyId/results': 'admin',
    'GET /studies/:studyId/results.csv': 'admin',
    'POST /studies': 'admin',
    'PUT /studies/:studyId': 'admin'
  };

  it('runs entirely in the capped lane', () => {
    // This is the router the 60-a-minute read ceiling sits on, and its traffic
    // is what the cap exists to bound. A marker appearing here would exempt
    // the exact flood this closes.
    expect(lanesOf(firsthandRouter)).toEqual(EXPECTED_LANES);
    expect(
      layersOf(firsthandRouter).some(
        (layer) =>
          !layer.route &&
          (layer.handle === participantRuntimeWork ||
            layer.handle === publicRuntimeWork)
      )
    ).toBe(false);
  });
});

/**
 * WHICH ROUTES HOLD A RESULTS-READ PERMIT, exhaustive for the same reason.
 *
 * These four are the only readers that materialise an unpaginated answer set -
 * up to 200,001 rows, then an aggregate or a CSV built from them, then the
 * response body - on a single-replica 2Gi pod.
 */
describe('the results-read gate', () => {
  it('gates exactly the four unpaginated readers, and nothing else', () => {
    expect(routesCarrying(firsthandRouter, boundResultsRead)).toEqual([
      'GET /studies/:studyId/results',
      'GET /studies/:studyId/results.csv'
    ]);
    expect(routesCarrying(opportunitiesRouter, boundResultsRead)).toEqual([
      'GET /:id/survey-results',
      'GET /:id/survey-results.csv'
    ]);
    expect(routesCarrying(firsthandSessionRouter, boundResultsRead)).toEqual([]);
  });

  it('never gates a route in the uncapped lane', () => {
    // The gate refuses with a 503 when full. A participant route behind it
    // would be a participant losing their session because a superadmin was
    // exporting a spreadsheet.
    const lanes = lanesOf(opportunitiesRouter);
    for (const route of routesCarrying(opportunitiesRouter, boundResultsRead)) {
      expect(lanes[route]).toBe('admin');
    }
  });

  it('holds the permit behind the role gate, never in front of it', () => {
    for (const router of [firsthandRouter, opportunitiesRouter]) {
      for (const layer of layersOf(router)) {
        const stack = layer.route?.stack;
        if (!stack) continue;

        const gate = stack.findIndex((entry) => entry.handle === boundResultsRead);
        if (gate === -1) continue;

        const admin = stack.findIndex((entry) => entry.name === 'requireAdmin');
        expect(admin).toBeGreaterThanOrEqual(0);
        expect(gate).toBeGreaterThan(admin);
      }
    }
  });

  /**
   * WHICH OF THE FOUR HAND THE PERMIT BACK EARLY - cto/AdaptaLabs#9.
   *
   * A SOURCE SCAN, and it has to be: the call is inside a handler, and this
   * file reads mounted middleware stacks, which cannot see in there. Running
   * the four handlers instead would need Postgres, a session and a study with
   * participants - and would still be four separate tests that a fifth route
   * added later escapes.
   *
   * The split is a DECISION, not a coincidence, which is why it is written down
   * as a whole map rather than as two assertions:
   *
   *   the .csv routes DO. Their permit is handed back at the preflight-to-
   *   stream boundary, because everything after it waits on a socket the client
   *   paces - and #9 measured one admin holding that permit for the whole drain
   *   timeout, ten times a minute, refusing every other admin including the
   *   superadmin.
   *
   *   the aggregate routes DO NOT. `res.json` buffers the body, and that body
   *   carries every open-text answer verbatim, so the heap the permit exists
   *   for genuinely is held until the client drains it. Releasing there would
   *   hand back a permit while still holding what the permit is for - trading
   *   an OOM kill, which drops every live participant session, for an
   *   admin-versus-admin availability problem. They stay exposed, and #9
   *   records it.
   *
   * So a route that starts releasing early, or a .csv route that stops, fails
   * here - and either direction is a decision somebody should have to make on
   * purpose.
   */
  it('releases the permit early on the two CSV routes and neither aggregate route', () => {
    const releasesEarlyIn = (file: string): Record<string, boolean> => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '..', file),
        'utf8'
      );

      // Sliced between `router.get(` call sites, so a release belonging to one
      // handler cannot be read as belonging to its neighbour.
      const blocks = source.split(/router\.(?=get\(|post\(|put\(|patch\(|delete\()/);
      const verdicts: Record<string, boolean> = {};

      for (const block of blocks) {
        const path_ = /^get\('([^']+)'/.exec(block);
        if (!path_ || !block.includes('boundResultsRead')) continue;
        verdicts[path_[1]] = block.includes('releaseResultsReadPermit(res)');
      }

      return verdicts;
    };

    // THE CONTROL for the two `false`s below. An absence-assertion passes just
    // as well when the scan matched nothing at all - a renamed function, a
    // reformatted call, a split that put every handler in one block. These two
    // `true`s are the proof the scan can still see a release.
    expect(releasesEarlyIn('firsthand.ts')).toEqual({
      '/studies/:studyId/results': false,
      '/studies/:studyId/results.csv': true
    });
    expect(releasesEarlyIn('opportunities.ts')).toEqual({
      '/:id/survey-results': false,
      '/:id/survey-results.csv': true
    });
  });
});
