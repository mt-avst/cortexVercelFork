import React from 'react';
import { Info, Plus } from 'lucide-react';

import { VALIDATION } from '@shared/constants';
import type { ScreenerQuestion } from '@shared/types';

import type { WithClientId } from '../../lib/opportunity-authoring/client-ids';
import ScreenerQuestions from './ScreenerQuestions';
import FieldError from './FieldError';

interface ScreenerStepProps {
  /** Whether this opportunity carries a screener at all. */
  hasScreener: boolean;
  questions: WithClientId<ScreenerQuestion>[];
  /** The optional message shown to anyone screened out. */
  message: string;
  /** Keyed `screener_questions[.*]` and `screener_message`. */
  validationErrors: Record<string, string>;
  /** Turn a screener on, seeding a first question. */
  onEnable: () => void;
  /** Remove the screener entirely. */
  onRemove: () => void;
  onQuestionsChange: (next: WithClientId<ScreenerQuestion>[]) => void;
  onMessageChange: (value: string) => void;
  /** Revalidate one field on blur, by its full error key. */
  onBlurField?: (errorKey: string) => void;
}

const MESSAGE_FIELD_ID = 'screener_message';

/**
 * The screener step: an eligibility gate a researcher opts into.
 *
 * A screener is OPTIONAL and off by default - most studies want everyone signed
 * in - so the step leads with a gate rather than an empty builder, the same
 * shape the wireframe signed off. Turning it on seeds one question; removing it
 * takes the whole thing away, and the save then sends no screener at all rather
 * than an empty one (a screener that exists always gates, which is the property
 * the participant check and the three backend chokepoints rely on).
 *
 * Explicit props rather than a `formData` blob, matching `ConsentStep`: the step
 * reads exactly what it needs, and the parent owns the state.
 */
const ScreenerStep: React.FC<ScreenerStepProps> = ({
  hasScreener,
  questions,
  message,
  validationErrors,
  onEnable,
  onRemove,
  onQuestionsChange,
  onMessageChange,
  onBlurField
}) => {
  const questionsError = validationErrors.screener_questions;
  const messageError = validationErrors.screener_message;

  const heading = (
    <div className="mb-4">
      <h2
        id="screener_questions-heading"
        tabIndex={-1}
        className="h4 mb-1 section-title"
        style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: 600 }}
      >
        Screener
      </h2>
      <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
        Ask a few questions before the study starts, and only let the right
        people through. Every answer is flagged qualify or screen out, and the
        result is decided automatically.
      </p>
    </div>
  );

  if (!hasScreener) {
    return (
      <div className="form-section mb-5" data-testid="screener-step">
        {heading}
        <div className="alert alert-secondary" role="status">
          <p className="mb-2">
            <strong>No screener on this study.</strong> Anyone signed in can
            start it. Add a screener to ask a few questions first and only let
            the right people through.
          </p>
          <button
            type="button"
            className="btn btn-outline-primary"
            onClick={onEnable}
          >
            <Plus size={16} className="me-1" aria-hidden="true" />
            Add a screener
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="form-section mb-5" data-testid="screener-step">
      {heading}

      <div className="alert alert-info d-flex gap-2" role="status">
        <Info size={18} className="flex-shrink-0 mt-1" aria-hidden="true" />
        <span style={{ fontSize: '0.9rem' }}>
          Each answer is flagged <strong>Qualify</strong> or{' '}
          <strong>Screen out</strong>. A person qualifies only if every answer
          they pick is a Qualify. One screen-out answer ends it, politely, with
          no booking.
        </span>
      </div>

      {questionsError && <FieldError>{questionsError}</FieldError>}

      <ScreenerQuestions
        questions={questions}
        onChange={onQuestionsChange}
        validationErrors={validationErrors}
        onBlurField={onBlurField}
      />

      <div className="form-group mt-4">
        <label
          htmlFor={MESSAGE_FIELD_ID}
          className="form-label mb-1"
          style={{ fontSize: '1rem', fontWeight: 600 }}
        >
          Message when someone is not a match
        </label>
        <p className="form-text mt-0 mb-2" style={{ fontSize: '0.875rem' }}>
          Shown instead of booking to anyone screened out. A neutral fallback is
          used if you leave it blank.
        </p>
        <textarea
          id={MESSAGE_FIELD_ID}
          className={`form-control ${messageError ? 'is-invalid' : ''}`}
          rows={3}
          maxLength={VALIDATION.SCREENER_MAX_MESSAGE_CHARS}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          onBlur={() => onBlurField?.(MESSAGE_FIELD_ID)}
        />
        {messageError && <FieldError>{messageError}</FieldError>}
      </div>

      <button
        type="button"
        className="btn btn-link text-danger p-0 mt-3"
        onClick={onRemove}
      >
        Remove screener
      </button>
    </div>
  );
};

export default ScreenerStep;
