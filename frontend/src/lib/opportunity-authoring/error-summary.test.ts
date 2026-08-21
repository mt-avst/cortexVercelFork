import { describe, it, expect } from 'vitest';

import {
  buildErrorSummary,
  errorsForStep,
  firstStepHoldingError,
  POSITION_PLACEHOLDER,
  positionOf,
  replaceStepErrors,
  resolveMessage
} from './error-summary';

/**
 * A stand-in for the page's `locateField`.
 *
 * Deliberately NOT the real one. These are the rules about ORDERING, SCOPING
 * and MERGING, and wiring the real map in would make every test here also a
 * test of that map - so a change to which step renders `external_link_optional`
 * would redden tests that are not about it. The real map has its own
 * completeness test in `OpportunityForm.test.tsx`.
 *
 * Ids are deliberately SPARSE (1, 2, 4) rather than 1, 2, 3. On a dense shape
 * every "step id" is also its position, so a mutation swapping one for the
 * other changes nothing observable and a passing test proves neither.
 */
const STEPS: Record<string, number> = {
  type: 1,
  title: 1,
  purpose_one_liner: 1,
  participant_type_required: 2,
  inline_survey_questions: 4,
  external_link_optional: 4
};

const locate = (key: string): { tab: number } => {
  if (/^inline_survey_questions\.\d+\./.test(key)) {
    return { tab: 4 };
  }
  return { tab: STEPS[key] ?? 1 };
};

const noControls = () => undefined;

/**
 * A field order that DISAGREES with step order, on purpose.
 *
 * `Object.keys(STEPS)` happens to run in step order, so with it as the order
 * array the step comparison and the field comparison produce the same list -
 * and deleting the step comparison altogether changed nothing observable. A
 * mutation that survives because the fixture cannot tell two rules apart is a
 * fixture bug, not a passing test.
 */
const ORDER_AGAINST_THE_STEPS = [
  'external_link_optional',
  'inline_survey_questions',
  'participant_type_required',
  'purpose_one_liner',
  'title',
  'type'
];

describe('buildErrorSummary', () => {
  it('lists problems in step order, so the author works forwards', () => {
    const entries = buildErrorSummary({
      errors: {
        external_link_optional: 'Enter the link participants will follow to take part',
        title: 'Enter a title',
        participant_type_required: 'Choose who can take part'
      },
      locate,
      resolveControl: noControls,
      order: ORDER_AGAINST_THE_STEPS
    });

    // Step 4 was inserted first. Reading it out first would send the author to
    // the last failure and back.
    //
    // The order array runs BACKWARDS relative to the steps, so this list can
    // only come out this way if the step comparison ran: field order alone
    // would give exactly the reverse.
    expect(entries.map((entry) => entry.key)).toEqual([
      'title',
      'participant_type_required',
      'external_link_optional'
    ]);
    expect(entries.map((entry) => entry.stepId)).toEqual([1, 2, 4]);
  });

  it('orders fields WITHIN a step by where they sit on it, not by insertion', () => {
    const entries = buildErrorSummary({
      errors: {
        purpose_one_liner: 'Enter a purpose',
        type: 'Choose a research study type',
        title: 'Enter a title'
      },
      locate,
      resolveControl: noControls,
      order: Object.keys(STEPS)
    });

    expect(entries.map((entry) => entry.key)).toEqual([
      'type',
      'title',
      'purpose_one_liner'
    ]);
  });

  it('orders per-item problems by item, not by string', () => {
    // The trap this exists for: '10' sorts before '2' as a string, so a summary
    // of eleven empty questions read 1, 10, 11, 2, 3 - which is unusable as the
    // list the author works down.
    //
    // Inserted SCRAMBLED, and that matters: `Array.prototype.sort` is stable,
    // so with the keys already in ascending order a comparator that ignored the
    // index entirely produced the right list anyway and could not be caught.
    const errors: Record<string, string> = {};
    [10, 2, 11, 1, 9].forEach((index) => {
      errors[`inline_survey_questions.${index}.prompt`] = `Enter the text for question ${index + 1}`;
    });

    const entries = buildErrorSummary({
      errors,
      locate,
      resolveControl: noControls,
      order: Object.keys(STEPS)
    });

    expect(entries.map((entry) => entry.key)).toEqual([
      'inline_survey_questions.1.prompt',
      'inline_survey_questions.2.prompt',
      'inline_survey_questions.9.prompt',
      'inline_survey_questions.10.prompt',
      'inline_survey_questions.11.prompt'
    ]);
  });

  it('carries the validator message through unchanged', () => {
    // The entry is not allowed to paraphrase. If it did, the summary and the
    // field would be two vocabularies again, which is the thing D1 deleted.
    const [entry] = buildErrorSummary({
      errors: { title: 'Enter a title of at least 4 characters' },
      locate,
      resolveControl: noControls,
      order: Object.keys(STEPS)
    });
    expect(entry.message).toBe('Enter a title of at least 4 characters');
  });

  it('carries the control id the resolver gives it', () => {
    const [entry] = buildErrorSummary({
      errors: { title: 'Enter a title' },
      locate,
      resolveControl: (key) => (key === 'title' ? 'title' : undefined),
      order: Object.keys(STEPS)
    });
    expect(entry.controlId).toBe('title');
  });

  it('sorts an unmapped key LAST rather than first', () => {
    // It still appears - a rule nobody has mapped must not vanish from the list
    // the author reads - but it does not take the top slot from a real one.
    const entries = buildErrorSummary({
      errors: {
        some_future_field: 'Something new went wrong',
        title: 'Enter a title'
      },
      locate,
      resolveControl: noControls,
      order: Object.keys(STEPS)
    });
    expect(entries.map((entry) => entry.key)).toEqual(['title', 'some_future_field']);
  });

  it('is empty when nothing is wrong', () => {
    expect(
      buildErrorSummary({
        errors: {},
        locate,
        resolveControl: noControls,
        order: Object.keys(STEPS)
      })
    ).toEqual([]);
  });
});

describe('firstStepHoldingError', () => {
  it('returns the earliest step, not the first key inserted', () => {
    expect(
      firstStepHoldingError(
        { external_link_optional: 'x', title: 'y' },
        locate
      )
    ).toBe(1);
  });

  it('returns the only step when there is one', () => {
    expect(firstStepHoldingError({ external_link_optional: 'x' }, locate)).toBe(4);
  });

  it('returns null when there is nothing to report', () => {
    expect(firstStepHoldingError({}, locate)).toBeNull();
  });
});

describe('errorsForStep', () => {
  it('keeps only what the step the author is standing on can answer for', () => {
    expect(
      errorsForStep(
        {
          title: 'Enter a title',
          participant_type_required: 'Choose who can take part',
          external_link_optional: 'Enter the link'
        },
        2,
        locate
      )
    ).toEqual({ participant_type_required: 'Choose who can take part' });
  });

  it('keeps `type` in scope on EVERY step', () => {
    // Not an arbitrary exception: the type decides which steps exist at all, so
    // continuing without it is continuing to a step the form cannot name. This
    // used to be a hand-written guard on step 2 only.
    expect(
      errorsForStep({ type: 'Choose a research study type' }, 4, locate)
    ).toEqual({ type: 'Choose a research study type' });
  });

  it('keeps a per-item key on the step that renders the list', () => {
    expect(
      errorsForStep(
        { 'inline_survey_questions.2.prompt': 'Enter the text for question 3' },
        4,
        locate
      )
    ).toEqual({ 'inline_survey_questions.2.prompt': 'Enter the text for question 3' });
  });

  it('is empty when this step holds nothing', () => {
    expect(errorsForStep({ external_link_optional: 'x' }, 2, locate)).toEqual({});
  });
});

describe('replaceStepErrors', () => {
  it('leaves other steps exactly as they were reported', () => {
    // The deleted Continue validator wrote its own narrow object wholesale,
    // which erased what every other step had already been told about - and the
    // stepper reads this map to decide which steps say "Needs attention".
    expect(
      replaceStepErrors(
        { external_link_optional: 'Enter the link', title: 'Enter a title' },
        { participant_type_required: 'Choose who can take part' },
        2,
        locate
      )
    ).toEqual({
      external_link_optional: 'Enter the link',
      title: 'Enter a title',
      participant_type_required: 'Choose who can take part'
    });
  });

  it('drops a key on THIS step that has since been fixed', () => {
    // Merging is not right either: a corrected field has to stop saying
    // "Needs attention", and only this step's slice is allowed to move.
    expect(
      replaceStepErrors(
        { title: 'Enter a title', external_link_optional: 'Enter the link' },
        {},
        1,
        locate
      )
    ).toEqual({ external_link_optional: 'Enter the link' });
  });

  it('invents nothing about a step the author has not reached', () => {
    // Step 4's problem is real, but it is not this step's to report: the
    // stepper paints a REPORTED error as "Needs attention" whether or not the
    // step has been visited, so writing it here would flag a step the author
    // has never seen.
    expect(
      replaceStepErrors(
        {},
        {
          title: 'Enter a title',
          external_link_optional: 'Enter the link'
        },
        1,
        locate
      )
    ).toEqual({ title: 'Enter a title' });
  });

  it('moves `type` with whichever step is being replaced', () => {
    // `type` is in scope on every step, so a step that has just refused over it
    // must be able to clear it too.
    expect(
      replaceStepErrors({ type: 'Choose a research study type' }, {}, 2, locate)
    ).toEqual({});
  });
});

describe('the live position of a per-item message', () => {
  it('reads the position off the key, 1-based', () => {
    expect(positionOf('inline_survey_questions.0.prompt')).toBe(1);
    expect(positionOf('inline_survey_questions.9.options')).toBe(10);
    expect(positionOf('inline_study_steps.2.prompt')).toBe(3);
  });

  it('has no position for a plain field key', () => {
    expect(positionOf('title')).toBeNull();
  });

  it('substitutes the placeholder from the key, not from when the rule ran', () => {
    // The whole point: the stored sentence never holds a number, so a reorder
    // that rewrites the key rewrites what the author reads.
    const stored = `Enter the text for question ${POSITION_PLACEHOLDER}`;
    expect(resolveMessage('inline_survey_questions.0.prompt', stored)).toBe(
      'Enter the text for question 1'
    );
    // Same stored string, moved item, different sentence.
    expect(resolveMessage('inline_survey_questions.4.prompt', stored)).toBe(
      'Enter the text for question 5'
    );
  });

  it('leaves a message with no placeholder exactly as it is', () => {
    expect(resolveMessage('title', 'Enter a title')).toBe('Enter a title');
    // Including one that is per-item but not numbered.
    expect(
      resolveMessage('inline_survey_questions.3.prompt', 'Something ungeneric')
    ).toBe('Something ungeneric');
  });

  it('leaves the placeholder alone when the key carries no position', () => {
    // Better a visible `{n}` than a wrong number: a placeholder that survives
    // to the screen is a bug someone reports, and a silently wrong ordinal is
    // one nobody does.
    const stored = `Enter the text for question ${POSITION_PLACEHOLDER}`;
    expect(resolveMessage('title', stored)).toBe(stored);
  });

  it('resolves through buildErrorSummary, so the summary never shows a stale number', () => {
    const [entry] = buildErrorSummary({
      errors: {
        'inline_survey_questions.2.prompt': `Enter the text for question ${POSITION_PLACEHOLDER}`
      },
      locate,
      resolveControl: noControls,
      order: Object.keys(STEPS)
    });
    expect(entry.message).toBe('Enter the text for question 3');
  });
});
