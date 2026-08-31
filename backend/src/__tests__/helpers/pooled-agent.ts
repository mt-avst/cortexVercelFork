import http from 'node:http';
import supertest from 'supertest';

/**
 * ONE TCP CONNECTION PER SERVER, INSTEAD OF ONE PER REQUEST.
 *
 * The sibling half of `listening.ts`, one layer down. That helper stopped
 * supertest BINDING a fresh ephemeral port per request; this one stops it
 * CONNECTING on a fresh ephemeral port per request. Both are flake fixes, and
 * the second was left behind by the first.
 *
 * WHY IT EXISTS. `superagent` sets `this._agent = false` in its constructor
 * (`superagent/lib/node/index.js:160`) and passes it straight through as
 * `options.agent = false` (:747). Node reads `agent: false` as "give this
 * request its own throwaway Agent with default options", and the default is
 * `keepAlive: false` - so every supertest call opens a TCP connection and
 * closes it again. `http.globalAgent` is irrelevant here: it already has
 * `keepAlive: true` on Node 22 and superagent never reaches it. Measured, 20
 * requests to one server through the default client: 20 connections.
 *
 * WHAT THAT COSTS. Measured on this repo at 9212686 by sampling
 * `netstat -an -p tcp | grep -c TIME_WAIT` once a second across one full
 * backend jest run: 211 before, 2,190 after. So a single run parks roughly two
 * thousand sockets in TIME_WAIT, and macOS holds each for 2*MSL - `msl` is
 * 15,000ms - which is thirty seconds, against an ephemeral range
 * (`net.inet.ip.portrange.first` 49152 to `.last` 65535) of 16,384 ports.
 *
 * One run alone is comfortable. Several at once are not, and several at once
 * is the normal state of this machine during a mutation-canary campaign. Four
 * concurrent runs produce ~8,000 sockets every fourteen seconds against a
 * thirty-second recycle, which is the regime where the connect fails at the
 * transport layer and whichever test happened to be mid-request dies with
 * `socket hang up` - never an assertion, always by name, and never the same
 * test twice.
 *
 * That is cto/AdaptaLabs#44. The issue reasoned from two absence-assertions
 * failing together to shared mutable state surviving between tests, and that
 * inference does not hold: the two live in different files, jest gives each
 * test file its own module registry, and there is no shared JS state between
 * them to survive. Reproduced under four concurrent suites, the identical
 * symptom landed on `feedback.open-to-all-admins` (two tests) and
 * `csrf` (one) - different files, ordinary positive assertions, all three
 * `socket hang up`. The pairing is two samples of one process-global socket
 * condition, not a leak.
 *
 * `maxSockets` is left at the default `Infinity` ON PURPOSE. A small pool
 * would be a deadlock waiting for the first test that holds one response open
 * while issuing another - and a deadlock here is a jest worker that hangs,
 * which is a CI job timeout with NO NAMED FAILING TEST. Unbounded plus
 * `keepAlive` still collapses the common case to nothing: measured, 25
 * sequential requests to one server take 1 connection, and 10 concurrent ones
 * take 9 more because one of the ten reuses the free socket.
 *
 * MEASURED, interleaved, five samples an arm, alternating order, on a machine
 * at load 9.5-14 with another agent's canary runs on it. Sockets left in
 * TIME_WAIT by one full backend jest run:
 *
 *   origin/main : 1855 1878 1859 1855 1858   (median 1858)
 *   with this   :  418  404  418  415  423   (median  418)
 *
 * ponytail: pooled per host:port, so the floor is one connection per express
 *   app, not one per run. Most suites build a fresh app per test, which is
 *   where the residual ~418 comes from. Sharing one app across a file's tests
 *   would take it to roughly one per suite; not done because 4.4x is what the
 *   flake needed and the other way is 70-odd files of churn.
 *
 *   THE SAVING IS NOT SPREAD EVENLY, and that matters for reading #44. Client
 *   connects per file across a full run, counted by instrumenting
 *   `net.Socket.prototype.connect` on both arms (1887 total unpooled, 419
 *   pooled):
 *
 *     opportunities.test.ts                 642 -> 14
 *     firsthand.test.ts                     518 -> 25
 *     firsthand-session.test.ts             187 ->  6
 *     auth-rate-limit.test.ts                60 -> 11
 *     sessions.write-ownership.test.ts       40 -> 40
 *     csrf.test.ts                           10 ->  8
 *     feedback.open-to-all-admins.test.ts    10 -> 10
 *     bookings.cancel-writes-are-row-scoped   9 ->  9
 *     runtime-work-class.test.ts              8 ->  6
 *
 *   Four files supply 96% of it; 25 of the 44 supertest-using suites are
 *   unchanged, and the suites #44 names as victims get 0-20%. So the benefit
 *   is PROCESS-GLOBAL socket pressure, not per-suite relief - which is why the
 *   red-run rate for those particular suites did not move. Written down so
 *   nobody re-derives it from the medians.
 *
 * WHAT POOLING ALSO BUYS, and it is the better argument. Three sequential
 * requests to one app used to get three separate TCP connections, so
 * `runtime-work-class.test.ts`'s `does not leak the classification into the
 * next request` could not fail whatever the middleware did - there was no
 * shared socket for a context to ride across. Proven by the refute gate on
 * !268: mutating `runAsParticipantWork` from `storage.run(ctx, op)` to
 * `storage.enterWith(ctx); return op()` - the textbook cross-request leak -
 * fails that test by name on the pooled arm and passes 5/5 on the unpooled
 * one, twice, interleaved. The detector starts detecting here.
 *
 * And it does not leak the other way: 6,000 alternating requests through the
 * real middleware over this agent gave `distinctClientPorts: 1, leaks: 0`. The
 * single port is the control - the socket genuinely was reused, so the zero
 * means something. An `Authorization` header or a `Cookie` set on request N is
 * not visible on request N+1 over the same socket.
 *
 * WIRED INTO BOTH RUNNERS (cto/AdaptaLabs#60, closed). `setup.ts` is jest's
 * `setupFilesAfterEnv`, so for a while the vitest-owned globs did not get this
 * at all - `supertest` appears in one vitest-owned file at one call site, so the
 * churn there was a rounding error and it was left. It is closed now:
 * `helpers/vitest-setup.ts` is `vitest.config.ts`'s `setupFiles` and installs
 * the same agent, and `__tests__/pooled-agent-vitest.test.ts` counts the
 * connections on that side so the wiring cannot silently come undone.
 *
 * Two entry points, one agent. Anything changed here changes both.
 */
export const TEST_HTTP_AGENT = new http.Agent({ keepAlive: true });

type AgentCarrier = { _agent: unknown };
type RequestBuilder = (this: AgentCarrier) => unknown;

/**
 * Wired on `Test.prototype` rather than at each call site, because there are
 * several hundred call sites and `__tests__/listening-call-sites.test.ts`
 * already exists to prove that a new one cannot quietly opt out of the sibling
 * helper. Repeating that enforcement for an agent argument would be a second
 * scan guarding a second thing every author has to remember; a default nobody
 * has to remember is smaller and cannot be forgotten.
 *
 * Only `false` is replaced. A test that sets its own agent - to assert
 * something about pooling, or to isolate a connection deliberately - keeps it.
 */
export function installPooledTestAgent(): void {
  // `supertest.Test` is a runtime export that `@types/supertest` declares only
  // as a type, so the constructor has to be reached through the module object.
  const { Test } = supertest as unknown as {
    Test: { prototype: { request: RequestBuilder } };
  };
  const proto = Test.prototype;
  const original = proto.request;

  proto.request = function (this: AgentCarrier) {
    if (this._agent === false) {
      this._agent = TEST_HTTP_AGENT;
    }
    return original.call(this);
  };
}

/**
 * TURN A TRANSPORT-LEVEL FAILURE INTO NAMED EVIDENCE. cto/AdaptaLabs#44.
 *
 * This hook is the instrument that finally caught that flake's mechanism in
 * the act: on any supertest error carrying no HTTP status - the signature of
 * a failure below the protocol - it writes the dying request's socket state
 * to stderr beside the failure jest formats. The 2026-08-31 diagnosis came
 * from exactly these lines: every failing request was on a FRESH socket
 * (`reusedSocket: false`, acquitting the keep-alive pool) and every failing
 * URL named one of two squatted ports (convicting the wildcard bind - see
 * helpers/listening.ts).
 *
 * It stays installed so a recurrence is a diagnosis, not an anecdote: the
 * next transport failure will say which port it dialed and whether the
 * socket was pooled, which is the difference between an evening of forensics
 * and reading one line.
 *
 * `!err.status` rather than an error-code list, because the list is the part
 * that goes stale: superagent surfaces these as ECONNRESET, HPE_* parse
 * errors, EPIPE and friends, and any of them without a status means the
 * transport, not the application, failed.
 */
export function installTransportForensics(): void {
  const { Test } = supertest as unknown as {
    Test: { prototype: Record<string, unknown> };
  };
  // Idempotent: a second installation would stack a second printer onto the
  // chain and every failure would log twice. Each runner's setup calls this
  // once per process today; this keeps that an invariant rather than a habit.
  if (Test.prototype.__transportForensicsInstalled) return;
  Test.prototype.__transportForensicsInstalled = true;
  const original = Test.prototype.callback as (...args: unknown[]) => unknown;

  Test.prototype.callback = function (
    this: Record<string, unknown>,
    err: { status?: number; message?: string; code?: string } | null,
    res: unknown
  ) {
    if (err && !err.status) {
      const req = this.req as
        | { reusedSocket?: boolean; socket?: { localPort?: number; remotePort?: number } }
        | undefined;
      // The test name, because four workers interleave one stderr and the
      // victim's identity is otherwise the one thing these lines omit. Both
      // runners implement expect.getState(); guarded anyway, since forensics
      // that can crash the failure path would be worse than none.
      let test: string | null = null;
      try {
        test = expect.getState().currentTestName ?? null;
      } catch {
        // No expect in scope - a request fired outside any test. Name absent.
      }
      process.stderr.write(
        `[transport-forensics] ${JSON.stringify({
          message: err.message,
          code: err.code,
          method: this.method,
          url: this.url,
          reusedSocket: req?.reusedSocket ?? null,
          localPort: req?.socket?.localPort ?? null,
          remotePort: req?.socket?.remotePort ?? null,
          test,
        })}\n`
      );
    }
    return original.call(this, err, res);
  };
}

/**
 * Give the pooled sockets back before the servers go.
 *
 * Node unrefs a free keep-alive socket, so this is not what stands between the
 * suite and a hung worker - `closeListeningServers` is. It is here so the
 * teardown order is the safe one: destroying the client's idle sockets before
 * `closeAllConnections()` destroys the server's ends of the same sockets means
 * no pooled socket is ever torn down from under a live agent.
 */
export function destroyPooledTestAgent(): void {
  TEST_HTTP_AGENT.destroy();
}
