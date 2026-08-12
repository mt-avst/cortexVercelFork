import React, { useEffect, useState } from 'react';

import { getFirstHandStudies } from '../../api/client';
import { FirstHandStudy, OpportunityFormData } from '../../api/types';
import {
  authorableStepTypes,
  type InlineStudyStep
} from '../../shared/firsthand/inline-study';

type FormFieldValue = string | number | boolean | undefined;

/**
 * The study fields the opportunity form carries. Declared here rather than on
 * OpportunityFormData because shared/types is flattened into a single file when
 * copied to the frontend, so it cannot import the inline-study contract.
 */
export type InlineStudyFormFields = {
  firsthand_study_id?: string;
  inline_study_consent_text?: string;
  inline_study_steps?: InlineStudyStep[];
  reuse_existing_study?: boolean;
};

interface FirstHandStudyTabProps {
  formData: OpportunityFormData & InlineStudyFormFields;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  /** Steps are an array, which handleInputChange's scalar signature cannot carry. */
  handleStepsChange: (steps: InlineStudyStep[]) => void;
  /** Edit mode links an already-created study; its script is edited in the studies area. */
  isEdit: boolean;
}

const STEP_TYPE_LABELS: Record<(typeof authorableStepTypes)[number], string> = {
  instruction: 'Instruction - something to read or do, no answer captured',
  open_text: 'Open text - participant types an answer',
  single_choice: 'Choice - participant picks one option'
};

/**
 * Authoring surface for an unmoderated study.
 *
 * An unmoderated opportunity cannot run without a study, so this tab collects
 * the study's content directly and the backend creates it on save. The previous
 * version of this tab only offered a picker of already-launched studies, which
 * meant abandoning a part-filled form to go and create one elsewhere.
 *
 * Reusing an existing script is still possible behind the toggle, and remains
 * the only option when editing (the opportunity already points at a study).
 */
const FirstHandStudyTab: React.FC<FirstHandStudyTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleStepsChange,
  isEdit
}) => {
  const [studies, setStudies] = useState<FirstHandStudy[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  // Editing always reuses: the study exists already and its script is edited in
  // the studies area, so the inline author would be a second source of truth.
  const reuseExisting = isEdit || Boolean(formData.reuse_existing_study);

  useEffect(() => {
    // Only the picker needs the list. Skip the request (and its cost) when
    // authoring inline, which is the default path.
    if (!reuseExisting) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setFetchError('');
    getFirstHandStudies()
      .then((data) => {
        if (!cancelled) setStudies(data);
      })
      .catch(() => {
        if (!cancelled) setFetchError('Could not load studies.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [retryCount, reuseExisting]);

  const steps = formData.inline_study_steps ?? [];
  const launchedStudies = studies.filter((s) => s.status === 'launched');
  // A study that exists but is not launched cannot be picked. Saying so beats
  // an empty dropdown, which reads as "you have no studies".
  const unlaunchedCount = studies.length - launchedStudies.length;

  const updateStep = (index: number, patch: Partial<InlineStudyStep>) => {
    handleStepsChange(
      steps.map((step, i) => (i === index ? { ...step, ...patch } : step))
    );
  };

  const addStep = () => {
    handleStepsChange([...steps, { type: 'open_text', prompt: '' }]);
  };

  const removeStep = (index: number) => {
    handleStepsChange(steps.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    handleStepsChange(next);
  };

  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2
              className="h4 mb-1 section-title"
              style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}
            >
              Study tasks
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              What the participant is asked to do while their screen is recorded
            </p>
          </div>
        </div>

        {!isEdit && (
          <div className="form-check mb-4">
            <input
              className="form-check-input"
              type="checkbox"
              id="reuse_existing_study"
              checked={Boolean(formData.reuse_existing_study)}
              onChange={(e) =>
                handleInputChange('reuse_existing_study', e.target.checked)
              }
            />
            <label className="form-check-label" htmlFor="reuse_existing_study">
              Reuse a script from an existing study instead of writing one here
            </label>
          </div>
        )}

        {reuseExisting ? (
          <div className="row">
            <div className="col-12 col-md-8">
              <div className="form-group mb-4">
                <label
                  htmlFor="firsthand_study_id"
                  className="form-label mb-2"
                  style={{ fontSize: '1rem', fontWeight: '600' }}
                >
                  Recorded study *
                </label>

                {loading && (
                  <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                    <span
                      className="spinner-border spinner-border-sm me-2"
                      role="status"
                      aria-hidden="true"
                    />
                    Loading studies...
                  </div>
                )}

                {!loading && fetchError && (
                  <div
                    className="alert alert-warning py-2 d-flex align-items-center justify-content-between"
                    style={{ fontSize: '0.875rem' }}
                  >
                    <span>{fetchError}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-warning ms-3"
                      onClick={() => setRetryCount((n) => n + 1)}
                    >
                      Retry
                    </button>
                  </div>
                )}

                {!loading && !fetchError && (
                  <select
                    id="firsthand_study_id"
                    className={`form-select ${validationErrors.firsthand_study_id ? 'is-invalid' : ''}`}
                    style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto' }}
                    value={formData.firsthand_study_id || ''}
                    onChange={(e) =>
                      handleInputChange('firsthand_study_id', e.target.value || undefined)
                    }
                  >
                    <option value="">-- Select a launched study --</option>
                    {launchedStudies.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                        {s.estimated_duration_minutes
                          ? ` (${s.estimated_duration_minutes} min)`
                          : ''}
                      </option>
                    ))}
                  </select>
                )}

                {validationErrors.firsthand_study_id && (
                  <div
                    className="fw-semibold"
                    style={{ fontSize: '0.875rem', display: 'block' }}
                  >
                    {validationErrors.firsthand_study_id}
                  </div>
                )}

                {!loading && !fetchError && launchedStudies.length === 0 && (
                  <div className="form-text mt-1" style={{ fontSize: '0.875rem' }}>
                    {unlaunchedCount > 0
                      ? `No launched studies. You have ${unlaunchedCount} ${unlaunchedCount === 1 ? 'study' : 'studies'} that ${unlaunchedCount === 1 ? 'is' : 'are'} not launched yet - launch ${unlaunchedCount === 1 ? 'it' : 'one'} in the studies area, or untick the box above and write the tasks here.`
                      : 'There are no studies yet. Untick the box above to write the tasks here.'}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {validationErrors.inline_study_steps && (
              <div className="alert alert-danger py-2" style={{ fontSize: '0.875rem' }}>
                {validationErrors.inline_study_steps}
              </div>
            )}

            {steps.length === 0 && (
              <p className="text-muted" style={{ fontSize: '0.95rem' }}>
                No tasks yet. Add the first thing you want the participant to do.
              </p>
            )}

            {steps.map((step, index) => (
              <div className="card mb-3" key={index}>
                <div className="card-body">
                  <div className="d-flex justify-content-between align-items-center mb-3">
                    <strong style={{ fontSize: '0.95rem' }}>Task {index + 1}</strong>
                    <div className="btn-group btn-group-sm">
                      <button
                        type="button"
                        className="btn btn-outline-secondary"
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0}
                        aria-label={`Move task ${index + 1} up`}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline-secondary"
                        onClick={() => moveStep(index, 1)}
                        disabled={index === steps.length - 1}
                        aria-label={`Move task ${index + 1} down`}
                      >
                        Down
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline-danger"
                        onClick={() => removeStep(index)}
                        aria-label={`Remove task ${index + 1}`}
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="mb-3">
                    <label
                      className="form-label mb-1"
                      htmlFor={`step_type_${index}`}
                      style={{ fontSize: '0.9rem', fontWeight: 600 }}
                    >
                      Type
                    </label>
                    <select
                      id={`step_type_${index}`}
                      className="form-select"
                      value={step.type}
                      onChange={(e) =>
                        updateStep(index, {
                          type: e.target.value as InlineStudyStep['type'],
                          // Options only mean anything for a choice step. Drop
                          // them on switch away so a stale list cannot be sent.
                          options:
                            e.target.value === 'single_choice'
                              ? (step.options ?? ['', ''])
                              : undefined
                        })
                      }
                    >
                      {authorableStepTypes.map((type) => (
                        <option key={type} value={type}>
                          {STEP_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mb-3">
                    <label
                      className="form-label mb-1"
                      htmlFor={`step_prompt_${index}`}
                      style={{ fontSize: '0.9rem', fontWeight: 600 }}
                    >
                      What the participant sees *
                    </label>
                    <textarea
                      id={`step_prompt_${index}`}
                      className={`form-control ${validationErrors[`inline_study_steps.${index}.prompt`] ? 'is-invalid' : ''}`}
                      rows={2}
                      value={step.prompt}
                      onChange={(e) => updateStep(index, { prompt: e.target.value })}
                      placeholder="Find the export button and download last month's report"
                    />
                    {validationErrors[`inline_study_steps.${index}.prompt`] && (
                      <div className="invalid-feedback d-block">
                        {validationErrors[`inline_study_steps.${index}.prompt`]}
                      </div>
                    )}
                  </div>

                  {step.type === 'single_choice' && (
                    <div className="mb-2">
                      <label
                        className="form-label mb-1"
                        style={{ fontSize: '0.9rem', fontWeight: 600 }}
                      >
                        Options (at least two) *
                      </label>
                      {(step.options ?? ['', '']).map((option, optionIndex) => (
                        <input
                          key={optionIndex}
                          className="form-control mb-2"
                          value={option}
                          aria-label={`Task ${index + 1} option ${optionIndex + 1}`}
                          onChange={(e) => {
                            const options = [...(step.options ?? ['', ''])];
                            options[optionIndex] = e.target.value;
                            updateStep(index, { options });
                          }}
                        />
                      ))}
                      <div className="d-flex gap-2">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() =>
                            updateStep(index, {
                              options: [...(step.options ?? ['', '']), '']
                            })
                          }
                        >
                          Add option
                        </button>
                        {(step.options ?? []).length > 2 && (
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-secondary"
                            onClick={() =>
                              updateStep(index, {
                                options: (step.options ?? []).slice(0, -1)
                              })
                            }
                          >
                            Remove last option
                          </button>
                        )}
                      </div>
                      {validationErrors[`inline_study_steps.${index}.options`] && (
                        <div className="invalid-feedback d-block">
                          {validationErrors[`inline_study_steps.${index}.options`]}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            <button type="button" className="btn btn-outline-primary mb-4" onClick={addStep}>
              Add task
            </button>

            <div className="row">
              <div className="col-12 col-md-8">
                <div className="form-group">
                  <label
                    htmlFor="inline_study_consent_text"
                    className="form-label mb-2"
                    style={{ fontSize: '1rem', fontWeight: '600' }}
                  >
                    Consent text *
                  </label>
                  <textarea
                    id="inline_study_consent_text"
                    className={`form-control ${validationErrors.inline_study_consent_text ? 'is-invalid' : ''}`}
                    rows={4}
                    value={formData.inline_study_consent_text ?? ''}
                    onChange={(e) =>
                      handleInputChange('inline_study_consent_text', e.target.value)
                    }
                  />
                  {validationErrors.inline_study_consent_text && (
                    <div className="invalid-feedback d-block">
                      {validationErrors.inline_study_consent_text}
                    </div>
                  )}
                  <div className="form-text mt-1" style={{ fontSize: '0.875rem' }}>
                    Shown before recording starts. The participant must accept it to continue.
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default FirstHandStudyTab;
