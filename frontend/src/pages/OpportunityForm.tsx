import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams, useMatch, Navigate } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { createOpportunity, updateOpportunity, deleteOpportunity, getOpportunity, getSessions } from '../api/client';
import { getFirstHandStudy, wasRateLimited } from '../api/firsthand-studies';
import {
  answersDetachedBy,
  detachedAnswersMessage,
  detachedAnswersTitle,
  type DetachedAnswers
} from '../lib/opportunity-authoring/answer-counts';
import { getPrimaryTargetUrl } from '../lib/recording/task-target';
import {
  withoutClientIds,
  type WithClientId
} from '../lib/opportunity-authoring/client-ids';
import { remapAuthoringErrors } from '../lib/opportunity-authoring/authoring-errors';
import {
  buildErrorSummary,
  errorsForStep,
  firstStepHoldingError,
  POSITION_PLACEHOLDER,
  replaceStepErrors
} from '../lib/opportunity-authoring/error-summary';
import { hasUnsavedChanges } from '../lib/opportunity-authoring/dirty-signature';
import {
  buildSavePayload,
  type SavePayload,
  type SavePayloadFormState
} from '../lib/opportunity-authoring/save-payload';
import {
  AUTOSAVE_MAX_ATTEMPTS,
  decideAutosave,
  forAutosave,
  meetsCreateThreshold,
  saveStateMessage,
  saveStateView,
  type AutosaveBlock,
  type AutosaveState
} from '../lib/opportunity-authoring/autosave';
import { dirtySignature } from '../lib/opportunity-authoring/dirty-signature';
import {
  STEP_STATUS_LABEL,
  deriveStepStatus,
  describeStepPosition,
  stepsHoldingErrors,
  type StepStatus
} from '../lib/opportunity-authoring/step-status';
import {
  estimateRecordedMinutes,
  estimateSurveyMinutes
} from '../lib/opportunity-authoring/estimate-duration';
import {
  buildReviewSummary,
  stepForPublishProblem
} from '../lib/opportunity-authoring/review-summary';
import {
  PUBLISH_PROBLEM_MESSAGES,
  findPublishProblem
} from '@shared/firsthand/publish-readiness';
import {
  EXTERNAL_LINK_PROTOCOL_MESSAGE,
  isPublishableExternalLink
} from '@shared/firsthand/url-safety';
import {
  authoredStepsOf,
  copiedRecordedFields,
  copiedSurveyFields,
  isAwaitingCopiedContent,
  recordedStudyCopyability,
  studyRoundTripsCleanly,
  toInlineStudyStep,
  toSurveyQuestion,
  withStoredIdentity,
  type AuthoringKind,
  type StudyReadOnlyReason
} from '../lib/opportunity-authoring/hydrate-study';
import type { StudySourceMode } from '../components/OpportunityForm/StudySourceChoice';
import ParticipantPreview, {
  PreviewParticipantButton
} from '../components/OpportunityForm/ParticipantPreview';
import {
  buildRecordedPreview,
  buildStoredStudyPreview,
  buildSurveyPreview,
  type ParticipantPreview as ParticipantPreviewModel
} from '../lib/opportunity-authoring/participant-preview';
import type { FirstHandStudyWithSteps } from '../api/firsthand-studies';
import { logger } from '../utils/logger';
import AdminSessionManager from '../components/AdminSessionManager';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import { BasicInfoTab, ConsentStep, ContentDetailsTab, ErrorSummary, ExternalLinkTab, FirstHandStudyTab, ReviewStep, StepActions, StepNav, SurveyQuestionsTab } from '../components/OpportunityForm';
import ConfirmationModal from '../components/ConfirmationModal';
import { RATING_SCALE_BOUNDS } from '@shared/firsthand/contract';
import {
  QUESTION_CARRYING_TYPES,
  isQuestionCarryingType,
  runsNativeSurvey
} from '@shared/firsthand/delivery';
import { VALIDATION } from '@shared/constants';
import {
  CUSTOM_CONSENT_TEMPLATE_ID,
  DEFAULT_MODERATED_CONSENT_TEXT,
  MODERATED_CONSENT_TEMPLATE,
  RECORDED_CONSENT_TEMPLATE,
  SURVEY_CONSENT_TEMPLATE,
  resolveConsentTemplate,
  type ConsentKind
} from '@shared/firsthand/consent-templates';
import {
  DEFAULT_SURVEY_CONSENT_TEXT,
  inlineSurveySchema,
  type SurveyQuestion
} from '@shared/firsthand/survey-authoring';
import {
  DEFAULT_CONSENT_TEXT,
  INLINE_STUDY_LIMITS,
  UNSAFE_TARGET_URL_MESSAGE,
  inlineStudySchema,
  type InlineStudyStep
} from '@shared/firsthand/inline-study';
import { isSafeTargetUrl } from '@shared/firsthand/url-safety';
import { normaliseTargetUrl } from '../utils/targetUrl';

import { CreateOpportunityRequest, UpdateOpportunityRequest, Opportunity, Session } from '../api/types';
import { TrendingUp, UserCircle, AlertTriangle, CheckCircle, LogOut } from 'lucide-react';

/**
 * Unmoderated studies run with logged-in Cortex users, so an external
 * participant type is not representable. Kept in sync (character-for-character)
 * with the authoritative backend rule in routes/opportunities.ts.
 */
export const UNMODERATED_EXTERNAL_PARTICIPANT_ERROR =
  'Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users';

/**
 * When the opportunity type changes, some fields (and therefore their
 * validation errors) no longer apply. Return a copy of `errors` with any stale
 * type-conditional error removed so it cannot linger on a now-hidden field
 * (blocking submit or resurfacing if the user switches back).
 */
export const clearTypeConditionalErrors = (
  errors: Record<string, string>,
  newType: string
): Record<string, string> => {
  const next = { ...errors };
  // External link only applies to poll/survey/question.
  if (!['poll', 'survey', 'question'].includes(newType)) {
    delete next.external_link_optional;
  }
  // A study - linked or authored inline - only applies to unmoderated.
  if (newType !== 'unmoderated') {
    delete next.firsthand_study_id;
    delete next.inline_study_consent_text;
    delete next.inline_study_target_url;
    delete next.inline_study_duration_minutes;
    Object.keys(next)
      .filter((key) => key.startsWith('inline_study_steps'))
      .forEach((key) => delete next[key]);
  }
  if (!QUESTION_CARRYING_TYPES.has(newType)) {
    delete next.inline_survey_consent_text;
    delete next.inline_survey_duration_minutes;
    Object.keys(next)
      .filter((key) => key.startsWith('inline_survey_questions'))
      .forEach((key) => delete next[key]);
  }
  // The unmoderated + external participant (M2) rule only applies to
  // unmoderated, and switching to unmoderated coerces an external participant
  // type back to 'any', so this error is stale after any type change.
  delete next.participant_type_required;

  /*
   * The session fields, which are rendered - and validated - for `test` and
   * `interview` only.
   *
   * These two were missing, and the result was a step chip that could not be
   * cleared. Blur or a refused save on a `test` leaves
   * `default_duration_minutes` in the map; switching to `question` unmounts the
   * field, so the message vanishes from the screen while the key stays - and
   * `reportedErrorSteps` paints step 1 "Needs attention" over a step holding
   * nothing wrong and offering nothing to fix. Reproduced by driving the form,
   * not by reading it.
   *
   * D1 made this easier to reach rather than causing it: before D1 the blur
   * validator for this field was unreachable, because no input in BasicInfoTab
   * wired `onBlur` at all, so only a refused save could set the key.
   */
  if (newType !== 'test' && newType !== 'interview') {
    delete next.default_duration_minutes;
    delete next.meeting_location_optional;
  }

  return next;
};

/**
 * Which step renders each validation error, and which control on it.
 *
 * The form spans three to five steps depending on the type, and the save
 * controls only exist on the last one, so a refused save is almost always
 * about a field that is not on screen: opening its step and landing on the
 * control is the whole point.
 *
 * `label` is gone, and its absence is the change D1 is most about. It held the
 * on-screen name of each field and fed a banner reading "Please fix these
 * fields: Title, Consent text" - a SECOND vocabulary, describing the same
 * failure in different words from the message the field itself showed. The
 * summary now renders the validator's own messages, so there is one sentence
 * per problem and it says the same thing in both places.
 *
 * `control` is the DOM id to focus. Where it is undefined the field has no
 * addressable control of its own and the summary link opens the step without
 * moving the caret; that is a smaller promise, honestly kept.
 */
export const FIELD_LOCATIONS: Record<string, { tab: number; control?: string }> = {
  type: { tab: 1, control: 'type' },
  title: { tab: 1, control: 'title' },
  // `status` has no entry, deliberately: it is a closed two-option select and
  // no validator in this file ever assigns `errors.status` or
  // `fieldErrors.status`, so it is a field that can never fail - the
  // completeness test below asserts exactly that. Moving its control to
  // Review (#111) does not change this; if a validator ever does start
  // setting it, it must be routed to `REVIEW_STEP_ID`, not tab 1, since that
  // is where the control now lives.
  meeting_location_optional: { tab: 1, control: 'meeting_location_optional' },
  purpose_one_liner: { tab: 1, control: 'purpose_one_liner' },
  default_duration_minutes: { tab: 1, control: 'default_duration_minutes' },
  participant_type_required: { tab: 2, control: 'participant_type_required' },
  participant_type_specific_details: {
    tab: 2,
    control: 'participant_type_specific_details'
  },
  external_link_optional: { tab: 3, control: 'external_link_optional' },
  // Set on neither authoring surface any more - copy mode sends `inline_*` and
  // never this id. It survives for the one state that still carries it: a
  // linked study this author may not change here, which is saved by id. No
  // control: the read-only rendering of that study is an `<ol>` with no id and
  // nothing on the step is editable, so there is nothing to focus.
  firsthand_study_id: { tab: 3 },
  inline_study_target_url: { tab: 3, control: 'inline_study_target_url' },
  inline_study_duration_minutes: {
    tab: 3,
    control: 'inline_study_duration_minutes'
  },
  // The step HEADING carries this id and `tabIndex={-1}`, not a form control:
  // "add at least one task" is about the list, and the list may be empty, so
  // there is no input to land on.
  inline_study_steps: { tab: 3, control: 'inline_study_steps' },
  // Step 4 on the two authoring paths, and there is no other kind of
  // opportunity that can produce this error: only an unmoderated study carries
  // a task list, and only an unmoderated study has a Consent step. Same for its
  // survey twin below. A type with no study never sets either key -
  // clearTypeConditionalErrors deletes them on a type change - so a fixed 4 is
  // unambiguous here in a way it would not be for a field two shapes share.
  //
  // The HEADING again, and for a sharper reason: consent is locked to the
  // approved wording by default, and while it is locked the textarea carrying
  // the field id is not rendered at all. C3 found this by driving the form.
  inline_study_consent_text: { tab: 4, control: 'inline_study_consent_text-heading' },
  inline_survey_questions: { tab: 3, control: 'inline_survey_questions' },
  inline_survey_duration_minutes: {
    tab: 3,
    control: 'inline_survey_duration_minutes'
  },
  inline_survey_consent_text: { tab: 4, control: 'inline_survey_consent_text-heading' },
  moderated_consent_text: { tab: 4, control: 'moderated_consent_text-heading' },
  // Audit row 15: the Session Management step (tab 3 for test/interview). Like
  // `inline_study_steps`, the slots are a list with no single input to land on,
  // so the summary link lands on the step HEADING (id + tabIndex={-1}).
  sessions: { tab: 3, control: 'sessions-heading' }
};

/**
 * The delivery-mode twin of `clearTypeConditionalErrors`.
 *
 * Switching a poll or survey between "in Cortex" and "in an external tool"
 * replaces its third step just as completely as changing the type does, and
 * discards the content of the surface being left - but nothing cleared the
 * errors that content had produced. They stayed in the map, pointing at tab 3,
 * which is now a different step.
 *
 * Before the stepper that was invisible unless a save was attempted. With a
 * per-step badge it is a dead end: the External Link step reads "Needs
 * attention" over a field that is optional on a draft and shows no error, and
 * nothing the author can do on that step clears it.
 *
 * Deliberately in this file rather than in a module of its own. The
 * `FIELD_LOCATIONS` completeness test greps this file for the assignments that
 * produce these keys, and the deletions have to sit beside them to be read
 * against them.
 */
export const clearDeliveryConditionalErrors = (
  errors: Record<string, string>,
  newDeliveryMode: 'native' | 'external'
): Record<string, string> => {
  const next = { ...errors };

  if (newDeliveryMode === 'external') {
    // The authored questions have just been dropped from state.
    delete next.inline_survey_consent_text;
    delete next.inline_survey_duration_minutes;
    Object.keys(next)
      .filter((key) => key.startsWith('inline_survey_questions'))
      .forEach((key) => delete next[key]);
  } else {
    // And in the other direction the link is no longer on screen or sent.
    delete next.external_link_optional;
  }

  return next;
};

/**
 * The participant-type twin of the two `clear*ConditionalErrors` above.
 *
 * `participant_type_specific_details` is rendered only while the participant
 * type is `specific`. Switching back to "Anyone" unmounts the field, and
 * `handleInputChange` clears only the key it just edited - so the details error
 * stayed in the map with nothing on screen to answer it.
 *
 * Exactly the dead end the session-field clear was added for, one field over:
 * step 2's chip reads "Needs attention" over a step holding nothing wrong, and
 * the summary keeps a link whose control id nothing renders - so activating it
 * calls `focus()` on a missing element, which throws nothing, does nothing, and
 * drops the author on `document.body`.
 */
export const clearParticipantConditionalErrors = (
  errors: Record<string, string>,
  newParticipantType: string
): Record<string, string> => {
  // Defensive, and unobservable today: the only transition that reaches this
  // function with `'specific'` is one INTO it, at which point a details error
  // can only be stale anyway. A mutation removing the guard survives the suite,
  // and that is recorded rather than papered over with a test that would only
  // be asserting the guard exists. It stays because the day another type
  // requires this field, an unconditional delete is silently wrong.
  if (newParticipantType === 'specific') {
    return errors;
  }
  const next = { ...errors };
  delete next.participant_type_specific_details;
  return next;
};

/**
 * Resolve one validation error key to the step that renders it, and the
 * control on that step it is about. Per-task errors are keyed
 * `inline_study_steps.<i>.<field>`; their control id depends on the item's
 * client id, which only the component holds, so they resolve to a step here
 * and get their control from `controlForError` below.
 *
 * An unknown key falls back to the first step rather than routing nowhere.
 *
 * The lookup is `hasOwn`-guarded, not `??`: a plain object inherits
 * `constructor`, `toString` and friends, so those keys would return a truthy
 * inherited value, skip the fallback, and yield a summary entry with no step to
 * open - this fix's own failure mode, reintroduced. No user-supplied string
 * becomes an error key today, but backend zod issue paths are one commit away
 * from being mapped straight into these.
 */
export const locateField = (key: string): { tab: number; control?: string } => {
  if (/^inline_study_steps\.\d+\./.test(key)) {
    return { tab: 3 };
  }

  if (/^inline_survey_questions\.\d+\./.test(key)) {
    return { tab: 3 };
  }
  // `Object.hasOwn` would read better but needs the es2022 lib, and widening
  // the compiler target for one call is not a trade worth making.
  return Object.prototype.hasOwnProperty.call(FIELD_LOCATIONS, key)
    ? FIELD_LOCATIONS[key]
    : { tab: 1 };
};

/**
 * Which item, and which part of it, an indexed error key is about.
 *
 * Returned rather than resolved here because the control's id is built from
 * the item's `_clientId` - a per-item identity the page holds and this module
 * scope does not. Exported so the mapping is testable without rendering a form.
 */
export const parseIndexedErrorKey = (
  key: string
): { list: 'inline_study_steps' | 'inline_survey_questions'; index: number; field: string } | null => {
  const match = /^(inline_study_steps|inline_survey_questions)\.(\d+)\.(.+)$/.exec(key);
  return match
    ? {
        list: match[1] as 'inline_study_steps' | 'inline_survey_questions',
        index: Number(match[2]),
        field: match[3]
      }
    : null;
};

/**
 * The wizard's steps for a given research study type. A pure function of the
 * type, and at module scope deliberately: as a closure over `formData` it was
 * rebuilt every render, so the effect that clamps `activeTab` could not name it
 * as a dependency without re-running on every render forever. Hoisting it
 * removes the dependency rather than memoising around it.
 *
 * Tab 3 is type-dependent and simply absent until a type is chosen, which is
 * why the Continue button has to handle there being no tab to continue to.
 *
 * `key` says which body a step renders. The step bodies used to re-derive that
 * from `type` and `deliveryMode` themselves, in predicates that had to agree
 * with this function and could silently stop agreeing with it.
 */
export type StepKey =
  | 'basics'
  | 'content'
  | 'questions'
  | 'externalLink'
  | 'taskList'
  | 'consent'
  | 'sessions'
  | 'review';

export interface FormStep {
  id: number;
  key: StepKey;
  title: string;
  description: string;
}

/**
 * Review's step id, fixed rather than derived from the length of the list.
 *
 * Exported so a test can name "the step that commits" without recomputing the
 * whole shape to find it. The first version of this docstring also claimed the
 * refusal-routing guard needed it; it does not, and nothing imported this at
 * all until the tests did - a justification for an export that no reader had
 * is the kind of nearly-right premise this plan keeps paying for.
 */
export const REVIEW_STEP_ID = 5;

/**
 * Where to send an author standing on a step the current shape does not have.
 *
 * Pure and exported so it can be TESTED, which the guard that calls it cannot
 * be: both controls that reshape the step set live on step 1, so there is no
 * way through the UI to be on a step the new shape lacks. An independent
 * mutation pass proved the point - replacing the whole choice with "the first
 * step" passed all 1178 tests, because nothing can reach it.
 *
 * That is a reason to make the logic reachable, not a reason to leave it
 * unpinned. The two `DEFENCE ONLY` guards in `handleSubmit` are unreachable in
 * the same way and are recorded as untested; this one need not join them.
 *
 * Returns the nearest EARLIER step rather than the first one: the author was
 * working forwards, and sending them back to Basic Information from step 4
 * discards their place for no reason. Falls back to the first step only when
 * there is nothing earlier, which for a list that always contains step 1 means
 * only when `activeStepId` is 1 or lower.
 */
export const stepAfterShapeChange = (
  shape: readonly FormStep[],
  activeStepId: number
): number => {
  if (shape.some((step) => step.id === activeStepId)) {
    return activeStepId;
  }
  const earlier = [...shape].reverse().find((step) => step.id < activeStepId);
  return (earlier ?? shape[0]).id;
};

export const getTabsForType = (
  type: string,
  deliveryMode: 'native' | 'external' = 'external'
): FormStep[] => {
  const tabs: FormStep[] = [
    { id: 1, key: 'basics', title: 'Basic Information', description: 'Configure type and details' },
    { id: 2, key: 'content', title: 'Content & Details', description: 'Define opportunity content' }
  ];

  // Every question-carrying type has two shapes. Native delivery collects the
  // questions here; external delivery collects the link it hands off to.
  //
  // `question` joined them in #78. It used to keep the link step
  // unconditionally, which was the whole of that issue: the only study type
  // with no native option, so a one-question study always handed off and Cortex
  // got back a click count. A single question is a strict subset of what
  // SurveyRunner already draws, so this is the same two shapes, not a third.
  if (QUESTION_CARRYING_TYPES.has(type)) {
    tabs.push(
      deliveryMode === 'native'
        ? {
            id: 3,
            key: 'questions',
            // Singular for the type whose whole promise is that there is one.
            title: type === 'question' ? 'Question' : 'Questions',
            description: 'What the participant is asked'
          }
        : { id: 3, key: 'externalLink', title: 'External Link', description: 'Configure external tool' }
    );
  }

  if (type === 'unmoderated') {
    tabs.push({ id: 3, key: 'taskList', title: 'Task List', description: 'What the participant does' });
  }

  if (type === 'test' || type === 'interview') {
    tabs.push({
      id: 3,
      key: 'sessions',
      title: 'Session Management',
      description: 'Create time slots'
    });
  }

  // Consent is a step of its own on the paths where Cortex either RUNS the
  // study or STORES artefacts of it, and on no others.
  //
  // Two ways in, deliberately distinct:
  //
  // - A study-authoring shape (`questions` or `taskList` above) gets Consent
  //   derived from that step rather than re-tested against `type`, so the two
  //   cannot disagree - the drift B1 removed. A future type that authors a
  //   study gets Consent for free.
  // - The two MODERATED shapes (`sessions` above) get Consent by type (#79).
  //   This used to be argued the other way - "a booked session has no study,
  //   so there is no consent for this product to govern" - and that argument
  //   EXPIRED the moment Cortex began storing a moderated session's recording
  //   and transcript against the booking. The session still happens on a
  //   third-party call; what the participant now agrees to at booking time is
  //   what Cortex may hold afterwards.
  //
  // A pure hand-off keeps no artefacts, so it still has no Consent step: what
  // its participant agrees to lives in the tool on the other side of the link,
  // and an empty Consent step there would imply Cortex has a say in something
  // it does not.
  //
  // #78 is the "future type" the first bullet predicted, and it arrived for
  // free: a native `question` gets Consent because it has a `questions` step,
  // and its external twin does not because it has a link step. Neither outcome
  // needed a word about `question` here.
  const authoringStep = tabs.find(
    (tab) => tab.key === 'questions' || tab.key === 'taskList'
  );
  const moderatedStep = tabs.find((tab) => tab.key === 'sessions');

  if (authoringStep || moderatedStep) {
    tabs.push({
      id: 4,
      key: 'consent',
      title: 'Consent',
      description: 'What the participant agrees to'
    });
  }

  /*
   * Review is last on every shape, and the shapes are not the same length -
   * two steps before a type is chosen, three for a hand-off or a booked
   * session, five for the two paths that author a study.
   *
   * Its id is a FIXED 5 rather than "one past the end", deliberately, and the
   * gaps that leaves are the point. One past the end would give Review id 3 on
   * a form with no type chosen - and id 3 is already Task List, Questions,
   * External Link or Session Management depending on the type. Making it also
   * mean Review is the same collision that had the strip reporting "External
   * Link: Completed" for a step nobody had opened.
   *
   * A fixed 5 also leaves `FIELD_LOCATIONS`' hardcoded `tab: 4` for consent
   * exactly where it was, which is the other thing a renumber would have
   * broken.
   */
  tabs.push({
    id: REVIEW_STEP_ID,
    key: 'review',
    title: 'Review',
    description: 'Check and confirm'
  });

  return tabs;
};

/**
 * The title of the study a copy came from, or null when it cannot be named.
 *
 * Separate from the study read it accompanies, and allowed to fail quietly,
 * because provenance is not load-bearing: `copied_from_study_id` deliberately
 * has no foreign key, so the source can have been deleted, archived, or simply
 * be unreadable. None of that should stop an opportunity opening - it only
 * changes what the note on screen can say.
 */
/**
 * One sentence for the author out of a schema refusal.
 *
 * The FIRST issue rather than all of them, and phrased as a nudge rather than
 * as a validation error, because this is not the validation surface: D1's
 * error summary is, and it names the step and moves focus. This only has to
 * say enough that "not saved" does not read as "something is broken" - the
 * author is usually mid-sentence in the very field it is about.
 */
const firstSchemaComplaint = (
  error: { issues: { path: (string | number)[] }[] },
  kind: 'survey' | 'recorded'
): string => {
  const path = error.issues[0]?.path ?? [];
  // `steps` and `questions` are the only arrays here, and their index is the
  // one part of the path worth saying out loud - "question 3" locates it,
  // whereas "prompt" on its own does not.
  const index = path.find((segment) => typeof segment === 'number');
  const field = [...path].reverse().find((segment) => typeof segment === 'string');

  if (typeof index === 'number') {
    // "task" or "question" by which vocabulary this study speaks. A recorded
    // task list has tasks; calling them questions describes a surface the
    // author is not looking at.
    const item = kind === 'survey' ? 'question' : 'task';
    return `${item} ${index + 1} needs ${field === 'prompt' ? 'a prompt' : `its ${String(field)}`}`;
  }

  return field ? `${String(field)} is not complete yet` : 'this is not ready to save yet';
};

const resolveSourceTitle = async (studyId: string): Promise<string> => {
  try {
    const source = await getFirstHandStudy(studyId);
    return source.study.title;
  } catch {
    return '';
  }
};

/**
 * The admin authoring form, and only the admin one.
 *
 * It used to take `allowUserSubmission`, a non-admin submission mode threaded
 * through eleven branches here plus BasicInfoTab and save-payload. The only
 * caller that ever passed it true was `ResearchRequestForm`, which nothing
 * imported and no route reached, so every one of those branches was dead.
 * Removed in #46: a non-admin raises research on the service desk instead,
 * which is what Header has always linked to.
 */
const OpportunityForm: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const isEdit = Boolean(id);

  const [formData, setFormData] = useState({
    type: '' as 'test' | 'interview' | 'poll' | 'survey' | 'question' | 'unmoderated' | '',
    title: '',
    purpose_one_liner: '',
    description_optional: '',
    product_optional: '',
    meeting_location_optional: '',
    default_duration_minutes: 30,
    external_link_optional: '',
    participant_type_required: 'any' as 'any' | 'internal' | 'external' | 'specific',
    participant_type_specific_details: '',
    status: 'draft' as 'draft' | 'published',
    start_date: '' as string | undefined,
    end_date: '' as string | undefined,
    firsthand_study_id: '' as string | undefined,
    // Unmoderated study authored inline. The backend creates and launches the
    // study from these on save, so a study is not a separate errand.
    inline_study_target_url: '' as string,
    // Undefined, never 30: an unset duration must stay unset all the way to
    // the database, where the column is nullable and null means "not stated".
    inline_study_duration_minutes: undefined as number | undefined,
    // Whether the duration above is the one B2 derives from the task list.
    // True on create so a new study gets an estimate rather than a blank; set
    // false the moment an existing study is hydrated, because whatever is
    // stored there is what its author decided and re-deriving over it would
    // change a value nobody touched.
    inline_study_duration_auto: true,
    inline_study_consent_text: DEFAULT_CONSENT_TEXT as string,
    // The classification the wording arrived with. A NEW study starts on the
    // current version of its kind's template, because that is literally the
    // text above it. Held in state rather than derived on every render so that
    // a study written against version 1 keeps saying version 1 once a version 2
    // ships - the wording is unchanged, so re-deriving it would reclassify a
    // study nobody touched. The server verifies the claim against the text
    // regardless; this only decides WHICH version it is checked against.
    inline_study_consent_template_id: RECORDED_CONSENT_TEMPLATE.id as string,
    inline_study_consent_template_version:
      RECORDED_CONSENT_TEMPLATE.version as number | null,
    inline_study_steps: [] as WithClientId<InlineStudyStep>[],
    // Native poll and survey. Defaults to external so an author who never opens
    // the choice gets exactly today's behaviour.
    delivery_mode: 'external' as 'native' | 'external',
    inline_survey_duration_minutes: undefined as number | undefined,
    inline_survey_duration_auto: true,
    inline_survey_consent_text: DEFAULT_SURVEY_CONSENT_TEXT as string,
    // The survey twin. Two field pairs rather than one for the same reason
    // there are two consent texts: a type change swaps which pair is live, and
    // a single shared pair would carry the recorded template's id onto a survey.
    inline_survey_consent_template_id: SURVEY_CONSENT_TEMPLATE.id as string,
    inline_survey_consent_template_version:
      SURVEY_CONSENT_TEMPLATE.version as number | null,
    inline_survey_questions: [] as WithClientId<SurveyQuestion>[],
    // Moderated consent (#79): the third consent home, for the two types with
    // no study. Its own field trio for the same reason survey and recorded
    // have theirs - a type change swaps which trio is live, and a shared one
    // would carry the wrong template id across. A NEW moderated opportunity
    // starts on the approved wording; hydration replaces this with whatever
    // the row holds, including nothing.
    moderated_consent_text: DEFAULT_MODERATED_CONSENT_TEXT as string,
    moderated_consent_template_id: MODERATED_CONSENT_TEMPLATE.id as string,
    moderated_consent_template_version:
      MODERATED_CONSENT_TEMPLATE.version as number | null,
    // Where this opportunity's content comes from, replacing the two
    // `reuse_existing_*` booleans. One field rather than two because only one
    // authoring surface is ever rendered - `getTabsForType` returns the task
    // list OR the questions tab, never both - so two flags could only ever
    // disagree, and they did: `loadOpportunity` had to set both together and
    // every read had to pick the right one for its tab.
    //
    // 'blank' is the default because copy is now the ONLY alternative and it
    // has to be asked for. Nothing here is ever sent to the API; it decides
    // which surface renders.
    study_source: 'blank' as StudySourceMode,
    // Provenance. Only `copied_from_study_id` reaches the payload - the other
    // two are what the note on screen says, and are display-only.
    copied_from_study_id: '' as string,
    copied_from_title: '' as string,
    copied_from_at: '' as string
  });

  // Whether the opportunity already pointed at a study when it loaded.
  //
  // This used to be one flag called lockedToExistingStudy that meant two
  // different things at once - "a study is linked" AND "you may not author
  // here" - and the second meaning is what discarded authored content on the
  // way back in: the tab body swapped to the reuse picker, so hydrated steps
  // had nowhere to render. The two are now separate, because a linked study the
  // author OWNS is exactly the thing they should be editing in place.
  //
  // hasLinkedStudy hides the source choice: once an opportunity has content of
  // its own, "where should this come from" has been answered. It is passed to
  // the tabs as `hasLinkedStudy && !studyMissing`, because a dangling link is
  // not content and the author needs the choice back to repair it.
  const [hasLinkedStudy, setHasLinkedStudy] = useState(false);
  // Whether the linked study may not be authored HERE. True when the API says
  // this reader cannot write it, and also when it holds a step type this form
  // cannot represent - see formCanAuthorEveryStep. This flag swaps the tab body
  // to a read-only rendering of the content. Deliberately FALSE for a study
  // that is missing entirely: nothing is there to protect, and read-only would
  // leave that opportunity with no repair path at all.
  const [studyIsReadOnly, setStudyIsReadOnly] = useState(false);
  // WHY it is read-only, because the honest sentence differs and the wrong one
  // sends the author somewhere that will refuse them too. `not-yours` cannot be
  // fixed in the Task Lists area either - StudyEditor applies the same
  // ownership rule - whereas `not-representable` genuinely can. Null when a
  // banner above the tabs already explains it (the study could not be read, or
  // no longer exists), so the tab does not assert a second, wrong cause.
  const [studyReadOnlyReason, setStudyReadOnlyReason] =
    useState<StudyReadOnlyReason>(null);
  // KNOWN GAP, deliberately not closed here. These three are derived once, at
  // load, and are not re-derived if the author then changes `type` or
  // `delivery_mode` in the same session. The reachable case is an EXTERNAL poll
  // carrying a stale firsthand_study_id - the column has no foreign key and
  // nothing clears it - which is deliberately never read (see authoringKind),
  // so flipping it to native leaves the form authoring against a study it never
  // loaded. Every destructive outcome is still refused by the API: 403 for a
  // colleague's study, 400 for a kind mismatch, 400 if a second opportunity
  // links it, 400 if it has answers and the sequence changed. The cost is a raw
  // refusal instead of the read-only surface, which is not worth a re-read that
  // would discard the author's in-progress type change to fix.
  // The linked study's updated_at as it was when this form loaded it. Captured
  // here rather than fetched again later: F1 uses it as a concurrency
  // precondition and D2 sends it with an autosave, and both would otherwise
  // need a second round trip to learn a value this load already had.
  const [linkedStudyUpdatedAt, setLinkedStudyUpdatedAt] = useState<string | null>(null);
  /**
   * How many answers each linked question has already collected, keyed by the
   * `_clientId` its card carries - which is the same value the stored step is
   * identified by, since F2 promoted it to the question's persisted identity.
   *
   * Three states, and the form must keep them apart. A map is a count that was
   * read; `null` is a count that could NOT be read; `undefined` is a form that
   * is not editing a stored study, so nothing on it could have answers. Only
   * the first two mean anything to the author, and only the second warrants
   * saying "could not check".
   *
   * Refreshed by `loadOpportunity`, which runs again after every successful
   * edit save. That is not incidental: a map left stale across a save would go
   * on naming a question that was removed by the save that made it stale, and
   * warn about the same answers on every subsequent save forever.
   */
  const [answerCounts, setAnswerCounts] = useState<
    Record<string, number> | null | undefined
  >(undefined);
  /**
   * The identities of the questions the linked study STORED, as at the last
   * load or save.
   *
   * Held apart from `answerCounts` because it is known in cases where the
   * counts are not, and that asymmetry is the whole point: a removal is
   * detectable from this list alone, so an unreadable count downgrades the
   * warning rather than deleting it. Deriving it from `originalFormData`
   * instead would work today and would tie this warning to a value maintained
   * for change detection, which is free to stop carrying identity.
   */
  const [storedQuestionKeys, setStoredQuestionKeys] = useState<string[]>([]);
  /**
   * The answers a save would detach, while the author is being asked about
   * them. Null means no such confirmation is open.
   */
  const [pendingDetach, setPendingDetach] = useState<DetachedAnswers | null>(null);
  /**
   * Whether the author has just confirmed that summary, for the one save that
   * follows.
   *
   * A ref and not state: confirming resolves by calling `handleSubmit` again in
   * the same tick, and a `setState` would not be visible to it - the save would
   * bounce off its own confirmation forever. Cleared as it is read, so this can
   * never authorise a second save the author was not asked about.
   */
  const detachConfirmedRef = useRef(false);
  /**
   * The linked study's `updated_at` as it stands on the server after a save was
   * refused for being stale, and the banner flag that goes with it.
   *
   * Held APART from `linkedStudyUpdatedAt`, which cannot be reused for this:
   * that value is the remount `key` on `<ConsentStep>`, so advancing it after a
   * conflict would remount the consent step and discard the author's consent
   * edits - the exact loss the conflict was raised to prevent. This one feeds
   * the next save's precondition and nothing else.
   */
  const [staleStudyUpdatedAt, setStaleStudyUpdatedAt] = useState<string | null>(
    null
  );
  /**
   * Whether the last save was refused because somebody else had written the
   * linked study first. Kept out of `error`, which is the dead-end banner: a
   * conflict is recoverable and the banner has to say how.
   */
  const [studyConflict, setStudyConflict] = useState(false);
  // Set when the linked study could not be read. Saving is refused while it is
  // set: the form would otherwise show an empty task list that a save would
  // then write over the real one.
  const [studyLoadError, setStudyLoadError] = useState('');
  // The linked study is GONE - a 404, not a failure to reach it. Distinct from
  // studyLoadError because the answers are opposite: an unreadable study must
  // block every save, a deleted one must not, or the opportunity pointing at it
  // can never be repaired or taken down. See the catch in loadOpportunity.
  const [studyMissing, setStudyMissing] = useState(false);
  // Starts true in edit mode, so the very FIRST paint is the spinner.
  //
  // This used to start false and only become true inside loadOpportunity's
  // effect, which meant one painted frame of a fully interactive but EMPTY
  // form. A value chosen in that frame was replaced wholesale when the load
  // resolved and called setFormData - no error, no warning - and the next save
  // reported success while storing the loaded value instead of the author's.
  // An e2e run hit it about half the time: status set to published on arrival
  // saved as draft, so the study silently never published.
  const [loadingOpportunity, setLoadingOpportunity] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  /** The discard confirmation, open when true. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [error, setError] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  // Whether a refusal is currently being reported. The banner's TEXT is derived
  // from `validationErrors` on every render rather than stored: a second copy
  // goes stale the moment the author fixes a field, leaving a banner naming a
  // field that no longer shows an error. This flag only says whether to show
  // it - fixing the last field empties the message and it disappears on its own.
  const [refusalShown, setRefusalShown] = useState(false);
  // Bumped on every refusal so React remounts the alert. Refusing twice with
  // the same message into the same node repaints nothing and is not re-announced
  // to a screen reader, which reads as another dead button.
  const [refusalCount, setRefusalCount] = useState(0);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [opportunityId, setOpportunityId] = useState<string>('');
  /**
   * The id of a draft THIS session created by autosaving, before the route had
   * one.
   *
   * `useParams` cannot answer this. The form opens at
   * `/admin/opportunities/new` with no id, and the first autosave POSTs a
   * draft and rewrites the URL - but every save after that has to be a PATCH
   * against the row that now exists, and reading the route alone would POST
   * again on every keystroke, minting an opportunity per save. That is the
   * exact failure the "a hundred saves produce one study" criterion is about.
   */
  const [draftId, setDraftId] = useState<string | null>(null);
  /**
   * The stored row this form is editing, whether the route named it or this
   * session created it.
   */
  const persistedOpportunityId = id ?? draftId;
  const isPersisted = Boolean(persistedOpportunityId);
  /**
   * An id this session minted, so the load effect can tell it apart from one
   * the author navigated to.
   *
   * Rewriting the URL makes `useParams().id` appear, which fires the load
   * effect, which rebuilds the entire form from the server - discarding
   * whatever was typed while the create request was in flight. The server has
   * nothing to teach us about a row we wrote a moment ago from the state on
   * screen, so the load is skipped for it. A ref rather than state: the effect
   * has to see the value in the same tick the id changes.
   */
  const selfCreatedIdRef = useRef<string | null>(null);
  const [autosaveState, setAutosaveState] = useState<AutosaveState>({
    inFlight: false,
    lastRequestAt: null,
    lastSavedAt: null,
    consecutiveFailures: 0
  });
  /**
   * The form as it was last successfully stored, as one comparable string.
   *
   * The same instrument the exit guard uses, for the same reason: a list of
   * fields to compare is a list that goes out of date, and this one decides
   * whether somebody's work is on the server.
   */
  const savedSignatureRef = useRef<string | null>(null);
  /** Re-runs the autosave decision when a timer says its moment has come. */
  const [autosaveTick, setAutosaveTick] = useState(0);
  /**
   * The autosave currently in flight, so a deliberate save can wait for it.
   *
   * Two writes in flight at once against the same study is the failure F1
   * exists to catch, arriving from inside one browser tab: whichever lands
   * second carries a precondition the first has already spent, so the author
   * is shown a conflict banner naming a colleague who is themselves. Worse, if
   * the deliberate save wins the race its content is then overwritten by the
   * autosave's older payload.
   *
   * A ref rather than state because `handleSubmit` has to see it in the tick
   * it is called, and nothing renders differently for it.
   */
  const autosaveInFlightRef = useRef<Promise<void> | null>(null);
  /**
   * Whether a DELIBERATE save is running, as a ref rather than as `saving`.
   *
   * `setSaving(true)` is state and is not visible to a second click in the
   * same tick, nor to the autosave timer's decision until a render has
   * happened. Both need a synchronous answer.
   */
  const manualSaveRef = useRef(false);
  /**
   * The body of the last save that SUCCEEDED, so the same one is never sent
   * twice in a row.
   *
   * A backstop rather than an optimisation, and it closes a whole class rather
   * than a bug. Everything that decides whether to fire is a guard, and a
   * guard that stops working leaves a timer whose payload never changes,
   * whose dirty flag therefore never clears, and which fires for ever - a
   * write every five seconds, for as long as the tab is open, spending the
   * shared budget to change nothing.
   *
   * An independent mutation pass found that shape twice, and the way it found
   * it is the point: removing either guard made the test suite HANG rather
   * than fail. In CI that is a job timeout with no named failing test, which
   * is the hardest kind of regression to diagnose. With this in place the same
   * removal produces one save and then silence - an assertion failure with a
   * name.
   */
  const lastSentBodyRef = useRef<string | null>(null);
  /**
   * The server's own sentence when it REFUSED an autosave, as opposed to
   * failing to answer one. Cleared the moment the author changes anything,
   * because the next save is a different request.
   */
  const [autosaveRefusal, setAutosaveRefusal] = useState<string | null>(null);
  /**
   * The form as the SERVER is known to hold it, which is not the same thing as
   * the form as it was LOADED.
   *
   * Two rules inside the payload builder ask "did this request change it" and
   * both used `originalFormData`, which only `loadOpportunity` ever sets. That
   * was sound while the only writer was a save that reloaded afterwards. An
   * autosave writes to the stored row and deliberately never reloads, so the
   * load baseline goes out of date the moment the timer fires - and the rules
   * built on it start answering about a state nobody is in:
   *
   *  - `delivery_mode` is sent only when it differs from the baseline, because
   *    sending it on every save trips the backend's publish and linkage guards
   *    and locks a row out of repair. A poll stored `external`, switched to
   *    Native (autosaved), then switched BACK, matches the stale baseline - so
   *    the key is omitted and the row stays native, serving a survey to people
   *    who were meant to get a handoff.
   *  - a duration CLEARED after being autosaved sends `undefined` rather than
   *    `null`, so the old number stays stored while the field reads blank.
   *
   * Advanced by every successful save with exactly what that save sent, which
   * is honest for these two scalar comparisons in a way that reusing
   * `originalFormData` is not. It is NOT used to decide whether there is
   * anything to save - `savedSignatureRef` does that - and it deliberately
   * does not replace `originalFormData`, which still means "what the server
   * served us" for the round-trip checks that need it.
   */
  const storedFormRef = useRef<SavePayloadFormState | null>(null);

  /*
   * Which opportunity has already had its landing step applied.
   *
   * `loadOpportunity` runs again after a successful save - the form re-reads
   * so a later save lands on the same study - so landing unconditionally with
   * the data would return the author to Basic Information every time they
   * saved. Keyed on the id rather than a bare boolean so that genuinely
   * opening a different opportunity still lands.
   */
  const landedForRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<number>(1);
  /**
   * Steps the author has been on and left, which is what separates "Completed"
   * from "Not started". Validity alone cannot: most steps hold nothing invalid
   * before they hold anything at all, so a blank four-step form would open
   * reporting three steps done.
   *
   * Held by step KEY and not by step id, which is the correction to how this
   * was first written. Id 3 is Task List, Questions, External Link or Session
   * Management depending on the type - so an author who walked to the Task
   * List and then changed the type to an external poll was shown "External
   * Link: Completed" for a step that had not existed a moment earlier. Found
   * in a browser, by doing it; no test had thought to change type mid-walk.
   */
  const [visitedStepKeys, setVisitedStepKeys] = useState<ReadonlySet<StepKey>>(
    () => new Set<StepKey>()
  );
  const [originalFormData, setOriginalFormData] = useState<typeof formData | null>(null);
  /**
   * The step the author is being asked to abandon, held while the confirmation
   * is on screen. `null` means no confirmation is open - not "step 0", which is
   * not a step this form has.
   */
  const [pendingExit, setPendingExit] = useState<string | null>(null);
  /**
   * What the live region says. Set on a step change and read once; the sentence
   * is built from the same labels the strip renders, so the two cannot drift.
   */
  const [stepAnnouncement, setStepAnnouncement] = useState('');
  /**
   * A STORED set the author asked to look at from the reuse picker, or null
   * when the preview is showing this form's own live draft.
   *
   * Held here rather than in the picker because the preview is a page, not a
   * panel: it replaces this component's render, so the picker is not mounted
   * while it is open. Cleared on close and on every live-draft preview, so a
   * stale pick can never be shown as though it were the author's own work.
   */
  const [previewingStoredStudy, setPreviewingStoredStudy] =
    useState<FirstHandStudyWithSteps | null>(null);
  /**
   * Whether the preview currently open was pushed by this form, as against
   * reached by a direct link. Decides whether closing pops or replaces - see
   * `closePreview`. A ref rather than state: nothing renders differently for
   * it, and it must not schedule a render mid-navigation.
   */
  const openedPreviewHere = useRef(false);
  /** The control the preview was opened from, so focus can be handed back. */
  const previewOpener = useRef<HTMLElement | null>(null);

  // Absent means external, matching the column default and every poll and
  // survey that existed before the choice did.
  const deliveryMode = formData.delivery_mode ?? 'external';

  // Define tabs based on opportunity type
  const tabs = getTabsForType(formData.type, deliveryMode);
  // Undefined when the author is on a step this type does not have - reachable,
  // because the step headers are clickable and the type can change underneath.
  const currentStep = tabs.find((tab) => tab.id === activeTab);

  /**
   * The step before the current one, by position in the list rather than by a
   * number written at the call site.
   *
   * Every step body used to hard-code its own `setActiveTab(n)`, five times,
   * and they all happened to agree with the list. They cannot any more: the
   * control now has to NAME the step it goes back to, and a hard-coded number
   * that drifts would send the author somewhere other than the place the button
   * says. First step has none, which is what makes the control disappear.
   */
  const previousStep =
    currentStep && tabs.findIndex((tab) => tab.id === currentStep.id) > 0
      ? tabs[tabs.findIndex((tab) => tab.id === currentStep.id) - 1]
      : undefined;

  /**
   * The backward control's two props, built as ONE value.
   *
   * `StepActions` types them as a present-or-absent pair, so a control cannot
   * exist without naming where it goes. Passed as two separate expressions the
   * compiler cannot see that they are correlated - each is independently
   * `T | undefined` - and rejects them. Spreading one object is how the call
   * site tells it what it already knows.
   */
  const backwardControl = previousStep
    ? { onPrevious: () => setActiveTab(previousStep.id), previousLabel: previousStep.title }
    : {};

  /**
   * The step after the current one, by position rather than by a number
   * written at the call site - the same reason `previousStep` is derived.
   *
   * Undefined on Review and nowhere else, which is what makes Review the step
   * that commits: `StepActions` types "continues" and "submits" as mutually
   * exclusive, so "is there a step after this one" IS the decision about which
   * control this step gets. Four steps used to hard-code `setActiveTab(4)` or
   * `setActiveTab(2)`; with a fifth step on every shape, a hard-coded number
   * and the label above it can disagree, and the label is what the author
   * believes.
   */
  const nextStep =
    currentStep && tabs.findIndex((tab) => tab.id === currentStep.id) >= 0
      ? tabs[tabs.findIndex((tab) => tab.id === currentStep.id) + 1]
      : undefined;

  /**
   * The forward control's two props, built as ONE value for the same reason
   * `backwardControl` is: the compiler cannot see that a label and a handler
   * are correlated when they arrive as two separate expressions.
   *
   * "Continue: {step}" rather than a bare "Continue", mirroring C2's
   * "Previous: {step name}". The plan asked for "Continue"; naming the
   * destination is the same promise kept in both directions, and it makes the
   * label DERIVED - which deletes the mislabel that shipped in B1, where a
   * native poll read "Continue to Link Setup" and then landed on Questions.
   * A hardcoded label can be wrong about where it goes. This one cannot.
   */
  const continueControl = nextStep
    ? {
        nextLabel: `Continue: ${nextStep.title}`,
        onNext: () => {
          // Clears the refusal only - a server error banner is not this
          // button's to erase.
          setRefusalShown(false);
          setActiveTab(nextStep.id);
        }
      }
    : undefined;

  /**
   * Which consent vocabulary this opportunity authors in, or null when it
   * authors no study at all.
   *
   * Derived from the step set rather than from `type` and `deliveryMode`, so it
   * cannot disagree with `getTabsForType` about which shapes have a study - the
   * same reason the Consent step itself is derived there rather than re-tested.
   */
  const authoringKind: AuthoringKind | null = tabs.some((tab) => tab.key === 'questions')
    ? 'survey'
    : tabs.some((tab) => tab.key === 'taskList')
    ? 'recorded'
    : null;

  /**
   * The participant preview, at `<this form's path>/preview`.
   *
   * A CHILD route of this one - see App.tsx. A route rather than a modal
   * because it takes the whole page and Back should close it; a child rather
   * than a sibling because a sibling would unmount this component, and the
   * unsaved draft it holds is the entire thing being previewed.
   */
  const formBasePath = isEdit
    ? `/admin/opportunities/${id}/edit`
    : '/admin/opportunities/new';
  const isPreviewing = useMatch(`${formBasePath}/preview`) !== null;

  const openPreview = (stored: FirstHandStudyWithSteps | null = null) => {
    setPreviewingStoredStudy(stored);
    openedPreviewHere.current = true;
    previewOpener.current = document.activeElement as HTMLElement | null;
    navigate(`${formBasePath}/preview`);
  };

  /**
   * Focus returns to whatever opened the preview, once the form is visible
   * again.
   *
   * It belongs here rather than in a cleanup inside `ParticipantPreview`, and
   * that is not a style preference: React runs a deleted component's effect
   * cleanups during the mutation phase, before sibling DOM updates land, so the
   * form was still `display: none` at that moment and `focus()` did nothing at
   * all - the browser dropped focus to `body` and an author who opened the
   * preview from task seven had to tab through the whole form to get back. A
   * passive effect here runs after the commit that reveals the form, so the
   * element is focusable by the time it is asked to take focus.
   */
  useEffect(() => {
    if (isPreviewing) return;

    const opener = previewOpener.current;
    previewOpener.current = null;
    // Guarded because the control that opened the preview need not still be
    // rendered - the reuse picker's row closes behind its own button.
    if (opener && document.contains(opener)) opener.focus();
  }, [isPreviewing]);

  /**
   * Closing POPS the entry the preview pushed, when this session pushed it.
   *
   * Replacing it unconditionally was the first version, and it made Back a dead
   * key: the entry before the preview is the form too, so an author who pressed
   * Back to leave the form saw nothing happen and had to press it twice.
   * Popping restores the history the author would expect.
   *
   * The ref is what tells the two cases apart. A preview reached by a direct
   * link has no entry to pop - `navigate(-1)` would leave the app - so that one
   * still replaces.
   */
  const closePreview = () => {
    setPreviewingStoredStudy(null);
    if (openedPreviewHere.current) {
      openedPreviewHere.current = false;
      navigate(-1);
      return;
    }
    navigate(formBasePath, { replace: true });
  };

  /**
   * Built at render time rather than memoised.
   *
   * A `useMemo` over the question list would run the contract parser on every
   * keystroke the author makes in the form, for a value read only while the
   * preview route is matched. Calling it here costs nothing on any other render
   * because nothing calls it.
   */
  const buildActivePreview = (): ParticipantPreviewModel => {
    if (previewingStoredStudy) {
      return buildStoredStudyPreview(
        previewingStoredStudy.study,
        previewingStoredStudy.steps
      );
    }

    // The same two fields the server reads for a study's title and intro - see
    // the inline branches of `routes/opportunities.ts`. Taken from live state,
    // not from what was loaded, so an unsaved rewrite of either shows up here.
    const frame = {
      title: formData.title,
      introText: formData.purpose_one_liner
    };

    return authoringKind === 'survey'
      ? buildSurveyPreview({
          ...frame,
          consentText: formData.inline_survey_consent_text,
          questions: formData.inline_survey_questions
        })
      : buildRecordedPreview({
          ...frame,
          consentText: formData.inline_study_consent_text,
          steps: formData.inline_study_steps,
          // Normalised the way the payload builder normalises it, so the host
          // shown is the host that would be stored rather than the raw typing.
          targetUrl: normaliseTargetUrl(formData.inline_study_target_url)
        });
  };

  /**
   * Shared with the content step's own chooser gate, so the two cannot disagree
   * about whether content has been chosen yet. See `isAwaitingCopiedContent`.
   */
  const awaitingCopiedContent = isAwaitingCopiedContent({
    hasLinkedStudy: hasLinkedStudy && !studyMissing,
    studyIsReadOnly,
    sourceMode: formData.study_source,
    copiedFromStudyId: formData.copied_from_study_id
  });

  // Computed once for every save control on every step. A study that could not
  // be read is the reason most easily dropped when this is written out by hand,
  // and dropping it is what lets a save overwrite content the form never had.
  const saveControlsDisabled = saving || !!successMessage || !!studyLoadError;

  /**
   * Whether this save will carry authored content INLINE rather than point at a
   * study by id. Exactly one of the two, never both.
   *
   * Hoisted out of `handleSubmit`, where each was a local named
   * `authoringInline` inside its own type branch, because Review's publish
   * preview has to answer "will the request the server sees carry a study" and
   * the only honest answer is the one the payload builder is about to use. Two
   * copies of that condition is Review promising a save the server refuses -
   * or, worse, staying silent about one it will.
   */
  const authoringInlineStudy =
    !studyIsReadOnly && formData.inline_study_steps.length > 0;
  const authoringInlineSurvey =
    !studyIsReadOnly && formData.inline_survey_questions.length > 0;

  const loadOpportunity = useCallback(async () => {
    if (!id) return;

    try {
      setLoadingOpportunity(true);
      setError('');
      setStudyLoadError('');
      setStudyMissing(false);
      const opportunity = await getOpportunity(id);

      // What the author actually wrote, read back off the linked study.
      //
      // Everything below used to be hardcoded defaults - an empty step list and
      // the boilerplate consent - so reopening an opportunity showed a form
      // that had forgotten its own content. It read as an empty form rather
      // than as loss because the tab body swapped to the reuse picker, so there
      // was no populated surface to notice was missing.
      const authoredFields = {
        inline_study_target_url: '',
        inline_study_duration_minutes: undefined as number | undefined,
        inline_study_duration_auto: true,
        inline_study_consent_text: DEFAULT_CONSENT_TEXT,
        inline_study_consent_template_id: RECORDED_CONSENT_TEMPLATE.id as string,
        inline_study_consent_template_version:
          RECORDED_CONSENT_TEMPLATE.version as number | null,
        inline_study_steps: [] as WithClientId<InlineStudyStep>[],
        inline_survey_duration_minutes: undefined as number | undefined,
        inline_survey_duration_auto: true,
        inline_survey_consent_text: DEFAULT_SURVEY_CONSENT_TEXT,
        inline_survey_consent_template_id: SURVEY_CONSENT_TEMPLATE.id as string,
        inline_survey_consent_template_version:
          SURVEY_CONSENT_TEMPLATE.version as number | null,
        inline_survey_questions: [] as WithClientId<SurveyQuestion>[],
        // Deliberately 'blank' once content is hydrated. The source choice is
        // about where content came FROM at authoring time; an opportunity being
        // reopened already has its content, and leaving this on 'copy' would
        // show the author a chooser instead of what they wrote.
        study_source: 'blank' as StudySourceMode,
        copied_from_study_id: '',
        copied_from_title: '',
        copied_from_at: ''
      };
      let readOnly = false;
      let readOnlyReason: StudyReadOnlyReason = null;
      let studyUpdatedAt: string | null = null;
      /**
       * Undefined until a study is actually read. An opportunity with no linked
       * study, or one whose study could not be loaded at all, has no stored
       * question that could hold an answer - which is a different thing from a
       * study whose answers could not be counted, and the removal warning says
       * something different about each.
       */
      let studyAnswerCounts: Record<string, number> | null | undefined;

      // The vocabulary this opportunity's form authors in, or null when it
      // authors nothing. An external poll can carry a study id it no longer
      // uses - the column has no foreign key and nothing clears it when the
      // delivery mode changes - and reading a study the form will never render
      // would make a failed fetch block a save that has nothing to do with it.
      const authoringKind: AuthoringKind | null =
        opportunity.type === 'unmoderated'
          ? 'recorded'
          : runsNativeSurvey(opportunity.type, opportunity.delivery_mode)
            ? 'survey'
            : null;

      if (opportunity.firsthand_study_id && authoringKind) {
        try {
          const linked = await getFirstHandStudy(opportunity.firsthand_study_id);
          const kind = linked.study.kind === 'survey' ? 'survey' : 'recorded';
          const authored = authoredStepsOf(linked.steps);

          studyUpdatedAt = linked.study.updated_at ?? null;
          // Carried through as-is, all three states of it.
          //
          // A map is a count that was read. `null` is a count that could not be
          // established, and the removal dialog says so. ABSENT is neither: the
          // route withholds counts it will not serve - a study nobody owns, a
          // recorded task list - and a backend older than the field sends
          // nothing either. Both mean "no count is on offer", and the form says
          // nothing about answers rather than claiming a check it never made.
          //
          // `?? null` here is what put the cautious wording on every card of
          // every unowned legacy survey, including cards minted seconds earlier
          // that provably cannot have answers.
          studyAnswerCounts = linked.answer_counts;
          // Absent means "not stated", not false: create and update responses
          // do not carry can_edit, and treating a missing value as a refusal
          // would lock the author out of their own study.
          if (linked.can_edit === false) {
            readOnlyReason = 'not-yours';
          } else if (
            // A recorded task list linked to a native survey, or the reverse.
            // The two vocabularies are different, so the wrong surface would
            // show an EMPTY editor for a study that is not empty - and the API
            // refuses the mismatch on save anyway.
            kind !== authoringKind ||
            // The general rule, replacing a step-type check that only caught
            // one of the ways this form could fail to reproduce a study. See
            // studyRoundTripsCleanly: anything it would drop, flatten or
            // rewrite makes the study read-only rather than partially loaded.
            !studyRoundTripsCleanly(linked.steps, kind, linked.study.id)
          ) {
            readOnlyReason = 'not-representable';
          }
          readOnly = readOnlyReason !== null;

          if (kind === 'survey') {
            // withStoredIdentity, not withClientIds: an EDIT must carry each
            // question's stored identity into the form, so that reordering and
            // saving writes the same step ids back and every answer already
            // collected stays attached to the question that produced it. A COPY
            // is the opposite case and still mints fresh ids - see
            // copiedSurveyFields.
            authoredFields.inline_survey_questions = withStoredIdentity(
              authored.map(toSurveyQuestion),
              authored,
              linked.study.id
            );
            authoredFields.inline_survey_consent_text = linked.study.consent_text;
            authoredFields.inline_survey_consent_template_id =
              linked.study.consent_template_id ?? CUSTOM_CONSENT_TEMPLATE_ID;
            authoredFields.inline_survey_consent_template_version =
              linked.study.consent_template_version ?? null;
            authoredFields.inline_survey_duration_minutes =
              linked.study.estimated_duration_minutes ?? undefined;
            // Stored, therefore decided - including a stored NULL, which says
            // "tell the participant no length". Re-deriving an estimate over
            // either would rewrite a value the author did not touch, on a save
            // about something else entirely.
            authoredFields.inline_survey_duration_auto = false;
          } else {
            // Same rule as the survey twin above.
            authoredFields.inline_study_steps = withStoredIdentity(
              authored.map(toInlineStudyStep),
              authored,
              linked.study.id
            );
            authoredFields.inline_study_consent_text = linked.study.consent_text;
            // A stored NULL is a row whose provenance was never established -
            // migration 0013 classified everything it could and left the rest
            // NULL rather than guessing. Reading that as `custom` is the safe
            // direction: it shows the author "this wording is not the approved
            // wording" for something nobody checked, where the other default
            // would put an approval badge on it.
            authoredFields.inline_study_consent_template_id =
              linked.study.consent_template_id ?? CUSTOM_CONSENT_TEMPLATE_ID;
            authoredFields.inline_study_consent_template_version =
              linked.study.consent_template_version ?? null;
            authoredFields.inline_study_duration_minutes =
              linked.study.estimated_duration_minutes ?? undefined;
            // Same rule as the survey twin above.
            authoredFields.inline_study_duration_auto = false;
            // The study-level starting URL. Read with the runtime's own
            // resolver rather than a second "first step carrying a target"
            // rule: toStudySteps writes target_url onto EVERY authored step,
            // and a private rule here would be free to disagree with the one
            // the participant's runner actually follows.
            authoredFields.inline_study_target_url =
              getPrimaryTargetUrl(linked.steps) ?? '';
          }

          // Where this study's content came from, if it came from anywhere.
          // Written once at create and never updated, so it is a fact about
          // this study rather than about the current session - which is why it
          // is shown on reopen and not only at the moment the copy is taken.
          if (linked.study.copied_from_study_id) {
            authoredFields.copied_from_study_id = linked.study.copied_from_study_id;
            authoredFields.copied_from_at = linked.study.created_at ?? '';
            // Resolved separately, and allowed to fail: there is deliberately
            // no foreign key, so a source can be deleted. The note degrades to
            // "a set that no longer exists" rather than disappearing, because
            // the copy happened whether or not its source still does.
            authoredFields.copied_from_title = await resolveSourceTitle(
              linked.study.copied_from_study_id
            );
          }
        } catch (studyError) {
          const status = (studyError as { response?: { status?: number } })?.response?.status;
          // A 404 is not a transient failure, and treating it as one bricks
          // the opportunity.
          //
          // `firsthand_study_id` has no foreign key and studies can be
          // deleted, so a dangling link is a reachable state. Refusing every
          // save for it left the opportunity uneditable through the only UI
          // that can write one - it could not be retitled, repointed at
          // another study, or even UNPUBLISHED, while it went on serving a
          // study that no longer exists. Delete was the only way out.
          //
          // A0's route already repairs this: an in-place update whose study
          // has vanished falls through to minting a replacement. What asks for
          // that repair is authored content, so a MISSING study must leave the
          // authoring surface OPEN - see `readOnly` below.
          const missing = status === 404;
          logger.error('Could not load the linked study for editing', {
            opportunityId: opportunity.id,
            studyId: opportunity.firsthand_study_id,
            status,
            missing,
            error: studyError instanceof Error ? studyError.message : String(studyError)
          });

          if (missing) {
            setStudyMissing(true);
          } else {
            // Everything else - a network failure, a 5xx, studies persistence
            // unconfigured - may well be a study that still exists and still
            // has content. The form is showing default consent and an empty
            // list because the read failed, and A0 would write exactly that
            // over the real thing, so no save is allowed until it succeeds.
            setStudyLoadError(
              'The linked task list or questions could not be loaded, so this opportunity cannot be saved right now. Reload the page to try again.'
            );
          }

          // readOnlyReason stays null: a banner above the tabs already says
          // what happened, and the tab asserting "it belongs to another
          // researcher, or uses a step type this form cannot show" would be
          // two wrong causes for one right outcome.
          //
          // A MISSING study is deliberately NOT read-only, and the distinction
          // is the whole repair path. Read-only was right while the picker was
          // the read-only branch's fallback: a dangling link could be repointed
          // at another study. B3 deletes the picker, so read-only here would
          // leave an author with a 404'd opportunity, no control of any kind on
          // the tab, and a banner telling them to pick something that is not
          // there - repairable only by deleting the opportunity.
          //
          // There is nothing to protect: the study is gone, so no content can
          // be overwritten and no owner can be trodden on. Leaving the surface
          // open lets the author write a task list or copy one, which sends
          // `inline_*`, which is exactly what A0's fallback mint needs to
          // replace the dead link.
          //
          // The OTHER branch keeps read-only, and must: `studyLoadError` means
          // the study still exists and could not be read, so authoring over it
          // would destroy content that is really there.
          readOnly = !missing;
        }
      }

      /*
       * Where the author lands, chosen with the content rather than after it.
       *
       * MUST STAY ABOVE `setFormData`. Automatic batching makes the two one
       * commit today, but the statement ORDER is the load-bearing guarantee,
       * not the batching: if anything ever puts a task boundary between them,
       * the intermediate commit holds the landing id against a form whose type
       * is still blank. That shape is `[1, 2, 5]`, so the `stepAfterShapeChange`
       * clamp below rewrites an id of 3 to 2 - and once the real type arrives, 2
       * is a valid member, so nothing corrects it back. The author lands on the
       * wrong step, permanently, with no error. `loadOpportunity` already awaits
       * mid-function, so this is an ordinary edit away.
       *
       * Read off the SHAPE by key rather than restating `type === 'test' ||
       * type === 'interview' ? 3 : 1`. Id 3 is Task List, Questions, External
       * Link or Session Management depending on the type, so a hardcoded 3 asks
       * for a position and hopes it still means what it meant. `getTabsForType`
       * makes the same argument about Consent a few lines down: a predicate
       * saying the same thing in different words is a predicate that can stop
       * agreeing. A future type that grows a sessions step gets the right
       * landing for free.
       *
       * ONCE per opportunity: this function also runs on the re-read after a
       * save, and landing again there would throw the author back to the first
       * step every time they saved.
       */
      if (landedForRef.current !== opportunity.id) {
        landedForRef.current = opportunity.id;
        const shape = getTabsForType(
          opportunity.type,
          opportunity.delivery_mode ?? 'external'
        );
        setActiveTab((shape.find((step) => step.key === 'sessions') ?? shape[0]).id);
      }

      setFormData({
        type: opportunity.type,
        title: opportunity.title,
        purpose_one_liner: opportunity.purpose_one_liner,
        description_optional: opportunity.description_optional || '',
        product_optional: opportunity.product_optional || '',
        meeting_location_optional: opportunity.meeting_location_optional || '',
        default_duration_minutes: opportunity.default_duration_minutes,
        external_link_optional: opportunity.external_link_optional || '',
        firsthand_study_id: opportunity.firsthand_study_id || '',
        participant_type_required: opportunity.participant_type_required || 'any',
        participant_type_specific_details: opportunity.participant_type_specific_details || '',
        status: opportunity.status === 'closed' ? 'draft' : opportunity.status,
        start_date: opportunity.start_date || '',
        end_date: opportunity.end_date || '',
        // Moderated consent (#79): what the ROW holds, never the default. A row
        // without wording hydrates empty - seeding the default here would make
        // any unrelated save silently add consent nobody wrote. The template
        // pair rides as stored; the server re-verifies any claim on save
        // regardless.
        moderated_consent_text: opportunity.consent_text || '',
        moderated_consent_template_id:
          opportunity.consent_template_id || CUSTOM_CONSENT_TEMPLATE_ID,
        moderated_consent_template_version:
          opportunity.consent_template_version ?? null,
        // Read from the linked study rather than defaulted. See authoredFields.
        ...authoredFields,
        // Read from the row rather than defaulted, so editing a native survey
        // does not silently switch it back to an external handoff on save.
        delivery_mode: opportunity.delivery_mode ?? 'external'
      });

      setHasLinkedStudy(Boolean(opportunity.firsthand_study_id));
      setAnswerCounts(studyAnswerCounts);
      setStoredQuestionKeys(
        (authoredFields.inline_survey_questions ?? []).map((question) => question._clientId)
      );
      setStudyIsReadOnly(readOnly);
      setStudyReadOnlyReason(readOnlyReason);
      setLinkedStudyUpdatedAt(studyUpdatedAt);
      setOpportunityId(opportunity.id);

      // Store original form data for change detection
      const originalData = {
        type: opportunity.type,
        title: opportunity.title,
        purpose_one_liner: opportunity.purpose_one_liner,
        description_optional: opportunity.description_optional || '',
        product_optional: opportunity.product_optional || '',
        meeting_location_optional: opportunity.meeting_location_optional || '',
        default_duration_minutes: opportunity.default_duration_minutes,
        external_link_optional: opportunity.external_link_optional || '',
        firsthand_study_id: opportunity.firsthand_study_id || '',
        participant_type_required: opportunity.participant_type_required || 'any' as const,
        participant_type_specific_details: opportunity.participant_type_specific_details || '',
        status: opportunity.status === 'closed' ? 'draft' as const : opportunity.status as 'draft' | 'published',
        start_date: opportunity.start_date || '',
        end_date: opportunity.end_date || '',
        moderated_consent_text: opportunity.consent_text || '',
        moderated_consent_template_id:
          opportunity.consent_template_id || CUSTOM_CONSENT_TEMPLATE_ID,
        moderated_consent_template_version:
          opportunity.consent_template_version ?? null,
        // Seeded from the SERVER's state, not from the defaults. Seeding the
        // baseline from a fiction made hasChanges compare the author's content
        // against an empty list, so simply opening an opportunity looked like
        // an unsaved change - and a real edit back to the stored value looked
        // like none. Deep-copied, so editing a step in formData cannot mutate
        // the baseline it is compared against.
        ...structuredClone(authoredFields),
        // Read from the row rather than defaulted, so editing a native survey
        // does not silently switch it back to an external handoff on save.
        delivery_mode: opportunity.delivery_mode ?? 'external'
      };
      setOriginalFormData(originalData);
      /**
       * The autosave baseline, stamped from the SAME object the change
       * comparison uses.
       *
       * Until this is set the ref is null and no autosave can fire, which is
       * deliberate rather than incidental: an edit form is fully typeable
       * while its load is still in flight, and a baseline seeded from the
       * blank initial state would read as "everything has changed" and write
       * an empty form over a real opportunity, on a timer, before the author
       * had seen its content.
       */
      savedSignatureRef.current = dirtySignature(originalData);
      storedFormRef.current = originalData;

      // Load sessions - always try to load fresh sessions from API when editing
      // The opportunity object might have stale session data
      try {
        logger.debug('EDIT MODE - Loading sessions for opportunity', {
          opportunityId: opportunity.id,
          opportunitySessionsCount: opportunity.sessions?.length || 0,
          willCallAPI: true
        });

        // IMPORTANT: Always request ALL sessions including past ones when editing
        const sessions = await getSessions(opportunity.id, { include_past: true });

        logger.debug('EDIT MODE - Loaded opportunity sessions from API', {
          opportunityId: opportunity.id,
          sessionsCount: sessions.length,
          sessions: sessions.map(s => ({
            id: s.id,
            start_time: s.start_time,
            end_time: s.end_time,
            capacity: s.capacity,
            booked_count: s.booked_count,
            opportunity_id: s.opportunity_id
          })),
          opportunitySessionsCount: opportunity.sessions?.length || 0
        });

        if (sessions.length > 0) {
          setSessions(sessions);
        } else if (opportunity.sessions && opportunity.sessions.length > 0) {
          // Fallback to sessions from opportunity object if API returns empty but opportunity has sessions
          logger.debug('API returned no sessions, using sessions from opportunity object', {
            opportunityId: opportunity.id,
            sessionsCount: opportunity.sessions.length
          });
          setSessions(opportunity.sessions);
        } else {
          logger.debug('No sessions found for opportunity', { opportunityId: opportunity.id });
          setSessions([]);
        }
      } catch (sessionError: unknown) {
        const axiosError = sessionError as { response?: { data?: unknown; status?: number } };
        logger.error('Error loading sessions', {
          error: sessionError instanceof Error ? sessionError : undefined,
          errorMessage: sessionError instanceof Error ? sessionError.message : String(sessionError),
          response: axiosError.response?.data,
          status: axiosError.response?.status
        });

        // Fallback to sessions from opportunity object if API fails
        if (opportunity.sessions && opportunity.sessions.length > 0) {
          logger.debug('Using sessions from opportunity object as fallback', {
            opportunityId: opportunity.id,
            sessionsCount: opportunity.sessions.length
          });
          setSessions(opportunity.sessions);
        } else {
          setSessions([]);
        }
      }
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number; data?: { error?: string } } };
      if (axiosError.response?.status === 404) {
        setError('Opportunity not found. It may have been deleted or you may not have permission to edit it.');
      } else {
        setError('Failed to load opportunity');
      }
    } finally {
      setLoadingOpportunity(false);
    }
    // Only the route id: everything else it touches is a setter.
  }, [id]);

  /**
   * A create has no server baseline to load, so its baseline is the empty form
   * it opened as - stamped once, on mount.
   *
   * Without this the ref stays null and autosave never fires at all on the
   * path it was mainly built for.
   */
  useEffect(() => {
    if (isEdit) return;
    if (savedSignatureRef.current !== null) return;
    savedSignatureRef.current = dirtySignature(openingFormData.current);
    // Refs only besides `isEdit`, so there is nothing else to depend on.
  }, [isEdit]);

  useEffect(() => {
    // Skipped for an id THIS session just created by autosaving. Rewriting the
    // URL makes `id` appear, which would otherwise rebuild the whole form from
    // the server and discard everything typed while the create request was in
    // flight - on the one feature whose entire purpose is not losing
    // keystrokes. The server holds exactly what we sent it a moment ago.
    if (isEdit && id && selfCreatedIdRef.current !== id) {
      loadOpportunity();
    }
  }, [isEdit, id, loadOpportunity]);

  // Ensure activeTab is valid when the type - or the delivery mode, which also
  // decides the tab set - changes.
  //
  // Lands on the LAST step the new shape has, rather than on the first.
  //
  // DEFENCE ONLY, and worth saying so plainly rather than implying coverage
  // that cannot exist: both things that change the step set - the type selector
  // and the delivery-mode choice - live on step 1, so `activeTab` is 1 whenever
  // either of them fires and the condition below is unreachable through the UI.
  // No test can drive it, and an independent mutation pass duly found the
  // change from `1` to `maxTabId` survives. It stays because the step set is
  // being reshaped step by step through this plan, and the day something moves
  // one of those controls, sending an author who has filled in three steps back
  // to the top is a worse answer than leaving them on the last step that still
  // exists. Neither loses input; one loses their place.
  useEffect(() => {
    const shape = getTabsForType(formData.type, deliveryMode);
    const landing = stepAfterShapeChange(shape, activeTab);
    if (landing === activeTab) {
      return;
    }
    /*
     * A MEMBERSHIP check, not `activeTab > maxTabId`.
     *
     * DEFENCE ONLY, like the two guards in `handleSubmit`, and it is worth
     * saying which failure it defends against because it is not the obvious
     * one. Both controls that reshape the step set - the type and the delivery
     * mode - live on step 1, so an author cannot reshape it while standing on a
     * step the new shape lacks. Nothing here is reachable today.
     *
     * What changed is that the OLD guard would have become permanently dead.
     * It asked whether `activeTab` was too LARGE, which was a true proxy for
     * "not in the list" only while the ids were contiguous and the last one
     * moved with the shape. Review is a fixed 5, so the largest id is now a
     * constant and `activeTab > 5` can never hold - and the failure it was
     * catching, a step body whose render guard is false and therefore shows
     * nothing at all, would have gone from guarded to silent. Restating it as
     * the question it always meant costs a predicate and keeps that class of
     * blank page out of every future change to the step set.
     *
     * The choice of WHERE to land lives in `stepAfterShapeChange`, above, so
     * that it can be tested even though this guard cannot be reached.
     */
    setActiveTab(landing);
  }, [formData.type, deliveryMode, activeTab]);

  /**
   * Record the step the author just left.
   *
   * Written as an effect on `activeTab` rather than inside a `goToStep` helper
   * on purpose: there are eleven places that move the author between steps -
   * five Continue handlers, five Back controls, the strip itself, plus two
   * effects that reposition on load - and a helper only covers the ones that
   * remember to call it. Watching the value covers all of them, including any
   * added after this.
   *
   * Only the step being LEFT is recorded. The one being arrived at is not
   * visited yet; it becomes visited when it is left in turn.
   */
  const stepBeforeThisRender = useRef<StepKey | null>(null);
  useEffect(() => {
    const left = stepBeforeThisRender.current;
    const arrived = currentStep?.key ?? null;
    if (arrived === null || left === arrived) {
      return;
    }
    stepBeforeThisRender.current = arrived;
    if (left === null) {
      return;
    }
    setVisitedStepKeys((previous) => {
      if (previous.has(left)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(left);
      return next;
    });
  }, [currentStep?.key]);

  /**
   * An opportunity being EDITED has been through every step already - its
   * content is on the server. Reporting three of its four steps as "Not
   * started" would be false, and worse than saying nothing, so the whole set is
   * marked visited once the load has produced its baseline. From then on each
   * step reports Completed or Needs attention on the same rules as a new one.
   *
   * Keyed on `originalFormData` rather than on `isEdit`, because `isEdit` is
   * true from the first render, long before anything has been read back.
   */
  useEffect(() => {
    if (!originalFormData) {
      return;
    }
    setVisitedStepKeys(
      (previous) => new Set([...previous, ...getTabsForType(
        originalFormData.type,
        originalFormData.delivery_mode ?? 'external'
      ).map((tab) => tab.key)])
    );
  }, [originalFormData]);

  /*
   * The landing step is chosen in `loadOpportunity`, with the content - NOT in
   * an effect keyed on the loaded values, which is what an effect here used to
   * be. See the note beside the code there for why that shape undid the
   * author's own navigation and threw them off their step mid-edit.
   */



  // Named for what it returns, not for a verdict: it hands back the errors so
  // the caller can name the failing fields and open the tab that holds them.
  // `if (!validateForm())` was the old shape and is legal TypeScript against a
  // record - always false, so it would submit every invalid payload - and the
  // name is the only thing that makes that misuse look wrong. Reading the
  // errors back off `validationErrors` is not an option either: that is the
  // pre-update state from this closure, which is what the old log line
  // reported.
  const computeValidationErrors = useCallback((): Record<string, string> => {
    const errors: Record<string, string> = {};

    // Validate research study type
    if (!formData.type) {
      errors.type = 'Choose a research study type';
    }

    if (!formData.title.trim()) {
      errors.title = 'Enter a title';
    } else if (formData.title.trim().length < 4) {
      errors.title = 'Enter a title of at least 4 characters';
    } else if (formData.title.trim().length > 140) {
      errors.title = 'Shorten the title to 140 characters or fewer';
    }

    if (!formData.purpose_one_liner.trim()) {
      errors.purpose_one_liner = 'Enter a purpose';
    } else if (formData.purpose_one_liner.trim().length < 10) {
      errors.purpose_one_liner = 'Enter a purpose of at least 10 characters';
    } else if (formData.purpose_one_liner.trim().length > 180) {
      errors.purpose_one_liner = 'Shorten the purpose to 180 characters or fewer';
    }

    // Only validate meeting location and duration for test and interview type opportunities
    if (formData.type === 'test' || formData.type === 'interview') {
      if (!formData.meeting_location_optional || !formData.meeting_location_optional.trim()) {
        errors.meeting_location_optional = 'Enter where the session takes place';
      }
      // Moderated consent (#79) is OPTIONAL - a session that stores nothing
      // needs no consent, and emptiness is how the author says so - so the
      // only failure the field has is length, the same ceiling the server
      // refuses over; validating here keeps the refusal on the step that owns
      // the control.
      // Trimmed, because the server schema trims before measuring - an
      // untrimmed check here refused text the server would accept.
      if (formData.moderated_consent_text.trim().length > VALIDATION.MAX_MODERATED_CONSENT_CHARS) {
        errors.moderated_consent_text =
          `Shorten the consent wording to ${VALIDATION.MAX_MODERATED_CONSENT_CHARS} characters or fewer`;
      }
      // Number.isFinite first: clearing the field stores NaN (parseInt('')), and
      // NaN < 5 and NaN > 240 are BOTH false, so an empty duration passed every
      // check here and failed as an opaque 400 at the API instead.
      if (
        !Number.isFinite(formData.default_duration_minutes) ||
        formData.default_duration_minutes < 5 ||
        formData.default_duration_minutes > 240
      ) {
        errors.default_duration_minutes =
          'Enter a session length between 5 and 240 minutes';
      }
    }

    if (formData.status === 'published' && formData.type === 'unmoderated') {
      // VALIDATE WHAT YOU SEND. The only state that still sends
      // `firsthand_study_id` is a linked study this form may not author, so
      // that is the only state whose presence is checked here. Copy mode sends
      // `inline_study` and never the id - checking the id there would refuse
      // every save over a field the payload does not carry.
      if (studyIsReadOnly) {
        if (!formData.firsthand_study_id?.trim()) {
          errors.firsthand_study_id =
            'Add a task list before publishing - this opportunity has none';
        }
      } else if (formData.inline_study_steps.length === 0) {
        // Named against the thing the author does, not the object model. The
        // backend rejects the same state with an equivalent message.
        errors.inline_study_steps =
          formData.study_source === 'copy'
            ? 'Choose a task list to start from, or switch to writing the tasks here'
            : 'Add at least one task before publishing';
      }
    } else if (
      formData.status === 'published' &&
      runsNativeSurvey(formData.type, deliveryMode)
    ) {
      // A natively-answered opportunity needs its questions, not a link.
      // Mirrors the backend guard, which refuses the same state.
      // The recorded twin's reasoning applies here unchanged.
      if (studyIsReadOnly) {
        if (!formData.firsthand_study_id?.trim()) {
          errors.firsthand_study_id =
            'Add questions before publishing - this opportunity has none';
        }
      } else if (formData.inline_survey_questions.length === 0) {
        errors.inline_survey_questions =
          formData.study_source === 'copy'
            ? 'Choose a set of questions to start from, or switch to writing them here'
            : 'Add at least one question before publishing';
      }
    } else if (
      formData.status === 'published' &&
      QUESTION_CARRYING_TYPES.has(formData.type)
    ) {
      // Reached only by a hand-off: the native arm above catches every shape
      // that answers in Cortex, so this never asks a native question for a
      // link. Same ordering as `findPublishProblem`, which this previews.
      if (!formData.external_link_optional?.trim()) {
        errors.external_link_optional =
          'Enter the link participants will follow to take part';
      }
    } else if (
      formData.status === 'published' &&
      (formData.type === 'test' || formData.type === 'interview')
    ) {
      // Audit row 15: a live session or an interview is taken by BOOKING a slot.
      // Published with none, it appears on the dashboard as LIVE and on the
      // participant home as "Book a time" with nothing bookable behind it, and
      // Review reports the study Completed. `sessions` holds the slots the
      // author has added (temporary and persisted alike), so gate publish on
      // there being at least one - which also flips the Session Management step
      // off "Completed" while it is empty.
      //
      // This client gate is the fast half: it blocks the commit and flips the
      // Session Management chip off "Completed" before any request. The server
      // now enforces the same rule (cto/AdaptaLabs#118 - a `bookable_slot_required`
      // branch in `findPublishProblem`, the wizard's slots-before-publish
      // reorder in `handleSubmit`, and the Review preview via `publishRefusal`),
      // so a direct-API publish of a slotless test/interview is refused too.
      if (sessions.length === 0) {
        errors.sessions =
          'Add at least one session slot before publishing a live session or interview';
      }
    }

    /*
     * Whether the link is WELL FORMED is not publish-gated, and the asymmetry
     * with the required check above is deliberate.
     *
     * The server's schema refuses a bad scheme on every write, draft included -
     * it is a schema, it does not know the status. So gating the client's copy
     * on `status === 'published'` left the repair path broken in exactly the
     * case that matters: a DRAFT holding a `javascript:` link stored before the
     * schema was hardened. The form resends that value on every save
     * (`external_link_optional: formData.external_link_optional.trim() ||
     * undefined`), so the author would have got an opaque "Validation failed"
     * from the endpoint, naming no field, on a row they were trying to fix.
     *
     * Presence is a publishing rule. Well-formedness is a property of the
     * value.
     */
    if (
      /*
       * Only where the author can actually SEE the field. Flagging a value on a
       * shape whose step list has no External Link step blocks every save and
       * sends the author to a step that does not contain it.
       *
       * `getTabsForType(...)` rather than the `tabs` const from the render:
       * this is a `useCallback`, and `tabs` is rebuilt every render, so closing
       * over it would either defeat the memo or leave a dependency the lint rule
       * is right to want. The function is pure and at module scope, so calling
       * it here depends only on the two values that decide the shape - both
       * already dependencies.
       */
      getTabsForType(formData.type, deliveryMode).some(
        (step) => step.key === 'externalLink'
      ) &&
      formData.external_link_optional.trim() &&
      !isPublishableExternalLink(formData.external_link_optional)
    ) {
      errors.external_link_optional = EXTERNAL_LINK_PROTOCOL_MESSAGE;
    }

    // Emptying an authored list is a deliberate instruction, and it used to be
    // answered by doing nothing.
    //
    // `authoringInline` requires at least one step, so deleting them all made
    // the payload fall back to sending the study id: the study kept every task,
    // the save reported success, and reopening brought them all back. Removing
    // one is never disabled, so this was one click away on a draft - the
    // publish checks above only cover a published opportunity.
    //
    // Standalone rather than another arm of the chain above, which is keyed on
    // status and type: these two are about a LINKED study being emptied, which
    // is a different question and must not depend on which arm ran first.
    // `!studyMissing` matters as much as the other two. This guard is about a
    // linked list that EXISTS and has been emptied; a study that has been
    // deleted has no content to empty, and refusing the save for it would take
    // away the very repair path the 404 branch of loadOpportunity opens up -
    // the author could not retitle, unpublish, or author a replacement.
    if (hasLinkedStudy && !studyIsReadOnly && !studyMissing) {
      if (
        formData.type === 'unmoderated' &&
        formData.inline_study_steps.length === 0
      ) {
        errors.inline_study_steps =
          'A task list needs at least one task. Add one, or delete the opportunity if you no longer need it';
      }

      if (
        runsNativeSurvey(formData.type, deliveryMode) &&
        formData.inline_survey_questions.length === 0
      ) {
        errors.inline_survey_questions =
          'A set of questions needs at least one question. Add one, or delete the opportunity if you no longer need it';
      }
    }

    // Gated exactly like the task-list loop below: only when these questions
    // are the thing being authored. Ungated, a question abandoned before the
    // author switched to an external tool refused every later save, naming a
    // field on a tab that is no longer rendered.
    const authoringQuestions =
      runsNativeSurvey(formData.type, deliveryMode) && !studyIsReadOnly;

    (authoringQuestions ? formData.inline_survey_questions : []).forEach((question, index) => {
      if (!question.prompt.trim()) {
        // Numbered, because a summary link is the author's only route to a card
        // that may be collapsed and below the fold. "Add what the participant
        // is asked" named no question, so a list of six of them said the same
        // sentence six times and none of them said which one to open.
        //
        // The number is a PLACEHOLDER, not the index. Baking `index + 1` in
        // here froze it: `remapAuthoringErrors` moves an error's key when its
        // item moves but carries the message through verbatim, so after a
        // reorder the card labelled "1." read "Enter the text for question 3".
        // Both renderers substitute from the live key instead.
        errors[`inline_survey_questions.${index}.prompt`] =
          question.type === 'instruction'
            ? `Enter what the participant reads at question ${POSITION_PLACEHOLDER}`
            : `Enter the text for question ${POSITION_PLACEHOLDER}`;
      }

      if (question.type === 'single_choice' || question.type === 'multi_choice') {
        const answers = (question.options ?? []).map((o) => o.trim()).filter(Boolean);
        if (answers.length < 2) {
          errors[`inline_survey_questions.${index}.options`] =
            `Enter at least two answers for question ${POSITION_PLACEHOLDER}`;
        }
      }

      // The number input's own min/max never runs: every save control in
      // this form is type="button" and calls handleSubmit directly, so the
      // browser never validates the form. Without this rule the contract
      // refuses the save instead, naming config on a step the form numbers
      // differently.
      if (question.type === 'rating') {
        const scale = question.config?.scale_max;
        if (
          scale === undefined ||
          !Number.isInteger(scale) ||
          scale < RATING_SCALE_BOUNDS.min ||
          scale > RATING_SCALE_BOUNDS.max
        ) {
          errors[`inline_survey_questions.${index}.config`] =
            `Set a scale between ${RATING_SCALE_BOUNDS.min} and ${RATING_SCALE_BOUNDS.max} points for question ${POSITION_PLACEHOLDER}`;
        }
      }
    });

    if (
      authoringQuestions &&
      formData.inline_survey_questions.length > 0 &&
      !formData.inline_survey_consent_text.trim()
    ) {
      errors.inline_survey_consent_text =
        'Enter the consent text participants agree to';
    }

    // The input carries min={1}, and the browser used to enforce it on this
    // tab and only this tab, because its forward control was the form's one
    // real submit button. Nothing submits this form implicitly now, so the
    // rule lives here - otherwise a negative or fractional length reaches the
    // API, which refuses it as `estimated_duration_minutes` and never names
    // the field the author typed in. Integers, because the contract is
    // `.int()` and the input's implicit step is 1.
    //
    // Gated on the override, because the override is the only thing this rule
    // can be ABOUT. While the automatic estimate is in force the payload sends
    // the estimate and ignores this field entirely, so validating it refuses a
    // save over a value nothing will send - and the banner then sends the
    // author to a read-only field displaying a perfectly valid number, with no
    // way to correct it from what they can see. Validate what you send.
    if (authoringQuestions && formData.inline_survey_duration_auto === false) {
      const surveyDuration = formData.inline_survey_duration_minutes;
      if (surveyDuration !== undefined) {
        if (!Number.isInteger(surveyDuration) || surveyDuration < 1) {
          errors.inline_survey_duration_minutes =
            'Enter a length of at least 1 minute, or leave it empty';
        } else if (surveyDuration > INLINE_STUDY_LIMITS.maxDurationMinutes) {
          errors.inline_survey_duration_minutes =
            `Shorten the length to ${INLINE_STUDY_LIMITS.maxDurationMinutes} minutes or fewer`;
        }
      }
    }

    // Task content is checked whenever tasks exist, not only at publish: the
    // backend contract rejects an empty prompt or a one-option choice on every
    // save, so a draft with a half-written task would fail server-side with a
    // far less useful message.
    if (formData.type === 'unmoderated' && !studyIsReadOnly) {
      formData.inline_study_steps.forEach((step, index) => {
        if (!step.prompt.trim()) {
          errors[`inline_study_steps.${index}.prompt`] =
            `Enter the text for task ${POSITION_PLACEHOLDER}`;
        }
        if (step.type === 'single_choice') {
          const filled = (step.options ?? []).filter((option) => option.trim()).length;
          if (filled < 2) {
            errors[`inline_study_steps.${index}.options`] =
              `Enter at least two options for task ${POSITION_PLACEHOLDER}`;
          }
        }
      });

      if (
        formData.inline_study_steps.length > 0 &&
        !formData.inline_study_consent_text.trim()
      ) {
        errors.inline_study_consent_text =
          'Enter the consent text participants agree to';
      }

      // Optional, but if given it must be openable. Mirrors isSafeTargetUrl on
      // the contract: the task page is opened as a same-origin about:blank and
      // then navigated, so an active-scheme URL would run against the
      // participant's session.
      // Normalised, not just trimmed, and for the same reason the payload
      // below is: blur has almost always already rewritten the field, but a
      // submit that somehow skipped it must not be rejected for a missing
      // scheme we would have added. Normalising is idempotent, so running it
      // again here costs nothing.
      // Gated exactly like the survey twin above: while the automatic estimate
      // is in force this field is not what the payload carries.
      const duration = formData.inline_study_duration_auto === false
        ? formData.inline_study_duration_minutes
        : undefined;
      if (duration !== undefined) {
        if (!Number.isFinite(duration) || duration < 1) {
          errors.inline_study_duration_minutes =
            'Enter a length of at least 1 minute, or leave it empty';
        } else if (duration > INLINE_STUDY_LIMITS.maxDurationMinutes) {
          errors.inline_study_duration_minutes =
            `Shorten the length to ${INLINE_STUDY_LIMITS.maxDurationMinutes} minutes or fewer`;
        }
      }

      const targetUrl = normaliseTargetUrl(formData.inline_study_target_url);
      if (targetUrl && !isSafeTargetUrl(targetUrl)) {
        errors.inline_study_target_url = UNSAFE_TARGET_URL_MESSAGE;
      } else if (targetUrl.length > INLINE_STUDY_LIMITS.maxTargetUrlLength) {
        // Mirrored so an over-long URL fails here rather than as a server 400.
        errors.inline_study_target_url =
          `Shorten the URL to ${INLINE_STUDY_LIMITS.maxTargetUrlLength} characters or fewer`;
      }

      // A URL with no tasks would be silently dropped: the payload is only
      // built when there is at least one task, so say so rather than discarding
      // what they typed.
      if (targetUrl && formData.inline_study_steps.length === 0) {
        errors.inline_study_steps =
          'Add at least one task - a starting URL on its own has nothing for the participant to do';
      }
    }

    // Unmoderated studies run with logged-in Cortex users, so an external
    // participant type is not representable.
    if (formData.type === 'unmoderated' && formData.participant_type_required === 'external') {
      errors.participant_type_required = UNMODERATED_EXTERNAL_PARTICIPANT_ERROR;
    }

    // Validate specific participant details when required
    if (formData.participant_type_required === 'specific') {
      if (!formData.participant_type_specific_details.trim()) {
        errors.participant_type_specific_details =
          'Describe the participants you need';
      } else if (formData.participant_type_specific_details.trim().length < 10) {
        errors.participant_type_specific_details =
          'Describe the participants you need, in at least 10 characters';
      }
    }

    return errors;
    // Memoised so that everything derived from it - `liveErrorSteps`, and
    // `statusOfStep` through it - is stable across renders that did not change
    // the form.
    //
    // It does NOT help on the typing path, and it would be easy to write a
    // comment claiming it does: `handleInputChange` rebuilds `formData` on
    // every keystroke, so this is recreated on every keystroke too. What stops
    // the live region talking over an author who is typing is the
    // `lastAnnouncedStep` guard, not this. The memo earns its place on the
    // renders driven by other state - `validationErrors`, `activeTab`,
    // `saving`, `sessions`, `refusalCount` - which is most of them.
  }, [formData, deliveryMode, studyIsReadOnly, hasLinkedStudy, studyMissing, sessions]);

  /**
   * The same rules, run for the same reason they have always been run: a save
   * was attempted, so the author is owed the list of what is wrong.
   *
   * Split from `computeValidationErrors` above so the stepper can ask the same
   * question during render without writing state. Calling the old combined
   * function from a render pass would have set state mid-render on every pass,
   * which React answers with an infinite loop rather than a warning - and the
   * alternative, a second set of "is this step done" rules, is exactly the
   * drift this form has already been bitten by three times.
   *
   * There is a SECOND writer of this map: the Basics step's own Continue
   * handler, which sets its own narrower object wholesale. That is why the
   * stepper reads the live rules as well as this map, rather than treating the
   * map as the complete picture.
   */
  const collectValidationErrors = (): Record<string, string> => {
    const errors = computeValidationErrors();
    setValidationErrors(errors);
    return errors;
  };

  /**
   * Which steps hold a problem, asked twice of the same rules.
   *
   * `reportedErrorSteps` is what the author has already been told - the state
   * map, written by a refused save, a blur, or the Basics step's own Continue
   * handler. `liveErrorSteps` is what those same rules say about the form as it
   * stands this render. The strip needs both: the first so a refusal keeps
   * pointing at the step it named, the second so filling the field clears the
   * flag immediately, with no save and without a second set of rules that could
   * disagree with the one that actually refuses.
   *
   * `computeValidationErrors` is the pure half of the validator and writes no
   * state, which is the only reason this is legal during render.
   */
  const reportedErrorSteps = useMemo(
    () => stepsHoldingErrors(validationErrors, locateField),
    [validationErrors]
  );
  const liveErrorSteps = useMemo(
    () => stepsHoldingErrors(computeValidationErrors(), locateField),
    [computeValidationErrors]
  );

  const statusOfStep = useCallback(
    (step: FormStep): StepStatus =>
      deriveStepStatus({
        // Errors are located by tab NUMBER and history is held by step KEY.
        // Both are passed rather than one derived from the other, because the
        // two identifiers genuinely mean different things here and collapsing
        // them is the bug this signature exists to prevent.
        stepId: step.id,
        activeStepId: activeTab,
        visited: visitedStepKeys.has(step.key),
        reportedErrorSteps,
        liveErrorSteps
      }),
    [activeTab, visitedStepKeys, reportedErrorSteps, liveErrorSteps]
  );

  /**
   * The control an Edit link asked for, held until the step it lives on has
   * rendered.
   *
   * A state hop rather than a direct `document.getElementById(...).focus()` in
   * the click handler: the step body is replaced wholesale by the render that
   * `setActiveTab` schedules, so at the moment of the click the control does
   * not exist yet. Cleared whether or not it was found, so a control that is
   * conditionally rendered cannot leave a request queued that fires on some
   * later, unrelated step change.
   */
  const [pendingFocusFieldId, setPendingFocusFieldId] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFocusFieldId) {
      return;
    }
    const target = document.getElementById(pendingFocusFieldId);
    setPendingFocusFieldId(null);
    if (!target) {
      return;
    }
    target.focus();
    // jsdom implements neither of these; the guard is what keeps the unit
    // tests from failing on the browser's behalf.
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [pendingFocusFieldId, activeTab]);

  /**
   * Open a step and put the author on the thing they came back to change.
   *
   * Review's Edit links are the only caller. A step change alone leaves focus
   * on the button that was pressed, two steps away from the field the author
   * just told us they wanted - which is the same "you fix it, we will not say
   * where" failure the refusal banner exists to stop.
   */
  const goToStepAndFocus = (stepId: number, focusFieldId?: string) => {
    setRefusalShown(false);
    setActiveTab(stepId);
    setPendingFocusFieldId(focusFieldId ?? null);
  };

  /**
   * The same move, made from the error summary, and it does NOT clear the
   * summary.
   *
   * A refusal naming five problems that disappears the moment the author acts
   * on the first one has told them about one problem and hidden four. The
   * summary stays until a save or a Continue is attempted again, at which point
   * it is rebuilt from the rules rather than edited.
   */
  const goToErrorAndFocus = (stepId: number, focusFieldId?: string) => {
    setActiveTab(stepId);
    setPendingFocusFieldId(focusFieldId ?? null);
  };

  /**
   * The DOM id of the control an error key is about.
   *
   * Per-item controls are addressed by the item's `_clientId` rather than by
   * its position, so an error that survives a reorder still points at its own
   * question. Position would point at whatever moved into the slot.
   *
   * `options` resolves to the FIRST answer box rather than to a container.
   * There is no single control for "at least two answers"; landing on the box
   * the author will type into is the nearest true thing.
   */
  const controlForError = (key: string): string | undefined => {
    const indexed = parseIndexedErrorKey(key);
    if (!indexed) {
      return locateField(key).control;
    }

    const item =
      indexed.list === 'inline_survey_questions'
        ? formData.inline_survey_questions[indexed.index]
        : formData.inline_study_steps[indexed.index];
    if (!item) {
      return undefined;
    }

    // `question` and `task` are the `idPrefix` values QuestionList renders
    // with on the two surfaces. Named here rather than derived, because they
    // are strings on both sides and a derivation that guessed wrong would fail
    // silently - a focus() on a missing id does nothing at all.
    const prefix = indexed.list === 'inline_survey_questions' ? 'question' : 'task';
    switch (indexed.field) {
      case 'prompt':
        return `${prefix}-prompt-${item._clientId}`;
      case 'options':
        return `${prefix}-option-${item._clientId}-0`;
      case 'config':
        return `question-scale-${item._clientId}`;
      default:
        return undefined;
    }
  };

  /**
   * What the summary lists, rebuilt from the reported map on every render.
   *
   * From `validationErrors`, not from the live rules: the summary is the
   * record of a refusal that HAPPENED. Deriving it live would grow the list as
   * the author walked into new steps, and shrink it under them as they typed,
   * which is a different component with a different job.
   */
  const errorSummaryEntries = buildErrorSummary({
    errors: validationErrors,
    locate: locateField,
    resolveControl: controlForError,
    order: Object.keys(FIELD_LOCATIONS)
  });

  // The consent vocabulary the CURRENT shape authors, extended past
  // `authoringKind` to cover the moderated (bookable) shapes. Their Consent
  // step is keyed by the `sessions` step in getTabsForType, so the same test
  // decides it here.
  const reviewConsentKind: ConsentKind | null =
    authoringKind ?? (tabs.some((tab) => tab.key === 'sessions') ? 'moderated' : null);

  // The three consent fields for that vocabulary, read straight from formData
  // so Review shows exactly what the Consent step edits. One object rather than
  // three parallel ternaries at the call site, so a vocabulary cannot be
  // half-wired (right text, wrong claimed template).
  const reviewConsentSource =
    reviewConsentKind === 'survey'
      ? {
          text: formData.inline_survey_consent_text,
          templateId: formData.inline_survey_consent_template_id,
          templateVersion: formData.inline_survey_consent_template_version
        }
      : reviewConsentKind === 'recorded'
      ? {
          text: formData.inline_study_consent_text,
          templateId: formData.inline_study_consent_template_id,
          templateVersion: formData.inline_study_consent_template_version
        }
      : reviewConsentKind === 'moderated'
      ? {
          text: formData.moderated_consent_text,
          templateId: formData.moderated_consent_template_id,
          templateVersion: formData.moderated_consent_template_version
        }
      : null;

  /**
   * The check-answers screen, derived on EVERY render rather than snapshotted
   * when the author arrives on it.
   *
   * Snapshotting is the obvious implementation and it is wrong: the whole
   * point of Review is that going back, changing something and returning shows
   * the change. A value captured on arrival shows the author their old answer
   * and then commits the new one, which is worse than having no review screen
   * at all. Every input below is read straight from `formData`, and the section
   * list comes from `tabs`, so this cannot describe a shape the form is not
   * rendering.
   */
  const reviewSections = buildReviewSummary({
    steps: tabs,
    type: formData.type,
    title: formData.title,
    purpose: formData.purpose_one_liner,
    status: formData.status,
    description: formData.description_optional,
    product: formData.product_optional,
    meetingLocation: formData.meeting_location_optional ?? '',
    defaultDurationMinutes: formData.default_duration_minutes,
    participantType: formData.participant_type_required,
    participantTypeDetails: formData.participant_type_specific_details,
    startDate: formData.start_date,
    endDate: formData.end_date,
    externalLink: formData.external_link_optional,
    deliveryMode,
    questionCount: formData.inline_survey_questions.length,
    taskCount: formData.inline_study_steps.length,
    // What the PARTICIPANT will be told, which is the author's own number when
    // they have set one and the estimate only while it is still automatic.
    estimatedMinutes:
      authoringKind === 'survey'
        ? formData.inline_survey_duration_minutes ??
          estimateSurveyMinutes(formData.inline_survey_questions)
        : authoringKind === 'recorded'
        ? formData.inline_study_duration_minutes ??
          estimateRecordedMinutes(formData.inline_study_steps)
        : null,
    // NORMALISED, like every other consumer of this field. Validation
    // (`normaliseTargetUrl` at the collector) and the payload builder both do
    // it, so passing the raw value made Review the only reader that did not -
    // and `app.example.com/checkout`, which stores fine as
    // `https://app.example.com/checkout`, was flagged on the summary as "not a
    // web address a participant can open" and then saved without complaint. A
    // false alarm on the screen whose job is to be the last chance to notice
    // costs more than no screen at all.
    targetUrl: normaliseTargetUrl(formData.inline_study_target_url),
    // Which consent VOCABULARY this shape's Consent step is in. `authoringKind`
    // only knows the two study-authoring vocabularies (survey, recorded); the
    // two moderated shapes (test, interview) carry their own consent under
    // `moderated_consent_text`, and Review never read it - so a bookable study's
    // Consent step showed "Standard live-session consent" while Review printed
    // the recorded-session wording and called it "Custom". Derived from the
    // step set, like `authoringKind`, so it cannot disagree with getTabsForType:
    // the moderated shapes are exactly the ones with a `sessions` step.
    // Audit rows a17-wizard-consent, a18-wizard-review-draft.
    consentText: reviewConsentSource?.text ?? '',
    // Resolved, not claimed. The form holds what the wording ARRIVED as; this
    // asks the same function the server asks whether the wording still IS that,
    // so an author who edited an approved template sees "Custom" here rather
    // than the approval they no longer have.
    consentTemplate:
      reviewConsentKind && reviewConsentSource
        ? resolveConsentTemplate({
            kind: reviewConsentKind,
            consentText: reviewConsentSource.text,
            claimedTemplateId: reviewConsentSource.templateId,
            claimedTemplateVersion: reviewConsentSource.templateVersion
          })
        : null,
    copiedFromStudyId: formData.copied_from_study_id,
    copiedFromStudyTitle: formData.copied_from_title,
    linkedStudyId: formData.firsthand_study_id?.trim() ?? '',
    sessionCount: sessions.length
  });

  /**
   * The refusal the SERVER would give this opportunity if it were saved now,
   * asked of the server's own predicate rather than restated here.
   *
   * `authoringKind` decides which twin's inline flag applies, and it is derived
   * from the step list - so this cannot disagree with the shape on screen about
   * which content the opportunity is supposed to have.
   */
  const authoringInline =
    authoringKind === 'survey'
      ? authoringInlineSurvey
      : authoringKind === 'recorded'
      ? authoringInlineStudy
      : false;

  const publishProblem = findPublishProblem({
    willBePublished: formData.status === 'published',
    type: formData.type,
    deliveryMode,
    // Matches what the payload builder sends: authoring inline OMITS the id.
    hasLinkedStudy:
      !authoringInline && Boolean(formData.firsthand_study_id?.trim()),
    hasInlineStudy: authoringKind === 'recorded' && authoringInlineStudy,
    hasInlineSurvey: authoringKind === 'survey' && authoringInlineSurvey,
    externalLink: formData.external_link_optional,
    /*
     * Preview parity for the slot gate (#118). The server refuses a bookable
     * publish with no upcoming slot; passing the count here lets Review show
     * that refusal PROACTIVELY, the same way every other publish problem is
     * previewed - the blocking `computeValidationErrors` arm (row 15's "S")
     * stops the commit, and this makes the Review banner name it too.
     *
     * `sessions.length > 0`, not an upcoming-only count: the wizard cannot add a
     * past slot (the slot picker offers future times), so in the form these are
     * the same set, and this mirrors `shareLinkStartable` below rather than
     * duplicating the server's `end_time > NOW()` clock here.
     */
    hasBookableSlot: sessions.length > 0
    /*
     * `removingLinkedStudy` is deliberately not passed, and it is not an
     * oversight. The server words its refusal differently for a caller TAKING
     * a task list away from a published opportunity, and it detects that by
     * `firsthand_study_id !== undefined` on the request. This form never sends
     * that key explicitly empty - it is `trimmed || undefined` - so the removal
     * wording is unreachable from here, and claiming it would preview a message
     * the server will not send.
     */
  });

  const publishRefusalStep = publishProblem
    ? stepForPublishProblem(publishProblem.code, tabs)
    : null;

  const publishRefusal =
    publishProblem && publishRefusalStep
      ? {
          message: PUBLISH_PROBLEM_MESSAGES[publishProblem.code],
          stepId: publishRefusalStep.id,
          stepTitle: publishRefusalStep.title
        }
      : null;

  /**
   * Whether a participant could actually start this study, for Review's share
   * block (#108).
   *
   * Mirrors `OpportunityDetail`'s own `hasStartablePath`/inline expression for
   * the one shape that check does not otherwise cover here: a test or
   * interview starts by BOOKING A SLOT, and `findPublishProblem` above says
   * nothing about slots at all, so a session-less booking type would
   * otherwise be reported shareable the moment its status is set to
   * Published. Every other shape defaults to `true` because
   * `publishRefusal`, computed above from the same live `formData.status`,
   * already refuses a Published status with no study or no external link -
   * so this share block never renders "shareable" over content that publish
   * itself would have refused.
   */
  const shareLinkStartable =
    formData.type === 'test' || formData.type === 'interview'
      ? sessions.length > 0
      : true;

  /**
   * Say the step change out loud.
   *
   * Moving between steps replaces the whole panel and changes nothing a screen
   * reader is told about: focus stays on the control that was clicked, which
   * still reads as the control it was. The sentence names position, title and
   * state - the same three things the strip shows - because "Step 4 of 4" on
   * its own does not say what is now on screen.
   *
   * Deliberately not in a `useMemo`: the effect runs on step change only, and
   * reading the status at that moment is the point. `stepAnnouncement` is state
   * so that React renders the region with the sentence in it; assigning to the
   * node directly would be a second source of truth for the same words.
   */
  // Seeded with the step the form opens on, so the region announces step
  // CHANGES and not the fact that a page loaded. Left null, the first effect
  // after mount fills an empty polite region, which a screen reader reads out
  // over whatever it was already saying about the page.
  const lastAnnouncedStep = useRef<number>(activeTab);
  useEffect(() => {
    // Guarded on the step rather than pared down to a dependency on `activeTab`
    // alone: `tabs` and `statusOfStep` are rebuilt every render, so a narrower
    // dependency list would be a lie the linter is right to reject. The body
    // runs often and does something only when the step actually changed, which
    // is what stops it talking over an author who is still typing.
    if (lastAnnouncedStep.current === activeTab) {
      return;
    }

    const index = tabs.findIndex((tab) => tab.id === activeTab);
    const step = tabs[index];
    if (!step) {
      return;
    }
    lastAnnouncedStep.current = activeTab;
    setStepAnnouncement(
      `${describeStepPosition(index, tabs.length)}: ${step.title}. ${
        STEP_STATUS_LABEL[statusOfStep(step)]
      }.`
    );
  }, [activeTab, tabs, statusOfStep]);

  /**
   * One field, revalidated on blur, by the ONE set of rules.
   *
   * This used to be a switch with six hand-written cases, and it was the third
   * vocabulary in the form: on blur an over-long title said nothing at all
   * about the 140 limit on some paths, and a `javascript:` external link was
   * called "not a valid URL" here and something else on submit. Two of the six
   * cases were unreachable in any case, because the inputs they named never
   * wired `onBlur` - the prop was threaded into `BasicInfoTab` and
   * `ContentDetailsTab` and used by neither.
   *
   * Now it runs the collector and takes ONE key out of the answer. Every field
   * with a rule is covered by construction, including the indexed per-question
   * and per-task keys, and a rule added to the collector is a rule this
   * enforces on blur the same day. The value argument is gone: every input
   * here is controlled, so `formData` already holds what was typed by the time
   * blur fires, and taking the value from the event was the thing that let the
   * two disagree.
   */
  const validateField = (fieldName: string) => {
    const fresh = computeValidationErrors();
    setValidationErrors((previous) => {
      const next = { ...previous };
      if (fresh[fieldName]) {
        next[fieldName] = fresh[fieldName];
      } else {
        // SHADOWED today, and kept anyway. `handleInputChange` already deletes
        // this key the moment the author types, and `remapAuthoringErrors` does
        // the same for a per-item key whose content changed - so nothing can
        // currently reach blur holding a corrected value and a live error, and
        // a mutation deleting this branch survives the suite.
        //
        // It stays because the alternative is a validator that can only ever
        // ADD messages, which is one refactor of the eager clear away from
        // being a field the author cannot un-flag. The BEHAVIOUR is covered -
        // "clears the message on blur once the value is corrected" - by
        // whichever half is carrying it.
        delete next[fieldName];
      }
      return next;
    });
  };

  // Check if form has been modified
  const hasChanges = (): boolean => {
    if (!isEdit || !originalFormData) return false;

    return (
      formData.type !== originalFormData.type ||
      formData.title.trim() !== originalFormData.title.trim() ||
      formData.purpose_one_liner.trim() !== originalFormData.purpose_one_liner.trim() ||
      formData.description_optional.trim() !== originalFormData.description_optional.trim() ||
      formData.product_optional.trim() !== originalFormData.product_optional.trim() ||
      (formData.meeting_location_optional || '').trim() !== (originalFormData.meeting_location_optional || '').trim() ||
      formData.default_duration_minutes !== originalFormData.default_duration_minutes ||
      formData.external_link_optional.trim() !== originalFormData.external_link_optional.trim() ||
      (formData.firsthand_study_id || '') !== (originalFormData.firsthand_study_id || '') ||
      // The survey fields, or switching delivery mode alone hid the Save
      // Changes buttons on the first two tabs and the author had to reach the
      // last tab to save a change they had already made.
      (formData.delivery_mode || 'external') !== (originalFormData.delivery_mode || 'external') ||
      formData.inline_survey_questions.length !== originalFormData.inline_survey_questions.length ||
      // Compared WITHOUT the client-side ids. They match today only because the
      // baseline is a structuredClone of the same hydrated array; anything that
      // re-hydrated one side and not the other would pin the Save button on
      // forever, with nothing for it to save.
      JSON.stringify(withoutClientIds(formData.inline_survey_questions)) !==
        JSON.stringify(withoutClientIds(originalFormData.inline_survey_questions)) ||
      formData.inline_survey_consent_text.trim() !==
        originalFormData.inline_survey_consent_text.trim() ||
      // The classification is saved state too, so a save that only reclassifies
      // - unlocking custom wording, then restoring the template verbatim - has
      // to be offerable. Without this the Save button stays hidden and the row
      // keeps saying `custom` for wording that is now the approved wording.
      formData.inline_survey_consent_template_id !==
        originalFormData.inline_survey_consent_template_id ||
      formData.inline_survey_consent_template_version !==
        originalFormData.inline_survey_consent_template_version ||
      formData.participant_type_required !== originalFormData.participant_type_required ||
      formData.participant_type_specific_details.trim() !== originalFormData.participant_type_specific_details.trim() ||
      formData.status !== originalFormData.status ||
      // The seven fields this comparison omitted, plus the two reuse flags.
      //
      // Changing only one of them left hasChanges false, which hides the Save
      // buttons on the first two tabs - so an author who rewrote their tasks,
      // their consent wording, the starting URL, either duration or the study
      // period had no way to save it from where they were standing. Only
      // reachable at all now that A1 loads these back in: before it, they never
      // held anything but their defaults in edit mode.
      //
      // inline_survey_questions and inline_survey_consent_text are deliberately
      // absent from this block: they are already compared above, and adding
      // them again would look like coverage while testing nothing.
      formData.inline_study_target_url.trim() !==
        originalFormData.inline_study_target_url.trim() ||
      formData.inline_study_consent_text.trim() !==
        originalFormData.inline_study_consent_text.trim() ||
      formData.inline_study_consent_template_id !==
        originalFormData.inline_study_consent_template_id ||
      formData.inline_study_consent_template_version !==
        originalFormData.inline_study_consent_template_version ||
      formData.inline_study_duration_minutes !==
        originalFormData.inline_study_duration_minutes ||
      formData.inline_survey_duration_minutes !==
        originalFormData.inline_survey_duration_minutes ||
      // Switching between the automatic estimate and a hand-set number changes
      // what a save sends, so it has to show the Save button. Without these two
      // clauses, taking over the estimate on the last tab would be a change the
      // form could not be persuaded to store.
      formData.inline_survey_duration_auto !== originalFormData.inline_survey_duration_auto ||
      formData.inline_study_duration_auto !== originalFormData.inline_study_duration_auto ||
      // No length comparison to go with this one. There is no input where the
      // lengths differ and the stringifications match, so a length clause is
      // exactly the "looks like coverage while testing nothing" shape the note
      // above warns about - it cannot be killed by a mutation on its own. The
      // survey pair a few lines up has the same redundancy and predates A1;
      // removing it is a tidy of its own rather than something to smuggle in
      // here.
      JSON.stringify(withoutClientIds(formData.inline_study_steps)) !==
        JSON.stringify(withoutClientIds(originalFormData.inline_study_steps)) ||
      (formData.start_date || '') !== (originalFormData.start_date || '') ||
      (formData.end_date || '') !== (originalFormData.end_date || '') ||
      formData.study_source !== originalFormData.study_source ||
      formData.copied_from_study_id !== originalFormData.copied_from_study_id ||
      sessions.some(session => session.id.startsWith('temp-session-'))
    );
  };

  /**
   * The state the form is in when it opens, captured once.
   *
   * `useRef`'s initial value is evaluated on the first render and kept, which
   * is exactly the semantics wanted: an edit overwrites `formData` when its
   * load returns, and the baseline for THAT case is `originalFormData`, not
   * this. This one is the blank-form baseline a create starts from.
   */
  const openingFormData = useRef(formData);

  /**
   * The whole form as one comparable string, recomputed each render.
   *
   * Used by three things that must agree: the autosave's notion of dirty, the
   * effect that stamps when a change happened, and the unload guard. One
   * instrument rather than three comparisons.
   */
  const changeSignature = dirtySignature(formData);

  /**
   * Whether this form autosaves at all.
   *
   * DRAFTS ONLY, and this is a product decision rather than a technical one,
   * so it is worth stating where it is made.
   *
   * The plan's rule is "autosave writes draft state only". The narrow reading
   * is "never set status to published", which `forAutosave` already
   * guarantees. The broader one - only autosave something that is still a
   * draft - is the one taken here, because of what the alternative means for
   * a study that is already running: a researcher rewording a question on a
   * live opportunity would have that wording reach participants two seconds
   * later, mid-session, with nobody having pressed anything. Some of those
   * participants would have already answered the previous wording, and
   * nothing records which version anybody saw.
   *
   * A published opportunity therefore goes back to saving deliberately, which
   * is what it did before D2 and what its Save control still says it does.
   * Unsaved work is still protected there - by the exit guard and the route
   * blocker, which warn rather than write.
   *
   * The STORED status, not the one in the form. An author who has selected
   * Published on the Review step but not yet committed is about to make a
   * deliberate decision, and a timer must not make it for them.
   *
   * Read from `storedFormRef` rather than from `originalFormData`, and the
   * difference is a real one on the path this feature creates. A draft THIS
   * session minted by autosaving has no `originalFormData` at all - the load
   * effect is skipped for a self-minted id - so the fallback was the form's
   * own status. Setting Status to Published on step one then switched autosave
   * off, taking the save-state line, the Discard control and the timer with
   * it, and everything typed after that was unsaved with nothing on screen
   * saying so. `storedFormRef` is set by the create response as well as by the
   * load, so it has an answer on both paths.
   */
  const autosaveApplies =
    (storedFormRef.current?.status ?? formData.status) === 'draft';

  /**
   * Would leaving now lose something.
   *
   * An edit asks `hasChanges`, which is the same question the Save Changes
   * button asks, so the two cannot disagree about whether there is anything to
   * save. A create has no server-side baseline to compare against, so it
   * compares against the form as it opened.
   *
   * A save that has just succeeded is not unsaved work, whatever the shape of
   * the object: the success banner is on screen and the form is about to
   * navigate on its own.
   */
  const hasUnsavedWork = (): boolean => {
    // There is deliberately NO "a save just succeeded" shortcut here. Both
    // baselines are refreshed by the save itself - an edit re-reads the
    // opportunity and a create rebaselines what it sent - so a saved form is
    // already clean by the ordinary comparison. A shortcut on top of that
    // would not be redundant, it would be wrong: the form stays on screen for
    // up to three seconds after a create, and anything typed in that window IS
    // unsaved work.

    // Temporary sessions are held outside `formData` entirely, so the object
    // comparison below cannot see them. `hasChanges` counts them and this has
    // to as well, or an author who laid out six time slots and never saved
    // them is let out without a word.
    if (sessions.some((session) => session.id.startsWith('temp-session-'))) {
      return true;
    }

    /**
     * The timer has already saved it, so there is nothing to lose.
     *
     * Checked BEFORE the two comparisons below, because both measure against
     * the baseline the LOAD produced and an autosave deliberately does not
     * refresh that - declaring that what we sent is now what is stored is the
     * mistake A1 exists to undo, and re-reading the opportunity mid-sentence
     * is the loss autosave exists to prevent. So on an autosaved form both
     * instruments report unsaved work indefinitely, and the author is warned
     * about losing something that is already on the server. Warned every time,
     * they learn to click through it - which is how the warning stops working
     * on the day it is telling the truth.
     *
     * `savedSignatureRef` is the honest instrument for this one question:
     * it holds exactly what was last successfully STORED, so a match means the
     * server has what is on screen. It is null until a baseline exists, and
     * this is skipped then.
     *
     * The temporary-sessions check above still stands, and stands FIRST: slots
     * held in memory are outside `formData` entirely, so no signature can see
     * them.
     */
    if (
      autosaveApplies &&
      savedSignatureRef.current !== null &&
      savedSignatureRef.current === changeSignature
    ) {
      return false;
    }

    // Both instruments, not one. `hasChanges` enumerates its comparisons
    // because it decides whether to OFFER a save; that list has been wrong
    // twice, and being wrong about a warning costs the author their work
    // rather than a button. The signature comparison cannot drift, so it runs
    // as well and either one is enough to ask the question.
    if (isEdit && originalFormData) {
      return hasChanges() || hasUnsavedChanges(formData, originalFormData);
    }

    // No baseline from the server. That is a create - and it is ALSO an edit
    // whose load failed, which renders the form fully typeable behind an
    // inline banner with `originalFormData` still null. `hasChanges` returns a
    // flat false for that state, so this control used to walk an author
    // straight out of a form they had just filled in.
    return hasUnsavedChanges(formData, openingFormData.current);
  };

  /**
   * Leave the form, asking first if there is anything to lose.
   *
   * The confirmation is the whole point of the rename. This control has always
   * navigated away on one click, discarding everything typed since the last
   * save, and it sat three inches above a button labelled the same way that
   * only moved back one step. D2 replaces this with a real save; until then,
   * asking is the least this can do.
   */
  /**
   * Take the study revision a write just produced.
   *
   * The alternative is re-reading the study after every save, which is a
   * request that can fail on a path that must not - and which would tell the
   * author nothing they could act on when it did. The write already knew the
   * answer; this is only a matter of it being carried back.
   *
   * Absence means "this response says nothing about a study", which is what a
   * title-only save means, so the precondition is KEPT rather than cleared.
   * Clearing it would silently drop the protection on the next save.
   */
  const adoptStudyRevision = (saved: Opportunity) => {
    if (saved.linked_study_updated_at) {
      setLinkedStudyUpdatedAt(saved.linked_study_updated_at);
      // A revision we just wrote makes any conflict token two writes old, and
      // a stale token permanently shadows the real one - refusing every later
      // save and blaming a colleague who did nothing.
      setStaleStudyUpdatedAt(null);
    }
  };

  /**
   * The payload this form would send right now.
   *
   * Built from the same builder the manual save uses, so an autosave and a
   * Finish cannot disagree about what a save carries.
   */
  const currentPayload = useCallback(
    (): SavePayload =>
      buildSavePayload({
        formData,
        // What the server HOLDS, falling back to what it served when nothing
        // has been saved since. See storedFormRef for why the two differ.
        originalFormData: storedFormRef.current ?? originalFormData,
        isEdit: isPersisted,
        tabs,
        deliveryMode,
        authoringInlineStudy,
        authoringInlineSurvey,
        linkedStudyUpdatedAt,
        staleStudyUpdatedAt
      }),
    [
      formData,
      originalFormData,
      isPersisted,
      tabs,
      deliveryMode,
      authoringInlineStudy,
      authoringInlineSurvey,
      linkedStudyUpdatedAt,
      staleStudyUpdatedAt
    ]
  );

  /**
   * Why an autosave cannot go out right now, in words the author can act on.
   *
   * A block is NOT an error. Nothing has gone wrong; the payload simply is not
   * one the server would accept yet, which is the ordinary state of a question
   * somebody is halfway through typing. Reporting it as a failure would teach
   * the author to ignore the one message that means their work is at risk.
   *
   * The authored content is checked against the SHARED schemas - the very
   * objects the server validates with, imported from `shared/firsthand` - not
   * against a restatement of their rules. A second copy of "a prompt must not
   * be empty" is a copy that can disagree with the server about when a save
   * would be refused, and the direction it would disagree in is silent: the
   * form would fire a POST, take a 400, and tell the author saving had failed.
   */
  const autosaveBlock = (payload: SavePayload): AutosaveBlock | null => {
    // A study that could not be READ must never be written over, and that
    // outranks everything: the form is showing default consent text and an
    // empty task list because the fetch failed, not because that is what the
    // study holds. `handleSubmit` refuses for the same reason.
    if (studyLoadError) {
      return { code: 'read-only', detail: 'this task list could not be read' };
    }

    /**
     * A conflict is unresolved until the author decides what to do about it,
     * and the TOKEN outlives the banner.
     *
     * `studyConflict` alone was not enough. `handleSubmit` clears that flag at
     * the top of its own try, and its catch only sets it again for another
     * `stale_study` 409 - so a deliberate re-save that failed for ANY other
     * reason left `staleStudyUpdatedAt` armed with the banner gone. The timer
     * then performed the deliberate overwrite that the author had authorised
     * for exactly one click, against a colleague's work, with `answerCounts`
     * null so the answer-detachment summary could not fire either.
     *
     * Gated on the token as well, so the overwrite stays a deliberate act.
     */
    if (studyConflict || staleStudyUpdatedAt !== null) {
      return {
        code: 'needs-confirmation',
        detail: 'somebody else has changed this since you opened it'
      };
    }

    if (!isPersisted && !meetsCreateThreshold(formData)) {
      return { code: 'below-threshold' };
    }

    // The server refused the last attempt and said why. Repeat its sentence
    // rather than a generic failure, and do not send the same body again.
    if (autosaveRefusal) {
      return { code: 'incomplete', detail: autosaveRefusal };
    }

    /**
     * A status the timer will never carry.
     *
     * `forAutosave` omits `status` on an edit deliberately, so a form whose
     * status differs from the stored one has a delta autosave cannot close.
     * Left to run, every pass would send an identical body, stay dirty, and
     * fire again on the next tick - spending the shared write budget forever
     * to change nothing.
     *
     * A block rather than a silent stop, because the author has made a
     * decision that is NOT being saved and is owed that sentence. The exit
     * guard warns about it too, now that the signature is honest about what
     * was stored.
     */
    if (
      storedFormRef.current &&
      formData.status !== storedFormRef.current.status
    ) {
      return {
        code: 'needs-confirmation',
        detail: 'changing the status is saved when you press Save'
      };
    }

    if (payload.inline_survey) {
      const parsed = inlineSurveySchema.safeParse(payload.inline_survey);
      if (!parsed.success) {
        return { code: 'incomplete', detail: firstSchemaComplaint(parsed.error, 'survey') };
      }
    }

    if (payload.inline_study) {
      const parsed = inlineStudySchema.safeParse(payload.inline_study);
      if (!parsed.success) {
        return { code: 'incomplete', detail: firstSchemaComplaint(parsed.error, 'recorded') };
      }
    }

    /**
     * A removal that would detach somebody's answers is never done on a timer.
     *
     * `handleSubmit` puts this behind a confirmation naming both numbers, and
     * an autosave that went round it would remove research nobody was asked
     * about - silently, seconds after the card left the screen. So the timer
     * holds and says so, and the removal happens when the author saves
     * deliberately and confirms.
     */
    if (authoringKind === 'survey') {
      const detached = answersDetachedBy(
        (formData.inline_survey_questions ?? []).map((question) => question._clientId),
        storedQuestionKeys,
        answerCounts
      );

      if (detached) {
        return {
          code: 'needs-confirmation',
          detail: 'removing a question that has answers needs confirming'
        };
      }
    }

    /**
     * Never send the same body twice in a row.
     *
     * LAST, after every block that has something to say. If the payload is
     * byte-for-byte what the last successful save sent, then whatever still
     * reads as unsaved is something this request cannot carry - and if that
     * thing has a name, one of the blocks above has already given it, so this
     * must not pre-empt them.
     *
     * A backstop rather than an optimisation. Every other guard decides
     * whether to fire; if one stops working, the timer is left with a payload
     * that never changes and a dirty flag that therefore never clears, and it
     * fires for ever. An independent mutation pass found that shape twice, and
     * both times the suite HUNG rather than failed - in CI a job timeout with
     * no named failing test. With this, the same removal produces one save and
     * then silence, which has a name.
     */
    if (
      lastSentBodyRef.current !== null &&
      JSON.stringify(forAutosave(payload, isPersisted)) === lastSentBodyRef.current
    ) {
      return { code: 'nothing-new' };
    }

    return null;
  };

  /**
   * Reopening a draft OFFERS the step that needs attention. It does not go
   * there.
   *
   * The plan's words are "land the author on the first step that needs
   * attention", and this is a deliberate departure from the literal reading,
   * so the reasoning belongs here rather than in a commit message nobody will
   * find.
   *
   * Moving somebody on load, before they have looked at anything, is the wrong
   * shape twice over. An author who deliberately left step three blank to come
   * back and finish step one first is taken somewhere they did not ask to go,
   * with no explanation and nothing on screen saying why the form did not open
   * where they expected. And "the first thing that is invalid" is a VALIDATION
   * affordance, not a resumption one - D1 already built that affordance, in
   * the error summary, and it works by offering a route rather than taking it.
   * Two mechanisms doing the same job by different rules is how a form starts
   * behaving unpredictably.
   *
   * So the author is told, once, in one line, and one click takes them there.
   * They arrive having chosen to.
   *
   * Review is never the answer: it reports "needs attention" whenever the
   * opportunity is not publishable, which on a half-finished draft is always,
   * so it would win this search every time and offer a summary of work that
   * has not been done.
   */
  const resumeStep = useMemo(() => {
    if (!originalFormData || originalFormData.status !== 'draft') return null;

    return (
      tabs.find((step) => {
        if (step.id === REVIEW_STEP_ID) return false;
        const status = statusOfStep(step);
        return status === 'needsAttention' || status === 'notStarted';
      }) ?? null
    );
  }, [originalFormData, tabs, statusOfStep]);


  /**
   * WHEN the form last changed, computed during render rather than recorded in
   * an effect.
   *
   * It was an effect first, and that was wrong in a way only a real browser
   * showed. An effect runs AFTER the render that first sees the new signature,
   * so on that render the autosave decision read the PREVIOUS change time -
   * which, on the first edit after a save, is minutes old. The debounce was
   * therefore already satisfied and the save went out on the first keystroke:
   * the exact behaviour the debounce exists to prevent, and the one the plan
   * names. Measured at 39ms after a single keystroke; jsdom never showed it,
   * because nothing there types twice with a save in between.
   *
   * `useMemo` keyed on the signature recomputes exactly when the form's
   * content changes and never otherwise, so it is a timestamp OF that change
   * rather than a reading taken near it - and it is available on the same
   * render, which is the whole point.
   */
  const lastChangeAt = useMemo(
    () => Date.now(),
    // The clock is read when the signature changes. That is the value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changeSignature]
  );

  /**
   * Warn before the BROWSER takes the page away.
   *
   * This is the refresh, the close and the back button - the three exits no
   * router hears about. It is deliberately narrow, and being honest about
   * what it does NOT cover matters more than the code:
   *
   *  - It cannot cover in-app navigation. That is what `requestExit` and its
   *    confirmation are for, and every control on this form that leaves goes
   *    through it.
   *  - A true route blocker would use `useBlocker`, which needs a data router.
   *    This app mounts `BrowserRouter` with a `Routes` tree, so the hook is
   *    not available here and moving the whole app onto `createBrowserRouter`
   *    is not a change that belongs in this step.
   *  - The browser decides the wording. Every current browser ignores the
   *    string and shows its own, which is why none is set.
   *
   * Only armed when there is genuinely something to lose. An unconditional
   * handler is the dialog everyone learns to dismiss without reading, and it
   * would fire on a form that autosaved thirty seconds ago and has nothing
   * outstanding at all.
   */
  const somethingToLose = hasUnsavedWork();

  useEffect(() => {
    if (!somethingToLose) return;

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Assigned as well as prevented: Chrome and Safari still gate the
      // dialog on returnValue being set, however deprecated it is.
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
    // The ANSWER, not the function. `hasUnsavedWork` is redefined every
    // render, so depending on it would add and remove the listener on every
    // keystroke - which works, and is a lot of churn to say the same thing a
    // boolean says.
  }, [somethingToLose]);


  /**
   * The signature of what is on screen, against what was last stored.
   *
   * `savedSignatureRef` is seeded by the load and re-stamped by every
   * successful save, so "dirty" means exactly "differs from what the server
   * holds" rather than "differs from what we last sent" - a distinction that
   * matters the moment the server normalises something we sent it.
   */
  const autosaveDirty =
    savedSignatureRef.current !== null && changeSignature !== savedSignatureRef.current;

  const pendingPayload = currentPayload();
  const rawBlock = autosaveBlock(pendingPayload);

  // The block, flattened to two primitives, because a fresh object every
  // render would re-run the effect every render. The detail as well as the
  // code: two `incomplete` blocks with different sentences are different
  // states to the author, and depending on the code alone would leave the
  // first sentence on screen after the reason for it changed.
  const currentBlockCode = rawBlock?.code ?? null;
  const currentBlockDetail =
    rawBlock && 'detail' in rawBlock ? rawBlock.detail : null;

  /**
   * Rebuilt from those two primitives rather than passed through, so its
   * identity changes only when its MEANING does.
   *
   * `autosaveBlock` runs on every render and returns a fresh object each time,
   * which as an effect dependency would re-run the timer decision on every
   * keystroke - re-arming the debounce forever and, at the limit, never
   * saving at all.
   */
  const currentBlock = useMemo<AutosaveBlock | null>(
    () =>
      currentBlockCode === null
        ? null
        : ({
            code: currentBlockCode,
            ...(currentBlockDetail !== null ? { detail: currentBlockDetail } : {})
          } as AutosaveBlock),
    [currentBlockCode, currentBlockDetail]
  );

  const saveState = saveStateView({
    dirty: autosaveDirty,
    block: currentBlock,
    inFlight: autosaveState.inFlight,
    lastSavedAt: autosaveState.lastSavedAt,
    consecutiveFailures: autosaveState.consecutiveFailures
  });

  /**
   * Send one autosave.
   *
   * Deliberately NOT `handleSubmit`. A manual save validates the whole form,
   * confirms detachments, writes time slots, re-reads the opportunity and then
   * navigates away - every one of which is wrong on a timer, and the re-read
   * most of all: rebuilding the form mid-sentence is the loss this feature
   * exists to prevent.
   *
   * What it shares with `handleSubmit` is the only thing that must not drift:
   * the payload.
   */
  const runAutosave = useCallback(async () => {
    // Read once, before the create branch below changes what `isPersisted`
    // would say on the next render.
    const wasPersisted = isPersisted;
    const payload = forAutosave(currentPayload(), wasPersisted);

    setAutosaveState((previous) => ({
      ...previous,
      inFlight: true,
      lastRequestAt: Date.now()
    }));

    try {
      if (persistedOpportunityId) {
        const saved = await updateOpportunity(
          persistedOpportunityId,
          payload as UpdateOpportunityRequest
        );
        adoptStudyRevision(saved);
      } else {
        const created = await createOpportunity(payload as CreateOpportunityRequest);
        adoptStudyRevision(created);
        setDraftId(created.id);
        setOpportunityId(created.id);
        selfCreatedIdRef.current = created.id;
        // An id this session minted is already on the step the author chose, so
        // it counts as landed. Without this the ref stays null through the whole
        // create path, and the FIRST MANUAL SAVE - which re-reads via
        // `loadOpportunity` - would fire the landing and throw the author off
        // the step they were standing on when they pressed Save.
        landedForRef.current = created.id;
        // What is stored is now the baseline for "would leaving lose
        // anything", exactly as the manual create path does it.
        openingFormData.current = formData;
        /**
         * The URL rewrite, so a refresh recovers the draft rather than opening
         * an empty form.
         *
         * A real navigation rather than `history.replaceState`, because the
         * router would otherwise disagree with the address bar and the next
         * `navigate` would compute the wrong base path. It is safe because
         * both paths render the SAME element - React reconciles them to one
         * position and the component is not remounted, which was measured
         * rather than assumed - and because the load effect skips an id this
         * session minted.
         */
        navigate(`/admin/opportunities/${created.id}/edit`, { replace: true });
      }

      /**
       * ONE object describing what this request left stored, and BOTH
       * instruments derived from it.
       *
       * They were derived separately, and the gap between them was a
       * data-loss defect. `forAutosave` carries a strict SUBSET of the form -
       * it deletes `status` on an edit - so stamping the signature with the
       * whole form recorded a field the request never sent as saved. Set
       * Status to Published on a stored draft and the timer fired, carried no
       * status, and then reported "Saved 15:42" while suppressing the exit
       * warning: the author's publish decision existed nowhere but the tab
       * they were about to close.
       *
       * `status` is INSIDE the signature, so widening the signature cannot
       * reach it. The fix has to be that both instruments describe the same
       * thing - what the server now holds - rather than one describing the
       * form.
       */
      const storedAfterThisSave: SavePayloadFormState = {
        ...formData,
        // A create says `draft` however the form is set; an edit omits the key
        // so the stored status is whatever it already was.
        status: wasPersisted ? storedFormRef.current?.status ?? formData.status : 'draft'
      };

      savedSignatureRef.current = dirtySignature(storedAfterThisSave);
      storedFormRef.current = storedAfterThisSave;
      lastSentBodyRef.current = JSON.stringify(payload);
      setAutosaveState((previous) => ({
        ...previous,
        inFlight: false,
        lastSavedAt: Date.now(),
        consecutiveFailures: 0
      }));
    } catch (err: unknown) {
      const axiosError = err as {
        response?: {
          status?: number;
          data?: { error?: string; current_updated_at?: string };
        };
      };

      /**
       * A stale-study conflict stops the timer rather than retrying it.
       *
       * Both conditions, never the status alone - `errorHandler` maps a lock
       * timeout and a unique violation to 409 too, and treating one of those
       * as a colleague's write would accuse somebody who did nothing and then
       * advance the precondition past them.
       *
       * Nothing is reset and nothing is reloaded: the author's unsaved work
       * surviving the refusal is the entire point. `studyConflict` then reads
       * as a block, so the timer holds instead of failing in a loop, and the
       * banner offers the deliberate overwrite F1 built.
       */
      if (
        axiosError.response?.status === 409 &&
        axiosError.response.data?.error === 'stale_study'
      ) {
        const refusedWith = axiosError.response.data?.current_updated_at;
        if (refusedWith) {
          setStaleStudyUpdatedAt(refusedWith);
        }
        // Known to be out of date: somebody else has written this study since
        // it was read, so a question they added and the answers it has
        // collected are in neither this map nor this form.
        setAnswerCounts(null);
        setStudyConflict(true);
        setAutosaveState((previous) => ({ ...previous, inFlight: false }));
        return;
      }

      /**
       * A REFUSAL is not a failure, and retrying one is pure waste.
       *
       * A 4xx will not fix itself. Retrying it four more times spends the
       * shared write budget for nothing and ends by telling the author
       * "Unable to save" with no reason - while the server sent one. It is
       * reachable without doing anything strange: change the type of a draft
       * that already has a linked study, and every save from then on is a 400
       * naming a vocabulary mismatch the author could act on if they were
       * shown it.
       *
       * So a refusal becomes a BLOCK carrying the server's own sentence, which
       * stops the timer without counting as a failure, and only a genuine
       * failure - a 5xx, a dropped connection - retries.
       */
      const status = axiosError.response?.status ?? 0;
      /**
       * Not every 4xx is a refusal, and treating them alike was wrong in the
       * direction that costs the author work.
       *
       * A refusal is the server saying "this body is wrong" - it will say the
       * same thing to the same body for ever, so retrying is waste and the
       * only useful response is to show its sentence and stop. But a request
       * timeout, a lock timeout and a rate limit are all 4xx and all TRANSIENT:
       * the same body succeeds a moment later. Reporting one of those as a
       * permanent refusal strands a save that would have worked, and a lock
       * timeout under contention is exactly when the author most needs the
       * timer to keep trying.
       *
       * 409 appears here as retryable because the ONE 409 that is not - a
       * stale-study conflict - is handled above and has already returned.
       */
      const TRANSIENT = [408, 409, 425, 429];
      const refused = status >= 400 && status < 500 && !TRANSIENT.includes(status);

      /**
       * A CREATE whose outcome is unknown is never retried.
       *
       * There is no idempotency key on this endpoint, so a request that failed
       * without a response - a dropped connection, a timeout - may or may not
       * have committed a row. That is precisely the case the retry loop used
       * to treat as "try again", and trying again is how one draft becomes
       * two, both of them the author's, neither of them obviously the wrong
       * one.
       *
       * A PATCH is idempotent enough to retry: it names a row, and the
       * precondition refuses it if somebody else moved underneath. A POST is
       * not. So an unknown-outcome create stops and says so, and the author's
       * work is still on the page - the honest end state, and a recoverable
       * one, because pressing Save then either creates it or updates the row
       * that did land once the page is reloaded.
       */
      if (!wasPersisted && status === 0) {
        setAutosaveRefusal(
          'the connection dropped while creating this draft, so it may or may ' +
            'not have been saved - press Save to be sure'
        );
        setAutosaveState((previous) => ({ ...previous, inFlight: false }));
        return;
      }

      logger.warn(refused ? 'Autosave refused' : 'Autosave failed', {
        opportunityId: persistedOpportunityId,
        status
      });

      if (refused) {
        setAutosaveRefusal(
          axiosError.response?.data?.error || 'the server refused this change'
        );
        setAutosaveState((previous) => ({ ...previous, inFlight: false }));
        return;
      }

      setAutosaveState((previous) => ({
        ...previous,
        inFlight: false,
        consecutiveFailures: previous.consecutiveFailures + 1
      }));
    }
    // Every dependency this reads is either state the effect below already
    // depends on or a setter. Listed exhaustively rather than trimmed, because
    // a stale closure here would save yesterday's content.
  }, [currentPayload, formData, isPersisted, persistedOpportunityId, navigate]);

  /**
   * The timer, and the only one.
   *
   * `decideAutosave` owns every rule; this arranges to ask it again at the
   * moment it named. One timeout at a time, replaced on each decision, so a
   * burst of keystrokes cannot arm a queue of saves.
   */
  useEffect(() => {
    if (!autosaveApplies) return;

    const decision = decideAutosave({
      now: Date.now(),
      dirty: autosaveDirty,
      block: currentBlock,
      ...autosaveState,
      lastChangeAt,
      // A deliberate save counts as in flight. Without this the timer can
      // start a second write while `handleSubmit` is mid-request, which is the
      // same one-tab conflict the wait in `handleSubmit` prevents from the
      // other direction.
      inFlight: autosaveState.inFlight || saving || manualSaveRef.current
    });

    if (decision.action === 'send') {
      const running = runAutosave();
      autosaveInFlightRef.current = running;
      void running.finally(() => {
        // Cleared only if this is still the current one, so a later autosave
        // is not un-registered by an earlier one finishing.
        if (autosaveInFlightRef.current === running) {
          autosaveInFlightRef.current = null;
        }
      });
      return;
    }

    if (decision.action === 'wait') {
      const timer = setTimeout(
        () => setAutosaveTick((tick) => tick + 1),
        decision.afterMs
      );
      return () => clearTimeout(timer);
    }
    // `autosaveTick` is in the list precisely because nothing else changes
    // when a wait expires - it is what turns the timer into a new decision.
  }, [
    autosaveDirty,
    currentBlock,
    lastChangeAt,
    autosaveState,
    autosaveTick,
    autosaveApplies,
    saving,
    runAutosave
  ]);

  /**
   * A fresh edit is a fresh chance.
   *
   * Without this a form that gave up stays given up for the rest of the
   * session, however long the backend has been back. Only the failure count
   * lives here now - the change TIME is derived during render above, because
   * an effect sees it a render too late to be a debounce.
   */
  useEffect(() => {
    if (savedSignatureRef.current === null) return;
    if (changeSignature === savedSignatureRef.current) return;

    setAutosaveState((previous) =>
      previous.consecutiveFailures >= AUTOSAVE_MAX_ATTEMPTS
        ? { ...previous, consecutiveFailures: 0 }
        : previous
    );
    setAutosaveRefusal(null);
  }, [changeSignature]);

  /**
   * "Saved 15:42", in the reader's own locale and timezone.
   *
   * Hours and minutes only. A second-precision timestamp on a save that
   * happens every few seconds reads as a stopwatch, and the question this
   * answers is "is my work safe", not "exactly when".
   */
  const formatSavedAt = (at: number) =>
    new Date(at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    });

  /**
   * Save what is on screen and leave.
   *
   * Routed through `handleSubmit` with navigation skipped rather than through
   * the autosave, and the difference is the point: this is a DELIBERATE save,
   * so it gets the full validation, the detachment confirmation and the time
   * slots - everything the timer deliberately does not do. Leaving only
   * happens if it actually saved.
   *
   * `skipNavigation` because the destination is this control's, not
   * `handleSubmit`'s: an author leaving from step two is going back to the
   * dashboard, not to whatever the create path would have chosen.
   */
  const handleSaveAndExit = async () => {
    const savedId = await handleSubmit(undefined, true);

    // Undefined means the save did not happen - a validation refusal, a
    // conflict, a detachment waiting to be confirmed. Every one of those has
    // put something on screen explaining itself, and walking the author out of
    // the form would discard the work AND the explanation.
    if (!savedId) return;

    navigate('/admin', {
      state: {
        refresh: true,
        timestamp: Date.now(),
        message:
          formData.status === 'draft'
            ? '⚠️ Saved as DRAFT - Not visible to users yet. Change status to Published to make it visible.'
            : 'Changes saved successfully!'
      }
    });
  };

  /**
   * Throw away a draft.
   *
   * The OPPORTUNITY only. `DELETE /api/opportunities/:id` removes that row and
   * nothing else, so a task list or question set authored here survives in the
   * Task Lists area, owned by its author. That is the endpoint's existing
   * behaviour and it is defensible - a study can be referenced by more than
   * one opportunity - but it is not what "discard this draft" sounds like, so
   * the confirmation says which of the two goes rather than implying both.
   *
   * Only ever offered for a DRAFT. Autosave means an abandoned attempt leaves
   * a real row behind - that is decision D-3, taken deliberately, on the
   * grounds that a local-only draft cannot survive the device change the
   * whole feature exists to survive. The price of that decision is that
   * "abandon this" has to become a real control, because the alternative is a
   * dashboard slowly filling with half-written opportunities nobody can
   * remove.
   *
   * The confirmation is not optional and not a toast: this deletes stored
   * work, and it is the one control on this form that does.
   */
  const handleDiscardDraft = async () => {
    if (!persistedOpportunityId) return;

    setDiscarding(true);
    try {
      await deleteOpportunity(persistedOpportunityId);
      navigate('/admin', {
        state: {
          refresh: true,
          timestamp: Date.now(),
          message: 'Draft discarded.'
        }
      });
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(axiosError.response?.data?.error || 'Could not discard this draft');
      setDiscarding(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const requestExit = (destination: string) => {
    if (hasUnsavedWork()) {
      setPendingExit(destination);
      return;
    }
    navigate(destination);
  };

  /**
   * Write the time slots the author confirmed on the Session Management step.
   *
   * Extracted from the edit branch, which was the only branch that had it,
   * because C3 moved the commit point: a test or an interview used to be
   * created by `AdminSessionManager` itself, which then created its own
   * sessions against the id it got back. Review commits now, so this form owns
   * writing them on BOTH paths - and a create that dropped them silently would
   * be the worst possible version of this change.
   *
   * Gated on BOTH the type and the `temp-session-` prefix, and the type half is
   * back after the security gate refuted the reason it was dropped.
   *
   * The prefix is what distinguishes a slot held in memory from one that is
   * already a row, and the first version of this relied on it alone - the
   * comment here claimed the type test "could only ever have agreed with it or
   * been wrong", because only the Session Management step mints these. That is
   * true of how they are CREATED and false of what happens next: the type lives
   * on step 1, so an author can confirm slots on a test, walk back, change the
   * type to a poll, and reach Review with temporary sessions still in state.
   * Without the type gate those slots are written to the poll - rows the author
   * never asked for, on an opportunity that has no session surface to show them.
   *
   * A premise that is nearly right has cost this plan more than one defect, and
   * this was one of them.
   */
  const persistTemporarySessions = async (savedOpportunityId: string): Promise<boolean> => {
    if (formData.type !== 'test' && formData.type !== 'interview') {
      return true;
    }
    const tempSessions = sessions.filter((session) => session.id.startsWith('temp-session-'));
    if (tempSessions.length === 0) {
      return true;
    }

    try {
      const sessionData = tempSessions.map(session => ({
        start_time: session.start_time,
        end_time: session.end_time,
        capacity: session.capacity,
        location_or_meet_link_optional: session.location_or_meet_link_optional || ''
      }));

      logger.debug('Creating confirmed time slots', { count: sessionData.length });
      const { createSessions } = await import('../api/client');
      await createSessions(savedOpportunityId, sessionData);

      // Re-read rather than assume: the temporary ids are local fictions and
      // the real rows are what every later action addresses.
      const refreshed = await getOpportunity(savedOpportunityId);
      setSessions(refreshed.sessions || []);
      return true;
    } catch (sessionError: unknown) {
      logger.error('Error saving sessions', {
        error: sessionError instanceof Error ? sessionError : undefined,
        errorMessage: sessionError instanceof Error ? sessionError.message : String(sessionError)
      });
      /*
       * A 409 says WHICH slots clash, and the advice changes with it.
       *
       * `POST /api/sessions` refuses a batch whose own slots overlap each other
       * with `Session overlaps with existing sessions: <start> - <end>`, and the
       * batch is atomic, so a refusal created nothing. This function's failure
       * also blocks the navigation below, so the author is still on the form
       * with those slots in state - they fix it by changing the times here.
       * Telling them to "add them from the dashboard" sends them to re-add the
       * same overlapping slots and hit the same 409, and the one fact that would
       * break the loop was in the response body.
       *
       * ONLY on a 409, and the reason is what the 500 body carries: outside
       * production `errorHandler` sends the raw `error.message`, so a constraint
       * violation or a dropped connection would put an internal message in front
       * of the author. Every other status keeps the generic sentence - which is
       * also the fallback for a 409 that carried no message, so the sentence
       * stays reachable rather than becoming dead copy.
       *
       * Rendered as a text child of the danger banner below, so React escapes it.
       *
       * Optional-chained from `axiosError` itself, not merely from `.response`.
       * A rejection is not guaranteed to be an object - the `logger.error` call
       * directly above already allows for that - and reading `.response` off a
       * null would throw a TypeError from INSIDE this catch, skipping the
       * `return false` below. That is precisely the silent half-success the
       * comment there calls the worst possible version of this change: the
       * author lands on the dashboard reading "created successfully" with no
       * bookable slots. Pinned by the "not an object at all" arm.
       */
      const axiosError = sessionError as
        | { response?: { status?: number; data?: { error?: string } } }
        | null
        | undefined;
      const overlapMessage =
        axiosError?.response?.status === 409 ? axiosError?.response?.data?.error : undefined;
      setError(
        overlapMessage
          ? `${overlapMessage.replace(/\.$/, '')}. The opportunity was saved but its time slots were not - change the times on the Session Management step and save again.`
          : 'The opportunity was saved but its time slots were not. Add them from the dashboard.'
      );
      /*
       * Reported to the CALLER, not only to `setError`.
       *
       * The banner this sets is painted on a page the navigation below is
       * about to unmount, so it was never seen: the author landed on the
       * dashboard reading "Opportunity created successfully!" with an
       * opportunity that had no bookable slots and no sign anything had gone
       * wrong. The deleted `AdminSessionManager` block had the same shape, so
       * this is not a regression - but C3 collapsed three create paths into one
       * and this function's own comment says a create that dropped them
       * silently would be the worst possible version of the change, so the code
       * and its justification had stopped agreeing.
       *
       * The EDIT path needs no flag: it returns before the navigation, so its
       * banner is already on a page the author is still looking at.
       */
      return false;
    }
  };

  const handleSubmit = async (e?: React.FormEvent, skipNavigation = false): Promise<string | undefined> => {
    // linkedStudyUpdatedAt is recorded here rather than sent: A0's in-place
    // update has no concurrency precondition yet (F1 adds one, and D2's
    // autosave sends it), so the only thing this revision stamp can do today is
    // name which revision of the study the form was editing when a lost-update
    // is reported.
    logger.debug('handleSubmit called', {
      isEdit,
      opportunityId,
      skipNavigation,
      linkedStudyUpdatedAt
    });

    if (e) {
      e.preventDefault();
    }

    /**
     * A deliberate save that arrives DURING an autosave restarts itself once
     * that autosave has landed. It does not resume.
     *
     * This waited and then carried on, and the difference is the whole
     * finding. Everything below - `persistedOpportunityId`, the precondition,
     * `formData` itself - is a render-scope const captured when this handler
     * was bound, and awaiting does not re-read a const. So a Save pressed
     * while the first autosave was creating the draft resumed believing
     * nothing had been created and created a SECOND opportunity, plus a second
     * study if the form was authoring content; and a Save pressed during any
     * later autosave sent the precondition it had captured rather than the one
     * that autosave had just learned, which is refused 409 and shown to the
     * author as a colleague who is themselves.
     *
     * Re-entering through the ref picks up the handler the render AFTER the
     * autosave rebound, so every value below is current by construction. That
     * is worth more than mirroring four values into refs and remembering to
     * add the fifth.
     *
     * Ahead of the detach flag deliberately: the re-entered call has to see
     * that authorisation, and reading it here would consume it on a pass that
     * never saves.
     */
    if (autosaveInFlightRef.current) {
      await autosaveInFlightRef.current;
      return handleSubmitRef.current(undefined, skipNavigation);
    }

    /**
     * A synchronous re-entrancy guard, because `saving` is not one.
     *
     * `setSaving(true)` is state, so it is not visible to a second click in
     * the same tick - and with the wait above, two clicks during one autosave
     * both used to get past the `saving` test and both proceed. A ref is set
     * and seen immediately.
     */
    if (manualSaveRef.current) {
      logger.debug('A deliberate save is already running, ignoring duplicate');
      return undefined;
    }

    /**
     * Read and cleared in one move, at the top, before anything can return.
     *
     * Consuming it further down - just before the save - looked equivalent and
     * was not: `saving`, `studyLoadError` and a validation refusal all return
     * BETWEEN the confirmation and that point. Confirm the summary, then have
     * the re-entered save refused for a missing prompt, and the flag survived
     * with nothing to spend it on: the NEXT save skipped the summary entirely,
     * silently removing the one control this exists to add, at the moment the
     * author is already dealing with a refusal.
     *
     * Clearing it on a path that does not save is the safe direction. The worst
     * it costs is being asked again about a save that has not happened yet.
     */
    const detachAlreadyConfirmed = detachConfirmedRef.current;
    detachConfirmedRef.current = false;

    // Prevent double-clicks - return early if already saving
    if (saving) {
      logger.debug('Already saving, ignoring duplicate click');
      return undefined;
    }

    /**
     * Let any autosave already in flight finish first.
     *
     * Not politeness - correctness. Both writes carry the same
     * `expected_study_updated_at`, so whichever lands second is refused as
     * stale and the author is shown a conflict banner naming a colleague who
     * is themselves; and in the ordering where the deliberate save wins, the
     * autosave's older payload lands on top of it. Waiting costs at most one
     * request and makes the precondition current before this one is built.
     */
    if (autosaveInFlightRef.current) {
      await autosaveInFlightRef.current;
    }

    // Refuse every save while the linked study could not be read.
    //
    // The form is showing default consent text and an empty task list because
    // the fetch failed, not because that is what the study holds. A0 applies an
    // edit to the linked study IN PLACE, so letting this through would write
    // the placeholder over the real content - and it would look like a
    // successful save.
    if (studyLoadError) {
      logger.error('Save refused: the linked study never loaded', { opportunityId });
      setError(studyLoadError);
      setSuccessMessage('');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return undefined;
    }

    const errors = collectValidationErrors();
    if (Object.keys(errors).length > 0) {
      // A save refused in silence is indistinguishable from a save that did
      // nothing: the create controls only exist on the last step, so the field
      // at fault is usually two steps away and its inline error is off screen.
      //
      // Unlike Continue this reports EVERY step's errors, and that asymmetry is
      // the point: Submit is the commit, so the author is owed the whole list.
      logger.error('Validation errors', { errors });
      refuse(errors);
      return undefined;
    }

    /**
     * The last thing between an ordinary save and somebody's research moving
     * into a different section of the results.
     *
     * Per-card confirmations cannot cover this on their own. An author who
     * deletes every question and adds replacements gets a fresh identity on
     * each new card, so every stored question is gone and every answer
     * detaches - through a run of dialogs each of which was individually about
     * one question, or through none at all if the cards were emptied first.
     * Nothing on screen adds them up. This does, once, naming both numbers.
     *
     * Placed AFTER validation on purpose, and that ordering is load-bearing
     * rather than tidy. A survey cannot be saved with no questions at all, so
     * emptying the list is REFUSED - and that save would have removed nothing
     * anyway, because an empty list sends no `inline_survey` and the study
     * keeps every question it has. Asking first would promise a removal that
     * cannot happen, on a save that is not going to happen either.
     *
     * Gated on `authoringKind` as well as on the counts. `inline_survey_questions`
     * is always empty on a form that is not authoring a survey, so a populated
     * map would make every stored question look removed and block every save on
     * a recorded task list behind a dialog naming a "Removed questions" section
     * that author's results view does not have. The route withholds counts for
     * a recorded study today and that is why this is currently unreachable -
     * which is exactly why the invariant belongs here, next to the code that
     * depends on it, rather than only on the server.
     *
     * Gated on a ref rather than on state, because the confirmation resolves by
     * calling this function again and a state update would not have landed by
     * then. Read and cleared at the very top of this function, so no early
     * return can carry the authorisation into a later save.
     */
    if (!detachAlreadyConfirmed && authoringKind === 'survey') {
      const detached = answersDetachedBy(
        (formData.inline_survey_questions ?? []).map((question) => question._clientId),
        storedQuestionKeys,
        answerCounts
      );

      if (detached) {
        setPendingDetach(detached);
        return undefined;
      }
    }

    /**
     * Claimed HERE rather than at the check above, so no early return can leak
     * it and lock the form out of saving for the rest of the session.
     *
     * Safe despite the distance: every line between the check and this one is
     * synchronous, and a click handler runs to completion before the next one
     * starts, so a second click cannot arrive in the gap. Released in the
     * `finally` below, which every path from here reaches.
     */
    manualSaveRef.current = true;

    try {
      setSaving(true);
      setError('');
      setRefusalShown(false);
      setSuccessMessage('');
      setStudyConflict(false);

      // ONE builder, shared with the autosave, so the two cannot disagree
      // about what a save carries. See save-payload.ts for why that matters
      // more here than it usually would.
      const data = buildSavePayload({
        formData,
        originalFormData: storedFormRef.current ?? originalFormData,
        isEdit,
        tabs,
        deliveryMode,
        authoringInlineStudy,
        authoringInlineSurvey,
        linkedStudyUpdatedAt,
        staleStudyUpdatedAt
      });


      let savedOpportunity: Opportunity;
      // False only when the opportunity saved and its time slots did not.
      let sessionsPersisted = true;

      /*
       * A publish of a bookable type needs its slots in the DB BEFORE the
       * publishing write, because the server now refuses a `test`/`interview`
       * publish with no upcoming slot (#118) and slots are a SEPARATE write
       * (`persistTemporarySessions` -> `POST /api/sessions`), not part of the
       * opportunity body. Slots-then-publish is what keeps the ordinary "author
       * adds slots, presses Finish" flow working against that gate.
       *
       * Only these two types, and only on a publish: every other type writes no
       * temporary slots, and a draft is never gated, so they keep the original
       * publish-then-persist order and pay nothing.
       */
      const publishingBookable =
        data.status === 'published' &&
        (formData.type === 'test' || formData.type === 'interview');

      // `persistedOpportunityId`, not the route id. An autosave may already
      // have created this draft and rewritten the URL, and POSTing again here
      // would mint a second opportunity for the same piece of work - the
      // author having done nothing but press Finish.
      if (persistedOpportunityId) {
        if (publishingBookable) {
          // Slots first, then publish over them. If the slots fail (an overlap
          // 409), do NOT publish: `persistTemporarySessions` has set the banner
          // and left the author on the form to fix the times, and the re-read
          // keeps `savedOpportunity` honest about what is actually stored (still
          // the pre-publish state) rather than a publish that did not happen.
          sessionsPersisted = await persistTemporarySessions(persistedOpportunityId);
          savedOpportunity = sessionsPersisted
            ? await updateOpportunity(
                persistedOpportunityId,
                data as UpdateOpportunityRequest
              )
            : await getOpportunity(persistedOpportunityId);
        } else {
          savedOpportunity = await updateOpportunity(
            persistedOpportunityId,
            data as UpdateOpportunityRequest
          );

          await persistTemporarySessions(savedOpportunity.id);
        }
      } else {
        // Create as a DRAFT when this Finish would publish a bookable type, so
        // the slots can be seated before the publish gate runs; every other
        // create still publishes in one call, having no slots to order.
        savedOpportunity = await createOpportunity(
          (publishingBookable
            ? { ...data, status: 'draft' }
            : data) as CreateOpportunityRequest
        );
        setOpportunityId(savedOpportunity.id);
        setDraftId(savedOpportunity.id);
        selfCreatedIdRef.current = savedOpportunity.id;
        // Landed, for the same reason as the autosave create above: the author
        // is already where they chose to be.
        landedForRef.current = savedOpportunity.id;

        logger.debug('CREATE MODE - Opportunity created');

        /*
         * One create path for all five types now, where there used to be
         * three.
         *
         * Poll, survey, question and unmoderated set a banner and navigated on
         * a timer; test and interview returned early here and let
         * `AdminSessionManager` create the sessions and navigate itself, which
         * is what made confirming a time slot the commit point for those two
         * types. Review commits for every type now, so this branch writes the
         * confirmed time slots - a no-op when there are none, which is every
         * type but those two - and then falls through to the single navigation
         * below.
         */
        sessionsPersisted = await persistTemporarySessions(savedOpportunity.id);

        // The draft above was seated only so its slots could be written first;
        // flip it to published now that they exist and the server gate will see
        // them. Skipped when the slots failed - the study stays a draft rather
        // than going live with nothing bookable, and the banner from
        // `persistTemporarySessions` already says why. A later Finish takes the
        // `persistedOpportunityId` branch above and completes the publish.
        if (publishingBookable && sessionsPersisted) {
          savedOpportunity = await updateOpportunity(
            savedOpportunity.id,
            { status: 'published' } as UpdateOpportunityRequest
          );
        }

        // The new baseline for "would leaving lose anything" - seeded AFTER the
        // publish flip, and from the STORED status, not the status `formData`
        // intends. On a create-as-draft whose slots failed the 409, the publish
        // flip was skipped and the row is still a draft; a baseline claiming
        // published (which `formData` carries here) would read as no-changes and
        // hide from the author that the publish did not happen. The row is a
        // draft exactly when a bookable publish could not seat its slots;
        // otherwise the store holds what `formData` asked for.
        const storedStatus =
          publishingBookable && !sessionsPersisted ? 'draft' : formData.status;
        const storedForm = { ...formData, status: storedStatus };
        openingFormData.current = storedForm;
        savedSignatureRef.current = dirtySignature(storedForm);
        storedFormRef.current = storedForm;
      }

      // Update original form data after successful save
      if (persistedOpportunityId) {
        // RE-READ, rather than declaring that what we sent is now what is
        // stored.
        //
        // This used to do `setOriginalFormData({ ...formData })`, which is the
        // same mistake on the way out that A1 just fixed on the way in: a
        // baseline seeded from a fiction. It asserts the request body was
        // stored verbatim, so `hasChanges()` goes false, the Save button
        // disappears, and the author gets positive confirmation that content
        // the server did not keep was written. Every remaining round-trip
        // discrepancy would be invisible behind it - which is exactly how the
        // helper_text loss stayed invisible.
        //
        // loadOpportunity already hydrates from the study, so re-running it
        // makes the baseline true by construction, and refreshes
        // linkedStudyUpdatedAt and studyIsReadOnly with it. It costs one round
        // trip per save; correctness of the thing the Save button reports is
        // worth more than that.
        await loadOpportunity();

        // Cleared HERE and nowhere else, and the placement is the whole fix.
        //
        // `staleStudyUpdatedAt` takes precedence over `linkedStudyUpdatedAt`
        // when the precondition is built, which is right while a conflict is
        // unresolved and wrong the moment one is. `loadOpportunity` above has
        // just refreshed `linkedStudyUpdatedAt` to what this save produced, so
        // leaving the conflict token set would permanently shadow it with a
        // revision that is now two writes old: every later save in the session
        // would be refused, and the banner would accuse a colleague who had
        // done nothing. Not cleared in the pre-save reset either - the whole
        // point of the deliberate second save is that it carries this value.
        setStaleStudyUpdatedAt(null);

        // Show success message for edit mode - but NOT when the slots failed to
        // save. In the slots-first publish path above, a failed
        // `persistTemporarySessions` skips the publishing update and leaves its
        // own error banner up; overwriting it with "Changes saved successfully!"
        // would tell the author the opposite of what happened.
        if (sessionsPersisted) {
          const isDraft = formData.status === 'draft';
          setSuccessMessage(
            isDraft
              ? '⚠️ Changes saved as DRAFT - Not visible to users yet. Change status to Published to make it visible.'
              : 'Changes saved successfully!'
          );
          // Clear success message after timeout (longer for draft warnings)
          setTimeout(() => setSuccessMessage(''), isDraft ? 3000 : 1500);
        }
      }

      // For edit mode, return the existing opportunity ID
      if (persistedOpportunityId && savedOpportunity) {
        return savedOpportunity.id;
      }

      /*
       * Navigate the moment the request resolves. No timer.
       *
       * There were two timed navigations before this - `setTimeout(navigate,
       * isDraft ? 3000 : 1500)` on the create path, and an
       * `await new Promise(setTimeout)` here - and both raced the author. The
       * page they were being given three seconds to read was one that was
       * about to be replaced underneath them, every control on it belonged to a
       * form that was unmounting, and pressing Return to Dashboard inside that
       * window queued a second navigation behind the first. Review is where the
       * author confirms now; there is nothing left for a delay to buy.
       *
       * A THIRD `setTimeout` survives deliberately, above: the one that clears
       * the edit-mode success banner. That is a banner timeout on a page the
       * author STAYS on, not a navigation, and removing it would leave a
       * "Changes saved" notice up for the rest of the session.
       *
       * The draft warning is the thing that had to survive the change, so it
       * travels in the navigation state rather than being shown here and
       * abandoned. `Admin` renders `state.message` and styles anything
       * containing DRAFT as a warning, so the author reads the same words in
       * the same colour, on the page they have actually arrived at.
       */
      if (!skipNavigation && sessionsPersisted) {
        const isDraft = formData.status === 'draft';
        navigate('/admin', {
          state: {
            refresh: true,
            timestamp: Date.now(),
            message: isDraft
              ? `⚠️ Study ${isEdit ? 'updated' : 'created'} as DRAFT - Not visible to users yet. Change status to Published to make it visible.`
              : (isEdit ? 'Opportunity updated successfully!' : 'Opportunity created successfully!')
          }
        });
      }

      return savedOpportunity?.id;

    } catch (err: unknown) {
      const axiosError = err as {
        response?: {
          status?: number;
          data?: { error?: string; message?: string; current_updated_at?: string };
        };
      };

      /**
       * WHICH study the conflict is about.
       *
       * `formData.firsthand_study_id` is empty on a draft whose study the
       * AUTOSAVE minted - the timer never writes the new id into form state,
       * because a payload carrying an id alongside authored content is refused
       * by the route. So on that draft the guard below used to fail its third
       * condition, fall through, and show the author the literal string
       * `stale_study` as an error - with no revision recorded, so the retry was
       * refused identically and there was no way out of the loop.
       *
       * `linkedStudyUpdatedAt` is the honest test for "this form is editing a
       * stored study": it is set by the load AND by every save that wrote one.
       * The id is still preferred when the form has it, because the recovery
       * path below re-reads the study by id.
       */
      const conflictedStudyId = formData.firsthand_study_id?.trim();
      const editingAStoredStudy = Boolean(conflictedStudyId) || linkedStudyUpdatedAt !== null;

      // Both conditions, never the status alone. `errorHandler` maps a unique
      // constraint violation and a lock timeout to 409 as well, and treating
      // one of those as a stale-study conflict would tell the author a
      // colleague had saved when none had - and then advance the precondition,
      // so the next click would overwrite a colleague who genuinely had.
      if (
        axiosError.response?.status === 409 &&
        axiosError.response.data?.error === 'stale_study' &&
        editingAStoredStudy
      ) {
        // Nothing else moves: no field is reset, no reload is triggered, no
        // step is remounted. The whole point of the refusal is that the
        // author's unsaved work survives it.
        //
        // The revision comes from the REFUSAL itself, so recovering from a
        // conflict costs no extra request and cannot fail. A second round trip
        // to learn what to save against is a request that can itself fail -
        // and when it does, the author is refused in a loop with no control
        // anywhere that would let them keep their work.
        //
        // Re-reading the study is the fallback for a refusal that carried no
        // revision, and it reads the STUDY rather than the opportunity on
        // purpose: `loadOpportunity` rebuilds the entire form from the server
        // and would throw away everything on screen.
        const refusedWith = axiosError.response.data?.current_updated_at;

        /**
         * The answer counts are now KNOWN to be stale, so they must stop
         * claiming anything.
         *
         * This is the one path that does not reload, deliberately - the whole
         * point of the refusal is that the author's unsaved work survives it -
         * and it is also the one path where the map is provably out of date:
         * somebody else wrote this study since it was read. A question they
         * added, and the answers it has since collected, are in neither this
         * map nor this form's list of cards. So the next save - the deliberate
         * overwrite F1 exists to offer - would detach those answers with no
         * per-card dialog and no summary, on the very save the conflict banner
         * has just told the author is contentious.
         *
         * `null` rather than a re-read here: this branch is the one that costs
         * no extra request and cannot fail, and buying a count back is not
         * worth making it fail. "Could not be checked" is the honest wording
         * for "somebody changed this underneath you".
         */
        setAnswerCounts(null);

        if (refusedWith) {
          setStaleStudyUpdatedAt(refusedWith);
        } else if (conflictedStudyId) {
          try {
            const linked = await getFirstHandStudy(conflictedStudyId);
            if (linked.study.updated_at) {
              setStaleStudyUpdatedAt(linked.study.updated_at);
            }
            // This branch DID re-read, so it has fresh counts and should use
            // them rather than the null set above: a question the colleague
            // added is in this map, and its answers then show up in the summary
            // as what the next save would detach - which is true, and is
            // exactly what the author needs to see before overwriting.
            setAnswerCounts(linked.answer_counts ?? null);
          } catch (refreshError) {
            logger.warn('Could not refresh the study revision after a conflict', {
              studyId: conflictedStudyId,
              error: String(refreshError)
            });
          }
        }

        setStudyConflict(true);
        return undefined;
      }

      setError(axiosError.response?.data?.error || 'Failed to save opportunity');
    } finally {
      setSaving(false);
      manualSaveRef.current = false;
    }
  };

  /**
   * The latest `handleSubmit`, for the one caller that must not use a stale
   * one: a deliberate save re-entering after waiting for an autosave.
   */
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  /**
   * Steps are an array, which handleInputChange's scalar signature cannot
   * carry. Kept separate rather than widening that signature so the existing
   * type-change coercions there stay readable.
   */
  const handleStepsChange = (steps: WithClientId<InlineStudyStep>[]) => {
    const previous = formData.inline_study_steps;
    setFormData(prev => ({ ...prev, inline_study_steps: steps }));
    // Errors are keyed by POSITION, so they used to be deleted wholesale on any
    // change - which meant moving a task the author had not yet fixed silently
    // cleared the reason they were sent back to it. With a stable client id per
    // task the mapping is derivable: an error follows its task, and is dropped
    // only when that task was removed or edited. See remapAuthoringErrors.
    setValidationErrors(prev =>
      remapAuthoringErrors(prev, 'inline_study_steps', previous, steps)
    );
  };

  /**
   * Takes a copy of an existing study into the form.
   *
   * The one rule this must not inherit from `loadOpportunity`'s hydration:
   * `can_edit` is NOT consulted. It is a fact about the SOURCE, and applying it
   * to a copy would hand the author a read-only form for content that is about
   * to become theirs - which is the single most likely way this step breaks,
   * and the reason the two hydrations are separate functions rather than one
   * with a flag.
   *
   * What IS consulted is whether this form can reproduce the content. Copying
   * something the form would flatten or drop would lose part of it silently on
   * the first save, so that is refused with a reason rather than half-done.
   * `studyRoundTripsCleanly` is checked against the SOURCE's id because that is
   * the id its stored steps were namespaced with; the copy's own steps are
   * re-derived from the new study's id when it is minted.
   *
   * Returns a message when it refused, null when it worked, so the picker can
   * say so next to the row that was clicked.
   */
  const copyFromStudy = async (
    studyId: string,
    kind: AuthoringKind
  ): Promise<string | null> => {
    const noun = kind === 'survey' ? 'questions' : 'task list';
    let loaded;
    try {
      loaded = await getFirstHandStudy(studyId);
    } catch (error) {
      // "Try again" is the wrong advice for the one failure that is certain to
      // repeat, and it spends another request against the bucket that just
      // refused this one.
      return wasRateLimited(error)
        ? `Too many requests in a short time, so nothing was copied. Wait a minute and try again.`
        : `Those ${noun} could not be loaded, so nothing was copied. Try again.`;
    }

    const sourceKind: AuthoringKind = loaded.study.kind === 'survey' ? 'survey' : 'recorded';
    if (sourceKind !== kind) {
      return kind === 'survey'
        ? 'That is a recorded task list, not a set of questions, so it cannot be copied here.'
        : 'That is a set of survey questions, not a task list, so it cannot be copied here.';
    }

    // The recorded path flattens a task list onto ONE study-level Starting URL,
    // so it tolerates a list that uses a single URL (or none, some tasks blank)
    // where a bare round-trip check would refuse it - see recordedStudyCopyability.
    // Only genuinely different per-task pages, or a shape the form cannot author,
    // are refused, and each gets its own sentence rather than one opaque message.
    if (kind === 'recorded') {
      const copyability = recordedStudyCopyability(loaded.steps, loaded.study.id);
      if (copyability === 'divergent-urls') {
        return 'These tasks open different pages, and a reused task list uses one page for every task. Make the task page URL the same on all of them in the Task Lists area, then copy it here.';
      }
      if (copyability === 'unrepresentable') {
        return `Those ${noun} use something this form cannot show, so copying them here would drop part of them.`;
      }
    } else if (!studyRoundTripsCleanly(loaded.steps, kind, loaded.study.id)) {
      return `Those ${noun} use something this form cannot show, so copying them here would drop part of them.`;
    }

    const copied =
      kind === 'survey'
        ? copiedSurveyFields(loaded.study, loaded.steps)
        : copiedRecordedFields(loaded.study, loaded.steps);

    setFormData((prev) => ({
      ...prev,
      ...copied,
      // Provenance is about the content, so it is set in the same update that
      // sets the content. The id is what reaches the payload; the other two are
      // what the note says.
      copied_from_study_id: loaded.study.id,
      copied_from_title: loaded.study.title,
      copied_from_at: new Date().toISOString()
    }));

    // The whole array has been replaced, so the errors that pointed into the
    // old one point at nothing. Cleared rather than remapped - remapping
    // matches errors to items by content, and none of these items are the same
    // items any more.
    setValidationErrors((prev) => {
      const next = { ...prev };
      Object.keys(next)
        .filter(
          (key) =>
            key === 'firsthand_study_id' ||
            key.startsWith('inline_survey_questions') ||
            key.startsWith('inline_study_steps')
        )
        .forEach((key) => delete next[key]);
      return next;
    });

    return null;
  };

  const handleQuestionsChange = (questions: WithClientId<SurveyQuestion>[]) => {
    const previous = formData.inline_survey_questions;
    setFormData(prev => ({ ...prev, inline_survey_questions: questions }));
    // Same reasoning as handleStepsChange.
    setValidationErrors(prev =>
      remapAuthoringErrors(prev, 'inline_survey_questions', previous, questions)
    );
  };

  // One place that turns a refusal on, so every path reports it identically.
  const showRefusal = () => {
    setRefusalShown(true);
    setRefusalCount(count => count + 1);
  };

  /**
   * Continue, refusing what Submit would refuse.
   *
   * This is the whole of D1's first task. Step 1's forward control used to run
   * a hand-written copy of four of the collector's rules, and the copy was
   * missing the title's 140-character ceiling, the purpose's 180, and the
   * 5-240 session-length bound. All three were measured, not assumed: a
   * 150-character title walked through Continue and was refused three steps
   * later from Review, with nothing on the way to say so.
   *
   * `errorsForStep` narrows the same rules to the step the author is standing
   * on, because a forward control that refused over a field further along
   * would be unfixable from where they are. `type` stays in scope on every
   * step - it decides which steps exist at all.
   */
  const continueFromStep = (advance: () => void) => {
    const fresh = computeValidationErrors();
    const mine = errorsForStep(fresh, activeTab, locateField);

    // The reported map keeps what every OTHER step has already been told
    // about. Writing this step's narrow object wholesale - which is what the
    // deleted validator did - erased those, and the stepper reads this map to
    // decide which steps say "Needs attention".
    setValidationErrors((previous) =>
      replaceStepErrors(previous, mine, activeTab, locateField)
    );

    if (Object.keys(mine).length > 0) {
      refuse(mine);
      return;
    }

    setRefusalShown(false);
    advance();
  };

  /**
   * Report a refusal: say so, and open the step holding the earliest problem.
   *
   * Focus is NOT moved here. The summary component takes it when it appears,
   * keyed on `refusalCount` so a repeat refusal over the same fields moves
   * focus again rather than changing nothing in silence.
   */
  const refuse = (errors: Record<string, string>) => {
    showRefusal();
    setSuccessMessage('');
    const step = firstStepHoldingError(errors, locateField);
    // Only to a step this shape actually HAS. FIELD_LOCATIONS is a static map
    // over every field in the form, so it names step 4 for consent - and the
    // shapes with no study have no step 4. Setting one anyway renders no step
    // body at all, because the render guards key off `currentStep`, which
    // `tabs.find` returns undefined for: the author would be told to fix a
    // field and shown a blank page.
    if (step && tabs.some((candidate) => candidate.id === step)) {
      setActiveTab(step);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleInputChange = (
    field: string,
    // `null` is here for `consent_template_version`, which is null exactly when
    // the wording is custom. `undefined` already meant "no value" for the
    // optional fields, and reusing it for this one would make "custom wording"
    // indistinguishable from "field not set" in the dirty check.
    value: string | number | boolean | null | undefined
  ) => {
    // Bug #109: `successMessage` (and the "Saved" state it drives via
    // `justSaved`) used to be cleared only by the save-confirmation timeout or
    // the next save. An edit made inside that window kept reading "Saved" over
    // now-unpersisted work until the timer caught up - the save button was
    // disabled through the same window so nothing was actually lost, but the
    // signal was wrong for as long as 3000ms. Cleared here, unconditionally,
    // so any edit drops the confirmation the instant it happens rather than on
    // the next tick of a timer. `successMessage` is otherwise only set after a
    // save resolves and cleared at the start of the next one, so this does not
    // touch the in-flight-save handling.
    setSuccessMessage('');
    setFormData(prev => {
      // The source choice and anything copied under it belong to the authoring
      // surface that is going away, so they are cleared for EVERY type change
      // rather than inside one arm of it.
      //
      // They used to be cleared in the poll/survey arm only. Copy a set of
      // questions, then change the type to unmoderated, and the provenance
      // survived onto a task list written from scratch - which the save then
      // stored, permanently, because provenance is write-once at create. The
      // task list was stamped forever as a copy of a survey it never came from.
      // Reachable in the other direction too, and through `question` as a
      // waypoint, because neither arm matched on the way past.
      const clearedSource =
        field === 'type'
          ? {
              study_source: 'blank' as StudySourceMode,
              copied_from_study_id: '',
              copied_from_title: '',
              copied_from_at: ''
            }
          : {};

      // Unmoderated is FirstHand-only and runs with logged-in Cortex users, so
      // drop any external link and coerce an 'external' participant type when
      // the type switches to unmoderated (a stale value must not persist).
      if (field === 'type' && value === 'unmoderated') {
        return {
          ...prev,
          ...clearedSource,
          type: 'unmoderated' as const,
          external_link_optional: '',
          participant_type_required:
            prev.participant_type_required === 'external' ? 'any' : prev.participant_type_required,
        };
      }

      // The reverse coercion. A task list picked before the author switched the
      // type to a question-carrying one stayed in state with no picker on
      // screen, and was submitted - so the API refused the save with a message
      // about a task list the form was no longer showing.
      //
      // `question` is in this branch since #78 rather than in the fall-through
      // below, because it now has an authoring surface of its own: leaving a
      // recorded study id in state would send it to a shape that asks for
      // survey questions.
      if (field === 'type' && isQuestionCarryingType(value)) {
        return {
          ...prev,
          ...clearedSource,
          type: value,
          firsthand_study_id: '',
        };
      }

      // Every other type change - to `test` or `interview` - lands here, and
      // must still drop the source choice. Those types have no authoring
      // surface at all, so a copy taken before the switch would otherwise sit
      // in state invisibly and be sent on the next save.
      return { ...prev, ...clearedSource, [field]: value };
    });

    // Clear validation error for this field immediately when typing
    if (validationErrors[field]) {
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
    // A type change can hide type-specific fields (external link, FirstHand
    // study, the external participant option); drop any stale errors left on
    // fields that no longer apply to the new type.
    if (field === 'type') {
      setValidationErrors(prev => clearTypeConditionalErrors(prev, String(value ?? '')));
    }
    // The same problem, one field along: switching delivery mode replaces the
    // third step and discards what the old one held.
    if (field === 'delivery_mode') {
      setValidationErrors(prev =>
        clearDeliveryConditionalErrors(prev, value === 'native' ? 'native' : 'external')
      );
    }
    // And the third: leaving "Specific" unmounts the criteria field.
    if (field === 'participant_type_required') {
      setValidationErrors(prev =>
        clearParticipantConditionalErrors(prev, String(value ?? ''))
      );
    }
  };

  /**
   * Blur is where an author finds out, and it now covers every field with a
   * rule rather than the two that happened to be wired.
   *
   * The value is deliberately not a parameter. The caller has it, and passing
   * it invited a second reading of the same input - `e.target.value` on a
   * number field is a string, which is how a cleared duration used to blur
   * clean and then fail at submit.
   */
  /**
   * Blur is where an author finds out - but only about a field they have
   * actually been in.
   *
   * `type`, `title` and `purpose_one_liner` are the first three tab stops on a
   * blank form. Validating unconditionally meant that TABBING THROUGH a form
   * you had not filled in yet raised three refusals, each with `role="alert"`,
   * before the author had typed a character. Nothing did that before D1,
   * because no input on this step wired `onBlur` at all.
   *
   * So an untouched, still-empty field is left alone. Once it holds something -
   * or once the author has been in it and left it non-empty - it is fair game,
   * and the CLEARING half always runs so a corrected field un-flags itself
   * whatever its history.
   */
  const handleBlur = (field: string) => {
    const alreadyReported = validationErrors[field] !== undefined;
    // A per-item field is touched BY EXISTING: the author added the question or
    // the task on purpose, so there is no "walked past it" case to protect.
    // Without this the gate below silently switched off blur for every indexed
    // key - caught by a test of the answer-group rule, not by review.
    const isPerItem = parseIndexedErrorKey(field) !== null;
    const holdsSomething = isPerItem || fieldHoldsSomething(field);

    if (!alreadyReported && !holdsSomething) {
      // Never been filled and nothing to complain about yet. Walking past a
      // field is not an attempt at it.
      return;
    }
    validateField(field);
  };

  /**
   * Whether a field the author has just left holds anything at all.
   *
   * Keyed off `formData` rather than a `touched` set, because the two questions
   * that matter here - "did they type something" and "is it still empty" - are
   * both answered by the value, and a parallel set of touched flags is one more
   * thing that can disagree with the form.
   */
  const fieldHoldsSomething = (field: string): boolean => {
    const value = (formData as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value);
    }
    return value !== undefined && value !== null;
  };

  // Show loading spinner while checking authentication
  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center min-h-50vh" aria-busy="true" aria-live="polite">
        <h1 className="visually-hidden">Create Opportunity</h1>
        <div className="spinner-border text-primary" role="status" aria-label="Loading">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!loading && !user) {
    return <Navigate to="/auth/login" replace />;
  }

  // Redirect to home if not admin. This form is admin-only; a non-admin who
  // wants research run goes to the service desk from the header (#46).
  if (!loading && user && user.role !== 'researcher_admin' && user.role !== 'superadmin') {
    return <Navigate to="/" replace />;
  }

  // Show loading spinner while loading opportunity for edit
  if (isEdit && loadingOpportunity) {
    return (
      <div className="d-flex justify-content-center align-items-center min-h-50vh" aria-busy="true" aria-live="polite">
        <h1 className="visually-hidden">Edit Opportunity</h1>
        <div className="spinner-border text-primary" role="status" aria-label="Loading opportunity">
          <span className="visually-hidden">Loading opportunity...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      {/*
        While the preview is up the form is HIDDEN, not unmounted.

        Unmounting it was the first shape of this and it was wrong in a way
        that only showed up in a test: the draft itself lives in this
        component's state and survived, but `QuestionList` keeps its own
        expansion state, so every card an author had open came back collapsed
        from a preview they opened to check one of them.

        `display: none` takes the form out of the accessibility tree and out of
        the tab order, so hiding it costs none of what unmounting bought: there
        is still exactly one reachable surface, and still no scroll lock or
        focus trap to keep correct. `hidden` and the inline style together
        because a class on this element could otherwise re-establish a display
        value and put a whole silent form back behind the preview.
      */}
      {isPreviewing && (
        <ParticipantPreview preview={buildActivePreview()} onClose={closePreview} />
      )}
      <div
        className="admin-page-bg"
        hidden={isPreviewing}
        style={isPreviewing ? { display: 'none' } : undefined}
      >
      {/* Theme-aware Background: Dark Mode gets neural particles */}
      {isDark && <SlowNeuralBackground />}

      <div className="container-fluid py-4 opportunity-form min-h-100vh">
        <div className="row justify-content-center">
          <div className="col-12 col-xl-10">
            {/*
              The way OUT of the form, as against the way BACK one step.
              They used to be two near-identical outline-secondary buttons
              carrying the same left arrow and the same word, one at the top of
              the page and one at the bottom of every step - so the destructive
              one and the harmless one were told apart by position alone.
              This one says Exit, carries a different icon, and asks before it
              throws anything away. The bottom one names the step it returns to.
            */}
            <button
              className="btn btn-outline-secondary mb-3"
              onClick={() => requestExit('/admin')}
            >
              <LogOut size={16} className="me-1" />
              Exit to dashboard
            </button>

          <div className="card shadow-sm border-0">
            <div className="card-header border-0 py-4">
              <div className="d-flex align-items-center justify-content-between">
                <div>
                  <h1 className="mb-1 form-title form-title-lg">
                    {isEdit ? 'Edit Opportunity' : 'Create New Opportunity'}
                  </h1>
                  <p className="mb-0 form-subtitle form-subtitle-md">
                    {isEdit ? 'Update study details and sessions' : 'Set up a new Cortex research study'}
                  </p>
                </div>
                <div className="d-flex align-items-center gap-3">
                  {/* Analytics button for every study type in edit mode. The
                      analytics page renders an Overview for all types and is the
                      only route to a moderated study's participant roster, so it
                      must not be gated to question-carrying and unmoderated types
                      (audit row a64-analytics-live-session-participants). */}
                  {isEdit && id && (
                    <button
                      className="btn btn-outline-primary btn-sm text-sm"
                      onClick={() => navigate(`/admin/opportunities/${id}/analytics`)}
                    >
                      <TrendingUp size={14} className="me-1" />
                      Analytics
                    </button>
                  )}
                  <div className="form-user-info form-user-info-text">
                    <UserCircle size={16} className="me-1" />
                    {user?.name || 'Unknown User'}
                  </div>
                </div>
              </div>
            </div>

            <div className="card-body p-0">
              {refusalShown && (
                <ErrorSummary
                  entries={errorSummaryEntries}
                  refusalCount={refusalCount}
                  onSelect={goToErrorAndFocus}
                />
              )}

              {/* d-flex, following ErrorState: the icon was an inline sibling of
                  the text, so any message that wrapped put its second line
                  UNDER the icon instead of aligned with the first. The overlap
                  refusal above is two lines wide at this container, which turns
                  that from an edge case into the normal one. align-items-start
                  rather than -center because a multi-line message centred
                  against a 18px icon floats the icon into the middle of it. */}
              {error && (
                <div className="alert alert-danger mx-4 mt-4 mb-0 d-flex align-items-start" role="alert">
                  <AlertTriangle size={18} className="me-2 flex-shrink-0" />
                  <div>{error}</div>
                </div>
              )}

              {/* A conflict is a warning, not a danger: nothing is broken and
                  nothing is lost. It gets its own banner rather than reusing
                  the danger one above because the two say different things -
                  that one is a dead end, this one has a way out - and because
                  the same event gets the same treatment in StudyEditor.

                  No reload control, deliberately. Reloading rebuilds this whole
                  form from the server and would discard exactly the unsaved
                  edits the refusal exists to protect; a second tab shows the
                  saved version beside them instead. */}
              {studyConflict && (
                <div className="alert alert-warning mx-4 mt-4 mb-0" role="alert">
                  <AlertTriangle size={18} className="me-2" />
                  <strong>Somebody else saved this while you were editing.</strong>{' '}
                  Nothing has been saved and your edits are still here. Open this
                  opportunity in a new tab to see what changed, then either copy
                  their changes across or save again to replace their version.
                </div>
              )}

              {/* Stays up for as long as the load failure lasts, rather than
                  appearing only once a save is attempted: the tabs below are
                  showing placeholder consent text and an empty task list, and
                  the author has no other way to tell that apart from a study
                  that genuinely holds nothing. The save controls are disabled
                  to match - see the studyLoadError guard in handleSubmit, which
                  is the one that actually refuses. */}
              {studyLoadError && (
                <div className="alert alert-danger mx-4 mt-4 mb-0" role="alert">
                  <AlertTriangle size={18} className="me-2" />
                  {studyLoadError}
                </div>
              )}

              {/* Saving is deliberately still allowed here, and so is
                  AUTHORING - see the 404 branch in loadOpportunity. This
                  sentence has to name a control that is actually on screen:
                  the previous one said "pick another below" while pointing at
                  a picker B3 deleted. */}
              {studyMissing && (
                <div className="alert alert-warning mx-4 mt-4 mb-0" role="alert">
                  <AlertTriangle size={18} className="me-2" />
                  The task list or questions this opportunity points at no longer
                  exist. Write replacements below, or start from an existing set
                  - saving will attach whichever you choose. You can also
                  unpublish this opportunity until you have replaced them.
                </div>
              )}

              {successMessage && (
                <div
                  className={`alert ${successMessage.includes('DRAFT') ? 'alert-warning' : 'alert-success'} d-flex justify-content-between align-items-center mx-4 mt-4 mb-0`}
                  role="alert"
                  aria-live="polite"
                >
                  <div>
                    {successMessage.includes('DRAFT') ? (
                      <AlertTriangle size={18} className="me-2" aria-hidden="true" />
                    ) : (
                      <CheckCircle size={18} className="me-2" aria-hidden="true" />
                    )}
                    {successMessage}
                  </div>
                  <button
                    type="button"
                    className={`btn btn-sm ${successMessage.includes('DRAFT') ? 'btn-outline-warning' : 'btn-outline-success'}`}
                    onClick={() => navigate('/admin', { state: { refresh: true, timestamp: Date.now() } })}
                  >
                    Return to Dashboard
                  </button>
                </div>
              )}

              {/*
                The form's submit event is NEUTERED, not wired to the commit,
                and this is the fix for the one defect that broke C3's whole
                exit criterion.
                `handleSubmit` used to be here. Every control in this form is
                `type="button"`, so the form has no submit button - and that is
                precisely the CONDITION under which the HTML implicit-submission
                algorithm submits the form from the form element itself, not a
                protection against it. It does so whenever the form holds no
                more than ONE field that blocks implicit submission, and two
                steps qualify: the External Link step renders a single
                `input[type=url]`, and Content & Details renders a single
                `input[type=text]` in its default case.
                So pressing Return in either field called `handleSubmit`,
                created the opportunity and navigated to the dashboard - from a
                step that is not Review, without the author ever seeing a
                summary. Confirmed in a browser: one keystroke, one POST, one
                redirect. Harmless before C3, because the External Link step WAS
                the commit point, which is why it survived this long.
                Review's own commit does not travel through this event - it is
                an `onClick` on a `type="button"` - so refusing the event costs
                nothing and closes both steps at once.
              */}
              {/*
                The save state, and it is on screen on every step rather than
                appearing only when something happens.

                An indicator that shows up to say "Saved" and then disappears
                cannot say anything about the state it is most important to
                report - that nothing has been saved for the last ten minutes.
                Every state has a sentence including the ones that are nobody's
                fault, so "not saved" never has to be inferred from silence.

                `role="status"` and polite: an author typing must not have the
                caret pulled away from them by a save they did not ask for, but
                a screen-reader user is owed the same information the sighted
                one has.
              */}
              {autosaveApplies && saveStateMessage(saveState, formatSavedAt) && (
                <div
                  className={`d-flex align-items-center gap-2 px-4 py-2 small ${
                    saveState.kind === 'failed'
                      ? 'text-danger fw-semibold'
                      : saveState.kind === 'retrying'
                        ? 'text-warning-emphasis'
                        : 'text-body-secondary'
                  }`}
                  data-testid="autosave-state"
                >
                  {saveState.kind === 'saving' && (
                    <span
                      className="spinner-border spinner-border-sm"
                      aria-hidden="true"
                    ></span>
                  )}
                  {saveState.kind === 'failed' && (
                    <AlertTriangle size={14} aria-hidden="true" />
                  )}
                  {saveState.kind === 'saved' && (
                    <CheckCircle size={14} aria-hidden="true" />
                  )}
                  <span aria-hidden="true">
                    {saveStateMessage(saveState, formatSavedAt)}
                  </span>

                  {/*
                    Announced SELECTIVELY, and the selection is the whole
                    design.

                    A live region carrying every routine state would read
                    "Saving, Saved 15:42" into a screen reader every few
                    seconds for as long as the form is open - while the author
                    is typing into it. That is not equal access to the
                    information, it is a form nobody can use.

                    So the states that mean something has gone wrong or that
                    work is NOT being saved are announced, and the ordinary
                    rhythm of a working autosave is not. The sentence is
                    identical either way; only whether it interrupts differs,
                    which is why the visible copy above is the same string.

                    The region is always mounted, empty when there is nothing
                    to say: a live region added to the DOM at the same moment
                    as its content is unreliably announced.
                  */}
                  <span className="visually-hidden" aria-live="polite">
                    {saveState.kind === 'failed' ||
                    saveState.kind === 'retrying' ||
                    saveState.kind === 'blocked'
                      ? saveStateMessage(saveState, formatSavedAt)
                      : ''}
                  </span>

                </div>
              )}

              {/*
                Discard, which is NOT part of the save-state line and must not
                inherit its visibility.

                It lived inside that line first, and the line only renders when
                there is something to say - so on a clean, fully saved draft
                the control disappeared. That is precisely the moment an author
                decides to abandon one: nothing is outstanding, they have read
                it back, and they do not want it.

                Autosave means an abandoned attempt leaves a real row behind -
                decision D-3, taken deliberately because a local-only draft
                cannot survive the device change this feature exists to
                survive. This control is the price of that decision: without it
                the dashboard fills with half-written opportunities nobody can
                remove.
              */}
              {autosaveApplies && persistedOpportunityId && (
                <div className="px-4 pb-2">
                  <button
                    type="button"
                    className="btn btn-link btn-sm text-danger p-0"
                    onClick={() => setConfirmingDiscard(true)}
                    disabled={discarding}
                  >
                    Discard draft
                  </button>
                </div>
              )}

              {/*
                One line, offered once, for an author coming back to an
                unfinished draft. Dismissed by acting on it or simply by
                walking to that step - `resumeStep` stops naming a step the
                moment it stops needing attention.
              */}
              {resumeStep && resumeStep.id !== activeTab && (
                <div className="px-4 pb-2">
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0"
                    onClick={() => setActiveTab(resumeStep.id)}
                  >
                    Pick up where you left off: {resumeStep.title} needs
                    attention
                  </button>
                </div>
              )}

              <form onSubmit={(event) => event.preventDefault()}>
                {/* Tab Navigation */}
                <div className="border-bottom">
                  <StepNav
                    steps={tabs}
                    activeStepId={activeTab}
                    statusOf={statusOfStep}
                    /* Backward AND forward navigation both stay free. A step
                       reporting Needs attention is information, not a lock:
                       refusing to let an author look at step 4 because step 1
                       is short of a purpose is how a form loses work. */
                    onSelect={setActiveTab}
                  />
                </div>

                {/*
                  The panel below is replaced wholesale on a step change and
                  nothing about that reaches a screen reader on its own - focus
                  stays on the control that was pressed. One region, polite, for
                  the whole strip.
                */}
                <div className="visually-hidden" aria-live="polite" role="status">
                  {stepAnnouncement}
                </div>

                {/* Tab Content */}
                <div className="tab-content p-4">
                  {/* Basic Information Tab */}
                  {currentStep?.key === 'basics' && (
                    <>
                      <BasicInfoTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleBlur={handleBlur}
                      />

                      {continueControl && (
                      <StepActions
                        isEdit={isEdit}
                        onSaveAndExit={handleSaveAndExit}
                        saving={saving}
                        disabled={saveControlsDisabled}
                        justSaved={Boolean(successMessage)}
                        onSave={isEdit && hasChanges() ? () => handleSubmit() : undefined}
                        {...continueControl}
                        onNext={() => continueFromStep(continueControl.onNext)}
                      />
                      )}
                    </>
                  )}

                  {/* Content & Details Tab */}
                  {currentStep?.key === 'content' && (
                    <>
                      <ContentDetailsTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleBlur={handleBlur}
                      />
                      {continueControl && (
                      <StepActions
                        isEdit={isEdit}
                        onSaveAndExit={handleSaveAndExit}
                        saving={saving}
                        disabled={saveControlsDisabled}
                        justSaved={Boolean(successMessage)}
                        {...backwardControl}
                        onSave={isEdit && hasChanges() ? () => handleSubmit() : undefined}
                        {...continueControl}
                        /*
                          The one place a forward control does NOT name its
                          destination, and the exception is the point.
                          With no type chosen the step list is [1, 2, 5], so the
                          next step BY POSITION is Review - but the handler
                          below refuses that move and sends the author to the
                          type field instead. A label reading "Continue: Review"
                          would therefore promise a step it does not go to,
                          which is the exact defect C3 deleted from this row
                          ("Continue to Link Setup", landing on Questions). The
                          honest label is the one that names nothing, because
                          until a type is chosen there is nothing to name.
                        */
                        nextLabel={formData.type ? continueControl.nextLabel : 'Continue'}
                        /*
                          The missing type is still refused here, and it is now
                          refused by the same rules as everywhere else.

                          It used to be a hand-written guard, because this step
                          is reachable with no type set - the step headers are
                          directly clickable - and continuing would have walked
                          the author past the only choice that decides what this
                          form is for. `errorsForStep` keeps `type` in scope on
                          every step for exactly that reason, so the guard is
                          now the general rule rather than a special case that
                          could stop agreeing with it.
                        */
                        onNext={() => continueFromStep(continueControl.onNext)}
                      />
                      )}
                    </>
                  )}

                  {/* Task List tab - only for unmoderated */}
                  {currentStep?.key === 'questions' && (
                      <>
                        <SurveyQuestionsTab
                          formData={formData}
                          validationErrors={validationErrors}
                          handleInputChange={handleInputChange}
                          handleQuestionsChange={handleQuestionsChange}
                          onBlurField={handleBlur}
                          hasLinkedStudy={hasLinkedStudy && !studyMissing}
                          studyIsReadOnly={studyIsReadOnly}
                          readOnlyReason={studyReadOnlyReason}
                          onCopyFromStudy={(studyId) => copyFromStudy(studyId, 'survey')}
                          onPreviewStudy={openPreview}
                          currentUserId={user?.id}
                          answerCounts={answerCounts}
                        />

                        {/* The author's own questions, run as a participant
                            gets them. Above the step controls rather than
                            beside them: it is a way of CHECKING this step, not
                            a way of leaving it. */}
                        <PreviewParticipantButton onClick={() => openPreview()} />

                        {/* Not the last step, and after C3 no step but Review
                            is. The green Save Changes shortcut this row
                            deliberately lacked in edit mode stays, because it
                            is the only way to save an edit without walking to
                            the end of the wizard. */}
                        {continueControl && (
                        <StepActions
                          isEdit={isEdit}
                          onSaveAndExit={handleSaveAndExit}
                          saving={saving}
                          disabled={saveControlsDisabled}
                          justSaved={Boolean(successMessage)}
                          {...backwardControl}
                          onSave={isEdit && hasChanges() ? () => handleSubmit() : undefined}
                          {...continueControl}
                        />
                        )}
                      </>
                    )}

                  {currentStep?.key === 'taskList' && (
                    <>
                      <FirstHandStudyTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleStepsChange={handleStepsChange}
                        onBlurField={handleBlur}
                        hasLinkedStudy={hasLinkedStudy && !studyMissing}
                        studyIsReadOnly={studyIsReadOnly}
                        readOnlyReason={studyReadOnlyReason}
                        onCopyFromStudy={(studyId) => copyFromStudy(studyId, 'recorded')}
                        onPreviewStudy={openPreview}
                        currentUserId={user?.id}
                      />

                      <PreviewParticipantButton onClick={() => openPreview()} />

                      {continueControl && (
                      <StepActions
                        isEdit={isEdit}
                        onSaveAndExit={handleSaveAndExit}
                        saving={saving}
                        disabled={saveControlsDisabled}
                        justSaved={Boolean(successMessage)}
                        {...backwardControl}
                        onSave={isEdit && hasChanges() ? () => handleSubmit() : undefined}
                        {...continueControl}
                      />
                      )}
                    </>
                  )}

                  {/* Consent - on the two paths that author a study, and absent
                      from the three that do not. Review follows it. */}
                  {currentStep?.key === 'consent' && authoringKind && (
                    <>
                      <ConsentStep
                        // Remounted when the linked study is re-read, which is
                        // what an edit-mode save does. ConsentStep captures the
                        // template it started this session on - deliberately,
                        // so the diff and Restore keep pointing at it while the
                        // author types - and that capture has to be refreshed
                        // when the SERVER's answer replaces the form's claim.
                        key={linkedStudyUpdatedAt ?? 'unsaved'}
                        kind={authoringKind}
                        consentText={
                          authoringKind === 'survey'
                            ? formData.inline_survey_consent_text
                            : formData.inline_study_consent_text
                        }
                        templateId={
                          authoringKind === 'survey'
                            ? formData.inline_survey_consent_template_id
                            : formData.inline_study_consent_template_id
                        }
                        templateVersion={
                          authoringKind === 'survey'
                            ? formData.inline_survey_consent_template_version
                            : formData.inline_study_consent_template_version
                        }
                        onBlur={() =>
                          handleBlur(
                            authoringKind === 'survey'
                              ? 'inline_survey_consent_text'
                              : 'inline_study_consent_text'
                          )
                        }
                        fieldId={
                          authoringKind === 'survey'
                            ? 'inline_survey_consent_text'
                            : 'inline_study_consent_text'
                        }
                        validationError={
                          authoringKind === 'survey'
                            ? validationErrors.inline_survey_consent_text
                            : validationErrors.inline_study_consent_text
                        }
                        studyIsReadOnly={studyIsReadOnly}
                        readOnlyReason={studyReadOnlyReason}
                        // A study that could not be READ has no wording for
                        // this step to describe - the form is holding its
                        // defaults - so it must say nothing rather than badge
                        // the boilerplate as this study's approved consent.
                        contentUnavailable={Boolean(studyLoadError)}
                        awaitingContent={awaitingCopiedContent}
                        contentStepTitle={
                          authoringKind === 'survey' ? 'Questions' : 'Task List'
                        }
                        onGoToContent={() => setActiveTab(3)}
                        onChange={(selection) => {
                          const prefix =
                            authoringKind === 'survey' ? 'inline_survey' : 'inline_study';
                          handleInputChange(`${prefix}_consent_text`, selection.text);
                          handleInputChange(
                            `${prefix}_consent_template_id`,
                            selection.templateId
                          );
                          handleInputChange(
                            `${prefix}_consent_template_version`,
                            selection.templateVersion
                          );
                        }}
                      />

                      {continueControl && (
                      <StepActions
                        isEdit={isEdit}
                        onSaveAndExit={handleSaveAndExit}
                        saving={saving}
                        disabled={saveControlsDisabled}
                        justSaved={Boolean(successMessage)}
                        {...backwardControl}
                        onSave={isEdit && hasChanges() ? () => handleSubmit() : undefined}
                        {...continueControl}
                      />
                      )}
                    </>
                  )}

                  {/* Consent for the MODERATED pair (#79): same step component,
                      third consent home. No study exists here, so none of the
                      study read-only machinery applies - the wording belongs to
                      the opportunity row and only its owner reaches this form. */}
                  {currentStep?.key === 'consent' && !authoringKind && (
                    <>
                      <ConsentStep
                        key={opportunityId ?? 'unsaved-moderated'}
                        kind="moderated"
                        consentText={formData.moderated_consent_text}
                        templateId={formData.moderated_consent_template_id}
                        templateVersion={formData.moderated_consent_template_version}
                        onBlur={() => handleBlur('moderated_consent_text')}
                        fieldId="moderated_consent_text"
                        validationError={validationErrors.moderated_consent_text}
                        studyIsReadOnly={false}
                        readOnlyReason={null}
                        contentUnavailable={false}
                        awaitingContent={false}
                        contentStepTitle="Session Management"
                        onGoToContent={() => setActiveTab(3)}
                        onChange={(selection) => {
                          handleInputChange('moderated_consent_text', selection.text);
                          handleInputChange(
                            'moderated_consent_template_id',
                            selection.templateId
                          );
                          handleInputChange(
                            'moderated_consent_template_version',
                            selection.templateVersion
                          );
                        }}
                      />

                      {continueControl && (
                      <StepActions
                        isEdit={isEdit}
                        onSaveAndExit={handleSaveAndExit}
                        saving={saving}
                        disabled={saveControlsDisabled}
                        justSaved={Boolean(successMessage)}
                        {...backwardControl}
                        onSave={isEdit && hasChanges() ? () => handleSubmit() : undefined}
                        {...continueControl}
                      />
                      )}
                    </>
                  )}

                  {/* External Link Tab - for polls, surveys, and questions (not unmoderated) */}
                  {currentStep?.key === 'externalLink' && (
                    <>
                      <ExternalLinkTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleBlur={handleBlur}
                      />

                      {continueControl && (
                      <StepActions
                        isEdit={isEdit}
                        onSaveAndExit={handleSaveAndExit}
                        saving={saving}
                        disabled={saveControlsDisabled}
                        justSaved={Boolean(successMessage)}
                        {...backwardControl}
                        onSave={isEdit && hasChanges() ? () => handleSubmit() : undefined}
                        {...continueControl}
                      />
                      )}
                    </>
                  )}

                  {/* Session Management - Only for Tests and Interviews */}
                  {currentStep?.key === 'sessions' && (
                    <>
                      <div className="form-section mb-5">
                        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
                          <div>
                            <h2 id="sessions-heading" tabIndex={-1} className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>Session Management</h2>
                            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
                              Create time slots for participants to book
                            </p>
                          </div>
                        </div>

                        {isEdit && !opportunityId && !loadingOpportunity && error ? (
                          <div className="alert alert-warning" role="alert">
                            <AlertTriangle size={18} className="me-2" />
                            Cannot load session management. The opportunity may not exist or you may not have permission to edit it.
                          </div>
                        ) : (
                          <AdminSessionManager
                            opportunityId={opportunityId}
                            sessions={sessions}
                            onSessionsChange={setSessions}
                            defaultDurationMinutes={formData.default_duration_minutes}
                            disabled={saving || (isEdit && loadingOpportunity)}
                            isTemporary={!isEdit || !opportunityId}
                            /*
                             * No `onOpportunitySave` and no `onNavigate` any
                             * more, and that is the restructure C3 owes this
                             * path rather than an omission.
                             *
                             * This component used to BE the commit point for a
                             * test or an interview: confirming time slots saved
                             * the opportunity and navigated away, so those two
                             * types were the only ones whose author never saw a
                             * summary of what they were about to create. Slot
                             * confirmation is now just slot confirmation; the
                             * Review step commits, for all five types.
                             */
                            onBack={previousStep ? () => setActiveTab(previousStep.id) : undefined}
                            onBackLabel={previousStep?.title}
                            onContinue={continueControl?.onNext}
                            onContinueLabel={nextStep?.title}
                          />
                        )}
                      </div>
                    </>
                  )}

                  {/*
                    Review - the last step on every shape, and the only step
                    that commits.
                  */}
                  {currentStep?.key === 'review' && (
                    <>
                      <ReviewStep
                        sections={reviewSections}
                        publishRefusal={publishRefusal}
                        onEdit={goToStepAndFocus}
                        isEdit={isEdit}
                        status={formData.status}
                        onStatusChange={(status) => handleInputChange('status', status)}
                        statusError={validationErrors.status}
                        shareLink={
                          persistedOpportunityId
                            ? { opportunityId: persistedOpportunityId, startable: shareLinkStartable }
                            : null
                        }
                        role={user?.role}
                      />

                      {/*
                        The seam C3 left, now filled. It sits between the
                        summary and the action row for the reason C3 gave: an
                        author checks their answers, looks at what the
                        participant will see, and then commits - in that order.
                      */}
                      <PreviewParticipantButton onClick={() => openPreview()} />

                      <StepActions
                        isEdit={isEdit}
                        onSaveAndExit={handleSaveAndExit}
                        saving={saving}
                        disabled={saveControlsDisabled}
                        justSaved={Boolean(successMessage)}
                        {...backwardControl}
                        /*
                          No `onSave` here, deliberately, where every other step
                          has one. On Review the green Save Changes shortcut and
                          the terminal control would be two buttons doing
                          exactly the same thing, sitting next to each other,
                          with two different names - and `getByRole` matching
                          names as substrings, that ambiguity reaches the tests
                          as well as the author.
                        */
                        onSubmit={() => handleSubmit()}
                        submitLabel={isEdit ? 'Save changes' : 'Create opportunity'}
                      />
                    </>
                  )}
                </div>
              </form>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/*
        Only ever mounted with something to lose - `requestExit` navigates
        straight out when the form is untouched, so a clean exit is still one
        click. Cancel is the default action, and the destination is held rather
        than recomputed, so the confirmation cannot send the author somewhere
        other than the button they pressed.
      */}
      <ConfirmationModal
        show={pendingExit !== null}
        title="Leave without saving?"
        message="This opportunity has changes that have not been saved. Leaving now discards them."
        confirmLabel="Discard and leave"
        cancelLabel="Stay on this form"
        variant="warning"
        onConfirm={() => {
          const destination = pendingExit;
          setPendingExit(null);
          if (destination) {
            navigate(destination);
          }
        }}
        onCancel={() => setPendingExit(null)}
      />

      {/*
        The one place a save that detaches answers is added up and named.

        Mounted only when there is something to say - `answersDetachedBy`
        returns null both when nothing answered is being removed and when the
        counts could not be read at all, and neither is a dialog worth showing.
        Confirming re-enters `handleSubmit`, which is why the ref is set before
        the state is cleared: the second pass has to see the authorisation, and
        state written here would not have landed by then.
      */}
      {/*
        Deleting stored work, which is the one thing on this form that does.
        Not a toast and not undoable.

        The wording names what actually goes. `DELETE /api/opportunities/:id`
        removes the opportunity row alone, so questions authored here remain in
        the Task Lists area - and a confirmation that claimed to delete
        "anything authored on it" would be telling the author their questions
        were gone when they were not, which is the wrong direction to be wrong
        in on the one irreversible control here.
      */}
      <ConfirmationModal
        show={confirmingDiscard}
        title="Discard this draft?"
        message="This deletes the draft opportunity and cannot be undone. Any questions or tasks you authored here stay in the Task Lists area, where you can delete them separately."
        confirmLabel="Discard it"
        cancelLabel="Keep working on it"
        variant="danger"
        onConfirm={() => {
          setConfirmingDiscard(false);
          void handleDiscardDraft();
        }}
        onCancel={() => setConfirmingDiscard(false)}
      />

      <ConfirmationModal
        show={pendingDetach !== null}
        title={pendingDetach ? detachedAnswersTitle(pendingDetach) : ''}
        message={pendingDetach ? detachedAnswersMessage(pendingDetach) : ''}
        confirmLabel="Save and remove them"
        cancelLabel="Go back"
        variant="danger"
        onConfirm={() => {
          detachConfirmedRef.current = true;
          setPendingDetach(null);
          void handleSubmit();
        }}
        onCancel={() => setPendingDetach(null)}
      />
      </div>
    </>
  );
};

export default OpportunityForm;
