import { describe, it, expect, jest } from '@jest/globals';
import http from 'node:http';
import request from 'supertest';
import express from 'express';

import { listening } from './helpers/listening';
import { TEST_HTTP_AGENT } from './helpers/pooled-agent';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  redactSensitiveUrl: (url: string) => url
}));

/**
 * DOES THE POOLING ACTUALLY HAPPEN?
 *
 * `installPooledTestAgent()` runs once, in `setup.ts`, and every other test in
 * this repository benefits from it without mentioning it. That is the whole
 * point of putting it there and it is also the hazard: if the patch ever
 * stopped applying - a supertest upgrade that renames `_agent`, a refactor that
 * drops the `installPooledTestAgent()` call, someone "tidying" the cast away -
 * NOTHING WOULD FAIL. The suite would go on passing, in full, while silently
 * reverting to a TCP connection per request and ~2,200 sockets in TIME_WAIT a
 * run, which is the socket pressure cto/AdaptaLabs#44 is made of.
 *
 * A regression with no failing test is the shape this repo keeps getting bitten
 * by, so these count the connections rather than trusting the wiring. Measured:
 * commenting out the `installPooledTestAgent()` call fails two of them by name.
 *
 * `listening(app)` is called at every request site rather than held in a
 * variable, because `__tests__/listening-call-sites.test.ts` scans for exactly
 * that shape and cannot tell a `Server` variable from an `app` one. It is
 * memoised, so every call here returns the same server.
 */

/** Counts server-side accepts for the duration of `run`. */
async function countingConnections(
  server: http.Server,
  run: () => Promise<void>
): Promise<number> {
  let connections = 0;
  const onConnection = () => {
    connections += 1;
  };

  server.on('connection', onConnection);
  try {
    await run();
  } finally {
    server.off('connection', onConnection);
  }

  return connections;
}

const buildApp = () => {
  const app = express();
  app.get('/x', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
};

const REQUESTS = 12;

describe('the pooled test agent', () => {
  it('opens ONE connection for many requests, where an unpooled client opens one per request', async () => {
    const pooledApp = buildApp();
    const pooled = await countingConnections(listening(pooledApp), async () => {
      for (let i = 0; i < REQUESTS; i += 1) {
        await request(listening(pooledApp)).get('/x').expect(200);
      }
    });

    // THE CONTROL, and it is not optional. A broken counter reads as a perfect
    // fix: zero connections in both arms would satisfy "pooled === 1" while
    // proving nothing. `new http.Agent()` defaults to `keepAlive: false`, which
    // is exactly what supertest's own `agent: false` asks Node for.
    const bareApp = buildApp();
    const bareAgent = new http.Agent();
    const bare = await countingConnections(listening(bareApp), async () => {
      for (let i = 0; i < REQUESTS; i += 1) {
        await request(listening(bareApp)).get('/x').agent(bareAgent).expect(200);
      }
    });
    bareAgent.destroy();

    expect(pooled).toBe(1);
    expect(bare).toBe(REQUESTS);
  });

  it('reuses the socket ACROSS tests, not merely within one', async () => {
    // The saving is per run, not per test, and a per-test agent would satisfy
    // the count above while leaving one connection per test - a few hundred a
    // run rather than one per request, but still growing with the suite.
    const app = buildApp();

    const first = await countingConnections(listening(app), async () => {
      await request(listening(app)).get('/x').expect(200);
    });
    const second = await countingConnections(listening(app), async () => {
      await request(listening(app)).get('/x').expect(200);
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it('never queues, so a test holding one response open cannot deadlock the next', async () => {
    // `maxSockets: Infinity` is load-bearing, not a default nobody chose. A
    // bounded pool turns "a handler that waits on a second request" into a
    // hung jest worker, which arrives as a CI job timeout with no named failing
    // test - the worst shape of failure this repo has.
    expect(TEST_HTTP_AGENT.maxSockets).toBe(Number.POSITIVE_INFINITY);
    expect(
      (TEST_HTTP_AGENT as unknown as { options: { keepAlive?: boolean } }).options.keepAlive
    ).toBe(true);

    const app = buildApp();
    const concurrent = await countingConnections(listening(app), async () => {
      await Promise.all(
        Array.from({ length: 5 }, () => request(listening(app)).get('/x').expect(200))
      );
    });

    // Five at once genuinely need sockets; the point is that they GET them
    // rather than waiting on each other.
    expect(concurrent).toBeGreaterThanOrEqual(4);
  });

  it('leaves a test that chose its own agent alone', async () => {
    // The only branch in the patch. Replacing an explicitly-set agent would
    // silently defeat any future test that isolates a connection on purpose.
    const own = new http.Agent({ keepAlive: false });
    const app = buildApp();

    const req = request(listening(app)).get('/x').agent(own);
    await req.expect(200);

    expect((req as unknown as { _agent: unknown })._agent).toBe(own);
    own.destroy();
  });
});
