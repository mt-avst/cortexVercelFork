import React from 'react';

interface CortexMarkProps {
  /** Extra class hook for sizing/colour from CSS. */
  className?: string;
  /**
   * Accessible name. Omit for a decorative mark that sits beside a text
   * wordmark (the default) - it is then hidden from assistive tech. Pass a
   * title where the mark stands alone and must carry the name.
   */
  title?: string;
}

/**
 * The Cortex product mark - the "Neuron": a central node with three radiating
 * links to satellite nodes. Single-colour by design, inherits `currentColor`
 * so it takes ink or brand orange from whatever sits behind it, and holds from
 * a 16px browser tab to app-icon scale without a redraw. Grid and spec: 48x48
 * artboard, central node radius 6.5, three limbs at 90/210/330 degrees to
 * satellite nodes radius 4.2, stem stroke 4.8.
 */
function CortexMark({ className, title }: CortexMarkProps) {
  const decorative = !title;
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <g
        stroke="currentColor"
        strokeWidth="4.8"
        strokeLinecap="round"
      >
        <path d="M24 24 24 9" />
        <path d="M24 24 12 31.5" />
        <path d="M24 24 36 31.5" />
      </g>
      <circle cx="24" cy="9" r="4.2" fill="currentColor" />
      <circle cx="12" cy="31.5" r="4.2" fill="currentColor" />
      <circle cx="36" cy="31.5" r="4.2" fill="currentColor" />
      <circle cx="24" cy="24" r="6.5" fill="currentColor" />
    </svg>
  );
}

export default CortexMark;
