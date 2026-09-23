import React, { useSyncExternalStore } from 'react';
import { Undo2, X } from 'lucide-react';

/**
 * The Close study notices on the Admin Research Studies table, rendered IN
 * PLACE: each is a full-width table row directly under the study it is about
 * (Admin.tsx), so the user's place on the page and their pointer stay where
 * they were. State and focus live in `hooks/useCloseStudyUndo.ts`.
 */

/**
 * The band where the table drops its Created column (`_components.css`,
 * search "1024-1279.98px: still the table, minus Created"). Keep in step.
 */
const CREATED_HIDDEN_QUERY = '(min-width: 1024px) and (max-width: 1279.98px)';

// matchMedia is absent outside a browser (jsdom): read that as the full grid.
const hasMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

const subscribe = (onChange: () => void) => {
  if (!hasMatchMedia()) return () => undefined;
  const query = window.matchMedia(CREATED_HIDDEN_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/**
 * How many columns the notice must span: exactly the columns on screen. A
 * span wider than the grid (6 while Created is hidden) makes the fixed-layout
 * table add a phantom column, which squeezed every row at 1024-1279px.
 */
const useNoticeColSpan = (): number =>
  useSyncExternalStore(
    subscribe,
    () => (hasMatchMedia() && window.matchMedia(CREATED_HIDDEN_QUERY).matches ? 5 : 6),
    () => 6
  );

interface ClosedNoticeRowProps {
  /** The study the notice is about: `data-notice-for`, which the page reads
   * to find the rows around the notice's slot (Admin.tsx captureNeighbours). */
  studyId: string;
  title: string;
  undoing: boolean;
  onUndo: () => void;
  undoButtonRef: React.Ref<HTMLButtonElement>;
}

export const ClosedStudyNoticeRow: React.FC<ClosedNoticeRowProps> = ({ studyId, title, undoing, onUndo, undoButtonRef }) => {
  const colSpan = useNoticeColSpan();
  return (
  <tr className="admin-inline-notice-row" data-notice-for={studyId}>
    <td colSpan={colSpan} className="admin-inline-notice-cell">
      <div className="admin-row-notice admin-undo-notice" role="status">
        <span className="admin-row-notice__text">Closed “{title}”</span>
        <button
          ref={undoButtonRef}
          type="button"
          className="btn btn-sm btn-outline-secondary admin-row-notice__action"
          onClick={onUndo}
          disabled={undoing}
        >
          <Undo2 size={14} aria-hidden="true" />
          Undo
        </button>
      </div>
    </td>
  </tr>
  );
};

interface ErrorRowProps {
  studyId: string;
  message: string;
  onDismiss: () => void;
  errorRef: React.Ref<HTMLDivElement>;
}

export const StudyActionErrorRow: React.FC<ErrorRowProps> = ({ studyId, message, onDismiss, errorRef }) => {
  const colSpan = useNoticeColSpan();
  return (
  <tr className="admin-inline-notice-row" data-notice-for={studyId}>
    <td colSpan={colSpan} className="admin-inline-notice-cell">
      <div ref={errorRef} tabIndex={-1} className="admin-row-notice admin-action-error" role="alert">
        <span className="admin-row-notice__text">{message}</span>
        <button
          type="button"
          className="btn btn-sm btn-link admin-row-notice__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </td>
  </tr>
  );
};

interface CopyNoticeRowProps {
  message: string;
  /** 'status': the copy was made. 'error': it was made, but the list could
   * not be refreshed to show it - with a Retry. */
  tone: 'status' | 'error';
  onRetry?: () => void;
  onDismiss: () => void;
  actionRef?: React.Ref<HTMLButtonElement>;
}

/**
 * Copy's outcome, in place under the study that was copied. Announced before
 * the list refreshes, so a copy is never made in silence - and if the refresh
 * fails, the list on screen stays and this says so, rather than the table
 * being replaced by the load-failure state.
 */
export const CopyNoticeRow: React.FC<CopyNoticeRowProps> = ({ message, tone, onRetry, onDismiss, actionRef }) => {
  const colSpan = useNoticeColSpan();
  return (
  <tr className="admin-inline-notice-row">
    <td colSpan={colSpan} className="admin-inline-notice-cell">
      <div
        className={`admin-row-notice admin-copy-notice${tone === 'error' ? ' admin-action-error' : ''}`}
        role={tone === 'error' ? 'alert' : 'status'}
      >
        <span className="admin-row-notice__text">{message}</span>
        {tone === 'error' && onRetry && (
          <button
            ref={actionRef}
            type="button"
            className="btn btn-sm btn-outline-secondary admin-row-notice__action"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-link admin-row-notice__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </td>
  </tr>
  );
};
