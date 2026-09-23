import { useCallback, useEffect, useRef, useState } from 'react';
import { updateOpportunity } from '../api/client';
import type { Opportunity } from '../api/types';
import { logger } from '../utils/logger';

/**
 * How long a closed study's Undo stays on offer. The same eight seconds as a
 * removed session slot's undo (AdminSessionManager's REMOVAL_UNDO_MS): long
 * enough to be genuinely reachable by keyboard and screen reader.
 */
export const CLOSE_UNDO_MS = 8000;

/** A study just closed from its row menu, while its Undo is on offer. */
export interface ClosedStudyNotice {
  id: string;
  title: string;
  /** The study as it was before the close. The table SORTS on this while the
   * notice is up, so the row keeps its place under the pointer; filters,
   * counts and Needs attention read the live study throughout. */
  snapshot: Opportunity;
}

/** A row action the server refused (Close, Undo, Copy). It freezes nothing:
 * the row sorts and filters live. */
export interface StudyActionError {
  id: string;
  title: string;
  message: string;
  /** Set for a refused Undo: the study as it was before its close. The error
   * is drawn in the notice's old slot (sorted on this), not under the row,
   * which has moved to its live place - so a failed Undo never scrolls the
   * page. The message names the study, so it reads on its own. Absent for a
   * refused Close or Copy, whose error sits under the row itself. */
  anchor?: Opportunity;
}

type FocusRequest = { target: 'undo' | 'error' | 'study'; id: string; near: string[]; seq: number };

interface Options {
  /** Apply a status change the server accepted to the loaded list. */
  onStatusChanged: (id: string, status: 'published' | 'closed') => void;
  /** Focus whatever represents study `id` on the page (its title link), with
   * the caller's own fallbacks when that row is no longer shown. It must not
   * scroll the page (`preventScroll`): the lapse calls it just before the row
   * re-sorts, and focus following the row must not drag the page with it.
   * `near` lists the studies that sat at the notice's slot (the next row,
   * then the previous one): where focus goes instead when the study's own
   * link has moved out of view, so the next Tab does not jump the page. */
  focusStudy: (id: string, near?: string[]) => void;
  /** The studies around study `id`'s notice or error slot, read from the
   * page BEFORE a re-sort: the next row's, then the previous row's. */
  captureNeighbours?: (id: string) => string[];
}

/** The server's own reason from a failed request, if it gave one. */
const serverReason = (error: unknown): string | null => {
  const data = (error as { response?: { data?: { error?: unknown; message?: unknown } } }).response?.data;
  const reason = data?.error ?? data?.message;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
};

export const failureMessage = (verb: 'close' | 'reopen' | 'copy', title: string, error: unknown): string => {
  const reason = serverReason(error);
  return reason
    ? `Could not ${verb} “${title}”: ${reason}`
    : `Could not ${verb} “${title}”. Please try again.`;
};

/** Focus without scrolling the page, then bring it into view only if it is
 * not already - so an in-place notice never jumps the page. */
const focusInPlace = (el: HTMLElement | null) => {
  if (!el) return;
  el.focus({ preventScroll: true });
  const rect = el.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) el.scrollIntoView?.({ block: 'nearest' });
};

/**
 * Close study with Undo, for the Admin Research Studies table (Petra 3.4).
 *
 * The removed-slot pattern from AdminSessionManager: a `role="status"` notice
 * whose Undo takes focus, gone after CLOSE_UNDO_MS. Unlike a slot removal the
 * close is committed on the server at once; Undo is a second PATCH back to
 * published, which the publish guard may refuse.
 *
 * ONE notice slot, deliberately: closing a second study replaces the first
 * study's notice (its close is already committed, so nothing is lost, and two
 * live timers with two Undo buttons is a harder page to operate than one).
 * Everything else is keyed by study id, so a late answer about one study
 * never clears or steals focus from another's notice.
 */
/** Whether an element is on screen. An element with no box at all (not laid
 * out, e.g. in a test DOM) counts as on screen: nothing says otherwise. */
export const isInViewport = (el: Element): boolean => {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  return rect.bottom > 0 && rect.top < window.innerHeight;
};

/** Runs `fn` two frames from now (after the re-sort has been laid out). */
const afterLayout = (fn: () => void) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  } else {
    setTimeout(fn, 32);
  }
};

export function useCloseStudyUndo({ onStatusChanged, focusStudy, captureNeighbours }: Options) {
  const [notice, setNotice] = useState<ClosedStudyNotice | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<StudyActionError | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  // True from a focus hand-off that coincides with a re-sort (a lapse with
  // focus on Undo, a refused Undo, Dismiss) until that re-sort is laid out.
  const [handoff, setHandoff] = useState(false);

  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Closes whose PATCH has not answered yet: a second Close of the same study
  // is ignored, and the table ignores row and button clicks meanwhile.
  const closingRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  // Mirrors, read by timers and settled requests scheduled on earlier renders.
  const noticeRef = useRef<ClosedStudyNotice | null>(null);
  const errorStateRef = useRef<StudyActionError | null>(null);
  const undoingRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);
  useEffect(() => {
    errorStateRef.current = actionError;
  }, [actionError]);

  const requestFocus = useCallback((target: FocusRequest['target'], id: string, near: string[] = []) => {
    seqRef.current += 1;
    setFocusRequest({ target, id, near, seq: seqRef.current });
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** The notice for `id` has run its course. */
  const lapse = useCallback((id: string) => {
    timerRef.current = null;
    const undoHadFocus = document.activeElement === undoButtonRef.current;
    const isCurrent = noticeRef.current?.id === id;
    // Hand focus to the study rather than dropping it on <body> - but only if
    // Undo still held it, and this is still the notice on screen. BEFORE the
    // notice goes: removing it releases the row to its sorted place, and focus
    // must already be on the row (without scrolling) when it moves. The
    // request re-asserts it after the re-render, in case the move blurred it.
    if (undoHadFocus && isCurrent) {
      // Only a reader still AT the notice has a place to keep: then the table
      // opts out of scroll anchoring through the re-sort. One who has scrolled
      // on is reading something else, and anchoring keeps that card still.
      const readerAtNotice = undoButtonRef.current ? isInViewport(undoButtonRef.current) : false;
      const near = captureNeighbours?.(id) ?? [];
      focusStudy(id, near);
      requestFocus('study', id, near);
      if (readerAtNotice) setHandoff(true);
    }
    setNotice((current) => (current?.id === id ? null : current));
  }, [captureNeighbours, focusStudy, requestFocus]);

  const closeStudy = useCallback(async (study: Opportunity) => {
    const { id, title } = study;
    if (closingRef.current.has(id)) return;
    closingRef.current.add(id);
    setActionError((current) => (current?.id === id ? null : current));
    try {
      await updateOpportunity(id, { status: 'closed' });
    } catch (error: unknown) {
      logger.error('Failed to close research study', {
        component: 'Admin',
        opportunityId: id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (mountedRef.current) {
        setActionError({ id, title, message: failureMessage('close', title, error) });
        requestFocus('error', id);
      }
      return;
    } finally {
      closingRef.current.delete(id);
    }
    if (!mountedRef.current) return;
    onStatusChanged(id, 'closed');
    clearTimer();
    setNotice({ id, title, snapshot: study });
    timerRef.current = setTimeout(() => lapse(id), CLOSE_UNDO_MS);
    requestFocus('undo', id);
  }, [clearTimer, lapse, onStatusChanged, requestFocus]);

  const undo = useCallback(async () => {
    const current = noticeRef.current;
    if (!current || undoingRef.current) return;
    const { id, title, snapshot } = current;
    clearTimer();
    undoingRef.current = id;
    setUndoingId(id);
    try {
      await updateOpportunity(id, { status: 'published' });
      if (!mountedRef.current) return;
      onStatusChanged(id, 'published');
      const newer = noticeRef.current !== null && noticeRef.current.id !== id;
      setNotice((n) => (n?.id === id ? null : n));
      if (!newer) requestFocus('study', id);
    } catch (error: unknown) {
      // Reopening runs the publish guard: a broken study, or a moderated one
      // with no future slot, is refused with a reason. The row stays closed,
      // which is the truth, and the reason is shown as the server gave it.
      logger.warn('Failed to reopen research study', {
        component: 'Admin',
        opportunityId: id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (!mountedRef.current) return;
      const newer = noticeRef.current !== null && noticeRef.current.id !== id;
      setNotice((n) => (n?.id === id ? null : n));
      setActionError({ id, title, message: failureMessage('reopen', title, error), anchor: snapshot });
      // The scroll hold is released by the focus hand-off, so it is only
      // taken when a hand-off is requested; a refusal behind a newer notice
      // leaves focus where it is and must not hold anchoring off with it.
      if (!newer) {
        requestFocus('error', id);
        setHandoff(true);
      }
    } finally {
      undoingRef.current = null;
      if (mountedRef.current) {
        setUndoingId((u) => (u === id ? null : u));
        // A newer notice appeared while this Undo was in flight, and its Undo
        // was disabled then, so focus could not land on it: land it now.
        const newer = noticeRef.current;
        if (newer && newer.id !== id && (document.activeElement === document.body || !document.activeElement)) {
          requestFocus('undo', newer.id);
        }
      }
    }
  }, [clearTimer, onStatusChanged, requestFocus]);

  /** Show a refused row action (e.g. Copy) under its study's row. */
  const showRowError = useCallback((study: Opportunity, message: string) => {
    if (!mountedRef.current) return;
    setActionError({ id: study.id, title: study.title, message });
    requestFocus('error', study.id);
  }, [requestFocus]);

  const dismissError = useCallback(() => {
    const current = errorStateRef.current;
    const near = current ? captureNeighbours?.(current.id) ?? [] : [];
    setActionError(null);
    if (current) {
      requestFocus('study', current.id, near);
      setHandoff(true);
    }
  }, [captureNeighbours, requestFocus]);

  // Focus moves after the render that put its target on the page.
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.target === 'undo') focusInPlace(undoButtonRef.current);
    else if (focusRequest.target === 'error') focusInPlace(errorRef.current);
    else focusStudy(focusRequest.id, focusRequest.near);
    // The re-sort this focus accompanied is laid out now; let the table
    // anchor its scroll again once it has settled.
    afterLayout(() => {
      if (mountedRef.current) setHandoff(false);
    });
  }, [focusRequest, focusStudy]);

  // Cleared on unmount only - never from an effect that re-runs, which would
  // cancel a live notice's timer on an unrelated render. The body re-marks
  // the hook mounted, because StrictMode runs this cleanup once on a page
  // that then stays.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  /** The pre-close study whose sort position is held, while its Undo is up. */
  const frozenSnapshot = notice?.snapshot ?? null;

  const isCloseInFlight = useCallback(() => closingRef.current.size > 0, []);

  /**
   * Whether the table should opt out of scroll anchoring right now: while a
   * notice is up, and through a focus hand-off's re-sort. Only then - with
   * anchoring off always, a reader who had scrolled on had the card they were
   * reading jump when a notice they had left behind lapsed.
   */
  const holdScroll = notice !== null || handoff;

  return {
    notice,
    undoingId,
    actionError,
    frozenSnapshot,
    closeStudy,
    undo,
    showRowError,
    dismissError,
    isCloseInFlight,
    holdScroll,
    undoButtonRef,
    errorRef,
  };
}
