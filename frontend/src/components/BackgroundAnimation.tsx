import React, { useEffect, memo, useState } from 'react';
import { useTheme } from '../contexts/ThemeContext';

/**
 * BackgroundAnimation Component
 * 
 * Level 4 "Living Interface" - Atmospheric depth with breathing orbs
 * for dark mode.
 * Light mode uses a clean background without animation.
 * CSS is centralized in main.css for performance (prevents re-injection on renders).
 * Uses React.memo to prevent unnecessary re-renders.
 * 
 * NOTE: Does not render on landing page (which has its own background)
 */
const BackgroundAnimation: React.FC = memo(() => {
  const { isDarkMode } = useTheme();
  const [isLandingPage, setIsLandingPage] = useState(false);

  // Check if on landing page or study listing page (which have their own backgrounds)
  useEffect(() => {
    const checkSpecialPage = () => {
      const hasLandingPage = document.body.classList.contains('landing-page');
      const hasStudyListingPage = document.querySelector('.study-listing-page') !== null;
      setIsLandingPage(hasLandingPage || hasStudyListingPage);
    };
    
    checkSpecialPage();
    
    // Observe body class changes and DOM changes
    const observer = new MutationObserver(checkSpecialPage);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    
    return () => observer.disconnect();
  }, []);

  // Don't render on landing page - it has its own background
  if (isLandingPage) {
    return null;
  }

  // Light mode: render only static grid (no animations)
  if (!isDarkMode) {
    return (
      <div className="mesh-gradient-background mesh-gradient-light" aria-hidden="true" />
    );
  }

  return (
    <>
      {/* Atmospheric Breathing Orbs - Level 4 depth effect */}
      <div 
        className="atmospheric-orb" 
        style={{ 
          top: '10%', 
          right: '-15%',
          animationDelay: '0s'
        }} 
        aria-hidden="true" 
      />
      <div 
        className="atmospheric-orb-secondary" 
        style={{ 
          bottom: '5%', 
          left: '-10%',
          animationDelay: '-4s'
        }} 
        aria-hidden="true" 
      />
      
      {/* Static Grid Background */}
      <div className="mesh-gradient-background" aria-hidden="true" />
    </>
  );
});

BackgroundAnimation.displayName = 'BackgroundAnimation';

export default BackgroundAnimation;
