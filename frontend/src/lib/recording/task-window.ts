import { useCallback, useEffect, useRef, useState } from "react";

import { isSafeTargetUrl } from "@shared/firsthand/url-safety";
import { isTaskPipSupported } from "./task-pip";

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
//
// The name is unique PER PAGE LOAD: window.open with the name of a window
// that already exists returns that window and silently IGNORES the requested
// features, so a task window surviving from an earlier session would pin
// every later session to its stale geometry. Within one page load the shared
// name is exactly what makes task-to-task reuse work; across page loads,
// adoption must be impossible.
// Computed lazily on first use rather than at module evaluation: a throw here
// would otherwise take down the whole participant chunk instead of degrading.
let taskWindowName: string | null = null;

const getTaskWindowName = (): string => {
  if (taskWindowName === null) {
    const bytes = new Uint32Array(2);

    crypto.getRandomValues(bytes);
    taskWindowName = `firsthand-task-${Array.from(bytes, (b) =>
      b.toString(36)
    ).join("")}`;
  }

  return taskWindowName;
};

// The floating task pane cannot be placed: Chrome owns Document PiP placement
// (bottom-right of the screen) and requestWindow takes only a size. The task
// window is the movable half, so anchor it bottom-right as a large inset -
// the pane then lands ON the task window and reads as attached to it, while
// the top-left corner of the screen stays clear so the participant can still
// find the Cortex window behind it. Filling the whole screen was tried and
// obscured everything, which reads as a takeover, not a task page.
//
// Only when the pane can actually appear: without Document PiP (Firefox, and
// embedders that strip the method) the tasks live in the Cortex page, and a
// deliberately placed large window would bury the only copy of the task card
// for no benefit. There the browser's own cascade near the opener is right.
//
// availLeft/availTop anchor the placement to the screen the participant is
// actually on - left=0,top=0 is the PRIMARY screen's origin, so on a second
// monitor it would throw the window onto the wrong display.
//
// Some embedded webviews report a 0x0 screen; a zero-sized popup request is
// at the browser's mercy, so fall back to a usable fixed size.
const TASK_WINDOW_FALLBACK_FEATURES = "popup,width=1280,height=900";
const TASK_WINDOW_WIDTH_FRACTION = 0.65;
const TASK_WINDOW_HEIGHT_FRACTION = 0.8;

const taskWindowFeatures = (): string => {
  if (!isTaskPipSupported()) {
    return TASK_WINDOW_FALLBACK_FEATURES;
  }

  const screen = window.screen as Screen & {
    availLeft?: number;
    availTop?: number;
  };
  const availWidth = screen?.availWidth;
  const availHeight = screen?.availHeight;

  if (!availWidth || !availHeight) {
    return TASK_WINDOW_FALLBACK_FEATURES;
  }

  const width = Math.round(availWidth * TASK_WINDOW_WIDTH_FRACTION);
  const height = Math.round(availHeight * TASK_WINDOW_HEIGHT_FRACTION);
  const left = (screen.availLeft ?? 0) + (availWidth - width);
  const top = (screen.availTop ?? 0) + (availHeight - height);

  return `popup,left=${left},top=${top},width=${width},height=${height}`;
};

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

  const closeTaskWindow = useCallback(() => {
    const win = windowRef.current;

    if (win && !win.closed) {
      win.close();
    }

    windowRef.current = null;
    setState(initialState);
  }, []);

  // The task window is part of the session: when the flow unmounts (session
  // complete, navigation away) or this page unloads (reload, tab close),
  // take the window down with it. An orphan would linger over the next thing
  // the participant does - and, because names are per page load, could never
  // be re-adopted or repositioned by a later session.
  useEffect(() => {
    window.addEventListener("pagehide", closeTaskWindow);

    return () => {
      window.removeEventListener("pagehide", closeTaskWindow);
      closeTaskWindow();
    };
  }, [closeTaskWindow]);

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
    const win = window.open("", getTaskWindowName(), taskWindowFeatures());

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

  return { state, isOpen, openTaskWindow, closeTaskWindow };
}
