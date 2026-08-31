import { createServer, type RequestListener, type Server } from 'node:http';
import net from 'node:net';

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
 * only closes a server it opened itself. A bare numeric `listen(port)`
 * publishes its address synchronously, which is why this needs no await - the
 * same property supertest already relies on.
 *
 * A LATER CORRECTION to the paragraph above (cto/AdaptaLabs#44): "the
 * bind/close cycle is itself the trigger" named the exposure, not the
 * mechanism. The residual red runs that survived this helper AND the pooled
 * agent were finally caught in the act on 2026-08-31: every one was a fresh
 * connection delivered to a long-lived IPv4-only service squatting an
 * ephemeral port that `listen(0)`'s wildcard bind had been assigned over.
 * See the reservoir below, which closes it. The 8-in-30,000 standalone
 * figure was not re-measured against that mechanism, but a server per
 * request sweeps the ephemeral range thousands of times per run, which is
 * consistent with it.
 */
const servers = new Map<unknown, Server>();

/**
 * PORTS VERIFIED FREE ON 127.0.0.1, WAITING TO BE BOUND. cto/AdaptaLabs#44.
 *
 * THE MECHANISM THIS CLOSES, named at last. `listen(0)` with no host binds the
 * IPv6 wildcard `::`, and the kernel assigns it any port whose IPv6 side is
 * free - INCLUDING one whose 127.0.0.1 side is already owned by a v4-only
 * listener, because a wildcard v6 socket and a specific v4 socket coexist on
 * one port. supertest then dials `http://127.0.0.1:<port>` (hardcoded in
 * `Test.serverAddress`), the kernel routes that to the MORE SPECIFIC v4
 * socket, and the request lands on whatever service happens to squat there.
 *
 * Measured on 2026-08-31, 80 clean-tree full runs with a forensics hook
 * recording every transport-level failure: 6 red runs, every failing request
 * on a FRESH socket (never a pooled reuse), and every failing URL on one of
 * exactly two ports - 55701, a leftover Homebrew postgres (answers HTTP with
 * a protocol error close: `socket hang up`), and 53144, colima's limactl
 * (answers non-HTTP bytes: `Parse Error: Expected HTTP/, RTSP/ or ICE/`).
 * Both are long-lived IPv4-only listeners inside the ephemeral range. That
 * also explains every recorded property of the flake: it lands on whichever
 * test happens to draw the squatted port, it is always transport-level and
 * never an assertion, it worsens with concurrent runs (more binds per second
 * sweep the ephemeral range faster), and it arrives in consecutive-run
 * clusters as the kernel's sequential port counter passes a squatter.
 *
 * WHY A RESERVOIR RATHER THAN `listen(0, '127.0.0.1')`. Binding with a host
 * string resolves through `dns.lookup`, so `address()` is null until the next
 * tick - and supertest reads `app.address()` SYNCHRONOUSLY at Test creation,
 * falling back to binding its own throwaway server when it sees null. Every
 * one of the ~940 `listening(` call sites (950 grep occurrences across
 * backend/src + backend/probe on 2026-08-31, minus comments and imports)
 * relies on that synchronous contract. So the verification is done ahead of
 * time, asynchronously, where a hook can await it: a probe binds
 * `127.0.0.1:0` - the kernel can only assign it a port that is FREE ON
 * EXACTLY THE ADDRESS SUPERTEST DIALS - the probe closes, and the port goes
 * in this reservoir. `listening()` then binds it with a bare numeric
 * `listen(port)`, which is synchronous.
 *
 * A verified port can still be lost to a race. If the rival bind is a
 * WILDCARD bind - another worker's server - the failure is synchronous
 * (`address()` stays null) and `bindVerifiedPort` moves to the next port. If
 * the rival is V4-SPECIFIC, it is NOT detectable: `listen(port)` binds `::`
 * alongside it and returns an address, which is #44 exactly - demonstrated
 * by the review gate, which planted a v4 rival inside the window and drove
 * the Parse Error through this very helper. What makes that acceptable is
 * not detection, it is the window: the reservoir is DISCARDED and re-probed
 * before every test, the static squatters this flake is made of were already
 * there when the probe asked, and a new v4-only listener would have to
 * appear on this exact port in the fraction of a second between probe and
 * bind. The flake as measured needed neither - only a long-lived squatter
 * and a wildcard bind.
 */
const verifiedPorts: number[] = [];

/**
 * The bank size, and also the ceiling on how many NEW servers one test body
 * can open: the reservoir is rebuilt in `beforeAll`/`beforeEach` (both
 * runners' setup files), so a single test that outruns it throws the named
 * exhaustion error below rather than silently reverting to wildcard binds.
 * Raise it here if a legitimate test ever needs more. Measured 2026-08-31 by
 * instrumenting a full jest run: the peak is 6 servers in one test body
 * (userCalendar.connect-flow), next highest 4; the vitest side was not
 * instrumented but holds far fewer supertest call sites.
 */
export const PORT_RESERVOIR_LOW_WATER = 16;

/**
 * A live probe bound to `127.0.0.1:0`, handed back still listening so a test
 * can SEE the address family it bound rather than trusting a self-report.
 * The caller closes it. The host argument is the load-bearing character of
 * this whole file: a probe that bound the wildcard would "verify" ports the
 * v4 side of which is taken, which is the exact false assurance #44 is made
 * of.
 */
export function bindLoopbackProbe(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve(probe));
  });
}

/** How many verified ports are currently banked. Read by tests and hooks. */
export function verifiedPortCount(): number {
  return verifiedPorts.length;
}

/**
 * Rebuild the reservoir. Registered as a global `beforeAll` AND `beforeEach`
 * in both runners' setup files - `beforeEach` because `listening()` is called
 * inside test bodies, where no hook can run.
 *
 * DISCARDS the bank rather than topping it up. A top-up leaves the bottom of
 * the stack verified once per FILE, and the stale entries are reached by
 * exactly the tests that open several servers - the widest race window handed
 * to the deepest consumers (found by the review gate: lowest bank level in a
 * full run was 10, so a top-up's bottom six entries were never re-verified).
 * Rebuilding makes every port's verification younger than the test using it.
 * Measured cost: 16 probes is ~4ms, and the full jest run moved by ~1s.
 *
 * BOUNDED, because this runs real I/O inside a global hook and an unbounded
 * loop here would be a hung worker with no named failing test - the failure
 * shape this repo's rules single out. The bound is generous: probes against a
 * loopback that cannot bind simply reject, and rejection propagates out of
 * this function as its own error.
 */
export async function topUpVerifiedPorts(): Promise<void> {
  verifiedPorts.length = 0;
  for (let attempts = 0; verifiedPorts.length < PORT_RESERVOIR_LOW_WATER; attempts++) {
    if (attempts >= PORT_RESERVOIR_LOW_WATER * 4) {
      throw new Error(
        `topUpVerifiedPorts: ${attempts} probes yielded only ${verifiedPorts.length} of ` +
          `${PORT_RESERVOIR_LOW_WATER} verified ports - the loopback is not handing out addresses`
      );
    }
    const probe = await bindLoopbackProbe();
    const address = probe.address();
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (address && typeof address === 'object') {
      verifiedPorts.push(address.port);
    }
  }
}

/**
 * Bind `server` on a verified port, synchronously. Exported with an
 * injectable port list so the retry path - reachable in production only
 * through a cross-worker race - can be driven deterministically by a test.
 *
 * A failed numeric bind is visible synchronously (`address()` stays null)
 * but EMITS its EADDRINUSE asynchronously, so a swallower is attached for
 * the duration and removed once any pending emissions have flushed. Without
 * it, the retry that SAVED the bind would still crash the worker a tick
 * later on the error from the bind it retried past.
 */
export function bindVerifiedPort(server: Server, ports: number[] = verifiedPorts): void {
  const swallowBindError = () => {};
  server.on('error', swallowBindError);
  let failures = 0;
  try {
    while (ports.length > 0) {
      server.listen(ports.pop() as number);
      if (server.address()) {
        return;
      }
      failures += 1;
    }
    throw new Error(
      'listening(): the verified-port reservoir ran dry' +
        (failures > 0
          ? ` after ${failures} failed bind${failures === 1 ? '' : 's'} - ports were taken between verification and use`
          : ` - one test body opened more than PORT_RESERVOIR_LOW_WATER (${PORT_RESERVOIR_LOW_WATER}) new servers between refills; ` +
            'raise the constant in helpers/listening.ts, or share an app across the requests') +
        '. Refusing to fall back to listen(0): a wildcard bind can be assigned a port whose ' +
        '127.0.0.1 side another process owns, which is the cto/AdaptaLabs#44 flake.'
    );
  } finally {
    if (failures === 0) {
      server.removeListener('error', swallowBindError);
    } else {
      // Two turns of the loop, because the EADDRINUSE emissions are scheduled
      // with process.nextTick from inside listen() and one setImmediate can
      // run before a nextTick queued after it was scheduled. The cost of the
      // window: a GENUINE server error in these two turns is eaten too, and
      // if the file ends inside it the swallower stays on that server for its
      // remaining lifetime. Both need the retry path (a cross-worker race) to
      // have fired first, and both lose one error event, not a failure.
      setImmediate(() => {
        setImmediate(() => server.removeListener('error', swallowBindError));
      });
    }
  }
}

export function listening(app: unknown): Server {
  const existing = servers.get(app);
  if (existing) {
    return existing;
  }

  const server = createServer(app as RequestListener);
  bindVerifiedPort(server);
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
