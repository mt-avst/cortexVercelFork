import { afterAll } from 'vitest';

import { closeListeningServers } from './listening';
import { destroyPooledTestAgent, installPooledTestAgent } from './pooled-agent';

/**
 * THE VITEST HALF OF `../setup.ts` (cto/AdaptaLabs#60).
 *
 * `../setup.ts` is jest's `setupFilesAfterEnv`, so the vitest-owned globs in
 * `vitest.config.ts` never saw `installPooledTestAgent()` and every supertest
 * call on that side opened a TCP connection it then threw away - the socket
 * churn cto/AdaptaLabs#44 is made of, at a smaller scale.
 *
 * A SEPARATE FILE rather than a shared one, because `../setup.ts` calls
 * `jest.fn()` and registers jest's `afterAll`. Two runners, two entry points,
 * one helper underneath: what is worth sharing is `pooled-agent.ts`, and it is
 * shared rather than copied.
 *
 * `closeListeningServers()` is here for the same reason jest's setup has it -
 * so no test file has to remember, and a forgotten server cannot hold a worker
 * open. It is idempotent (it clears the map it closes), so the one vitest file
 * that already closes its own servers,
 * `routes/__tests__/bookings-concurrency-postgres.test.ts`, keeps working
 * unchanged and this simply finds nothing left to do.
 *
 * TEARDOWN ORDER IS THE OPPOSITE OF JEST'S RELATIVE TO A TEST FILE'S OWN
 * `afterAll`, and that is measured rather than assumed. Vitest 3.2.7 defaults
 * `sequence.hooks` to `'stack'`, so `afterAll` hooks run in REVERSE
 * registration order and a setup file's - registered first, before the test
 * file is even loaded - runs LAST. Probed directly on 3.2.7: the test file's
 * `afterAll` logged before this one's, where under jest it is the other way
 * round.
 *
 * WITHIN this hook the order is jest's, client before servers, and that is the
 * order that matters: destroying the client's idle sockets before
 * `closeAllConnections()` destroys the server's ends means no pooled socket is
 * ever torn down from under a live agent. For the one file that closes its own
 * servers first, nothing is in flight by `afterAll` anyway, and
 * `Agent.destroy()` over sockets a closed server already destroyed is a no-op.
 */
installPooledTestAgent();

afterAll(async () => {
  // Client first, then servers - see `destroyPooledTestAgent`.
  destroyPooledTestAgent();
  await closeListeningServers();
});
