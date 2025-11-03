import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { getOpportunities } from '../api/client';
import { Opportunity } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useAnimation } from '../contexts/AnimationContext';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';
import Landing from './Landing';
import ErrorState from '../components/ErrorState';
import { Users, Lock, Globe } from 'lucide-react';

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [showBookingSuccess, setShowBookingSuccess] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedType, setSelectedType] = useState<string>('all');
  const itemsPerPage = 6; // 6 studies per page (2 rows of 3 cards)
  
  const { user, loading: authLoading, initialAuthCheck } = useAuth();
  const { animationsEnabled } = useAnimation();
  const squaresRef = useRef<(HTMLDivElement | null)[]>([]);
  const fullGridSquareRefs = useRef<(HTMLDivElement | null)[]>([]);
  const timeoutRefs = useRef<NodeJS.Timeout[]>([]);

  // Redirect admin users to admin dashboard
  if (!authLoading && initialAuthCheck && user?.role === 'researcher_admin') {
    return <Navigate to="/admin" replace />;
  }

  const loadOpportunities = async () => {
    try {
      setLoading(true);
      setError('');
      console.log('Loading opportunities...');
      const data = await getOpportunities({});
      console.log('Loaded opportunities:', data?.length || 0, 'opportunities');
      
      // Ensure data is an array and not HTML
      if (!Array.isArray(data)) {
        console.error('API returned non-array data (backend may not be deployed):', typeof data);
        setOpportunities([]);
        if (typeof data === 'string' && (data as string).includes('<!doctype html>')) {
          console.error('Received HTML instead of JSON - backend not deployed');
          setError('Backend API not available');
        } else {
          setError('No backend available. This is a production demo with frontend only.');
        }
      } else {
        setOpportunities(data);
        if (data.length > 0) {
          console.log('First opportunity sessions:', data[0].sessions?.length || 0);
        }
      }
      setCurrentPage(1); // Reset to first page when data loads
    } catch (err: any) {
      console.error('Error loading opportunities:', err);
      setError('Failed to load opportunities - backend not available in production demo');
      setOpportunities([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  };

  // Consolidated effect to load opportunities - prevents duplicate API calls
  useEffect(() => {
    // Only load if we're on the home page
    if (location.pathname !== '/') {
      return;
    }

    // Use a small delay to ensure component is fully mounted and navigation is complete
    // Also check if returning from admin to ensure fresh data
    const isReturningFromAdmin = document.referrer.includes('/admin');
    const delay = isReturningFromAdmin ? 150 : 50;

    const timer = setTimeout(() => {
      loadOpportunities();
    }, delay);

    return () => clearTimeout(timer);
  }, [location.pathname]); // Only re-run when pathname changes


  // Check for booking success parameter and show banner
  useEffect(() => {
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get('bookingSuccess') === 'true') {
      setShowBookingSuccess(true);
      // Clean up URL parameter
      navigate('/', { replace: true });
    }
  }, [location.search, navigate]);

  // Hide banner when location changes (navigation away)
  useEffect(() => {
    if (showBookingSuccess && location.pathname !== '/') {
      setShowBookingSuccess(false);
    }
  }, [location.pathname, showBookingSuccess]);

  

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'published': return 'badge bg-success text-white';
      case 'draft': return 'badge bg-warning text-white';
      case 'closed': return 'badge bg-secondary text-white';
      default: return 'badge bg-secondary text-white';
    }
  };

  // Filter and pagination logic
  const safeOpportunities = Array.isArray(opportunities) ? opportunities : [];
  
  // Filter opportunities by type
  const filteredOpportunities = selectedType === 'all' 
    ? safeOpportunities 
    : safeOpportunities.filter(opp => {
        // Handle concatenated type+status values (e.g., 'testpublished')
        const baseType = opp.type?.toLowerCase().replace(/published|draft|closed$/, '') || '';
        return baseType === selectedType.toLowerCase();
      });
  
  const totalPages = Math.ceil(filteredOpportunities.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedOpportunities = filteredOpportunities.slice(startIndex, endIndex);
  
  // Reset to page 1 when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedType]);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    // Scroll to top when page changes
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Randomize square positions on each animation cycle (only for logged-in users)
  useEffect(() => {
    if (!user) return; // Only run for logged-in users
    
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
  }, [user, animationsEnabled]);

  // Randomize full grid squares position and lighting - constrained to margins (only for logged-in users)
  useEffect(() => {
    if (!user) return; // Only run for logged-in users

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
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Get actual rendered positions
      const meshRect = meshBackground.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      
      // Get the main content container
      const mainContainer = document.querySelector('.home-content-container');
      if (!mainContainer) return;
      
      const containerRect = mainContainer.getBoundingClientRect();
      
      // Define margin zones - left and right of the container
      // Use a minimum margin width (e.g., 5% of viewport or 100px, whichever is larger)
      const minMarginWidth = Math.max(viewportWidth * 0.05, 100);
      
      // Left margin: from viewport left to container left minus padding
      const leftMarginStart = 0;
      const leftMarginEnd = Math.max(containerRect.left - 60, minMarginWidth);
      
      // Right margin: from container right plus padding to viewport right
      const rightMarginStart = Math.min(containerRect.right + 60, viewportWidth - minMarginWidth);
      const rightMarginEnd = viewportWidth;
      
      // Determine which margin to spawn in (50/50 chance)
      const useLeftMargin = Math.random() < 0.5;
      
      // Calculate grid boundaries
      const viewportCols = Math.ceil(viewportWidth / 80) + 2;
      const viewportRows = Math.ceil(viewportHeight / 80) + 2;
      
      // Find a valid grid cell in the chosen margin
      let attempts = 0;
      let randomCol = Math.floor(Math.random() * viewportCols);
      let randomRow = Math.floor(Math.random() * viewportRows);
      let targetScreenX = meshRect.left + (randomCol * 80);
      let targetScreenY = meshRect.top + (randomRow * 80);
      let isValid = false;
      
      while (!isValid && attempts < 500) {
        randomCol = Math.floor(Math.random() * viewportCols);
        randomRow = Math.floor(Math.random() * viewportRows);
        targetScreenX = meshRect.left + (randomCol * 80);
        targetScreenY = meshRect.top + (randomRow * 80);
        
        // Check if position is in the chosen margin zone
        const squareCenterX = targetScreenX + 40; // Center of 80px square
        
        if (useLeftMargin) {
          isValid = squareCenterX >= leftMarginStart && squareCenterX <= leftMarginEnd;
        } else {
          isValid = squareCenterX >= rightMarginStart && squareCenterX <= rightMarginEnd;
        }
        
        // Also exclude the title and text area (top portion of container)
        if (isValid) {
          const titleExclusionTop = containerRect.top - 40;
          const titleExclusionBottom = containerRect.top + 200; // Approximate height of title + text
          const squareTop = targetScreenY;
          const squareBottom = targetScreenY + 80;
          
          // If square overlaps title/text area, try again
          if (!(squareBottom < titleExclusionTop || squareTop > titleExclusionBottom)) {
            isValid = false;
          }
        }
        
        attempts++;
      }
      
      // If we couldn't find a valid position, skip this spawn
      if (!isValid) {
        return;
      }
      
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
  }, [user, animationsEnabled]);

  return (
    <>
      {/* Grid Background and Animations (only for logged-in users) */}
      {user && (
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

              .home-content-container {
                position: relative;
                z-index: 10;
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
        </>
      )}

      {!user && (
        <div className="mb-4">
          <Landing />
        </div>
      )}
      {/* Success Banner */}
      {showBookingSuccess && (
        <div className="booking-success-banner">
          <div className="container">
            <div className="row">
              <div className="col-12">
                <div className="alert alert-success mb-0 text-center">
                  <i className="bi bi-check-circle me-2"></i>
                  Session booked. Thanks!
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* AdaptaLabs Section */}
      {user && (
        <div className="container mt-4 home-content-container">
          <div className="row" style={{ marginBottom: 'var(--spacing-section)' }}>
            <div className="col-12">
              <h1 className="mb-3" style={{ marginBottom: '24px' }}>AdaptaLabs</h1>
              
              {/* Welcome text - half page width before wrapping */}
              <div className="row mb-4 align-items-end">
                <div className="col-md-6">
                  <p className="lead" style={{ lineHeight: 'var(--line-height-body)', fontSize: 'var(--font-size-body)', marginBottom: '16px' }}>
                    Welcome to AdaptaLabs - every action you take here strengthens our group, sparks new ideas and helps us to leverage all the talent and experience that we have across TAG
                  </p>
                  <p className="tagline" style={{ lineHeight: 'var(--line-height-body)', fontSize: 'var(--font-size-body)', fontWeight: '600', marginTop: '1rem', marginBottom: '0' }}>
                    Together we turn <span style={{ fontStyle: 'italic' }}>participation into progress</span>
                  </p>
                </div>
                {/* Type filter dropdown */}
                {!loading && !error && opportunities.length > 0 && (
                  <div className="col-md-6 d-flex justify-content-end">
                    <select 
                      id="opportunity-type-filter"
                      className="form-select" 
                      value={selectedType} 
                      onChange={(e) => setSelectedType(e.target.value)}
                    style={{
                      width: '352px',
                      backgroundColor: 'var(--bg-card)',
                      borderColor: 'var(--border-card)',
                      color: 'var(--text-primary)',
                      fontSize: 'var(--font-size-body)'
                    }}
                    >
                      <option value="all">Filter by study type</option>
                      <option value="survey">Survey</option>
                      <option value="poll">Poll</option>
                      <option value="interview">Interview</option>
                      <option value="test">App Testing</option>
                      <option value="question">Question</option>
                    </select>
                  </div>
                )}
              </div>
              
              {error && (
                <div className="mb-4">
                  <ErrorState
                    title="Failed to load studies"
                    message={error}
                    actionLabel="Reload Studies"
                    onAction={loadOpportunities}
                    icon="bi-exclamation-triangle"
                  />
                </div>
              )}
              
              {!loading && !error && opportunities.length === 0 && (
                <div className="text-center text-muted py-5">
                  <i className="bi bi-inbox" style={{ fontSize: '3rem', display: 'block', marginBottom: '1rem', opacity: 0.3 }}></i>
                  <h4 className="mb-3">No studies available</h4>
                  <p className="mb-2">No AdaptaLabs activities available at the moment.</p>
                  <p style={{ fontSize: '0.9rem' }}>Check back later for new opportunities to participate!</p>
                </div>
              )}
              
              {!loading && !error && opportunities.length > 0 && filteredOpportunities.length === 0 && (
                <div className="text-center text-muted py-5">
                  <i className="bi bi-funnel" style={{ fontSize: '3rem', display: 'block', marginBottom: '1rem', opacity: 0.3 }}></i>
                  <h4 className="mb-3">No opportunities found</h4>
                  <p className="mb-2">No opportunities match the selected filter.</p>
                  <button 
                    className="btn btn-outline-primary" 
                    onClick={() => setSelectedType('all')}
                    style={{ marginTop: '1rem' }}
                  >
                    Show All Types
                  </button>
                </div>
              )}
              
              {/* Loading skeleton cards */}
              {loading && (
                <div className="row">
                  {[...Array(6)].map((_, index) => (
                    <div key={index} className="col-md-6 col-lg-4 mb-4">
                      <div className="card h-100">
                        <div className="card-body d-flex flex-column">
                          <div className="mb-2">
                            <div className="badge bg-secondary" style={{ width: '80px', height: '24px' }}></div>
                          </div>
                          <div className="mb-3">
                            <div className="placeholder-glow">
                              <span className="placeholder col-11" style={{ height: '24px' }}></span>
                            </div>
                            <div className="placeholder-glow mt-2">
                              <span className="placeholder col-10" style={{ height: '16px' }}></span>
                            </div>
                          </div>
                          <div className="mt-auto">
                            <div className="placeholder-glow mb-2">
                              <span className="placeholder col-6" style={{ height: '14px' }}></span>
                            </div>
                            <div className="placeholder-glow">
                              <span className="placeholder col-12" style={{ height: '38px' }}></span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {!loading && !error && opportunities.length > 0 && filteredOpportunities.length > 0 && (
                <div className="bento-grid">
                  {paginatedOpportunities.map((opportunity) => {
                    // Make "New Feature Validation" and "User Interface Testing" wide
                    const isWide = opportunity.title === 'New Feature Validation' || opportunity.title === 'User Interface Testing';
                    
                    return (
                      <div 
                        key={opportunity.id} 
                        className={isWide ? 'bento-grid-item-wide' : 'bento-grid-item'}
                      >
                        <div className="card h-100">
                          <div className="card-body d-flex flex-column opportunity-card-body">
                            <div className="mb-4">
                              <span className={getTypeBadgeClass(opportunity.type)}>
                                {formatOpportunityType(opportunity.type)}
                              </span>
                            </div>
                            
                            <h5 className="card-title">{opportunity.title}</h5>
                            <p className="card-text" style={{ fontSize: 'var(--font-size-body)', lineHeight: '1.25', fontWeight: '400' }}>{opportunity.purpose_one_liner}</p>
                            
                            {opportunity.description_optional && (
                              <p className="card-text small">{opportunity.description_optional}</p>
                            )}
                            
                            <div className="mt-auto">
                              {(opportunity.type === 'test' || opportunity.type === 'interview') && (
                                <>
                                  <div className="mb-2">
                                    <small className="text-muted">
                                      <i className="bi bi-clock me-1"></i>
                                      {opportunity.default_duration_minutes} min
                                    </small>
                                  </div>
                                  {(opportunity.type === 'test' || opportunity.type === 'interview') && opportunity.sessions && opportunity.sessions.length > 0 && (
                                    <div className="mb-2">
                                      <small className="text-muted d-flex align-items-center">
                                        <Users size={14} className="me-1" style={{ opacity: 0.7 }} />
                                        {opportunity.sessions.reduce((total, session) => total + (session.remaining || 0), 0)} slots available
                                      </small>
                                    </div>
                                  )}
                                  {opportunity.participant_type_required !== 'specific' && (
                                    <div className="mb-2">
                                      <small className="text-muted d-flex align-items-center">
                                        {(() => {
                                          switch (opportunity.participant_type_required) {
                                            case 'any': 
                                              return (
                                                <>
                                                  <Globe size={14} className="me-1" style={{ opacity: 0.7 }} />
                                                  Open To All
                                                </>
                                              );
                                            case 'internal': 
                                              return (
                                                <>
                                                  <Lock size={14} className="me-1" style={{ opacity: 0.7 }} />
                                                  Internal
                                                </>
                                              );
                                            case 'external': 
                                              return (
                                                <>
                                                  <Globe size={14} className="me-1" style={{ opacity: 0.7 }} />
                                                  External
                                                </>
                                              );
                                            default: 
                                              return (
                                                <>
                                                  <Globe size={14} className="me-1" style={{ opacity: 0.7 }} />
                                                  Open To All
                                                </>
                                              );
                                          }
                                        })()}
                                      </small>
                                    </div>
                                  )}
                                </>
                              )}
                              
                              {opportunity.participant_type_required === 'specific' && opportunity.participant_type_specific_details && (
                                <div className="mb-2">
                                  <small className="text-muted">🎯 {opportunity.participant_type_specific_details}</small>
                                </div>
                              )}
                              
                              <div className="d-grid">
                                <button 
                                  className="btn btn-primary"
                                  onClick={() => navigate(`/opportunities/${opportunity.id}`)}
                                  aria-label={`View details for ${opportunity.title}`}
                                >
                                  View Details
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination Controls */}
              {!loading && !error && filteredOpportunities.length > itemsPerPage && (
                <div className="row mt-4">
                  <div className="col-12 d-flex justify-content-center align-items-center">
                    <nav aria-label="Page navigation">
                      <ul className="pagination mb-0">
                        <li className={`page-item ${currentPage === 1 ? 'disabled' : ''}`}>
                          <button 
                            className="page-link"
                            onClick={() => handlePageChange(currentPage - 1)}
                            disabled={currentPage === 1}
                            aria-label="Previous page"
                          >
                            <i className="bi bi-chevron-left"></i>
                          </button>
                        </li>
                        {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                          <li key={page} className={`page-item ${currentPage === page ? 'active' : ''}`}>
                            <button 
                              className="page-link"
                              onClick={() => handlePageChange(page)}
                              aria-label={`Go to page ${page}`}
                              aria-current={currentPage === page ? 'page' : undefined}
                            >
                              {page}
                            </button>
                          </li>
                        ))}
                        <li className={`page-item ${currentPage === totalPages ? 'disabled' : ''}`}>
                          <button 
                            className="page-link"
                            onClick={() => handlePageChange(currentPage + 1)}
                            disabled={currentPage === totalPages}
                            aria-label="Next page"
                          >
                            <i className="bi bi-chevron-right"></i>
                          </button>
                        </li>
                      </ul>
                    </nav>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Home;
