// Test setup file for Jest
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Set test environment
process.env.NODE_ENV = 'test';

// shared/config/environment.ts validates the environment when src/config is
// imported, and requires a session secret of at least 32 characters. Four
// suites import it transitively - race-condition, config/pool,
// services/reminders and health-endpoint - so without a secret they fail to
// load before running a single test, while the run still reports every other
// suite as passing. That reads as green, which is worse than a failure.
//
// .gitlab-ci.yml sets the same kind of constant for exactly this reason, but
// backend/.env.test is gitignored, so a developer machine and a fresh clone
// get nothing. This fallback makes the local run cover what CI covers by
// default. It is a fixed test constant rather than a credential: no session it
// signs outlives the process, and any real value - CI's variable or a local
// .env.test - still wins, because this only fills an absent one.
process.env.SESSION_SECRET ||= 'jest-local-test-constant-not-a-real-secret'; // gitleaks:allow

// Every server opened by `listening()` is closed once the file's tests are
// done. Global rather than per-file so a new test file cannot forget, and an
// unclosed server cannot leave a jest worker hanging.
//
// The port reservoir refills in beforeAll AND beforeEach (cto/AdaptaLabs#44):
// `listening()` is called inside test bodies, where no hook can run, so each
// test starts with a full bank of ports verified free on 127.0.0.1 - the
// address supertest actually dials.
import { closeListeningServers, topUpVerifiedPorts } from './helpers/listening';

// supertest opens a fresh TCP connection for every request unless it is given
// a pooling agent, and a full run of this suite parks ~2,200 sockets in
// TIME_WAIT because of it (cto/AdaptaLabs#44). Installed globally for the same
// reason the close above is: so no test file has to remember. The forensics
// hook is what caught #44's mechanism in the act; it stays so any future
// transport-level failure names its socket state instead of just its victim.
import {
  destroyPooledTestAgent,
  installPooledTestAgent,
  installTransportForensics,
} from './helpers/pooled-agent';

installPooledTestAgent();
installTransportForensics();

beforeAll(topUpVerifiedPorts);
beforeEach(topUpVerifiedPorts);

afterAll(async () => {
  // Client first, then servers - see `destroyPooledTestAgent`.
  destroyPooledTestAgent();
  await closeListeningServers();
});

// Mock console methods in test environment to reduce noise
if (process.env.NODE_ENV === 'test') {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}
