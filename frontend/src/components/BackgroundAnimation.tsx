import React, { memo } from 'react';

/**
 * BackgroundAnimation Component
 * 
 * IMPORTANT: This component is now DISABLED.
 * 
 * Theme backgrounds are handled by:
 * - Dark Mode: Individual pages render SlowNeuralBackground (neural particles on black #030305)
 * - Light Mode: CSS body::before creates the orange grid overlay (in _themes.css)
 * 
 * This prevents the blue atmospheric orbs and incorrect backgrounds from showing.
 * Pages that need the neural background should import SlowNeuralBackground directly.
 */
const BackgroundAnimation: React.FC = memo(() => {
  // DISABLED: All backgrounds now handled by page-level components and CSS
  // Dark mode: Pages render SlowNeuralBackground themselves
  // Light mode: body::before in _themes.css handles the orange grid
  return null;
});

BackgroundAnimation.displayName = 'BackgroundAnimation';

export default BackgroundAnimation;
