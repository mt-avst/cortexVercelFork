import React, { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import {
  createFirstHandStudy,
  getFirstHandStudy,
  updateFirstHandStudy,
} from '../api/firsthand-studies';
import { Alert, Button, Card, CardBody } from '../components/ui';
import type { FirstHandStudy } from '../api/types';
import type { StudyStep } from '../shared/firsthand/contract';
import {
  createStudyRequestSchema,
  updateStudyRequestSchema,
} from '../shared/firsthand/study-input';

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
};

const stepTypeOptions: StepType[] = [
  'instruction',
  'open_text',
  'single_choice',
  'end',
];

const defaultStep = (order: number): StepDraft => ({
  step_id: `step_${String(order).padStart(3, '0')}`,
  order,
  type: 'instruction',
  prompt: '',
  target_url: '',
  helper_text: '',
  is_required: false,
  options: '',
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

  if (draft.type === 'single_choice') {
    base.options = draft.options
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  return base;
};

/**
 * Whether a study has task steps but no task-page URL on any of them.
 *
 * A study with task steps but no `target_url` anywhere records the participant's
 * whole screen with nothing pre-opened, and they never see the guided
 * open-and-share step. That is correct for a survey-style study, but is almost
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

type StudyEditorFormProps = {
  initialStudy?: FirstHandStudy;
  initialSteps?: StudyStep[];
};

/**
 * The study authoring form. Ported from FirstHand `study-editor.tsx`: same field
 * set, step model, and the missing-task-page-URL acknowledgement gate, reskinned
 * onto Cortex's Momentum form classes and backed by the in-process studies CRUD.
 */
export function StudyEditorForm({
  initialStudy,
  initialSteps,
}: StudyEditorFormProps) {
  const navigate = useNavigate();
  const isEditing = Boolean(initialStudy);
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
  const [steps, setSteps] = useState<StepDraft[]>(() => {
    if (initialSteps && initialSteps.length > 0) {
      return initialSteps
        .slice()
        .sort((left, right) => left.order - right.order)
        .map(stepDraftFromStep);
    }

    return [defaultStep(1)];
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgedNoTaskPageUrl, setAcknowledgedNoTaskPageUrl] =
    useState(false);

  const missingTaskPageUrl = studyMissingTaskPageUrl(steps);

  const addStep = () => {
    setSteps((current) => [...current, defaultStep(current.length + 1)]);
  };

  const removeStep = (index: number) => {
    setSteps((current) =>
      current
        .filter((_, idx) => idx !== index)
        .map((step, idx) => ({ ...step, order: idx + 1 }))
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
        'This study has task steps but no task page URL. Add one, or confirm it is a survey-style study.'
      );
      return;
    }

    const payload = {
      title: title.trim(),
      intro_text: introText.trim(),
      consent_text: consentText.trim(),
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
    setSubmitting(true);

    try {
      if (isEditing) {
        const parsed = updateStudyRequestSchema.safeParse(payload);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'The study is not valid.');
          return;
        }
        await updateFirstHandStudy(initialStudy!.id, parsed.data);
      } else {
        const parsed = createStudyRequestSchema.safeParse(payload);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'The study is not valid.');
          return;
        }
        await createFirstHandStudy(parsed.data);
      }

      navigate('/admin/studies');
    } catch (caught) {
      setError(extractSaveError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {error ? (
        <Alert variant="danger" className="mb-4">
          <strong>Could not save study.</strong>
          <p className="mb-0">{error}</p>
        </Alert>
      ) : null}

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
              <option value="launched">launched</option>
              <option value="archived">archived</option>
            </select>
          </div>
        </div>
      </div>

      <h2 className="h5 mt-4 mb-3">Steps</h2>

      <ol className="list-unstyled">
        {steps.map((step, index) => (
          <li className="mb-4" key={index}>
            <Card padding="md" hoverable={false}>
              <CardBody>
                <p className="fw-semibold mb-3">Step {step.order}</p>

                <div className="form-group mb-3">
                  <label className="form-label" htmlFor={`step-id-${index}`}>
                    Step id
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

                <div className="form-group mb-3">
                  <label className="form-label" htmlFor={`step-type-${index}`}>
                    Type
                  </label>
                  <select
                    className="form-select"
                    id={`step-type-${index}`}
                    onChange={(event) =>
                      updateStep(index, 'type', event.target.value as StepType)
                    }
                    value={step.type}
                  >
                    {stepTypeOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

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

                {step.type === 'single_choice' ? (
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
                    Remove step
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
            Target URL to a task step, or confirm this is a survey-style study.
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
              This study has no task page on purpose
            </label>
          </div>
        </Alert>
      ) : null}

      <div className="d-flex gap-2">
        <Button variant="secondary" onClick={addStep} type="button">
          Add step
        </Button>
        <Button
          variant="primary"
          disabled={
            submitting || (missingTaskPageUrl && !acknowledgedNoTaskPageUrl)
          }
          loading={submitting}
          type="submit"
        >
          {submitting ? 'Saving...' : isEditing ? 'Save changes' : 'Create study'}
        </Button>
      </div>
    </form>
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
            ? 'That study could not be found.'
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
      <Link className="btn btn-link px-0 mb-3" to="/admin/studies">
        Back to studies
      </Link>

      <p className="text-uppercase fw-semibold text-muted mb-1">
        Researcher workspace
      </p>
      <h1 className="h3 mb-2">
        {isEdit ? `Edit ${study?.title ?? 'study'}` : 'New study'}
      </h1>
      <p className="text-muted mb-4">
        {isEdit
          ? 'Changes apply to new participant sessions. Sessions already in flight keep their original step payload.'
          : 'Define the intro copy, consent, and step sequence. An unmoderated opportunity references the study id once published.'}
      </p>

      {isEdit && loadingStudy ? (
        <div className="d-flex justify-content-center py-5">
          <div
            className="spinner-border text-primary"
            role="status"
            aria-label="Loading study"
          >
            <span className="visually-hidden">Loading study...</span>
          </div>
        </div>
      ) : loadError ? (
        <Alert variant="danger">
          <strong>Could not load study.</strong>
          <p className="mb-0">{loadError}</p>
        </Alert>
      ) : (
        <StudyEditorForm
          initialStudy={isEdit ? study ?? undefined : undefined}
          initialSteps={isEdit ? steps : undefined}
        />
      )}
    </div>
  );
};

export default StudyEditor;
