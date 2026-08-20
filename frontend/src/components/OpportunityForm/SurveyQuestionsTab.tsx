import React, { useEffect, useState } from 'react';

import { getFirstHandStudies } from '../../api/client';
import { FirstHandStudy, OpportunityFormData } from '../../api/types';
import type { WithClientId } from '../../lib/opportunity-authoring/client-ids';
import { estimateSurveyMinutes } from '../../lib/opportunity-authoring/estimate-duration';
import type { StudyReadOnlyReason } from '../../lib/opportunity-authoring/hydrate-study';
import {
  NPS_SCALE_MAX,
  RATING_SCALE_BOUNDS
} from '../../shared/firsthand/contract';
import {
  authorableSurveyStepTypes,
  type SurveyQuestion
} from '../../shared/firsthand/survey-authoring';
import DurationEstimate from './DurationEstimate';
import QuestionList from './QuestionList';
import ReadOnlyStudyContent from './ReadOnlyStudyContent';
import StudyProvenanceNote from './StudyProvenanceNote';
import StudySourceChoice, { type StudySourceMode } from './StudySourceChoice';
import StudySourcePicker from './StudySourcePicker';

type FormFieldValue = string | number | boolean | undefined;

/**
 * The survey fields the opportunity form carries. Declared here rather than on
 * OpportunityFormData for the same reason the task-list fields are: shared/types
 * is flattened into a single file when copied to the frontend, so it cannot
 * import the survey contract.
 */
export type InlineSurveyFormFields = {
  firsthand_study_id?: string;
  inline_survey_duration_minutes?: number;
  /**
   * Whether the duration shown is derived from the question list.
   *
   * A separate flag rather than "empty means automatic", because empty already
   * means something: tell the participant no length at all. Collapsing the two
   * would remove a capability the field's own help text offers.
   */
  inline_survey_duration_auto?: boolean;
  inline_survey_consent_text?: string;
  inline_survey_questions?: WithClientId<SurveyQuestion>[];
  /**
   * Where the content came from, replacing `reuse_existing_survey`. Shared with
   * the task-list twin: only one authoring surface renders at a time, so a
   * per-surface flag could only ever disagree with its counterpart.
   */
  study_source?: StudySourceMode;
  copied_from_study_id?: string;
  copied_from_title?: string;
  copied_from_at?: string;
};

/**
 * What a researcher calls each question type. A `Record` keyed on the survey
 * vocabulary, so adding a type to that set is a compile error here until it has
 * a label - the same guard the recorded task list has.
 */
const QUESTION_TYPE_LABELS: Record<
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

const DEFAULT_RATING_SCALE = 5;

/** Types whose answers come from a list the author writes. */
const CHOICE_TYPES = new Set(['single_choice', 'multi_choice']);

interface SurveyQuestionsTabProps {
  formData: OpportunityFormData & InlineSurveyFormFields;
  validationErrors: Record<string, string>;
  handleInputChange: (field: string, value: FormFieldValue) => void;
  /** Questions are an array, which handleInputChange's scalar signature cannot carry. */
  handleQuestionsChange: (questions: WithClientId<SurveyQuestion>[]) => void;
  /**
   * True when the opportunity already has questions of its own. Hides the
   * source choice: "where should this content come from" has been answered, and
   * the answer is "it is already here".
   *
   * The caller passes FALSE when the linked study is MISSING, deliberately. A
   * dangling link is not a set of questions, and the author needs the choice
   * back in order to repair it - authoring content is what makes the save mint
   * a replacement.
   *
   * NOT the same question as whether those questions may be authored here - see
   * studyIsReadOnly. The two were one flag, and collapsing them is what made an
   * edit discard the author's questions: a linked set swapped this tab to the
   * picker, so there was no surface for them to be loaded into.
   */
  hasLinkedStudy: boolean;
  /**
   * True when the linked questions may not be authored HERE - they belong to
   * another researcher, or they use a step type this tab cannot represent. They
   * are shown read-only; questions this author may change are loaded into the
   * editor below and saved back to the same study.
   */
  studyIsReadOnly: boolean;
  /**
   * Why, when it is. Null when a banner above the tabs already explains it, in
   * which case this tab says nothing rather than asserting a second cause.
   */
  readOnlyReason: StudyReadOnlyReason;
  /** Takes the copy. Resolves to a refusal message, or null when it worked. */
  onCopyFromStudy: (studyId: string) => Promise<string | null>;
  /** Decides whether a row reads as "Yours". */
  currentUserId?: string;
}

/**
 * Authoring surface for a native poll or survey.
 *
 * The counterpart of the task-list tab, and deliberately a separate component
 * rather than a mode of it. The two collect different things from different
 * vocabularies: a task list has a starting URL and instructions performed aloud
 * while a screen recording runs, a survey has typed questions and no page under
 * test at all. Sharing one component would mean a tab that hides half of itself.
 */
const SurveyQuestionsTab: React.FC<SurveyQuestionsTabProps> = ({
  formData,
  validationErrors,
  handleInputChange,
  handleQuestionsChange,
  hasLinkedStudy,
  studyIsReadOnly,
  readOnlyReason,
  onCopyFromStudy,
  currentUserId
}) => {
  const [studies, setStudies] = useState<FirstHandStudy[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  const [chooserOpen, setChooserOpen] = useState(false);

  const sourceMode: StudySourceMode = formData.study_source ?? 'blank';
  const copiedFromId = formData.copied_from_study_id ?? '';

  /**
   * The source choice is offered only before a study exists, exactly as the
   * checkbox it replaces was: once an opportunity has one, the question is no
   * longer "where does this come from" but "what does it say".
   */
  const offeringSourceChoice = !hasLinkedStudy && !studyIsReadOnly;
  const choosingSource = offeringSourceChoice && sourceMode === 'copy';

  /**
   * The chooser gives way to the editor as soon as a copy has been taken, so
   * the author lands on their content rather than on the list they just used.
   * `chooserOpen` is local UI state, not form data: reopening the list must not
   * discard the provenance of the copy already taken, which is what clearing
   * `copied_from_study_id` to reopen it would have done.
   */
  const showChooser = choosingSource && (!copiedFromId || chooserOpen);

  useEffect(() => {
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
        if (!cancelled) setFetchError('Could not load questions.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [retryCount, choosingSource]);

  const questions = formData.inline_survey_questions ?? [];

  /**
   * Only survey-vocabulary studies, and only launched ones.
   *
   * A recorded task list offered here would be refused by the API on save, so
   * showing it is offering a choice that cannot work. The API check is the real
   * boundary - this filter exists so the researcher never reaches it.
   */
  const selectableStudies = studies.filter(
    (study) => study.status === 'launched' && study.kind === 'survey'
  );
  const draftCount = studies.filter(
    (study) => study.status === 'draft' && study.kind === 'survey'
  ).length;

  /**
   * Changing type keeps what the new type cannot show, rather than deleting it.
   *
   * It used to replace the question wholesale, so a multiple choice switched to
   * free text and back came back with two empty answer rows and the author's
   * four options gone - destroyed by a control that looks like a filter.
   *
   * The reason it deleted them is real, though, and has only moved: a rating's
   * `scale_max` left on a question switched to NPS is REFUSED by the contract,
   * and the save would fail naming a field the form is no longer showing. So
   * the leftovers are preserved HERE and stripped in `toSurveyPayloadStep`,
   * which is the same function `studyRoundTripsCleanly` checks the round trip
   * with - the two cannot drift apart.
   */
  const changeQuestionType = (
    question: WithClientId<SurveyQuestion>,
    type: string
  ): WithClientId<SurveyQuestion> => {
    const next: WithClientId<SurveyQuestion> = {
      ...question,
      type: type as SurveyQuestion['type']
    };

    // Not carried onto an instruction: it cannot be answered, so a required
    // flag on one is hidden state that crosses the API and is stored meaning
    // nothing. Deleted rather than preserved because, unlike options and a
    // scale, there is nothing for the author to get back - the checkbox is
    // simply off when they switch away again.
    if (type === 'instruction') {
      delete next.is_required;
    }

    // Seeded only when there is nothing to restore, so switching back to a
    // choice type recovers the answers the author already wrote.
    if (CHOICE_TYPES.has(type) && (next.options ?? []).length === 0) {
      next.options = ['', ''];
    }

    // Same rule for the scale. `rating` is the one type the contract REQUIRES
    // a config on, so a seed is not a convenience here.
    if (type === 'rating' && next.config?.scale_max === undefined) {
      next.config = { ...next.config, scale_max: DEFAULT_RATING_SCALE };
    }

    return next;
  };

  const estimate = estimateSurveyMinutes(questions);
  const automaticDuration = formData.inline_survey_duration_auto !== false;

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
              control here to name: the author came back to change one of the questions, and
              which one is theirs to choose. Its id is the validation key for
              the same content, so the two ways of addressing this step cannot
              drift apart.
            */}
            <h2
              id="inline_survey_questions"
              tabIndex={-1}
              className="h4 mb-1 section-title"
              style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}
            >
              Questions
            </h2>
            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
              What the participant is asked, answered here in Cortex
            </p>
          </div>
        </div>

        {readOnlyReason === 'not-yours' && (
          <div className="alert alert-info py-2 px-3 mb-4" style={{ fontSize: '0.875rem' }}>
            These questions belong to another researcher, so they are not
            editable here - and the Task Lists area applies the same rule. Ask
            their owner to change them, or create a new opportunity and start
            from a copy of them.
          </div>
        )}

        {readOnlyReason === 'not-representable' && (
          <div className="alert alert-info py-2 px-3 mb-4" style={{ fontSize: '0.875rem' }}>
            These questions use something this form cannot show, so editing them
            here would drop what is not shown. Open them in the Task Lists area
            instead.
          </div>
        )}

        {offeringSourceChoice && (
          <StudySourceChoice
            noun="question"
            idPrefix="survey"
            value={sourceMode}
            onChange={(mode) => {
              // Switching mode is never destructive: the questions already
              // written stay written, and the provenance of a copy already
              // taken stays recorded. Only which surface renders changes.
              setChooserOpen(false);
              handleInputChange('study_source', mode);
            }}
            copyLabel="Start from an existing set of questions"
          />
        )}

        {copiedFromId && !studyIsReadOnly && (
          <StudyProvenanceNote
            title={formData.copied_from_title || null}
            copiedAt={formData.copied_from_at}
            noun="question"
            onChooseAnother={
              choosingSource && !showChooser ? () => setChooserOpen(true) : undefined
            }
          />
        )}

        {/* Rendered ABOVE the three-way branch, not inside the editor arm.
            The copy-mode message this can carry - "Choose a question to start from,
            or switch to writing them here" - is set in exactly the state where
            the CHOOSER is on screen, so rendering it only alongside the editor
            made it unreachable: the author was routed to this step by the error
            summary and landed on a list with no error text on it. */}
        {validationErrors.inline_survey_questions && (
          <div className="validation-error mb-2" role="alert">
            {validationErrors.inline_survey_questions}
          </div>
        )}

        {studyIsReadOnly ? (
          <ReadOnlyStudyContent items={questions} noun="question" />
        ) : showChooser ? (
          <div className="mb-4">
            <StudySourcePicker
              studies={selectableStudies}
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
              currentUserId={currentUserId}
              noun="question"
              setNoun="set of questions"
              idPrefix="survey"
            />
          </div>
        ) : (
          <>
            <div className="row">
              <div className="col-12 col-md-6">
                <DurationEstimate
                  field="inline_survey_duration_minutes"
                  value={formData.inline_survey_duration_minutes}
                  automatic={automaticDuration}
                  estimate={estimate}
                  error={validationErrors.inline_survey_duration_minutes}
                  derivedFrom={`${questions.length} ${
                    questions.length === 1 ? 'question' : 'questions'
                  }`}
                  onValueChange={(value) =>
                    handleInputChange('inline_survey_duration_minutes', value)
                  }
                  onAutomaticChange={(automatic) =>
                    handleInputChange('inline_survey_duration_auto', automatic)
                  }
                />
              </div>
            </div>

            <QuestionList
              items={questions}
              onChange={handleQuestionsChange}
              validationErrors={validationErrors}
              errorPrefix="inline_survey_questions"
              idPrefix="question"
              noun="question"
              nounPlural="questions"
              typeLabels={QUESTION_TYPE_LABELS}
              typeVocabulary={authorableSurveyStepTypes}
              onChangeType={changeQuestionType}
              makeItem={(): SurveyQuestion => ({ type: 'open_text', prompt: '' })}
              promptLabel={(question) =>
                question.type === 'instruction'
                  ? 'What the participant reads *'
                  : 'What the participant is asked *'
              }
              addLabel="Add question"
              emptyMessage="No questions yet. Add the first thing you want to ask."
              renderTypeFields={({ item, index, update }) => (
                <>
                  {CHOICE_TYPES.has(item.type) && (
                    <div className="form-group mb-3">
                      <label className="form-label">Answers</label>
                      {(item.options ?? []).map((option, optionIndex) => (
                        <div className="input-group mb-2" key={optionIndex}>
                          <input
                            className="form-control"
                            aria-label={`Answer ${optionIndex + 1} for question ${index + 1}`}
                            value={option}
                            onChange={(e) =>
                              update({
                                options: (item.options ?? []).map((each, i) =>
                                  i === optionIndex ? e.target.value : each
                                )
                              })
                            }
                          />
                          <button
                            type="button"
                            className="btn btn-outline-secondary"
                            onClick={() =>
                              update({
                                options: (item.options ?? []).filter(
                                  (_, i) => i !== optionIndex
                                )
                              })
                            }
                            disabled={(item.options ?? []).length <= 2}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() =>
                          update({ options: [...(item.options ?? []), ''] })
                        }
                      >
                        Add answer
                      </button>
                      {validationErrors[
                        `inline_survey_questions.${index}.options`
                      ] && (
                        <div className="validation-error" role="alert">
                          {
                            validationErrors[
                              `inline_survey_questions.${index}.options`
                            ]
                          }
                        </div>
                      )}
                    </div>
                  )}

                  {item.type === 'rating' && (
                    <div className="form-group mb-3">
                      <label
                        className="form-label"
                        htmlFor={`question-scale-${item._clientId}`}
                      >
                        Points on the scale
                      </label>
                      <input
                        type="number"
                        className="form-control"
                        id={`question-scale-${item._clientId}`}
                        min={RATING_SCALE_BOUNDS.min}
                        max={RATING_SCALE_BOUNDS.max}
                        style={{ maxWidth: '8rem' }}
                        value={item.config?.scale_max ?? DEFAULT_RATING_SCALE}
                        onChange={(e) =>
                          update({
                            config: {
                              ...item.config,
                              scale_max: Number(e.target.value)
                            }
                          })
                        }
                      />
                      {validationErrors[
                        `inline_survey_questions.${index}.config`
                      ] && (
                        <div className="validation-error" role="alert">
                          {
                            validationErrors[
                              `inline_survey_questions.${index}.config`
                            ]
                          }
                        </div>
                      )}
                      <div className="form-text">
                        Between {RATING_SCALE_BOUNDS.min} and{' '}
                        {RATING_SCALE_BOUNDS.max}. Not defaulted silently: two
                        surveys with the same wording on different scales produce
                        data nothing records the difference between.
                      </div>
                    </div>
                  )}

                  {item.type === 'nps' && (
                    <div className="form-text mb-3">
                      Always 0 to {NPS_SCALE_MAX}, so there is nothing to set. An
                      author-set scale would produce something labelled a
                      recommendation score whose numbers cannot be compared with
                      anyone else&apos;s.
                    </div>
                  )}

                  {item.type !== 'instruction' && (
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id={`question-required-${item._clientId}`}
                        checked={Boolean(item.is_required)}
                        onChange={(e) =>
                          update({ is_required: e.target.checked })
                        }
                      />
                      <label
                        className="form-check-label"
                        htmlFor={`question-required-${item._clientId}`}
                      >
                        Required
                      </label>
                    </div>
                  )}
                </>
              )}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default SurveyQuestionsTab;
