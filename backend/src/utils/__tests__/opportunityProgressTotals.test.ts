import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('../../config', () => ({
  pool: { query: jest.fn() },
}));

import { pool } from '../../config';
import {
  loadOpportunityProgressTotals,
  mockOpportunityProgressTotals,
} from '../opportunityProgressTotals';

const mockQuery = pool.query as unknown as jest.Mock;

/**
 * The pure halves of the all-time progress totals. Which rows the SQL counts is
 * proved against a real database in
 * `routes/__tests__/opportunities.list-progress-totals-postgres.test.ts`; this
 * file pins what happens around the query.
 */
describe('loadOpportunityProgressTotals', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('asks the database nothing for an empty id list', async () => {
    const totals = await loadOpportunityProgressTotals([]);

    expect(totals.size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keys each row by its opportunity id and coerces the counts to numbers', async () => {
    // pg can hand back a bigint aggregate as a string; the wire must carry a number.
    mockQuery.mockResolvedValue({
      rows: [{ opportunity_id: 'opp-a', total_booked: '2', total_capacity: '4' }],
    } as never);

    const totals = await loadOpportunityProgressTotals(['opp-a', 'opp-b']);

    expect(totals.get('opp-a')).toEqual({ total_booked: 2, total_capacity: 4 });
    // An id the query returned nothing for (no sessions) is ABSENT, not 0/0.
    expect(totals.has('opp-b')).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect((mockQuery.mock.calls[0] as unknown[])[1]).toEqual([['opp-a', 'opp-b']]);
  });

  it('propagates a read failure so the caller can decide how to degrade', async () => {
    mockQuery.mockRejectedValue(new Error('boom') as never);

    await expect(loadOpportunityProgressTotals(['opp-a'])).rejects.toThrow('boom');
  });
});

describe('mockOpportunityProgressTotals', () => {
  it('sums booked_count and capacity across every session', () => {
    expect(
      mockOpportunityProgressTotals([
        { capacity: 4, booked_count: 2 },
        { capacity: 3, booked_count: 1 },
      ])
    ).toEqual({ total_booked: 3, total_capacity: 7 });
  });

  it.each([
    ['an empty array', []],
    ['undefined', undefined],
    ['a non-array', { capacity: 4 }],
  ])('is undefined for %s, matching the database path absence', (_label, sessions) => {
    expect(mockOpportunityProgressTotals(sessions)).toBeUndefined();
  });

  it('counts a missing or non-numeric field as zero rather than NaN', () => {
    expect(
      mockOpportunityProgressTotals([
        { capacity: 5 },
        { capacity: 'five', booked_count: Number.NaN },
        null,
      ])
    ).toEqual({ total_booked: 0, total_capacity: 5 });
  });
});
