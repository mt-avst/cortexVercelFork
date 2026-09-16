import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

import { useTheme } from '../contexts/ThemeContext';
import type { ParticipantScreener, ScreenerOutcome } from '@shared/types';

interface ScreenerCheckProps {
  /** The REDACTED screener - no `disqualifies` flags ever reach here. */
  screener: ParticipantScreener;
  /** Submits the answers and returns the server's auto-evaluated verdict. */
  onSubmit: (answers: Record<string, string>) => Promise<ScreenerOutcome>;
  /** Called once the participant qualifies, to resume what they were doing. */
  onQualified: () => void;
  /** Close without proceeding (Cancel, backdrop, or after a screen-out). */
  onClose: () => void;
}

const FALLBACK_SCREENED_OUT_MESSAGE =
  "Thanks for your interest. This study isn't a match for you this time. We run studies often, so keep an eye out for the next one.";

/**
 * The participant eligibility check (MR2).
 *
 * A screener gates every take-part path, so this is the one surface a
 * participant answers it on. It shows the REDACTED screener - the server strips
 * the owner-only `disqualifies` flag at the public serialiser, so a participant
 * cannot see which answer screens them out and game it - and submits their
 * choices for the server to evaluate. The verdict decides the rest: a qualify
 * resumes the pending action (booking, survey, recorded study or external
 * hand-off), a screen-out shows the researcher's not-a-match message and offers
 * a retake, because a screened-out participant can change their answer and try
 * again (latest answer wins, server side).
 *
 * A bespoke modal rather than `ConfirmationModal`: the footer is not a fixed
 * Cancel/Confirm pair - the primary control is disabled until every question is
 * answered, and it changes entirely between the answering and screened-out
 * states - which that component cannot express.
 */
const ScreenerCheck: React.FC<ScreenerCheckProps> = ({
  screener,
  onSubmit,
  onQualified,
  onClose
}) => {
  const { isDarkMode } = useTheme();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [screenedOut, setScreenedOut] = useState(false);
  const [error, setError] = useState('');

  const allAnswered = screener.questions.every((question) =>
    Boolean(answers[question.id])
  );

  const check = async () => {
    if (!allAnswered || submitting) {
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const outcome = await onSubmit(answers);
      if (outcome === 'qualified') {
        onQualified();
      } else {
        setScreenedOut(true);
      }
    } catch {
      setError('Could not check your answers. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const retake = () => {
    setScreenedOut(false);
    setAnswers({});
    setError('');
  };

  /**
   * Focus trap and initial focus, matching ConfirmationModal.
   *
   * A bespoke `aria-modal` dialog owns its own keyboard containment: without
   * this, Tab escapes to the page behind the backdrop and focus never enters the
   * dialog on open. Re-run when the view flips between answering and screened-out
   * so the trap tracks the controls that are actually on screen.
   */
  useEffect(() => {
    const modal = document.querySelector('[data-testid="screener-check"]');
    if (!modal) return;

    const focusable = modal.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || focusable.length === 0) return;
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
      } else if (document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    modal.addEventListener('keydown', onKeyDown as EventListener);
    return () => modal.removeEventListener('keydown', onKeyDown as EventListener);
  }, [screenedOut]);

  const modalContentStyle: React.CSSProperties = isDarkMode
    ? {
        backgroundColor: 'rgba(10, 9, 26, 0.95)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        borderRadius: '16px'
      }
    : {
        backgroundColor: '#FFFFFF',
        border: '1px solid rgba(0, 0, 0, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.15)',
        borderRadius: '16px'
      };

  const borderColor = isDarkMode
    ? 'rgba(255, 255, 255, 0.1)'
    : 'rgba(0, 0, 0, 0.1)';
  const titleColor = isDarkMode ? '#FFFFFF' : '#1A1A1A';
  const bodyColor = isDarkMode ? 'rgba(255, 255, 255, 0.85)' : '#374151';

  const cancelBtnStyle: React.CSSProperties = isDarkMode
    ? {
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        borderColor: 'rgba(255, 255, 255, 0.2)',
        color: '#FFFFFF'
      }
    : {
        backgroundColor: 'rgba(0, 0, 0, 0.05)',
        borderColor: 'rgba(0, 0, 0, 0.15)',
        color: '#374151'
      };

  const handleBackdropClick = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const modal = (
    <div
      className="modal show d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="screener-check-title"
      data-testid="screener-check"
      tabIndex={-1}
      style={{
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 1050,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      onClick={handleBackdropClick}
    >
      <div
        className="modal-dialog modal-dialog-centered"
        style={{ margin: 'auto', maxWidth: '560px', width: '100%' }}
      >
        <div className="modal-content" style={modalContentStyle}>
          <div
            className="modal-header border-0"
            style={{ borderBottom: `1px solid ${borderColor}` }}
          >
            <h5 className="modal-title" id="screener-check-title" style={{ color: titleColor }}>
              {screenedOut ? 'Not a match this time' : 'Check this study is a fit'}
            </h5>
            <button
              type="button"
              className={`btn-close ${isDarkMode ? 'btn-close-white' : ''}`}
              onClick={onClose}
              aria-label="Close"
            />
          </div>

          <div
            className="modal-body"
            style={{ color: bodyColor, maxHeight: '60vh', overflowY: 'auto' }}
          >
            {screenedOut ? (
              <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                {screener.screenedOutMessage?.trim() || FALLBACK_SCREENED_OUT_MESSAGE}
              </p>
            ) : (
              <>
                <p className="mb-3" style={{ fontSize: '0.95rem' }}>
                  Answer these once. If you are a match you can go straight on.
                </p>
                {screener.questions.map((question, index) => (
                  <fieldset key={question.id} className="mb-4">
                    <legend
                      className="mb-2"
                      style={{ fontSize: '1rem', fontWeight: 600, float: 'none' }}
                    >
                      <span className="text-muted me-2" style={{ fontWeight: 400 }}>
                        Q{index + 1}
                      </span>
                      {question.prompt}
                    </legend>
                    {question.options.map((option) => {
                      const inputId = `screener-${question.id}-${option.id}`;
                      return (
                        <div className="form-check mb-2" key={option.id}>
                          <input
                            className="form-check-input"
                            type="radio"
                            name={question.id}
                            id={inputId}
                            value={option.id}
                            checked={answers[question.id] === option.id}
                            onChange={() =>
                              setAnswers((previous) => ({
                                ...previous,
                                [question.id]: option.id
                              }))
                            }
                          />
                          <label className="form-check-label" htmlFor={inputId}>
                            {option.label}
                          </label>
                        </div>
                      );
                    })}
                  </fieldset>
                ))}
                {error && (
                  <div
                    className="validation-error field-error"
                    role="alert"
                    style={{ color: isDarkMode ? '#f8b4b4' : '#DC2626' }}
                  >
                    <AlertTriangle size={15} aria-hidden="true" className="me-1" />
                    <span>{error}</span>
                  </div>
                )}
              </>
            )}
          </div>

          <div
            className="modal-footer border-0"
            style={{ borderTop: `1px solid ${borderColor}` }}
          >
            {screenedOut ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={cancelBtnStyle}
                  onClick={onClose}
                >
                  Close
                </button>
                <button type="button" className="btn btn-primary" onClick={retake}>
                  Change my answers
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={cancelBtnStyle}
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={check}
                  disabled={!allAnswered || submitting}
                >
                  {submitting ? 'Checking…' : 'Check eligibility'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};

export default ScreenerCheck;
