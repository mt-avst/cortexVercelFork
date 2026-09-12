import { describe, it, expect } from 'vitest';
import { computeBarChartAxis } from '../barChartAxis';

describe('computeBarChartAxis', () => {
  it('gives an integer axis with 2-3 gridlines for small counts', () => {
    const { niceMax, ticks } = computeBarChartAxis(3);
    expect(niceMax).toBe(3);
    expect(ticks).toEqual([0, 1, 2, 3]);
  });

  it('never produces a fractional tick for integer data', () => {
    for (const max of [1, 2, 3, 5, 8, 12, 27, 50, 99, 137, 1001]) {
      const { ticks } = computeBarChartAxis(max);
      for (const tick of ticks) {
        expect(Number.isInteger(tick)).toBe(true);
      }
    }
  });

  it('rounds the ceiling UP to a nice number at or above the data max', () => {
    expect(computeBarChartAxis(8).niceMax).toBe(10); // 8/3 -> step 5 -> 10
    expect(computeBarChartAxis(12).niceMax).toBe(15); // 12/3 -> step 5 -> 15
    expect(computeBarChartAxis(30).niceMax).toBe(30); // 30/3 -> step 10 -> 30
    expect(computeBarChartAxis(50).niceMax).toBe(60); // 50/3 -> step 20 -> 60
    expect(computeBarChartAxis(100).niceMax).toBe(100); // 100/3 -> step 50 -> 100
  });

  it('always includes 0 (the baseline) and niceMax (the top) in order', () => {
    for (const max of [1, 4, 9, 40, 250]) {
      const { niceMax, ticks } = computeBarChartAxis(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(niceMax);
      const sorted = [...ticks].sort((a, b) => a - b);
      expect(ticks).toEqual(sorted);
      expect(niceMax).toBeGreaterThanOrEqual(max);
    }
  });

  it('keeps a floor of 1 so an all-zero series still has a drawable axis', () => {
    const { niceMax, ticks } = computeBarChartAxis(0);
    expect(niceMax).toBe(1);
    expect(ticks).toEqual([0, 1]);
  });

  it('caps the gridline count so a large max stays legible', () => {
    for (const max of [3, 8, 30, 137, 4096]) {
      // baseline + at most three gridlines above it
      expect(computeBarChartAxis(max).ticks.length).toBeLessThanOrEqual(4);
    }
  });
});
