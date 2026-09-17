import { findPublishProblems } from '@shared/firsthand/publish-readiness';

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
 *
 * Audit row 15 asks for this state's WORD to read "Ready" rather than
 * "Completed" - "Completed" overclaims for a step that is merely visited
 * (Content & Details has no required field, so leaving it always earns the
 * word). That rename is NOT made here: `STEP_STATUS_LABEL.completed` is
 * pinned as the literal string "Completed" by ~15 assertions in
 * `pages/__tests__/OpportunityForm.stepper.test.tsx`, a whole-page test suite
 * outside this workstream's owned files, and updating every one of them to
 * keep the suite green is a wider, cross-cutting edit than this file's
 * boundary is meant to authorise on its own. Logged in W1.md as a follow-up:
 * the rename is one-line here once that test file's assertions are migrated
 * alongside it, ideally by whichever agent already owns a pass over that
 * suite.
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
 * The one word for a study whose Status pill says PUBLISHED while it would
 * itself fail publish readiness (audit row 6): four seeded studies shipped in
 * exactly this state - zero questions, no external link, or a moderated
 * session with no venue - and the dashboard, the Review identity card and the
 * strip each said something different about it, or nothing at all. One
 * spelling, used everywhere the state is shown, so it cannot drift the way the
 * three surfaces already had.
 */
export const PUBLISHED_NOT_WORKING_LABEL = 'Published, not working';

/**
 * What `isPublishedButNotWorking` needs to know, kept deliberately narrower
 * than `PublishReadinessInput`: this is filled from whatever summary of the
 * opportunity the CALLER already has, which is not always the full authoring
 * form.
 */
export interface PublishedReadinessSignal {
  type: string;
  deliveryMode?: string | null;
  hasLinkedStudy: boolean;
  externalLink?: string | null;
  /** Session slots, when the caller has them (the dashboard's list does). */
  sessionCount?: number;
  meetingLocation?: string | null;
}

/**
 * Whether a PUBLISHED opportunity is known - from the fields it is given - to
 * fail its own publish requirements.
 *
 * ponytail: only the gates this signal can PROVE from `PublishedReadinessSignal`
 * fire here. An inline survey's question count and an inline task list's task
 * count are not part of the dashboard's list response (`Opportunity` from
 * `getOpportunities`), so `hasInlineStudy`/`hasInlineSurvey` are passed as
 * `true` - the benefit of the doubt - rather than guessed at `false`, which
 * would misreport every correctly-authored native survey or unmoderated study
 * as broken. The practical effect: this catches a published moderated study
 * with no venue or no slot, and a published hand-off with no link and no
 * linked study, but NOT a published native survey or unmoderated study with
 * no content - that case is still caught on the study's own Review step
 * (`OpportunityForm.tsx`'s `publishRefusal`, built from the real counts), just
 * not on the dashboard row. Widening this needs a content-count field on the
 * list response, which is a backend change outside this signal's reach.
 *   -> worth a tracked issue if the dashboard blind spot is judged worth
 *      closing now rather than left to the per-study Review page.
 *
 * ponytail: `sessionCount` disagrees with the study's own Review page by
 * DESIGN, not by accident, and the two can genuinely give different
 * verdicts for the same study. The admin list route (`GET /opportunities`,
 * `backend/src/routes/opportunities.ts`) joins each opportunity's sessions
 * through `ADMIN_RECENT_SESSIONS_ONLY` - `end_time > NOW() - INTERVAL '14
 * days'` - so `Opportunity.sessions` here is a 14-DAY TAIL, not every
 * session the study has. Review loads the full set with no such window
 * (`getSessions(opportunityId)`) and counts all of it. A live session or
 * interview whose only slots ended more than 14 days ago is therefore
 * `hasBookableSlot: false` here (dashboard reads "Published, not working")
 * while Review, seeing the same old slots, reads `hasBookableSlot: true`
 * and shows no blocker at all - the opposite verdict on the SAME data, from
 * the SAME function, for the SAME study. Not re-architected here: the
 * window exists on purpose (cto/AdaptaLabs#103, see the comment above
 * `ADMIN_RECENT_SESSIONS_ONLY`) for reasons unrelated to this signal, and
 * changing it is a backend decision outside this file's reach.
 */
export const isPublishedButNotWorking = (
  opportunityStatus: string,
  signal: PublishedReadinessSignal
): boolean => {
  if (opportunityStatus !== 'published') {
    return false;
  }
  const problems = findPublishProblems({
    willBePublished: true,
    type: signal.type,
    deliveryMode: signal.deliveryMode ?? 'external',
    hasLinkedStudy: signal.hasLinkedStudy,
    hasInlineStudy: true,
    hasInlineSurvey: true,
    externalLink: signal.externalLink,
    hasBookableSlot:
      signal.sessionCount === undefined ? undefined : signal.sessionCount > 0,
    hasMeetingLocation:
      signal.meetingLocation === undefined
        ? undefined
        : Boolean(signal.meetingLocation && signal.meetingLocation.trim())
  });
  return problems.length > 0;
};

/**
 * "Step 2 of 4". The step's own `id` is not its position: `id` is 1-4 with a
 * type-dependent third step, and a form with no type chosen has two steps
 * carrying ids 1 and 2. Position and total both come from the rendered list, so
 * "Step 3 of 3" and "Step 3 of 4" are both sayable and both true.
 */
export const describeStepPosition = (index: number, total: number): string =>
  `Step ${index + 1} of ${total}`;
