import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type ModalProps = {
  children: ReactNode;
  /**
   * Invoked on Escape and on a backdrop click. Omit for a modal that must be
   * resolved through its own buttons.
   */
  onDismiss?: () => void;
};

/**
 * A dialog rendered into `document.body` rather than in place.
 *
 * The portal is load-bearing, not stylistic: an ancestor with `backdrop-filter`
 * (like `filter`, `transform`, `perspective` and `will-change`) becomes the
 * containing block for any `position: fixed` descendant, which would size the
 * backdrop to that ancestor instead of the viewport. Rendering into body sizes
 * it to the viewport.
 *
 * The backdrop carries the `fh-recording` scope class so the recording-session
 * base styles (`.button`, `.actions`, `.eyebrow`, ...) still apply to the
 * portalled content even though it lives outside the page's own `fh-recording`
 * subtree.
 */
export function Modal({ children, onDismiss }: ModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isMounted) {
      return;
    }

    // Stop the page scrolling underneath the dialog.
    const { overflow } = document.body.style;

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
    };
  }, [isMounted]);

  useEffect(() => {
    if (!isMounted) {
      return;
    }

    // Move focus into the dialog so keyboard and screen-reader users land on
    // it rather than continuing behind the backdrop.
    cardRef.current?.focus();
  }, [isMounted]);

  useEffect(() => {
    if (!isMounted || !onDismiss) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onDismiss?.();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMounted, onDismiss]);

  // Rendered only after mount so document.body exists before portalling.
  if (!isMounted) {
    return null;
  }

  return createPortal(
    <div
      className="fh-recording fh-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onDismiss?.();
        }
      }}
    >
      <div
        aria-modal="true"
        className="fh-modal-card"
        ref={cardRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
