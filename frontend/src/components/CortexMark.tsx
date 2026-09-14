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
 * a 16px browser tab to app-icon scale without a redraw.
 *
 * Geometry, on the original 48x48 design grid: central node radius 6.5 at
 * (24,24), three limbs at 90/210/330 degrees to satellite nodes radius 4.2,
 * stem stroke 4.8.
 *
 * ARTBOARD. The `viewBox` is the ink's own bounding box (x 7.8-40.2,
 * y 4.8-35.7) squared off with one unit of optical margin, NOT the 48x48 grid
 * the coordinates are expressed on. It used to be "0 0 48 48", which framed
 * 32.4 x 30.9 of ink inside 48 x 48 - the ink filled 67.5% of the artboard's
 * width and 56.5% of its area. So the 30px header slot painted about 20px of
 * mark against an 18px cap height, and the lockup's 10px CSS gap read wider
 * than it is, because the mark's own artboard padded it by ~4.9px on that side
 * (measured at 16px in the brand review). Reframed, the same slot paints
 * about 28px - measured live at 28 x 27px, both themes.
 *
 * Coordinates are unchanged: this reframes, it does not redraw. Four redraw
 * candidates were drawn and measured on 2026-09-14 (Decision 1 of the
 * second-pass plan) and Nick chose none of them - the tightened artboard on
 * the shipped geometry was the pick. A geometry change here is a regression
 * until that decision is revisited.
 *
 * `frontend/public/favicon.svg` repeats this artboard and these coordinates
 * with the orange baked in, and `apple-touch-icon.png` is rasterised from the
 * same. `__tests__/cortex-mark-assets.test.ts` is what stops the three
 * drifting apart.
 */
function CortexMark({ className, title }: CortexMarkProps) {
  const decorative = !title;
  return (
    <svg
      className={className}
      viewBox="6.8 3.05 34.4 34.4"
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
