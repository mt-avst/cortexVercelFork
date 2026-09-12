/**
 * Axis scale for the inline analytics BarChart.
 *
 * The chart drew bars against the raw maximum of its own data, with no y-axis,
 * no ticks and no baseline - so a bar was tall or short only relative to its
 * neighbours, and a reader could not read a value off it without the per-bar
 * label. This picks a "nice" ceiling (a round number at or above the data max)
 * and a small set of evenly-spaced ticks from zero to that ceiling, so the
 * chart can draw 2-3 gridlines with value labels and bars that sit at a
 * readable fraction of a stated scale.
 *
 * Kept pure so the nice-number arithmetic is pinned by a test rather than
 * eyeballed against a rendered chart.
 */

export interface BarChartAxis {
  /** The rounded ceiling bars are scaled against (>= the data max, >= 1). */
  niceMax: number;
  /** Ascending tick values from 0 to niceMax inclusive (baseline + gridlines). */
  ticks: number[];
}

/**
 * Round a rough step up to a "nice" number - 1, 2, 5 or 10 times a power of
 * ten. Click counts are integers, so for any step at or above 1 the result is
 * itself an integer, which keeps the ticks whole rather than printing 2.5 of a
 * thing that cannot be halved.
 */
const niceStep = (rough: number): number => {
  if (!(rough > 0)) return 1;
  const exponent = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exponent);
  const fraction = rough / base; // in [1, 10)
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * base;
};

/**
 * @param rawMax the largest value in the series (or an explicit ceiling)
 * @param targetIntervals how many gaps to aim for between baseline and top;
 *   3 yields roughly 2-3 gridlines above the baseline for typical counts
 */
export const computeBarChartAxis = (
  rawMax: number,
  targetIntervals = 3
): BarChartAxis => {
  const max = Math.max(rawMax, 1);
  // Floored at 1: the chart only ever plots integer click counts, so a step
  // below 1 (which a max of 1-2 would otherwise produce) would print ticks
  // like 0.5 of a thing that cannot be halved.
  const step = Math.max(niceStep(max / targetIntervals), 1);
  const niceMax = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  // A half-step of slack absorbs floating-point drift so the top tick is not
  // dropped when niceMax is an exact multiple of step.
  for (let tick = 0; tick <= niceMax + step / 2; tick += step) {
    ticks.push(Math.round(tick * 1000) / 1000);
  }

  return { niceMax, ticks };
};
