import React, { memo } from 'react';

interface LoadingSpinnerProps {
  size?: 'small' | 'medium' | 'large';
  text?: string;
}

const SIZE_MAP = {
  small: '20px',
  medium: '30px',
  large: '40px'
} as const;

/**
 * LoadingSpinner Component
 * Displays an accessible loading indicator with optional text.
 * Wrapped in React.memo for performance optimization.
 */
const LoadingSpinner: React.FC<LoadingSpinnerProps> = memo(({ 
  size = 'small', 
  text = 'Loading...' 
}) => {
  return (
    <div 
      style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: '8px',
        opacity: 0.7 
      }}
      aria-busy="true"
      aria-live="polite"
    >
      <div 
        role="status"
        aria-label={text}
        style={{
          width: SIZE_MAP[size],
          height: SIZE_MAP[size],
          border: '2px solid #f3f3f3',
          borderTop: '2px solid #007bff',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }}
      />
      <span>{text}</span>
    </div>
  );
});

LoadingSpinner.displayName = 'LoadingSpinner';

export default LoadingSpinner;
