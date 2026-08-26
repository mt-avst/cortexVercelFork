import { createServer, type RequestListener, type Server } from 'node:http';

/**
 * One long-lived server per app, instead of one per request.
 *
 * THIS IS A FLAKE FIX, not a tidy-up. `supertest`'s `request(app)` binds a
 * FRESH EPHEMERAL PORT for every call - `Test.serverAddress()` does
 * `app.listen(0)` whenever the app is not already listening, and `end()`
 * closes that server once the response arrives. `routes/__tests__/
 * opportunities.test.ts` alone did that 202 times per run, and the rate-limit
 * tests fire sixty in a tight sequential loop.
 *
 * That bind/close cycle is itself the trigger. Measured standalone - no jest,
 * no ts-jest, no test framework, just express and supertest in a loop,
 * interleaved ten rounds each:
 *
 *   a server per request : 8 failures / 30,000 requests
 *   one shared server    : 0 failures / 30,000 requests
 *
 * If both arms had the same true rate, zero in the second is roughly a 0.03%
 * event. The failures are always transport-level - `socket hang up` or
 * `Parse Error: Expected HTTP/, RTSP/ or ICE/` - and never an assertion.
 *
 * At ~0.027% per request, and 400-500 supertest requests in a full backend
 * run, that is a double-digit chance of at least one failure per run. Measured
 * on an untouched tree: 4 red runs in 20.
 *
 * WHAT THIS IS NOT. Four other explanations fitted the symptoms and were each
 * killed by measurement: AsyncLocalStorage, `async_hooks` specifically,
 * general timing perturbation, and `http.globalAgent` keep-alive pooling. The
 * last one is worth naming because it is the most plausible-sounding: Node 19
 * turned pooling on by default and supertest recycles ports underneath it, so
 * a stale pooled socket for a reused port is a tidy story. It is also wrong -
 * disabling pooling changed nothing, in the real suite (main 2/16 vs "fixed"
 * 3/16) and in the standalone harness (1/9,000 on vs 3/9,000 off).
 *
 * Passing an ALREADY-LISTENING server is what makes supertest bind nothing:
 * `serverAddress` returns early when `app.address()` is non-null, and `end()`
 * only closes a server it opened itself. `listen(0)` publishes its address
 * synchronously, which is why this needs no await - the same property
 * supertest already relies on.
 */
const servers = new Map<unknown, Server>();

export function listening(app: unknown): Server {
  const existing = servers.get(app);
  if (existing) {
    return existing;
  }

  const server = createServer(app as RequestListener).listen(0);
  // THE OTHER HALF OF THE POOLING, and without it the pooling is a NET LOSS.
  //
  // `helpers/pooled-agent.ts` gives the test client a keep-alive agent, so a
  // socket is held open between requests instead of one being opened per
  // request. Node's server closes an idle keep-alive connection after
  // `keepAliveTimeout`, which defaults to 5000ms - and a client that reuses a
  // socket the server has just closed gets ECONNRESET, which superagent
  // reports as `socket hang up`. That is the SAME error text as the socket
  // pressure this whole pair of helpers exists to remove, so it would have
  // been indistinguishable from the flake it was meant to fix.
  //
  // Measured, interleaved, same pooled agent, one request then 6s idle then
  // another: default 5000ms server, 5 resets in 6; `keepAliveTimeout = 0`, 0
  // in 6. Six seconds between two requests to one app is not exotic under the
  // load this repo's suites run at.
  //
  // Zero is safe here in a way it would not be in production: nothing holds
  // these servers open, because `closeListeningServers` destroys every
  // connection at the end of each file.
  server.keepAliveTimeout = 0;
  servers.set(app, server);
  return server;
}

/**
 * Closes everything `listening` opened. Registered as a global `afterAll` in
 * BOTH runners' setup files - ../setup.ts for jest, ../helpers/vitest-setup.ts
 * for vitest (cto/AdaptaLabs#60) - so no test file has to remember, and an
 * unclosed server would hold the worker open and turn a passing run into a hang.
 *
 * Idempotent: it clears the map it closes, so a file that already called it in
 * its own `afterAll` (`routes/__tests__/bookings-concurrency-postgres.test.ts`
 * does) simply leaves the global one nothing to do.
 */
export function closeListeningServers(): Promise<void> {
  const open = [...servers.values()];
  servers.clear();

  return Promise.all(open.map(closeOne)).then(() => undefined);
}

/**
 * How long to wait for one server to close before giving up on it.
 *
 * A BOUND, not a budget. `server.close()` waits for every open connection, and
 * its callback simply never fires if one of them never ends - which would hang
 * the `afterAll` in ../setup.ts, and therefore the jest worker, and therefore
 * CI, as a job timeout with NO NAMED FAILING TEST.
 *
 * That is not hypothetical: proving these tests could detect a broken close
 * meant mutating it, and the mutation did not fail the run - it HUNG it, and
 * had to be killed by hand. A peer reviewing this change asked exactly the
 * right question of it ("if it broke, would a test fail with a name, or would
 * the suite sit there?"), and the answer was the second one.
 *
 * `closeAllConnections()` should make this unreachable by destroying the
 * sockets first. It is called through `?.` because it does not exist before
 * Node 18.2 - and that optional chain is precisely how a hang could come back
 * on an older runtime, silently. So the wait is bounded as well.
 */
const CLOSE_TIMEOUT_MS = 2_000;

function closeOne(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // Destroy first: a request abandoned mid-flight would otherwise keep
    // `close` waiting for a connection nobody is reading.
    server.closeAllConnections?.();

    const timer = setTimeout(() => {
      // Deliberately not a throw. The process is ending; a slow close is not
      // worth failing a green run over. What it must not do is wait forever.
      resolve();
    }, CLOSE_TIMEOUT_MS);
    timer.unref();

    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
