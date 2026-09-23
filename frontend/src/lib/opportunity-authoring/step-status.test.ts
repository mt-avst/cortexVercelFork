import { describe, expect, it } from 'vitest';
import {
  PUBLISHED_NOT_WORKING_LABEL,
  PUBLISHED_NOT_WORKING_PREFIX,
  PUBLISHED_NOT_WORKING_DESCRIPTION,
  STEP_STATUS_LABEL,
  describeStepPosition,
  deriveStepStatus,
  isPublishedButNotWorking,
  stepsHoldingErrors
} from './step-status';

/**
 * A stand-in for `locateField`, which lives on the page. Deliberately NOT a
 * copy of its rules: these tests are about what the stepper does with a
 * located error, and giving it real routing logic here would test the wrong
 * module and hide a change in the real one.
 */
const locate = (key: string) => ({ tab: Number(key.split(':')[0]) });

const derive = (overrides: Partial<Parameters<typeof deriveStepStatus>[0]> = {}) =>
  deriveStepStatus({
    stepId: 1,
    activeStepId: 99,
    visited: false,
    reportedErrorSteps: new Set<number>(),
    liveErrorSteps: new Set<number>(),
    ...overrides
  });

describe('stepsHoldingErrors', () => {
  it('collects every step an error routes to, not just the first', () => {
    // Three keys across two steps, and the step with two of them must not
    // swallow the other. A single-key fixture would pass with a `return` in
    // place of the loop.
    expect(
      stepsHoldingErrors({ '1:title': 'x', '1:purpose': 'y', '3:tasks': 'z' }, locate)
    ).toEqual(new Set([1, 3]));
  });

  it('is empty when there are no errors', () => {
    expect(stepsHoldingErrors({}, locate)).toEqual(new Set());
  });

  it('routes through the function it is given rather than reading the key', () => {
    // Pins that the located tab is what counts. Keyed '9:...' but located to
    // 2, so anything parsing the key itself reports 9 and fails here.
    expect(stepsHoldingErrors({ '9:thing': 'x' }, () => ({ tab: 2 }))).toEqual(new Set([2]));
  });
});

describe('deriveStepStatus', () => {
  it('reports a step nobody has been to as not started', () => {
    expect(derive()).toBe('notStarted');
  });

  it('reports a step nobody has been to as not started even when it would fail', () => {
    // The blank-form case, and the reason `visited` exists at all. A four-step
    // form must not open shouting about steps the author has not reached.
    expect(derive({ liveErrorSteps: new Set([1]) })).toBe('notStarted');
  });

  it('reports the step being looked at as current', () => {
    expect(derive({ activeStepId: 1 })).toBe('current');
  });

  it('reports a visited step with nothing wrong as completed', () => {
    expect(derive({ visited: true })).toBe('completed');
  });

  it('reports a step the author walked past leaving it invalid as needing attention', () => {
    expect(
      derive({ visited: true, liveErrorSteps: new Set([1]) })
    ).toBe('needsAttention');
  });

  it('reports a step already named in a refusal as needing attention, unvisited or not', () => {
    // A refused save names steps the author may never have opened - it
    // validates the whole form. Being told is enough.
    expect(derive({ reportedErrorSteps: new Set([1]) })).toBe('needsAttention');
  });

  it('keeps saying needs attention while the author stands on the failing step', () => {
    // The precedence that matters most: arriving at the step you were sent to
    // must not erase the reason you were sent there.
    expect(
      derive({ activeStepId: 1, reportedErrorSteps: new Set([1]) })
    ).toBe('needsAttention');
  });

  it('clears to current the moment the live rules stop failing, with no save', () => {
    // Same step, same visit, the only difference being that the error is gone
    // from both maps.
    expect(derive({ activeStepId: 1, visited: true })).toBe('current');
  });

  it('reads its own step, not another one', () => {
    // Both sets are populated - for a DIFFERENT step. A derivation that
    // ignored `stepId` and asked "is anything wrong anywhere" would report
    // needsAttention here.
    expect(
      derive({
        stepId: 2,
        activeStepId: 1,
        visited: false,
        reportedErrorSteps: new Set([1]),
        liveErrorSteps: new Set([1])
      })
    ).toBe('notStarted');
  });

  it('lets a visited step be completed while another step is failing', () => {
    // The twin of the test above, and the one that stops it passing for the
    // wrong reason: with `visited` true the answer changes to `completed`, so
    // the sets really are being read against `stepId` rather than ignored.
    expect(
      derive({
        stepId: 2,
        activeStepId: 1,
        visited: true,
        reportedErrorSteps: new Set([1]),
        liveErrorSteps: new Set([1])
      })
    ).toBe('completed');
  });

  it('a visited-but-invalid step is Needs attention, not Ready', () => {
    // Row 15: "Ready" (the intended word for the `completed` state - see the
    // note beside `STEP_STATUS_LABEL` on why the literal rename is deferred)
    // claims a step would survive a publish. A step the author walked past
    // leaving something invalid behind must never carry that claim, under
    // either word: the state machine below must resolve it to
    // `needsAttention`, never to the `completed` state "Ready" describes.
    const state = derive({ visited: true, liveErrorSteps: new Set([1]) });
    expect(state).toBe('needsAttention');
    expect(state).not.toBe('completed');
  });
});

describe('describeStepPosition', () => {
  it('counts from one and names the real total', () => {
    expect(describeStepPosition(2, 4)).toBe('Step 3 of 4');
  });

  it('says three of three for a form whose third step is its last', () => {
    // The variable step count is real: an external poll has three steps and an
    // unmoderated study has four, and the same index means different things.
    expect(describeStepPosition(2, 3)).toBe('Step 3 of 3');
  });

  it('says two of two for a form with no type chosen yet', () => {
    expect(describeStepPosition(1, 2)).toBe('Step 2 of 2');
  });
});

describe('STEP_STATUS_LABEL', () => {
  it('gives every state its own words', () => {
    const labels = Object.values(STEP_STATUS_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toHaveLength(4);
  });

});

describe('PUBLISHED_NOT_WORKING_LABEL', () => {
  it('is one fixed word, shared by every surface that shows it (row 6)', () => {
    expect(PUBLISHED_NOT_WORKING_LABEL).toBe('Broken');
  });

  it('keeps "published" for a screen reader and for hover (#157)', () => {
    expect(PUBLISHED_NOT_WORKING_PREFIX).toBe('Published, ');
    expect(PUBLISHED_NOT_WORKING_DESCRIPTION).toBe('Published, not working');
  });
});

describe('isPublishedButNotWorking', () => {
  const signal = (over: Partial<Parameters<typeof isPublishedButNotWorking>[1]> = {}) => ({
    type: 'test',
    hasLinkedStudy: false,
    externalLink: null,
    sessionCount: 1,
    meetingLocation: 'Zoom',
    ...over
  });

  it('is false for a draft, however broken its content is', () => {
    expect(isPublishedButNotWorking('draft', signal({ sessionCount: 0, meetingLocation: '' }))).toBe(false);
  });

  it('is true for a published moderated study with no venue', () => {
    expect(isPublishedButNotWorking('published', signal({ meetingLocation: '' }))).toBe(true);
  });

  it('is true for a published moderated study with no bookable slot', () => {
    expect(isPublishedButNotWorking('published', signal({ sessionCount: 0 }))).toBe(true);
  });

  it('is true for a published hand-off with no link and no linked study', () => {
    expect(
      isPublishedButNotWorking(
        'published',
        signal({ type: 'poll', deliveryMode: 'external', externalLink: '' })
      )
    ).toBe(true);
  });

  it('is false for a published hand-off with a usable link', () => {
    expect(
      isPublishedButNotWorking(
        'published',
        signal({ type: 'poll', deliveryMode: 'external', externalLink: 'https://example.com/s' })
      )
    ).toBe(false);
  });

  it('is false for a fully ready published moderated study', () => {
    expect(isPublishedButNotWorking('published', signal())).toBe(false);
  });

  it('does not claim a broken state for content it cannot count (the known dashboard gap)', () => {
    // A published native survey with zero questions cannot be detected from
    // this signal - there is no question count on it - so this stays false
    // rather than guessing. The per-study Review step still catches it.
    expect(
      isPublishedButNotWorking(
        'published',
        signal({ type: 'survey', deliveryMode: 'native', sessionCount: undefined, meetingLocation: undefined })
      )
    ).toBe(false);
  });
});
