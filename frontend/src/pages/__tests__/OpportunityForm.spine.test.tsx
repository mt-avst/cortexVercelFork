import { describe, it, expect } from 'vitest';

import { getTabsForType, REVIEW_STEP_ID } from '../OpportunityForm';

/*
 * D1/D3 - the spine. Start (the picker) -> The study -> Audience -> the
 * participant's experience (one step, body by type) -> Consent (native,
 * recorded, moderated only) -> Review. External shapes run shorter: their
 * affirmation folds into the link step (row 13), so they have no Consent step.
 *
 * These pin the exact per-shape step set - id, key and title, in order - so a
 * reshape that drops, reorders or renumbers a step fails by name. Ids are
 * fixed: The study 1, Audience 2, experience 3, Consent 4, Review 5.
 */

const shape = (type: string, delivery: 'native' | 'external' = 'external') =>
  getTabsForType(type, delivery).map((step) => [step.id, step.key, step.title]);

describe('getTabsForType - the D1/D3 spine', () => {
  it('gives the moderated pair five steps: study, audience, sessions, consent, review', () => {
    const expected = [
      [1, 'basics', 'The study'],
      [2, 'screener', 'Audience'],
      [3, 'sessions', 'Session Management'],
      [4, 'consent', 'Consent'],
      [REVIEW_STEP_ID, 'review', 'Review']
    ];
    expect(shape('interview')).toEqual(expected);
    expect(shape('test')).toEqual(expected);
  });

  it('gives a recorded study five steps, its experience a task list', () => {
    expect(shape('unmoderated')).toEqual([
      [1, 'basics', 'The study'],
      [2, 'screener', 'Audience'],
      [3, 'taskList', 'Task List'],
      [4, 'consent', 'Consent'],
      [REVIEW_STEP_ID, 'review', 'Review']
    ]);
  });

  it('gives a native answer-based study five steps, its experience Questions', () => {
    expect(shape('survey', 'native')).toEqual([
      [1, 'basics', 'The study'],
      [2, 'screener', 'Audience'],
      [3, 'questions', 'Questions'],
      [4, 'consent', 'Consent'],
      [REVIEW_STEP_ID, 'review', 'Review']
    ]);
    expect(shape('poll', 'native')[2]).toEqual([3, 'questions', 'Questions']);
  });

  it('titles a one-question native study its experience "Question", singular', () => {
    expect(shape('question', 'native')[2]).toEqual([3, 'questions', 'Question']);
  });

  it('gives every external answer-based shape four steps, with no Consent step', () => {
    const expected = [
      [1, 'basics', 'The study'],
      [2, 'screener', 'Audience'],
      [3, 'externalLink', 'Your link'],
      [REVIEW_STEP_ID, 'review', 'Review']
    ];
    expect(shape('poll', 'external')).toEqual(expected);
    expect(shape('question', 'external')).toEqual(expected);
    expect(shape('survey', 'external')).toEqual(expected);
  });

  it('never gives an external shape a Consent step (row 13 folds it into the link)', () => {
    for (const type of ['poll', 'question', 'survey']) {
      expect(
        getTabsForType(type, 'external').some((step) => step.key === 'consent')
      ).toBe(false);
    }
  });

  it('puts Audience before the experience body on every shape that has one', () => {
    for (const [type, delivery] of [
      ['interview', 'external'],
      ['test', 'external'],
      ['unmoderated', 'external'],
      ['survey', 'native'],
      ['survey', 'external']
    ] as const) {
      const keys = getTabsForType(type, delivery).map((step) => step.key);
      const audience = keys.indexOf('screener');
      const experience = keys.findIndex((key) =>
        ['questions', 'externalLink', 'taskList', 'sessions'].includes(key)
      );
      expect(audience).toBeGreaterThan(0);
      expect(audience).toBeLessThan(experience);
    }
  });

  it('collapses Content & Details - no shape carries a content step', () => {
    for (const [type, delivery] of [
      ['', 'external'],
      ['interview', 'external'],
      ['survey', 'native'],
      ['poll', 'external']
    ] as const) {
      expect(
        getTabsForType(type, delivery).some(
          (step) => step.title === 'Content & Details'
        )
      ).toBe(false);
    }
  });

  it('gives the no-type shape just The study and Review, with Review fixed at 5', () => {
    expect(shape('')).toEqual([
      [1, 'basics', 'The study'],
      [REVIEW_STEP_ID, 'review', 'Review']
    ]);
    expect(REVIEW_STEP_ID).toBe(5);
  });
});
