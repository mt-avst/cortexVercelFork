/**
 * What removing a question does to the answers people have already given it.
 *
 * Before F2 this file could not have existed: `updateLinkedStudyContent`
 * refused any save that changed the questions of a study which had collected
 * answers, so there was nothing to warn about. F2 narrows that refusal to type
 * and scale changes - the ones that change what a stored answer MEANS - and a
 * question can now simply be deleted from a live survey. 0015's foreign key
 * makes that safe for the data: `ON DELETE SET NULL` detaches the answers
 * rather than destroying them, and they surface under "Removed questions" in
 * the results.
 *
 * The person it is not safe for is the author, who is given no signal at all.
 * The Remove control behaves identically whether a question has none or three
 * hundred answers, so tidying a form and moving somebody's research into a
 * different section of the results look and feel exactly the same.
 *
 * The counts arrive keyed by STEP KEY, which is the same value a question card
 * carries as `_clientId` - minted when the question was created and unchanged
 * through every edit and reorder. That is what makes this a lookup rather than
 * a match, and it is the whole reason F2 had to land first.
 */

/** Answers about to be detached, and how many questions they are spread over. */
export interface DetachedAnswers {
  questions: number;
  answers: number;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * How many answers this question has collected, or undefined when that is not
 * known.
 *
 * The three states of `answerCounts` collapse to two here, and the distinction
 * that survives is the one the wording turns on:
 *
 *  - a number, when the count was read. Zero is a real answer and means the
 *    question is safe to remove
 *  - `undefined` when the map itself is null or absent, which is "the count
 *    could not be read" rather than "there are none". A key merely MISSING from
 *    a map that was read is a question with no stored answers, so it is zero
 *
 * Written as a lookup on the map rather than a boolean on the question, because
 * a boolean would have to decide which of those two undefineds it meant and
 * would necessarily get one of them wrong.
 */
export const answerCountFor = (
  clientId: string,
  answerCounts: Record<string, number> | null | undefined
): number | undefined => (answerCounts ? (answerCounts[clientId] ?? 0) : undefined);

/**
 * The answers a save would detach, given the questions the form still holds.
 *
 * Derived from what is MISSING rather than from anything the form records about
 * a removal, and that is what makes it catch the case no per-card dialog can.
 * An author who deletes every question card and adds replacements gets a fresh
 * `_clientId` on each new card, so every stored question is absent from this
 * list and every one of their answers detaches - through a sequence of dialogs
 * each of which was individually about one question, or through no dialog at
 * all if the cards were emptied before they were removed.
 *
 * Returns null when there is nothing to say: no counts (so nothing can be
 * said), or nothing missing. Null rather than a zeroed record so the caller
 * cannot accidentally render "0 questions will be removed".
 *
 * Questions with a count of zero are ignored. They are being removed, but
 * removing a question nobody answered is exactly the ordinary edit this warning
 * must not fire on.
 */
export const answersDetachedBy = (
  remainingClientIds: readonly string[],
  answerCounts: Record<string, number> | null | undefined
): DetachedAnswers | null => {
  if (!answerCounts) {
    return null;
  }

  const remaining = new Set(remainingClientIds);

  const detached = Object.entries(answerCounts).filter(
    ([clientId, count]) => count > 0 && !remaining.has(clientId)
  );

  if (detached.length === 0) {
    return null;
  }

  return {
    questions: detached.length,
    answers: detached.reduce((total, [, count]) => total + count, 0)
  };
};

/**
 * What the confirmation says about removing ONE question.
 *
 * Three sentences for three different situations, rather than one hedged
 * sentence covering all of them. A dialog that warns about answers on a
 * question nobody has answered is a dialog authors learn to dismiss without
 * reading - which is why `requestRemove` already declines to confirm the
 * removal of an empty card at all.
 *
 * `position` is the question's number as the author sees it on screen, so the
 * sentence names the same thing the card does.
 */
export const removalMessage = (
  position: number,
  noun: string,
  nounPlural: string,
  count: number | undefined
): string => {
  const Noun = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;

  if (count === undefined) {
    // The runtime database did not answer. Saying nothing here would be the
    // fail-open this whole change exists to close: the removal still goes
    // through, and the author is told least at the moment the database is
    // under the pressure that suggests people are answering right now.
    return (
      `${Noun} ${position} and everything written in it will be removed from this list of ${nounPlural}. ` +
      `This cannot be undone. Whether anyone has already answered it could not be checked just now - ` +
      `if they have, their answers are kept and shown under "Removed questions" in the results.`
    );
  }

  if (count > 0) {
    return (
      `${Noun} ${position} has collected ${plural(count, 'answer', 'answers')}. ` +
      `Removing it keeps them - they move to "Removed questions" in the results, under the wording each ` +
      `participant was actually shown - but nobody will be asked it again. This cannot be undone.`
    );
  }

  return (
    `${Noun} ${position} and everything written in it will be removed from this list of ${nounPlural}. ` +
    `This cannot be undone.`
  );
};

/** What the confirmation says about a save that would detach several at once. */
export const detachedAnswersMessage = (detached: DetachedAnswers): string =>
  `Saving now removes ${plural(detached.questions, 'question that has', 'questions that have')} ` +
  `collected ${plural(detached.answers, 'answer', 'answers')}` +
  // "between them" needs more than one of them. One question collecting one
  // answer read as "1 question that has collected 1 answer between them".
  `${detached.questions === 1 ? '' : ' between them'}. ` +
  `Those answers are kept and shown under "Removed questions" in the results, under the wording each ` +
  `participant was actually shown, but nobody will be asked ${
    detached.questions === 1 ? 'that question' : 'those questions'
  } again.`;

/** And its title, which names the number so the dialog is legible at a glance. */
export const detachedAnswersTitle = (detached: DetachedAnswers): string =>
  `Remove ${plural(detached.questions, 'question', 'questions')} that ${
    detached.questions === 1 ? 'has' : 'have'
  } been answered?`;
