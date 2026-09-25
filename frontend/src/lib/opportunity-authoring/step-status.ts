import { findPublishProblems, PublishProblem } from '@shared/firsthand/publish-readiness';

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
 *
 * "Broken" rather than the original "Published, not working" (#157): the
 * long form needed 147px in a Status pill that leaves its label 53px beside
 * the warning glyph, so the dashboard read "PUBLIS..." - and "Not working"
 * (79px) still did not fit. "Broken" measures 45px.
 *
 * The pill's amber fill and glyph are the DRAFT pill's, so they do not say
 * "published" - and published is what makes this urgent: participants can
 * see the study. Every surface that shows this label therefore also carries
 * PUBLISHED_NOT_WORKING_PREFIX, visually hidden, for a screen reader, and
 * PUBLISHED_NOT_WORKING_DESCRIPTION as its hover title.
 */
export const PUBLISHED_NOT_WORKING_LABEL = 'Broken';

/** Read before the label by a screen reader: "Published, Broken". */
export const PUBLISHED_NOT_WORKING_PREFIX = 'Published, ';

/** The full meaning, for the pill's hover `title`. */
export const PUBLISHED_NOT_WORKING_DESCRIPTION = 'Published, not working';

/**
 * Whether at least one session has not yet ended: `end_time` strictly after
 * `now`. This is the ONE rule "Broken" and its Review-step twin both use for
 * slots (cto/AdaptaLabs#164) - it mirrors the server's own gates exactly, so
 * the frontend can never show a verdict the server would contradict on the
 * next write:
 *  - the publish guard (`backend/src/routes/opportunities.ts` ~2832)
 *  - the session-delete guard (`backend/src/routes/sessions.ts` ~743)
 * Both read `end_time > NOW()`, strictly, regardless of capacity - a fully
 * booked slot still counts as upcoming here. Fullness is a different
 * question, answered elsewhere ("Fully booked" on the table).
 *
 * `now` is passed in, never read from the clock, so every caller controls
 * its own freshness and a test can pin it.
 *
 * An `end_time` that fails to parse is treated as NOT upcoming - a date this
 * function cannot understand cannot be counted as a live one, and leaning
 * toward "not working" is the safer misread for a state that gates a
 * "Broken" pill and a publish preview.
 */
export const hasUpcomingSlot = (
  sessions: readonly { end_time: string }[],
  now: Date
): boolean =>
  sessions.some((session) => {
    const endMs = new Date(session.end_time).getTime();
    return !isNaN(endMs) && endMs > now.getTime();
  });

/**
 * WHY a bookable type's share link cannot be handed to a participant yet, for
 * `ShareOpportunityLink`'s copy (cto/AdaptaLabs#164). A live
 * session or interview can fail two INDEPENDENT publish gates at once - no
 * upcoming slot, no meeting location, or both - and naming only one of them
 * when both are missing tells the author a single fix will do when it will
 * not.
 *
 * Not a boolean, for the same reason `ShareOpportunityLink`'s own prop of
 * this name is not one (see that component's docblock): a caller that only
 * ever asks "is it the slot" has no way to say "it is the venue" without a
 * second boolean, and a third state (both) would need a third.
 */
export type ShareLinkUnstartableReason =
  | 'no_upcoming_slot'
  | 'no_meeting_location'
  | 'no_upcoming_slot_and_no_meeting_location';

/**
 * Resolves `ShareLinkUnstartableReason` from a `findPublishProblems` result -
 * the one place that mapping is written, so `OpportunityForm.tsx` (which
 * already has the full plural list, for the Review checklist) and
 * `OpportunityDetail.tsx` (which asks `findPublishProblems` itself for only
 * the moderated-type problems it has data for) read exactly the same answer
 * off exactly the same two codes, and cannot start naming a different
 * blocker than each other.
 *
 * Any other publish problem in the list (a missing task list, a missing
 * link) is not a `ShareOpportunityLink` reason at all - that component's
 * fallback generic sentence already covers it - so this only ever looks for
 * the two moderated-type codes and ignores the rest.
 */
export const deriveShareLinkUnstartableReason = (
  problems: readonly PublishProblem[]
): ShareLinkUnstartableReason | undefined => {
  const missingLocation = problems.some(
    (problem) => problem.code === 'meeting_location_required'
  );
  const missingSlot = problems.some(
    (problem) => problem.code === 'bookable_slot_required'
  );
  if (missingLocation && missingSlot) {
    return 'no_upcoming_slot_and_no_meeting_location';
  }
  if (missingLocation) {
    return 'no_meeting_location';
  }
  if (missingSlot) {
    return 'no_upcoming_slot';
  }
  return undefined;
};

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
  /**
   * The answer to `hasUpcomingSlot`, when the caller has sessions to ask (the
   * dashboard's list and the Review step both do). The caller computes this -
   * `hasUpcomingSlot(sessions, now)` - rather than handing over raw sessions,
   * so this module stays clock-free and every caller's `now` stays explicit
   * at its own call site.
   */
  hasUpcomingSlot?: boolean;
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
 * `hasUpcomingSlot` (cto/AdaptaLabs#164) no longer disagrees with the study's
 * own Review page: both ask the same question, `hasUpcomingSlot(sessions,
 * now)`, of `end_time > now` - the exact clock the server's own publish and
 * session-delete guards use. This used to run on `sessionCount > 0` from the
 * admin list's own sessions, which is a 14-DAY TAIL
 * (`ADMIN_RECENT_SESSIONS_ONLY`, `backend/src/routes/opportunities.ts`,
 * `end_time > NOW() - INTERVAL '14 days'`) rather than every session the
 * study has - the list's window exists for reasons unrelated to this signal
 * (cto/AdaptaLabs#103) and stays exactly as it was. It just no longer
 * matters here: any session that has NOT yet ended satisfies
 * `end_time > NOW() - 14 days` by construction (a not-yet-ended session's
 * `end_time` is after `NOW()`, which is itself after `NOW() - 14 days`), so
 * the tail always contains every session the "is anything upcoming" question
 * needs - the two surfaces can no longer see different data for the one
 * thing this predicate asks about.
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
    hasBookableSlot: signal.hasUpcomingSlot,
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
