import React, { useEffect, useRef } from 'react';
import { useAnimation } from '../contexts/AnimationContext';

const BackgroundAnimation: React.FC = () => {
  const squaresRef = useRef<(HTMLDivElement | null)[]>([]);
  const fullGridSquareRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { animationsEnabled } = useAnimation();
  const timeoutRefs = useRef<NodeJS.Timeout[]>([]);

  // Randomize square positions on each animation cycle
  useEffect(() => {
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
          // Random position offsets (between -300px and +300px)
          const randomX = Math.floor(Math.random() * 600 - 300);
          const randomY = Math.floor(Math.random() * 600 - 300);
          square.style.setProperty('--translate-x', `${randomX}px`);
          square.style.setProperty('--translate-y', `${randomY}px`);
        }
      });
    };

    // Randomize initially
    randomizePositions();

    // Set up interval to randomize periodically (every 2-5 seconds randomly)
    const intervals: NodeJS.Timeout[] = [];
    
    squaresRef.current.forEach((square) => {
      if (square) {
        // Each square gets its own randomization interval
        const baseInterval = 2500 + Math.random() * 2000; // 2.5-4.5 seconds
        const interval = setInterval(() => {
          const randomX = Math.floor(Math.random() * 600 - 300);
          const randomY = Math.floor(Math.random() * 600 - 300);
          square.style.setProperty('--translate-x', `${randomX}px`);
          square.style.setProperty('--translate-y', `${randomY}px`);
        }, baseInterval);
        intervals.push(interval);
      }
    });

    return () => {
      intervals.forEach(interval => clearInterval(interval));
    };
  }, [animationsEnabled]);

  // Randomize full grid squares position and lighting (21 squares total)
  useEffect(() => {
    // Clear all existing timeouts when toggling
    timeoutRefs.current.forEach(timeout => clearTimeout(timeout));
    timeoutRefs.current = [];

    const squares = fullGridSquareRefs.current.filter(sq => sq !== null);
    if (squares.length === 0) return;

    if (!animationsEnabled) {
      // Hide grid squares when animations are disabled
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
      if (!animationsEnabled) return; // Stop if animations were disabled
      // Grid is 80px x 80px, perfectly align to grid intersections
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Get actual rendered positions (accounts for percentage rounding)
      const meshRect = meshBackground.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      
      // Calculate available grid cells in viewport
      const viewportCols = Math.ceil(viewportWidth / 80) + 2;
      const viewportRows = Math.ceil(viewportHeight / 80) + 2;
      
      // Randomly select a grid cell anywhere on the screen
      const randomCol = Math.floor(Math.random() * viewportCols);
      const randomRow = Math.floor(Math.random() * viewportRows);
      
      // Calculate the absolute screen position where the grid cell would be
      const targetScreenX = meshRect.left + (randomCol * 80);
      const targetScreenY = meshRect.top + (randomRow * 80);
      
      // Convert to overlay-relative coordinates
      const left = targetScreenX - overlayRect.left;
      const top = targetScreenY - overlayRect.top;
      
      // Round to ensure pixel-perfect alignment
      gridSquare.style.left = `${Math.round(left)}px`;
      gridSquare.style.top = `${Math.round(top)}px`;
      
      // Trigger fade in with higher opacity immediately
      gridSquare.style.opacity = '0.7';
      
      // Fade out after random duration
      const fadeDuration = 1500 + Math.random() * 2000; // 1.5-3.5 seconds
      const fadeTimeout = setTimeout(() => {
        if (animationsEnabled) {
          gridSquare.style.opacity = '0';
        }
      }, fadeDuration);
      timeoutRefs.current.push(fadeTimeout);
    };

    // Initialize all squares with staggered start times
    squares.forEach((square, index) => {
      const initialDelay = (index * 200) + Math.random() * 500; // Stagger starts
      const initialTimeout = setTimeout(() => {
        if (animationsEnabled) {
          randomizePosition(square);
        }
      }, initialDelay);
      timeoutRefs.current.push(initialTimeout);

      // Each square gets its own randomization schedule
      const scheduleNext = () => {
        if (!animationsEnabled) return; // Stop scheduling if disabled
        const delay = 1000 + Math.random() * 2500; // 1-3.5 seconds
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
      // Cleanup: clear all timeouts when component unmounts or animations change
      timeoutRefs.current.forEach(timeout => clearTimeout(timeout));
      timeoutRefs.current = [];
    };
  }, [animationsEnabled]);

  return (
    <>
      <style>
        {`
          /* Static Grid Background - Full Screen Bleed */
          .mesh-gradient-background {
            position: fixed;
            top: -20%;
            left: -20%;
            width: 140%;
            height: 140%;
            z-index: 0;
            background-image: 
              linear-gradient(rgba(255, 78, 80, 0.3) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255, 78, 80, 0.3) 1px, transparent 1px);
            background-size: 80px 80px;
            background-position: 0 0;
            pointer-events: none;
            overflow: visible;
            opacity: 0.5;
          }

          /* Retro Computing Grid Squares Overlay */
          .grid-squares-overlay {
            position: fixed;
            top: -20%;
            left: -20%;
            width: 140%;
            height: 140%;
            z-index: 1;
            pointer-events: none;
            overflow: visible;
          }

          /* Full Grid Square - Lights up at random positions */
          .full-grid-square {
            position: absolute;
            width: 80px;
            height: 80px;
            background-color: rgba(255, 78, 80, 0.25);
            border: 2px solid rgba(255, 78, 80, 0.7);
            box-shadow: 0 0 30px rgba(255, 78, 80, 0.8), inset 0 0 30px rgba(255, 78, 80, 0.3);
            opacity: 0;
            transition: opacity 0.6s ease-in-out;
            pointer-events: none;
            z-index: 2;
          }

          /* Individual glowing squares - positioned at grid intersections */
          .grid-square {
            position: absolute;
            width: 4px;
            height: 4px;
            background-color: #FF4E50;
            border-radius: 1px;
            box-shadow: 0 0 8px #FF4E50, 0 0 12px #FF4E50, 0 0 16px rgba(255, 78, 80, 0.6);
            opacity: 0;
            animation: retroSquareFlicker linear infinite;
          }

          @keyframes retroSquareFlicker {
            0% {
              opacity: 0;
              transform: translate(0, 0) scale(0.8);
            }
            5% {
              opacity: 0.5;
              transform: translate(0, 0) scale(1);
            }
            15% {
              opacity: 0.45;
              transform: translate(var(--translate-x), var(--translate-y)) scale(1);
            }
            25% {
              opacity: 0.3;
              transform: translate(var(--translate-x), var(--translate-y)) scale(0.95);
            }
            35% {
              opacity: 0.4;
              transform: translate(calc(var(--translate-x) * 0.7), calc(var(--translate-y) * 0.7)) scale(1);
            }
            50% {
              opacity: 0.2;
              transform: translate(calc(var(--translate-x) * 1.2), calc(var(--translate-y) * 1.2)) scale(0.9);
            }
            60% {
              opacity: 0.35;
              transform: translate(var(--translate-x), var(--translate-y)) scale(1);
            }
            75% {
              opacity: 0.15;
              transform: translate(calc(var(--translate-x) * 0.5), calc(var(--translate-y) * 0.5)) scale(0.85);
            }
            85% {
              opacity: 0.45;
              transform: translate(var(--translate-x), var(--translate-y)) scale(1);
            }
            95% {
              opacity: 0.25;
              transform: translate(calc(var(--translate-x) * 0.9), calc(var(--translate-y) * 0.9)) scale(0.9);
            }
            100% {
              opacity: 0;
              transform: translate(var(--translate-x), var(--translate-y)) scale(0.8);
            }
          }

          /* Random positions and timings for each square */
          .grid-square:nth-child(1) {
            top: 12%;
            left: 8%;
            --translate-x: 240px;
            --translate-y: -160px;
            animation-duration: 3.2s;
            animation-delay: 0.3s;
          }
          .grid-square:nth-child(2) {
            top: 28%;
            left: 24%;
            --translate-x: -180px;
            --translate-y: 200px;
            animation-duration: 4.7s;
            animation-delay: 1.1s;
          }
          .grid-square:nth-child(3) {
            top: 15%;
            left: 42%;
            --translate-x: 320px;
            --translate-y: 120px;
            animation-duration: 2.8s;
            animation-delay: 0.7s;
          }
          .grid-square:nth-child(4) {
            top: 35%;
            left: 18%;
            --translate-x: -220px;
            --translate-y: -140px;
            animation-duration: 5.3s;
            animation-delay: 2.4s;
          }
          .grid-square:nth-child(5) {
            top: 22%;
            left: 58%;
            --translate-x: 180px;
            --translate-y: 240px;
            animation-duration: 3.9s;
            animation-delay: 0.9s;
          }
          .grid-square:nth-child(6) {
            top: 48%;
            left: 32%;
            --translate-x: -280px;
            --translate-y: 160px;
            animation-duration: 4.2s;
            animation-delay: 1.8s;
          }
          .grid-square:nth-child(7) {
            top: 38%;
            left: 56%;
            --translate-x: 200px;
            --translate-y: -180px;
            animation-duration: 3.5s;
            animation-delay: 0.5s;
          }
          .grid-square:nth-child(8) {
            top: 52%;
            left: 14%;
            --translate-x: -160px;
            --translate-y: 220px;
            animation-duration: 4.9s;
            animation-delay: 2.1s;
          }
          .grid-square:nth-child(9) {
            top: 18%;
            left: 68%;
            --translate-x: 260px;
            --translate-y: -120px;
            animation-duration: 3.1s;
            animation-delay: 1.3s;
          }
          .grid-square:nth-child(10) {
            top: 44%;
            left: 76%;
            --translate-x: -240px;
            --translate-y: 180px;
            animation-duration: 4.6s;
            animation-delay: 0.8s;
          }
          .grid-square:nth-child(11) {
            top: 62%;
            left: 26%;
            --translate-x: 300px;
            --translate-y: -200px;
            animation-duration: 3.7s;
            animation-delay: 1.9s;
          }
          .grid-square:nth-child(12) {
            top: 56%;
            left: 52%;
            --translate-x: -200px;
            --translate-y: 140px;
            animation-duration: 4.4s;
            animation-delay: 1.2s;
          }
          .grid-square:nth-child(13) {
            top: 32%;
            left: 84%;
            --translate-x: 220px;
            --translate-y: -160px;
            animation-duration: 3.3s;
            animation-delay: 2.6s;
          }
          .grid-square:nth-child(14) {
            top: 68%;
            left: 44%;
            --translate-x: -260px;
            --translate-y: 200px;
            animation-duration: 5.1s;
            animation-delay: 0.4s;
          }
          .grid-square:nth-child(15) {
            top: 74%;
            left: 62%;
            --translate-x: 280px;
            --translate-y: -140px;
            animation-duration: 3.8s;
            animation-delay: 1.6s;
          }
          .grid-square:nth-child(16) {
            top: 58%;
            left: 88%;
            --translate-x: -180px;
            --translate-y: 160px;
            animation-duration: 4.5s;
            animation-delay: 2.3s;
          }
          .grid-square:nth-child(17) {
            top: 82%;
            left: 18%;
            --translate-x: 240px;
            --translate-y: -180px;
            animation-duration: 3.6s;
            animation-delay: 1.4s;
          }
          .grid-square:nth-child(18) {
            top: 26%;
            left: 92%;
            --translate-x: -220px;
            --translate-y: 120px;
            animation-duration: 4.8s;
            animation-delay: 0.6s;
          }
          .grid-square:nth-child(19) {
            top: 72%;
            left: 34%;
            --translate-x: 260px;
            --translate-y: -200px;
            animation-duration: 3.4s;
            animation-delay: 2.0s;
          }
          .grid-square:nth-child(20) {
            top: 46%;
            left: 96%;
            --translate-x: -280px;
            --translate-y: 180px;
            animation-duration: 4.3s;
            animation-delay: 1.7s;
          }

          .animations-disabled .grid-square {
            animation: none !important;
            opacity: 0 !important;
          }

          .animations-disabled .full-grid-square {
            opacity: 0 !important;
          }
        `}
      </style>
      {/* Static Grid Background */}
      <div className="mesh-gradient-background" aria-hidden="true"></div>
      
      {/* Retro Computing Grid Squares Overlay */}
      <div className={`grid-squares-overlay ${!animationsEnabled ? 'animations-disabled' : ''}`} aria-hidden="true">
        {/* Full Grid Squares - Randomly light up (21 total) */}
        {[...Array(21)].map((_, i) => (
          <div
            key={`full-grid-${i}`}
            ref={(el) => fullGridSquareRefs.current[i] = el}
            className="full-grid-square"
          ></div>
        ))}
        {/* Small glowing squares (20 total) */}
        {[...Array(20)].map((_, i) => (
          <div
            key={`grid-square-${i}`}
            ref={(el) => squaresRef.current[i] = el}
            className="grid-square"
          ></div>
        ))}
      </div>
    </>
  );
};

export default BackgroundAnimation;

