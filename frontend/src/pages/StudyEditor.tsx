import React, { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import {
  GuardedLink,
  useOptionalNavigationGuard,
} from '../contexts/NavigationGuardContext';
import ConfirmationModal from '../components/ConfirmationModal';
import {
  createFirstHandStudy,
  getFirstHandStudy,
  getFirstHandStudyUsage,
  updateFirstHandStudy,
  type FirstHandStudyUsage,
} from '../api/firsthand-studies';
import { Alert, Button, Card, CardBody, StatusBadge } from '../components/ui';
import { isStudyReadOnly, type StudyViewer } from '../utils/studyOwnership';
import type { FirstHandStudy, OpportunityFormData } from '../api/types';
import type { StudyStep } from '@shared/firsthand/contract';
import { toStudySteps, type InlineStudyStep } from '@shared/firsthand/inline-study';
import { toSurveySteps, type SurveyQuestion } from '@shared/firsthand/survey-authoring';
import { CUSTOM_CONSENT_TEMPLATE_ID } from '@shared/firsthand/consent-templates';
import {
  authoredStepsOf,
  toInlineStudyPayloadStep,
  toInlineStudyStep,
  toSurveyPayloadStep,
  toSurveyQuestion,
  withStoredIdentity,
} from '../lib/opportunity-authoring/hydrate-study';
import type { WithClientId } from '../lib/opportunity-authoring/client-ids';
import { getPrimaryTargetUrl } from '../lib/recording/task-target';
import FirstHandStudyTab, {
  type FirstHandStudyTabFormData,
} from '../components/OpportunityForm/FirstHandStudyTab';
import SurveyQuestionsTab, {
  type InlineSurveyFormFields,
} from '../components/OpportunityForm/SurveyQuestionsTab';
import ReadOnlyStudyContent from '../components/OpportunityForm/ReadOnlyStudyContent';
import {
  createStudyRequestSchema,
  updateStudyRequestSchema,
} from '@shared/firsthand/study-input';

type StudyStatus = 'draft' | 'launched' | 'archived';

/**
 * Row 35: this page and `Studies.tsx` had no page shell where every wizard
 * screen has a card and a status pill - a plain uppercase text label here,
 * against `StatusBadge` everywhere the opportunity form shows a study's
 * standing. `StudyStatus` and `StatusBadge`'s own `StatusType` use different
 * words for the same three states, so this maps rather than reusing one enum
 * for both call sites.
 */
const STUDY_STATUS_BADGE: Record<StudyStatus, 'draft' | 'published' | 'closed'> = {
  draft: 'draft',
  launched: 'published',
  archived: 'closed'
};

/**
 * A study id of the same shape the server mints: `study_<uuid v4>`.
 *
 * `crypto.randomUUID` is secure-context only, so it is absent over plain http -
 * a dev server reached from another machine by IP, or an http staging host. It
 * is called from a `useState` initialiser, so its absence throws during render
 * and the app ErrorBoundary swallows the whole New Study page.
 *
 * The fallback builds a v4 uuid from `crypto.getRandomValues`, which IS
 * available in insecure contexts. It is deliberately NOT `Math.random()`: this
 * value becomes a primary key, and a weak generator would trade a page that
 * fails loudly for ids that collide quietly.
 */
const mintStudyId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return `study_${crypto.randomUUID()}`;
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10x
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');

  return `study_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Whether this task list would be saved with tasks but no starting page.
 *
 * A single, study-level Starting URL (the same field the wizard's Task List
 * step carries) replaces the old per-task Target URL, so this no longer needs
 * to search step by step - it needs only to know whether there ARE tasks and
 * whether the one URL that would apply to all of them is blank. Empty is
 * correct for a survey-style task list with no page to test; the checkbox
 * below exists so that is a conscious choice rather than a silent gap.
 */
export function studyMissingTaskPageUrl(
  steps: ReadonlyArray<unknown>,
  targetUrl: string
): boolean {
  return steps.length > 0 && targetUrl.trim().length === 0;
}

/** Pull a human-readable message out of an axios/unknown save error. */
function extractSaveError(caught: unknown): string {
  const response = (caught as { response?: { data?: { message?: string; error?: string } } })
    ?.response;
  const data = response?.data;
  if (data?.message) return data.message;
  if (data?.error) return data.error;
  if (caught instanceof Error) return caught.message;
  return 'Save failed';
}

/**
 * The server's current `updated_at` when a save was refused as stale, or null
 * when the failure was anything else.
 *
 * Reads the STATUS, not the message. `extractSaveError` deliberately discards
 * the status and returns prose, so a 409 was previously indistinguishable from
 * a 400 - and matching on the sentence would make the client's recovery
 * behaviour depend on the server's copy, which is the kind of coupling that
 * breaks silently the first time somebody rewords a message.
 *
 * Both conditions are required. A 409 with no `current_updated_at` cannot be
 * recovered from - re-sending the same stale precondition would be refused
 * again forever - so it is left to the generic error path, which at least tells
 * the author something true.
 */
function staleStudyUpdatedAt(caught: unknown): string | null {
  const response = (caught as {
    response?: { status?: number; data?: { error?: string; current_updated_at?: string } };
  })?.response;

  if (response?.status !== 409) return null;
  if (response.data?.error !== 'stale_study') return null;

  const currentUpdatedAt = response.data.current_updated_at;

  return typeof currentUpdatedAt === 'string' && currentUpdatedAt.length > 0
    ? currentUpdatedAt
    : null;
}

type StudyEditorFormProps = {
  initialStudy?: FirstHandStudy;
  initialSteps?: StudyStep[];
  /**
   * Passed in rather than read from useAuth here so the form stays renderable
   * (and testable) without an AuthProvider, matching how the page already owns
   * the auth lookup for its own admin redirect.
   */
  viewer?: StudyViewer;
};

/**
 * The study authoring form - now a thin shell around the wizard's own Tasks
 * body (D4).
 *
 * This surface used to duplicate task authoring entirely: its own Task id,
 * Target URL, Helper text, Required and Options controls, a bespoke Add/Remove,
 * and a second vocabulary for the same content the wizard's Task List step
 * already collects. That gave one stored study two authoring surfaces that
 * disagreed - a `_step_end` completion marker editable only here, and a task
 * reordered in one that could not be reordered back in the other (Petra,
 * "the two task-list editors - my ruling"). `FirstHandStudyTab` is now the ONE
 * editor for a task list's steps, mounted here standalone rather than inside
 * an opportunity; this form supplies only what a task list needs and the
 * wizard's own step does not carry - Title, Intro text, Consent text and
 * Status - plus the save.
 */
export function StudyEditorForm({
  initialStudy,
  initialSteps,
  viewer,
}: StudyEditorFormProps) {
  const navigate = useNavigate();
  const isEditing = Boolean(initialStudy);
  // No `isEditing &&` guard: the create form has no initialStudy, so
  // isStudyReadOnly already answers false for it.
  const readOnly = isStudyReadOnly(initialStudy, viewer);

  const [title, setTitle] = useState(initialStudy?.title ?? '');
  const [introText, setIntroText] = useState(initialStudy?.intro_text ?? '');
  const [consentText, setConsentText] = useState(
    initialStudy?.consent_text ?? ''
  );
  const [status, setStatus] = useState<StudyStatus>(
    (initialStudy?.status as StudyStatus | undefined) ?? 'draft'
  );
  // Known before the first save so step ids can be namespaced by it. On create
  // the server would otherwise mint the id only once the study is inserted -
  // too late for the step ids travelling in the same request - so it is
  // generated here and sent as `id`, which createStudyRequestSchema accepts.
  const [studyId, setStudyId] = useState(() => initialStudy?.id ?? mintStudyId());

  /**
   * Which vocabulary this study is written in - fixed at create and never
   * editable (see study-input.ts). A create form has no `initialStudy`, so it
   * is never in the survey vocabulary: every authoring path that mints a
   * survey-kind study does so inline, from the wizard's own Questions step -
   * this page's create form has only ever produced recorded task lists (see
   * `mintStudyId`, called unconditionally). Editing an EXISTING survey study
   * is the one case this page must still serve, via the wizard's own
   * `SurveyQuestionsTab` rather than the recorded-only `FirstHandStudyTab`.
   */
  const isSurveyKind = initialStudy?.kind === 'survey';

  const initialAuthoredSteps = authoredStepsOf(initialSteps ?? []);
  // `withStoredIdentity`, not a fresh `withClientIds`: this is an EDIT, and an
  // edit must carry each step's identity forward so a save does not renumber
  // it and orphan whatever has already been recorded against it (see
  // hydrate-study.ts). A create has nothing stored to recover, so its steps
  // start with no identity and one is minted the first time a task is typed.
  const [steps, setSteps] = useState<WithClientId<InlineStudyStep>[]>(() =>
    isSurveyKind
      ? []
      : withStoredIdentity(
          initialAuthoredSteps.map(toInlineStudyStep),
          initialAuthoredSteps,
          studyId
        )
  );
  const [questions, setQuestions] = useState<WithClientId<SurveyQuestion>[]>(() =>
    isSurveyKind
      ? withStoredIdentity(
          initialAuthoredSteps.map(toSurveyQuestion),
          initialAuthoredSteps,
          studyId
        )
      : []
  );
  const [targetUrl, setTargetUrl] = useState(
    initialSteps ? getPrimaryTargetUrl(initialSteps) ?? '' : ''
  );
  const [durationMinutes, setDurationMinutes] = useState<number | undefined>(
    initialStudy?.estimated_duration_minutes ?? undefined
  );
  // `false` on load whenever there is something loaded to be false about - a
  // stored duration was decided by a human, and re-deriving the estimate would
  // silently overwrite that decision on the very next save (see
  // copiedRecordedFields in hydrate-study.ts for the same rule). A brand new
  // list has no stored decision, so it starts automatic.
  const [durationAuto, setDurationAuto] = useState<boolean | undefined>(
    initialStudy ? false : undefined
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The `updated_at` this form is editing against - the optimistic-concurrency
   * precondition, sent on every save.
   *
   * STATE rather than `initialStudy.updated_at` read at submit time, for two
   * reasons that pull the same way. A conflict has to be able to advance it
   * without the parent re-fetching and remounting this form, because a remount
   * would discard exactly the local edits the conflict exists to protect. And a
   * successful save advances the row, so a form that stayed open would fail its
   * own precondition on the second save.
   */
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | undefined>(
    initialStudy?.updated_at
  );
  /**
   * Set when the server refused a save because somebody else got there first.
   *
   * Held apart from `error`, which is a dead end. This one is recoverable and
   * the banner says how: the local edits are untouched, the precondition has
   * been advanced to what is actually stored, and saving again replaces the
   * other version deliberately rather than by accident.
   */
  const [conflict, setConflict] = useState<{ occurred: true } | null>(null);
  const [acknowledgedNoTaskPageUrl, setAcknowledgedNoTaskPageUrl] =
    useState(false);

  // A survey has no page under test at all, so the missing-task-page warning
  // - which asks "add a Starting URL, or confirm this is survey-style" -
  // cannot apply to a study that is already, unconditionally, survey-style.
  const missingTaskPageUrl = !isSurveyKind && studyMissingTaskPageUrl(steps, targetUrl);

  /**
   * Unsaved-changes guarding (row 25).
   *
   * `isDirty` compares a signature of the live fields against the FIRST
   * render's, which equals the loaded study because the state above is seeded
   * from `initialStudy`. A read-only viewer cannot change anything, so it
   * never guards; a create form guards only once its default has actually
   * been typed into.
   */
  const currentEditSignature = JSON.stringify({
    title,
    introText,
    consentText,
    status,
    steps,
    questions,
    targetUrl,
    durationMinutes,
    durationAuto,
  });
  const openingEditSignatureRef = useRef<string | null>(null);
  if (openingEditSignatureRef.current === null) {
    openingEditSignatureRef.current = currentEditSignature;
  }
  const isDirty = !readOnly && currentEditSignature !== openingEditSignatureRef.current;

  const { registerGuard } = useOptionalNavigationGuard();
  const [pendingExit, setPendingExit] = useState<string | null>(null);

  // The browser gate, armed only while there is something to lose - an
  // unconditional handler is the dialog everyone learns to dismiss unread.
  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome/Safari still gate the dialog on returnValue, deprecated as it is.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  /**
   * The in-app cousin of the browser gate (WZ-13 pattern, as OpportunityForm).
   *
   * The Back link navigates straight through react-router, so a dirty author
   * who clicks it bypasses `beforeunload`. The page registers this guard on
   * the shared `NavigationGuardProvider`; a `GuardedLink` consults it and, when
   * it intercepts, the confirmation below owns what happens next.
   */
  const latestGuardRef = useRef<(destination: string) => boolean>(() => false);
  latestGuardRef.current = (destination: string): boolean => {
    if (isDirty) {
      setPendingExit(destination);
      return true;
    }
    return false;
  };
  useEffect(() => {
    registerGuard((destination) => latestGuardRef.current(destination));
    return () => registerGuard(null);
  }, [registerGuard]);

  // One handler for both tabs - only one is ever mounted, since `isSurveyKind`
  // is fixed for the life of this form, and the two vocabularies' field names
  // never collide (`inline_study_*` vs `inline_survey_*`).
  const handleTabFieldChange = (
    field: string,
    value: string | number | boolean | undefined
  ) => {
    switch (field) {
      case 'inline_study_target_url':
        setTargetUrl(typeof value === 'string' ? value : '');
        break;
      case 'inline_study_duration_minutes':
      case 'inline_survey_duration_minutes':
        setDurationMinutes(
          typeof value === 'number' ? value : undefined
        );
        break;
      case 'inline_study_duration_auto':
      case 'inline_survey_duration_auto':
        setDurationAuto(Boolean(value));
        break;
      default:
        // 'study_source' and friends: unreachable here, since the source
        // choice only ever offers itself with no existing content to hide -
        // and both tabs are mounted here only once a study already exists,
        // hasLinkedStudy true, or (FirstHandStudyTab only) with the choice
        // force-hidden. Nothing to do.
        break;
    }
  };

  // The opportunity's own "this is published" flag, translated: the wizard's
  // Tasks/Questions bodies only ever compare this to the literal 'published',
  // so the task list's OWN status ('launched' means published) is mapped onto
  // it rather than widening what either tab reads.
  const publishedFlag = status === 'launched' ? 'published' : status;

  const tabFormData: FirstHandStudyTabFormData = {
    status: publishedFlag,
    inline_study_steps: steps,
    inline_study_target_url: targetUrl,
    inline_study_duration_minutes: durationMinutes,
    inline_study_duration_auto: durationAuto,
    firsthand_study_id: initialStudy?.id,
  };

  /**
   * `SurveyQuestionsTab` takes a full `OpportunityFormData`, unmodified here -
   * unlike `FirstHandStudyTab`, it has no narrowed prop type of its own, and
   * widening it is outside this change's file ownership. This is a plain,
   * self-consistent stand-in rather than any real opportunity: `type:
   * 'survey'` keeps `maxQuestionsFor` at the ordinary (not one-question)
   * ceiling, and nothing else the tab reads (`purpose_one_liner`,
   * `default_duration_minutes`) is ever rendered or sent anywhere from here.
   */
  const surveyTabFormData: OpportunityFormData & InlineSurveyFormFields = {
    type: 'survey',
    title,
    purpose_one_liner: '',
    default_duration_minutes: 30,
    status: publishedFlag === 'published' ? 'published' : 'draft',
    inline_survey_questions: questions,
    inline_survey_duration_minutes: durationMinutes,
    inline_survey_duration_auto: durationAuto,
    firsthand_study_id: initialStudy?.id,
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // Defensive: the submit button is disabled in this state, but never let a
    // task study save with no task-page URL unless it was acknowledged.
    if (missingTaskPageUrl && !acknowledgedNoTaskPageUrl) {
      setError(
        'This task list has tasks but no task page URL. Add one, or confirm it is a survey-style task list.'
      );
      return;
    }

    // `toStudySteps`/`toSurveySteps` each append the completion marker (row 3)
    // themselves, with the same fixed, non-authorable prompt - the same calls
    // the wizard's own Task List/Questions steps make on save. There is
    // nothing of a stored marker to carry through: every authoring path
    // writes the identical step, every time.
    const stepsPayload = isSurveyKind
      ? toSurveySteps(questions.map(toSurveyPayloadStep), studyId)
      : toStudySteps(
          steps.map(toInlineStudyPayloadStep),
          studyId,
          targetUrl.trim() || undefined
        );

    const payload = {
      // Sent on create so the study row's id matches the prefix already baked
      // into the step ids. Ignored on update, where the id comes from the route.
      id: studyId,
      title: title.trim(),
      intro_text: introText.trim(),
      consent_text: consentText.trim(),
      // Carried through so this surface cannot silently reclassify a study -
      // see the identical reasoning in hydrate-study.ts.
      ...(initialStudy?.consent_template_id &&
      initialStudy.consent_template_id !== CUSTOM_CONSENT_TEMPLATE_ID
        ? {
            consent_template_id: initialStudy.consent_template_id,
            consent_template_version: initialStudy.consent_template_version ?? null
          }
        : {}),
      // A hidden default, CREATE only. D4 drops the Locale field from the UI,
      // but the pre-D4 form always sent 'en-GB' as its own default - dropping
      // the field entirely would leave every new list `locale = null`, which
      // nothing chose. An edit must never carry this: it would overwrite a
      // stored locale on every save, and the update branch below only ever
      // sees this key on create (it is absent whenever `isEditing`).
      // `brand_name` has no equivalent: it never had a default to preserve.
      ...(!isEditing ? { locale: 'en-GB' } : {}),
      estimated_duration_minutes: durationMinutes,
      status,
      steps: stepsPayload,
    };

    setError(null);
    setConflict(null);
    setSubmitting(true);

    try {
      if (isEditing) {
        const { id: _unusedOnUpdate, ...updatePayload } = payload;
        const parsed = updateStudyRequestSchema.safeParse({
          ...updatePayload,
          ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {})
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'The task list is not valid.');
          return;
        }
        await updateFirstHandStudy(initialStudy!.id, parsed.data);
      } else {
        const parsed = createStudyRequestSchema.safeParse(payload);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'The task list is not valid.');
          return;
        }
        await createFirstHandStudy(parsed.data);
      }

      navigate('/admin/studies');
    } catch (caught) {
      const conflictUpdatedAt = staleStudyUpdatedAt(caught);

      if (conflictUpdatedAt) {
        setExpectedUpdatedAt(conflictUpdatedAt);
        setConflict({ occurred: true });
        setError(null);
        return;
      }

      setError(extractSaveError(caught));

      // A client-minted primary key makes a create retry non-idempotent. If the
      // study committed but the response was lost to a timeout or a proxy blip,
      // the author sees a failure and clicks Create again - and every retry now
      // collides on studies_pkey, with no escape but reloading and losing the
      // form. Re-mint so the next attempt is a fresh insert. Create only: on
      // update the id comes from the route and re-minting would be meaningless.
      if (!isEditing) {
        setStudyId(mintStudyId());
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <form onSubmit={handleSubmit}>
      {error ? (
        <Alert variant="danger" className="mb-4">
          <strong>Could not save task list.</strong>
          <p className="mb-0">{error}</p>
        </Alert>
      ) : null}

      {conflict ? (
        <Alert variant="warning" className="mb-4" id="study-conflict-notice">
          <strong>Somebody else saved this task list while you were editing.</strong>
          <p className="mb-2">
            Nothing has been saved and your edits are still here. Open the saved
            version to see what changed, then either copy their changes across or
            save again to replace their version.
          </p>
          <a
            href={`/admin/studies/${encodeURIComponent(initialStudy?.id ?? '')}/edit`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the saved version in a new tab
          </a>
        </Alert>
      ) : null}

      {readOnly ? (
        <Alert variant="info" className="mb-4" id="study-read-only-notice">
          <strong>Read only</strong>
          <p className="mb-0">
            Another researcher owns this task list. Ask them, or a superadmin,
            to make changes.
          </p>
        </Alert>
      ) : null}

      <fieldset
        aria-describedby={readOnly ? 'study-read-only-notice' : undefined}
        className="border-0 p-0 m-0"
        disabled={readOnly}
        style={{ minInlineSize: 0 }}
      >
        <div className="form-group mb-3">
          <label className="form-label" htmlFor="study-title">
            Title
          </label>
          <input
            className="form-control"
            id="study-title"
            onChange={(event) => setTitle(event.target.value)}
            required
            value={title}
          />
        </div>

        <div className="form-group mb-3">
          <label className="form-label" htmlFor="study-intro">
            Intro text
          </label>
          <textarea
            className="form-control"
            id="study-intro"
            onChange={(event) => setIntroText(event.target.value)}
            required
            rows={3}
            value={introText}
          />
        </div>

        <div className="form-group mb-3">
          <label className="form-label" htmlFor="study-consent">
            Consent text
          </label>
          <textarea
            className="form-control"
            id="study-consent"
            onChange={(event) => setConsentText(event.target.value)}
            required
            rows={3}
            value={consentText}
          />
        </div>

        <div className="form-group mb-4" style={{ maxWidth: '16rem' }}>
          <label className="form-label" htmlFor="study-status">
            Status
          </label>
          <select
            className="form-select"
            id="study-status"
            onChange={(event) =>
              setStatus(event.target.value as StudyStatus)
            }
            value={status}
          >
            <option value="draft">draft</option>
            <option value="launched">published</option>
            <option value="archived">archived</option>
          </select>
        </div>

        {/*
          D4: the wizard's own Tasks/Questions body, mounted standalone.
          `hasLinkedStudy` is true only once this list is a persisted study of
          its own - which is also exactly when it could be shared with other
          opportunities - so the shared-list notice (row 12) fetches and names
          a real count only for an existing list, never for one still being
          created. `FirstHandStudyTab`'s `hideSourceChoice` is always on: this
          editor has no "start from a copy" flow, and offering the chooser to a
          blank, unlinked list would be a control this page cannot honour.
          `SurveyQuestionsTab` needs no such flag - it is reachable here only
          when editing an EXISTING survey study, where `hasLinkedStudy` is
          already true and its own source choice is already suppressed.
        */}
        {isSurveyKind ? (
          <SurveyQuestionsTab
            formData={surveyTabFormData}
            validationErrors={{}}
            handleInputChange={handleTabFieldChange}
            handleQuestionsChange={setQuestions}
            hasLinkedStudy={isEditing}
            studyIsReadOnly={readOnly}
            readOnlyReason={null}
            onCopyFromStudy={async () => null}
          />
        ) : (
          <FirstHandStudyTab
            formData={tabFormData}
            validationErrors={{}}
            handleInputChange={handleTabFieldChange}
            handleStepsChange={setSteps}
            hasLinkedStudy={isEditing}
            studyIsReadOnly={readOnly}
            readOnlyReason={null}
            onCopyFromStudy={async () => null}
            hideSourceChoice
          />
        )}

        {missingTaskPageUrl ? (
          <Alert variant="warning" className="mb-4">
            <strong>No task page URL set</strong>
            <p className="mb-2">
              Participants will be asked to share their screen with nothing
              pre-opened, and won't see the guided open-and-share step. Add a
              Starting URL above, or confirm this is a survey-style task list.
            </p>
            <div className="form-check">
              <input
                className="form-check-input"
                id="ack-no-task-page"
                checked={acknowledgedNoTaskPageUrl}
                onChange={(event) =>
                  setAcknowledgedNoTaskPageUrl(event.target.checked)
                }
                type="checkbox"
              />
              <label className="form-check-label" htmlFor="ack-no-task-page">
                This task list has no task page on purpose
              </label>
            </div>
          </Alert>
        ) : null}

        <div className="d-flex gap-2">
          <Button
            variant="primary"
            disabled={
              submitting || (missingTaskPageUrl && !acknowledgedNoTaskPageUrl)
            }
            loading={submitting}
            type="submit"
          >
            {submitting ? 'Saving...' : isEditing ? 'Save changes' : 'Create task list'}
          </Button>
        </div>
      </fieldset>
    </form>

    {/*
      Row 25: the confirmation the in-app guard opens. `pendingExit` holds the
      exact destination the intercepted link was heading to, so confirming sends
      the author there rather than to a recomputed guess. Staying just closes it.
    */}
    {pendingExit !== null && (
      <ConfirmationModal
        show
        title="Leave without saving?"
        message="This task list has changes that have not been saved. Leaving now discards them."
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
    )}
    </>
  );
}

/**
 * The read-only half of the library (D4): a task list's name, its content,
 * and - the thing neither editor had before - which studies use it.
 *
 * Deliberately plain text and lists rather than disabled form controls: a
 * disabled textarea still reads as an editing surface that happens to be
 * switched off (see `ReadOnlyStudyContent`'s own reasoning), and this page's
 * whole point is that editing lives elsewhere - one click away, via "Edit
 * this list", never here.
 */
function StudyDetail({
  study,
  steps,
  usage,
  usageError,
  readOnly,
  onEdit,
}: {
  study: FirstHandStudy;
  steps: StudyStep[];
  usage: FirstHandStudyUsage | null;
  usageError: boolean;
  readOnly: boolean;
  onEdit: () => void;
}) {
  const status = (study.status as StudyStatus | undefined) ?? 'draft';
  const items = authoredStepsOf(steps).map(toInlineStudyStep);

  return (
    <div>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-1">
        <p className="text-uppercase fw-semibold text-muted mb-0">
          Researcher workspace
        </p>
        <StatusBadge status={STUDY_STATUS_BADGE[status]} />
      </div>
      <h1 className="h3 mb-3">{study.title}</h1>

      <section className="mb-4">
        <h2 className="h6 text-uppercase text-muted mb-2">Intro text</h2>
        <p className="mb-0">{study.intro_text}</p>
      </section>

      <section className="mb-4">
        <h2 className="h6 text-uppercase text-muted mb-2">Consent text</h2>
        <p className="mb-0">{study.consent_text}</p>
      </section>

      <section className="mb-4">
        <h2 className="h6 text-uppercase text-muted mb-2">Tasks</h2>
        <ReadOnlyStudyContent items={items} noun="task" />
      </section>

      <section className="mb-4">
        <h2 className="h6 text-uppercase text-muted mb-2">Used by</h2>
        {usageError ? (
          <p className="text-muted mb-0">Could not load which studies use this task list.</p>
        ) : usage === null ? (
          <p className="text-muted mb-0">Loading…</p>
        ) : usage.count === 0 ? (
          <p className="text-muted mb-0">No studies use this task list yet.</p>
        ) : (
          <>
            <p className="mb-2">
              Used by {usage.count} {usage.count === 1 ? 'study' : 'studies'}.
            </p>
            <ul className="mb-0">
              {usage.studies.map((used) => (
                <li key={used.id}>
                  {used.title} <span className="text-muted">({used.status})</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {readOnly ? (
        <Alert variant="info" className="mb-0">
          Another researcher owns this task list. Ask them, or a superadmin,
          to make changes.
        </Alert>
      ) : (
        <Button variant="primary" onClick={onEdit} type="button">
          Edit this list
        </Button>
      )}
    </div>
  );
}

/**
 * Authoring page for `/admin/studies/new` and `/admin/studies/:id/edit`.
 * Admin-gated via AuthContext (the backend studies CRUD is `requireAdmin`).
 *
 * D4: `/admin/studies/:id/edit` now opens on the read-only detail view - the
 * library, not a second editor - with an explicit "Edit this list" to switch
 * into the wizard's own Tasks body. A brand new list has nothing to view, so
 * `/admin/studies/new` opens straight into that same editor.
 */
const StudyEditor: React.FC = () => {
  const { user, loading } = useAuth();
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const isAdmin =
    user?.role === 'researcher_admin' || user?.role === 'superadmin';

  const [loadingStudy, setLoadingStudy] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [study, setStudy] = useState<FirstHandStudy | null>(null);
  const [steps, setSteps] = useState<StudyStep[]>([]);
  const [usage, setUsage] = useState<FirstHandStudyUsage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [mode, setMode] = useState<'detail' | 'edit'>(isEdit ? 'detail' : 'edit');

  // A new id (navigating from one list's page to another's) starts back on
  // the detail view - "edit" is per-visit, not a fact about the route.
  useEffect(() => {
    setMode(isEdit ? 'detail' : 'edit');
  }, [id, isEdit]);

  useEffect(() => {
    // Wait for auth to resolve and only fetch for an admin - the render below
    // redirects everyone else, so an earlier fetch would just be a doomed
    // 401/403. Mirrors the sibling Studies.tsx guard.
    if (!isEdit || !id || loading || !isAdmin) {
      return;
    }

    let cancelled = false;
    setLoadingStudy(true);
    setLoadError(null);
    setUsage(null);
    setUsageError(false);

    getFirstHandStudy(id)
      .then((result) => {
        if (cancelled) return;
        setStudy(result.study);
        setSteps(result.steps);
      })
      .catch((caught) => {
        if (cancelled) return;
        const status = (caught as { response?: { status?: number } })?.response
          ?.status;
        setLoadError(
          status === 404
            ? 'That task list could not be found.'
            : extractSaveError(caught)
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingStudy(false);
      });

    getFirstHandStudyUsage(id)
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch(() => {
        if (!cancelled) setUsageError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [id, isEdit, loading, isAdmin]);

  if (loading) {
    return (
      <div className="d-flex justify-content-center py-5">
        <div className="spinner-border text-primary" role="status" aria-label="Loading">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  if (!loading && !user) {
    return <Navigate to="/auth/login" replace />;
  }

  if (
    !loading &&
    user &&
    user.role !== 'researcher_admin' &&
    user.role !== 'superadmin'
  ) {
    return <Navigate to="/" replace />;
  }

  const readOnly = isStudyReadOnly(study ?? undefined, user);

  return (
    <div className="py-4">
      {/*
        A GuardedLink, not a plain Link (row 25): the editor form registers an
        unsaved-changes guard on the shared NavigationGuardProvider, and this
        link - which lives on the page, above the form - consults it so a dirty
        author is asked to confirm before it navigates away, the same way the
        Header's own links are. A clean editor registers no guard, so it behaves
        exactly like a plain Link.
      */}
      <GuardedLink className="btn btn-link px-0 mb-3" to="/admin/studies">
        Back to task lists
      </GuardedLink>

      <Card padding="lg" hoverable={false}>
        <CardBody>
          {isEdit && loadingStudy ? (
            <div className="d-flex justify-content-center py-5">
              <div
                className="spinner-border text-primary"
                role="status"
                aria-label="Loading task list"
              >
                <span className="visually-hidden">Loading task list...</span>
              </div>
            </div>
          ) : loadError ? (
            <Alert variant="danger">
              <strong>Could not load task list.</strong>
              <p className="mb-0">{loadError}</p>
            </Alert>
          ) : isEdit && mode === 'detail' && study ? (
            <StudyDetail
              study={study}
              steps={steps}
              usage={usage}
              usageError={usageError}
              readOnly={readOnly}
              onEdit={() => setMode('edit')}
            />
          ) : (
            <>
              <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-1">
                <p className="text-uppercase fw-semibold text-muted mb-0">
                  Researcher workspace
                </p>
                {isEdit && study?.status && (
                  <StatusBadge status={STUDY_STATUS_BADGE[study.status as StudyStatus]} />
                )}
              </div>
              <h1 className="h3 mb-2">
                {isEdit ? `Edit ${study?.title ?? 'task list'}` : 'New Task List'}
              </h1>
              <p className="text-muted mb-4">
                {isEdit
                  ? 'Changes apply to new participant sessions. Sessions already in flight keep their original task payload.'
                  : 'Define the intro copy, consent and task sequence. An unmoderated study references the task list id once published.'}
              </p>

              <StudyEditorForm
                initialStudy={isEdit ? study ?? undefined : undefined}
                initialSteps={isEdit ? steps : undefined}
                viewer={user}
              />
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
};

export default StudyEditor;
