import { describe, it, expect } from 'vitest';

import { getActionMeaning, getParticipantActionLabel } from '../opportunityUtils';
import { OPPORTUNITY_TYPES } from '../../shared/constants';

// The analytics card counting "actions" described them as "Clicked link /
// Booked" for every study. A recorded study has no link to click and nothing to
// book - its action is the participant pressing Start - so the one card telling
// a researcher how many people began their study described something that
// cannot happen in it.

describe('getActionMeaning', () => {
  it('describes what an action is for each type a study can be', () => {
    expect(getActionMeaning('unmoderated')).toBe('Started the study');
    expect(getActionMeaning('test')).toBe('Booked a time');
    expect(getActionMeaning('interview')).toBe('Booked a time');
    expect(getActionMeaning('poll')).toBe('Opened the poll');
    expect(getActionMeaning('survey')).toBe('Opened the survey');
    expect(getActionMeaning('question')).toBe('Answered');
  });

  it('never tells a recorded study it was a link or a booking', () => {
    expect(getActionMeaning('unmoderated')).not.toMatch(/link|book/i);
  });

  it('says something for every type, so a new one cannot fall through to nothing', () => {
    for (const type of Object.values(OPPORTUNITY_TYPES)) {
      const meaning = getActionMeaning(type);
      expect(meaning, `no action meaning for "${type}"`).toBeTruthy();
      // The generic fallback is for values that are not types at all.
      expect(meaning, `"${type}" fell through to the fallback`).not.toBe('Took part');
    }
  });

  it('falls back neutrally rather than exposing an unrecognised value', () => {
    expect(getActionMeaning('wat')).toBe('Took part');
    expect(getActionMeaning(null)).toBe('Took part');
    expect(getActionMeaning(undefined)).toBe('Took part');
  });

  it('tolerates a type concatenated with a status, as its sibling does', () => {
    expect(getActionMeaning('unmoderatedpublished')).toBe('Started the study');
    expect(getParticipantActionLabel('unmoderatedpublished')).toBe('Start recorded study');
  });
});
