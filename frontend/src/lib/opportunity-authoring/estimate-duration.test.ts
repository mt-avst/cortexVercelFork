import { describe, expect, it } from 'vitest';

import { estimateRecordedMinutes, estimateSurveyMinutes } from './estimate-duration';

/**
 * The number a participant is told before they start.
 *
 * The field it replaces produced two outcomes and no third: left empty, so the
 * participant was told nothing, or filled with a guess made before the
 * questions were written. These pin the model rather than the arithmetic - a
 * changed weight should fail here and be re-decided, not drift.
 */
describe('estimateSurveyMinutes', () => {
  it('has nothing to estimate from an empty list', () => {
    expect(estimateSurveyMinutes([])).toBeNull();
  });

  /**
   * Deliberately not "1 minute". A minute against no questions is a number
   * nobody chose, which is the failure the whole control exists to stop.
   */
  it('costs a free-text answer more than a rating', () => {
    expect(estimateSurveyMinutes([{ type: 'open_text' }])).toBeGreaterThan(
      estimateSurveyMinutes([{ type: 'rating' }]) as number
    );
  });

  it('adds up the whole list, not just its length', () => {
    // 30s of consent, 60s of free text, 20s of single choice, 15s of rating:
    // 125 seconds, rounded up.
    expect(
      estimateSurveyMinutes([
        { type: 'open_text' },
        { type: 'single_choice' },
        { type: 'rating' }
      ])
    ).toBe(3);
  });

  /**
   * Three questions of identical type must not cost the same as one. A model
   * that read only the first item would pass the addition test above if the
   * types happened to be uniform.
   */
  it('grows with the number of questions of the same type', () => {
    expect(
      estimateSurveyMinutes([{ type: 'open_text' }, { type: 'open_text' }])
    ).toBeGreaterThan(estimateSurveyMinutes([{ type: 'open_text' }]) as number);
  });

  /**
   * Every weight, pinned individually.
   *
   * The file's own docstring claims these are pinned, and until this test they
   * were not: `Math.ceil(seconds / 60)` absorbs a change of up to a minute, so
   * a single question of each type reads the same at several different weights.
   * Four of a kind spreads them far enough apart to bite - `rating` at 25s
   * instead of 15s is 3 minutes here rather than 2.
   */
  it.each([
    ['instruction', 2],
    ['open_text', 5],
    ['single_choice', 2],
    ['multi_choice', 3],
    ['rating', 2],
    ['nps', 2],
    // Not a known type, so it costs what the most expensive one does. Compared
    // as a number rather than against `open_text`, because two weights that
    // differ by less than a minute compare equal after rounding and the
    // assertion would hold for a fallback anywhere in 31-60 seconds.
    ['something_new', 5]
  ])('costs four %s questions %i minutes', (type, minutes) => {
    expect(estimateSurveyMinutes(Array.from({ length: 4 }, () => ({ type })))).toBe(
      minutes
    );
  });

  /**
   * `estimated_duration_minutes` is bounded at 1440 by the contract, so an
   * estimate above it would be refused on save - a number the form produced
   * itself, rejected by the form's own API.
   *
   * The bound cannot be reached through the form: `INLINE_STUDY_LIMITS.maxSteps`
   * is 50, and fifty free-text questions is 51 minutes. So the clamp is a guard
   * against that limit moving, and both halves are asserted - the real ceiling
   * a legal list produces, and the clamp itself, reached by handing the
   * estimator a list longer than any list it will ever be given. Asserting only
   * the first is a test that cannot fail.
   */
  it('puts the largest list the contract accepts well under the bound', () => {
    const fifty = Array.from({ length: 50 }, () => ({ type: 'open_text' }));

    expect(estimateSurveyMinutes(fifty)).toBe(51);
  });

  it('clamps anything that would exceed what the contract will store', () => {
    const absurd = Array.from({ length: 5000 }, () => ({ type: 'open_text' }));

    expect(estimateSurveyMinutes(absurd)).toBe(1440);
    expect(
      estimateRecordedMinutes(Array.from({ length: 5000 }, () => ({ type: 'instruction' })))
    ).toBe(1440);
  });
});

describe('estimateRecordedMinutes', () => {
  it('has nothing to estimate from an empty task list', () => {
    expect(estimateRecordedMinutes([])).toBeNull();
  });

  it('charges for the setup as well as the tasks', () => {
    // Three minutes of consent, screen choice and opening the page, plus two
    // minutes a task. The setup is the part authors forget, because they never
    // do it themselves.
    expect(estimateRecordedMinutes([{ type: 'instruction' }])).toBe(5);
    expect(
      estimateRecordedMinutes([{ type: 'instruction' }, { type: 'instruction' }])
    ).toBe(7);
  });

  it('costs a recorded task more than a typed survey question', () => {
    expect(estimateRecordedMinutes([{ type: 'instruction' }])).toBeGreaterThan(
      estimateSurveyMinutes([{ type: 'open_text' }]) as number
    );
  });
});
