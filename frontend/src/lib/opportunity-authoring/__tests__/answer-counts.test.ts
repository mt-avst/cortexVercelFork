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
  const STORED = ['q1', 'q2', 'q3'];

  it('reports the questions that are gone and the answers they held', () => {
    expect(answersDetachedBy(['q1'], STORED, { q1: 5, q2: 40, q3: 7 })).toEqual({
      questions: 2,
      answers: 47
    });
  });

  it('says nothing when every answered question is still on the form', () => {
    expect(answersDetachedBy(['q1', 'q2'], ['q1', 'q2'], { q1: 5, q2: 40 })).toBeNull();
  });

  it('ignores a removed question that nobody answered', () => {
    // Removing a question with no answers is the ordinary edit this warning
    // must not fire on. A count of zero in the map is still a key, so a filter
    // on presence alone would warn about it.
    expect(answersDetachedBy(['q1'], ['q1', 'q2'], { q1: 5, q2: 0 })).toBeNull();
  });

  it('catches an author who replaced every question rather than editing them', () => {
    // The case no per-card dialog can see. Deleting every card and adding
    // replacements mints a fresh key for each new one, so nothing on the form
    // shares an identity with anything stored and every answer detaches - and
    // each individual removal looked like removing one question.
    expect(
      answersDetachedBy(['new-a', 'new-b'], ['q1', 'q2'], { q1: 300, q2: 12 })
    ).toEqual({ questions: 2, answers: 312 });
  });

  /**
   * THE FAIL-OPEN THIS FUNCTION USED TO HAVE, and the reason it is worth a
   * block of its own.
   *
   * It derived everything from the counts map, so an unreadable map produced an
   * empty removal list and the dialog did not render. The reasoning - "there is
   * genuinely nothing to enumerate" - was true of the ANSWERS and false of the
   * QUESTIONS, which are known either way.
   *
   * It matters more than a rare database failure suggests: the runtime pool
   * refuses an advisory count rather than queueing for it when busy, so an
   * unreadable map is a state another admin's load can produce on demand.
   */
  it.each([
    ['could not be read', null],
    ['was never offered', undefined]
  ])('still warns about a removal when the count %s', (_label, counts) => {
    expect(answersDetachedBy(['q1'], ['q1', 'q2'], counts)).toEqual({
      questions: 1,
      answers: null
    });
  });

  it('says nothing about an unreadable count when nothing stored is being removed', () => {
    // The other half of failing closed. Warning on every save of a study whose
    // counts happen to be unavailable is the noise that gets the dialog
    // dismissed unread, and no stored question is going anywhere here.
    expect(answersDetachedBy(['q1', 'q2'], ['q1', 'q2'], null)).toBeNull();
  });

  it('says nothing when the study stored no questions at all', () => {
    // A survey being authored for the first time has nothing to detach, so an
    // unreadable count is not a reason to warn about one.
    expect(answersDetachedBy(['new-a'], [], null)).toBeNull();
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

  describe('when the count could not be read', () => {
    it('says what it knows and admits what it does not', () => {
      const message = detachedAnswersMessage({ questions: 2, answers: null });

      // The removal is certain; its cost is not. Both halves have to be said.
      expect(message).toContain('2 questions that were already saved');
      expect(message).toContain('could not be checked');
      expect(message).toContain('Removed questions');
    });

    it('claims only that they MAY have been answered', () => {
      // A title asserting they have been is a guess, and an author who checks
      // and finds none learns to disbelieve the next one.
      expect(detachedAnswersTitle({ questions: 2, answers: null })).toBe(
        'Remove 2 questions that may have been answered?'
      );
      expect(detachedAnswersTitle({ questions: 1, answers: null })).toBe(
        'Remove 1 question that may have been answered?'
      );
    });

    it('never invents a number of answers', () => {
      const message = detachedAnswersMessage({ questions: 2, answers: null });

      expect(message).not.toContain('null');
      expect(message).not.toMatch(/collected \d+ answer/);
    });
  });
});
