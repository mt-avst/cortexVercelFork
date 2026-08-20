import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { createOpportunity, updateOpportunity, getOpportunity, getSessions } from '../api/client';
import { getFirstHandStudy } from '../api/firsthand-studies';
import { getPrimaryTargetUrl } from '../lib/recording/task-target';
import {
  withClientIds,
  withoutClientIds,
  type WithClientId
} from '../lib/opportunity-authoring/client-ids';
import { remapAuthoringErrors } from '../lib/opportunity-authoring/authoring-errors';
import { hasUnsavedChanges } from '../lib/opportunity-authoring/dirty-signature';
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
} from '../shared/firsthand/publish-readiness';
import {
  EXTERNAL_LINK_PROTOCOL_MESSAGE,
  isPublishableExternalLink
} from '../shared/firsthand/url-safety';
import {
  authoredStepsOf,
  copiedRecordedFields,
  copiedSurveyFields,
  isAwaitingCopiedContent,
  studyRoundTripsCleanly,
  toInlineStudyPayloadStep,
  toInlineStudyStep,
  toSurveyPayloadStep,
  toSurveyQuestion,
  type AuthoringKind,
  type StudyReadOnlyReason
} from '../lib/opportunity-authoring/hydrate-study';
import type { StudySourceMode } from '../components/OpportunityForm/StudySourceChoice';
import { logger } from '../utils/logger';
import AdminSessionManager from '../components/AdminSessionManager';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import { BasicInfoTab, ConsentStep, ContentDetailsTab, ExternalLinkTab, FirstHandStudyTab, ReviewStep, StepActions, StepNav, SurveyQuestionsTab } from '../components/OpportunityForm';
import ConfirmationModal from '../components/ConfirmationModal';
import { RATING_SCALE_BOUNDS } from '../shared/firsthand/contract';
import {
  CUSTOM_CONSENT_TEMPLATE_ID,
  RECORDED_CONSENT_TEMPLATE,
  SURVEY_CONSENT_TEMPLATE,
  resolveConsentTemplate
} from '../shared/firsthand/consent-templates';
import {
  DEFAULT_SURVEY_CONSENT_TEXT,
  type InlineSurvey as InlineSurveyPayload,
  type SurveyQuestion
} from '../shared/firsthand/survey-authoring';
import {
  DEFAULT_CONSENT_TEXT,
  INLINE_STUDY_LIMITS,
  UNSAFE_TARGET_URL_MESSAGE,
  type InlineStudy as InlineStudyPayload,
  type InlineStudyStep
} from '../shared/firsthand/inline-study';
import { isSafeTargetUrl } from '../shared/firsthand/url-safety';
import { normaliseTargetUrl } from '../utils/targetUrl';

import { CreateOpportunityRequest, UpdateOpportunityRequest, Opportunity, Session } from '../api/types';
import { TrendingUp, UserCircle, AlertTriangle, CheckCircle, LayoutGrid, LogOut } from 'lucide-react';

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
  if (newType !== 'poll' && newType !== 'survey') {
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
  return next;
};

/**
 * Which tab renders each validation error, and what the author sees that field
 * called. The form spans three or four steps depending on the type, and the
 * save controls only exist on the last one, so a refused save is almost always
 * about a field that is not on screen: naming it and opening its step is the
 * whole point. Labels are the
 * on-screen label text minus the required marker - not the state key, which
 * appears nowhere in the UI.
 */
export const FIELD_LOCATIONS: Record<string, { tab: number; label: string }> = {
  type: { tab: 1, label: 'Research Study Type' },
  title: { tab: 1, label: 'Title' },
  meeting_location_optional: { tab: 1, label: 'Meeting Location' },
  purpose_one_liner: { tab: 1, label: 'Purpose' },
  default_duration_minutes: { tab: 1, label: 'Default Duration (minutes)' },
  participant_type_required: { tab: 2, label: 'Participant Type' },
  participant_type_specific_details: { tab: 2, label: 'Specific Criteria' },
  external_link_optional: { tab: 3, label: 'External Link' },
  // Set on neither authoring surface any more - copy mode sends `inline_*` and
  // never this id. It survives for the one state that still carries it: a
  // linked study this author may not change here, which is saved by id. Named
  // for neither tab, because naming one makes the banner lie on the other half
  // of the time.
  firsthand_study_id: { tab: 3, label: 'Existing study content' },
  inline_study_target_url: { tab: 3, label: 'Starting URL' },
  inline_study_duration_minutes: { tab: 3, label: 'Estimated completion time' },
  inline_study_steps: { tab: 3, label: 'Task List' },
  // Step 4 on the two authoring paths, and there is no other kind of
  // opportunity that can produce this error: only an unmoderated study carries
  // a task list, and only an unmoderated study has a Consent step. Same for its
  // survey twin below. A type with no study never sets either key -
  // clearTypeConditionalErrors deletes them on a type change - so a fixed 4 is
  // unambiguous here in a way it would not be for a field two shapes share.
  inline_study_consent_text: { tab: 4, label: 'Consent text' },
  inline_survey_questions: { tab: 3, label: 'Questions' },
  inline_survey_duration_minutes: { tab: 3, label: 'Estimated completion time' },
  inline_survey_consent_text: { tab: 4, label: 'Consent text' }
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
 * Resolve one validation error key to the tab that renders it and the name the
 * author knows it by. Per-task errors are keyed `inline_study_steps.<i>.<field>`
 * and are named by position, since tasks have no other identity on screen.
 * An unknown key falls back to the first tab rather than routing nowhere.
 *
 * The lookup is `hasOwn`-guarded, not `??`: a plain object inherits
 * `constructor`, `toString` and friends, so those keys would return a truthy
 * inherited value, skip the fallback, and yield a banner naming no field and no
 * tab to open - this fix's own failure mode, reintroduced. No user-supplied
 * string becomes an error key today, but backend zod issue paths are one commit
 * away from being mapped straight into these.
 */
export const locateField = (key: string): { tab: number; label: string } => {
  const step = /^inline_study_steps\.(\d+)\./.exec(key);
  if (step) {
    return { tab: 3, label: `Task ${Number(step[1]) + 1}` };
  }

  // Questions have no other identity on screen either, so they are named by
  // position for the same reason tasks are.
  const question = /^inline_survey_questions\.(\d+)\./.exec(key);
  if (question) {
    return { tab: 3, label: `Question ${Number(question[1]) + 1}` };
  }
  // `Object.hasOwn` would read better but needs the es2022 lib, and widening
  // the compiler target for one call is not a trade worth making.
  return Object.prototype.hasOwnProperty.call(FIELD_LOCATIONS, key)
    ? FIELD_LOCATIONS[key]
    : { tab: 1, label: key };
};

/**
 * Turn a set of validation errors into the two things a refusal owes the
 * author: which tab to open, and which fields to fix. The tab is the earliest
 * one holding a problem, so the author works forwards rather than being sent
 * to the last failure and back. Every failing field is named once, in tab
 * order, because fixing them one banner at a time is the same silent failure
 * in slow motion.
 */
export const describeValidationFailure = (
  errors: Record<string, string>
): { tab: number | null; message: string } => {
  const located = Object.keys(errors)
    .map(locateField)
    .sort((a, b) => a.tab - b.tab);
  if (located.length === 0) {
    return { tab: null, message: '' };
  }
  const labels = Array.from(new Set(located.map((field) => field.label)));
  return { tab: located[0].tab, message: `Please fix these fields: ${labels.join(', ')}` };
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
    { id: 1, key: 'basics', title: 'Basic Information', description: 'Configure type and status' },
    { id: 2, key: 'content', title: 'Content & Details', description: 'Define opportunity content' }
  ];

  // A poll or survey has two shapes now. Native delivery collects the questions
  // here; external delivery collects the link it hands off to. `question` has
  // no native path yet and keeps the link tab unconditionally.
  if (type === 'poll' || type === 'survey') {
    tabs.push(
      deliveryMode === 'native'
        ? { id: 3, key: 'questions', title: 'Questions', description: 'What the participant is asked' }
        : { id: 3, key: 'externalLink', title: 'External Link', description: 'Configure external tool' }
    );
  }

  if (type === 'question') {
    tabs.push({ id: 3, key: 'externalLink', title: 'External Link', description: 'Configure external tool' });
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

  // Consent is a step of its own on exactly the paths that author a study, and
  // on no others.
  //
  // Derived from the step that precedes it rather than re-tested against `type`
  // and `deliveryMode`, deliberately. The four blocks above already encode which
  // shapes author content; a fifth predicate saying the same thing in different
  // words is a predicate that can stop agreeing with them, which is the exact
  // drift B1 removed from the step bodies. If a future type authors a study, it
  // pushes `questions` or `taskList` and gets a Consent step for free.
  //
  // An external link, a booked session and a hand-off have no study, so there is
  // no consent for this product to govern: what the participant agrees to lives
  // in the tool on the other side of the link. Adding an empty Consent step
  // there would imply Cortex has a say in something it does not.
  const authoringStep = tabs.find(
    (tab) => tab.key === 'questions' || tab.key === 'taskList'
  );

  if (authoringStep) {
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
const resolveSourceTitle = async (studyId: string): Promise<string> => {
  try {
    const source = await getFirstHandStudy(studyId);
    return source.study.title;
  } catch {
    return '';
  }
};

const OpportunityForm: React.FC<{ allowUserSubmission?: boolean }> = ({ allowUserSubmission = false }) => {
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
    status: allowUserSubmission ? 'draft' as const : 'draft' as 'draft' | 'published',
    display_width: 'single' as 'single' | 'double',
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

      // The vocabulary this opportunity's form authors in, or null when it
      // authors nothing. An external poll can carry a study id it no longer
      // uses - the column has no foreign key and nothing clears it when the
      // delivery mode changes - and reading a study the form will never render
      // would make a failed fetch block a save that has nothing to do with it.
      const authoringKind: AuthoringKind | null =
        opportunity.type === 'unmoderated'
          ? 'recorded'
          : (opportunity.type === 'poll' || opportunity.type === 'survey') &&
              (opportunity.delivery_mode ?? 'external') === 'native'
            ? 'survey'
            : null;

      if (opportunity.firsthand_study_id && authoringKind) {
        try {
          const linked = await getFirstHandStudy(opportunity.firsthand_study_id);
          const kind = linked.study.kind === 'survey' ? 'survey' : 'recorded';
          const authored = authoredStepsOf(linked.steps);

          studyUpdatedAt = linked.study.updated_at ?? null;
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
            authoredFields.inline_survey_questions = withClientIds(
              authored.map(toSurveyQuestion)
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
            authoredFields.inline_study_steps = withClientIds(
              authored.map(toInlineStudyStep)
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
        display_width: opportunity.display_width || 'single',
        start_date: opportunity.start_date || '',
        end_date: opportunity.end_date || '',
        // Read from the linked study rather than defaulted. See authoredFields.
        ...authoredFields,
        // Read from the row rather than defaulted, so editing a native survey
        // does not silently switch it back to an external handoff on save.
        delivery_mode: opportunity.delivery_mode ?? 'external'
      });

      setHasLinkedStudy(Boolean(opportunity.firsthand_study_id));
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
        display_width: opportunity.display_width || 'single' as 'single' | 'double',
        start_date: opportunity.start_date || '',
        end_date: opportunity.end_date || '',
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

  useEffect(() => {
    if (isEdit && id) {
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

  // Set active tab when editing existing opportunity
  // Only user tests and interviews should go to tab 3 (Session Management)
  // All other types should go to tab 1 (Basic Information)
  useEffect(() => {
    if (isEdit && opportunityId && formData.type) {
      if (formData.type === 'test' || formData.type === 'interview') {
        setActiveTab(3); // Go to tab 3 (Session Management) for tests and interviews
      } else {
        setActiveTab(1); // Go to tab 1 (Basic Information) for all other types
      }
    }
  }, [isEdit, opportunityId, formData.type]);



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
      errors.type = 'Please select a research study type';
    }

    if (!formData.title.trim()) {
      errors.title = 'Title is required';
    } else if (formData.title.trim().length < 4) {
      errors.title = 'Title must be at least 4 characters';
    } else if (formData.title.trim().length > 140) {
      errors.title = 'Title must be no more than 140 characters';
    }

    if (!formData.purpose_one_liner.trim()) {
      errors.purpose_one_liner = 'Purpose is required';
    } else if (formData.purpose_one_liner.trim().length < 10) {
      errors.purpose_one_liner = 'Purpose must be at least 10 characters';
    } else if (formData.purpose_one_liner.trim().length > 180) {
      errors.purpose_one_liner = 'Purpose must be no more than 180 characters';
    }

    // Only validate meeting location and duration for test and interview type opportunities
    if (formData.type === 'test' || formData.type === 'interview') {
      if (!formData.meeting_location_optional || !formData.meeting_location_optional.trim()) {
        errors.meeting_location_optional = 'Meeting location is required for tests and interviews';
      }
      // Number.isFinite first: clearing the field stores NaN (parseInt('')), and
      // NaN < 5 and NaN > 240 are BOTH false, so an empty duration passed every
      // check here and failed as an opaque 400 at the API instead.
      if (
        !Number.isFinite(formData.default_duration_minutes) ||
        formData.default_duration_minutes < 5 ||
        formData.default_duration_minutes > 240
      ) {
        errors.default_duration_minutes = 'Duration must be between 5 and 240 minutes';
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
          errors.firsthand_study_id = 'This opportunity has no task list to publish';
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
      (formData.type === 'poll' || formData.type === 'survey') &&
      deliveryMode === 'native'
    ) {
      // A native poll or survey needs its questions, not a link. Mirrors the
      // backend guard, which refuses the same state.
      // The recorded twin's reasoning applies here unchanged.
      if (studyIsReadOnly) {
        if (!formData.firsthand_study_id?.trim()) {
          errors.firsthand_study_id = 'This opportunity has no questions to publish';
        }
      } else if (formData.inline_survey_questions.length === 0) {
        errors.inline_survey_questions =
          formData.study_source === 'copy'
            ? 'Choose a set of questions to start from, or switch to writing them here'
            : 'Add at least one question before publishing';
      }
    } else if (formData.status === 'published' && ['poll', 'survey', 'question'].includes(formData.type)) {
      if (!formData.external_link_optional?.trim()) {
        errors.external_link_optional = 'External link is required for published polls, surveys, and questions';
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
        (formData.type === 'poll' || formData.type === 'survey') &&
        deliveryMode === 'native' &&
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
      (formData.type === 'poll' || formData.type === 'survey') &&
      deliveryMode === 'native' &&
      !studyIsReadOnly;

    (authoringQuestions ? formData.inline_survey_questions : []).forEach((question, index) => {
      if (!question.prompt.trim()) {
        errors[`inline_survey_questions.${index}.prompt`] =
          question.type === 'instruction'
            ? 'Add what the participant should read'
            : 'Add what the participant is asked';
      }

      if (question.type === 'single_choice' || question.type === 'multi_choice') {
        const answers = (question.options ?? []).map((o) => o.trim()).filter(Boolean);
        if (answers.length < 2) {
          errors[`inline_survey_questions.${index}.options`] =
            'A choice question needs at least two answers';
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
            `A rating scale needs between ${RATING_SCALE_BOUNDS.min} and ${RATING_SCALE_BOUNDS.max} points`;
        }
      }
    });

    if (
      authoringQuestions &&
      formData.inline_survey_questions.length > 0 &&
      !formData.inline_survey_consent_text.trim()
    ) {
      errors.inline_survey_consent_text = 'Consent text is required';
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
            'Give a length of at least 1 minute, or leave it empty';
        } else if (surveyDuration > INLINE_STUDY_LIMITS.maxDurationMinutes) {
          errors.inline_survey_duration_minutes =
            `Keep it under ${INLINE_STUDY_LIMITS.maxDurationMinutes} minutes`;
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
          errors[`inline_study_steps.${index}.prompt`] = 'Add what the participant should see';
        }
        if (step.type === 'single_choice') {
          const filled = (step.options ?? []).filter((option) => option.trim()).length;
          if (filled < 2) {
            errors[`inline_study_steps.${index}.options`] = 'A choice task needs at least two options';
          }
        }
      });

      if (
        formData.inline_study_steps.length > 0 &&
        !formData.inline_study_consent_text.trim()
      ) {
        errors.inline_study_consent_text = 'Consent text is required';
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
            'Give a length of at least 1 minute, or leave it empty';
        } else if (duration > INLINE_STUDY_LIMITS.maxDurationMinutes) {
          errors.inline_study_duration_minutes =
            `Keep it under ${INLINE_STUDY_LIMITS.maxDurationMinutes} minutes`;
        }
      }

      const targetUrl = normaliseTargetUrl(formData.inline_study_target_url);
      if (targetUrl && !isSafeTargetUrl(targetUrl)) {
        errors.inline_study_target_url = UNSAFE_TARGET_URL_MESSAGE;
      } else if (targetUrl.length > INLINE_STUDY_LIMITS.maxTargetUrlLength) {
        // Mirrored so an over-long URL fails here rather than as a server 400.
        errors.inline_study_target_url = `Keep the URL under ${INLINE_STUDY_LIMITS.maxTargetUrlLength} characters`;
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
        errors.participant_type_specific_details = 'Specific participant criteria is required when "Specific" is selected';
      } else if (formData.participant_type_specific_details.trim().length < 10) {
        errors.participant_type_specific_details = 'Specific participant criteria must be at least 10 characters';
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
  }, [formData, deliveryMode, studyIsReadOnly, hasLinkedStudy, studyMissing]);

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
    consentText:
      authoringKind === 'survey'
        ? formData.inline_survey_consent_text
        : formData.inline_study_consent_text,
    // Resolved, not claimed. The form holds what the wording ARRIVED as; this
    // asks the same function the server asks whether the wording still IS that,
    // so an author who edited an approved template sees "Custom" here rather
    // than the approval they no longer have.
    consentTemplate: authoringKind
      ? resolveConsentTemplate({
          kind: authoringKind,
          consentText:
            authoringKind === 'survey'
              ? formData.inline_survey_consent_text
              : formData.inline_study_consent_text,
          claimedTemplateId:
            authoringKind === 'survey'
              ? formData.inline_survey_consent_template_id
              : formData.inline_study_consent_template_id,
          claimedTemplateVersion:
            authoringKind === 'survey'
              ? formData.inline_survey_consent_template_version
              : formData.inline_study_consent_template_version
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
    externalLink: formData.external_link_optional
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

  // Validate single field
  const validateField = (fieldName: string, value: string | number | boolean | undefined) => {
    const fieldErrors: Record<string, string> = { ...validationErrors };
    const stringValue = typeof value === 'string' ? value : '';
    const numValue = typeof value === 'number' ? value : 0;

    switch (fieldName) {
      case 'title':
        if (!stringValue.trim()) {
          fieldErrors.title = 'Title is required';
        } else if (stringValue.trim().length < 4) {
          fieldErrors.title = 'Title must be at least 4 characters';
        } else if (stringValue.trim().length > 140) {
          fieldErrors.title = 'Title must be no more than 140 characters';
        } else {
          delete fieldErrors.title;
        }
        break;
      case 'purpose_one_liner':
        if (!stringValue.trim()) {
          fieldErrors.purpose_one_liner = 'Purpose is required';
        } else if (stringValue.trim().length < 10) {
          fieldErrors.purpose_one_liner = 'Purpose must be at least 10 characters';
        } else if (stringValue.trim().length > 180) {
          fieldErrors.purpose_one_liner = 'Purpose must be no more than 180 characters';
        } else {
          delete fieldErrors.purpose_one_liner;
        }
        break;
      case 'meeting_location_optional':
        if (!stringValue.trim()) {
          fieldErrors.meeting_location_optional = 'Meeting location is required';
        } else {
          delete fieldErrors.meeting_location_optional;
        }
        break;
      case 'default_duration_minutes':
        if (formData.type === 'test' || formData.type === 'interview') {
          if (numValue < 5 || numValue > 240) {
            fieldErrors.default_duration_minutes = 'Duration must be between 5 and 240 minutes';
          } else {
            delete fieldErrors.default_duration_minutes;
          }
        }
        break;
      case 'external_link_optional': {
        /*
         * The THIRD validator of this field, and it had its own bare
         * `new URL(...)` and its own wording ("External link must be a valid
         * URL") - so on blur the author was told a `javascript:` link was fine,
         * and on submit told it was not, in different words. One predicate and
         * one message now, imported like the other two.
         *
         * Same split as the submit path: presence is publish-gated, the scheme
         * is not.
         */
        const link = stringValue.trim();
        const requiresLink =
          formData.status === 'published' &&
          ['poll', 'survey', 'question'].includes(formData.type);

        if (requiresLink && !link) {
          fieldErrors.external_link_optional = 'External link is required for published polls, surveys, and questions';
        } else if (link && !isPublishableExternalLink(stringValue)) {
          fieldErrors.external_link_optional = EXTERNAL_LINK_PROTOCOL_MESSAGE;
        } else {
          delete fieldErrors.external_link_optional;
        }
        break;
      }
      case 'participant_type_specific_details':
        if (formData.participant_type_required === 'specific') {
          if (!stringValue.trim()) {
            fieldErrors.participant_type_specific_details = 'Specific participant criteria is required when "Specific" is selected';
          } else if (stringValue.trim().length < 10) {
            fieldErrors.participant_type_specific_details = 'Specific participant criteria must be at least 10 characters';
          } else {
            delete fieldErrors.participant_type_specific_details;
          }
        } else {
          delete fieldErrors.participant_type_specific_details;
        }
        break;
    }

    setValidationErrors(fieldErrors);
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
      formData.display_width !== originalFormData.display_width ||
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
  const requestExit = (destination: string) => {
    if (hasUnsavedWork()) {
      setPendingExit(destination);
      return;
    }
    navigate(destination);
  };

  /**
   * What to send for a duration the author may have cleared.
   *
   * `undefined` omits the key, which the in-place update path reads as "this
   * request says nothing about the duration" and leaves the stored value
   * alone. That is right for a form that never showed the field - and wrong
   * now that it does: an author who cleared a populated field got a successful
   * save and the old number still stored, with no way to remove it at all.
   *
   * So an empty field is `null` when the study HAD one at load (a deliberate
   * clear) and `undefined` when it did not (nothing to say).
   */
  const durationToSend = (
    current: number | undefined,
    original: number | undefined
  ): number | null | undefined => {
    if (current) return current;
    return original === undefined ? undefined : null;
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
      setError('The opportunity was saved but its time slots were not. Add them from the dashboard.');
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

    // Prevent double-clicks - return early if already saving
    if (saving) {
      logger.debug('Already saving, ignoring duplicate click');
      return undefined;
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
      // nothing: the create controls only exist on the last tab, so the field
      // at fault is usually two tabs away and its inline error is off screen.
      const { tab } = describeValidationFailure(errors);
      logger.error('Validation errors', { errors });
      showRefusal();
      setSuccessMessage('');
      // Only to a step this shape actually HAS. FIELD_LOCATIONS is a static map
      // over every field in the form, so it names step 4 for consent - and the
      // shapes with no study have no step 4. Setting one anyway renders no step
      // body at all, because the render guards key off `currentStep`, which
      // `tabs.find` returns undefined for: the author would be told to fix a
      // field and shown a blank page.
      //
      // Also defence only, for the same reason the clamp above is:
      // `clearTypeConditionalErrors` deletes both consent keys on every type
      // change, so no consent error survives into a shape that lacks step 4.
      // The guard costs a predicate and removes a whole class of blank-page
      // failure from every future change to the step set.
      if (tab && tabs.some((candidate) => candidate.id === tab)) {
        setActiveTab(tab);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return undefined;
    }

    try {
      setSaving(true);
      setError('');
      setRefusalShown(false);
      setSuccessMessage('');

      // inline_study is not on the shared CreateOpportunityRequest: shared/types
      // is flattened into one file when copied here, so it cannot import the
      // inline-study contract. Added at the call site instead.
      const data: Partial<CreateOpportunityRequest & {
        display_width?: 'single' | 'double';
        inline_study?: InlineStudyPayload;
        // Same reason as inline_study: the survey contract cannot be imported
        // into the flattened shared types, so it is added at the call site.
        inline_survey?: InlineSurveyPayload;
        delivery_mode?: 'native' | 'external';
      }> = {
        type: formData.type as CreateOpportunityRequest['type'],
        title: formData.title.trim(),
        purpose_one_liner: formData.purpose_one_liner.trim(),
        description_optional: formData.description_optional.trim() || undefined,
        product_optional: formData.product_optional.trim() || undefined,
        meeting_location_optional: formData.meeting_location_optional.trim(),
        /*
         * Sent only on the shapes that HAVE an External Link step.
         *
         * It used to be sent unconditionally, which is what made a legacy bad
         * value unrepairable. An unmoderated, test, interview or native-survey
         * row holding a `javascript:` link from before the schema was hardened
         * resends it on every save, is refused 400 by the schema, and has no
         * External Link input anywhere in its step list to fix it in - the
         * refusal banner even routes to tab 3, which on those shapes is Task
         * List or Session Management. Found by the security gate; my own repair
         * test only covered `question`, the one shape that has the step.
         *
         * Derived from the step list, not from a type test, for the same reason
         * everything else on this form is.
         */
        ...(tabs.some((step) => step.key === 'externalLink')
          ? { external_link_optional: formData.external_link_optional.trim() || undefined }
          : {}),
        participant_type_required: formData.participant_type_required,
        participant_type_specific_details: formData.participant_type_specific_details.trim() || undefined,
        status: allowUserSubmission ? 'draft' : formData.status
      };

      // Only include default_duration_minutes for test and interview types
      if (formData.type === 'test' || formData.type === 'interview') {
        data.default_duration_minutes = formData.default_duration_minutes;
      }

      // Include start_date, end_date, and firsthand_study_id for external link / unmoderated types
      if (['poll', 'survey', 'question', 'unmoderated'].includes(formData.type)) {
        data.start_date = formData.start_date || undefined;
        data.end_date = formData.end_date || undefined;
      }

      if (formData.type === 'unmoderated') {
        // Authoring is available on create, on an edit of a draft saved before
        // its tasks were written, AND on an edit of a task list this author may
        // change - which A1 added and A0 made safe by updating the linked study
        // in place instead of minting a second one. Only a list this form
        // cannot author here (someone else's, or one holding a step type this
        // form cannot represent) still sends its id and is edited in the Task
        // Lists area.
        const authoringInline = authoringInlineStudy;

        // Exactly one of the two, never both. An opportunity that already has
        // a study keeps `firsthand_study_id` in state, so authoring content
        // into it must OMIT the id rather than send it or null it: the PATCH
        // guards test `!== undefined`, and a null would be read as "clear the
        // link" in the same breath as rewriting the study it pointed at.
        data.firsthand_study_id = authoringInline
          ? undefined
          : formData.firsthand_study_id?.trim() || undefined;

        if (authoringInline) {
          // Must match what collectValidationErrors checked, or a value could pass
          // validation and then be sent in a different shape.
          const targetUrl = normaliseTargetUrl(formData.inline_study_target_url);

          data.inline_study = {
            // Omitted rather than sent empty: its absence is meaningful, and
            // the contract rejects an empty string.
            ...(targetUrl ? { target_url: targetUrl } : {}),
            consent_text: formData.inline_study_consent_text.trim(),
            // Sent as a claim, not as an instruction. The server checks it
            // against the wording beside it and writes `custom` when the two
            // disagree, so nothing this form sends can make a study claim
            // approval it does not have. `custom` is omitted rather than sent:
            // it is the server's answer, never the client's assertion.
            ...(formData.inline_study_consent_template_id !== CUSTOM_CONSENT_TEMPLATE_ID &&
            formData.inline_study_consent_template_version !== null
              ? {
                  consent_template_id: formData.inline_study_consent_template_id,
                  consent_template_version:
                    formData.inline_study_consent_template_version
                }
              : {}),
            // The study's OWN duration, not the opportunity's. This used to
            // send `default_duration_minutes`, which unmoderated never shows,
            // so every recorded study inherited that field's default and told
            // participants a length nobody had chosen.
            // The automatic estimate is what a save sends while it is in
            // force. Derived HERE from the same list the tab shows it from, so
            // a stale copy in state cannot be sent instead of the number the
            // author was actually looking at.
            estimated_duration_minutes: durationToSend(
              formData.inline_study_duration_auto
                ? estimateRecordedMinutes(formData.inline_study_steps) ?? undefined
                : formData.inline_study_duration_minutes,
              originalFormData?.inline_study_duration_minutes
            ),
            // Built by the same function studyRoundTripsCleanly checks with,
            // so the fields this sends and the fields the form claims it can
            // reproduce cannot drift apart again. They did, and it deleted
            // helper_text and is_required from every task list built in the
            // Task Lists area.
            steps: formData.inline_study_steps.map(toInlineStudyPayloadStep),
            // Provenance travels with the content that came from it. Omitted
            // rather than sent empty: `inlineStudySchema` takes a non-empty
            // string, and the column is NULL for anything authored from blank.
            ...(formData.copied_from_study_id
              ? { copied_from_study_id: formData.copied_from_study_id }
              : {})
          };
        }
      }

      if (formData.type === 'poll' || formData.type === 'survey') {
        // Sent only when it actually CHANGED.
        //
        // The backend deliberately gates its publish and linkage checks on the
        // request changing the shape, so an unrelated edit to a row already in
        // a bad state stays allowed and the row can be repaired. Sending this
        // on every save made both conditions permanently true for polls and
        // surveys: a published poll whose external link was somehow null could
        // no longer have its TITLE corrected through the form, and a native
        // survey whose study had been deleted was refused every edit. That is
        // the same lock-out the backend guard was gated to prevent,
        // reintroduced from the client.
        if (
          !isEdit ||
          deliveryMode !== (originalFormData?.delivery_mode ?? 'external')
        ) {
          data.delivery_mode = deliveryMode;
        }

        if (deliveryMode === 'native') {
          // Same shape as the task-list branch above, and the same reason for
          // exactly one of the two: the stored id stays in state, and copy mode
          // authors content rather than pointing at somebody else's study.
          const authoringInline = authoringInlineSurvey;

          data.firsthand_study_id = authoringInline
            ? undefined
            : formData.firsthand_study_id?.trim() || undefined;

          if (authoringInline) {
            data.inline_survey = {
              consent_text: formData.inline_survey_consent_text.trim(),
              ...(formData.inline_survey_consent_template_id !== CUSTOM_CONSENT_TEMPLATE_ID &&
              formData.inline_survey_consent_template_version !== null
                ? {
                    consent_template_id: formData.inline_survey_consent_template_id,
                    consent_template_version:
                      formData.inline_survey_consent_template_version
                  }
                : {}),
              // Same rule as the task-list branch above.
              estimated_duration_minutes: durationToSend(
                formData.inline_survey_duration_auto
                  ? estimateSurveyMinutes(formData.inline_survey_questions) ?? undefined
                  : formData.inline_survey_duration_minutes,
                originalFormData?.inline_survey_duration_minutes
              ),
              // Same function studyRoundTripsCleanly checks with. This branch
              // was already faithful; sharing the serialiser is what stops it
              // drifting the way the task-list branch did.
              steps: formData.inline_survey_questions.map(toSurveyPayloadStep),
              // The recorded twin carries this too. `inlineSurveySchema` is
              // `.strict()`, so an unknown key here is a refused save rather
              // than a dropped field - which is exactly why both twins were
              // changed in the same breath.
              ...(formData.copied_from_study_id
                ? { copied_from_study_id: formData.copied_from_study_id }
                : {})
            };
          }
        }
        // No `else` clearing inline_survey: the payload is built fresh on every
        // submit and only the native branch above ever sets it, so an external
        // handoff cannot carry authored questions. A defensive assignment here
        // was dead code, and the mutation proved it - the test asserting their
        // absence passes without it, because the absence is structural.
      }

      // Only superadmins can set display_width
      if (user?.role === 'superadmin') {
        data.display_width = formData.display_width;
      }


      let savedOpportunity: Opportunity;
      // False only when the opportunity saved and its time slots did not.
      let sessionsPersisted = true;
      if (isEdit && id) {
        savedOpportunity = await updateOpportunity(id, data as UpdateOpportunityRequest);

        await persistTemporarySessions(savedOpportunity.id);
      } else {
        savedOpportunity = await createOpportunity(data as CreateOpportunityRequest);
        setOpportunityId(savedOpportunity.id);

        // What is on screen has now been stored, so it is the new baseline
        // for "would leaving lose anything".
        openingFormData.current = formData;

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
      }

      // Update original form data after successful save
      if (isEdit) {
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
        // Show success message for edit mode
        const isDraft = formData.status === 'draft';
        setSuccessMessage(
          isDraft
            ? '⚠️ Changes saved as DRAFT - Not visible to users yet. Change status to Published to make it visible.'
            : 'Changes saved successfully!'
        );
        // Clear success message after timeout (longer for draft warnings)
        setTimeout(() => setSuccessMessage(''), isDraft ? 3000 : 1500);
      }

      // For edit mode, return the existing opportunity ID
      if (isEdit && savedOpportunity) {
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
        if (allowUserSubmission) {
          // For user submissions, navigate to home with success message
          navigate('/', { state: { message: 'Research request submitted successfully! It will be reviewed by an admin.' } });
        } else {
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
      }

      return savedOpportunity?.id;

    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(axiosError.response?.data?.error || 'Failed to save opportunity');
    } finally {
      setSaving(false);
    }
  };

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
    } catch {
      return `Those ${noun} could not be loaded, so nothing was copied. Try again.`;
    }

    const sourceKind: AuthoringKind = loaded.study.kind === 'survey' ? 'survey' : 'recorded';
    if (sourceKind !== kind) {
      return kind === 'survey'
        ? 'That is a recorded task list, not a set of questions, so it cannot be copied here.'
        : 'That is a set of survey questions, not a task list, so it cannot be copied here.';
    }

    if (!studyRoundTripsCleanly(loaded.steps, kind, loaded.study.id)) {
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

  const handleInputChange = (
    field: string,
    // `null` is here for `consent_template_version`, which is null exactly when
    // the wording is custom. `undefined` already meant "no value" for the
    // optional fields, and reusing it for this one would make "custom wording"
    // indistinguishable from "field not set" in the dirty check.
    value: string | number | boolean | null | undefined
  ) => {
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
      // type to a poll or survey stayed in state with no picker on screen, and
      // was submitted - so the API refused the save with a message about a task
      // list the form was no longer showing.
      if (field === 'type' && (value === 'poll' || value === 'survey')) {
        return {
          ...prev,
          ...clearedSource,
          type: value,
          firsthand_study_id: '',
        };
      }

      // Every other type change - to `question`, `test` or `interview` - lands
      // here, and must still drop the source choice. Those types have no
      // authoring surface at all, so a copy taken before the switch would
      // otherwise sit in state invisibly and be sent on the next save.
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
  };

  const handleBlur = (field: string, value: string | number | boolean | undefined) => {
    // Validate field on blur
    validateField(field, value);
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

  // Redirect to home if not admin (unless allowUserSubmission is true)
  if (!loading && user && user.role !== 'researcher_admin' && user.role !== 'superadmin' && !allowUserSubmission) {
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
    <div className="admin-page-bg">
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
              onClick={() => requestExit(allowUserSubmission ? '/' : '/admin')}
            >
              <LogOut size={16} className="me-1" />
              {allowUserSubmission ? 'Exit to home' : 'Exit to dashboard'}
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
                  {/* Analytics button - only for polls, surveys, and unmoderated tests in edit mode */}
                  {isEdit && id && (formData.type === 'poll' || formData.type === 'survey' || formData.type === 'unmoderated') && (
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
              {refusalShown && describeValidationFailure(validationErrors).message && (
                <div
                  key={`refusal-${refusalCount}`}
                  className="alert alert-danger mx-4 mt-4 mb-0"
                  role="alert"
                >
                  <AlertTriangle size={18} className="me-2" />
                  {describeValidationFailure(validationErrors).message}
                </div>
              )}

              {error && (
                <div className="alert alert-danger mx-4 mt-4 mb-0" role="alert">
                  <AlertTriangle size={18} className="me-2" />
                  {error}
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
                        allowUserSubmission={allowUserSubmission}
                      />

                      {/* Display Width Setting - Superadmin Only */}
                      {user?.role === 'superadmin' && (
                        <div className="form-section mb-4 display-settings-section" style={{
                          paddingTop: '1.5rem',
                          marginTop: '1rem'
                        }}>
                          <div className="d-flex align-items-center mb-3">
                            <div>
                              <h3 className="h5 mb-1 section-title" style={{ fontSize: '1.2rem', fontWeight: '600' }}>
                                <LayoutGrid size={18} className="me-2 section-icon" />
                                Display Settings
                              </h3>
                              <p className="mb-0 section-description" style={{ fontSize: '0.875rem' }}>
                                Control how this study appears on the user home page (Superadmin only)
                              </p>
                            </div>
                          </div>

                          <div className="row g-3">
                            <div className="col-md-6">
                              <div className="form-group">
                                <label htmlFor="display_width" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                                  Pod Display Width
                                </label>
                                <div id="display_width-help" className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
                                  Double-width pods are more prominent on the user home page
                                </div>
                                <select
                                  id="display_width"
                                  className="form-select"
                                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', maxWidth: '300px' }}
                                  value={formData.display_width}
                                  onChange={(e) => handleInputChange('display_width', e.target.value)}
                                  aria-describedby="display_width-help"
                                >
                                  <option value="single">📦 Single Width - Standard display</option>
                                  <option value="double">📦📦 Double Width - Featured display</option>
                                </select>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {continueControl && (
                      <StepActions
                        isEdit={isEdit}
                        saving={saving}
                        disabled={saveControlsDisabled}
                        onSave={isEdit && hasChanges() ? () => handleSubmit() : undefined}
                        {...continueControl}
                        onNext={() => {
                          // Validate basic info before continuing
                          const errors: Record<string, string> = {};

                          if (!formData.type) {
                            errors.type = 'Please select a research study type';
                          }
                          if (!formData.title.trim()) {
                            errors.title = 'Title is required';
                          } else if (formData.title.trim().length < 4) {
                            errors.title = 'Title must be at least 4 characters';
                          }
                          if (!formData.purpose_one_liner.trim()) {
                            errors.purpose_one_liner = 'Purpose is required';
                          } else if (formData.purpose_one_liner.trim().length < 10) {
                            errors.purpose_one_liner = 'Purpose must be at least 10 characters';
                          }
                          // Only require meeting location for test/interview types
                          if ((formData.type === 'test' || formData.type === 'interview') && !formData.meeting_location_optional?.trim()) {
                            errors.meeting_location_optional = 'Meeting location is required for tests and interviews';
                          }

                          if (Object.keys(errors).length > 0) {
                            setValidationErrors(errors);
                            // Reported the same way as every other refusal
                            // in this form, so the author learns one shape.
                            showRefusal();
                            // Scroll to top to see errors
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                            return;
                          }

                          continueControl.onNext();
                        }}
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
                        saving={saving}
                        disabled={saveControlsDisabled}
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
                        onNext={() => {
                          /*
                           * Asks the question it actually means.
                           *
                           * This used to read "is there a step after 2", which
                           * was a true proxy for "has a type been chosen" only
                           * while the shapes ended at the type-dependent step.
                           * Review now sits after step 2 on every shape,
                           * including the one with no type, so the proxy
                           * silently became "yes, always" - and the author who
                           * never picked a type would have been walked past the
                           * only choice that decides what this form is for.
                           *
                           * The step headers are directly clickable, so this
                           * step is reachable with no type set. Send them to the
                           * field that is blocking them rather than forward.
                           */
                          if (!formData.type) {
                            setValidationErrors(prev => ({
                              ...prev,
                              type: 'Please select a research study type'
                            }));
                            showRefusal();
                            setActiveTab(1);
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                            return;
                          }
                          continueControl.onNext();
                        }}
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
                          hasLinkedStudy={hasLinkedStudy && !studyMissing}
                          studyIsReadOnly={studyIsReadOnly}
                          readOnlyReason={studyReadOnlyReason}
                          onCopyFromStudy={(studyId) => copyFromStudy(studyId, 'survey')}
                          currentUserId={user?.id}
                        />

                        {/* Not the last step, and after C3 no step but Review
                            is. The green Save Changes shortcut this row
                            deliberately lacked in edit mode stays, because it
                            is the only way to save an edit without walking to
                            the end of the wizard. */}
                        {continueControl && (
                        <StepActions
                          isEdit={isEdit}
                          saving={saving}
                          disabled={saveControlsDisabled}
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
                        hasLinkedStudy={hasLinkedStudy && !studyMissing}
                        studyIsReadOnly={studyIsReadOnly}
                        readOnlyReason={studyReadOnlyReason}
                        onCopyFromStudy={(studyId) => copyFromStudy(studyId, 'recorded')}
                        currentUserId={user?.id}
                      />

                      {continueControl && (
                      <StepActions
                        isEdit={isEdit}
                        saving={saving}
                        disabled={saveControlsDisabled}
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
                        saving={saving}
                        disabled={saveControlsDisabled}
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
                        saving={saving}
                        disabled={saveControlsDisabled}
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
                            <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>Session Management</h2>
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
                      />

                      {/*
                        E1's "Preview participant experience" entry point belongs
                        here, and it is deliberately absent rather than stubbed.

                        E1 has not landed - it is a parallel branch of this plan
                        that rebuilds the participant read-through, and its own
                        brief says its entry point is added by C3 rather than by
                        E1. So this is the seam. A disabled button or one wired
                        to nothing would read to an author as a broken feature,
                        which is worse than a feature that is not there yet: the
                        whole point of this screen is that every control on it
                        does what it says.

                        When E1 lands it goes between the summary and the action
                        row, so an author checks their answers, looks at what the
                        participant will see, and then commits - in that order.
                      */}

                      <StepActions
                        isEdit={isEdit}
                        saving={saving}
                        disabled={saveControlsDisabled}
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
    </div>
  );
};

export default OpportunityForm;
