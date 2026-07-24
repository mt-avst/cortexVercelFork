import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Factories use only inline jest.fn() to avoid TDZ, matching the harness in
// routes/__tests__/opportunities.test.ts.
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('../../config/databaseUrl', () => ({
  hasDatabaseConfig: jest.fn(),
}));

import { isDatabaseAvailable } from '../database';
import { pool } from '../../config';
import { hasDatabaseConfig } from '../../config/databaseUrl';
import { AppError } from '../errorHandler';

const mockQuery = pool.query as jest.MockedFunction<any>;
const mockHasDatabaseConfig = hasDatabaseConfig as jest.MockedFunction<any>;

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

/**
 * Asserts the call rejected and hands back the error typed. Resolving is itself
 * a failure here: returning `false` instead of throwing is the exact defect
 * these tests exist to pin.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<AppError> =>
  promise.then(
    (value) => {
      throw new Error(
        `expected isDatabaseAvailable() to reject, but it resolved with ${String(value)}`
      );
    },
    (error: unknown) => error as AppError
  );

/**
 * NODE_ENV has to be set on process.env rather than read from `config`, because
 * shared/config/environment coerces any unrecognised value to 'development'
 * (`z.enum([...]).catch(() => 'development')`). That coercion is fail-open: it
 * is exactly why these tests assert on the raw value.
 */
const setNodeEnv = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
};

describe('isDatabaseAvailable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    setNodeEnv(ORIGINAL_NODE_ENV);
  });

  describe('when a database IS configured', () => {
    beforeEach(() => {
      mockHasDatabaseConfig.mockReturnValue(true);
    });

    it('returns true when the connectivity check succeeds', async () => {
      mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

      await expect(isDatabaseAvailable()).resolves.toBe(true);
      expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
    });

    // The core of this fix. Previously this resolved `false`, which made every
    // caller fall through to the demo fixture store and answer HTTP 200 with
    // fabricated data during a real database outage.
    it('throws a 503 rather than reporting mock-data mode when the connectivity check fails', async () => {
      setNodeEnv('production');
      mockQuery.mockRejectedValue(new Error('connection terminated unexpectedly'));

      await expect(isDatabaseAvailable()).rejects.toBeInstanceOf(AppError);
    });

    it('surfaces the failure as 503 DB_CONNECTION_FAILED', async () => {
      setNodeEnv('production');
      mockQuery.mockRejectedValue(new Error('connection terminated unexpectedly'));

      const error = await rejectionOf(isDatabaseAvailable());

      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(503);
      expect(error.code).toBe('DB_CONNECTION_FAILED');
    });

    // A configured-but-unreachable database is never a mock-data situation, in
    // any environment. Silently serving fixtures locally hides the same class of
    // fault it hides in production.
    it.each(['production', 'development', 'test', undefined])(
      'throws rather than falling back to mock data when NODE_ENV is %s',
      async (nodeEnv) => {
        setNodeEnv(nodeEnv as string | undefined);
        mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(isDatabaseAvailable()).rejects.toBeInstanceOf(AppError);
      }
    );

    it('does not leak the underlying driver message to the caller', async () => {
      setNodeEnv('production');
      mockQuery.mockRejectedValue(
        new Error('password authentication failed for user "adaptalabs"')
      );

      const error = await rejectionOf(isDatabaseAvailable());

      expect(error.message).not.toMatch(/password/i);
      expect(error.message).not.toMatch(/adaptalabs/i);
    });
  });

  describe('when NO database is configured', () => {
    beforeEach(() => {
      mockHasDatabaseConfig.mockReturnValue(false);
    });

    // Preserves the documented local workflow: `npm run dev` sets no NODE_ENV.
    it.each([undefined, 'development', 'test'])(
      'permits mock-data mode when NODE_ENV is %s',
      async (nodeEnv) => {
        setNodeEnv(nodeEnv as string | undefined);

        await expect(isDatabaseAvailable()).resolves.toBe(false);
        expect(mockQuery).not.toHaveBeenCalled();
      }
    );

    // This is the shape of the week-long outage recorded in
    // config/__tests__/databaseUrl.test.ts: database configuration went missing
    // in a real deployment and the backend quietly served fixtures instead.
    it('throws in production instead of serving fixtures', async () => {
      setNodeEnv('production');

      await expect(isDatabaseAvailable()).rejects.toBeInstanceOf(AppError);
    });

    // Fail-safe: an unrecognised NODE_ENV must not be treated as a developer
    // machine. shared/config/environment would coerce it to 'development'.
    it.each(['staging', 'prod', 'Production', 'PRODUCTION'])(
      'throws for the unrecognised NODE_ENV %s rather than assuming development',
      async (nodeEnv) => {
        setNodeEnv(nodeEnv);

        await expect(isDatabaseAvailable()).rejects.toBeInstanceOf(AppError);
      }
    );
  });
});
