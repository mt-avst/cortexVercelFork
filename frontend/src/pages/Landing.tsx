import React, { useState, useEffect, useRef } from 'react';
import { demoLogin, demoUser2Login, demoAdminLogin, googleLogin } from '../api/client';
import { useAnimation } from '../contexts/AnimationContext';

const Landing: React.FC = () => {
  const [loginLoading, setLoginLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const squaresRef = useRef<(HTMLDivElement | null)[]>([]);
  const fullGridSquareRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { animationsEnabled } = useAnimation();
  const timeoutRefs = useRef<NodeJS.Timeout[]>([]);

  const handleDemoLogin = () => {
    setLoginLoading(true);
    demoLogin();
  };

  const handleDemoAdminLogin = () => {
    setLoginLoading(true);
    demoAdminLogin();
  };

  const handleGoogleLogin = () => {
    setGoogleLoading(true);
    googleLogin();
  };

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
    
    squaresRef.current.forEach((square, index) => {
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
      // Need to align relative to the actual grid background position on screen
      // Both mesh background and overlay use: top: -20%, left: -20%, width: 140%, height: 140%
      
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Get actual rendered positions (accounts for percentage rounding)
      const meshRect = meshBackground.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      
      // Get hero content elements to exclude from spawning
      // Use hero-content wrapper to get all content at once, or individual elements
      const heroContent = document.querySelector('.hero-content');
      const heroImage = document.querySelector('.hero-image');
      const heroHeadline = document.querySelector('.hero-headline');
      const heroSubtext = document.querySelector('.hero-subtext');
      const ctaPrimary = document.querySelector('.cta-primary');
      const demoButtonsContainer = document.querySelector('.demo-buttons-container');
      
      // Collect all exclusion zones (with larger padding for safety)
      const exclusionZones: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      const padding = 40; // Larger padding to ensure squares don't touch content
      
      // Add hero-content as a single large exclusion zone if it exists
      if (heroContent) {
        const rect = heroContent.getBoundingClientRect();
        exclusionZones.push({
          left: rect.left - padding,
          top: rect.top - padding,
          right: rect.right + padding,
          bottom: rect.bottom + padding
        });
      } else {
        // Fallback: use individual elements
        [heroImage, heroHeadline, heroSubtext, ctaPrimary, demoButtonsContainer].forEach((element) => {
          if (element) {
            const rect = element.getBoundingClientRect();
            exclusionZones.push({
              left: rect.left - padding,
              top: rect.top - padding,
              right: rect.right + padding,
              bottom: rect.bottom + padding
            });
          }
        });
      }
      
      // Grid starts at meshRect.left, meshRect.top (the background-position: 0 0)
      // Calculate available grid cells in viewport
      const viewportCols = Math.ceil(viewportWidth / 80) + 2;
      const viewportRows = Math.ceil(viewportHeight / 80) + 2;
      
      // Try to find a valid grid cell that doesn't overlap with content
      let attempts = 0;
      let randomCol = Math.floor(Math.random() * viewportCols);
      let randomRow = Math.floor(Math.random() * viewportRows);
      let targetScreenX = meshRect.left + (randomCol * 80);
      let targetScreenY = meshRect.top + (randomRow * 80);
      let overlaps = true;
      
      // Try up to 300 times to find a non-overlapping position
      // Always recalculate exclusion zones to ensure they're current
      while (overlaps && attempts < 300) {
        // Always get fresh exclusion zones to account for any layout changes
        exclusionZones.length = 0;
        const currentHeroContent = document.querySelector('.hero-content');
        
        if (currentHeroContent) {
          const rect = currentHeroContent.getBoundingClientRect();
          // Only add if element is actually visible and has dimensions
          if (rect.width > 0 && rect.height > 0) {
            exclusionZones.push({
              left: rect.left - padding,
              top: rect.top - padding,
              right: rect.right + padding,
              bottom: rect.bottom + padding
            });
          }
        } else {
          // Fallback: use individual elements with fresh lookups
          const currentHeroImage = document.querySelector('.hero-image');
          const currentHeroHeadline = document.querySelector('.hero-headline');
          const currentHeroSubtext = document.querySelector('.hero-subtext');
          const currentCtaPrimary = document.querySelector('.cta-primary');
          const currentDemoButtonsContainer = document.querySelector('.demo-buttons-container');
          
          [currentHeroImage, currentHeroHeadline, currentHeroSubtext, currentCtaPrimary, currentDemoButtonsContainer].forEach((element) => {
            if (element) {
              const rect = element.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                exclusionZones.push({
                  left: rect.left - padding,
                  top: rect.top - padding,
                  right: rect.right + padding,
                  bottom: rect.bottom + padding
                });
              }
            }
          });
        }
        
        // Skip overlap check if no exclusion zones found
        if (exclusionZones.length === 0) {
          overlaps = false;
          break;
        }
        
        randomCol = Math.floor(Math.random() * viewportCols);
        randomRow = Math.floor(Math.random() * viewportRows);
        
        // Calculate the absolute screen position where the grid cell would be
        targetScreenX = meshRect.left + (randomCol * 80);
        targetScreenY = meshRect.top + (randomRow * 80);
        
        // Check if this grid cell overlaps with any exclusion zone
        // Square is 80x80px
        const squareLeft = targetScreenX;
        const squareTop = targetScreenY;
        const squareRight = squareLeft + 80;
        const squareBottom = squareTop + 80;
        
        // Strict overlap detection: square must be completely outside all zones
        overlaps = exclusionZones.some(zone => {
          // Square overlaps if it's not completely outside the zone
          const isOutside = (squareRight < zone.left || squareLeft > zone.right || 
                            squareBottom < zone.top || squareTop > zone.bottom);
          return !isOutside;
        });
        
        attempts++;
      }
      
      // If we couldn't find a non-overlapping position after 100 attempts,
      // use the last tried position (should rarely happen)
      
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
          .landing-hero-wrapper {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            padding-top: 5vh;
            background-color: #0A091A;
            color: #E0E0E0;
            font-family: 'Inter', sans-serif;
            padding-left: 2rem;
            padding-right: 2rem;
            padding-bottom: 2rem;
            text-align: center;
            position: relative;
            overflow: hidden;
          }

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

          .animations-disabled .grid-square {
            animation: none !important;
            opacity: 0 !important;
          }

          .animations-disabled .full-grid-square {
            opacity: 0 !important;
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

          /* Random positions and timings for each square - positions randomize each cycle */
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

          .hero-content {
            position: relative;
            z-index: 10;
            max-width: 900px;
            width: 100%;
          }

          /* Hero Image - Above Title */
          .hero-image {
            max-width: 400px;
            width: 100%;
            height: auto;
            margin: 0 auto 2rem;
            display: block;
            opacity: 1;
          }

          .landing-hero-wrapper .hero-headline {
            color: #FFFFFF !important;
            font-size: 3.75rem;
            font-weight: 700;
            margin-bottom: 1rem;
            line-height: 1.1;
          }

          @media (max-width: 768px) {
            .landing-hero-wrapper .hero-headline {
              font-size: 2.5rem;
            }
          }

          .hero-subtext {
            color: #D1D5DB;
            font-size: 1.125rem;
            max-width: 44rem;
            margin-left: auto;
            margin-right: auto;
            line-height: 1.6;
            margin-bottom: 2.5rem;
          }

          @media (max-width: 768px) {
            .hero-subtext {
              font-size: 1rem;
            }
          }

          .text-spark {
            color: #FF4E50;
          }

          /* Base Button Style */
          .btn {
            display: inline-block;
            padding: 0.75rem 1.5rem;
            font-size: 0.9rem;
            font-weight: 500;
            border-radius: 8px;
            text-decoration: none;
            transition: all 0.2s ease-in-out;
            cursor: pointer;
            border: none;
            font-family: 'Inter', sans-serif;
          }

          .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }

          /* Primary CTA - Glassmorphic */
          .cta-primary {
            background-color: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            color: #FFFFFF;
            width: 100%;
            max-width: 380px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            margin: 0 auto 3rem;
          }

          .cta-primary:hover:not(:disabled) {
            background-color: rgba(255, 255, 255, 0.2);
          }

          /* Secondary CTA - Solid Accent */
          .cta-secondary {
            background-color: #FF4E50;
            color: #FFFFFF;
            border: 1px solid #FF4E50;
          }

          .cta-secondary:hover:not(:disabled) {
            filter: brightness(1.1);
          }

          /* Tertiary CTAs - Ghost */
          .cta-tertiary {
            background-color: transparent;
            border: 1px solid #FF4E50;
            color: #FF4E50;
          }

          .cta-tertiary:hover:not(:disabled) {
            background-color: #FF4E50;
            color: #FFFFFF;
          }

          /* Demo Buttons Container */
          .demo-buttons-container {
            display: flex;
            justify-content: center;
            gap: 1rem;
            flex-wrap: wrap;
            margin-bottom: 3rem;
          }

          @media (max-width: 640px) {
            .demo-buttons-container {
              flex-direction: column;
              align-items: center;
            }
            
            .demo-buttons-container .btn {
              width: 100%;
              max-width: 380px;
            }
          }

          /* Loading Spinner */
          .btn-spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid currentColor;
            border-right-color: transparent;
            border-radius: 50%;
            animation: spin 0.75s linear infinite;
          }

          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }
        `}
      </style>
      <div className={`landing-hero-wrapper ${!animationsEnabled ? 'animations-disabled' : ''}`}>
        {/* Static Grid Background */}
        <div className="mesh-gradient-background"></div>
        
        {/* Retro Computing Grid Squares Overlay */}
        <div className={`grid-squares-overlay ${!animationsEnabled ? 'animations-disabled' : ''}`}>
          {/* Full Grid Squares - Randomly light up (21 total) */}
          <div ref={(el) => fullGridSquareRefs.current[0] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[1] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[2] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[3] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[4] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[5] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[6] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[7] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[8] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[9] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[10] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[11] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[12] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[13] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[14] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[15] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[16] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[17] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[18] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[19] = el} className="full-grid-square"></div>
          <div ref={(el) => fullGridSquareRefs.current[20] = el} className="full-grid-square"></div>
          
          <div ref={(el) => squaresRef.current[0] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[1] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[2] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[3] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[4] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[5] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[6] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[7] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[8] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[9] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[10] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[11] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[12] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[13] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[14] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[15] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[16] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[17] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[18] = el} className="grid-square"></div>
          <div ref={(el) => squaresRef.current[19] = el} className="grid-square"></div>
        </div>
        
        {/* Hero Content */}
        <div className="hero-content">
          <img 
            src="/images/research-icon.png" 
            alt="Research and Innovation" 
            className="hero-image"
          />
          <h1 className="hero-headline">AdaptaLabs</h1>
          <p className="hero-subtext">
            Participate in research that shapes the future of our products. Browse opportunities, book
            sessions, and share feedback to help us build better experiences<span className="text-spark">.</span>
          </p>
          
          {/* Primary CTA - Sign in with Google */}
          <button 
            onClick={handleGoogleLogin} 
            className="btn cta-primary"
            disabled={googleLoading || loginLoading}
          >
            {googleLoading ? (
              <>
                <span className="btn-spinner"></span>
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                  <g fillRule="evenodd">
                    <path d="M9 3.48c1.69 0 2.83.73 3.48 1.34l2.54-2.48C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l2.91 2.26C4.6 5.05 6.62 3.48 9 3.48z" fill="#EA4335"/>
                    <path d="M17.64 9.2c0-.74-.06-1.28-.19-1.84H9v3.34h4.96c-.21 1.18-.84 2.18-1.79 2.91l2.75 2.13c1.66-1.52 2.72-3.77 2.72-6.54z" fill="#4285F4"/>
                    <path d="M3.88 10.78A5.54 5.54 0 0 1 3.58 9c0-.62.11-1.22.29-1.78L.96 4.96A9.008 9.008 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.92-2.26z" fill="#FBBC05"/>
                    <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.75-2.13c-.76.53-1.78.9-3.21.9-2.38 0-4.4-1.57-5.12-3.74L.96 13.04C2.45 15.98 5.48 18 9 18z" fill="#34A853"/>
                  </g>
                </svg>
                <span>Sign in with Google</span>
              </>
            )}
          </button>
          
          {/* Demo Buttons Container */}
          <div className="demo-buttons-container">
            <button 
              onClick={handleDemoLogin} 
              className="btn cta-secondary"
              disabled={loginLoading || googleLoading}
            >
              {loginLoading ? 'Signing in...' : 'Demo Login'}
            </button>
            <button 
              onClick={() => {
                setLoginLoading(true);
                demoUser2Login();
              }} 
              className="btn cta-tertiary"
              disabled={loginLoading || googleLoading}
            >
              {loginLoading ? 'Signing in...' : 'Demo User 2'}
            </button>
            <button 
              onClick={handleDemoAdminLogin} 
              className="btn cta-tertiary"
              disabled={loginLoading || googleLoading}
            >
              {loginLoading ? 'Signing in...' : 'Demo Admin'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default Landing;


