import React, { memo } from 'react';

interface LoadingSpinnerProps {
  size?: 'small' | 'medium' | 'large';
  text?: string;
}

/**
 * LoadingSpinner Component
 * Displays a premium, accessible loading indicator using brand tokens.
 * "Breathing" animation via CSS classes.
 */
const LoadingSpinner: React.FC<LoadingSpinnerProps> = memo(({ 
  size = 'medium', 
  text = 'Loading...' 
}) => {
  // Map size prop to bootstrap-compatible or custom classes
  const spinnerClass = size === 'small' ? 'spinner-border-sm' : '';
  const containerStyle = size === 'large' ? { transform: 'scale(1.5)' } : {};

  return (
    <div 
      className="d-flex align-items-center gap-3 opacity-75"
      role="status"
      aria-live="polite"
    >
      <div 
        className={`spinner-border text-primary ${spinnerClass}`} 
        style={{ 
          ...containerStyle, 
          borderColor: 'var(--border-subtle)', 
          borderRightColor: 'var(--brand-primary)' 
        }}
      >
        <span className="visually-hidden">{text}</span>
      </div>
      
      {text && (
        <span className="text-muted small font-monospace text-uppercase tracking-wider">
          {text}
        </span>
      )}
    </div>
  );
});

LoadingSpinner.displayName = 'LoadingSpinner';

export default LoadingSpinner;
