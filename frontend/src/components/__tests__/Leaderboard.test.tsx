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
