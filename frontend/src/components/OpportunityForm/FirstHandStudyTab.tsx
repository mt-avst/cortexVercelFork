import React, { useEffect, useState } from 'react';

import { getFirstHandStudies } from '../../api/client';
import { FirstHandStudy, OpportunityFormData } from '../../api/types';
import type { WithClientId } from '../../lib/opportunity-authoring/client-ids';
import { estimateRecordedMinutes } from '../../lib/opportunity-authoring/estimate-duration';
import type { StudyReadOnlyReason } from '../../lib/opportunity-authoring/hydrate-study';
import {
  authorableStepTypes,
  type InlineStudyStep
} from '../../shared/firsthand/inline-study';
import { normaliseTargetUrl } from '../../utils/targetUrl';
import DurationEstimate from './DurationEstimate';
import QuestionList from './QuestionList';

/**
 * What a researcher calls each task type, for the collapsed summary row.
 *
 * A `Record` keyed on the recorded vocabulary, so widening that set is a
 * compile error here until the new type has a name. The two typed shapes are
 * named as legacy because authoring no longer offers them - participants in a
 * recorded session answer out loud - but stored ones stay editable.
 */
const TASK_TYPE_LABELS: Record<(typeof authorableStepTypes)[number], string> = {
  instruction: 'Task',
  open_text: 'Typed answer (legacy)',
  single_choice: 'Choice (legacy)'
};

type FormFieldValue = string | number | boolean | undefined;

/**
 * The study fields the opportunity form carries. Declared here rather than on
 * OpportunityFormData because shared/types is flattened into a single file when
 * copied to the frontend, so it cannot import the inline-study contract.
 */
export type InlineStudyFormFields = {
  firsthand_study_id?: string;
  inline_study_target_url?: string;
  inline_study_duration_minutes?: number;
  /**
   * Whether the duration shown is derived from the task list. See the survey
   * twin in SurveyQuestionsTab for why this is a flag rather than "empty means
   * automatic".
   */
  inline_study_duration_auto?: boolean;
  inline_study_consent_text?: string;
  inline_study_steps?: WithClientId<InlineStudyStep>[];
  reuse_existing_study?: boolean;
};

interface FirstHandStudyTabProps {
  formData: OpportunityFormData & InlineStudyFormFields;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  /** Steps are an array, which handleInputChange's scalar signature cannot carry. */
  handleStepsChange: (steps: WithClientId<InlineStudyStep>[]) => void;
  /**
   * True when the opportunity already points at a task list. Hides the "reuse
   * an existing one instead" tickbox: swapping which list an opportunity points
   * at is not this form's job once it points at one.
   *
   * NOT the same question as whether the list may be authored here - see
   * studyIsReadOnly. The two were one flag, and collapsing them is what made an
   * edit discard the author's content: a linked list swapped this tab to the
   * picker, so there was no surface for it to be loaded into.
   */
  hasLinkedStudy: boolean;
  /**
   * True when the linked task list may not be authored HERE - it belongs to
   * another researcher, or it holds a step type this tab cannot represent. Only
   * then is the picker the right surface; a list this author may change is
   * loaded into the editor below and saved back to the same study.
   */
  studyIsReadOnly: boolean;
  /**
   * Why, when it is. Null when a banner above the tabs already explains it, in
   * which case this tab says nothing rather than asserting a second cause.
   */
  readOnlyReason: StudyReadOnlyReason;
}

/**
 * Authoring surface for an unmoderated opportunity's task list.
 *
 * An unmoderated opportunity cannot run without a task list, so this tab
 * collects its content directly and the backend creates it on save. The
 * previous version of this tab only offered a picker of already-launched task
 * lists, which meant abandoning a part-filled form to go and create one
 * elsewhere.
 *
 * Reusing an existing task list is still possible behind the toggle, and is the
 * only option once the opportunity actually points at one.
 */
const FirstHandStudyTab: React.FC<FirstHandStudyTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleStepsChange,
  hasLinkedStudy,
  studyIsReadOnly,
  readOnlyReason
}) => {
  const [studies, setStudies] = useState<FirstHandStudy[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  const reuseExisting = studyIsReadOnly || Boolean(formData.reuse_existing_study);

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
        if (!cancelled) setFetchError('Could not load task lists.');
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
  // A draft task list cannot be picked but can be launched, so saying how many
  // are waiting beats an empty dropdown that reads as "you have none".
  // Archived ones are excluded: they are deliberately retired, so offering to
  // launch them would be wrong.
  const draftCount = studies.filter((s) => s.status === 'draft').length;

  const estimate = estimateRecordedMinutes(steps);
  const automaticDuration = formData.inline_study_duration_auto !== false;

  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            <h2
              className="h4 mb-1 section-title"
              style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}
            >
              Task List
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              What the participant is asked to do while their screen is recorded
            </p>
          </div>
        </div>

        {readOnlyReason === 'not-yours' && (
          <div className="alert alert-info py-2 px-3 mb-4" style={{ fontSize: '0.875rem' }}>
            This task list belongs to another researcher, so it is not editable
            here - and the Task Lists area applies the same rule. Ask its owner
            to change it, or pick a different one below.
          </div>
        )}

        {readOnlyReason === 'not-representable' && (
          <div className="alert alert-info py-2 px-3 mb-4" style={{ fontSize: '0.875rem' }}>
            This task list uses something this form cannot show - a step type it
            does not offer, or a different starting URL per step. Editing it here
            would drop what is not shown, so open it in the Task Lists area
            instead.
          </div>
        )}

        {!hasLinkedStudy && (
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
              Reuse an existing task list instead of writing one here
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
                  Existing task list *
                </label>

                {loading && (
                  <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                    <span
                      className="spinner-border spinner-border-sm me-2"
                      role="status"
                      aria-hidden="true"
                    />
                    Loading task lists...
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
                    <option value="">-- Select a launched task list --</option>
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
                    {draftCount > 0
                      ? `No launched task lists. You have ${draftCount} ${draftCount === 1 ? 'task list' : 'task lists'} still in draft - launch ${draftCount === 1 ? 'it' : 'one'} in the Task Lists area, or untick the box above and write the tasks here.`
                      : 'There are no task lists to reuse. Untick the box above to write the tasks here.'}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="row">
              <div className="col-12 col-md-8">
                <div className="form-group mb-4">
                  <label
                    htmlFor="inline_study_target_url"
                    className="form-label mb-2"
                    style={{ fontSize: '1rem', fontWeight: '600' }}
                  >
                    Starting URL
                  </label>
                  <input
                    id="inline_study_target_url"
                    type="text"
                    className={`form-control ${validationErrors.inline_study_target_url ? 'is-invalid' : ''}`}
                    style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem' }}
                    value={formData.inline_study_target_url ?? ''}
                    onChange={(e) =>
                      handleInputChange('inline_study_target_url', e.target.value)
                    }
                    // Normalise on blur rather than at save, so the author
                    // WATCHES "example.com" become "https://example.com" and
                    // knows what will be stored. Rewriting silently at submit
                    // would fix the symptom and hide the change.
                    onBlur={(e) => {
                      const normalised = normaliseTargetUrl(e.target.value);
                      if (normalised !== e.target.value) {
                        handleInputChange('inline_study_target_url', normalised);
                      }
                    }}
                    placeholder="https://example.com/checkout"
                  />
                  {validationErrors.inline_study_target_url && (
                    <div className="invalid-feedback d-block">
                      {validationErrors.inline_study_target_url}
                    </div>
                  )}
                  <div className="form-text mt-1" style={{ fontSize: '0.875rem' }}>
                    The page the participant opens and shares before recording starts.
                    Leave it empty for a questionnaire with no page to test - they will
                    get a single start button instead.
                  </div>
                </div>
              </div>
            </div>

            {/* Optional, and optional on purpose. Before this field existed the
                create path fell back to the opportunity's default_duration_minutes
                - NOT NULL, DEFAULT 30 - so every recorded study told participants
                "about 30 minutes" above a consent button, chosen by nobody. An
                empty field STILL means nobody said, and every surface renders
                that as nothing. The automatic estimate is a better default than
                a blank, but it is a default, not a floor. */}
            <div className="row">
              <div className="col-12 col-md-6">
                <DurationEstimate
                  field="inline_study_duration_minutes"
                  value={formData.inline_study_duration_minutes}
                  automatic={automaticDuration}
                  estimate={estimate}
                  error={validationErrors.inline_study_duration_minutes}
                  derivedFrom={`${steps.length} ${
                    steps.length === 1 ? 'task' : 'tasks'
                  }`}
                  onValueChange={(value) =>
                    handleInputChange('inline_study_duration_minutes', value)
                  }
                  onAutomaticChange={(automatic) =>
                    handleInputChange('inline_study_duration_auto', automatic)
                  }
                />
              </div>
            </div>

            {validationErrors.inline_study_steps && (
              <div className="alert alert-danger py-2" style={{ fontSize: '0.875rem' }}>
                {validationErrors.inline_study_steps}
              </div>
            )}

            <QuestionList
              items={steps}
              onChange={handleStepsChange}
              validationErrors={validationErrors}
              errorPrefix="inline_study_steps"
              idPrefix="task"
              noun="task"
              nounPlural="tasks"
              typeLabels={TASK_TYPE_LABELS}
              /* No type selector: a recorded participant answers out loud, so
                 authoring offers instructions only. Adding one here would be a
                 product change wearing a shared component's clothes. */
              typeVocabulary={null}
              makeItem={(): InlineStudyStep => ({ type: 'instruction', prompt: '' })}
              promptLabel={() => 'What the participant sees *'}
              promptPlaceholder="Find the export button and download last month's report"
              addLabel="Add task"
              emptyMessage="No tasks yet. Add the first thing you want the participant to do."
              renderTypeFields={({ item, index, update }) =>
                item.type === 'single_choice' ? (
                  <div className="mb-2">
                    <label
                      className="form-label mb-1"
                      style={{ fontSize: '0.9rem', fontWeight: 600 }}
                    >
                      Options (at least two) *
                    </label>
                    {(item.options ?? ['', '']).map((option, optionIndex) => (
                      <input
                        key={optionIndex}
                        className="form-control mb-2"
                        value={option}
                        aria-label={`Task ${index + 1} option ${optionIndex + 1}`}
                        onChange={(e) =>
                          update({
                            options: (item.options ?? ['', '']).map((each, i) =>
                              i === optionIndex ? e.target.value : each
                            )
                          })
                        }
                      />
                    ))}
                    <div className="d-flex gap-2">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() =>
                          update({ options: [...(item.options ?? ['', '']), ''] })
                        }
                      >
                        Add option
                      </button>
                      {(item.options ?? []).length > 2 && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() =>
                            update({ options: (item.options ?? []).slice(0, -1) })
                          }
                        >
                          Remove last option
                        </button>
                      )}
                    </div>
                    {validationErrors[`inline_study_steps.${index}.options`] && (
                      <div className="validation-error" role="alert">
                        {validationErrors[`inline_study_steps.${index}.options`]}
                      </div>
                    )}
                  </div>
                ) : null
              }
            />

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
