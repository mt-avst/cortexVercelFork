import React from 'react';

interface LoadingSpinnerProps {
  size?: 'small' | 'medium' | 'large';
  text?: string;
}

const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ 
  size = 'small', 
  text = 'Loading...' 
}) => {
  const sizeClasses = {
    small: '20px',
    medium: '30px',
    large: '40px'
  };

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
          width: sizeClasses[size],
          height: sizeClasses[size],
          border: '2px solid #f3f3f3',
          borderTop: '2px solid #007bff',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }}
      />
      <span>{text}</span>
    </div>
  );
};

export default LoadingSpinner;
