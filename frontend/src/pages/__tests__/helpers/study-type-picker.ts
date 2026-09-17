import { fireEvent, screen } from '@testing-library/react';

/**
 * Driving the study-type picker (D2) from a test.
 *
 * The picker replaced the old "Research Study Type" select and the "Where
 * participants answer" delivery radios with nine cards, each a `role="radio"`
 * with a concise accessible name. A test that used to `selectOptions(type)` and
 * then click a delivery radio now clicks ONE card - so these helpers give the
 * card's accessible name for a (type, delivery) pair and click it.
 *
 * The three interactive types (interview -> Interview, test -> Live session,
 * unmoderated -> Recorded session) have one card each; delivery is not a choice
 * they carry, so it is ignored for them.
 */

type DeliveryMode = 'native' | 'external';

const INTERACTIVE_CARD: Record<string, string> = {
  interview: 'Interview',
  test: 'Live session',
  unmoderated: 'Recorded session'
};

const ANSWER_TITLE: Record<string, string> = {
  poll: 'Quick poll',
  question: 'One question',
  survey: 'Survey'
};

/** The card's accessible name for a (type, delivery) pair. */
export const studyTypeCardName = (
  type: string,
  delivery: DeliveryMode = 'external'
): string => {
  if (INTERACTIVE_CARD[type]) return INTERACTIVE_CARD[type];
  const title = ANSWER_TITLE[type];
  if (!title) {
    throw new Error(`studyTypeCardName: unknown study type "${type}"`);
  }
  return `${title}, ${delivery === 'native' ? 'in Cortex' : 'in an external tool'}`;
};

/** The card radio for a (type, delivery) pair. */
export const studyTypeCard = (type: string, delivery: DeliveryMode = 'external') =>
  screen.getByRole('radio', { name: studyTypeCardName(type, delivery) });

/**
 * Choose a study type by clicking its card. Delivery defaults to external, which
 * is what the old select left it at before a delivery radio was touched.
 */
export const chooseStudyType = (
  type: string,
  delivery: DeliveryMode = 'external'
): void => {
  fireEvent.click(studyTypeCard(type, delivery));
};
