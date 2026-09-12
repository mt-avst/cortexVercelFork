import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';

// Factories use only inline jest.fn() to avoid TDZ, matching the harness in
// utils/__tests__/database.test.ts.
jest.mock('../../config', () => ({
  pool: {
    connect: jest.fn(),
  },
}));

import { runMigrations } from '../migrate';
import { pool } from '../../config';

/**
 * The click_type column add used to sit behind `catch (e) { }` with the comment
 * "Column may already exist" - a case ADD COLUMN IF NOT EXISTS already handles,
 * so nothing benign could ever reach that catch. What could reach it was a real
 * failure, and discarding it left the column absent and every click-tracking
 * insert failing for the life of the deployment with nothing logged anywhere.
 *
 * It now asks the schema whether the column ended up there, and fails the
 * migration only when it genuinely did not.
 */

const mockConnect = pool.connect as unknown as jest.Mock<() => Promise<unknown>>;

// Specific to the click_type ALTER. opportunity_clicks now has a second guarded
// ALTER (visitor_nonce, #125), so a bare `ALTER TABLE opportunity_clicks` matcher
// would wrongly fail that one too; require the column name.
const ALTER_CLICK_TYPE = /ALTER TABLE[\s\S]*opportunity_clicks[\s\S]*click_type/i;

/**
 * Deliberately specific, and every clause is here for a reason a looser matcher
 * got wrong: an earlier version required only "information_schema.columns" and
 * "click_type" to appear somewhere, and survived a mutation that deleted the
 * entire table filter from the query.
 *
 * A mock can only ever pin control flow - it cannot tell you the SQL means what
 * you think against a real Postgres. Requiring the exact resolution mechanism
 * is the most a mock can do: to_regclass rather than information_schema is the
 * whole correctness argument (identical name resolution to the ALTER, and no
 * privilege filtering), so a rewrite that loses it has to fail here.
 */
const COLUMN_CHECK =
  /pg_attribute[\s\S]*to_regclass\('opportunity_clicks'\)[\s\S]*click_type[\s\S]*attisdropped/i;

/**
 * A client that answers every statement blandly, except the click_type ALTER,
 * which fails, and the follow-up schema question, which answers as told.
 */
const clientWhereTheAlterFails = (
  columnIsPresentAfterwards: boolean,
  // Chosen per case so the fixture stays a situation that can really happen.
  // A lock timeout is the realistic way the ALTER fails against a table whose
  // column IS already there: ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE
  // before it evaluates IF NOT EXISTS, so a busy table times out even when the
  // statement would have been a no-op.
  failure = columnIsPresentAfterwards
    ? 'canceling statement due to lock timeout'
    : 'permission denied for table opportunity_clicks'
) => {
  const seen: string[] = [];
  return {
    seen,
    client: {
      query: jest.fn(async (text: unknown) => {
        const sql = String(text);
        seen.push(sql);
        if (ALTER_CLICK_TYPE.test(sql)) {
          throw new Error(failure);
        }
        if (COLUMN_CHECK.test(sql)) {
          return columnIsPresentAfterwards
            ? { rows: [{ '?column?': 1 }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    },
  };
};

const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

beforeEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  consoleLog.mockRestore();
  consoleError.mockRestore();
});

describe('runMigrations - adding opportunity_clicks.click_type', () => {
  it('fails the migration when the column is genuinely missing afterwards', async () => {
    const { client } = clientWhereTheAlterFails(false);
    mockConnect.mockResolvedValue(client);

    await expect(runMigrations()).rejects.toThrow(/permission denied/);

    // The original error, not a rewritten one - the Postgres text is the only
    // thing that says which of the real causes this was.
    expect(client.release).toHaveBeenCalled();
  });

  it('reports the cause rather than discarding it', async () => {
    const { client } = clientWhereTheAlterFails(false);
    mockConnect.mockResolvedValue(client);

    await expect(runMigrations()).rejects.toThrow();

    const logged = consoleError.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toMatch(/click_type/);
    expect(logged).toMatch(/permission denied/);
  });

  it('continues when the column turns out to be present after all', async () => {
    const { client, seen } = clientWhereTheAlterFails(true);
    mockConnect.mockResolvedValue(client);

    await expect(runMigrations()).resolves.toBeUndefined();

    // Continuing means continuing - statements after the ALTER still ran.
    expect(seen.some((sql) => /idx_clicks_opportunity/.test(sql))).toBe(true);
  });

  it('asks the schema only when the ALTER actually failed', async () => {
    const seen: string[] = [];
    const client = {
      query: jest.fn(async (text: unknown) => {
        seen.push(String(text));
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    mockConnect.mockResolvedValue(client);

    await expect(runMigrations()).resolves.toBeUndefined();

    expect(seen.some((sql) => ALTER_CLICK_TYPE.test(sql))).toBe(true);
    expect(seen.some((sql) => COLUMN_CHECK.test(sql))).toBe(false);
  });
});

/**
 * #125 added a second ALTER on opportunity_clicks (visitor_nonce), guarded the
 * same way and for the same reason: `ADD COLUMN IF NOT EXISTS` takes ACCESS
 * EXCLUSIVE before evaluating IF NOT EXISTS, so a busy table can lock-timeout
 * even on the no-op re-run, and an unguarded failure would abort the migration
 * and CrashLoop the pod for an OPTIONAL analytics column. These pin that the
 * guard exists and behaves - a revert to a bare `await client.query(ALTER …)`
 * fails 'continues when the column is present after all' by name.
 */
const ALTER_VISITOR_NONCE = /ALTER TABLE[\s\S]*opportunity_clicks[\s\S]*visitor_nonce/i;
const VISITOR_NONCE_CHECK =
  /pg_attribute[\s\S]*to_regclass\('opportunity_clicks'\)[\s\S]*visitor_nonce[\s\S]*attisdropped/i;

/**
 * A client where the click_type ALTER succeeds and only the visitor_nonce ALTER
 * fails, with the follow-up schema question answered as told. Isolates the
 * visitor_nonce guard from the click_type one that runs just before it.
 */
const clientWhereVisitorNonceAlterFails = (
  columnIsPresentAfterwards: boolean,
  failure = columnIsPresentAfterwards
    ? 'canceling statement due to lock timeout'
    : 'permission denied for table opportunity_clicks'
) => {
  const seen: string[] = [];
  return {
    seen,
    client: {
      query: jest.fn(async (text: unknown) => {
        const sql = String(text);
        seen.push(sql);
        if (ALTER_VISITOR_NONCE.test(sql)) {
          throw new Error(failure);
        }
        if (VISITOR_NONCE_CHECK.test(sql)) {
          return columnIsPresentAfterwards
            ? { rows: [{ '?column?': 1 }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    },
  };
};

describe('runMigrations - adding opportunity_clicks.visitor_nonce (#125)', () => {
  it('fails the migration when the column is genuinely missing afterwards', async () => {
    const { client } = clientWhereVisitorNonceAlterFails(false);
    mockConnect.mockResolvedValue(client);

    await expect(runMigrations()).rejects.toThrow(/permission denied/);
    expect(client.release).toHaveBeenCalled();
  });

  it('continues when the column turns out to be present after all', async () => {
    const { client, seen } = clientWhereVisitorNonceAlterFails(true);
    mockConnect.mockResolvedValue(client);

    await expect(runMigrations()).resolves.toBeUndefined();

    // Continuing means continuing - the index after the ALTER still ran.
    expect(seen.some((sql) => /idx_clicks_opportunity/.test(sql))).toBe(true);
    // It asked the schema by to_regclass, the same resolution the ALTER used.
    expect(seen.some((sql) => VISITOR_NONCE_CHECK.test(sql))).toBe(true);
  });
});
