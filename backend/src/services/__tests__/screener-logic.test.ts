import {
  evaluateScreener,
  parseScreenerAnswers,
  redactScreenerForParticipant,
  SCREENER_ANSWERS_MALFORMED,
  SCREENER_ANSWER_INVALID,
} from '../../../../shared/screener';
import type { Screener } from '../../../../shared/types';
import { hasScreener } from '../screener';

const screener: Screener = {
  questions: [
    {
      id: 'role',
      prompt: 'Which best describes your role?',
      options: [
        { id: 'eng', label: 'Engineer', disqualifies: false },
        { id: 'sales', label: 'Sales', disqualifies: true },
      ],
    },
    {
      id: 'recent',
      prompt: 'Worked on checkout recently?',
      options: [
        { id: 'yes', label: 'Yes', disqualifies: false },
        { id: 'no', label: 'No', disqualifies: true },
      ],
    },
  ],
  screenedOutMessage: 'Not a match this time',
};

describe('evaluateScreener', () => {
  it('qualifies when every chosen answer qualifies', () => {
    expect(evaluateScreener(screener, { role: 'eng', recent: 'yes' })).toBe('qualified');
  });

  it('screens out when any chosen answer disqualifies', () => {
    expect(evaluateScreener(screener, { role: 'eng', recent: 'no' })).toBe('screened_out');
    expect(evaluateScreener(screener, { role: 'sales', recent: 'yes' })).toBe('screened_out');
  });

  it('fails closed: an incomplete or unknown answer is a screen-out, never a silent qualify', () => {
    expect(evaluateScreener(screener, { role: 'eng' })).toBe('screened_out');
    expect(evaluateScreener(screener, { role: 'eng', recent: 'nope' })).toBe('screened_out');
    expect(evaluateScreener(screener, {})).toBe('screened_out');
  });
});

describe('parseScreenerAnswers', () => {
  it('accepts a complete valid submission and normalises to the screener questions', () => {
    const result = parseScreenerAnswers(screener, { role: 'eng', recent: 'yes', extra: 'ignored' });
    expect(result).toEqual({ ok: true, answers: { role: 'eng', recent: 'yes' } });
  });

  it('rejects a missing question', () => {
    expect(parseScreenerAnswers(screener, { role: 'eng' })).toEqual({
      ok: false,
      message: SCREENER_ANSWER_INVALID,
    });
  });

  it('rejects an option id that does not belong to its question', () => {
    expect(parseScreenerAnswers(screener, { role: 'yes', recent: 'yes' })).toEqual({
      ok: false,
      message: SCREENER_ANSWER_INVALID,
    });
  });

  it('rejects a non-object body', () => {
    expect(parseScreenerAnswers(screener, null).ok).toBe(false);
    expect(parseScreenerAnswers(screener, [] as unknown).ok).toBe(false);
    expect(parseScreenerAnswers(screener, 'x' as unknown)).toEqual({
      ok: false,
      message: SCREENER_ANSWERS_MALFORMED,
    });
  });
});

describe('redactScreenerForParticipant', () => {
  it('strips the owner-only disqualifies flag from every option', () => {
    const redacted = redactScreenerForParticipant(screener);
    const flattened = JSON.stringify(redacted);
    expect(flattened).not.toContain('disqualifies');
    for (const question of redacted.questions) {
      for (const option of question.options) {
        expect(option).toEqual({ id: option.id, label: option.label });
      }
    }
  });

  it('keeps the prompts, labels and screened-out message', () => {
    const redacted = redactScreenerForParticipant(screener);
    expect(redacted.questions[0].prompt).toBe('Which best describes your role?');
    expect(redacted.questions[0].options[0]).toEqual({ id: 'eng', label: 'Engineer' });
    expect(redacted.screenedOutMessage).toBe('Not a match this time');
  });
});

describe('hasScreener', () => {
  it('is true only for a screener with at least one question', () => {
    expect(hasScreener(screener)).toBe(true);
    expect(hasScreener(null)).toBe(false);
    expect(hasScreener(undefined)).toBe(false);
    expect(hasScreener({ questions: [] })).toBe(false);
  });
});
