import React, { memo } from 'react';
import { AlertTriangle, AlertCircle, Info, XCircle, LucideIcon } from 'lucide-react';

interface ErrorStateProps {
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: string;
}

const iconMap: Record<string, LucideIcon> = {
  'alert-triangle': AlertTriangle,
  'alert-circle': AlertCircle,
  'info': Info,
  'x-circle': XCircle,
};

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
  icon = 'alert-triangle'
}) => {
  const IconComponent = iconMap[icon] || AlertTriangle;
  
  return (
    <div className="alert alert-danger d-flex align-items-center" role="alert">
      <IconComponent size={24} className="me-3" aria-hidden="true" />
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

