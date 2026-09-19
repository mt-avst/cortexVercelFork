import { fireEvent, screen } from '@testing-library/react';

/**
 * Driving the study-type picker from a test.
 *
 * The picker is six pods, one per `type`, each a `role="radio"` named by its
 * title, plus a delivery toggle ("In Cortex" / "In an external tool") that
 * appears once an answer-based type is picked. A test that used to
 * `selectOptions(type)` and then click a delivery radio now clicks the pod and,
 * for the answer-based types, the toggle - which is what `chooseStudyType` does.
 *
 * The three interactive types (interview -> Interview, test -> Live session,
 * unmoderated -> Recorded session) carry no delivery choice, so the toggle is
 * not clicked for them.
 */

type DeliveryMode = 'native' | 'external';

const TYPE_TITLE: Record<string, string> = {
  interview: 'Interview',
  test: 'Live session',
  unmoderated: 'Recorded session',
  poll: 'Poll',
  question: 'One question',
  survey: 'Survey'
};

const ANSWER_TYPES = new Set(['poll', 'question', 'survey']);

/** The pod radio's accessible name for a type (its title). */
export const studyTypePodName = (type: string): string => {
  const title = TYPE_TITLE[type];
  if (!title) {
    throw new Error(`studyTypePodName: unknown study type "${type}"`);
  }
  return title;
};

/** The pod radio for a type. */
export const studyTypePod = (type: string) =>
  screen.getByRole('radio', { name: studyTypePodName(type) });

/**
 * Choose a study type by clicking its pod, then - for the answer-based types -
 * the delivery toggle. Delivery defaults to external, the system default a pod
 * commits when picked, so it need only be clicked to reach `native`.
 */
export const chooseStudyType = (
  type: string,
  delivery: DeliveryMode = 'external'
): void => {
  fireEvent.click(studyTypePod(type));
  if (ANSWER_TYPES.has(type)) {
    const label = delivery === 'native' ? 'In Cortex' : 'In an external tool';
    fireEvent.click(screen.getByRole('radio', { name: label }));
  }
};
