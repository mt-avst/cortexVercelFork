import React from 'react';

import { INLINE_STUDY_LIMITS } from '@shared/firsthand/inline-study';
import FieldError from './FieldError';

interface DurationEstimateProps {
  /** The form field this control writes, used for its id and its label. */
  field: string;
  /** Minutes the author has set by hand, when they have overridden. */
  value: number | undefined;
  /** Whether the automatic estimate is in force. */
  automatic: boolean;
  /** What the list is currently worth, or null when there is nothing to add up. */
  estimate: number | null;
  error?: string;
  /** "6 questions", "3 tasks" - what the estimate was derived from. */
  derivedFrom: string;
  onValueChange: (value: number | undefined) => void;
  onAutomaticChange: (automatic: boolean) => void;
  /** Revalidate this field on blur, by the same rules a save runs. */
  onBlur?: () => void;
}

/**
 * How long this takes, estimated for the author and overridable by them.
 *
 * The field was a bare number input labelled "How long it takes (optional)",
 * which produced two outcomes and no third: left empty, so the participant is
 * told nothing, or filled with a number chosen before the questions were
 * written and never revisited. Neither gets better as the list grows.
 *
 * So the estimate is the default and it moves with the list, the author can
 * take it over at any point, and taking it over and clearing it is still how
 * you say "do not tell them a length" - that was a real capability of the old
 * field and removing it would trade one wrong number for another.
 */
const DurationEstimate: React.FC<DurationEstimateProps> = ({
  field,
  value,
  automatic,
  estimate,
  error,
  derivedFrom,
  onValueChange,
  onAutomaticChange,
  onBlur
}) => (
  <div className="form-group mb-4">
    <label
      htmlFor={field}
      className="form-label mb-2"
      style={{ fontSize: '1rem', fontWeight: '600' }}
    >
      Estimated completion time
    </label>

    <div className="d-flex align-items-center gap-2">
      <input
        type="number"
        className={`form-control duration-estimate__field ${error ? 'is-invalid' : ''}`}
        id={field}
        min={1}
        max={INLINE_STUDY_LIMITS.maxDurationMinutes}
        style={{ maxWidth: '8rem' }}
        readOnly={automatic}
        aria-describedby={`${field}-help`}
        value={automatic ? (estimate ?? '') : (value ?? '')}
        onChange={(event) =>
          onValueChange(
            event.target.value === '' ? undefined : Number(event.target.value)
          )
        }
        onBlur={onBlur}
      />
      <span aria-hidden="true">minutes</span>
    </div>

    {error && (
      <FieldError>{error}</FieldError>
    )}

    <div className="form-text mt-1" id={`${field}-help`}>
      {automatic ? (
        <>
          {estimate === null ? (
            // Nothing to add up yet. "Automatically estimated from your 0
            // questions" reads as a broken sentence and describes a number that
            // is not there.
            <>There is nothing to estimate from yet. Add a question and this fills in.{' '}</>
          ) : (
            <>
              <span className="duration-estimate__value">Automatically estimated</span>{' '}
              from your {derivedFrom}, and it moves as you write. Shown to
              participants before they start.{' '}
            </>
          )}
          <button
            type="button"
            className="duration-estimate__toggle"
            onClick={() => {
              // Seeded with the estimate rather than emptied, so overriding
              // starts from the number the author was already being shown.
              onValueChange(estimate ?? undefined);
              onAutomaticChange(false);
            }}
          >
            Set it myself
          </button>
        </>
      ) : (
        <>
          Minutes. Shown to participants before they start. Leave it empty to
          tell them nothing, which is better than telling them the wrong thing.{' '}
          <button
            type="button"
            className="duration-estimate__toggle"
            onClick={() => onAutomaticChange(true)}
          >
            Use the automatic estimate
          </button>
        </>
      )}
    </div>
  </div>
);

export default DurationEstimate;
