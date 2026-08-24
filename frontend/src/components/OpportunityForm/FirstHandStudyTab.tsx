import React, { useEffect, useState } from 'react';

import { getFirstHandStudies } from '../../api/client';
import { FirstHandStudy, OpportunityFormData } from '../../api/types';
import type { WithClientId } from '../../lib/opportunity-authoring/client-ids';
import { estimateRecordedMinutes } from '../../lib/opportunity-authoring/estimate-duration';
import type { StudyReadOnlyReason } from '../../lib/opportunity-authoring/hydrate-study';
import {
  authorableStepTypes,
  type InlineStudyStep
} from '@shared/firsthand/inline-study';
import { normaliseTargetUrl } from '../../utils/targetUrl';
import DurationEstimate from './DurationEstimate';
import QuestionList from './QuestionList';
import ReadOnlyStudyContent from './ReadOnlyStudyContent';
import StudyProvenanceNote from './StudyProvenanceNote';
import StudySourceChoice, { type StudySourceMode } from './StudySourceChoice';
import StudySourcePicker from './StudySourcePicker';
import type { FirstHandStudyWithSteps } from '../../api/firsthand-studies';
import FieldError from './FieldError';
import { resolveMessage } from '../../lib/opportunity-authoring/error-summary';

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
  /**
   * Where the content came from, replacing `reuse_existing_study`. Declared on
   * both surfaces' field types and backed by ONE field on the form, because
   * only one of the two tabs is ever rendered.
   */
  study_source?: StudySourceMode;
  copied_from_study_id?: string;
  copied_from_title?: string;
  copied_from_at?: string;
};

interface FirstHandStudyTabProps {
  /**
   * Revalidate one field on blur, by the same rules a save runs.
   *
   * Keyed by the FULL error key, because the rules on this step are per item:
   * `inline_study_steps.1.options`, not `options`.
   */
  onBlurField?: (errorKey: string) => void;
  formData: OpportunityFormData & InlineStudyFormFields;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  /** Steps are an array, which handleInputChange's scalar signature cannot carry. */
  handleStepsChange: (steps: WithClientId<InlineStudyStep>[]) => void;
  /**
   * True when the opportunity already has a task list of its own. Hides the
   * source choice: "where should this content come from" has been answered, and
   * the answer is "it is already here".
   *
   * The caller passes FALSE when the linked study is MISSING, deliberately. A
   * dangling link is not a task list, and the author needs the choice back in
   * order to repair it - authoring content is what makes the save mint a
   * replacement.
   *
   * NOT the same question as whether the list may be authored here - see
   * studyIsReadOnly. The two were one flag, and collapsing them is what made an
   * edit discard the author's content: a linked list swapped this tab to the
   * picker, so there was no surface for it to be loaded into.
   */
  hasLinkedStudy: boolean;
  /**
   * True when the linked task list may not be authored HERE - it belongs to
   * another researcher, or it holds a step type this tab cannot represent. It
   * is shown read-only; a list this author may change is loaded into the editor
   * below and saved back to the same study.
   */
  studyIsReadOnly: boolean;
  /**
   * Why, when it is. Null when a banner above the tabs already explains it, in
   * which case this tab says nothing rather than asserting a second cause.
   */
  readOnlyReason: StudyReadOnlyReason;
  /** Takes the copy. Resolves to a refusal message, or null when it worked. */
  onCopyFromStudy: (studyId: string) => Promise<string | null>;
  /**
   * Opens the participant preview on a stored set, before it is copied. Passed
   * straight to the picker; absent means the control is not offered.
   */
  onPreviewStudy?: (study: FirstHandStudyWithSteps) => void;
  /** Decides whether a row reads as "Yours". */
  currentUserId?: string;
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
 * Starting from an existing task list is still offered - as a COPY, chosen
 * explicitly, and only while this opportunity has no list of its own.
 */
const FirstHandStudyTab: React.FC<FirstHandStudyTabProps> = ({
  formData,
  onBlurField,
  validationErrors,
  handleInputChange,
  handleStepsChange,
  hasLinkedStudy,
  studyIsReadOnly,
  readOnlyReason,
  onCopyFromStudy,
  onPreviewStudy,
  currentUserId
}) => {
  const [studies, setStudies] = useState<FirstHandStudy[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  const [chooserOpen, setChooserOpen] = useState(false);

  const sourceMode: StudySourceMode = formData.study_source ?? 'blank';
  const copiedFromId = formData.copied_from_study_id ?? '';

  // The survey twin carries the reasoning for all three of these. They are
  // written the same way on both surfaces deliberately: the defect this project
  // keeps producing is a property pinned on one twin and not the other.
  const offeringSourceChoice = !hasLinkedStudy && !studyIsReadOnly;
  const choosingSource = offeringSourceChoice && sourceMode === 'copy';
  const showChooser = choosingSource && (!copiedFromId || chooserOpen);

  useEffect(() => {
    // Only the chooser needs the list. Skip the request (and its cost) when
    // authoring inline, which is the default path.
    if (!choosingSource) {
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
  }, [retryCount, choosingSource]);

  const steps = formData.inline_study_steps ?? [];
  /**
   * Only recorded-vocabulary task lists, and only launched ones.
   *
   * The `kind` half was missing, and the survey twin has had it since 7.37: a
   * survey-shaped study was offered in this picker and then refused by the API
   * on save, naming a rule the author had no way to see. Copying one would fail
   * the same way, one step earlier, so the filter is the fix rather than the
   * message.
   *
   * A study created before `kind` existed carries the column's DEFAULT
   * 'recorded' rather than nothing, so this excludes no legacy row.
   */
  const launchedStudies = studies.filter(
    (s) => s.status === 'launched' && s.kind !== 'survey'
  );
  // A draft task list cannot be picked but can be launched, so saying how many
  // are waiting beats an empty dropdown that reads as "you have none".
  // Archived ones are excluded: they are deliberately retired, so offering to
  // launch them would be wrong.
  const draftCount = studies.filter(
    (s) => s.status === 'draft' && s.kind !== 'survey'
  ).length;

  const estimate = estimateRecordedMinutes(steps);
  const automaticDuration = formData.inline_study_duration_auto !== false;

  return (
    <div className="tab-pane active">
      <div className="form-section mb-5">
        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
          <div>
            {/*
              The landing point for Review's Edit link on this step.
              `tabIndex={-1}` makes the heading focusable programmatically
              without adding a Tab stop, which is the standard skip-target
              shape. A heading rather than a control because there is no single
              control here to name: the author came back to change one of the tasks, and
              which one is theirs to choose. Its id is the validation key for
              the same content, so the two ways of addressing this step cannot
              drift apart.
            */}
            <h2
              id="inline_study_steps"
              tabIndex={-1}
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
            to change it, or create a new opportunity and start from a copy of
            it.
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

        {offeringSourceChoice && (
          <StudySourceChoice
            noun="task"
            idPrefix="task"
            value={sourceMode}
            onChange={(mode) => {
              setChooserOpen(false);
              handleInputChange('study_source', mode);
            }}
            copyLabel="Start from an existing task list"
          />
        )}

        {copiedFromId && !studyIsReadOnly && (
          <StudyProvenanceNote
            title={formData.copied_from_title || null}
            copiedAt={formData.copied_from_at}
            noun="task"
            onChooseAnother={
              choosingSource && !showChooser ? () => setChooserOpen(true) : undefined
            }
          />
        )}

        {/* Rendered ABOVE the three-way branch, not inside the editor arm.
            The copy-mode message this can carry - "Choose a task list to start
            from, or switch to writing the tasks here" - is set in exactly the
            state where the CHOOSER is on screen, so rendering it only alongside
            the editor made it unreachable: the author was routed to this step
            by the error summary and landed on a list with no error text on it.
            `role="alert"` matches the survey twin, which already had it. */}
        {validationErrors.inline_study_steps && (
          <div
            className="alert alert-danger py-2"
            style={{ fontSize: '0.875rem' }}
            role="alert"
          >
            {validationErrors.inline_study_steps}
          </div>
        )}

        {studyIsReadOnly ? (
          <ReadOnlyStudyContent items={steps} noun="task" />
        ) : showChooser ? (
          <div className="mb-4">
            <StudySourcePicker
              studies={launchedStudies}
              draftCount={draftCount}
              loading={loading}
              fetchError={fetchError}
              onRetry={() => setRetryCount((count) => count + 1)}
              onChoose={async (studyId) => {
                const failure = await onCopyFromStudy(studyId);
                if (!failure) setChooserOpen(false);
                return failure;
              }}
              onCancel={copiedFromId && chooserOpen ? () => setChooserOpen(false) : undefined}
              onPreviewStudy={onPreviewStudy}
              currentUserId={currentUserId}
              noun="task"
              setNoun="task list"
              idPrefix="task"
            />
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
                      // Safe to validate against the PRE-normalised value in
                      // state: the collector normalises this field itself
                      // before checking it, so both readings agree. Anywhere
                      // else, validating in the same tick as a change would
                      // read the state this render closed over, not the new one.
                      onBlurField?.('inline_study_target_url');
                    }}
                    placeholder="https://example.com/checkout"
                  />
                  {validationErrors.inline_study_target_url && (
                    <FieldError>
                      {validationErrors.inline_study_target_url}
                    </FieldError>
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
                  onBlur={() => onBlurField?.('inline_study_duration_minutes')}
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

            <QuestionList
              items={steps}
              onChange={handleStepsChange}
              validationErrors={validationErrors}
              errorPrefix="inline_study_steps"
              idPrefix="task"
              onBlurField={onBlurField}
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
                  <div
                    className="mb-2"
                    /* Group blur, not per box - see the survey twin. */
                    onBlur={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node | null
                        )
                      ) {
                        onBlurField?.(`inline_study_steps.${index}.options`);
                      }
                    }}
                  >
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
                        /* Addressable, so the summary's "Enter at least two
                           options for task 2" can land on the box the author
                           will type into. */
                        id={`task-option-${item._clientId}-${optionIndex}`}
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
                      <FieldError>
                        {resolveMessage(
                          `inline_study_steps.${index}.options`,
                          validationErrors[`inline_study_steps.${index}.options`]
                        )}
                      </FieldError>
                    )}
                  </div>
                ) : null
              }
            />

          </>
        )}
      </div>
    </div>
  );
};

export default FirstHandStudyTab;
