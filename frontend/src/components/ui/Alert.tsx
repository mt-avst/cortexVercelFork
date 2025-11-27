import React from 'react';

export type AlertVariant = 'success' | 'danger' | 'warning' | 'info';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant: AlertVariant;
  dismissible?: boolean;
  onDismiss?: () => void;
  icon?: React.ReactNode;
}

const variantClasses: Record<AlertVariant, string> = {
  success: 'alert alert-success',
  danger: 'alert alert-danger',
  warning: 'alert alert-warning',
  info: 'alert alert-info',
};

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ children, variant, dismissible = false, onDismiss, icon, className = '', ...props }, ref) => {
    const classes = [
      variantClasses[variant],
      dismissible ? 'flex justify-between items-start' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div ref={ref} role="alert" className={classes} {...props}>
        <div className="flex items-start gap-3">
          {icon && <span className="flex-shrink-0">{icon}</span>}
          <div>{children}</div>
        </div>
        {dismissible && onDismiss && (
          <button
            type="button"
            className="btn-close ml-4"
            aria-label="Close"
            onClick={onDismiss}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
    );
  }
);

Alert.displayName = 'Alert';

export default Alert;

