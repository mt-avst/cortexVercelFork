import { Check } from 'lucide-react';
import { Icon } from '../ui/Icon';

export interface StepMarkerProps {
  /** 1-based step position, shown when the step is not done. */
  index: number;
  done: boolean;
  /**
   * `numbered` - the launch list's 22px circle: shows the digit, then a
   * check once done.
   * `tick` - the Journey rail's 16px square: shows nothing until done, then
   * a check. The rail already names the step in text beside it, so the tick
   * carries no digit.
   */
  variant: 'numbered' | 'tick';
}

/**
 * One implementation for both recording-rail step markers. Before this they
 * were a ternary each: the Journey tick always held a "✓" text node hidden
 * via `color: transparent` until done, and the launch circle swapped between
 * a digit string and a literal "✓". Neither drew from the icon system, and
 * a `done` state that showed different glyphs in the same flow read as two
 * flows, not one.
 */
export function StepMarker({ index, done, variant }: StepMarkerProps) {
  const baseClass = variant === 'tick' ? 'journey-vtick' : 'journey-launch-num';

  return (
    <span aria-hidden="true" className={baseClass}>
      {done ? (
        <Icon icon={Check} size={14} />
      ) : variant === 'numbered' ? (
        index
      ) : null}
    </span>
  );
}
