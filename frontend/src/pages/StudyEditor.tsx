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
  updateFirstHandStudy,
} from '../api/firsthand-studies';
import { Alert, Button, Card, CardBody } from '../components/ui';
import { isStudyReadOnly, type StudyViewer } from '../utils/studyOwnership';
import type { FirstHandStudy } from '../api/types';
import {
  RATING_SCALE_BOUNDS,
  type StepConfig,
  type StudyStep
} from '@shared/firsthand/contract';
import { CUSTOM_CONSENT_TEMPLATE_ID } from '@shared/firsthand/consent-templates';
import { authorableSurveyStepTypes } from '@shared/firsthand/survey-authoring';

/** What a researcher calls each survey question type, keyed on the vocabulary. */
const SURVEY_TYPE_LABELS: Record<
  (typeof authorableSurveyStepTypes)[number],
  string
> = {
  instruction: 'Section text (no answer)',
  open_text: 'Free text',
  single_choice: 'Choose one',
  multi_choice: 'Choose several',
  rating: 'Rating scale',
  nps: 'Recommendation score (0 to 10)'
};
import {
  createStudyRequestSchema,
  updateStudyRequestSchema,
} from '@shared/firsthand/study-input';

type StepType = StudyStep['type'];
type StudyStatus = 'draft' | 'launched' | 'archived';

type StepDraft = {
  step_id: string;
  order: number;
  type: StepType;
  prompt: string;
  target_url: string;
  helper_text: string;
  is_required: boolean;
  options: string;
  /**
   * Per-type question settings, for the survey vocabulary. Held as the object
   * rather than flattened into strings like `options` is, because the contract
   * validates its shape and a round-trip through text would have to reconstruct
   * it exactly.
   */
  config?: StepConfig;
};

/**
 * Step ids are namespaced by their study, because they are NOT scoped to it in
 * storage: `firsthand.study_steps.id` is a global `TEXT PRIMARY KEY`
 * (0004_firsthand_studies.sql) and `insertStudySteps` writes `step_id` straight
 * into it.
 *
 * The old default was `step_${order}` zero-padded, so every study started with
 * `step_001` and the SECOND study anyone authored here failed on a unique
 * violation. This route reports it as a 400 `create_failed` carrying the raw
 * Postgres text (`routes/firsthand.ts` catches locally); the inline path, which
 * lets `mapDatabaseError` see the 23505, reports the same cause as a misleading
 * 409 "Resource already exists". Either way the author's only way out was to
 * rename the ids by hand. The inline authoring path fixed this for itself; this
 * is the same fix for the editor.
 *
 * The field stays user-editable, so a determined author can still collide by
 * typing another study's id. That is a deliberate mistake rather than the
 * default behaviour, which is what this closes.
 */
const stepIdFor = (studyId: string, sequence: number): string =>
  `${studyId}_step_${String(sequence).padStart(3, '0')}`;

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
 * The lowest sequence number not already claimed by a step in this form.
 *
 * Sequence is deliberately NOT the step's `order`: removing a step renumbers
 * every `order` after it but leaves the step ids alone, so `order` is reused
 * while an id is not. Deriving a new id from `order` therefore reissues an id a
 * surviving step still holds - remove step 1 of three, add a step, and the new
 * step claims `_step_003` a second time. That is caught by `validateSteps` as a
 * "Duplicate step_id", which is a dead end the author cannot act on. Scanning
 * for a free sequence also copes with studies authored before ids were
 * namespaced, whose steps carry bare `step_001` and claim nothing here.
 *
 * Sequences freed by a removal ARE reused once nothing holds them. Accepted
 * knowingly: `participant_responses.step_id` is free text with no FK, so a
 * recycled id conflates old responses with the new step for anything that
 * aggregates across sessions. Nothing does today - playback resolves prompts
 * from the session's frozen step snapshot, not the live table.
 *
 * Ids are compared trimmed, because `stepDraftToPayload` trims before sending:
 * an untrimmed compare would read a pasted "..._step_002 " as a different id,
 * hand the same sequence out again, and land on the very "Duplicate step_id"
 * this exists to avoid.
 */
const nextStepId = (current: ReadonlyArray<StepDraft>, studyId: string): string => {
  const taken = new Set(current.map((step) => step.step_id.trim()));
  let sequence = current.length + 1;
  while (taken.has(stepIdFor(studyId, sequence))) {
    sequence += 1;
  }

  return stepIdFor(studyId, sequence);
};

/** One past the highest order in use, so a non-contiguous set cannot repeat one. */
const nextStepOrder = (current: ReadonlyArray<StepDraft>): number =>
  current.reduce((highest, step) => Math.max(highest, step.order), 0) + 1;

const defaultStep = (order: number, stepId: string): StepDraft => ({
  step_id: stepId,
  order,
  type: 'instruction',
  prompt: '',
  target_url: '',
  helper_text: '',
  is_required: false,
  options: '',
  config: undefined,
});

const stepDraftFromStep = (step: StudyStep): StepDraft => ({
  step_id: step.step_id,
  order: step.order,
  type: step.type,
  prompt: step.prompt,
  target_url: step.target_url ?? '',
  helper_text: step.helper_text ?? '',
  is_required: step.is_required ?? false,
  options: step.options ? step.options.join('\n') : '',
  config: step.config,
});

const stepDraftToPayload = (draft: StepDraft): StudyStep => {
  const base: StudyStep = {
    step_id: draft.step_id.trim(),
    order: draft.order,
    type: draft.type,
    prompt: draft.prompt.trim(),
  };

  if (draft.target_url.trim()) {
    base.target_url = draft.target_url.trim();
  }

  if (draft.helper_text.trim()) {
    base.helper_text = draft.helper_text.trim();
  }

  if (draft.is_required) {
    base.is_required = true;
  }

  if (draft.type === 'single_choice' || draft.type === 'multi_choice') {
    base.options = draft.options
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // Carried through rather than dropped. Without this, opening a survey study
  // here and saving it silently stripped every rating's scale - and the
  // contract then refuses the save for a field the editor never showed, so the
  // study becomes uneditable with no way to see why.
  if (draft.config) {
    base.config = draft.config;
  }

  return base;
};

/**
 * Whether a study has task steps but no task-page URL on any of them.
 *
 * A task list with task steps but no `target_url` anywhere records the participant's
 * whole screen with nothing pre-opened, and they never see the guided
 * open-and-share step. That is correct for a survey-style task list, but is almost
 * always an accidental omission for a product test - so the editor forces a
 * conscious choice rather than saving it silently. `end` steps are terminal
 * markers, never task steps, so they are ignored.
 */
export function studyMissingTaskPageUrl(
  steps: ReadonlyArray<{ type: string; target_url?: string | null }>
): boolean {
  const taskSteps = steps.filter((step) => step.type !== 'end');
  const hasTargetUrl = taskSteps.some(
    (step) =>
      typeof step.target_url === 'string' && step.target_url.trim().length > 0
  );

  return taskSteps.length > 0 && !hasTargetUrl;
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
 * The study authoring form. Ported from FirstHand `study-editor.tsx`: same field
 * set, step model, and the missing-task-page-URL acknowledgement gate, reskinned
 * onto Cortex's Momentum form classes and backed by the in-process studies CRUD.
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
  /**
   * Which vocabulary this study is written in, and so which controls the editor
   * offers. A study created before the column existed reads as `recorded`,
   * which is what it is. New studies made here are recorded too - a survey is
   * authored on its opportunity, where the questions belong to the thing being
   * asked rather than to a reusable script.
   */
  const isSurvey = initialStudy?.kind === 'survey';
  const [title, setTitle] = useState(initialStudy?.title ?? '');
  const [introText, setIntroText] = useState(initialStudy?.intro_text ?? '');
  const [consentText, setConsentText] = useState(
    initialStudy?.consent_text ?? ''
  );
  const [brandName, setBrandName] = useState(initialStudy?.brand_name ?? '');
  const [durationMinutes, setDurationMinutes] = useState(
    initialStudy?.estimated_duration_minutes?.toString() ?? ''
  );
  const [locale, setLocale] = useState(initialStudy?.locale ?? 'en-GB');
  const [status, setStatus] = useState<StudyStatus>(
    (initialStudy?.status as StudyStatus | undefined) ?? 'draft'
  );
  // Known before the first save so step ids can be namespaced by it. On create
  // the server would otherwise mint the id only once the study is inserted -
  // too late for the step ids travelling in the same request - so it is
  // generated here and sent as `id`, which createStudyRequestSchema accepts.
  // The same shape the server uses: study_<uuid>.
  const [studyId, setStudyId] = useState(() => initialStudy?.id ?? mintStudyId());

  const [steps, setSteps] = useState<StepDraft[]>(() => {
    if (initialSteps && initialSteps.length > 0) {
      return initialSteps
        .slice()
        .sort((left, right) => left.order - right.order)
        .map(stepDraftFromStep);
    }

    return [defaultStep(1, stepIdFor(studyId, 1))];
  });
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
   * own precondition on the second save - this one does navigate away today, but
   * a state variable makes that an incidental fact rather than a load-bearing
   * one.
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

  // A SURVEY has no page under test, so the missing-task-page warning does not
  // apply to it - and unacknowledged it blocks the save outright, which made
  // every survey study unsaveable here. The warning exists because a recorded
  // study with no target degrades to a start button with no open-and-share
  // sequence; a survey never had that sequence to lose.
  const missingTaskPageUrl = !isSurvey && studyMissingTaskPageUrl(steps);

  /**
   * Unsaved-changes guarding (row 25).
   *
   * The editor had none: its Back link was a plain `<Link>` and it registered no
   * guard, so an author who had typed into it lost the lot on one click - the
   * `beforeunload` browser gate never fires on an in-app route change either.
   *
   * `isDirty` compares a signature of the live fields against the FIRST render's,
   * which equals the loaded study because the state above is seeded from
   * `initialStudy`. A read-only viewer cannot change anything, so it never
   * guards; a create form guards only once its default has actually been typed
   * into. The signature is a string comparison, not deep equality, so it costs
   * nothing per render.
   */
  const currentEditSignature = JSON.stringify({
    title,
    introText,
    consentText,
    brandName,
    durationMinutes,
    locale,
    status,
    steps,
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
   * The Back link and the Header's own links navigate straight through
   * react-router, so a dirty author who clicks one bypasses `beforeunload`. The
   * page registers this guard on the shared `NavigationGuardProvider` (mounted
   * above both the page's Back link and the Header in `AppChromeLayout`); a
   * `GuardedLink` consults it and, when it intercepts, the confirmation below
   * owns what happens next. A thin wrapper over a ref keeps the registration
   * stable while always seeing the latest dirty state.
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

  const addStep = () => {
    setSteps((current) => [
      ...current,
      // `order` is taken from the highest in use, not from the step count, for
      // the same reason the id is: `validateSteps` rejects a duplicate order but
      // never requires them to be contiguous, so a study stored with orders
      // 1, 3, 4 (reachable through the API) would make a count-derived order
      // repeat 4 and fail the save with an unactionable "Duplicate step order".
      defaultStep(nextStepOrder(current), nextStepId(current, studyId)),
    ]);
  };

  /**
   * Swap in a fresh study id, carrying the step ids that are namespaced by the
   * old one across with it. Ids the author typed themselves are left alone -
   * they were a deliberate choice, and rewriting them would be a surprise.
   */
  const remintStudyId = (previousId: string) => {
    const nextId = mintStudyId();
    const previousPrefix = `${previousId}_step_`;

    setStudyId(nextId);
    setSteps((current) =>
      current.map((step) =>
        step.step_id.trim().startsWith(previousPrefix)
          ? {
              ...step,
              step_id: `${nextId}_step_${step.step_id
                .trim()
                .slice(previousPrefix.length)}`,
            }
          : step
      )
    );
  };

  const removeStep = (index: number) => {
    setSteps((current) =>
      current
        .filter((_, idx) => idx !== index)
        .map((step, idx) => ({ ...step, order: idx + 1 }))
    );
  };

  /**
   * Change a survey question's type, dropping the settings that no longer
   * apply. Hiding them is not enough: an NPS question carrying a rating's
   * scale_max is refused by the contract, so a leftover fails the save with an
   * error about a control the editor is no longer showing.
   */
  const changeStepType = (
    index: number,
    type: (typeof authorableSurveyStepTypes)[number]
  ) => {
    setSteps((current) =>
      current.map((step, idx) =>
        idx === index
          ? {
              ...step,
              type,
              options:
                type === 'single_choice' || type === 'multi_choice'
                  ? step.options
                  : '',
              // Dropped on an instruction for the same reason as the config: it
              // cannot be answered, so a required flag on one is stored state
              // that means nothing.
              is_required: type === 'instruction' ? false : step.is_required,
              config: type === 'rating' ? { scale_max: step.config?.scale_max ?? 5 } : undefined
            }
          : step
      )
    );
  };

  /**
   * The one-way repair for a legacy typed step in a RECORDED study. Keeps the
   * step_id, so responses already stored against it are not orphaned.
   *
   * `config` is cleared because stepDraftToPayload emits it for any type. The
   * options are NOT cleared, and that is deliberate rather than an oversight:
   * both the payload and the editor key off the type, so once the step is an
   * instruction the options are unreachable either way. A mutation proved a
   * clear here changes nothing observable.
   */
  const convertToInstruction = (index: number) => {
    setSteps((current) =>
      current.map((step, idx) =>
        idx === index
          ? { ...step, type: 'instruction', config: undefined }
          : step
      )
    );
  };

  const updateStep = <K extends keyof StepDraft>(
    index: number,
    field: K,
    value: StepDraft[K]
  ) => {
    setSteps((current) =>
      current.map((step, idx) =>
        idx === index
          ? {
              ...step,
              [field]: value,
            }
          : step
      )
    );
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

    const payload = {
      // Sent on create so the study row's id matches the prefix already baked
      // into the step ids. Ignored on update, where the id comes from the route.
      id: studyId,
      title: title.trim(),
      intro_text: introText.trim(),
      consent_text: consentText.trim(),
      // Carried through so this surface cannot silently reclassify a study.
      //
      // The server resolves the classification from the wording, and with no
      // claim it can only compare against the CURRENT version of the template.
      // So the day a version 2 ships, an author who opens a study running on
      // verbatim version 1 wording and changes only its title would have it
      // rewritten to `custom` - wording that is approved, permanently badged as
      // not. Sending what was loaded is the whole of the fix; the claim is
      // still verified against the text on the way in, so this grants nothing.
      ...(initialStudy?.consent_template_id &&
      initialStudy.consent_template_id !== CUSTOM_CONSENT_TEMPLATE_ID
        ? {
            consent_template_id: initialStudy.consent_template_id,
            consent_template_version: initialStudy.consent_template_version ?? null
          }
        : {}),
      brand_name: brandName.trim() || undefined,
      estimated_duration_minutes: durationMinutes
        ? Number(durationMinutes)
        : undefined,
      locale: locale.trim() || undefined,
      status,
      steps: steps.map(stepDraftToPayload),
    };

    // Validate client-side against the shared contract before hitting the API,
    // so obvious mistakes (empty required copy, unsafe target URLs) surface
    // immediately with the same field rules the backend enforces. Validate with
    // the schema for the operation so the parsed value matches the CRUD call.
    setError(null);
    setConflict(null);
    setSubmitting(true);

    try {
      if (isEditing) {
        // The id is dropped rather than sent and ignored. The update route
        // takes it from its own path, and the update schema is now strict, so
        // sending a field the server does not act on is exactly the kind of
        // thing strictness exists to surface. The schema still tolerates it,
        // deliberately, so a bundle cached across a deploy keeps working.
        const { id: _unusedOnUpdate, ...updatePayload } = payload;
        const parsed = updateStudyRequestSchema.safeParse({
          ...updatePayload,
          // The optimistic-concurrency precondition. Omitted rather than sent
          // as null when the study was served without one: the schema takes
          // `string | undefined`, and an absent precondition means "no claim"
          // on the server, which is the honest reading of a row whose
          // `updated_at` never reached this form.
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
        // Nothing else is touched: no field is reset, no navigation happens, no
        // remount is triggered. The author's edits are the thing being
        // protected, so the only state that moves is the precondition itself -
        // advanced to what is now stored, which is what turns "save again" from
        // a guaranteed second refusal into a deliberate overwrite.
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
        remintStudyId(studyId);
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

      {/*
        A conflict is a warning, not a danger: nothing is broken and nothing is
        lost. It is modelled on the missing-task-page block below, which is the
        other banner here that asks the author to do something rather than just
        telling them a thing failed.

        The link opens a NEW TAB deliberately. "Reload" is the obvious
        affordance and it is the wrong one: every field in this form comes from
        a one-shot useState initialiser, so reloading means remounting, and
        remounting means discarding the very edits that were just refused. A
        second tab shows the saved version beside the unsaved one, which is what
        an author actually needs in order to decide what to keep.
      */}
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

      {/* One fieldset rather than a `disabled` prop on every control: the
          native cascade covers each input, textarea, select and button inside
          it, so a control added later cannot forget to opt in. The backend is
          still the authority - this only stops an author filling in a form
          whose save is going to 403.

          minInlineSize because a bare fieldset carries a UA
          `min-inline-size: min-content`, which would stop it shrinking with
          the Bootstrap grid rows inside it on a narrow viewport. Inline rather
          than a class: there is no such utility in styles/_utilities.css.
          aria-describedby so a screen reader reaching the disabled controls is
          told why they are disabled. */}
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

        <div className="row g-3">
          <div className="col-md-6">
            <div className="form-group mb-3">
              <label className="form-label" htmlFor="study-brand">
                Brand
              </label>
              <input
                className="form-control"
                id="study-brand"
                onChange={(event) => setBrandName(event.target.value)}
                value={brandName}
              />
            </div>
          </div>

          <div className="col-md-6">
            <div className="form-group mb-3">
              <label className="form-label" htmlFor="study-duration">
                Estimated duration (minutes)
              </label>
              <input
                className="form-control"
                id="study-duration"
                min={1}
                onChange={(event) => setDurationMinutes(event.target.value)}
                type="number"
                value={durationMinutes}
              />
            </div>
          </div>

          <div className="col-md-6">
            <div className="form-group mb-3">
              <label className="form-label" htmlFor="study-locale">
                Locale
              </label>
              <input
                className="form-control"
                id="study-locale"
                onChange={(event) => setLocale(event.target.value)}
                value={locale}
              />
            </div>
          </div>

          <div className="col-md-6">
            <div className="form-group mb-3">
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
          </div>
        </div>

        <h2 className="h5 mt-4 mb-3">Tasks</h2>

        <ol className="list-unstyled">
          {steps.map((step, index) => (
            <li className="mb-4" key={index}>
              <Card padding="md" hoverable={false}>
                <CardBody>
                  <p className="fw-semibold mb-3">Task {step.order}</p>

                  <div className="form-group mb-3">
                    <label className="form-label" htmlFor={`step-id-${index}`}>
                      Task id
                    </label>
                    <input
                      className="form-control"
                      id={`step-id-${index}`}
                      onChange={(event) =>
                        updateStep(index, 'step_id', event.target.value)
                      }
                      required
                      value={step.step_id}
                    />
                  </div>

                  {/* A RECORDED study has no response-type selector: sessions
                      record screen and voice, so participants answer out loud.
                      New steps are instructions (see defaultStep). Legacy typed
                      steps keep their type, and the options editor below still
                      renders for a legacy choice step so it stays editable.

                      A SURVEY is the opposite - everything is typed - so it
                      gets the full survey vocabulary here. */}
                  {isSurvey && step.type !== 'end' ? (
                    <div className="form-group mb-3">
                      <label className="form-label" htmlFor={`step-type-${index}`}>
                        Type
                      </label>
                      <select
                        className="form-control form-select"
                        id={`step-type-${index}`}
                        value={step.type}
                        disabled={readOnly}
                        onChange={(event) =>
                          changeStepType(
                            index,
                            event.target
                              .value as (typeof authorableSurveyStepTypes)[number]
                          )
                        }
                      >
                        {authorableSurveyStepTypes.map((type) => (
                          <option key={type} value={type}>
                            {SURVEY_TYPE_LABELS[type]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    /**
                     * A one-way repair for a legacy typed step.
                     *
                     * The type selector is gone from recorded authoring, so an
                     * inherited open_text or single_choice step could have its
                     * prompt edited but never its type - and those steps are
                     * unanswerable now, because the runner renders no inputs.
                     * Delete-and-re-add would lose the step_id and orphan every
                     * response already stored against it.
                     *
                     * One way on purpose: there is no route back to a type this
                     * editor cannot otherwise produce.
                     */
                    step.type !== 'instruction' &&
                    step.type !== 'end' && (
                      <div className="alert alert-warning py-2 px-3 mb-3">
                        <div className="mb-2">
                          This task asks for a typed answer, which a recorded
                          session cannot collect - participants answer out loud.
                        </div>
                        <button
                          className="btn btn-sm btn-outline-secondary"
                          disabled={readOnly}
                          onClick={() => convertToInstruction(index)}
                          type="button"
                        >
                          Convert to a spoken instruction
                        </button>
                        <div className="form-text mt-1">
                          Keeps the task and its answers. Cannot be undone.
                        </div>
                      </div>
                    )
                  )}
                  <div className="form-group mb-3">
                    <label
                      className="form-label"
                      htmlFor={`step-prompt-${index}`}
                    >
                      Prompt
                    </label>
                    <textarea
                      className="form-control"
                      id={`step-prompt-${index}`}
                      onChange={(event) =>
                        updateStep(index, 'prompt', event.target.value)
                      }
                      required
                      rows={2}
                      value={step.prompt}
                    />
                  </div>

                  {isSurvey ? null : (
                  <div className="form-group mb-3">
                    <label
                      className="form-label"
                      htmlFor={`step-target-${index}`}
                    >
                      Target URL
                    </label>
                    <input
                      className="form-control"
                      id={`step-target-${index}`}
                      onChange={(event) =>
                        updateStep(index, 'target_url', event.target.value)
                      }
                      placeholder="https://..."
                      value={step.target_url}
                    />
                    <div className="form-text">
                      The page the participant opens and records. Leave blank only
                      for a survey-style step with no product to test.
                    </div>
                  </div>
                  )}

                  <div className="form-group mb-3">
                    <label
                      className="form-label"
                      htmlFor={`step-helper-${index}`}
                    >
                      Helper text
                    </label>
                    <input
                      className="form-control"
                      id={`step-helper-${index}`}
                      onChange={(event) =>
                        updateStep(index, 'helper_text', event.target.value)
                      }
                      value={step.helper_text}
                    />
                  </div>

                  <div className="form-check mb-3">
                    <input
                      className="form-check-input"
                      id={`step-required-${index}`}
                      checked={step.is_required}
                      onChange={(event) =>
                        updateStep(index, 'is_required', event.target.checked)
                      }
                      type="checkbox"
                    />
                    <label
                      className="form-check-label"
                      htmlFor={`step-required-${index}`}
                    >
                      Required
                    </label>
                  </div>

                  {isSurvey && step.type === 'rating' ? (
                    <div className="form-group mb-3">
                      <label
                        className="form-label"
                        htmlFor={`step-scale-${index}`}
                      >
                        Points on the scale
                      </label>
                      <input
                        className="form-control"
                        id={`step-scale-${index}`}
                        max={RATING_SCALE_BOUNDS.max}
                        min={RATING_SCALE_BOUNDS.min}
                        disabled={readOnly}
                        onChange={(event) =>
                          updateStep(index, 'config', {
                            ...step.config,
                            scale_max: Number(event.target.value)
                          })
                        }
                        style={{ maxWidth: '8rem' }}
                        type="number"
                        value={step.config?.scale_max ?? ''}
                      />
                    </div>
                  ) : null}

                  {step.type === 'single_choice' || step.type === 'multi_choice' ? (
                    <div className="form-group mb-3">
                      <label
                        className="form-label"
                        htmlFor={`step-options-${index}`}
                      >
                        Options (one per line)
                      </label>
                      <textarea
                        className="form-control"
                        id={`step-options-${index}`}
                        onChange={(event) =>
                          updateStep(index, 'options', event.target.value)
                        }
                        rows={3}
                        value={step.options}
                      />
                    </div>
                  ) : null}

                  {steps.length > 1 ? (
                    <Button
                      variant="outline-danger"
                      size="sm"
                      onClick={() => removeStep(index)}
                      type="button"
                    >
                      Remove task
                    </Button>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ol>

        {missingTaskPageUrl ? (
          <Alert variant="warning" className="mb-4">
            <strong>No task page URL set</strong>
            <p className="mb-2">
              Participants will be asked to share their screen with nothing
              pre-opened, and won't see the guided open-and-share step. Add a
              Target URL to a task step, or confirm this is a survey-style task list.
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
          <Button variant="secondary" onClick={addStep} type="button">
            Add task
          </Button>
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

      Mounted only when there is a pending exit, so an idle editor does not carry
      the modal's theme dependency - it is offscreen work with nothing to show.
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
 * Authoring page for `/admin/studies/new` and `/admin/studies/:id/edit`.
 * Admin-gated via AuthContext (the backend studies CRUD is `requireAdmin`).
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

      <p className="text-uppercase fw-semibold text-muted mb-1">
        Researcher workspace
      </p>
      <h1 className="h3 mb-2">
        {isEdit ? `Edit ${study?.title ?? 'task list'}` : 'New Task List'}
      </h1>
      <p className="text-muted mb-4">
        {isEdit
          ? 'Changes apply to new participant sessions. Sessions already in flight keep their original task payload.'
          : 'Define the intro copy, consent and task sequence. An unmoderated study references the task list id once published.'}
      </p>

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
      ) : (
        <StudyEditorForm
          initialStudy={isEdit ? study ?? undefined : undefined}
          initialSteps={isEdit ? steps : undefined}
          viewer={user}
        />
      )}
    </div>
  );
};

export default StudyEditor;
