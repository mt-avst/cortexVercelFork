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

/**
 * below 1024px each row is one grid/flex item (a single
 * card, `tr.admin-row-clickable`) - at 800-1023.98px specifically, one CELL
 * of the Research Studies list's row-major two-column grid. A notice
 * rendered as a SIBLING `<tr>` is a second grid item, and inserting or
 * removing one shifts every later item's column/row the same way an earlier
 * `column-count` layout did - the bug the grid replaced it to fix, in a
 * different primitive's clothing. So below 1024px a notice renders `compact`:
 * a `<td className="col-notice">` with no wrapping `<tr>` or `colSpan` (no
 * columns to span - the row is already stacked, not a grid of cells), placed
 * INSIDE the study's own `<tr>` as an extra flex child (Admin.tsx), so the
 * card simply grows by one line and no other item moves. >=1024px keeps the
 * original `<tr>` sibling, which IS how the desktop table draws a full-width
 * banner row under a `<tr>` in a real table layout.
 */
interface ClosedNoticeRowProps {
  /** The study the notice is about: `data-notice-for`, which the page reads
   * to find the rows around the notice's slot (Admin.tsx captureNeighbours). */
  studyId: string;
  title: string;
  undoing: boolean;
  onUndo: () => void;
  undoButtonRef: React.Ref<HTMLButtonElement>;
  compact?: boolean;
}

const UndoNoticeBody: React.FC<Pick<ClosedNoticeRowProps, 'title' | 'undoing' | 'onUndo' | 'undoButtonRef'>> = ({
  title, undoing, onUndo, undoButtonRef,
}) => (
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
);

export const ClosedStudyNoticeRow: React.FC<ClosedNoticeRowProps> = ({ studyId, title, undoing, onUndo, undoButtonRef, compact }) => {
  const colSpan = useNoticeColSpan();
  if (compact) {
    return (
      <td className="col-notice" data-notice-for={studyId}>
        <UndoNoticeBody title={title} undoing={undoing} onUndo={onUndo} undoButtonRef={undoButtonRef} />
      </td>
    );
  }
  return (
  <tr className="admin-inline-notice-row" data-notice-for={studyId}>
    <td colSpan={colSpan} className="admin-inline-notice-cell">
      <UndoNoticeBody title={title} undoing={undoing} onUndo={onUndo} undoButtonRef={undoButtonRef} />
    </td>
  </tr>
  );
};

interface ErrorRowProps {
  studyId: string;
  message: string;
  onDismiss: () => void;
  errorRef: React.Ref<HTMLDivElement>;
  compact?: boolean;
}

const ErrorNoticeBody: React.FC<Pick<ErrorRowProps, 'message' | 'onDismiss' | 'errorRef'>> = ({
  message, onDismiss, errorRef,
}) => (
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
);

export const StudyActionErrorRow: React.FC<ErrorRowProps> = ({ studyId, message, onDismiss, errorRef, compact }) => {
  const colSpan = useNoticeColSpan();
  if (compact) {
    return (
      <td className="col-notice" data-notice-for={studyId}>
        <ErrorNoticeBody message={message} onDismiss={onDismiss} errorRef={errorRef} />
      </td>
    );
  }
  return (
  <tr className="admin-inline-notice-row" data-notice-for={studyId}>
    <td colSpan={colSpan} className="admin-inline-notice-cell">
      <ErrorNoticeBody message={message} onDismiss={onDismiss} errorRef={errorRef} />
    </td>
  </tr>
  );
};

interface CopyNoticeRowProps {
  /** The study the notice is about: `data-notice-for`, which the page reads
   * to find the rows around the notice's slot (Admin.tsx captureNeighbours).
   * Optional because Copy's own notice (unlike Reopen's) never needs the
   * neighbour hand-off - Copy always leaves focus where it was, never on the
   * notice itself. */
  studyId?: string;
  message: string;
  /** 'status': the copy was made. 'error': it was made, but the list could
   * not be refreshed to show it - with a Retry. 'warning':
   * the copy was made, but something about IT needs the reader's attention
   * (cto/AdaptaLabs#161's empty-questions fallback) - shown next to the row,
   * not the page-top banner it used to run through, and never auto-dismissed
   * (a warning the reader has not acted on yet must not vanish on its own). */
  tone: 'status' | 'error' | 'warning';
  onRetry?: () => void;
  onDismiss: () => void;
  actionRef?: React.Ref<HTMLButtonElement>;
  compact?: boolean;
}

const CopyNoticeBody: React.FC<Omit<CopyNoticeRowProps, 'compact'>> = ({ message, tone, onRetry, onDismiss, actionRef }) => {
  const toneClass = tone === 'error' ? ' admin-action-error' : tone === 'warning' ? ' admin-row-notice--warning' : '';
  return (
    <div
      className={`admin-row-notice admin-copy-notice${toneClass}`}
      role={tone === 'status' ? 'status' : 'alert'}
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
  );
};

/**
 * Copy's outcome, in place under the study that was copied. Announced before
 * the list refreshes, so a copy is never made in silence - and if the refresh
 * fails, the list on screen stays and this says so, rather than the table
 * being replaced by the load-failure state.
 */
export const CopyNoticeRow: React.FC<CopyNoticeRowProps> = ({ studyId, message, tone, onRetry, onDismiss, actionRef, compact }) => {
  const colSpan = useNoticeColSpan();
  if (compact) {
    return (
      <td className="col-notice" data-notice-for={studyId}>
        <CopyNoticeBody message={message} tone={tone} onRetry={onRetry} onDismiss={onDismiss} actionRef={actionRef} />
      </td>
    );
  }
  return (
  <tr className="admin-inline-notice-row" data-notice-for={studyId}>
    <td colSpan={colSpan} className="admin-inline-notice-cell">
      <CopyNoticeBody message={message} tone={tone} onRetry={onRetry} onDismiss={onDismiss} actionRef={actionRef} />
    </td>
  </tr>
  );
};
