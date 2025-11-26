import React, { memo } from 'react';

interface ErrorStateProps {
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: string;
}

/**
 * ErrorState Component
 * Displays an accessible error message with optional retry action.
 * Wrapped in React.memo for performance optimization.
 */
const ErrorState: React.FC<ErrorStateProps> = memo(({ 
  title = 'Something went wrong', 
  message, 
  actionLabel = 'Try Again',
  onAction,
  icon = 'bi-exclamation-triangle'
}) => {
  return (
    <div className="alert alert-danger d-flex align-items-center" role="alert">
      <i className={`bi ${icon} me-3`} style={{ fontSize: '1.5rem' }} aria-hidden="true" />
      <div className="flex-grow-1">
        <h5 className="alert-heading mb-2">{title}</h5>
        <p className="mb-0">{message}</p>
      </div>
      {onAction && (
        <button 
          className="btn btn-outline-danger ms-3"
          onClick={onAction}
          aria-label={actionLabel}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
});

ErrorState.displayName = 'ErrorState';

export default ErrorState;

