import http from 'node:http';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { listening } from './helpers/listening';
import { TEST_HTTP_AGENT } from './helpers/pooled-agent';

/**
 * DOES THE POOLING HAPPEN ON THE VITEST SIDE TOO? (cto/AdaptaLabs#60)
 *
 * `pooled-agent.test.ts` next door asks the same question of jest, and it
 * cannot answer it for vitest: the agent is installed by a SETUP FILE, one per
 * runner, and jest's proves nothing about `vitest.config.ts`. Deleting the
 * `setupFiles` entry there would leave the entire suite green - which is the
 * shape of regression this repository keeps getting bitten by, and the reason
 * this file exists rather than a comment saying it is wired.
 *
 * `-vitest.test.ts` IS THE POINT OF THE SUFFIX. Before #60 the only vitest-owned
 * files outside `src/firsthand/` were `*-postgres.test.ts`, and every one of
 * those needs a database, so a guard living there would be skipped by default on
 * the job that gates a merge - a test that cannot run does not protect the
 * property. This one needs nothing but a loopback socket.
 *
 * Counting CONNECTIONS rather than reading `_agent`, because the wiring is not
 * the property. A supertest upgrade that renames the field, or a patch that
 * sets it on the wrong object, would satisfy an identity check and still open a
 * socket per request.
 *
 * `listening(app)` is called at each request site rather than held in a
 * variable, because `listening-call-sites.test.ts` scans for exactly that shape.
 * It is memoised, so every call returns the same server.
 */

/** Counts server-side accepts for the duration of `run`. */
async function countingConnections(
  server: http.Server,
  run: () => Promise<void>
): Promise<number> {
  let connections = 0;
  const onConnection = (): void => {
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

const buildApp = (): express.Express => {
  const app = express();
  app.get('/x', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
};

const REQUESTS = 12;

describe('the pooled test agent, under vitest', () => {
  it('opens ONE connection for many requests, where an unpooled client opens one per request', async () => {
    const pooledApp = buildApp();
    const pooled = await countingConnections(listening(pooledApp), async () => {
      for (let i = 0; i < REQUESTS; i += 1) {
        await request(listening(pooledApp)).get('/x').expect(200);
      }
    });

    // THE CONTROL, and it is not optional. Zero connections in both arms would
    // satisfy `pooled === 1` while proving nothing. `new http.Agent()` defaults
    // to `keepAlive: false`, which is exactly what supertest's own
    // `agent: false` asks Node for - so this arm is the unpooled behaviour the
    // setup file exists to replace, measured in the same run.
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

  it('hands out the module-level agent, not a per-file copy with its own options', async () => {
    // WHAT THIS CAN AND CANNOT SEE, corrected after the refute gate on !272
    // pointed out the title claimed more than the assertion. Vitest isolates
    // each test file, so nothing here observes the jest side; what it observes
    // is that the setup file and this file resolve the SAME `pooled-agent.ts`
    // instance, and that the agent a request ends up with is that one rather
    // than a fresh copy. That is the useful property: a refactor that built a
    // second agent per file, or left `maxSockets` bounded on it, fails here.
    //
    // `Infinity` is load-bearing: a bounded pool turns "a handler that waits on
    // a second request" into a worker that hangs, which arrives as a CI job
    // timeout with no named failing test.
    expect(TEST_HTTP_AGENT.maxSockets).toBe(Number.POSITIVE_INFINITY);
    expect(
      (TEST_HTTP_AGENT as unknown as { options: { keepAlive?: boolean } }).options.keepAlive
    ).toBe(true);

    const app = buildApp();
    const req = request(listening(app)).get('/x');
    await req.expect(200);

    expect((req as unknown as { _agent: unknown })._agent).toBe(TEST_HTTP_AGENT);
  });
});
