import {
  answerCountFor,
  answersDetachedBy,
  detachedAnswersMessage,
  detachedAnswersTitle,
  removalMessage
} from '../answer-counts';

describe('answerCountFor', () => {
  it('reads a question count by the key the card carries', () => {
    expect(answerCountFor('q1', { q1: 47, q2: 3 })).toBe(47);
  });

  it('treats a key missing from a map that was read as no answers', () => {
    // The count query returns one row per question that HAS answers, so a
    // question absent from the map has none. Reporting it as unknown would put
    // the "could not check" warning on every unanswered question in every
    // survey - which is most of them.
    expect(answerCountFor('q3', { q1: 47 })).toBe(0);
  });

  it.each([
    ['null, meaning the count could not be read', null],
    ['undefined, meaning the response did not state one', undefined]
  ])('reports unknown rather than zero when the map is %s', (_label, counts) => {
    // The distinction this whole module turns on. Collapsed to 0 the author is
    // told a question is safe to remove at exactly the moment the runtime
    // database is failing, which is when there are most likely to be
    // participants answering it.
    expect(answerCountFor('q1', counts)).toBeUndefined();
  });
});

describe('answersDetachedBy', () => {
  it('reports the questions that are gone and the answers they held', () => {
    expect(answersDetachedBy(['q1'], { q1: 5, q2: 40, q3: 7 })).toEqual({
      questions: 2,
      answers: 47
    });
  });

  it('says nothing when every answered question is still on the form', () => {
    expect(answersDetachedBy(['q1', 'q2'], { q1: 5, q2: 40 })).toBeNull();
  });

  it('ignores a removed question that nobody answered', () => {
    // Removing a question with no answers is the ordinary edit this warning
    // must not fire on. A count of zero in the map is still a key, so a filter
    // on presence alone would warn about it.
    expect(answersDetachedBy(['q1'], { q1: 5, q2: 0 })).toBeNull();
  });

  it('catches an author who replaced every question rather than editing them', () => {
    // The case no per-card dialog can see. Deleting every card and adding
    // replacements mints a fresh key for each new one, so nothing on the form
    // shares an identity with anything stored and every answer detaches - and
    // each individual removal looked like removing one question.
    expect(answersDetachedBy(['new-a', 'new-b'], { q1: 300, q2: 12 })).toEqual({
      questions: 2,
      answers: 312
    });
  });

  it('reports nothing it cannot know when the counts were never read', () => {
    // Not a warning that says "some unknown number". There is no list of
    // stored questions to compare against, so there is genuinely nothing to
    // enumerate; the per-card dialog carries the "could not check" sentence
    // instead, at the point the author actually removes something.
    expect(answersDetachedBy(['q1'], null)).toBeNull();
    expect(answersDetachedBy(['q1'], undefined)).toBeNull();
  });
});

describe('removalMessage', () => {
  it('names the number of answers when the question has some', () => {
    const message = removalMessage(3, 'question', 'questions', 47);

    expect(message).toContain('Question 3 has collected 47 answers');
    expect(message).toContain('Removed questions');
  });

  it('speaks of one answer in the singular', () => {
    expect(removalMessage(1, 'question', 'questions', 1)).toContain(
      'has collected 1 answer.'
    );
  });

  it('says nothing about answers when the question has none', () => {
    const message = removalMessage(2, 'question', 'questions', 0);

    // A dialog that mentions answers on a question nobody answered is the
    // noise that teaches authors to dismiss dialogs unread.
    expect(message).not.toContain('answer');
    expect(message).toContain('Question 2');
  });

  it('admits it could not check rather than implying there are none', () => {
    const message = removalMessage(2, 'question', 'questions', undefined);

    expect(message).toContain('could not be checked');
    expect(message).toContain('Removed questions');
  });

  it('uses the vocabulary of whichever list it is in', () => {
    // The list renders recorded tasks as well as survey questions, and a
    // dialog calling a task a question is a dialog about something the author
    // cannot see on screen.
    expect(removalMessage(1, 'task', 'tasks', 0)).toContain('Task 1');
    expect(removalMessage(1, 'task', 'tasks', 0)).toContain('list of tasks');
  });
});

describe('the save-time summary', () => {
  it('counts questions and answers separately', () => {
    const message = detachedAnswersMessage({ questions: 2, answers: 47 });

    // Both numbers matter and neither implies the other: two questions with 47
    // answers and 47 questions with 2 are very different edits.
    expect(message).toContain('2 questions that have');
    expect(message).toContain('47 answers');
    // And "between them" belongs on the plural, where it is true.
    expect(message).toContain('between them');
  });

  it('reads as English for a single question', () => {
    // "between them" needs more than one of them.
    expect(detachedAnswersMessage({ questions: 1, answers: 1 })).toContain(
      '1 question that has collected 1 answer.'
    );
    expect(detachedAnswersMessage({ questions: 1, answers: 1 })).not.toContain(
      'between them'
    );
    expect(detachedAnswersTitle({ questions: 1, answers: 1 })).toBe(
      'Remove 1 question that has been answered?'
    );
  });

  it('names the count in the title, so the dialog reads at a glance', () => {
    expect(detachedAnswersTitle({ questions: 3, answers: 9 })).toBe(
      'Remove 3 questions that have been answered?'
    );
  });
});
