import React, { useEffect, useRef, memo } from 'react';
import { useTheme } from '../contexts/ThemeContext';

/**
 * BackgroundAnimation Component
 * 
 * Renders a retro computing-inspired animated grid background.
 * Only renders in dark mode - light mode uses a clean background without animation.
 * CSS is centralized in main.css for performance (prevents re-injection on renders).
 * Uses React.memo to prevent unnecessary re-renders.
 */
const BackgroundAnimation: React.FC = memo(() => {
  const fullGridSquareRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { isDarkMode } = useTheme();
  const timeoutRefs = useRef<NodeJS.Timeout[]>([]);

  // Randomize full grid squares position and lighting
  useEffect(() => {
    timeoutRefs.current.forEach(timeout => clearTimeout(timeout));
    timeoutRefs.current = [];

    // Skip animations in light mode
    if (!isDarkMode) return;

    const squares = fullGridSquareRefs.current.filter(sq => sq !== null);
    if (squares.length === 0) return;

    const meshBackground = document.querySelector('.mesh-gradient-background');
    const overlay = squares[0]?.parentElement;
    
    if (!meshBackground || !overlay) return;

    const randomizePosition = (gridSquare: HTMLDivElement) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const meshRect = meshBackground.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      
      const viewportCols = Math.ceil(viewportWidth / 80) + 2;
      const viewportRows = Math.ceil(viewportHeight / 80) + 2;
      const randomCol = Math.floor(Math.random() * viewportCols);
      const randomRow = Math.floor(Math.random() * viewportRows);
      
      const targetScreenX = meshRect.left + (randomCol * 80);
      const targetScreenY = meshRect.top + (randomRow * 80);
      const left = targetScreenX - overlayRect.left;
      const top = targetScreenY - overlayRect.top;
      
      gridSquare.style.left = `${Math.round(left)}px`;
      gridSquare.style.top = `${Math.round(top)}px`;
      gridSquare.style.opacity = '0.7';
      
      const fadeDuration = 1500 + Math.random() * 2000;
      const fadeTimeout = setTimeout(() => {
        gridSquare.style.opacity = '0';
      }, fadeDuration);
      timeoutRefs.current.push(fadeTimeout);
    };

    // Initialize with staggered starts
    squares.forEach((square, index) => {
      const initialDelay = (index * 200) + Math.random() * 500;
      const initialTimeout = setTimeout(() => {
        randomizePosition(square);
      }, initialDelay);
      timeoutRefs.current.push(initialTimeout);

      const scheduleNext = () => {
        const delay = 1000 + Math.random() * 2500;
        const nextTimeout = setTimeout(() => {
          randomizePosition(square);
          scheduleNext();
        }, delay);
        timeoutRefs.current.push(nextTimeout);
      };

      scheduleNext();
    });

    return () => {
      timeoutRefs.current.forEach(timeout => clearTimeout(timeout));
      timeoutRefs.current = [];
    };
  }, [isDarkMode]);

  // Light mode: render only static grid (no animations)
  if (!isDarkMode) {
    return (
      <div className="mesh-gradient-background mesh-gradient-light" aria-hidden="true" />
    );
  }

  return (
    <>
      {/* Static Grid Background */}
      <div className="mesh-gradient-background" aria-hidden="true" />
      
      {/* Grid Squares Overlay - Illuminated cells on grid */}
      <div 
        className="grid-squares-overlay"
        aria-hidden="true"
      >
        {/* Full Grid Squares - Randomly light up (21 total) */}
        {Array.from({ length: 21 }, (_, i) => (
          <div
            key={`full-grid-${i}`}
            ref={(el) => { fullGridSquareRefs.current[i] = el; }}
            className="full-grid-square"
          />
        ))}
      </div>
    </>
  );
});

BackgroundAnimation.displayName = 'BackgroundAnimation';

export default BackgroundAnimation;
