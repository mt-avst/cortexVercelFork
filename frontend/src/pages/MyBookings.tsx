import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Row, Col, Card, Button, Badge, Alert, Spinner } from 'react-bootstrap';
import { getMyBookings, cancelBooking, rescheduleBooking } from '../api/client';
import { BookingWithDetails } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useAnimation } from '../contexts/AnimationContext';
import ConfirmationModal from '../components/ConfirmationModal';

const MyBookings: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { animationsEnabled } = useAnimation();
  const squaresRef = useRef<(HTMLDivElement | null)[]>([]);
  const fullGridSquareRefs = useRef<(HTMLDivElement | null)[]>([]);
  const timeoutRefs = useRef<NodeJS.Timeout[]>([]);
  const [bookings, setBookings] = useState<{ upcoming: BookingWithDetails[]; past: BookingWithDetails[] }>({ upcoming: [], past: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<{ show: boolean; bookingId: string | null }>({ show: false, bookingId: null });
  const [rescheduleConfirm, setRescheduleConfirm] = useState<{ show: boolean; bookingId: string | null; targetSessionId: string | null }>({ show: false, bookingId: null, targetSessionId: null });

  useEffect(() => {
    loadBookings();
  }, []);

  // Refresh data when user returns to the page
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log('Page became visible, refreshing bookings data');
        loadBookings();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

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
      
      // Get page content elements to exclude from spawning
      const pageContent = document.querySelector('.my-bookings-content');
      
      // Collect all exclusion zones (with larger padding for safety)
      const exclusionZones: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      const padding = 40; // Larger padding to ensure squares don't touch content
      
      // Add page content as exclusion zone if it exists
      if (pageContent) {
        const rect = pageContent.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          exclusionZones.push({
            left: rect.left - padding,
            top: rect.top - padding,
            right: rect.right + padding,
            bottom: rect.bottom + padding
          });
        }
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
        const currentPageContent = document.querySelector('.my-bookings-content');
        
        if (currentPageContent) {
          const rect = currentPageContent.getBoundingClientRect();
          // Only add if element is actually visible and has dimensions
          if (rect.width > 0 && rect.height > 0) {
            exclusionZones.push({
              left: rect.left - padding,
              top: rect.top - padding,
              right: rect.right + padding,
              bottom: rect.bottom + padding
            });
          }
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

  const loadBookings = async () => {
    try {
      setLoading(true);
      setError(null);
      console.log('Loading my bookings...');
      const data = await getMyBookings();
      console.log('Loaded bookings data:', data);
      console.log('Upcoming bookings:', data.upcoming?.length || 0);
      console.log('Past bookings:', data.past?.length || 0);
      setBookings(data);
    } catch (err) {
      console.error('Error loading bookings:', err);
      setError('Failed to load bookings');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelBooking = (bookingId: string) => {
    setCancelConfirm({ show: true, bookingId });
  };

  const confirmCancelBooking = async () => {
    if (!cancelConfirm.bookingId) return;
    
    try {
      setActionLoading(cancelConfirm.bookingId);
      await cancelBooking(cancelConfirm.bookingId);
      await loadBookings(); // Reload to update the list
      setCancelConfirm({ show: false, bookingId: null });
    } catch (err: any) {
      console.error('Error cancelling booking:', err);
      // Show more specific error message if available
      let errorMessage = 'Failed to cancel booking';
      if (err?.response?.data?.error) {
        errorMessage = typeof err.response.data.error === 'string' 
          ? err.response.data.error 
          : err.response.data.error?.message || errorMessage;
      } else if (err?.response?.data?.details) {
        errorMessage = typeof err.response.data.details === 'string'
          ? err.response.data.details
          : errorMessage;
      } else if (err?.message) {
        errorMessage = typeof err.message === 'string' ? err.message : errorMessage;
      } else if (err?.response?.statusText) {
        errorMessage = err.response.statusText;
      }
      setError(`Failed to cancel booking: ${errorMessage}`);
    } finally {
      setActionLoading(null);
    }
  };

  const cancelCancelBooking = () => {
    setCancelConfirm({ show: false, bookingId: null });
  };

  const handleRescheduleBooking = (bookingId: string, targetSessionId: string) => {
    setRescheduleConfirm({ show: true, bookingId, targetSessionId });
  };

  const confirmRescheduleBooking = async () => {
    if (!rescheduleConfirm.bookingId || !rescheduleConfirm.targetSessionId) return;
    
    try {
      setActionLoading(rescheduleConfirm.bookingId);
      await rescheduleBooking(rescheduleConfirm.bookingId, { target_session_id: rescheduleConfirm.targetSessionId });
      await loadBookings(); // Reload to update the list
      setRescheduleConfirm({ show: false, bookingId: null, targetSessionId: null });
    } catch (err: any) {
      console.error('Error rescheduling booking:', err);
      // Show more specific error message if available
      const errorMessage = err?.response?.data?.error || err?.message || 'Failed to reschedule booking';
      setError(`Failed to reschedule booking: ${errorMessage}`);
    } finally {
      setActionLoading(null);
    }
  };

  const cancelRescheduleBooking = () => {
    setRescheduleConfirm({ show: false, bookingId: null, targetSessionId: null });
  };

  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'booked':
        return null; // Don't show "Booked" badge
      case 'cancelled':
        return <Badge bg="secondary">Cancelled</Badge>;
      default:
        return <Badge bg="light" text="dark">{status}</Badge>;
    }
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'test':
        return <Badge bg="primary">Test</Badge>;
      case 'poll':
        return <Badge bg="info">Poll</Badge>;
      case 'survey':
        return <Badge bg="warning" text="dark">Survey</Badge>;
      default:
        return <Badge bg="light" text="dark">{type}</Badge>;
    }
  };

  // Grid animation JSX (always render, even during loading or when not logged in)
  const gridAnimationJSX = (
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

          /* Random positions and timings for each square - positions randomize each cycle */
          /* Use nth-of-type - grid squares are divs starting at 22nd div (after 21 full-grid-square divs) */
          .grid-square:nth-of-type(22) {
            top: 12%;
            left: 8%;
            --translate-x: 240px;
            --translate-y: -160px;
            animation-duration: 3.2s;
            animation-delay: 0.3s;
          }
          .grid-square:nth-of-type(23) {
            top: 28%;
            left: 24%;
            --translate-x: -180px;
            --translate-y: 200px;
            animation-duration: 4.7s;
            animation-delay: 1.1s;
          }
          .grid-square:nth-of-type(24) {
            top: 15%;
            left: 42%;
            --translate-x: 320px;
            --translate-y: 120px;
            animation-duration: 2.8s;
            animation-delay: 0.7s;
          }
          .grid-square:nth-of-type(25) {
            top: 35%;
            left: 18%;
            --translate-x: -220px;
            --translate-y: -140px;
            animation-duration: 5.3s;
            animation-delay: 2.4s;
          }
          .grid-square:nth-of-type(26) {
            top: 22%;
            left: 58%;
            --translate-x: 180px;
            --translate-y: 240px;
            animation-duration: 3.9s;
            animation-delay: 0.9s;
          }
          .grid-square:nth-of-type(27) {
            top: 48%;
            left: 32%;
            --translate-x: -280px;
            --translate-y: 160px;
            animation-duration: 4.2s;
            animation-delay: 1.8s;
          }
          .grid-square:nth-of-type(28) {
            top: 38%;
            left: 56%;
            --translate-x: 200px;
            --translate-y: -180px;
            animation-duration: 3.5s;
            animation-delay: 0.5s;
          }
          .grid-square:nth-of-type(29) {
            top: 52%;
            left: 14%;
            --translate-x: -160px;
            --translate-y: 220px;
            animation-duration: 4.9s;
            animation-delay: 2.1s;
          }
          .grid-square:nth-of-type(30) {
            top: 18%;
            left: 68%;
            --translate-x: 260px;
            --translate-y: -120px;
            animation-duration: 3.1s;
            animation-delay: 1.3s;
          }
          .grid-square:nth-of-type(31) {
            top: 44%;
            left: 76%;
            --translate-x: -240px;
            --translate-y: 180px;
            animation-duration: 4.6s;
            animation-delay: 0.8s;
          }
          .grid-square:nth-of-type(32) {
            top: 62%;
            left: 26%;
            --translate-x: 300px;
            --translate-y: -200px;
            animation-duration: 3.7s;
            animation-delay: 1.9s;
          }
          .grid-square:nth-of-type(33) {
            top: 56%;
            left: 52%;
            --translate-x: -200px;
            --translate-y: 140px;
            animation-duration: 4.4s;
            animation-delay: 1.2s;
          }
          .grid-square:nth-of-type(34) {
            top: 32%;
            left: 84%;
            --translate-x: 220px;
            --translate-y: -160px;
            animation-duration: 3.3s;
            animation-delay: 2.6s;
          }
          .grid-square:nth-of-type(35) {
            top: 68%;
            left: 44%;
            --translate-x: -260px;
            --translate-y: 200px;
            animation-duration: 5.1s;
            animation-delay: 0.4s;
          }
          .grid-square:nth-of-type(36) {
            top: 74%;
            left: 62%;
            --translate-x: 280px;
            --translate-y: -140px;
            animation-duration: 3.8s;
            animation-delay: 1.6s;
          }
          .grid-square:nth-of-type(37) {
            top: 58%;
            left: 88%;
            --translate-x: -180px;
            --translate-y: 160px;
            animation-duration: 4.5s;
            animation-delay: 2.3s;
          }
          .grid-square:nth-of-type(38) {
            top: 82%;
            left: 18%;
            --translate-x: 240px;
            --translate-y: -180px;
            animation-duration: 3.6s;
            animation-delay: 1.4s;
          }
          .grid-square:nth-of-type(39) {
            top: 26%;
            left: 92%;
            --translate-x: -220px;
            --translate-y: 120px;
            animation-duration: 4.8s;
            animation-delay: 0.6s;
          }
          .grid-square:nth-of-type(40) {
            top: 72%;
            left: 34%;
            --translate-x: 260px;
            --translate-y: -200px;
            animation-duration: 3.4s;
            animation-delay: 2.0s;
          }
          .grid-square:nth-of-type(41) {
            top: 46%;
            left: 96%;
            --translate-x: -280px;
            --translate-y: 180px;
            animation-duration: 4.3s;
            animation-delay: 1.7s;
          }

          .my-bookings-content {
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
  );

  if (!user) {
    return (
      <>
        {gridAnimationJSX}
        <Container className="mt-4 my-bookings-content">
          <Alert variant="warning">
            Please log in to view your bookings.
          </Alert>
        </Container>
      </>
    );
  }

  if (loading) {
    return (
      <>
        {gridAnimationJSX}
        <Container className="mt-4 text-center my-bookings-content" aria-busy="true" aria-live="polite">
          <Spinner animation="border" role="status" aria-label="Loading bookings">
            <span className="visually-hidden">Loading...</span>
          </Spinner>
          <p className="mt-2">Loading your bookings...</p>
        </Container>
      </>
    );
  }

  return (
    <>
      {gridAnimationJSX}
      <Container className="mt-4 my-bookings-content">
        <Row>
          <Col>
            <div className="d-flex justify-content-between align-items-start">
              <div>
                <button
                  className="btn btn-outline-secondary mb-3"
                  onClick={() => navigate('/')}
                  title="Back to AdaptaLabs"
                >
                  <i className="bi bi-arrow-left me-1"></i>
                  Back to AdaptaLabs
                </button>
                <h2>My Bookings</h2>
                <p className="text-muted">Manage your AdaptaLabs activity bookings</p>
              </div>
              <button
                className="btn btn-outline-primary"
                onClick={loadBookings}
                disabled={loading}
                title="Refresh bookings"
              >
                <i className={`bi bi-arrow-clockwise ${loading ? 'spinner-border spinner-border-sm' : ''}`}></i>
                Refresh
              </button>
            </div>
          </Col>
        </Row>

      {error && (
        <Row className="mt-3">
          <Col>
            <Alert variant="danger" dismissible onClose={() => setError(null)}>
              {error}
            </Alert>
          </Col>
        </Row>
      )}

      {/* Upcoming Bookings */}
      <Row className="mt-4">
        <Col>
          <h4>Upcoming Bookings</h4>
          {bookings.upcoming.length === 0 ? (
            <Card>
              <Card.Body className="text-center text-muted">
                <p>No upcoming bookings</p>
              </Card.Body>
            </Card>
          ) : (
            <Row>
              {bookings.upcoming.map((booking) => (
                <Col md={6} lg={4} key={booking.id} className="mb-3">
                  <Card>
                    <Card.Header className="d-flex justify-content-between align-items-center">
                      <div>
                        {getStatusBadge(booking.status)}
                        {getTypeBadge(booking.opportunity_type)}
                      </div>
                    </Card.Header>
                    <Card.Body>
                      <Card.Title className="h6" style={{fontWeight: 'bold'}}>{booking.opportunity_title}</Card.Title>
                      <Card.Text className="small text-muted">
                        {booking.opportunity_purpose}
                      </Card.Text>
                      <div className="small">
                        <div><strong>Date:</strong> {formatDate(booking.session_start_time)}</div>
                        <div><strong>Time:</strong> {formatTime(booking.session_start_time)} - {formatTime(booking.session_end_time)}</div>
                        {booking.session_location && (
                          <div><strong>Location:</strong> {booking.session_location}</div>
                        )}
                        <div><strong>Owner:</strong> {booking.owner_name}</div>
                      </div>
                    </Card.Body>
                    <Card.Footer>
                      <div className="d-flex gap-2">
                        <Button
                          variant="outline-danger"
                          size="sm"
                          onClick={() => handleCancelBooking(booking.id)}
                          disabled={actionLoading === booking.id}
                        >
                          {actionLoading === booking.id ? (
                            <Spinner size="sm" aria-label="Processing cancellation" aria-busy="true" />
                          ) : (
                            'Cancel'
                          )}
                        </Button>
                        {/* Reschedule functionality will be implemented in a future release */}
                        <Button
                          variant="outline-primary"
                          size="sm"
                          disabled
                        >
                          Reschedule
                        </Button>
                      </div>
                    </Card.Footer>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </Col>
      </Row>

      {/* Past Bookings */}
      <Row className="mt-5">
        <Col>
          <h4>Past Bookings</h4>
          {bookings.past.length === 0 ? (
            <Card>
              <Card.Body className="text-center text-muted">
                <p>No past bookings</p>
              </Card.Body>
            </Card>
          ) : (
            <Row>
              {bookings.past.map((booking) => (
                <Col md={6} lg={4} key={booking.id} className="mb-3">
                  <Card className="opacity-75">
                    <Card.Header className="d-flex justify-content-between align-items-center">
                      <div>
                        {getStatusBadge(booking.status)}
                        {getTypeBadge(booking.opportunity_type)}
                      </div>
                    </Card.Header>
                    <Card.Body>
                      <Card.Title className="h6" style={{fontWeight: 'bold'}}>{booking.opportunity_title}</Card.Title>
                      <Card.Text className="small text-muted">
                        {booking.opportunity_purpose}
                      </Card.Text>
                      <div className="small">
                        <div><strong>Date:</strong> {formatDate(booking.session_start_time)}</div>
                        <div><strong>Time:</strong> {formatTime(booking.session_start_time)} - {formatTime(booking.session_end_time)}</div>
                        {booking.session_location && (
                          <div><strong>Location:</strong> {booking.session_location}</div>
                        )}
                        <div><strong>Owner:</strong> {booking.owner_name}</div>
                        {booking.cancelled_at && (
                          <div><strong>Cancelled:</strong> {formatDateTime(booking.cancelled_at)}</div>
                        )}
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </Col>
      </Row>

      <ConfirmationModal
        show={cancelConfirm.show}
        title="Cancel Booking"
        message="Are you sure you want to cancel this booking? This action will free up the slot for other participants and cannot be undone."
        confirmLabel="Yes, Cancel Booking"
        cancelLabel="Keep My Booking"
        variant="danger"
        onConfirm={confirmCancelBooking}
        onCancel={cancelCancelBooking}
      />

      <ConfirmationModal
        show={rescheduleConfirm.show}
        title="Reschedule Booking"
        message="Are you sure you want to reschedule this booking? This action will move your booking to the selected time slot, free up your current slot, and cannot be undone."
        confirmLabel="Yes, Reschedule"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={confirmRescheduleBooking}
        onCancel={cancelRescheduleBooking}
      />
      </Container>
    </>
  );
};

export default MyBookings;