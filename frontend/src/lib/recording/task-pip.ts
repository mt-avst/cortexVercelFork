import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Document Picture-in-Picture wrapper for the floating task pane.
 *
 * The two-window flow makes the participant memorise the task, switch to the
 * task window, then switch back to answer. Document PiP gives us an
 * always-on-top window we control, so the current task can float over the
 * page under test - the same UX as UserTesting's task widget, without a
 * browser extension.
 *
 * Chromium-only (116+). Firefox and Safari have no Document PiP, so the hook
 * reports unsupported there and the existing two-window flow is the fallback -
 * mirroring how UserTesting itself degrades to a two-tab layout off Chrome.
 */

type DocumentPictureInPictureOptions = {
  width?: number;
  height?: number;
};

type DocumentPictureInPictureApi = {
  // The shipped method name. (Not `open` - that never existed; verified
  // against real Chrome, whose prototype carries only requestWindow.)
  requestWindow: (options?: DocumentPictureInPictureOptions) => Promise<Window>;
  window: Window | null;
};

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

// Sized for one task card: counter, prompt, an answer input and the confirm
// button. The participant can resize the window natively afterwards.
const PIP_WIDTH = 380;
const PIP_HEIGHT = 440;

export function isTaskPipSupported(): boolean {
  // Check the method, not just the object: an embedder policy can expose the
  // object with the method absent, and an object-only check would then offer
  // a float button that can never work.
  return (
    typeof window !== "undefined" &&
    typeof window.documentPictureInPicture?.requestWindow === "function"
  );
}

export type TaskPipState = {
  // The floating window while open, null otherwise. Render into its
  // document.body via createPortal; it is same-origin and shares this page's
  // JS context, so React state flows into it directly.
  pipWindow: Window | null;
  isSupported: boolean;
  openTaskPip: () => Promise<boolean>;
  closeTaskPip: () => void;
};

export function useTaskPip(): TaskPipState {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  // The ref, not state, is the source of truth for imperative paths (close on
  // unmount) - state exists so the portal re-renders when the window comes
  // and goes.
  const pipRef = useRef<Window | null>(null);

  const closeTaskPip = useCallback(() => {
    const win = pipRef.current;

    if (win && !win.closed) {
      win.close();
    }

    pipRef.current = null;
    setPipWindow(null);
  }, []);

  const openTaskPip = useCallback(async (): Promise<boolean> => {
    const api = window.documentPictureInPicture;

    if (typeof api?.requestWindow !== "function") {
      return false;
    }

    const existing = pipRef.current;

    if (existing && !existing.closed) {
      // Already floating: nothing to do. The browser only allows one Document
      // PiP window, and ours is it.
      return true;
    }

    let win: Window;

    try {
      // Requires transient user activation, so this must run in a click
      // handler. Rejects when activation has expired or the platform refuses.
      win = await api.requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT });
    } catch {
      return false;
    }

    // Everything past requestWindow is best-effort DRESSING, and it is inside
    // the try for a reason: the caller runs while capture is already live, so
    // a throw here (an absent body, a stylesheet that misbehaves) must never
    // propagate and strand a participant who is being recorded. This function
    // resolves true or false and never rejects.
    try {
      copyStylesInto(win.document);
      // The recording surface's styles are all scoped under .fh-recording (see
      // recording-session.css); the class on body lets them reach the portal
      // content, exactly like the portalled modal does it.
      win.document.body.className = "fh-recording pip-body";
      // Screen readers announce the window title and pick a voice from the
      // language; without these the pane is an untitled, language-less window.
      win.document.title = "Your task";
      win.document.documentElement.lang =
        document.documentElement.lang || "en";

      // Fires when the participant closes the floating window (or the browser
      // replaces it). State resets so the way back comes with it.
      win.addEventListener("pagehide", () => {
        pipRef.current = null;
        setPipWindow(null);
      });
    } catch {
      // Dressing failed but the window exists; still hand it back, because a
      // bare-but-working pane beats no pane and beats a broken session.
    }

    pipRef.current = win;
    setPipWindow(win);

    return true;
  }, []);

  // The floating pane must not outlive the surface that owns it: when the
  // runner unmounts (session complete, navigation away), take the pane down.
  useEffect(() => closeTaskPip, [closeTaskPip]);

  return { pipWindow, isSupported: isTaskPipSupported(), openTaskPip, closeTaskPip };
}

/**
 * A Document PiP window opens with an empty head: none of the opener's
 * stylesheets apply. Copy them across - inline the readable ones, re-link the
 * cross-origin ones whose cssRules are unreadable.
 */
function copyStylesInto(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      const style = target.createElement("style");

      style.textContent = rules;
      target.head.appendChild(style);
    } catch {
      // Cross-origin stylesheet: cssRules throws. Reference it instead.
      const node = sheet.ownerNode;

      if (node instanceof HTMLLinkElement && node.href) {
        const link = target.createElement("link");

        link.rel = "stylesheet";
        link.href = node.href;
        target.head.appendChild(link);
      }
    }
  }
}
