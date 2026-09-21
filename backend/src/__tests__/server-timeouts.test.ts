import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  applyServerTimeouts,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  SERVER_SOCKET_TIMEOUT_MS
} from '../server-timeouts';

/**
 * THE SOCKET-LEVEL BACKSTOP FOR A REQUEST THAT NEVER ENDS (cto/AdaptaLabs#5).
 *
 * The fix that matters is the CSV export's own wall-clock deadline, which
 * knows what stalled and says so. These are what stands behind it, and behind
 * the next unbounded response somebody writes.
 */
describe('server timeouts', () => {
  it('pins all three as literals', () => {
    // LITERALS. An expectation derived from the constant cannot report that
    // the constant moved, and these three are the only thing standing between
    // a socket that goes quiet mid-request and a handle held forever.
    expect(SERVER_HEADERS_TIMEOUT_MS).toBe(60_000);
    expect(SERVER_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(SERVER_SOCKET_TIMEOUT_MS).toBe(360_000);
  });

  it('keeps the headers bound at or below the request bound', () => {
    // Node treats a headersTimeout larger than requestTimeout as a
    // misconfiguration, and the failure mode is a request that is refused
    // before its body can arrive.
    expect(SERVER_HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(
      SERVER_REQUEST_TIMEOUT_MS
    );
  });

  it('leaves the export deadline room to fire first', () => {
    // Deliberate, not incidental. If the socket bound fired first it would
    // silently pre-empt the application-level deadline, and an operator would
    // be left with a destroyed connection and no log line saying which study
    // or why. Kept as a literal for the same reason as the numbers above: the
    // export deadline is 300000ms.
    expect(SERVER_SOCKET_TIMEOUT_MS).toBeGreaterThan(300_000);
  });

  it('applies all three to the server it is given', () => {
    const server = http.createServer();

    try {
      // THE SENTINELS ARE THE WHOLE TEST, and this was written without them
      // first. Node 22 already defaults headersTimeout to 60000 - the same
      // number this file pins - so `expect(server.headersTimeout).toBe(
      // SERVER_HEADERS_TIMEOUT_MS)` passed against a function that had that
      // assignment DELETED. The mutation survived; the assertion was reading
      // Node's default and calling it ours.
      //
      // Recorded because the defaults are the trap and they move: whichever
      // constant here next coincides with a Node default would silently do the
      // same thing.
      expect(server.timeout).toBe(0);
      expect(server.headersTimeout).toBe(60_000);
      expect(server.requestTimeout).toBe(300_000);

      server.headersTimeout = 1;
      server.requestTimeout = 2;
      server.timeout = 3;

      applyServerTimeouts(server);

      expect(server.headersTimeout).toBe(SERVER_HEADERS_TIMEOUT_MS);
      expect(server.requestTimeout).toBe(SERVER_REQUEST_TIMEOUT_MS);
      expect(server.timeout).toBe(SERVER_SOCKET_TIMEOUT_MS);
    } finally {
      server.close();
    }
  });
});

/**
 * A SOURCE SCAN, because the call site cannot be reached any other way.
 *
 * server.ts binds a port on import unless NODE_ENV is 'test' (the listen moved
 * there from index.ts, #153), so no test can import it and watch it listen -
 * which means the function above can be correct, tested and never called. That
 * is the shape of a test that cannot fail, and it is the one defect this
 * repository keeps paying for.
 *
 * The same technique as __tests__/listening-call-sites.test.ts, for the same
 * reason: the failure being guarded against is a line that is simply absent,
 * and there is nothing absent to instrument.
 */
describe('the server timeouts are actually wired up', () => {
  // The listen lives in server.ts, the process entrypoint, not index.ts which
  // only assembles the app (#153).
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'server.ts'),
    'utf8'
  );

  /** `applyServerTimeouts(app.listen(` with any spacing. */
  const WIRED = /applyServerTimeouts\(\s*app\.listen\(/;

  it('wraps the listen call in server.ts', () => {
    // The control for "the file was read and looks like we think it does". A
    // moved or renamed entry point would make the assertion below fail for a
    // reason that has nothing to do with the timeouts, and this says which.
    expect(source).toContain('app.listen(');

    expect(WIRED.test(source)).toBe(true);
  });

  it('has a pattern that can still fail', () => {
    // Every absence-assertion needs an arm proving it can still detect
    // something. A regex that matched everything - or a `source` that came
    // back empty - would make the test above green forever.
    expect(WIRED.test('app.listen(config.PORT, () => {});')).toBe(false);
    expect(source.length).toBeGreaterThan(1_000);
  });
});
