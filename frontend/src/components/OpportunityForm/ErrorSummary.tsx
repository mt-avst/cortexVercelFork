import React, { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

import type { ErrorSummaryEntry } from '../../lib/opportunity-authoring/error-summary';

interface ErrorSummaryProps {
  entries: ErrorSummaryEntry[];
  /**
   * Bumped by every refusal, including a repeat one for the same fields.
   *
   * Without it a second refusal over the same errors changes nothing in the
   * DOM, so focus never moves and a screen reader says nothing: the author is
   * told, in silence, that pressing the button did nothing.
   */
  refusalCount: number;
  /** Open the step holding the control, and put focus on it. */
  onSelect: (stepId: number, controlId?: string) => void;
}

/**
 * What is wrong, in one list, with a way into each of them.
 *
 * This replaced a single sentence of field labels with no links, no focus move
 * and no route to the field: "Please fix these fields: Title, Consent text",
 * rendered on a step that usually holds neither of them.
 *
 * The container takes focus when it appears. That is the whole accessibility
 * argument for the pattern - a refusal that only paints something above the
 * fold is invisible to anyone not looking there, and the author's focus is
 * still on a button they have just been told did nothing.
 */
export const ErrorSummary = ({ entries, refusalCount, onSelect }: ErrorSummaryProps) => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (entries.length === 0) {
      return;
    }
    const node = container.current;
    if (!node) {
      return;
    }
    node.focus();
    // jsdom implements neither, and the guard is what keeps this testable
    // without a browser - the same shape `pendingFocusFieldId` uses.
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    // `refusalCount` rather than `entries`: the array is rebuilt on every
    // render, so depending on it would drag focus back here while the author
    // was typing into the field it sent them to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusalCount]);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div
      ref={container}
      className="alert alert-danger mx-4 mt-4 mb-0 error-summary"
      role="alert"
      tabIndex={-1}
      aria-labelledby="error-summary-heading"
    >
      <h2 id="error-summary-heading" className="error-summary__heading h6 mb-2 d-flex align-items-center gap-2">
        <AlertTriangle size={18} aria-hidden="true" />
        {entries.length === 1
          ? 'There is a problem'
          : `There are ${entries.length} problems`}
      </h2>
      <ul className="error-summary__list mb-0">
        {entries.map((entry) => (
          <li key={entry.key} data-field={entry.key}>
            <button
              type="button"
              className="error-summary__link"
              onClick={() => onSelect(entry.stepId, entry.controlId)}
            >
              {entry.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default ErrorSummary;
