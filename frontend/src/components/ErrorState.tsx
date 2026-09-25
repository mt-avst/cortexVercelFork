import React, { memo } from 'react';
import { AlertTriangle, AlertCircle, Info, XCircle, LucideIcon } from 'lucide-react';

interface ErrorStateProps {
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: string;
  /**
   * The title's heading level. Defaults to 5; pass the level that follows
   * the surrounding headings when the state sits under a page `<h1>` or a
   * section `<h2>`, so the outline does not skip levels.
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
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
  icon = 'alert-triangle',
  headingLevel = 5
}) => {
  const IconComponent = iconMap[icon] || AlertTriangle;
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  
  return (
    <div className="alert alert-danger d-flex align-items-center" role="alert">
      <IconComponent size={24} className="me-3" aria-hidden="true" />
      <div className="flex-grow-1">
        <Heading className="alert-heading h5 mb-2">{title}</Heading>
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

