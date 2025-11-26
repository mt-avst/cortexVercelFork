import React, { useEffect, useRef, memo } from 'react';
import { useAnimation } from '../contexts/AnimationContext';

/**
 * BackgroundAnimation Component
 * 
 * Renders a retro computing-inspired animated grid background.
 * CSS is centralized in index.css for performance (prevents re-injection on renders).
 * Uses React.memo to prevent unnecessary re-renders.
 */
const BackgroundAnimation: React.FC = memo(() => {
  const squaresRef = useRef<(HTMLDivElement | null)[]>([]);
  const fullGridSquareRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { animationsEnabled } = useAnimation();
  const timeoutRefs = useRef<NodeJS.Timeout[]>([]);
  const intervalsRef = useRef<NodeJS.Timeout[]>([]);

  // Randomize square positions on each animation cycle
  useEffect(() => {
    // Clear existing intervals
    intervalsRef.current.forEach(interval => clearInterval(interval));
    intervalsRef.current = [];

    if (!animationsEnabled) {
      // Hide animated squares when animations are disabled
      squaresRef.current.forEach((square) => {
        if (square) {
          square.style.opacity = '0';
          square.style.animationPlayState = 'paused';
        }
      });
      return;
    }

    const randomizePositions = () => {
      squaresRef.current.forEach((square) => {
        if (square) {
          const randomX = Math.floor(Math.random() * 600 - 300);
          const randomY = Math.floor(Math.random() * 600 - 300);
          square.style.setProperty('--translate-x', `${randomX}px`);
          square.style.setProperty('--translate-y', `${randomY}px`);
        }
      });
    };

    // Randomize initially
    randomizePositions();

    // Set up interval for each square
    squaresRef.current.forEach((square) => {
      if (square) {
        const baseInterval = 2500 + Math.random() * 2000;
        const interval = setInterval(() => {
          const randomX = Math.floor(Math.random() * 600 - 300);
          const randomY = Math.floor(Math.random() * 600 - 300);
          square.style.setProperty('--translate-x', `${randomX}px`);
          square.style.setProperty('--translate-y', `${randomY}px`);
        }, baseInterval);
        intervalsRef.current.push(interval);
      }
    });

    return () => {
      intervalsRef.current.forEach(interval => clearInterval(interval));
      intervalsRef.current = [];
    };
  }, [animationsEnabled]);

  // Randomize full grid squares position and lighting
  useEffect(() => {
    timeoutRefs.current.forEach(timeout => clearTimeout(timeout));
    timeoutRefs.current = [];

    const squares = fullGridSquareRefs.current.filter(sq => sq !== null);
    if (squares.length === 0) return;

    if (!animationsEnabled) {
      squares.forEach((square) => {
        if (square) {
          square.style.opacity = '0';
        }
      });
      return;
    }

    const meshBackground = document.querySelector('.mesh-gradient-background');
    const overlay = squares[0]?.parentElement;
    
    if (!meshBackground || !overlay) return;

    const randomizePosition = (gridSquare: HTMLDivElement) => {
      if (!animationsEnabled) return;
      
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
        if (animationsEnabled) {
          gridSquare.style.opacity = '0';
        }
      }, fadeDuration);
      timeoutRefs.current.push(fadeTimeout);
    };

    // Initialize with staggered starts
    squares.forEach((square, index) => {
      const initialDelay = (index * 200) + Math.random() * 500;
      const initialTimeout = setTimeout(() => {
        if (animationsEnabled) {
          randomizePosition(square);
        }
      }, initialDelay);
      timeoutRefs.current.push(initialTimeout);

      const scheduleNext = () => {
        if (!animationsEnabled) return;
        const delay = 1000 + Math.random() * 2500;
        const nextTimeout = setTimeout(() => {
          if (animationsEnabled) {
            randomizePosition(square);
            scheduleNext();
          }
        }, delay);
        timeoutRefs.current.push(nextTimeout);
      };

      scheduleNext();
    });

    return () => {
      timeoutRefs.current.forEach(timeout => clearTimeout(timeout));
      timeoutRefs.current = [];
    };
  }, [animationsEnabled]);

  return (
    <>
      {/* Static Grid Background */}
      <div className="mesh-gradient-background" aria-hidden="true" />
      
      {/* Retro Computing Grid Squares Overlay */}
      <div 
        className={`grid-squares-overlay ${!animationsEnabled ? 'animations-disabled' : ''}`} 
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
        {/* Small glowing squares (20 total) */}
        {Array.from({ length: 20 }, (_, i) => (
          <div
            key={`grid-square-${i}`}
            ref={(el) => { squaresRef.current[i] = el; }}
            className="grid-square"
          />
        ))}
      </div>
    </>
  );
});

BackgroundAnimation.displayName = 'BackgroundAnimation';

export default BackgroundAnimation;

