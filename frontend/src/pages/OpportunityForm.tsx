import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { createOpportunity, updateOpportunity, getOpportunity, getSessions } from '../api/client';
import { getFirstHandStudy } from '../api/firsthand-studies';
import { getPrimaryTargetUrl } from '../lib/recording/task-target';
import {
  authoredStepsOf,
  studyRoundTripsCleanly,
  toInlineStudyPayloadStep,
  toInlineStudyStep,
  toSurveyPayloadStep,
  toSurveyQuestion,
  type AuthoringKind,
  type StudyReadOnlyReason
} from '../lib/opportunity-authoring/hydrate-study';
import { logger } from '../utils/logger';
import AdminSessionManager from '../components/AdminSessionManager';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import { BasicInfoTab, ContentDetailsTab, ExternalLinkTab, FirstHandStudyTab, SurveyQuestionsTab } from '../components/OpportunityForm';
import { RATING_SCALE_BOUNDS } from '../shared/firsthand/contract';
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
import { ArrowLeft, TrendingUp, UserCircle, AlertTriangle, CheckCircle, LayoutGrid, Save, ArrowRight } from 'lucide-react';

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
 * called. The form spans three tabs and the save controls only exist on the
 * last one, so a refused save is almost always about a field that is not on
 * screen: naming it and opening its tab is the whole point. Labels are the
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
  // One key, two controls: the task list picker and the questions picker both
  // set it. Named for neither, because naming one makes the banner lie on the
  // other half of the time.
  firsthand_study_id: { tab: 3, label: 'Existing study content' },
  inline_study_target_url: { tab: 3, label: 'Starting URL' },
  inline_study_duration_minutes: { tab: 3, label: 'How long it takes' },
  inline_study_steps: { tab: 3, label: 'Task List' },
  inline_study_consent_text: { tab: 3, label: 'Consent text' },
  inline_survey_questions: { tab: 3, label: 'Questions' },
  // No entry for inline_survey_duration_minutes: nothing validates it. Its
  // task-list counterpart has one because an emptied duration IS refused
  // there; a survey's is optional with no rule, and the completeness test in
  // both directions is what says so.
  inline_survey_consent_text: { tab: 3, label: 'Consent text' }
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
 */
export const getTabsForType = (
  type: string,
  deliveryMode: 'native' | 'external' = 'external'
) => {
  const tabs = [
    { id: 1, title: 'Basic Information', description: 'Configure type and status' },
    { id: 2, title: 'Content & Details', description: 'Define opportunity content' }
  ];

  // A poll or survey has two shapes now. Native delivery collects the questions
  // here; external delivery collects the link it hands off to. `question` has
  // no native path yet and keeps the link tab unconditionally.
  if (type === 'poll' || type === 'survey') {
    tabs.push(
      deliveryMode === 'native'
        ? { id: 3, title: 'Questions', description: 'What the participant is asked' }
        : { id: 3, title: 'External Link', description: 'Configure external tool' }
    );
  }

  if (type === 'question') {
    tabs.push({ id: 3, title: 'External Link', description: 'Configure external tool' });
  }

  if (type === 'unmoderated') {
    tabs.push({ id: 3, title: 'Task List', description: 'What the participant does' });
  }

  if (type === 'test' || type === 'interview') {
    tabs.push({
      id: 3,
      title: 'Session Management',
      description: 'Create time slots'
    });
  }

  return tabs;
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
    inline_study_consent_text: DEFAULT_CONSENT_TEXT as string,
    inline_study_steps: [] as InlineStudyStep[],
    reuse_existing_study: false,
    // Native poll and survey. Defaults to external so an author who never opens
    // the choice gets exactly today's behaviour.
    delivery_mode: 'external' as 'native' | 'external',
    inline_survey_duration_minutes: undefined as number | undefined,
    inline_survey_consent_text: DEFAULT_SURVEY_CONSENT_TEXT as string,
    inline_survey_questions: [] as SurveyQuestion[],
    reuse_existing_survey: false
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
  // hasLinkedStudy hides the "reuse an existing one instead" tickbox: swapping
  // which study an opportunity points at is not this form's job once it points
  // at one.
  const [hasLinkedStudy, setHasLinkedStudy] = useState(false);
  // Whether the linked study may not be authored HERE. True when the API says
  // this reader cannot write it, and also when it holds a step type this form
  // cannot represent - see formCanAuthorEveryStep. Only this flag swaps the tab
  // body to the picker.
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
  const [loadingOpportunity, setLoadingOpportunity] = useState(false);
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
  const [originalFormData, setOriginalFormData] = useState<typeof formData | null>(null);

  // Absent means external, matching the column default and every poll and
  // survey that existed before the choice did.
  const deliveryMode = formData.delivery_mode ?? 'external';

  // Define tabs based on opportunity type
  const tabs = getTabsForType(formData.type, deliveryMode);

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
        inline_study_consent_text: DEFAULT_CONSENT_TEXT,
        inline_study_steps: [] as InlineStudyStep[],
        inline_survey_duration_minutes: undefined as number | undefined,
        inline_survey_consent_text: DEFAULT_SURVEY_CONSENT_TEXT,
        inline_survey_questions: [] as SurveyQuestion[],
        // Both deliberately FALSE once content is hydrated: a ticked reuse box
        // sends the study id instead of the authored content, which is the same
        // save the old code made and the reason an edit could never change what
        // was written.
        reuse_existing_study: false,
        reuse_existing_survey: false
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
            authoredFields.inline_survey_questions = authored.map(toSurveyQuestion);
            authoredFields.inline_survey_consent_text = linked.study.consent_text;
            authoredFields.inline_survey_duration_minutes =
              linked.study.estimated_duration_minutes ?? undefined;
          } else {
            authoredFields.inline_study_steps = authored.map(toInlineStudyStep);
            authoredFields.inline_study_consent_text = linked.study.consent_text;
            authoredFields.inline_study_duration_minutes =
              linked.study.estimated_duration_minutes ?? undefined;
            // The study-level starting URL. Read with the runtime's own
            // resolver rather than a second "first step carrying a target"
            // rule: toStudySteps writes target_url onto EVERY authored step,
            // and a private rule here would be free to disagree with the one
            // the participant's runner actually follows.
            authoredFields.inline_study_target_url =
              getPrimaryTargetUrl(linked.steps) ?? '';
          }

          // A study this form cannot author is still shown as linked, but
          // through the picker - and the reuse flag has to say so, or the
          // publish check would demand a study id the picker is not being
          // asked for.
          if (readOnly) {
            authoredFields.reuse_existing_study = true;
            authoredFields.reuse_existing_survey = true;
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
          // has vanished falls through to minting a replacement. Read-only
          // plus a save that is allowed is what lets the author ask for that
          // repair.
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
          readOnly = true;
          authoredFields.reuse_existing_study = true;
          authoredFields.reuse_existing_survey = true;
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
  useEffect(() => {
    const maxTabId = Math.max(...getTabsForType(formData.type, deliveryMode).map(tab => tab.id));
    if (activeTab > maxTabId) {
      setActiveTab(1);
    }
  }, [formData.type, deliveryMode, activeTab]);

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
  const collectValidationErrors = (): Record<string, string> => {
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
      if (formData.reuse_existing_study || studyIsReadOnly) {
        if (!formData.firsthand_study_id?.trim()) {
          // The reuse tickbox is not rendered once a study is linked, so do not
          // tell that author to untick it. Keyed on hasLinkedStudy rather than
          // studyIsReadOnly because it is the tickbox's own visibility rule.
          errors.firsthand_study_id = hasLinkedStudy
            ? 'Select a launched task list before publishing'
            : 'Select a launched task list, or untick the reuse box and write the tasks here';
        }
      } else if (formData.inline_study_steps.length === 0) {
        // Named against the thing the author does, not the object model. The
        // backend rejects the same state with an equivalent message.
        errors.inline_study_steps = 'Add at least one task before publishing';
      }
    } else if (
      formData.status === 'published' &&
      (formData.type === 'poll' || formData.type === 'survey') &&
      deliveryMode === 'native'
    ) {
      // A native poll or survey needs its questions, not a link. Mirrors the
      // backend guard, which refuses the same state.
      if (formData.reuse_existing_survey || studyIsReadOnly) {
        if (!formData.firsthand_study_id?.trim()) {
          errors.firsthand_study_id = hasLinkedStudy
            ? 'Select a launched set of questions before publishing'
            : 'Select a launched set of questions, or untick the reuse box and write them here';
        }
      } else if (formData.inline_survey_questions.length === 0) {
        errors.inline_survey_questions = 'Add at least one question before publishing';
      }
    } else if (formData.status === 'published' && ['poll', 'survey', 'question'].includes(formData.type)) {
      if (!formData.external_link_optional?.trim()) {
        errors.external_link_optional = 'External link is required for published polls, surveys, and questions';
      } else {
        try {
          new URL(formData.external_link_optional);
        } catch {
          errors.external_link_optional = 'External link must be a valid URL';
        }
      }
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
    if (hasLinkedStudy && !studyIsReadOnly) {
      if (
        formData.type === 'unmoderated' &&
        !formData.reuse_existing_study &&
        formData.inline_study_steps.length === 0
      ) {
        errors.inline_study_steps =
          'A task list needs at least one task. Add one, or delete the opportunity if you no longer need it';
      }

      if (
        (formData.type === 'poll' || formData.type === 'survey') &&
        deliveryMode === 'native' &&
        !formData.reuse_existing_survey &&
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
      !formData.reuse_existing_survey &&
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

      // The number input's min/max never runs: the save controls are
      // type="button" and call handleSubmit directly, and the Questions tab is
      // unmounted while the author is on another tab. Without this the contract
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

    // Task content is checked whenever tasks exist, not only at publish: the
    // backend contract rejects an empty prompt or a one-option choice on every
    // save, so a draft with a half-written task would fail server-side with a
    // far less useful message.
    if (formData.type === 'unmoderated' && !formData.reuse_existing_study && !studyIsReadOnly) {
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
      const duration = formData.inline_study_duration_minutes;
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

    setValidationErrors(errors);
    return errors;
  };

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
        if (formData.status === 'published' && ['poll', 'survey', 'question'].includes(formData.type)) {
          if (!stringValue.trim()) {
            fieldErrors.external_link_optional = 'External link is required for published polls, surveys, and questions';
          } else {
            try {
              new URL(stringValue);
              delete fieldErrors.external_link_optional;
            } catch {
              fieldErrors.external_link_optional = 'External link must be a valid URL';
            }
          }
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
      JSON.stringify(formData.inline_survey_questions) !==
        JSON.stringify(originalFormData.inline_survey_questions) ||
      formData.inline_survey_consent_text.trim() !==
        originalFormData.inline_survey_consent_text.trim() ||
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
      formData.inline_study_duration_minutes !==
        originalFormData.inline_study_duration_minutes ||
      formData.inline_survey_duration_minutes !==
        originalFormData.inline_survey_duration_minutes ||
      // No length comparison to go with this one. There is no input where the
      // lengths differ and the stringifications match, so a length clause is
      // exactly the "looks like coverage while testing nothing" shape the note
      // above warns about - it cannot be killed by a mutation on its own. The
      // survey pair a few lines up has the same redundancy and predates A1;
      // removing it is a tidy of its own rather than something to smuggle in
      // here.
      JSON.stringify(formData.inline_study_steps) !==
        JSON.stringify(originalFormData.inline_study_steps) ||
      (formData.start_date || '') !== (originalFormData.start_date || '') ||
      (formData.end_date || '') !== (originalFormData.end_date || '') ||
      formData.reuse_existing_study !== originalFormData.reuse_existing_study ||
      formData.reuse_existing_survey !== originalFormData.reuse_existing_survey ||
      sessions.some(session => session.id.startsWith('temp-session-'))
    );
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
      if (tab) {
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
        external_link_optional: formData.external_link_optional.trim() || undefined,
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
        const authoringInline =
          !studyIsReadOnly &&
          !formData.reuse_existing_study &&
          formData.inline_study_steps.length > 0;

        // Exactly one of the two, never both. A study id can survive in state
        // after the author ticks reuse, picks one, then unticks and writes
        // tasks instead; sending it alongside the authored study would be
        // ambiguous, and the backend rejects that rather than guessing.
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
            // The study's OWN duration, not the opportunity's. This used to
            // send `default_duration_minutes`, which unmoderated never shows,
            // so every recorded study inherited that field's default and told
            // participants a length nobody had chosen.
            estimated_duration_minutes: durationToSend(
              formData.inline_study_duration_minutes,
              originalFormData?.inline_study_duration_minutes
            ),
            // Built by the same function studyRoundTripsCleanly checks with,
            // so the fields this sends and the fields the form claims it can
            // reproduce cannot drift apart again. They did, and it deleted
            // helper_text and is_required from every task list built in the
            // Task Lists area.
            steps: formData.inline_study_steps.map(toInlineStudyPayloadStep)
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
          // exactly one of the two: a study id can survive in state after the
          // author ticks reuse, picks one, then unticks and writes questions
          // instead. The backend refuses both rather than guessing.
          const authoringInline =
            !studyIsReadOnly &&
            !formData.reuse_existing_survey &&
            formData.inline_survey_questions.length > 0;

          data.firsthand_study_id = authoringInline
            ? undefined
            : formData.firsthand_study_id?.trim() || undefined;

          if (authoringInline) {
            data.inline_survey = {
              consent_text: formData.inline_survey_consent_text.trim(),
              estimated_duration_minutes: durationToSend(
                formData.inline_survey_duration_minutes,
                originalFormData?.inline_survey_duration_minutes
              ),
              // Same function studyRoundTripsCleanly checks with. This branch
              // was already faithful; sharing the serialiser is what stops it
              // drifting the way the task-list branch did.
              steps: formData.inline_survey_questions.map(toSurveyPayloadStep)
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
      if (isEdit && id) {
        savedOpportunity = await updateOpportunity(id, data as UpdateOpportunityRequest);

        // Save any temporary sessions that were created during editing (only for test and interview types)
        if (formData.type === 'test' || formData.type === 'interview') {
          const tempSessions = sessions.filter(session => session.id.startsWith('temp-session-'));
          logger.debug('EDIT MODE - Checking for temporary sessions', {
            totalSessions: sessions.length,
            tempSessions: tempSessions.length,
            tempSessionIds: tempSessions.map(s => s.id),
            opportunityId: savedOpportunity.id
          });

          if (tempSessions.length > 0) {
            try {
              const sessionData = tempSessions.map(session => ({
                start_time: session.start_time,
                end_time: session.end_time,
                capacity: session.capacity,
                location_or_meet_link_optional: session.location_or_meet_link_optional || ''
              }));

              logger.debug('EDIT MODE - Creating sessions', { count: sessionData.length });
              const { createSessions } = await import('../api/client');
              await createSessions(savedOpportunity.id, sessionData);

              // Reload sessions to get the real IDs
              const updatedOpportunity = await getOpportunity(savedOpportunity.id);
              logger.debug('EDIT MODE - Updated opportunity sessions', { count: updatedOpportunity.sessions?.length || 0 });
              setSessions(updatedOpportunity.sessions || []);
            } catch (sessionError: unknown) {
              logger.error('Error saving sessions', {
                error: sessionError instanceof Error ? sessionError : undefined,
                errorMessage: sessionError instanceof Error ? sessionError.message : String(sessionError)
              });
              setError('Opportunity updated but failed to save sessions. Please add them manually.');
            }
          } else {
            logger.debug('EDIT MODE - No temporary sessions to save');
          }
        }
      } else {
        savedOpportunity = await createOpportunity(data as CreateOpportunityRequest);
        setOpportunityId(savedOpportunity.id);

        logger.debug('CREATE MODE - Opportunity created');

        // For types that use external links (no sessions), show success then auto-navigate
        if (['poll', 'survey', 'question', 'unmoderated'].includes(formData.type)) {
          const isDraft = formData.status === 'draft';
          setSuccessMessage(
            isDraft
              ? '⚠️ Study created as DRAFT - Not visible to users yet. Change status to Published to make it visible.'
              : 'Opportunity created successfully!'
          );
          // Auto-navigate to admin dashboard after a brief delay so the user sees the success message
          setTimeout(() => {
            navigate('/admin', { state: { refresh: true, timestamp: Date.now() } });
          }, isDraft ? 3000 : 1500); // Longer delay for draft warning
          return savedOpportunity.id;
        }

        // For test/interview types, AdminSessionManager will handle session creation
        // Return the opportunity ID so AdminSessionManager can create sessions
        return savedOpportunity.id;
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

      // Navigate after successful save
      if (!skipNavigation) {
        if (allowUserSubmission) {
          // For user submissions, navigate to home with success message
          navigate('/', { state: { message: 'Research request submitted successfully! It will be reviewed by an admin.' } });
        } else {
          // For admin, show success message briefly then navigate to admin dashboard
          const isDraft = formData.status === 'draft';
          setSuccessMessage(
            isDraft
              ? `⚠️ Study ${isEdit ? 'updated' : 'created'} as DRAFT - Not visible to users yet. Change status to Published to make it visible.`
              : (isEdit ? 'Opportunity updated successfully!' : 'Opportunity created successfully!')
          );
          // Brief delay to show success feedback before navigation (longer for draft warnings)
          await new Promise(resolve => setTimeout(resolve, isDraft ? 3000 : 1500));
          navigate('/admin', { state: { refresh: true, timestamp: Date.now(), message: isEdit ? 'Opportunity updated!' : 'Opportunity created!' } });
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
  const handleStepsChange = (steps: InlineStudyStep[]) => {
    setFormData(prev => ({ ...prev, inline_study_steps: steps }));
    setValidationErrors(prev => {
      // Drop every per-step error on any structural change: indices shift when
      // a step is added, removed or moved, so a kept error would point at the
      // wrong task.
      const next = { ...prev };
      Object.keys(next)
        .filter(key => key.startsWith('inline_study_steps'))
        .forEach(key => delete next[key]);
      return next;
    });
  };

  const handleQuestionsChange = (questions: SurveyQuestion[]) => {
    setFormData(prev => ({ ...prev, inline_survey_questions: questions }));
    setValidationErrors(prev => {
      // Same reasoning as handleStepsChange: indices shift when a question is
      // added, removed or moved, so a kept per-question error would point at
      // the wrong question.
      const next = { ...prev };
      Object.keys(next)
        .filter(key => key.startsWith('inline_survey_questions'))
        .forEach(key => delete next[key]);
      return next;
    });
  };

  // One place that turns a refusal on, so every path reports it identically.
  const showRefusal = () => {
    setRefusalShown(true);
    setRefusalCount(count => count + 1);
  };

  const handleInputChange = (field: string, value: string | number | boolean | undefined) => {
    setFormData(prev => {
      // Unticking reuse drops the study that was picked while it was ticked.
      // Without this the id lives on invisibly - the picker is no longer on
      // screen - and would be submitted alongside the authored tasks.
      if (field === 'reuse_existing_study' && value === false) {
        return { ...prev, reuse_existing_study: false, firsthand_study_id: '' };
      }

      // The survey twin. Without it the id survived the untick and was
      // submitted alongside authored questions - and worse, the behaviour
      // flipped on whether the author had typed anything yet, because the
      // payload only drops the id once at least one question exists. That is
      // precedence resolution of exactly the kind the backend refuses.
      if (field === 'reuse_existing_survey' && value === false) {
        return { ...prev, reuse_existing_survey: false, firsthand_study_id: '' };
      }

      // Unmoderated is FirstHand-only and runs with logged-in Cortex users, so
      // drop any external link and coerce an 'external' participant type when
      // the type switches to unmoderated (a stale value must not persist).
      if (field === 'type' && value === 'unmoderated') {
        return {
          ...prev,
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
          type: value,
          firsthand_study_id: '',
          reuse_existing_study: false,
          reuse_existing_survey: false,
        };
      }
      return { ...prev, [field]: value };
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
  };

  const handleBlur = (field: string, value: string | number | boolean | undefined) => {
    // Validate field on blur
    validateField(field, value);
  };

  const handleCancel = () => {
    navigate('/admin', { state: { refresh: true } });
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
            {/* Back button */}
            <button
              className="btn btn-outline-secondary mb-3"
              onClick={() => allowUserSubmission ? navigate('/') : navigate('/admin')}
            >
              <ArrowLeft size={16} className="me-1" />
              {allowUserSubmission ? 'Back to Home' : 'Back to Admin Dashboard'}
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

              {/* Saving is deliberately still allowed here - see the 404 branch
                  in loadOpportunity. The author needs to be able to repoint or
                  unpublish an opportunity whose study has been deleted. */}
              {studyMissing && (
                <div className="alert alert-warning mx-4 mt-4 mb-0" role="alert">
                  <AlertTriangle size={18} className="me-2" />
                  The task list or questions this opportunity points at no longer
                  exist. Pick another below, or unpublish this opportunity until
                  you have replaced them.
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

              <form onSubmit={handleSubmit}>
                {/* Tab Navigation */}
                <div className="border-bottom">
                  <nav className="nav nav-tabs border-0 nav-tabs-form">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        className={`nav-link border-0 py-3 px-4 opportunity-form-tab ${
                          activeTab === tab.id ? 'active fw-bold' : 'fw-semibold'
                        }`}
                        onClick={() => setActiveTab(tab.id)}
                      >
                        <div className="text-center">
                          <div className={`tab-title tab-title-dynamic ${activeTab === tab.id ? 'active' : ''}`}>
                            {tab.title}
                          </div>
                          <small className={`tab-description tab-description-dynamic ${activeTab === tab.id ? 'active' : ''}`}>
                            {tab.description}
                          </small>
                        </div>
                      </button>
                    ))}
                  </nav>
                </div>

                {/* Tab Content */}
                <div className="tab-content p-4">
                  {/* Basic Information Tab */}
                  {activeTab === 1 && (
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

                      {/* Navigation Buttons for Tab 1 */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <div style={{ flex: 1 }}></div>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving || !!successMessage || !!studyLoadError}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <Save size={16} className="me-2" />
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-primary px-5 py-2 fw-semibold"
                            onClick={() => {
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

                              // Clears the refusal only - a server error
                              // banner is not this button's to erase.
                              setRefusalShown(false);
                              setActiveTab(2);
                            }}
                            style={{ fontSize: '0.95rem' }}
                          >
                            Continue to Details
                            <ArrowRight size={16} className="ms-2" />
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Content & Details Tab */}
                  {activeTab === 2 && (
                    <>
                      <ContentDetailsTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleBlur={handleBlur}
                      />
                      {/* Navigation Buttons for Tab 2 */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                            onClick={() => setActiveTab(1)}
                            style={{ fontSize: '0.95rem' }}
                          >
                            <ArrowLeft size={16} className="me-2" />
                            Back
                          </button>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving || !!successMessage || !!studyLoadError}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <Save size={16} className="me-2" />
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-primary px-5 py-2 fw-semibold"
                            onClick={() => {
                              // Determine next tab based on opportunity type
                              const tabs = getTabsForType(formData.type, deliveryMode);
                              const nextTab = tabs.find(tab => tab.id > 2)?.id;
                              if (!nextTab) {
                                // There is no third tab until a type is chosen,
                                // and the tab headers are directly clickable -
                                // so this tab is reachable with no type set.
                                // Continuing to tab 2 from tab 2 is a no-op the
                                // author reads as a broken button. Send them to
                                // the field that is actually blocking them.
                                setValidationErrors(prev => ({
                                  ...prev,
                                  type: 'Please select a research study type'
                                }));
                                showRefusal();
                                setActiveTab(1);
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                                return;
                              }
                              setRefusalShown(false);
                              setActiveTab(nextTab);
                            }}
                            style={{ fontSize: '0.95rem' }}
                          >
                            {formData.type === 'test' || formData.type === 'interview'
                              ? 'Continue to Session Setup'
                              : formData.type === 'unmoderated'
                              ? 'Continue to Task List'
                              : formData.type === 'poll' || formData.type === 'survey' || formData.type === 'question'
                              ? 'Continue to Link Setup'
                              : 'Continue'}
                            <ArrowRight size={16} className="ms-2" />
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Task List tab - only for unmoderated */}
                  {activeTab === 3 &&
                    (formData.type === 'poll' || formData.type === 'survey') &&
                    deliveryMode === 'native' && (
                      <>
                        <SurveyQuestionsTab
                          formData={formData}
                          validationErrors={validationErrors}
                          handleInputChange={handleInputChange}
                          handleQuestionsChange={handleQuestionsChange}
                          hasLinkedStudy={hasLinkedStudy}
                          studyIsReadOnly={studyIsReadOnly}
                          readOnlyReason={studyReadOnlyReason}
                        />

                        {/* Navigation buttons for the Questions tab. Same shape
                            as every other tab's: this is the last tab for a
                            native survey, so without them there is no way to
                            save at all - which is how it shipped until a test
                            went looking for the button. */}
                        <div className="border-top mt-4 pt-4">
                          <div className="d-flex justify-content-between align-items-center gap-2">
                            <button
                              type="button"
                              className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                              onClick={() => setActiveTab(2)}
                              style={{ fontSize: '0.95rem' }}
                            >
                              <ArrowLeft size={16} className="me-2" />
                              Back
                            </button>
                            <button
                              type="submit"
                              className="btn btn-primary px-5 py-2 fw-semibold"
                              disabled={saving || !!successMessage || !!studyLoadError}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Creating" aria-hidden="true"></span>
                                  {isEdit ? 'Updating...' : 'Creating...'}
                                </>
                              ) : (
                                <>
                                  <CheckCircle size={16} className="me-2" />
                                  {isEdit ? 'Update Opportunity' : 'Create Opportunity'}
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      </>
                    )}

                  {activeTab === 3 && formData.type === 'unmoderated' && (
                    <>
                      <FirstHandStudyTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleStepsChange={handleStepsChange}
                        hasLinkedStudy={hasLinkedStudy}
                        studyIsReadOnly={studyIsReadOnly}
                        readOnlyReason={studyReadOnlyReason}
                      />

                      {/* Navigation buttons for the Task List tab */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                            onClick={() => setActiveTab(2)}
                            style={{ fontSize: '0.95rem' }}
                          >
                            <ArrowLeft size={16} className="me-2" />
                            Back
                          </button>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving || !!successMessage || !!studyLoadError}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <Save size={16} className="me-2" />
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-success px-5 py-2 fw-semibold"
                            onClick={() => handleSubmit()}
                            disabled={saving || !!successMessage || !!studyLoadError}
                            style={{ fontSize: '0.95rem' }}
                          >
                            {saving ? (
                              <>
                                <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Creating" aria-hidden="true"></span>
                                {isEdit ? 'Updating...' : 'Creating...'}
                              </>
                            ) : (
                              <>
                                <CheckCircle size={16} className="me-2" />
                                {isEdit ? 'Update Opportunity' : 'Create Opportunity'}
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* External Link Tab - for polls, surveys, and questions (not unmoderated) */}
                  {activeTab === 3 && ['poll', 'survey', 'question'].includes(formData.type) && !(deliveryMode === 'native' && formData.type !== 'question') && (
                    <>
                      <ExternalLinkTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                      />

                      {/* Navigation Buttons for External Link Tab */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                            onClick={() => setActiveTab(2)}
                            style={{ fontSize: '0.95rem' }}
                          >
                            <ArrowLeft size={16} className="me-2" />
                            Back
                          </button>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving || !!successMessage || !!studyLoadError}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <Save size={16} className="me-2" />
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-success px-5 py-2 fw-semibold"
                            onClick={() => handleSubmit()}
                            disabled={saving || !!successMessage || !!studyLoadError}
                            style={{ fontSize: '0.95rem' }}
                          >
                            {saving ? (
                              <>
                                <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Creating" aria-hidden="true"></span>
                                {isEdit ? 'Updating...' : 'Creating...'}
                              </>
                            ) : (
                              <>
                                <CheckCircle size={16} className="me-2" />
                                {isEdit ? 'Update Opportunity' : 'Create Opportunity'}
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Session Management - Only for Tests and Interviews */}
                  {activeTab === 3 && (formData.type === 'test' || formData.type === 'interview') && (
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
                            onOpportunitySave={() => handleSubmit(undefined, true)}
                            onBack={() => setActiveTab(2)}
                            onNavigate={(path) => {
                              const isDraft = formData.status === 'draft';
                              navigate(path, {
                                state: {
                                  refresh: true,
                                  timestamp: Date.now(),
                                  message: isDraft
                                    ? '⚠️ Study created as DRAFT - Not visible to users yet. Change status to Published to make it visible.'
                                    : 'Opportunity created successfully!'
                                }
                              });
                            }}
                            isDraft={formData.status === 'draft'}
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OpportunityForm;
