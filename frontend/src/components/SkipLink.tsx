import React from 'react';

/**
 * SkipLink Component
 * 
 * Provides a "Skip to main content" link for keyboard users.
 * Hidden by default, visible when focused via keyboard navigation.
 * Improves accessibility by allowing users to bypass repetitive navigation.
 * 
 * Styles are defined in _components.css as part of the design system.
 */
const SkipLink: React.FC = () => {
  return (
    <a href="#main-content" className="skip-link">
      Skip to main content
    </a>
  );
};

export default SkipLink;



