import { forwardRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/**
 * The four sizes every glyph in the product may render at. A fifth size
 * silently reintroduces the inconsistency this component exists to remove,
 * so it is a closed union rather than `number`.
 */
export type IconSize = 14 | 16 | 20 | 24;

export interface IconProps extends Omit<LucideProps, 'size' | 'ref' | 'absoluteStrokeWidth'> {
  /** The lucide component to render, e.g. `icon={ArrowRight}`. */
  icon: LucideIcon;
  size?: IconSize;
}

/**
 * The one place lucide's `size` and `absoluteStrokeWidth` are decided.
 * Lucide's raw stroke-width is fixed in viewBox units, so the same
 * `strokeWidth={2}` reads thinner at 14px than at 24px unless
 * `absoluteStrokeWidth` scales it to compensate - every call site would
 * otherwise have to remember that itself.
 */
export const Icon = forwardRef<SVGSVGElement, IconProps>(
  ({ icon: LucideIconComponent, size = 16, ...props }, ref) => (
    <LucideIconComponent ref={ref} size={size} absoluteStrokeWidth {...props} />
  )
);

Icon.displayName = 'Icon';
