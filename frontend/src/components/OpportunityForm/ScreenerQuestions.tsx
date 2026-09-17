import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { VALIDATION } from '@shared/constants';
import type { ScreenerOption, ScreenerQuestion } from '@shared/types';

import {
  makeScreenerOption,
  makeScreenerQuestion
} from '../../lib/opportunity-authoring/screener';
import { withClientId, type WithClientId } from '../../lib/opportunity-authoring/client-ids';
import { resolveMessage } from '../../lib/opportunity-authoring/error-summary';
import FieldError from './FieldError';
import './screener-questions.css';

interface ScreenerQuestionsProps {
  questions: WithClientId<ScreenerQuestion>[];
  onChange: (next: WithClientId<ScreenerQuestion>[]) => void;
  /** Keyed `screener_questions.<i>.prompt|options` and `...options.<j>.label`. */
  validationErrors: Record<string, string>;
  /** Revalidate one field on blur, by its full error key. Optional. */
  onBlurField?: (errorKey: string) => void;
}

/**
 * The screener question builder.
 *
 * Bespoke rather than reusing `QuestionList`: a screener answer is not a string
 * but an object carrying a `disqualifies` flag, and the whole of this component
 * is the per-answer Qualify / Screen-out control that flag needs. It stays flat
 * and always expanded - a screener is at most five short single-choice
 * questions (`VALIDATION.SCREENER_MAX_QUESTIONS`), so the collapse, reorder and
 * duplicate machinery `QuestionList` earns on a twenty-question survey would be
 * weight with nothing to carry here.
 *
 * It owns editing only. Validation lives in `collectScreenerErrors`, called by
 * the form, and arrives back as `validationErrors` for display - one source of
 * truth, the same the save is gated on, so the two cannot drift.
 */
const ScreenerQuestions: React.FC<ScreenerQuestionsProps> = ({
  questions,
  onChange,
  validationErrors,
  onBlurField
}) => {
  const errorFor = (key: string): string | undefined => {
    const message = validationErrors[key];
    return message === undefined ? undefined : resolveMessage(key, message);
  };

  const updateQuestion = (index: number, patch: Partial<ScreenerQuestion>) =>
    onChange(
      questions.map((question, i) =>
        i === index ? { ...question, ...patch } : question
      )
    );

  const updateOption = (
    qIndex: number,
    oIndex: number,
    patch: Partial<ScreenerOption>
  ) =>
    updateQuestion(qIndex, {
      options: questions[qIndex].options.map((option, i) =>
        i === oIndex ? { ...option, ...patch } : option
      )
    });

  const addQuestion = () =>
    onChange([...questions, withClientId(makeScreenerQuestion())]);

  const removeQuestion = (index: number) =>
    onChange(questions.filter((_question, i) => i !== index));

  const addOption = (qIndex: number) =>
    updateQuestion(qIndex, {
      options: [...questions[qIndex].options, makeScreenerOption(false)]
    });

  const removeOption = (qIndex: number, oIndex: number) =>
    updateQuestion(qIndex, {
      options: questions[qIndex].options.filter((_option, i) => i !== oIndex)
    });

  return (
    <div className="screener-questions">
      <ol className="screener-questions__list list-unstyled" aria-label="Screener questions">
        {questions.map((question, index) => {
          const promptId = `screener-question-prompt-${question._clientId}`;
          const promptError = errorFor(`screener_questions.${index}.prompt`);
          const optionsError = errorFor(`screener_questions.${index}.options`);
          const canRemoveOption =
            question.options.length > VALIDATION.SCREENER_MIN_OPTIONS;

          return (
            <li key={question._clientId} className="screener-card">
              <div className="screener-card__header">
                <span className="screener-card__num" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="screener-card__prompt">
                  <label htmlFor={promptId} className="form-label mb-1">
                    Question {index + 1}
                  </label>
                  <input
                    type="text"
                    id={promptId}
                    className={`form-control ${promptError ? 'is-invalid' : ''}`}
                    value={question.prompt}
                    placeholder="The question the participant sees"
                    onChange={(event) =>
                      updateQuestion(index, { prompt: event.target.value })
                    }
                    onBlur={() =>
                      onBlurField?.(`screener_questions.${index}.prompt`)
                    }
                  />
                  {promptError && <FieldError>{promptError}</FieldError>}
                </div>
                <button
                  type="button"
                  className="screener-card__remove"
                  onClick={() => removeQuestion(index)}
                  aria-label={`Remove question ${index + 1}`}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>

              <div className="screener-card__body">
                <span className="form-label mb-2 d-block">Answers</span>
                <ol className="screener-options list-unstyled" aria-label={`Answers to question ${index + 1}`}>
                  {question.options.map((option, oIndex) => {
                    const labelError = errorFor(
                      `screener_questions.${index}.options.${oIndex}.label`
                    );
                    return (
                      <li key={option.id} className="screener-option">
                        <div className="screener-option__row">
                          <input
                            type="text"
                            className={`form-control screener-option__label ${labelError ? 'is-invalid' : ''}`}
                            value={option.label}
                            placeholder="Answer"
                            aria-label={`Answer ${oIndex + 1}`}
                            onChange={(event) =>
                              updateOption(index, oIndex, {
                                label: event.target.value
                              })
                            }
                            onBlur={() =>
                              onBlurField?.(
                                `screener_questions.${index}.options.${oIndex}.label`
                              )
                            }
                          />
                          <div
                            className="screener-option__toggle btn-group"
                            role="group"
                            aria-label={`Answer ${oIndex + 1} eligibility`}
                          >
                            <button
                              type="button"
                              className={`btn btn-sm ${option.disqualifies ? 'btn-outline-secondary' : 'btn-success'}`}
                              aria-pressed={!option.disqualifies}
                              onClick={() =>
                                updateOption(index, oIndex, { disqualifies: false })
                              }
                            >
                              Qualify
                            </button>
                            <button
                              type="button"
                              className={`btn btn-sm ${option.disqualifies ? 'btn-danger' : 'btn-outline-secondary'}`}
                              aria-pressed={option.disqualifies}
                              onClick={() =>
                                updateOption(index, oIndex, { disqualifies: true })
                              }
                            >
                              Screen out
                            </button>
                          </div>
                          <button
                            type="button"
                            className="screener-option__remove"
                            onClick={() => removeOption(index, oIndex)}
                            disabled={!canRemoveOption}
                            aria-label={`Remove answer ${oIndex + 1}`}
                          >
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>
                        {labelError && <FieldError>{labelError}</FieldError>}
                      </li>
                    );
                  })}
                </ol>

                {optionsError && <FieldError>{optionsError}</FieldError>}

                {question.options.length < VALIDATION.SCREENER_MAX_OPTIONS && (
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm mt-2"
                    onClick={() => addOption(index)}
                  >
                    <Plus size={15} className="me-1" aria-hidden="true" />
                    Add answer
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {questions.length < VALIDATION.SCREENER_MAX_QUESTIONS && (
        <button
          type="button"
          className="btn btn-outline-primary"
          onClick={addQuestion}
        >
          <Plus size={16} className="me-1" aria-hidden="true" />
          Add question
        </button>
      )}
    </div>
  );
};

export default ScreenerQuestions;
