import { useCallback, useRef, useState } from "react";

import { isSafeTargetUrl } from "../../shared/firsthand/url-safety";

export type TaskWindowStatus = "idle" | "open" | "blocked";

export type TaskWindowState = {
  status: TaskWindowStatus;
  // The URL currently loaded in the task window. Lets a later task reuse the
  // same window when it targets the same page, and reopen only when it does
  // not.
  openedUrl: string | null;
};

// A named window so a second open() reuses the same OS window rather than
// spawning another. "popup" forces a separate window (not a tab): a window is
// easier to recognise in the share picker, easier to place beside this page,
// and - unlike a shared tab - keeps capturing when the product opens its own
// child popups mid-task.
const TASK_WINDOW_NAME = "firsthand-task";
const TASK_WINDOW_FEATURES = "popup,width=1280,height=900";

const initialState: TaskWindowState = { status: "idle", openedUrl: null };

/**
 * Owns the separate window the participant records during a recorded study.
 *
 * The window must exist before getDisplayMedia is called, or it cannot appear
 * in the browser's share picker - that ordering is the whole point of opening
 * it here rather than inside the runner. The handle is kept so the window can
 * be focused (brought back in front of this page) and reused across tasks.
 */
export function useTaskWindow() {
  const windowRef = useRef<Window | null>(null);
  const [state, setState] = useState<TaskWindowState>(initialState);

  const isOpen = useCallback(() => {
    const win = windowRef.current;

    return Boolean(win && !win.closed);
  }, []);

  const openTaskWindow = useCallback((url: string): boolean => {
    // Never navigate the same-origin popup to an unsafe URL: location.href on
    // an about:blank window runs javascript: (and other active schemes) in this
    // app's origin. The contract rejects these at ingestion; this is the
    // second line, so the sink never trusts its input.
    if (!isSafeTargetUrl(url)) {
      setState({ status: "blocked", openedUrl: null });

      return false;
    }

    const existing = windowRef.current;

    // Same window, same page: just bring it to the front. Never spawn a
    // second copy of a page the participant already has open.
    if (existing && !existing.closed && state.openedUrl === url) {
      existing.focus();

      return true;
    }

    // Open a blank same-origin window first, sever its back-reference to this
    // page (reverse-tabnabbing mitigation - the target is researcher-supplied,
    // not necessarily trusted), then navigate it. Opening blank keeps the
    // handle we need for focus() and for telling a pop-up block (null return)
    // apart from a real window; noopener would null the handle and defeat both.
    const win = window.open("", TASK_WINDOW_NAME, TASK_WINDOW_FEATURES);

    if (!win) {
      setState({ status: "blocked", openedUrl: null });

      return false;
    }

    try {
      win.opener = null;
    } catch {
      // A few engines disallow writing opener; acceptable for a configured
      // study target, and the handle we hold is unaffected.
    }

    win.location.href = url;
    win.focus();
    windowRef.current = win;
    setState({ status: "open", openedUrl: url });

    return true;
  }, [state.openedUrl]);

  return { state, isOpen, openTaskWindow };
}
