import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface FieldErrorProps {
  /** Referenced by the control's `aria-describedby`, where the control has one. */
  id?: string;
  children: React.ReactNode;
}

/**
 * One inline validation message, beside the control it is about.
 *
 * The icon is the point. `.validation-error` is a colour - brand orange in the
 * dark theme, #DC2626 in the light one - and colour was the only thing marking
 * twenty-six of these messages as errors rather than as help text sitting in
 * the same place. An author who cannot separate those two hues reads a refusal
 * as a hint.
 *
 * `aria-hidden` on the icon, because the message already says what is wrong;
 * an announced "warning" before every sentence is noise, and the `role="alert"`
 * on the wrapper is what carries the urgency to a screen reader.
 */
export const FieldError = ({ id, children }: FieldErrorProps) => (
  <div id={id} className="validation-error field-error" role="alert">
    <AlertTriangle size={15} aria-hidden="true" className="validation-error__icon" />
    <span>{children}</span>
  </div>
);

export default FieldError;
