import { describe, expect, it } from 'vitest';

import { remapAuthoringErrors } from './authoring-errors';
import { withClientId } from './client-ids';

/**
 * Per-question errors surviving a reorder.
 *
 * They are keyed by POSITION, because that is the only identity a question has
 * in the banner that lists them - so the form used to delete every one of them
 * on any change at all. Moving a question the author had not yet fixed silently
 * cleared the reason they were sent back to it, and the next save refused for
 * exactly the same thing.
 */
const question = (prompt: string, extra: Record<string, unknown> = {}) =>
  withClientId({ type: 'open_text', prompt, ...extra });

describe('remapAuthoringErrors', () => {
  it('follows a question to its new position', () => {
    const first = question('Which tool slows you down?');
    const second = question('What would you replace it with?');
    const third = question('How long have you used it?');
    const before = [first, second, third];

    const remapped = remapAuthoringErrors(
      { 'inline_survey_questions.2.prompt': 'Add what the participant is asked' },
      'inline_survey_questions',
      before,
      [third, first, second]
    );

    expect(remapped).toEqual({
      'inline_survey_questions.0.prompt': 'Add what the participant is asked'
    });
  });

  it('drops the error belonging to a removed question and keeps the others', () => {
    const first = question('Which tool slows you down?');
    const second = question('What would you replace it with?');
    const third = question('How long have you used it?');

    const remapped = remapAuthoringErrors(
      {
        'inline_survey_questions.0.prompt': 'First is wrong',
        'inline_survey_questions.1.prompt': 'Second is wrong',
        'inline_survey_questions.2.prompt': 'Third is wrong'
      },
      'inline_survey_questions',
      [first, second, third],
      [first, third]
    );

    expect(remapped).toEqual({
      'inline_survey_questions.0.prompt': 'First is wrong',
      'inline_survey_questions.1.prompt': 'Third is wrong'
    });
  });

  /**
   * An edited question has been acted on, so keeping its refusal would sit a
   * stale message beside a field the author has just corrected - which is what
   * the wholesale delete got right and is the reason it existed.
   */
  it('drops the error for a question the author has edited', () => {
    const first = question('Which tool slows you down?');
    const second = question('What would you replace it with?');

    const remapped = remapAuthoringErrors(
      {
        'inline_survey_questions.0.prompt': 'First is wrong',
        'inline_survey_questions.1.prompt': 'Second is wrong'
      },
      'inline_survey_questions',
      [first, second],
      [{ ...first, prompt: 'Which tool slows you down the most?' }, second]
    );

    expect(remapped).toEqual({
      'inline_survey_questions.1.prompt': 'Second is wrong'
    });
  });

  /**
   * Two objects with the same content can serialise differently when a spread
   * appends a key, and a naive comparison would read that as an edit and throw
   * the error away - the old behaviour, reintroduced by accident.
   */
  it('does not read a reordered key as an edit', () => {
    const first = withClientId({
      type: 'single_choice',
      prompt: 'Which delivery option would you pick?',
      options: ['Standard', 'Next day']
    });
    const reshuffled = {
      options: [...first.options],
      _clientId: first._clientId,
      prompt: first.prompt,
      type: first.type
    };

    expect(
      remapAuthoringErrors(
        { 'inline_survey_questions.0.options': 'A choice question needs two answers' },
        'inline_survey_questions',
        [first],
        [reshuffled]
      )
    ).toEqual({
      'inline_survey_questions.0.options': 'A choice question needs two answers'
    });
  });

  /**
   * Duplicate is the one operation that INSERTS mid-array, so every index below
   * the copy shifts by one. The copy is a new identity and carries no error of
   * its own; the original keeps the error it already had.
   */
  it('shifts the errors below a duplicated question', () => {
    const first = question('Which tool slows you down?');
    const second = question('What would you replace it with?');
    const third = question('How long have you used it?');
    const copyOfFirst = question('Which tool slows you down?');

    expect(
      remapAuthoringErrors(
        {
          'inline_survey_questions.0.prompt': 'First is wrong',
          'inline_survey_questions.2.prompt': 'Third is wrong'
        },
        'inline_survey_questions',
        [first, second, third],
        [first, copyOfFirst, second, third]
      )
    ).toEqual({
      'inline_survey_questions.0.prompt': 'First is wrong',
      'inline_survey_questions.3.prompt': 'Third is wrong'
    });
  });

  /**
   * `config` is rebuilt by spread when a rating scale is edited, so its key
   * order is not stable. A comparison that sorted only the top level would read
   * that as an edit and throw away an error the author has not fixed.
   */
  it('does not read a reordered NESTED key as an edit', () => {
    const rating = withClientId({
      type: 'rating',
      prompt: 'How happy are you with it?',
      config: { scale_max: 7, min_label: 'Not at all' }
    });
    const reshuffled = {
      ...rating,
      config: { min_label: 'Not at all', scale_max: 7 }
    };

    expect(
      remapAuthoringErrors(
        { 'inline_survey_questions.0.config': 'Give the scale between 2 and 10 points' },
        'inline_survey_questions',
        [rating],
        [reshuffled]
      )
    ).toEqual({
      'inline_survey_questions.0.config': 'Give the scale between 2 and 10 points'
    });
  });

  it('drops the list-level error and leaves unrelated keys alone', () => {
    const only = question('Which tool slows you down?');

    expect(
      remapAuthoringErrors(
        {
          inline_survey_questions: 'Add at least one question before publishing',
          title: 'Give this opportunity a title'
        },
        'inline_survey_questions',
        [only],
        [only]
      )
    ).toEqual({ title: 'Give this opportunity a title' });
  });

  /**
   * The two vocabularies share this function and their prefixes are different
   * strings, so a prefix match that was not anchored would let a task error
   * survive a question reorder under a task's index.
   */
  it('does not touch the other vocabulary keys', () => {
    const task = withClientId({ type: 'instruction', prompt: 'Open the basket' });

    expect(
      remapAuthoringErrors(
        { 'inline_study_steps.0.prompt': 'Add what the participant should see' },
        'inline_survey_questions',
        [task],
        [task]
      )
    ).toEqual({ 'inline_study_steps.0.prompt': 'Add what the participant should see' });
  });
});
