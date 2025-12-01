import React, { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Session, CalendarEvent } from '../api/types';
import { getMyCalendarEvents, getCalendarConnectionStatus, getMyBookings } from '../api/client';
import { Info } from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform } from 'framer-motion';

interface CalendarGridProps {
  sessions: Session[];
  onBookSession: (sessionId: string) => void;
  bookingLoading: string | null;
  hideLegend?: boolean; // Allow parent to render legend elsewhere
}

// Export legend items for use in parent component
export const CALENDAR_LEGEND_ITEMS = [
  { className: 'legend-available', label: 'Available', labelClass: 'legend-label-available' },
  { className: 'legend-conflict', label: 'Conflict', labelClass: 'legend-label-conflict' },
  { className: 'legend-full', label: 'Full', labelClass: 'legend-label-full' },
  { className: 'legend-booked', label: 'Booked', labelClass: 'legend-label-booked' }
];

// ============================================================
// LEVEL 4: "LIVING INTERFACE" CALENDAR GRID
// Features: Staggered entry, spring physics, cursor spotlight,
// current time indicator, glassmorphic headers
// ============================================================

const CalendarGrid: React.FC<CalendarGridProps> = memo(({ sessions, onBookSession, bookingLoading, hideLegend = false }) => {
  const navigate = useNavigate();
  const [confirmingSlot, setConfirmingSlot] = useState<string | null>(null);
  const [bookedSlots, setBookedSlots] = useState<Set<string>>(new Set());
  const [userCalendarEvents, setUserCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  
  // Cursor spotlight state - scoped to grid area only
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [isMouseInGrid, setIsMouseInGrid] = useState(false);
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  
  // Smooth spring-based cursor tracking
  const smoothMouseX = useSpring(mouseX, { stiffness: 300, damping: 30 });
  const smoothMouseY = useSpring(mouseY, { stiffness: 300, damping: 30 });
  
  // Transform for spotlight position (hooks must be called unconditionally)
  const spotlightX = useTransform(smoothMouseX, x => x - 200);
  const spotlightY = useTransform(smoothMouseY, y => y - 200);
  
  // Update current time every minute for the time indicator
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000); // Update every minute
    
    return () => clearInterval(timer);
  }, []);
  
  // Track mouse position for cursor spotlight - only within grid area
  const handleGridMouseMove = useCallback((e: React.MouseEvent) => {
    if (gridContainerRef.current) {
      const rect = gridContainerRef.current.getBoundingClientRect();
      mouseX.set(e.clientX - rect.left);
      mouseY.set(e.clientY - rect.top);
    }
  }, [mouseX, mouseY]);
  
  const handleGridMouseEnter = useCallback(() => {
    setIsMouseInGrid(true);
  }, []);
  
  const handleGridMouseLeave = useCallback(() => {
    setIsMouseInGrid(false);
  }, []);
  
  // Load user bookings and populate bookedSlots when sessions change
  useEffect(() => {
    const loadUserBookings = async () => {
      if (!sessions || sessions.length === 0) {
        setBookedSlots(new Set());
        return;
      }

      try {
        const bookings = await getMyBookings();
        const allBookings = [...bookings.upcoming, ...bookings.past];
        const sessionIds = new Set(sessions.map(s => s.id));
        
        const bookedSessionIds = allBookings
          .filter(booking => booking.status === 'booked' && sessionIds.has(booking.session_id))
          .map(booking => booking.session_id);
        
        setBookedSlots(new Set(bookedSessionIds));
      } catch (error) {
        console.error('Error loading user bookings:', error);
        setBookedSlots(new Set());
      }
    };

    loadUserBookings();
  }, [sessions]);

  // Auto-detect calendar connection and fetch events when component mounts
  useEffect(() => {
    const checkAndFetchCalendar = async () => {
      if (!sessions || sessions.length === 0) return;

      try {
        setLoadingCalendar(true);
        
        let calendarConnectedStatus = false;
        try {
          const status = await getCalendarConnectionStatus();
          calendarConnectedStatus = status.connected;
          setCalendarConnected(status.connected);
        } catch (error: unknown) {
          setCalendarConnected(false);
        }

        const dates = sessions
          .map(s => new Date(s.start_time))
          .sort((a, b) => a.getTime() - b.getTime());
        
        if (dates.length === 0) return;

        const startTime = new Date(dates[0]);
        startTime.setHours(0, 0, 0, 0);
        
        const endTime = new Date(dates[dates.length - 1]);
        endTime.setHours(23, 59, 59, 999);

        const events = await getMyCalendarEvents(
          startTime.toISOString(),
          endTime.toISOString()
        );
        
        setUserCalendarEvents(events);
      } catch (error: unknown) {
        const axiosError = error as { response?: { status?: number } };
        if (axiosError.response?.status === 404) {
          setCalendarConnected(false);
        } else {
          setCalendarConnected(false);
        }
      } finally {
        setLoadingCalendar(false);
      }
    };

    checkAndFetchCalendar();
  }, [sessions]);

  // Check if a session conflicts with user's calendar
  const hasCalendarConflict = useCallback((session: Session): boolean => {
    if (userCalendarEvents.length === 0) {
      return false;
    }

    const sessionStart = new Date(session.start_time);
    const sessionEnd = new Date(session.end_time);

    const hasConflict = userCalendarEvents.some(event => {
      if (event.status === 'cancelled' || event.status === 'declined') {
        return false;
      }
      
      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);
      
      if (isNaN(eventStart.getTime()) || isNaN(eventEnd.getTime())) {
        return false;
      }
      
      const overlaps = (sessionStart < eventEnd && sessionEnd > eventStart);
      return overlaps;
    });
    
    return hasConflict;
  }, [userCalendarEvents]);

  // Format time for display (condensed format)
  const formatTime = (dateString: string, includeAmPm: boolean = true) => {
    const date = new Date(dateString);
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const isPM = hours >= 12;
    const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const minuteStr = minutes.toString().padStart(2, '0');
    
    if (includeAmPm) {
      return `${displayHour}:${minuteStr} ${isPM ? 'PM' : 'AM'}`;
    }
    return `${displayHour}:${minuteStr}`;
  };

  // Format time range - drops first AM/PM if both are the same
  const formatTimeRange = (startTime: string, endTime: string) => {
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const startIsPM = startDate.getUTCHours() >= 12;
    const endIsPM = endDate.getUTCHours() >= 12;
    
    // If both are AM or both are PM, drop the first suffix
    if (startIsPM === endIsPM) {
      return `${formatTime(startTime, false)} - ${formatTime(endTime, true)}`;
    }
    // Different periods, show both
    return `${formatTime(startTime, true)} - ${formatTime(endTime, true)}`;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  };

  // Helper function to get hour from time string
  const getHourFromSlot = (timeString: string): number => {
    const date = new Date(timeString);
    return date.getUTCHours() + (date.getUTCMinutes() / 60);
  };

  // Helper function to calculate position percentage (7am = 0%, 11pm = 100%)
  const getTimePosition = (hour: number): number => {
    const startHour = 7;
    const endHour = 23;
    const totalHours = endHour - startHour;
    const adjustedHour = hour - startHour;
    return Math.max(0, Math.min(100, (adjustedHour / totalHours) * 100));
  };

  // Generate time markers for left column (7am to 11pm)
  const generateTimeMarkers = (): Array<{ time: number; isHour: boolean }> => {
    const markers: Array<{ time: number; isHour: boolean }> = [];
    for (let hour = 7; hour <= 23; hour++) {
      markers.push({ time: hour, isHour: true });
      if (hour < 23) {
        markers.push({ time: hour + 0.5, isHour: false });
      }
    }
    return markers;
  };

  // Format time label for display
  const formatTimeLabel = (time: number): string => {
    const hour = Math.floor(time);
    const decimal = time % 1;
    let minutes = 0;
    if (decimal === 0.5) minutes = 30;
    
    const isPM = hour >= 12;
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const ampm = isPM ? 'PM' : 'AM';
    return `${displayHour}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  };

  // Group sessions by date and generate all days in the date range
  const groupSessionsByDate = () => {
    if (sessions.length === 0) {
      return [];
    }

    const dates = sessions
      .map(s => new Date(s.start_time))
      .sort((a, b) => a.getTime() - b.getTime());
    
    const startDate = new Date(dates[0]);
    startDate.setUTCHours(0, 0, 0, 0);
    
    const endDate = new Date(dates[dates.length - 1]);
    endDate.setUTCHours(23, 59, 59, 999);

    const sessionsByDateMap = new Map<string, Session[]>();
    
    sessions.forEach(session => {
      const date = new Date(session.start_time);
      date.setUTCHours(0, 0, 0, 0);
      const dateKey = date.toDateString();
      
      if (!sessionsByDateMap.has(dateKey)) {
        sessionsByDateMap.set(dateKey, []);
      }
      sessionsByDateMap.get(dateKey)!.push(session);
    });

    sessionsByDateMap.forEach((sessions, date) => {
      sessions.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    });

    const allDays: Array<[string, Session[]]> = [];
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
      const dayOfWeek = currentDate.getUTCDay();
      
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        const dateKey = currentDate.toDateString();
        const dateSessions = sessionsByDateMap.get(dateKey) || [];
        allDays.push([dateKey, dateSessions]);
      }
      
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return allDays;
  };

  const sessionsByDate = useMemo(() => groupSessionsByDate(), [sessions]);
  const timeMarkers = useMemo(() => generateTimeMarkers(), []);
  const timelineHeight = '900px';

  // Calculate current time position for the "Now" indicator
  const getCurrentTimePosition = useMemo(() => {
    const now = currentTime;
    const currentHour = now.getHours() + now.getMinutes() / 60;
    return getTimePosition(currentHour);
  }, [currentTime]);

  // Check if today is in the visible date range
  const todayColumnIndex = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toDateString();
    
    return sessionsByDate.findIndex(([date]) => {
      const sessionDate = new Date(date);
      sessionDate.setHours(0, 0, 0, 0);
      return sessionDate.toDateString() === todayStr;
    });
  }, [sessionsByDate, currentTime]);

  const handleSlotClick = (session: Session, slotElement: HTMLElement) => {
    const isBooked = bookedSlots.has(session.id);
    const hasConflict = hasCalendarConflict(session);
    const isAvailable = session.remaining > 0 && new Date(session.end_time) >= new Date();
    
    if (!isBooked && !hasConflict && isAvailable && !bookingLoading) {
      checkPopoverPosition(slotElement);
      setConfirmingSlot(session.id);
    }
  };

  const handleConfirmBooking = async (sessionId: string) => {
    try {
      setBookedSlots(prev => new Set([...prev, sessionId]));
      await onBookSession(sessionId);
      setConfirmingSlot(null);
    } catch (error) {
      setBookedSlots(prev => {
        const newSet = new Set(prev);
        newSet.delete(sessionId);
        return newSet;
      });
      setConfirmingSlot(null);
    }
  };

  const handleCancelBooking = () => {
    setConfirmingSlot(null);
  };

  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverFlipped, setPopoverFlipped] = useState(false);
  
  // Check if popover should flip to below when slot is near top of viewport
  const checkPopoverPosition = useCallback((slotElement: HTMLElement | null) => {
    if (!slotElement) {
      setPopoverFlipped(false);
      return;
    }
    const rect = slotElement.getBoundingClientRect();
    // Popover is ~150px tall, plus 12px gap. Flip if there's not enough space above.
    // Also account for header height (~70px)
    const minSpaceAbove = 180;
    setPopoverFlipped(rect.top < minSpaceAbove);
  }, []);

  useEffect(() => {
    if (!confirmingSlot) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setConfirmingSlot(null);
      }
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [confirmingSlot]);

  // ============================================================
  // FRAMER MOTION ANIMATION VARIANTS
  // ============================================================
  
  // Staggered column entry animation
  const columnVariants = {
    hidden: { 
      opacity: 0, 
      y: 30,
      scale: 0.95
    },
    visible: (i: number) => ({
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        delay: i * 0.1,
        duration: 0.5,
        ease: [0.25, 0.46, 0.45, 0.94] as const, // Custom easing for smooth feel
      }
    })
  };

  // Tactile slot interaction variants
  const slotVariants = {
    idle: { 
      scale: 1,
      boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
    },
    hover: { 
      scale: 1.03,
      boxShadow: '0 8px 25px rgba(0,0,0,0.12)',
      transition: {
        type: 'spring' as const,
        stiffness: 400,
        damping: 20
      }
    },
    tap: { 
      scale: 0.97,
      transition: {
        type: 'spring' as const,
        stiffness: 600,
        damping: 25
      }
    }
  };

  // Legend item animation
  const legendItemVariants = {
    hidden: { opacity: 0, x: -10 },
    visible: (i: number) => ({
      opacity: 1,
      x: 0,
      transition: {
        delay: 0.5 + i * 0.08,
        duration: 0.3
      }
    })
  };

  if (sessions.length === 0) {
    return (
      <motion.div 
        className="alert alert-info"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <Info size={18} className="me-2" />
        No sessions available
      </motion.div>
    );
  }

  if (sessionsByDate.length === 0) {
    return (
      <motion.div 
        className="alert alert-info d-flex align-items-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <Info size={18} className="me-2" />
        No sessions available
      </motion.div>
    );
  }

  // Use exported legend items
  const legendItems = CALENDAR_LEGEND_ITEMS;

  return (
    <div 
      className="calendar-view calendar-living-interface calendar-hud" 
      style={{ overflow: 'visible', position: 'relative' }}
    >
      {/* Ambient Glow Background - Dark Mode Only (via CSS) */}
      <div className="calendar-ambient-glow" aria-hidden="true" />
      <div className="calendar-ambient-glow-secondary" aria-hidden="true" />
      
      {/* Color-coded legend with staggered animation - conditionally rendered */}
      {!hideLegend && (
        <div className="calendar-legend d-flex flex-wrap gap-4 mb-4">
          {legendItems.map((item, index) => (
            <motion.div 
              key={item.label}
              className="d-flex align-items-center gap-2"
              custom={index}
              initial="hidden"
              animate="visible"
              variants={legendItemVariants}
            >
              <div className={`legend-swatch ${item.className}`}></div>
              <small className={`legend-label ${item.labelClass}`}>{item.label}</small>
            </motion.div>
          ))}
        </div>
      )}

      {/* Calendar Timeline - Page scroll with viewport-sticky headers */}
      <div className="calendar-timeline" style={{ 
        position: 'relative',
        overflow: 'visible'
      }}>
        {/* Viewport-Sticky Header Row */}
        <div className="calendar-sticky-header-row" style={{
          display: 'flex',
          gap: '24px',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          paddingTop: '8px',
          paddingBottom: '12px',
          marginBottom: '0'
        }}>
          {/* Empty space for time column alignment */}
          <div style={{ minWidth: '90px', width: '90px' }} />
          
          {/* Day Headers */}
          <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(sessionsByDate.length, 5)}, 1fr)`,
            gap: '24px'
          }}>
            {sessionsByDate.slice(0, 5).map(([date, dateSessions], columnIndex) => {
              const isToday = columnIndex === todayColumnIndex;
              return (
                <motion.div
                  key={`header-${date}`}
                  className="calendar-day-header-cell"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: columnIndex * 0.05 }}
                  style={{
                    textAlign: 'center',
                    padding: '8px'
                  }}
                >
                  <h6 
                    className="calendar-day-title mb-1" 
                    style={{ 
                      margin: 0,
                      marginBottom: '4px',
                      color: isToday ? 'var(--color-emerald-500, #10b981)' : undefined
                    }}
                  >
                    {formatDate(date)}
                    {isToday && (
                      <motion.span
                        initial={{ opacity: 0, scale: 0 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.3 }}
                        style={{
                          marginLeft: '8px',
                          fontSize: '10px',
                          fontWeight: 700,
                          color: 'white',
                          backgroundColor: '#059669',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px'
                        }}
                      >
                        Today
                      </motion.span>
                    )}
                  </h6>
                  <small className="calendar-day-sessions">
                    {dateSessions.length} session{dateSessions.length !== 1 ? 's' : ''}
                  </small>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Calendar Content */}
        <div style={{ 
          display: 'flex',
          gap: '24px',
          width: '100%'
        }}>
          {/* Time Column (Left) */}
          <motion.div 
            className="calendar-time-column" 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            style={{
              minWidth: '90px',
              width: '90px',
              position: 'sticky',
              left: 0,
              zIndex: 5
            }}
          >
            {/* Time Markers */}
            <div className="calendar-time-markers" style={{
              position: 'relative',
              height: timelineHeight
            }}>
              {timeMarkers.map((marker, index) => {
                if (!marker.isHour) return null;
                
                const position = getTimePosition(marker.time);
                
                return (
                  <div
                    key={`${marker.time}-${index}`}
                    className="calendar-time-label"
                    style={{
                      position: 'absolute',
                      top: `${position}%`,
                      left: 0,
                      right: 0,
                      pointerEvents: 'none',
                      backgroundColor: 'transparent'
                    }}
                  >
                    {formatTimeLabel(marker.time)}
                  </div>
                );
              })}
            </div>
          </motion.div>

          {/* Day Columns Container - Spotlight effect scoped here */}
          <div 
            ref={gridContainerRef}
            className="calendar-days-container" 
            onMouseMove={handleGridMouseMove}
            onMouseEnter={handleGridMouseEnter}
            onMouseLeave={handleGridMouseLeave}
            style={{ 
              position: 'relative',
              flex: 1,
              minWidth: `${Math.min(sessionsByDate.length, 5) * 140}px`,
              overflow: 'hidden'
            }}
          >
            {/* Cursor Spotlight Effect - Radial glow that follows the mouse within grid */}
            <motion.div
              className="cursor-spotlight"
              initial={{ opacity: 0 }}
              animate={{ opacity: isMouseInGrid ? 1 : 0 }}
              transition={{ duration: 0.2 }}
              style={{
                position: 'absolute',
                width: 400,
                height: 400,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(16, 185, 129, 0.08) 0%, rgba(16, 185, 129, 0.02) 40%, transparent 70%)',
                pointerEvents: 'none',
                zIndex: 0,
                x: spotlightX,
                y: spotlightY,
              }}
            />
            {/* Horizontal hour dividers - HUD style grid lines */}
            <div 
              className="calendar-grid-lines"
              style={{
                position: 'absolute',
                top: '0',
                left: 0,
                right: 0,
                height: timelineHeight,
                pointerEvents: 'none',
                zIndex: 1
              }}
            >
              {timeMarkers.filter(m => m.isHour).map((marker, index) => {
                const position = getTimePosition(marker.time);
                return (
                  <div
                    key={`divider-${marker.time}-${index}`}
                    className="calendar-grid-line"
                    style={{
                      position: 'absolute',
                      top: `${position}%`,
                      left: 0,
                      right: 0,
                      height: '1px'
                    }}
                  />
                );
              })}
            </div>
            
            {/* Current Time Indicator - The "Red Line" */}
            {todayColumnIndex >= 0 && getCurrentTimePosition >= 0 && getCurrentTimePosition <= 100 && (
              <motion.div
                className="current-time-indicator"
                initial={{ opacity: 0, scaleX: 0 }}
                animate={{ opacity: 1, scaleX: 1 }}
                transition={{ duration: 0.6, delay: 0.8, ease: 'easeOut' }}
                style={{
                  position: 'absolute',
                  top: `calc(${getCurrentTimePosition}% * 900 / 100)`,
                  left: 0,
                  right: 0,
                  zIndex: 10,
                  pointerEvents: 'none',
                  transformOrigin: 'left center'
                }}
              >
                {/* Live dot with pulse animation */}
                <motion.div
                  className="current-time-dot"
                  animate={{
                    scale: [1, 1.3, 1],
                    opacity: [1, 0.7, 1]
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                    ease: 'easeInOut'
                  }}
                  style={{
                    position: 'absolute',
                    left: -6,
                    top: -4,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: '#ef4444',
                    boxShadow: '0 0 8px rgba(239, 68, 68, 0.6)'
                  }}
                />
                {/* The red line */}
                <div
                  style={{
                    height: '2px',
                    backgroundColor: '#ef4444',
                    boxShadow: '0 0 4px rgba(239, 68, 68, 0.4)'
                  }}
                />
                {/* Time label */}
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1 }}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: -20,
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#ef4444',
                    backgroundColor: 'var(--bg-card, white)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                  }}
                >
                  NOW
                </motion.span>
              </motion.div>
            )}

            {/* Day Columns Grid - Content scrolls under sticky header */}
            <div style={{ 
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(sessionsByDate.length, 5)}, 1fr)`,
              gap: '24px',
              position: 'relative',
              zIndex: 3
            }}>
              {sessionsByDate.slice(0, 5).map(([date, dateSessions], columnIndex) => {
                const isToday = columnIndex === todayColumnIndex;
                const isPast = (() => {
                  const sessionDate = new Date(date);
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  sessionDate.setHours(0, 0, 0, 0);
                  return sessionDate < today;
                })();

                return (
                  <motion.div 
                    key={date} 
                    className={`calendar-day-column ${isToday ? 'calendar-day-today' : ''} ${isPast ? 'calendar-day-past' : ''}`}
                    custom={columnIndex}
                    initial="hidden"
                    animate="visible"
                    variants={columnVariants}
                    style={{ position: 'relative', width: '100%' }}
                  >
                    {/* Timeline Container with Ghost Hover Effect */}
                    <div className="calendar-timeline-container calendar-timeline-interactive" style={{ 
                      position: 'relative',
                      width: '100%',
                      height: timelineHeight,
                      border: 'none',
                      overflow: 'visible',
                      zIndex: 1,
                      opacity: isPast ? 0.5 : 1,
                      filter: isPast ? 'grayscale(30%)' : 'none',
                      transition: 'opacity 0.3s ease, filter 0.3s ease'
                    }}>
                      {/* Ghost Hover Cells - Visible faint highlight on empty space hover */}
                      {timeMarkers.filter(m => m.isHour && m.time < 23).map((marker, index) => {
                        const topPos = getTimePosition(marker.time);
                        const nextPos = getTimePosition(marker.time + 1);
                        const height = nextPos - topPos;
                        return (
                          <div
                            key={`ghost-${marker.time}-${index}`}
                            className="calendar-ghost-cell"
                            style={{
                              top: `${topPos}%`,
                              height: `${height}%`,
                            }}
                            aria-hidden="true"
                          />
                        );
                      })}
                      
                      {dateSessions.map((session, slotIndex) => {
                        const isBooked = bookedSlots.has(session.id);
                        const hasConflict = hasCalendarConflict(session);
                        const isFull = session.remaining <= 0;
                        const isAvailable = session.remaining > 0 && new Date(session.end_time) >= new Date();
                        const isSessionPast = new Date(session.end_time) < currentTime;
                        
                        const slotStartHour = getHourFromSlot(session.start_time);
                        const slotEndHour = getHourFromSlot(session.end_time);
                        
                        const topPosition = Math.max(0, Math.min(100, getTimePosition(slotStartHour)));
                        const bottomPosition = Math.max(0, Math.min(100, getTimePosition(slotEndHour)));
                        
                        const rawHeight = bottomPosition - topPosition;
                        const height = Math.max(0.01, rawHeight);
                        
                        const roundedTop = Math.round(topPosition * 10000) / 10000;
                        const roundedHeight = Math.round(height * 10000) / 10000;

                        const canClick = !isBooked && !hasConflict && isAvailable && !isFull && !bookingLoading && !isSessionPast;
                        const isConfirming = confirmingSlot === session.id;

                        let slotClass = 'calendar-slot calendar-slot-btn position-absolute ';
                        
                        if (isConfirming) {
                          slotClass += 'calendar-slot-selected';
                        } else if (isBooked) {
                          slotClass += 'calendar-slot-booked';
                        } else if (isFull) {
                          slotClass += 'calendar-slot-full';
                        } else if (hasConflict) {
                          slotClass += 'calendar-slot-conflict';
                        } else if (isSessionPast) {
                          slotClass += 'calendar-slot-past';
                        } else {
                          slotClass += 'calendar-slot-ghost';
                        }

                        return (
                          <motion.div
                            key={session.id}
                            className={slotClass}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: isSessionPast ? 0.4 : 1, scale: 1 }}
                            transition={{ 
                              delay: 0.3 + columnIndex * 0.1 + slotIndex * 0.05,
                              duration: 0.3
                            }}
                            variants={canClick ? slotVariants : undefined}
                            whileHover={canClick ? 'hover' : undefined}
                            whileTap={canClick ? 'tap' : undefined}
                            style={{ 
                              top: `${roundedTop}%`,
                              height: `${roundedHeight}%`,
                              maxHeight: `${roundedHeight}%`,
                              minHeight: '0',
                              boxSizing: 'border-box',
                              position: 'absolute',
                              // left/right/width controlled by CSS
                              cursor: canClick ? 'pointer' : 'not-allowed',
                              fontSize: '0.7rem',
                              padding: '2px 4px',
                              overflow: isConfirming ? 'visible' : 'hidden',
                              zIndex: isConfirming ? 9999 : (isBooked ? 5 : 2),
                              pointerEvents: canClick || isBooked ? 'auto' : 'none'
                            }}
                            title={(() => {
                              const startTime = formatTime(session.start_time);
                              const endTime = formatTime(session.end_time);
                              if (isBooked) return `Your booking: ${startTime} - ${endTime}`;
                              if (isFull) return `Full: ${startTime} - ${endTime}`;
                              if (hasConflict) return `Calendar conflict: ${startTime} - ${endTime}`;
                              if (isSessionPast) return `Past: ${startTime} - ${endTime}`;
                              return `Available: ${startTime} - ${endTime} (${session.remaining} remaining)`;
                            })()}
                            onClick={(e) => canClick && handleSlotClick(session, e.currentTarget as HTMLElement)}
                          >
                            {/* Time label - vertically centered */}
                            <div 
                              className="timeslot-label"
                              style={{
                                position: 'absolute',
                                top: '50%',
                                left: '0',
                                right: '0',
                                transform: 'translateY(-50%)',
                                width: '100%',
                                height: 'auto',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '11px',
                                fontWeight: '600',
                                letterSpacing: '-0.025em',
                                lineHeight: '1.25',
                                textAlign: 'center',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                padding: '0 2px',
                                pointerEvents: 'none'
                              }}>
                              {formatTimeRange(session.start_time, session.end_time)}
                            </div>

                            {/* Booking confirmation popover */}
                            <AnimatePresence>
                              {isConfirming && (
                                <motion.div 
                                  ref={popoverRef}
                                  className={`booking-popover ${popoverFlipped ? 'booking-popover-below' : ''}`}
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  exit={{ opacity: 0 }}
                                  transition={{ duration: 0.15 }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="booking-popover-header">Confirm Booking</div>
                                  <div className="booking-popover-time">
                                    {(() => {
                                      const startDate = new Date(session.start_time);
                                      const dayName = startDate.toLocaleDateString('en-US', { 
                                        weekday: 'long',
                                        timeZone: 'UTC'
                                      });
                                      return `${dayName}, ${formatTimeRange(session.start_time, session.end_time)}`;
                                    })()}
                                  </div>
                                  <div className="booking-popover-actions">
                                    <motion.button
                                      className="booking-popover-cancel"
                                      whileHover={{ scale: 1.02 }}
                                      whileTap={{ scale: 0.98 }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCancelBooking();
                                      }}
                                    >
                                      Cancel
                                    </motion.button>
                                    <motion.button
                                      className="booking-popover-confirm"
                                      whileHover={{ scale: 1.02 }}
                                      whileTap={{ scale: 0.98 }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleConfirmBooking(session.id);
                                      }}
                                    >
                                      Confirm
                                    </motion.button>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>

                            {/* Loading indicator */}
                            {bookingLoading === session.id && (
                              <motion.div 
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                style={{ 
                                  position: 'absolute',
                                  top: '50%',
                                  left: '50%',
                                  transform: 'translate(-50%, -50%)',
                                  zIndex: 10
                                }}
                              >
                                <div className="spinner-border spinner-border-sm" role="status" aria-label="Booking session" aria-busy="true">
                                  <span className="visually-hidden">Booking...</span>
                                </div>
                              </motion.div>
                            )}
                          </motion.div>
                        );
                      })}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

CalendarGrid.displayName = 'CalendarGrid';

export default CalendarGrid;
