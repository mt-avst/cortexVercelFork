import { EventEmitter } from 'events';
import { pool } from '../../config';

/**
 * The exported backend pool serves all Express traffic, and without these
 * listeners a dropped connection terminates the process. The helper's own
 * unit tests cannot catch it being unwired here: removing the
 * attachPoolErrorLogging call from config/index.ts left every other suite
 * green, so this pins the wiring itself rather than the helper's behaviour.
 */
describe('backend pool error guards', () => {
  it('registers an error listener, so an idle-client error cannot kill the process', () => {
    expect((pool as unknown as EventEmitter).listenerCount('error')).toBe(1);
  });

  it('registers acquire and release listeners that guard checked-out clients', () => {
    // pg-pool strips a client's own error listener while it is checked out, so
    // the Pool listener above does not cover a client held across a
    // transaction. That gap is closed by this pair.
    expect((pool as unknown as EventEmitter).listenerCount('acquire')).toBe(1);
    expect((pool as unknown as EventEmitter).listenerCount('release')).toBe(1);
  });
});

/**
 * The TLS wiring, pinned at the call site rather than in the helper.
 *
 * dbTls.ts has its own tests, but they cannot catch config/index.ts being
 * unwired from it: a mutation reverting this pool to
 * `NODE_ENV === 'production' ? { rejectUnauthorized: false } : false` survived
 * the entire suite. It survived because under jest NODE_ENV is 'test' and the
 * resolved database is local, so the old and new code agree - the difference
 * only appears for a REMOTE database, which is exactly the case that matters.
 */
describe('backend pool TLS wiring', () => {
  const ORIGINAL_ENV = { ...process.env };
  const RDS = 'postgres://u:pw@cortex.abc123.eu-west-1.rds.amazonaws.com:5432/app';

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  function loadPoolWith(env: Record<string, string | undefined>) {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...env } as NodeJS.ProcessEnv;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loaded = require('../../config') as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Client } = require('pg') as any;
    return new Client(loaded.pool.options).connectionParameters.ssl;
  }

  it('encrypts to a remote database even when NODE_ENV is not production', () => {
    // The old condition gave a remote database NO TLS AT ALL outside
    // production - not merely an unverified connection.
    const ssl = loadPoolWith({ DATABASE_URL: RDS, NODE_ENV: 'test', DB_TLS_VERIFY: undefined });
    expect(ssl).not.toBe(false);
    expect(ssl.rejectUnauthorized).toBe(false);
  });

  it('verifies that database once DB_TLS_VERIFY is set', () => {
    const ssl = loadPoolWith({ DATABASE_URL: RDS, NODE_ENV: 'test', DB_TLS_VERIFY: '1' });
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBeTruthy();
  });

  it('does not let an sslmode in DATABASE_URL undo the verification', () => {
    // pg merges the parsed connection string over the ssl option, so passing
    // the ORIGINAL string alongside a verifying config leaves the string in
    // charge. Without this case, a mutation that hands the Pool the unstripped
    // string survives - the other cases carry no TLS parameters, so stripping
    // them is a no-op there.
    const ssl = loadPoolWith({
      DATABASE_URL: `${RDS}?sslmode=disable`,
      NODE_ENV: 'test',
      DB_TLS_VERIFY: '1',
    });
    expect(ssl).not.toBe(false);
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBeTruthy();
  });

  it('leaves a local database alone', () => {
    const ssl = loadPoolWith({
      DATABASE_URL: 'postgresql://postgres:password@postgres:5432/adaptalabs_dev',
      NODE_ENV: 'test',
      DB_TLS_VERIFY: undefined,
    });
    expect(ssl).toBe(false);
  });
});
