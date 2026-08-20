/**
 * What the stepper says about one step of the opportunity form.
 *
 * Four states, and they are mutually exclusive because the author reads exactly
 * one word per step. `current` is deliberately NOT the highest priority: a step
 * the author was just sent back to has to keep saying `needsAttention`, or the
 * act of visiting it erases the only reason they went there.
 *
 * Colour is never the carrier - every state pairs with an icon and its own
 * words at the call site, because the two failing-contrast tokens in this app
 * are exactly the kind of thing that makes a colour-only state unreadable.
 */
export type StepStatus = 'needsAttention' | 'current' | 'completed' | 'notStarted';

/**
 * The words the author sees, and the same words the live region announces.
 * One spelling of each, so the chip and the announcement cannot drift.
 */
export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  needsAttention: 'Needs attention',
  current: 'Current step',
  completed: 'Completed',
  notStarted: 'Not started'
};

/**
 * Which steps hold at least one of these errors.
 *
 * `locate` is passed in rather than imported: `FIELD_LOCATIONS` and
 * `locateField` live in `OpportunityForm.tsx`, and the completeness test greps
 * that file off disk for the assignments that feed them. Importing them here
 * would be fine; importing this module THERE and the page HERE would not, so
 * the dependency points one way only and this module stays testable on its own.
 */
export const stepsHoldingErrors = (
  errors: Record<string, string>,
  locate: (key: string) => { tab: number }
): Set<number> => {
  const tabs = new Set<number>();
  Object.keys(errors).forEach((key) => {
    tabs.add(locate(key).tab);
  });
  return tabs;
};

export interface StepStatusInputs {
  /** The step being described. */
  stepId: number;
  /** The step the author is looking at. */
  activeStepId: number;
  /**
   * Whether the author has been on this step AND left it. A step they are
   * standing on for the first time is not visited: nothing about it has been
   * decided yet, and calling a blank step Completed the moment it renders is
   * the form lying.
   *
   * A boolean rather than a set, because the caller has to answer it by STEP
   * KEY while the error maps below are keyed by step ID, and the two are not
   * interchangeable: id 3 is Task List, Questions, External Link or Session
   * Management depending on the type, and inheriting one shape's history into
   * another's is a bug this had before it was written this way.
   */
  visited: boolean;
  /**
   * Steps holding an error the author has already been TOLD about - the
   * `validationErrors` state map, written by a refused save or a blur.
   */
  reportedErrorSteps: ReadonlySet<number>;
  /**
   * Steps holding an error under the same rules, evaluated against the form as
   * it stands right now. This is what lets a step flip to Completed the moment
   * its field is filled, with no save and no second rule set - it is the same
   * validator `handleSubmit` runs, called without its `setState`.
   */
  liveErrorSteps: ReadonlySet<number>;
}

/**
 * The whole state machine, in one pure function of five values.
 *
 * A step is `needsAttention` when it has already been reported, or when the
 * author has walked past it leaving something invalid behind - the second half
 * matters because the tab strip is directly clickable, so walking past a step
 * does not have to go through the Continue button that would have reported it.
 *
 * It is `completed` only once BOTH are true: the author has been there, and it
 * would pass right now. Never having been there is `notStarted`, whatever the
 * validator thinks, because most steps hold nothing invalid before they hold
 * anything at all.
 */
export const deriveStepStatus = ({
  stepId,
  activeStepId,
  visited,
  reportedErrorSteps,
  liveErrorSteps
}: StepStatusInputs): StepStatus => {
  if (reportedErrorSteps.has(stepId) || (visited && liveErrorSteps.has(stepId))) {
    return 'needsAttention';
  }
  if (stepId === activeStepId) {
    return 'current';
  }
  if (visited) {
    return 'completed';
  }
  return 'notStarted';
};

/**
 * "Step 2 of 4". The step's own `id` is not its position: `id` is 1-4 with a
 * type-dependent third step, and a form with no type chosen has two steps
 * carrying ids 1 and 2. Position and total both come from the rendered list, so
 * "Step 3 of 3" and "Step 3 of 4" are both sayable and both true.
 */
export const describeStepPosition = (index: number, total: number): string =>
  `Step ${index + 1} of ${total}`;
