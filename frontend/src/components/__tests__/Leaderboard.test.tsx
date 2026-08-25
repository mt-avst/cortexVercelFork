import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Leaderboard from '../Leaderboard';
import { gamificationApi } from '../../api/gamification';

// The loader used to be a plain function rebuilt on every render, and the
// effect that calls it listed only [limit]. Naming a function like that in a
// dependency array - which is what the hooks rule asks for - re-runs the effect
// on every render, and since the loader sets state, that render loops forever.
// The fix was to memoise the loader first.
//
// This is the guard for that: an infinite loop shows up here as an unbounded
// call count, so the assertion is on how many times the API is hit, not on
// what is rendered.
vi.mock('../../api/gamification', () => ({
  gamificationApi: {
    getLeaderboard: vi.fn().mockResolvedValue([]),
    getMonthlyLeaderboard: vi.fn().mockResolvedValue([]),
  },
  gamificationUtils: {
    getRankDisplay: (rank: number) => `#${rank}`,
    formatPoints: (points: number) => String(points),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Leaderboard - effect stability', () => {
  it('loads once on mount and does not re-enter', async () => {
    render(<Leaderboard />);

    // Settle every pending promise and any renders they cause.
    await vi.waitFor(() => {
      expect(vi.mocked(gamificationApi.getLeaderboard)).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(gamificationApi.getLeaderboard)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gamificationApi.getMonthlyLeaderboard)).toHaveBeenCalledTimes(1);
  });

  it('reloads exactly once when the limit changes, and settles again', async () => {
    // Proves the memoisation did not over-correct into never reloading: the
    // loader is keyed on `limit`, so a new limit must fetch again - once.
    const { rerender } = render(<Leaderboard limit={10} />);
    await vi.waitFor(() => {
      expect(vi.mocked(gamificationApi.getLeaderboard)).toHaveBeenCalledTimes(1);
    });

    rerender(<Leaderboard limit={25} />);
    await vi.waitFor(() => {
      expect(vi.mocked(gamificationApi.getLeaderboard)).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(gamificationApi.getLeaderboard)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(gamificationApi.getLeaderboard)).toHaveBeenLastCalledWith(25);
  });

  it('does not refetch when re-rendered with the same limit', async () => {
    const { rerender } = render(<Leaderboard limit={10} />);
    await vi.waitFor(() => {
      expect(vi.mocked(gamificationApi.getLeaderboard)).toHaveBeenCalledTimes(1);
    });

    rerender(<Leaderboard limit={10} />);
    rerender(<Leaderboard limit={10} />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(gamificationApi.getLeaderboard)).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE ROW KEY, which cto/AdaptaLabs#17 changed from `entry.user_id` to
 * `entry.rank` because the id is no longer published - and which nothing above
 * can see, because every test in this file resolves the boards to `[]` and so
 * renders NO ROWS AT ALL. A gate mutated the key to the constant `"dup"` and all
 * three passed. A test that cannot see the thing it guards is #20's subject.
 *
 * TIED POINTS ARE THE CASE THAT MATTERS. Both queries rank with `ROW_NUMBER()`
 * rather than `RANK()` or `DENSE_RANK()`, so three participants on identical
 * totals still get 1, 2, 3 - which is exactly what makes `rank` usable as a key
 * and exactly what a switch to `RANK()` would break. The fixture is therefore
 * all-equal points, not distinct ones.
 *
 * THE OBSERVABLE IS REACT'S OWN WARNING, on `console.error`. Duplicate keys do
 * not change what renders on a first mount, so a row count cannot see them; the
 * reconciler's complaint is the only signal there is. Asserted by name below,
 * with a control proving the spy can still catch it.
 */
const TIED_ROWS = [
  { name: 'Ada', total_points: 40, monthly_points: 40, level: 2, rank: 1 },
  { name: 'Grace', total_points: 40, monthly_points: 40, level: 2, rank: 2 },
  { name: 'Alan', total_points: 40, monthly_points: 40, level: 2, rank: 3 },
];

/** Everything React wrote to console.error during a render, as one string. */
const complaints = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');

describe('Leaderboard - row identity', () => {
  it('gives rows on tied points distinct keys', async () => {
    vi.mocked(gamificationApi.getLeaderboard).mockResolvedValue(TIED_ROWS);
    vi.mocked(gamificationApi.getMonthlyLeaderboard).mockResolvedValue(TIED_ROWS);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { container } = render(<Leaderboard />);

      // Bounded by waitFor: three rows must actually RENDER, or the key
      // assertion below is passing over an empty list - which is precisely how
      // this gap got here.
      await vi.waitFor(() => {
        expect(container.querySelectorAll('.leaderboard-row')).toHaveLength(3);
      });

      expect(complaints(consoleError)).not.toContain('same key');
    } finally {
      consoleError.mockRestore();
    }
  });

  // THE CONTROL. `not.toContain('same key')` passes just as well against a spy
  // that never sees anything - a warning React stopped emitting, a dev-only
  // check compiled out, a spy attached to the wrong channel. So the same spy and
  // the same matcher are shown catching the duplicate they are looking for.
  it('would notice two rows sharing a key', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(
        <div>
          {TIED_ROWS.map((row) => (
            <div key="dup">{row.name}</div>
          ))}
        </div>
      );

      expect(complaints(consoleError)).toContain('same key');
    } finally {
      consoleError.mockRestore();
    }
  });
});
