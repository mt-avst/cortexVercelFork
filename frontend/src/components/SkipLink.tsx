import React from 'react';
import './SkipLink.css';

/**
 * SkipLink Component
 * 
 * Provides a "Skip to main content" link for keyboard users.
 * Hidden by default, visible when focused via keyboard navigation.
 * Improves accessibility by allowing users to bypass repetitive navigation.
 */
const SkipLink: React.FC = () => {
  return (
    <a href="#main-content" className="skip-link">
      Skip to main content
    </a>
  );
};

export default SkipLink;



