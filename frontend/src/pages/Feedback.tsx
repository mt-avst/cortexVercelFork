import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useAnimation } from '../contexts/AnimationContext';

const Feedback: React.FC = () => {
  const { user } = useAuth();
  const { animationsEnabled } = useAnimation();
  const [feedback, setFeedback] = useState('');
  const [category, setCategory] = useState<'bug' | 'feature' | 'question' | 'other'>('bug');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Animation refs
  const squaresRef = useRef<(HTMLDivElement | null)[]>([]);
  const fullGridSquareRefs = useRef<(HTMLDivElement | null)[]>([]);
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

  // Randomize full grid squares position and lighting
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
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Get actual rendered positions
      const meshRect = meshBackground.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      
      // Get the main content container
      const mainContainer = document.querySelector('.feedback-content-container');
      if (!mainContainer) return;
      
      const containerRect = mainContainer.getBoundingClientRect();
      
      // Define margin zones - left and right of the container
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
  }, [animationsEnabled]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    
    try {
      const token = localStorage.getItem('token');
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          category,
          feedback,
          userAgent: navigator.userAgent,
          url: window.location.href,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to submit feedback');
      }

      setSubmitted(true);
    } catch (err) {
      console.error('Error submitting feedback:', err);
      setError('Failed to submit feedback. Please try again later or email nfine@adaptavist.com directly.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Styles for animation and dark card
  const styles = `
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
    .grid-square:nth-child(1) { top: 12%; left: 8%; --translate-x: 240px; --translate-y: -160px; animation-duration: 3.2s; animation-delay: 0.3s; }
    .grid-square:nth-child(2) { top: 28%; left: 24%; --translate-x: -180px; --translate-y: 200px; animation-duration: 4.7s; animation-delay: 1.1s; }
    .grid-square:nth-child(3) { top: 15%; left: 42%; --translate-x: 320px; --translate-y: 120px; animation-duration: 2.8s; animation-delay: 0.7s; }
    .grid-square:nth-child(4) { top: 35%; left: 18%; --translate-x: -220px; --translate-y: -140px; animation-duration: 5.3s; animation-delay: 2.4s; }
    .grid-square:nth-child(5) { top: 22%; left: 58%; --translate-x: 180px; --translate-y: 240px; animation-duration: 3.9s; animation-delay: 0.9s; }
    .grid-square:nth-child(6) { top: 48%; left: 32%; --translate-x: -280px; --translate-y: 160px; animation-duration: 4.2s; animation-delay: 1.8s; }
    .grid-square:nth-child(7) { top: 38%; left: 56%; --translate-x: 200px; --translate-y: -180px; animation-duration: 3.5s; animation-delay: 0.5s; }
    .grid-square:nth-child(8) { top: 52%; left: 14%; --translate-x: -160px; --translate-y: 220px; animation-duration: 4.9s; animation-delay: 2.1s; }
    .grid-square:nth-child(9) { top: 18%; left: 68%; --translate-x: 260px; --translate-y: -120px; animation-duration: 3.1s; animation-delay: 1.3s; }
    .grid-square:nth-child(10) { top: 44%; left: 76%; --translate-x: -240px; --translate-y: 180px; animation-duration: 4.6s; animation-delay: 0.8s; }
    .grid-square:nth-child(11) { top: 62%; left: 26%; --translate-x: 300px; --translate-y: -200px; animation-duration: 3.7s; animation-delay: 1.9s; }
    .grid-square:nth-child(12) { top: 56%; left: 52%; --translate-x: -200px; --translate-y: 140px; animation-duration: 4.4s; animation-delay: 1.2s; }
    .grid-square:nth-child(13) { top: 32%; left: 84%; --translate-x: 220px; --translate-y: -160px; animation-duration: 3.3s; animation-delay: 2.6s; }
    .grid-square:nth-child(14) { top: 68%; left: 44%; --translate-x: -260px; --translate-y: 200px; animation-duration: 5.1s; animation-delay: 0.4s; }
    .grid-square:nth-child(15) { top: 74%; left: 62%; --translate-x: 280px; --translate-y: -140px; animation-duration: 3.8s; animation-delay: 1.6s; }
    .grid-square:nth-child(16) { top: 58%; left: 88%; --translate-x: -180px; --translate-y: 160px; animation-duration: 4.5s; animation-delay: 2.3s; }
    .grid-square:nth-child(17) { top: 82%; left: 18%; --translate-x: 240px; --translate-y: -180px; animation-duration: 3.6s; animation-delay: 1.4s; }
    .grid-square:nth-child(18) { top: 26%; left: 92%; --translate-x: -220px; --translate-y: 120px; animation-duration: 4.8s; animation-delay: 0.6s; }
    .grid-square:nth-child(19) { top: 72%; left: 34%; --translate-x: 260px; --translate-y: -200px; animation-duration: 3.4s; animation-delay: 2.0s; }
    .grid-square:nth-child(20) { top: 46%; left: 96%; --translate-x: -280px; --translate-y: 180px; animation-duration: 4.3s; animation-delay: 1.7s; }

    .feedback-content-container {
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

    /* Feedback Card Styles - Dark Glassmorphism */
    .feedback-card {
      background-color: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      color: #E0E0E0;
    }
    
    .feedback-card .card-header {
      background-color: transparent;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    .feedback-card .card-body {
      background-color: transparent;
    }
    
    .feedback-card h2, 
    .feedback-card h5,
    .feedback-card .form-label,
    .feedback-card p {
      color: #E0E0E0;
    }

    .feedback-card .text-muted {
      color: rgba(224, 224, 224, 0.7) !important;
    }
    
    .feedback-card .form-control, 
    .feedback-card .form-select {
      background-color: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #E0E0E0;
    }
    
    .feedback-card .form-control:focus, 
    .feedback-card .form-select:focus {
      background-color: rgba(0, 0, 0, 0.3);
      border-color: rgba(255, 255, 255, 0.3);
      color: #FFFFFF;
      box-shadow: 0 0 0 0.25rem rgba(255, 255, 255, 0.1);
    }

    .feedback-card .form-text {
      color: rgba(224, 224, 224, 0.6);
    }

    .feedback-card .bg-light {
      background-color: rgba(255, 255, 255, 0.05) !important;
      color: #E0E0E0;
    }
    
    .feedback-card a {
      color: #FF4E50;
    }
    
    .feedback-card a:hover {
      color: #ff6b6d;
      text-decoration: underline;
    }
    
    .feedback-card .btn-outline-secondary {
      border-color: rgba(255, 255, 255, 0.3);
      color: #E0E0E0;
    }
    
    .feedback-card .btn-outline-secondary:hover {
      background-color: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.5);
      color: #FFFFFF;
    }
  `;

  if (submitted) {
    return (
      <>
        <style>{styles}</style>
        <div className="mesh-gradient-background"></div>
        <div className={`grid-squares-overlay ${!animationsEnabled ? 'animations-disabled' : ''}`}>
          {Array.from({ length: 21 }).map((_, i) => (
            <div key={`full-${i}`} ref={(el) => fullGridSquareRefs.current[i] = el} className="full-grid-square"></div>
          ))}
          {Array.from({ length: 20 }).map((_, i) => (
            <div key={`grid-${i}`} ref={(el) => squaresRef.current[i] = el} className="grid-square"></div>
          ))}
        </div>

        <div className="container mt-5 feedback-content-container">
          <div className="row justify-content-center">
            <div className="col-md-8">
              <div className="card feedback-card">
                <div className="card-body text-center">
                  <i className="bi bi-check-circle text-success" style={{ fontSize: '3rem' }}></i>
                  <h2 className="mt-3">Thank You!</h2>
                  <p className="lead">Your feedback has been submitted successfully.</p>
                  <p>We appreciate you taking the time to help us improve AdaptaLabs.</p>
                  <button 
                    className="btn btn-primary mt-3"
                    onClick={() => {
                      setSubmitted(false);
                      setFeedback('');
                    }}
                  >
                    Submit Another
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{styles}</style>
      {/* Static Grid Background */}
      <div className="mesh-gradient-background"></div>
      
      {/* Retro Computing Grid Squares Overlay */}
      <div className={`grid-squares-overlay ${!animationsEnabled ? 'animations-disabled' : ''}`}>
        {/* Full Grid Squares - Randomly light up (21 total) */}
        {Array.from({ length: 21 }).map((_, i) => (
          <div key={`full-${i}`} ref={(el) => fullGridSquareRefs.current[i] = el} className="full-grid-square"></div>
        ))}
        
        {/* Individual glowing squares (20 total) */}
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={`grid-${i}`} ref={(el) => squaresRef.current[i] = el} className="grid-square"></div>
        ))}
      </div>

      <div className="container mt-5 feedback-content-container">
        <div className="row justify-content-center">
          <div className="col-md-8">
            <div className="card feedback-card">
              <div className="card-header">
                <h2 className="mb-0">
                  <i className="bi bi-chat-left-text me-2"></i>
                  Send Feedback
                </h2>
              </div>
              <div className="card-body">
                <p className="text-muted">
                  Help us improve AdaptaLabs by sharing your feedback, reporting bugs, or suggesting features.
                </p>
                
                {error && (
                  <div className="alert alert-danger" role="alert">
                    {error}
                  </div>
                )}
                
                <form onSubmit={handleSubmit}>
                  <div className="mb-3">
                    <label htmlFor="category" className="form-label">
                      Category <span className="text-danger">*</span>
                    </label>
                    <select
                      id="category"
                      className="form-select"
                      value={category}
                      onChange={(e) => setCategory(e.target.value as typeof category)}
                      required
                    >
                      <option value="bug">🐛 Bug Report</option>
                      <option value="feature">💡 Feature Request</option>
                      <option value="question">❓ Question</option>
                      <option value="other">💬 Other Feedback</option>
                    </select>
                  </div>

                  <div className="mb-3">
                    <label htmlFor="feedback" className="form-label">
                      Your Feedback <span className="text-danger">*</span>
                    </label>
                    <textarea
                      id="feedback"
                      className="form-control"
                      rows={8}
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      placeholder="Please describe your feedback, bug report, or feature request in detail..."
                      required
                      aria-describedby="feedback-help"
                    />
                    <div id="feedback-help" className="form-text">
                      Be as specific as possible. For bug reports, include steps to reproduce the issue.
                    </div>
                  </div>

                  <div className="d-flex justify-content-end">
                    <button 
                      type="submit" 
                      className="btn btn-primary"
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                          Sending...
                        </>
                      ) : (
                        <>
                          <i className="bi bi-send me-2"></i>
                          Send Feedback
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default Feedback;
