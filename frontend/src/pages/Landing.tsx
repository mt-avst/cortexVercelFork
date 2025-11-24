import React, { useState, useEffect, useRef, useMemo } from 'react';
import { demoLogin, demoAdminLogin, googleLogin } from '../api/client';
import { useAnimation } from '../contexts/AnimationContext';

const Landing: React.FC = () => {
  const [loginLoading, setLoginLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const squaresRef = useRef<(HTMLDivElement | null)[]>([]);
  const fullGridSquareRefs = useRef<(HTMLDivElement | null)[]>([]);
  const coralDotsRef = useRef<(HTMLDivElement | null)[]>([]);
  const { animationsEnabled } = useAnimation();
  const timeoutRefs = useRef<NodeJS.Timeout[]>([]);
  const glassGlowTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Generate stable opacity values for each dot (persists across renders)
  const dotOpacities = useMemo(() => {
    return Array.from({ length: 30 }, () => 0.2 + Math.random() * 0.8);
  }, []);

  // Generate stable color values for each dot (persists across renders)
  // Varying hue (red/pink/coral: 340-360°), saturation (70-100%), and lightness (25-40%)
  const dotColors = useMemo(() => {
    return Array.from({ length: 30 }, () => {
      const hue = 340 + Math.random() * 20; // 340-360 degrees (red to pink-coral range)
      const saturation = 70 + Math.random() * 30; // 70-100%
      const lightness = 25 + Math.random() * 15; // 25-40% (darker range)
      return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    });
  }, []);

  // Helper function to convert HSL to RGB
  const hslToRgb = (hslColor: string): [number, number, number] => {
    const hslMatch = hslColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    let r = 255, g = 78, b = 80; // fallback to original coral
    if (hslMatch) {
      const h = parseInt(hslMatch[1]) / 360;
      const s = parseInt(hslMatch[2]) / 100;
      const l = parseInt(hslMatch[3]) / 100;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs((h * 6) % 2 - 1));
      const m = l - c / 2;
      if (h < 1/6) { r = c; g = x; b = 0; }
      else if (h < 2/6) { r = x; g = c; b = 0; }
      else if (h < 3/6) { r = 0; g = c; b = x; }
      else if (h < 4/6) { r = 0; g = x; b = c; }
      else if (h < 5/6) { r = x; g = 0; b = c; }
      else { r = c; g = 0; b = x; }
      r = Math.round((r + m) * 255);
      g = Math.round((g + m) * 255);
      b = Math.round((b + m) * 255);
    }
    return [r, g, b];
  };

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
      
      // Grid starts at meshRect.left, meshRect.top (the background-position: 0 0)
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

  // Randomize coral dot positions and directions
  useEffect(() => {
    if (!animationsEnabled) {
      // Hide dots when animations are disabled
      coralDotsRef.current.forEach((dot) => {
        if (dot) {
          dot.style.opacity = '0';
        }
      });
      return;
    }

    const dots = coralDotsRef.current.filter(dot => dot !== null);
    if (dots.length === 0) return;

    // Randomize positions at grid intersections (multiples of 80px)
    const randomizeDotPositions = () => {
      coralDotsRef.current.forEach((dot, originalIndex) => {
        if (!dot) return;

        const isHorizontal = dot.classList.contains('coral-dot-horizontal');
        const isVertical = dot.classList.contains('coral-dot-vertical');

        if (isHorizontal) {
          // Horizontal dots: random Y at grid intersection, start from left
          const viewportHeight = window.innerHeight;
          const maxGridRows = Math.ceil(viewportHeight / 80) + 4;
          const randomRow = Math.floor(Math.random() * maxGridRows);
          const topPosition = randomRow * 80;
          
          dot.style.top = `${topPosition}px`;
          dot.style.left = '0px';
        } else if (isVertical) {
          // Vertical dots: random X at grid intersection, start from top
          const viewportWidth = window.innerWidth;
          const maxGridCols = Math.ceil(viewportWidth / 80) + 4;
          const randomCol = Math.floor(Math.random() * maxGridCols);
          const leftPosition = randomCol * 80;
          
          dot.style.top = '0px';
          dot.style.left = `${leftPosition}px`;
        }

        // Randomize animation duration (12-20 seconds)
        const duration = 12 + Math.random() * 8;
        dot.style.animationDuration = `${duration}s`;
        
        // Randomize animation delay (0-6 seconds)
        const delay = Math.random() * 6;
        dot.style.animationDelay = `${delay}s`;
        
        // Use stable opacity from dotOpacities array (preserves depth effect)
        const opacity = dotOpacities[originalIndex];
        dot.style.setProperty('opacity', opacity.toString(), 'important');
        
        // Use stable color from dotColors array
        const color = dotColors[originalIndex];
        dot.style.setProperty('background-color', color, 'important');
        
        // Convert HSL to RGB for box-shadow rgba
        const [r, g, b] = hslToRgb(color);
        
        // Adjust box-shadow intensity based on opacity for more realistic depth
        const shadowIntensity = opacity;
        dot.style.setProperty('box-shadow', `0 0 ${12 * shadowIntensity}px ${color}, 0 0 ${20 * shadowIntensity}px rgba(${r}, ${g}, ${b}, ${0.8 * shadowIntensity})`, 'important');
      });
    };

    // Randomize initially
    randomizeDotPositions();

    // Re-randomize positions periodically (every 30-60 seconds)
    const reRandomizeInterval = setInterval(() => {
      randomizeDotPositions();
    }, 30000 + Math.random() * 30000);

    return () => {
      clearInterval(reRandomizeInterval);
    };
  }, [animationsEnabled, dotOpacities, dotColors]);

  // Coral dots traveling along grid lines with glass intersection detection
  useEffect(() => {
    if (!animationsEnabled) {
      return;
    }

    const dots = coralDotsRef.current.filter(dot => dot !== null);
    if (dots.length === 0) return;

    const heroContent = document.querySelector('.hero-content');
    if (!heroContent) return;

    // Detect when a dot intersects with glass border and trigger glow
    const checkGlassIntersection = (dot: HTMLDivElement) => {
      const dotRect = dot.getBoundingClientRect();
      const glassRect = heroContent.getBoundingClientRect();
      
      // Expand glass rect to include border area (0.5rem + border width)
      const borderWidth = 1;
      const padding = 8; // Account for the -0.5rem offset
      const glassLeft = glassRect.left - padding;
      const glassTop = glassRect.top - padding;
      const glassRight = glassRect.right + padding;
      const glassBottom = glassRect.bottom + padding;
      
      const dotCenterX = dotRect.left + dotRect.width / 2;
      const dotCenterY = dotRect.top + dotRect.height / 2;
      
      // Check if dot is near any edge of the glass (within 10px)
      const threshold = 10;
      const nearTop = dotCenterY >= glassTop - threshold && dotCenterY <= glassTop + threshold && 
                     dotCenterX >= glassLeft && dotCenterX <= glassRight;
      const nearBottom = dotCenterY >= glassBottom - threshold && dotCenterY <= glassBottom + threshold && 
                        dotCenterX >= glassLeft && dotCenterX <= glassRight;
      const nearLeft = dotCenterX >= glassLeft - threshold && dotCenterX <= glassLeft + threshold && 
                      dotCenterY >= glassTop && dotCenterY <= glassBottom;
      const nearRight = dotCenterX >= glassRight - threshold && dotCenterX <= glassRight + threshold && 
                       dotCenterY >= glassTop && dotCenterY <= glassBottom;
      
      if (nearTop || nearBottom || nearLeft || nearRight) {
        // Trigger glass glow
        heroContent.classList.add('glass-glow');
        
        // Clear existing timeout if any
        if (glassGlowTimeoutRef.current) {
          clearTimeout(glassGlowTimeoutRef.current);
        }
        
        // Remove glow after 0.5 seconds
        glassGlowTimeoutRef.current = setTimeout(() => {
          heroContent.classList.remove('glass-glow');
        }, 500);
      }
    };

    // Set up intersection checking for each dot
    const intervalId = setInterval(() => {
      dots.forEach((dot) => {
        if (dot) {
          checkGlassIntersection(dot);
        }
      });
    }, 50); // Check every 50ms for responsive detection

    return () => {
      clearInterval(intervalId);
      if (glassGlowTimeoutRef.current) {
        clearTimeout(glassGlowTimeoutRef.current);
      }
      heroContent.classList.remove('glass-glow');
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
            pointer-events: none;
            overflow: visible;
          }

          /* Base grid layer */
          .mesh-gradient-background::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-image: 
              linear-gradient(rgba(255, 78, 80, 0.3) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255, 78, 80, 0.3) 1px, transparent 1px);
            background-size: 80px 80px;
            background-position: 0 0;
            opacity: 0.5;
          }

          /* Glowing overlay that cycles through red variations */
          .mesh-gradient-background::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-size: 80px 80px;
            background-position: 0 0;
            animation: gentleGridGlow 8s ease-in-out infinite;
            opacity: 0.6;
            mix-blend-mode: screen;
          }

          @keyframes gentleGridGlow {
            0% {
              background-image: 
                linear-gradient(rgba(255, 78, 80, 0.25) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 78, 80, 0.25) 1px, transparent 1px);
            }
            25% {
              background-image: 
                linear-gradient(rgba(255, 100, 90, 0.3) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 100, 90, 0.3) 1px, transparent 1px);
            }
            50% {
              background-image: 
                linear-gradient(rgba(255, 65, 75, 0.35) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 65, 75, 0.35) 1px, transparent 1px);
            }
            75% {
              background-image: 
                linear-gradient(rgba(255, 90, 85, 0.3) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 90, 85, 0.3) 1px, transparent 1px);
            }
            100% {
              background-image: 
                linear-gradient(rgba(255, 78, 80, 0.25) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 78, 80, 0.25) 1px, transparent 1px);
            }
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

          /* Coral dots container - matches grid background position */
          .coral-dots-container {
            position: fixed;
            top: -20%;
            left: -20%;
            width: 140%;
            height: 140%;
            z-index: 3;
            pointer-events: none;
            overflow: visible;
          }

          /* Horizontal travel animation - dots move left to right along grid lines */
          /* The animation distance ensures dots move across the full container width */
          /* Since container is 140vw, we move from 0 to 140vw to travel full width */
          @keyframes travelHorizontal {
            0% {
              transform: translateX(-4px);
            }
            100% {
              transform: translateX(calc(1.4 * 100vw - 4px));
            }
          }

          /* Vertical travel animation - dots move top to bottom along grid lines */
          /* The animation distance ensures dots move across the full container height */
          /* Since container is 140vh, we move from 0 to 140vh to travel full height */
          @keyframes travelVertical {
            0% {
              transform: translateY(-4px);
            }
            100% {
              transform: translateY(calc(1.4 * 100vh - 4px));
            }
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
            padding: 0.75rem;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
          }

          /* Glass effect behind hero content */
          .hero-content::before {
            content: '';
            position: absolute;
            top: -0.5rem;
            left: -0.5rem;
            right: -0.5rem;
            bottom: -0.5rem;
            z-index: -1;
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 78, 80, 0.3);
            border-radius: 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
          }

          /* Glass border glow effect when dot reaches it */
          .hero-content.glass-glow::before {
            border-color: rgba(255, 78, 80, 0.3);
            box-shadow: 0 0 12px rgba(255, 78, 80, 0.15), 0 0 24px rgba(255, 78, 80, 0.1), 0 8px 32px rgba(0, 0, 0, 0.3);
          }

          /* Coral dots that travel along grid lines */
          .coral-dot {
            position: absolute;
            width: 8px;
            height: 8px;
            background-color: #FF4E50;
            border-radius: 50%;
            /* Box-shadow will be set dynamically based on opacity */
            z-index: 3;
            pointer-events: none;
            /* Opacity will be set dynamically for depth effect - default removed */
          }

          /* Horizontal dots - positioned at exact grid Y intersections, centered on grid line */
          /* They move horizontally, staying on their Y grid line */
          .coral-dot-horizontal {
            /* Center dot on grid line (half width = 4px) */
            margin-top: -4px;
            margin-left: -4px;
          }

          /* Vertical dots - positioned at exact grid X intersections, centered on grid line */
          /* They move vertically, staying on their X grid line */
          .coral-dot-vertical {
            /* Center dot on grid line (half width = 4px) */
            margin-top: -4px;
            margin-left: -4px;
          }

          /* Hero Image - Above Title */
          .hero-image {
            max-width: 400px;
            width: 100%;
            height: auto;
            margin: 0 auto 2rem;
            display: block;
            opacity: 1;
            align-self: center;
          }

          .landing-hero-wrapper .hero-headline {
            color: #FFFFFF !important;
            font-size: 3.75rem;
            font-weight: 700;
            margin-bottom: 1rem;
            line-height: 1.1;
            text-align: center;
            width: 100%;
            position: relative;
            display: inline-block;
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
            text-align: center;
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
            font-size: 18px !important; /* Increase font size for better contrast compliance (meets 3.0:1 ratio for large text ≥18px) */
            width: 100%;
            max-width: 380px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            margin: 0 auto 3rem;
            align-self: center;
          }

          .cta-primary:hover:not(:disabled) {
            background-color: rgba(255, 255, 255, 0.2);
          }

          /* Secondary CTA - Solid Accent */
          .cta-secondary {
            background-color: #FF4E50;
            color: #FFFFFF;
            border: 1px solid #FF4E50;
            font-size: 18px !important; /* Increase font size for better contrast compliance (meets 3.0:1 ratio for large text ≥18px) */
          }

          .cta-secondary:hover:not(:disabled) {
            filter: brightness(1.1);
          }

          /* Tertiary CTAs - Ghost */
          .cta-tertiary {
            background-color: transparent;
            border: 1px solid #FF4E50;
            color: #FF4E50;
            font-size: 18px !important; /* Increase font size for better contrast compliance (meets 3.0:1 ratio for large text ≥18px) */
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
            width: 100%;
            align-self: center;
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
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top: 2px solid #FFFFFF;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }

          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }
          
          /* Beta Badge - Square Lozenge on Title */
          .beta-badge {
            position: absolute;
            top: -0.5rem;
            right: -4rem;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0.4rem 0.75rem;
            background-color: #FF4E50;
            color: #FFFFFF;
            font-size: 0.75rem;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            border-radius: 6px;
            box-shadow: 0 2px 8px rgba(255, 78, 80, 0.3);
            white-space: nowrap;
            z-index: 10;
          }
          
          @media (max-width: 768px) {
            .beta-badge {
              top: -0.4rem;
              right: -3rem;
              font-size: 0.65rem;
              padding: 0.35rem 0.6rem;
            }
          }
          
          @media (max-width: 480px) {
            .beta-badge {
              top: -0.3rem;
              right: -2.5rem;
              font-size: 0.6rem;
              padding: 0.3rem 0.5rem;
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
        
        {/* Coral dots traveling along grid lines - 30 dots randomly positioned */}
        <div className="coral-dots-container">
          {/* Generate 30 dots - 15 horizontal, 15 vertical, randomly positioned */}
          {Array.from({ length: 30 }).map((_, index) => {
            const isHorizontal = index < 15;
            // Use stable opacity and color values from useMemo
            const dotOpacity = dotOpacities[index];
            const dotColor = dotColors[index];
            const shadowIntensity = dotOpacity;
            
            // Convert HSL to RGB for box-shadow rgba
            const [r, g, b] = hslToRgb(dotColor);
            
            return (
              <div
                key={index}
                ref={(el) => {
                  coralDotsRef.current[index] = el;
                  // Set opacity and color immediately when ref is assigned
                  if (el) {
                    el.style.setProperty('opacity', dotOpacity.toString(), 'important');
                    el.style.setProperty('background-color', dotColor, 'important');
                    el.style.setProperty('box-shadow', `0 0 ${12 * shadowIntensity}px ${dotColor}, 0 0 ${20 * shadowIntensity}px rgba(${r}, ${g}, ${b}, ${0.8 * shadowIntensity})`, 'important');
                  }
                }}
                className={`coral-dot ${isHorizontal ? 'coral-dot-horizontal' : 'coral-dot-vertical'}`}
                style={{
                  animation: isHorizontal ? 'travelHorizontal 15s linear infinite' : 'travelVertical 15s linear infinite',
                  animationDelay: '0s',
                  opacity: dotOpacity,
                  backgroundColor: dotColor,
                  boxShadow: `0 0 ${12 * shadowIntensity}px ${dotColor}, 0 0 ${20 * shadowIntensity}px rgba(${r}, ${g}, ${b}, ${0.8 * shadowIntensity})`
                }}
              ></div>
            );
          })}
        </div>
        
        {/* Hero Content */}
        <div className="hero-content">
          <img 
            src="/images/research-icon.png" 
            alt="Research and Innovation" 
            className="hero-image"
          />
          <h1 className="hero-headline">
            AdaptaLabs
            <span className="beta-badge">BETA</span>
          </h1>
          <p className="hero-subtext">
            Participate in research that shapes the future of our products. Browse opportunities, book
            sessions, and share feedback to help us build better experiences<span className="text-spark">.</span>
          </p>
          
          {/* Primary CTA - Sign in with Google */}
          <button 
            onClick={handleGoogleLogin} 
            className="btn cta-primary"
            disabled={googleLoading || loginLoading}
            aria-busy={googleLoading || loginLoading}
            aria-label={googleLoading ? "Signing in with Google" : "Sign in with Google"}
          >
            {googleLoading ? (
              <>
                <span className="btn-spinner" role="status" aria-label="Signing in" aria-hidden="true"></span>
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
          
          {/* Demo Buttons Container - Show 1 demo user and 1 admin button */}
          <div className="demo-buttons-container">
            <button 
              onClick={handleDemoLogin} 
              className="btn cta-secondary"
              disabled={loginLoading || googleLoading}
              aria-busy={loginLoading}
              aria-label={loginLoading ? "Signing in..." : "Demo Login"}
            >
              {loginLoading ? 'Signing in...' : 'Demo Login'}
            </button>
            <button 
              onClick={handleDemoAdminLogin} 
              className="btn cta-tertiary"
              disabled={loginLoading || googleLoading}
              aria-busy={loginLoading}
              aria-label={loginLoading ? "Signing in..." : "Demo Admin"}
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


