import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import feedbackRouter, { FEEDBACK_LIST_LIMIT } from '../feedback';
import { logger } from '../../utils/logger';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;

/**
 * GET /api/feedback IS BOUNDED. cto/AdaptaLabs#81.
 *
 * The list route read the whole feedback table - no LIMIT, no cursor - and the
 * table grows with user submissions, not admin activity. The disposition chosen
 * (option 3 on the issue) is a fixed server cap with `has_more`, NOT a keyset
 * cursor, because the only consumer (AdminFeedback.tsx) sorts client-side on
 * three fields over the whole loaded set and a `(created_at, id)` keyset can
 * only preserve one of them. The cursor rework is #86, triggered if the table
 * ever outgrows the cap.
 *
 * The route fetches LIMIT+1 rows and reports `has_more` from the presence of
 * the extra row, so the flag is measured, not guessed from a separate COUNT
 * that could race the read.
 */

const feedbackRow = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  user_id: 'u1',
  user_name: `User ${n}`,
  user_email: `user${n}@example.com`,
  category: 'bug',
  feedback: `feedback body ${n}`,
  url: 'https://example.com',
  user_agent: 'jest',
  created_at: '2026-08-26T00:00:00.000Z',
});

const rowsOf = (count: number) => Array.from({ length: count }, (_, i) => feedbackRow(i));

const app = () => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id: 'u1', name: 'A', email: 'a@example.com', role: 'superadmin' },
    };
    next();
  });
  a.use('/api/feedback', feedbackRouter);
  a.use(errorHandler);
  return a;
};

describe('the feedback list cap is the number the issue and the UI copy agree on', () => {
  // A LITERAL, deliberately. A test that derives its expectation from the
  // constant cannot see the constant move; this one goes red if anyone changes
  // the policy number, which is the point (rules/common/testing.md).
  it('is 1000', () => {
    expect(FEEDBACK_LIST_LIMIT).toBe(1000);
  });
});

describe('GET /api/feedback is bounded', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('asks the database for the cap plus one rows, as a bound parameter', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    await request(listening(app())).get('/api/feedback').expect(200);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Both halves matter: LIMIT present in the SQL, and the bound value being
    // the literal 1001 - asserting only one lets the other drift.
    expect(sql).toMatch(/LIMIT \$1/);
    expect(params).toEqual([1001]);
    // "The most recent" is the entire meaning of a cap without a cursor. An
    // unordered LIMIT returns an arbitrary 1000 rows - silent truncation of
    // an unpredictable subset, which is what #81 exists to stop. The review
    // gate deleted this clause and the whole 1497-test suite stayed green;
    // this line is what turned that mutation into a named failure.
    expect(sql).toMatch(/ORDER BY created_at DESC, id DESC/);
  });

  it('returns every row with has_more false when the table fits under the cap', async () => {
    mockQuery.mockResolvedValue({ rows: rowsOf(3), rowCount: 3 } as never);

    const res = await request(listening(app())).get('/api/feedback').expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0].feedback).toBe('feedback body 0');
    expect(res.body.has_more).toBe(false);
  });

  it('returns exactly the cap with has_more false when the table holds exactly the cap', async () => {
    // The boundary case that separates `>` from `>=` on the overflow check: at
    // exactly 1000 rows the sentinel row is absent, nothing was cut off, and
    // claiming has_more would tell the admin to go looking for rows that do
    // not exist.
    mockQuery.mockResolvedValue({ rows: rowsOf(1000), rowCount: 1000 } as never);

    const res = await request(listening(app())).get('/api/feedback').expect(200);

    expect(res.body.data).toHaveLength(1000);
    expect(res.body.has_more).toBe(false);
  });

  it('returns exactly the cap with has_more true when the table overflows it', async () => {
    // The database answered LIMIT+1 rows, meaning at least one row exists past
    // the cap. The sentinel row must NOT reach the wire - 1001 rows with
    // has_more true would hand the UI one more row than the stated cap.
    mockQuery.mockResolvedValue({ rows: rowsOf(1001), rowCount: 1001 } as never);

    const res = await request(listening(app())).get('/api/feedback').expect(200);

    expect(res.body.data).toHaveLength(1000);
    expect(res.body.has_more).toBe(true);
  });

  it('logs the ceiling being hit, so the #86 trigger does not depend on an admin mentioning it', async () => {
    /*
     * The deferral on this cap comes with a condition for revisiting it, and a
     * condition nobody can observe is not a trigger. Before this the only
     * signal was the notice in the admin UI - which fires in one person's
     * browser and reaches an engineer only if they think to say so.
     */
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      mockQuery.mockResolvedValue({ rows: rowsOf(1001), rowCount: 1001 } as never);

      await request(listening(app())).get('/api/feedback');

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cto/AdaptaLabs#86'),
        expect.objectContaining({ cap: 1000 })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent below the ceiling, so the signal means something when it fires', async () => {
    // The control. A line logged on every list request is a line nobody reads,
    // and the trigger would be indistinguishable from ordinary traffic.
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      mockQuery.mockResolvedValue({ rows: rowsOf(1000), rowCount: 1000 } as never);

      await request(listening(app())).get('/api/feedback');

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the rows in the order the database returned them', async () => {
    // The route must not re-sort: the UI owns sorting, the SQL owns the
    // newest-first ordering, and the slice must take the FIRST cap rows (the
    // newest) rather than the last.
    mockQuery.mockResolvedValue({ rows: rowsOf(1001), rowCount: 1001 } as never);

    const res = await request(listening(app())).get('/api/feedback').expect(200);

    expect(res.body.data[0].feedback).toBe('feedback body 0');
    expect(res.body.data[999].feedback).toBe('feedback body 999');
  });
});
