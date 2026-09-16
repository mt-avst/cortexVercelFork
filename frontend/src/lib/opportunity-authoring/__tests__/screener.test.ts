import { describe, expect, it } from 'vitest';

import {
  collectScreenerErrors,
  emptyScreenerQuestions,
  makeScreenerOption,
  makeScreenerQuestion,
  SCREENER_MESSAGE_KEY,
  SCREENER_QUESTIONS_KEY
} from '../screener';
import { withClientId, type WithClientId } from '../client-ids';
import {
  SCREENER_NEEDS_SCREEN_OUT,
  SCREENER_QUESTION_NEEDS_PASS
} from '@shared/screener';
import { VALIDATION } from '@shared/constants';
import type { ScreenerQuestion } from '@shared/types';

/**
 * The frontend screener factories and validator.
 *
 * The validator is asserted against the SAME message constants the shared zod
 * uses, because the whole point of `collectScreenerErrors` is that the authoring
 * UI refuses exactly what the server would refuse, in the same words - the two
 * agreeing is what stops an author saving a screener the API then rejects with a
 * message the form never showed.
 */

const q = (
  overrides: Partial<ScreenerQuestion> = {}
): WithClientId<ScreenerQuestion> =>
  withClientId({ ...makeScreenerQuestion(), ...overrides });

/** A question that passes every rule: a prompt, one qualify, one screen-out. */
const validQuestion = (): WithClientId<ScreenerQuestion> =>
  q({
    prompt: 'Which best describes your role?',
    options: [
      { id: 'a', label: 'Engineer', disqualifies: false },
      { id: 'b', label: 'Something else', disqualifies: true }
    ]
  });

describe('screener factories', () => {
  it('makeScreenerOption carries the qualify/screen-out flag and a distinct id', () => {
    const qualify = makeScreenerOption(false);
    const screenOut = makeScreenerOption(true);

    expect(qualify).toMatchObject({ label: '', disqualifies: false });
    expect(screenOut).toMatchObject({ label: '', disqualifies: true });
    expect(qualify.id).toBeTruthy();
    expect(qualify.id).not.toBe(screenOut.id);
  });

  it('makeScreenerQuestion seeds one qualify and one screen-out answer', () => {
    const question = makeScreenerQuestion();

    expect(question.prompt).toBe('');
    expect(question.options).toHaveLength(2);
    expect(question.options.map((o) => o.disqualifies)).toEqual([false, true]);
    // Distinct question and option ids, so a screener built from these seeds
    // never trips the shared duplicate-id refinements.
    const optionIds = question.options.map((o) => o.id);
    expect(new Set(optionIds).size).toBe(2);
  });

  it('emptyScreenerQuestions returns one starter question with a client id', () => {
    const questions = emptyScreenerQuestions();

    expect(questions).toHaveLength(1);
    expect(questions[0]._clientId).toBeTruthy();
    expect(questions[0].options).toHaveLength(2);
  });
});

describe('collectScreenerErrors - nothing to validate', () => {
  it('returns no errors when the study has no screener, whatever the fields hold', () => {
    // A half-built screener left behind after "Remove screener" must not block a
    // save: the payload sends no screener at all, so there is nothing to refuse.
    const errors = collectScreenerErrors({
      hasScreener: false,
      questions: [q({ prompt: '', options: [] as never })],
      message: 'x'.repeat(VALIDATION.SCREENER_MAX_MESSAGE_CHARS + 5)
    });

    expect(errors).toEqual({});
  });

  it('accepts a well-formed screener', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [validQuestion()],
      message: ''
    });

    expect(errors).toEqual({});
  });
});

describe('collectScreenerErrors - shape', () => {
  it('needs at least one question', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [],
      message: ''
    });

    expect(errors[SCREENER_QUESTIONS_KEY]).toBeDefined();
  });

  it('refuses more than the maximum number of questions', () => {
    const questions = Array.from(
      { length: VALIDATION.SCREENER_MAX_QUESTIONS + 1 },
      validQuestion
    );

    const errors = collectScreenerErrors({
      hasScreener: true,
      questions,
      message: ''
    });

    expect(errors[SCREENER_QUESTIONS_KEY]).toContain(
      String(VALIDATION.SCREENER_MAX_QUESTIONS)
    );
  });

  it('flags a question with no wording', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [q({ prompt: '   ', options: validQuestion().options })],
      message: ''
    });

    expect(errors['screener_questions.0.prompt']).toBeDefined();
  });

  it('flags a question whose wording is too long', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [
        q({
          prompt: 'x'.repeat(VALIDATION.SCREENER_MAX_PROMPT_CHARS + 1),
          options: validQuestion().options
        })
      ],
      message: ''
    });

    expect(errors['screener_questions.0.prompt']).toContain(
      String(VALIDATION.SCREENER_MAX_PROMPT_CHARS)
    );
  });

  it('flags an answer with no label', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [
        q({
          prompt: 'Role?',
          options: [
            { id: 'a', label: 'Engineer', disqualifies: false },
            { id: 'b', label: '  ', disqualifies: true }
          ]
        })
      ],
      message: ''
    });

    expect(errors['screener_questions.0.options.1.label']).toBeDefined();
  });

  it('flags an answer whose label is too long', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [
        q({
          prompt: 'Role?',
          options: [
            {
              id: 'a',
              label: 'x'.repeat(VALIDATION.SCREENER_MAX_OPTION_LABEL_CHARS + 1),
              disqualifies: false
            },
            { id: 'b', label: 'No', disqualifies: true }
          ]
        })
      ],
      message: ''
    });

    expect(errors['screener_questions.0.options.0.label']).toContain(
      String(VALIDATION.SCREENER_MAX_OPTION_LABEL_CHARS)
    );
  });

  it('needs at least two answers per question', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [
        q({
          prompt: 'Role?',
          options: [{ id: 'a', label: 'Only one', disqualifies: false }]
        })
      ],
      message: ''
    });

    expect(errors['screener_questions.0.options']).toBeDefined();
  });

  it('refuses more than the maximum number of answers', () => {
    const options = Array.from(
      { length: VALIDATION.SCREENER_MAX_OPTIONS + 1 },
      (_unused, index) => ({
        id: `o${index}`,
        label: `Answer ${index}`,
        disqualifies: index === 0
      })
    );

    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [q({ prompt: 'Role?', options })],
      message: ''
    });

    expect(errors['screener_questions.0.options']).toContain(
      String(VALIDATION.SCREENER_MAX_OPTIONS)
    );
  });
});

describe('collectScreenerErrors - the two semantic rules, in the shared words', () => {
  it('every question needs a qualifying answer (verbatim shared message)', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [
        q({
          prompt: 'Role?',
          options: [
            { id: 'a', label: 'Sales', disqualifies: true },
            { id: 'b', label: 'Marketing', disqualifies: true }
          ]
        })
      ],
      message: ''
    });

    expect(errors['screener_questions.0.options']).toBe(
      SCREENER_QUESTION_NEEDS_PASS
    );
  });

  it('the screener as a whole needs a screen-out answer (verbatim shared message)', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [
        q({
          prompt: 'Role?',
          options: [
            { id: 'a', label: 'Engineer', disqualifies: false },
            { id: 'b', label: 'Designer', disqualifies: false }
          ]
        })
      ],
      message: ''
    });

    expect(errors[SCREENER_QUESTIONS_KEY]).toBe(SCREENER_NEEDS_SCREEN_OUT);
  });

  it('does not raise the needs-screen-out rule while a question is still empty', () => {
    // A freshly enabled screener is invalid for a more basic reason (an empty
    // prompt), and reporting "needs a screen-out answer" over the top of that is
    // noise about a screener the author has not finished describing.
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [makeScreenerQuestion()].map((question) => withClientId(question)),
      message: ''
    });

    expect(errors[SCREENER_QUESTIONS_KEY]).toBeUndefined();
    expect(errors['screener_questions.0.prompt']).toBeDefined();
  });
});

describe('collectScreenerErrors - the not-a-match message', () => {
  it('flags a message that exceeds the cap', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [validQuestion()],
      message: 'x'.repeat(VALIDATION.SCREENER_MAX_MESSAGE_CHARS + 1)
    });

    expect(errors[SCREENER_MESSAGE_KEY]).toContain(
      String(VALIDATION.SCREENER_MAX_MESSAGE_CHARS)
    );
  });

  it('accepts an empty message - it is optional', () => {
    const errors = collectScreenerErrors({
      hasScreener: true,
      questions: [validQuestion()],
      message: ''
    });

    expect(errors[SCREENER_MESSAGE_KEY]).toBeUndefined();
  });
});
