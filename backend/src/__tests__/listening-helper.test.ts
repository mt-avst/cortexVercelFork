import { describe, it, expect, afterEach, jest } from '@jest/globals';
import net from 'node:net';
import { createServer } from 'node:http';
import request from 'supertest';
import express from 'express';

import { closeListeningServers, listening } from './helpers/listening';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  redactSensitiveUrl: (url: string) => url
}));

/**
 * DOES THE HELPER ACTUALLY STOP THE BINDING?
 *
 * Every other test in this repository asserts, at most, that `listening()` was
 * CALLED - by using it. None of them could tell you it worked, and that is a
 * worse hole than it sounds, because of how `supertest` fails:
 *
 *   `Test.serverAddress()` binds a fresh ephemeral port ONLY when
 *   `app.address()` is null.
 *
 * So if `listening` ever stopped returning a listening server - a broken
 * memoisation, a server closed too early, a future refactor handing back the
 * app instead - supertest would QUIETLY BIND ONE ITSELF. The suite would go on
 * passing, in full, while silently reverting to the exact behaviour this change
 * removes: 414 bind/close cycles a run and a one-in-five red suite. A
 * regression with no failing test.
 *
 * Raised by a peer reviewing the change, who had just found two guards
 * elsewhere in this repo that were only "killed" by making the suite hang - a
 * CI timeout with no named failure. The question they asked of this one is the
 * right question: if it broke, would anything say so BY NAME?
 *
 * These are the answer. They count the syscall rather than trusting the shape.
 */

/** Counts `listen(0)` calls - the ephemeral binds - for the duration of `run`. */
async function countingEphemeralBinds<T>(run: () => Promise<T>): Promise<number> {
  const original = net.Server.prototype.listen;
  let binds = 0;

  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
    if (args[0] === 0) {
      binds += 1;
    }
    return (original as (...a: unknown[]) => net.Server).apply(this, args);
  } as typeof net.Server.prototype.listen;

  try {
    await run();
  } finally {
    net.Server.prototype.listen = original;
  }

  return binds;
}

const buildApp = () => {
  const app = express();
  app.get('/x', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
};

const REQUESTS = 12;

describe('the listening helper', () => {
  afterEach(async () => {
    await closeListeningServers();
  });

  it('binds ONCE for many requests, where the bare app binds every time', async () => {
    const shared = buildApp();
    const sharedBinds = await countingEphemeralBinds(async () => {
      for (let i = 0; i < REQUESTS; i += 1) {
        await request(listening(shared)).get('/x').expect(200);
      }
    });

    // THE CONTROL, and it is not optional. Without it a broken counter reads
    // as a perfect fix: zero binds either way would "pass" the assertion above
    // while proving nothing at all.
    const bare = buildApp();
    const bareBinds = await countingEphemeralBinds(async () => {
      for (let i = 0; i < REQUESTS; i += 1) {
        await request(bare).get('/x').expect(200);
      }
    });

    expect(sharedBinds).toBe(1);
    expect(bareBinds).toBe(REQUESTS);
  });

  it('hands back the same server for the same app, every time', async () => {
    const app = buildApp();

    expect(listening(app)).toBe(listening(app));
    // Memoisation is the mechanism: a helper that returned a NEW listening
    // server per call would satisfy "supertest binds nothing" and reintroduce
    // the port cycling one layer up.
    expect(listening(app).address()).not.toBeNull();
  });

  it('gives different apps different servers', async () => {
    expect(listening(buildApp())).not.toBe(listening(buildApp()));
  });

  it('closes what it opened, so a worker cannot be left hanging', async () => {
    const app = buildApp();
    const server = listening(app);
    expect(server.listening).toBe(true);

    await closeListeningServers();

    // An unclosed server holds the jest worker open. That failure arrives as a
    // run that never finishes rather than a test that fails - the shape this
    // whole file exists to avoid - so it is asserted directly.
    expect(server.listening).toBe(false);
  });

  it('disables the server keep-alive timeout, so a pooled socket is never closed under the client', () => {
    // THE HAZARD THE POOLED AGENT BRINGS WITH IT. Since
    // `helpers/pooled-agent.ts` the client holds a socket between requests, and
    // Node's server closes an idle keep-alive connection after
    // `keepAliveTimeout`. Reusing one the server has just closed is
    // ECONNRESET, which superagent reports as `socket hang up` - the EXACT
    // text of the socket-pressure flake both helpers exist to remove, so the
    // regression would have been indistinguishable from the bug in any log.
    //
    // Measured standalone, interleaved, one pooled agent across two servers,
    // one request then six seconds idle then another:
    //
    //   server keepAliveTimeout 5000 (Node's default) : 5 resets in 6
    //   server keepAliveTimeout 0                     : 0 resets in 6
    //
    // Six seconds between two requests to one app is not exotic at the load
    // these suites run at. Asserted as a literal rather than reproduced,
    // because the behaviour only appears at the real 5000ms default - a
    // shorter window makes Node send `Keep-Alive: timeout=0`, which the client
    // honours by not reusing the socket at all - so a behavioural arm would
    // cost the whole suite six seconds of sleeping to watch one number.
    expect(listening(buildApp()).keepAliveTimeout).toBe(0);

    // THE SENTINEL, and it is what stops the line above reading Node's default
    // back and calling it ours. `server-timeouts.test.ts` was written without
    // one and a deleted assignment survived, because Node's default happened
    // to equal the number being pinned. If this ever reaches 0, the assertion
    // above stops meaning anything and this says so.
    expect(createServer().keepAliveTimeout).toBe(5000);
  });

  it('binds again after a close, rather than handing back a dead server', async () => {
    const app = buildApp();
    const first = listening(app);
    await closeListeningServers();

    const second = listening(app);
    expect(second).not.toBe(first);
    expect(second.address()).not.toBeNull();

    await request(second).get('/x').expect(200);
  });
});
