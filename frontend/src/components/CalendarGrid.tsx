import React, { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Session, CalendarEvent } from '../api/types';
import { getMyCalendarEvents, getCalendarConnectionStatus, getMyBookings } from '../api/client';
import { Info } from 'lucide-react';

interface CalendarGridProps {
  sessions: Session[];
  onBookSession: (sessionId: string) => void;
  bookingLoading: string | null;
}

const CalendarGrid: React.FC<CalendarGridProps> = memo(({ sessions, onBookSession, bookingLoading }) => {
  const navigate = useNavigate();
  const [confirmingSlot, setConfirmingSlot] = useState<string | null>(null);
  const [bookedSlots, setBookedSlots] = useState<Set<string>>(new Set());
  const [userCalendarEvents, setUserCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  
  // Debug logging (disabled in production for performance)
  // console.log('CalendarGrid received sessions:', sessions?.map(s => ({ id: s.id, remaining: s.remaining, booked_count: s.booked_count, capacity: s.capacity })));
  
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
        
        // Find session IDs that user has booked
        const bookedSessionIds = allBookings
          .filter(booking => booking.status === 'booked' && sessionIds.has(booking.session_id))
          .map(booking => booking.session_id);
        
        // Performance: debug logging disabled in production
        // console.log('📅 CalendarGrid: Found booked sessions:', { totalBookings: allBookings.length, bookedSessionIds, sessionsCount: sessions.length });
        
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
        
        // First check if calendar is connected
        let calendarConnectedStatus = false;
        try {
          const status = await getCalendarConnectionStatus();
          calendarConnectedStatus = status.connected;
          setCalendarConnected(status.connected);
          
          // Performance: debug logging disabled in production
          // console.log('📅 CalendarGrid: Connection status:', status);
          
          if (!status.connected) {
            // console.log('📅 CalendarGrid: Calendar not connected, but will try to fetch events anyway (demo mode)');
            // In demo mode, we still want to fetch mock events even if "not connected"
            // So we continue rather than returning early
          }
        } catch (error: any) {
          // Performance: error logging kept but verbose logging disabled
          // console.error('📅 CalendarGrid: Error checking connection status:', error);
          setCalendarConnected(false);
          // Still try to fetch events in demo mode even if connection check fails
        }

        // Get date range from sessions
        const dates = sessions
          .map(s => new Date(s.start_time))
          .sort((a, b) => a.getTime() - b.getTime());
        
        if (dates.length === 0) return;

        const startTime = new Date(dates[0]);
        startTime.setHours(0, 0, 0, 0);
        
        const endTime = new Date(dates[dates.length - 1]);
        endTime.setHours(23, 59, 59, 999);

        // Fetch calendar events
        // Performance: debug logging disabled in production
        const events = await getMyCalendarEvents(
          startTime.toISOString(),
          endTime.toISOString()
        );
        
        setUserCalendarEvents(events);
      } catch (error: any) {
        if (error.response?.status === 404) {
          setCalendarConnected(false);
        } else {
          console.error('Error fetching user calendar:', error);
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
    // Even if calendarConnected is false, check conflicts if we have events (demo mode)
    if (userCalendarEvents.length === 0) {
      return false;
    }

    const sessionStart = new Date(session.start_time);
    const sessionEnd = new Date(session.end_time);

    const hasConflict = userCalendarEvents.some(event => {
      // Skip cancelled or declined events
      if (event.status === 'cancelled' || event.status === 'declined') {
        return false;
      }
      
      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);
      
      // Skip if event times are invalid
      if (isNaN(eventStart.getTime()) || isNaN(eventEnd.getTime())) {
        return false;
      }
      
      // Check for actual overlap (not just touching)
      // Events overlap if: sessionStart < eventEnd AND sessionEnd > eventStart
      const overlaps = (sessionStart < eventEnd && sessionEnd > eventStart);
      
      // Performance: conflict logging disabled in production
      // if (overlaps) { console.log('📅 Calendar conflict detected:', {...}); }
      
      return overlaps;
    });
    
    return hasConflict;
  }, [userCalendarEvents]);

  // Format time for display (12-hour format with AM/PM)
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC'
    });
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
    const startHour = 7; // 7 AM
    const endHour = 23; // 11 PM
    const totalHours = endHour - startHour; // 16 hours
    const adjustedHour = hour - startHour;
    return Math.max(0, Math.min(100, (adjustedHour / totalHours) * 100));
  };

  // Generate time markers for left column (7am to 11pm)
  const generateTimeMarkers = (): Array<{ time: number; isHour: boolean }> => {
    const markers: Array<{ time: number; isHour: boolean }> = [];
    for (let hour = 7; hour <= 23; hour++) {
      markers.push({ time: hour, isHour: true });
      if (hour < 23) {
        markers.push({ time: hour + 0.5, isHour: false }); // 30-minute marks
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

    // Find the date range from sessions
    const dates = sessions
      .map(s => new Date(s.start_time))
      .sort((a, b) => a.getTime() - b.getTime());
    
    const startDate = new Date(dates[0]);
    startDate.setUTCHours(0, 0, 0, 0);
    
    const endDate = new Date(dates[dates.length - 1]);
    endDate.setUTCHours(23, 59, 59, 999);

    // Group sessions by date
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

    // Sort sessions within each date by start time
    sessionsByDateMap.forEach((sessions, date) => {
      sessions.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    });

    // Generate all days in the range (excluding weekends)
    const allDays: Array<[string, Session[]]> = [];
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
      const dayOfWeek = currentDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
      
      // Only include weekdays (Monday-Friday)
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        const dateKey = currentDate.toDateString();
        const dateSessions = sessionsByDateMap.get(dateKey) || [];
        allDays.push([dateKey, dateSessions]);
      }
      
      // Move to next day
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return allDays;
  };

  // Memoize expensive calculations to prevent recalculation on every render
  const sessionsByDate = useMemo(() => groupSessionsByDate(), [sessions]);
  const timeMarkers = useMemo(() => generateTimeMarkers(), []);
  const timelineHeight = '900px'; // Fixed height for 16 hours

  const handleSlotClick = (session: Session) => {
    const isBooked = bookedSlots.has(session.id);
    const hasConflict = hasCalendarConflict(session);
    const isAvailable = session.remaining > 0 && new Date(session.end_time) >= new Date();
    
    if (!isBooked && !hasConflict && isAvailable && !bookingLoading) {
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

  // Ref for popover click-outside detection
  const popoverRef = useRef<HTMLDivElement>(null);

  // Click-outside handler to close popover
  useEffect(() => {
    if (!confirmingSlot) return;

    const handleClickOutside = (event: MouseEvent) => {
      // Check if click is outside the popover
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setConfirmingSlot(null);
      }
    };

    // Add listener with a small delay to prevent immediate close on the opening click
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [confirmingSlot]);

  if (sessions.length === 0) {
    return (
      <div className="alert alert-info">
        <Info size={18} className="me-2" />
        No sessions available
      </div>
    );
  }

  if (sessionsByDate.length === 0) {
    return (
      <div className="alert alert-info d-flex align-items-center">
        <Info size={18} className="me-2" />
        No sessions available
      </div>
    );
  }

  return (
    <div className="calendar-view" style={{ overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' }}>
      {/* Color-coded legend */}
      <div className="calendar-legend d-flex flex-wrap gap-3 mb-3">
        <div className="d-flex align-items-center gap-2">
          <div style={{ width: '20px', height: '20px', borderRadius: '2px', backgroundColor: '#28a745' }}></div>
          <small className="calendar-legend-text">Available</small>
        </div>
        <div className="d-flex align-items-center gap-2">
          <div className="bg-warning" style={{ width: '20px', height: '20px', borderRadius: '2px' }}></div>
          <small className="calendar-legend-text">Calendar Conflict</small>
        </div>
        <div className="d-flex align-items-center gap-2">
          <div className="bg-danger" style={{ width: '20px', height: '20px', borderRadius: '2px' }}></div>
          <small className="calendar-legend-text">Full</small>
        </div>
        <div className="d-flex align-items-center gap-2">
          <div style={{ width: '20px', height: '20px', borderRadius: '2px', backgroundColor: '#ff7700' }}></div>
          <small className="calendar-legend-text">Your Booking</small>
        </div>
      </div>

      {/* Calendar Timeline */}
      <div className="calendar-timeline" style={{ overflow: 'hidden' }}>
        <div style={{ 
          display: 'flex',
          gap: '8px',
          width: '100%',
          overflowX: 'hidden', /* Removed horizontal scrollbar */
          overflowY: 'hidden' /* Removed vertical scrollbar */
        }}>
          {/* Time Column (Left) */}
          <div className="calendar-time-column" style={{
            minWidth: '90px',
            width: '90px',
            position: 'sticky',
            left: 0,
            zIndex: 5
          }}>
            {/* Time Header */}
            <div className="calendar-time-header" style={{
              height: '60px'
            }}></div>
            {/* Time Markers */}
            <div className="calendar-time-markers" style={{
              position: 'relative',
              height: timelineHeight
            }}>
              {timeMarkers.map((marker, index) => {
                if (!marker.isHour) return null; // Only show hour markers
                
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
                      paddingTop: '2px',
                      paddingRight: '16px',
                      fontSize: '0.875rem',
                      fontWeight: '500',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                      pointerEvents: 'none',
                      lineHeight: '1.3',
                      backgroundColor: 'transparent',
                      textAlign: 'right',
                      color: 'var(--text-secondary)'
                    }}
                  >
                    {formatTimeLabel(marker.time)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Day Columns Container */}
          <div className="calendar-days-container" style={{ 
            position: 'relative',
            flex: 1,
            minWidth: `${Math.min(sessionsByDate.length, 5) * 120}px`
          }}>
            {/* Day Columns Grid */}
            <div style={{ 
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(sessionsByDate.length, 5)}, 1fr)`,
              gap: '8px',
              position: 'relative',
              zIndex: 3
            }}>
                {sessionsByDate.slice(0, 5).map(([date, dateSessions]) => (
                <div key={date} className="calendar-day-column" style={{ position: 'relative' }}>
                  {/* Day Header */}
                  <div className="calendar-day-header p-2" style={{ 
                    borderRadius: '8px 8px 0 0',
                    border: 'none',
                    height: '60px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center'
                  }}>
                    <h6 className="calendar-day-title mb-1" style={{ margin: 0 }}>
                      {formatDate(date)}
                    </h6>
                    <small className="calendar-day-sessions">
                      {dateSessions.length} session{dateSessions.length !== 1 ? 's' : ''}
                    </small>
                  </div>

                  {/* Timeline Container */}
                  <div className="calendar-timeline-container" style={{ 
                    position: 'relative',
                    height: timelineHeight,
                    border: 'none',
                    overflow: 'visible',
                    zIndex: 1
                  }}>
                    {dateSessions.map((session) => {
                        const isBooked = bookedSlots.has(session.id);
                        const hasConflict = hasCalendarConflict(session);
                        const isFull = session.remaining <= 0;
                        const isAvailable = session.remaining > 0 && new Date(session.end_time) >= new Date();
                        
                        // Calculate position
                        const slotStartHour = getHourFromSlot(session.start_time);
                        const slotEndHour = getHourFromSlot(session.end_time);
                        
                        const topPosition = Math.max(0, Math.min(100, getTimePosition(slotStartHour)));
                        const bottomPosition = Math.max(0, Math.min(100, getTimePosition(slotEndHour)));
                        
                        const rawHeight = bottomPosition - topPosition;
                        const height = Math.max(0.01, rawHeight);
                        
                        const roundedTop = Math.round(topPosition * 10000) / 10000;
                        const roundedHeight = Math.round(height * 10000) / 10000;

                        const canClick = !isBooked && !hasConflict && isAvailable && !isFull && !bookingLoading;
                        const isConfirming = confirmingSlot === session.id;

                        // Determine slot class based on state
                        let slotClass = 'calendar-slot calendar-slot-btn position-absolute ';
                        
                        if (isConfirming) {
                          slotClass += 'calendar-slot-selected';
                        } else if (isBooked) {
                          slotClass += 'calendar-slot-booked';
                        } else if (isFull) {
                          slotClass += 'calendar-slot-full';
                        } else if (hasConflict) {
                          slotClass += 'calendar-slot-conflict';
                        } else {
                          slotClass += 'calendar-slot-ghost';
                        }

                        return (
                          <div
                            key={session.id}
                            className={slotClass}
                            style={{ 
                              left: '4px',
                              right: '4px',
                              top: `${roundedTop}%`,
                              height: `${roundedHeight}%`,
                              maxHeight: `${roundedHeight}%`,
                              minHeight: '0',
                              boxSizing: 'border-box',
                              position: 'absolute',
                              cursor: canClick ? 'pointer' : 'not-allowed',
                              fontSize: '0.7rem',
                              padding: '2px 4px',
                              overflow: isConfirming ? 'visible' : 'hidden',
                              zIndex: isConfirming ? 9999 : (isBooked ? 5 : 1),
                              pointerEvents: canClick || isBooked ? 'auto' : 'none'
                            }}
                            title={(() => {
                              const startTime = formatTime(session.start_time);
                              const endTime = formatTime(session.end_time);
                              if (isBooked) return `Your booking: ${startTime} - ${endTime}`;
                              if (isFull) return `Full: ${startTime} - ${endTime}`;
                              if (hasConflict) return `Calendar conflict: ${startTime} - ${endTime}`;
                              return `Available: ${startTime} - ${endTime} (${session.remaining} remaining)`;
                            })()}
                            onClick={() => canClick && handleSlotClick(session)}
                          >
                            {/* Time label */}
                            <div 
                              className="timeslot-label"
                              style={{
                                position: 'absolute',
                                top: '2px',
                                left: '4px',
                                fontSize: '0.65rem',
                                fontWeight: '600',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: 'calc(100% - 24px)',
                                pointerEvents: 'none',
                                lineHeight: '1.2'
                              }}>
                              {formatTime(session.start_time)} - {formatTime(session.end_time)}
                            </div>

                            {/* Booking confirmation popover */}
                            {isConfirming && (
                              <div 
                                ref={popoverRef}
                                className="booking-popover" 
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="booking-popover-text">Book this session?</div>
                                <div className="booking-popover-actions">
                                  <button
                                    className="booking-popover-cancel"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCancelBooking();
                                    }}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    className="booking-popover-confirm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleConfirmBooking(session.id);
                                    }}
                                  >
                                    Confirm
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Loading indicator */}
                            {bookingLoading === session.id && (
                              <div style={{ 
                                position: 'absolute',
                                top: '50%',
                                left: '50%',
                                transform: 'translate(-50%, -50%)',
                                zIndex: 10
                              }}>
                                <div className="spinner-border spinner-border-sm" role="status" aria-label="Booking session" aria-busy="true">
                                  <span className="visually-hidden">Booking...</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// Display name for React DevTools debugging
CalendarGrid.displayName = 'CalendarGrid';

export default CalendarGrid;
