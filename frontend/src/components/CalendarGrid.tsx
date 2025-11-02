import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Session, CalendarEvent } from '../api/types';
import { getMyCalendarEvents, getCalendarConnectionStatus, getMyBookings } from '../api/client';

interface CalendarGridProps {
  sessions: Session[];
  onBookSession: (sessionId: string) => void;
  bookingLoading: string | null;
}

const CalendarGrid: React.FC<CalendarGridProps> = ({ sessions, onBookSession, bookingLoading }) => {
  const navigate = useNavigate();
  const [confirmingSlot, setConfirmingSlot] = useState<string | null>(null);
  const [bookedSlots, setBookedSlots] = useState<Set<string>>(new Set());
  const [userCalendarEvents, setUserCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  
  // Debug logging
  console.log('CalendarGrid received sessions:', sessions?.map(s => ({ id: s.id, remaining: s.remaining, booked_count: s.booked_count, capacity: s.capacity })));
  
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
        
        console.log('📅 CalendarGrid: Found booked sessions:', {
          totalBookings: allBookings.length,
          bookedSessionIds: bookedSessionIds,
          sessionsCount: sessions.length
        });
        
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
          
          console.log('📅 CalendarGrid: Connection status:', status);
          
          if (!status.connected) {
            console.log('📅 CalendarGrid: Calendar not connected, but will try to fetch events anyway (demo mode)');
            // In demo mode, we still want to fetch mock events even if "not connected"
            // So we continue rather than returning early
          }
        } catch (error: any) {
          console.error('📅 CalendarGrid: Error checking connection status:', error);
          setCalendarConnected(false);
          // Still try to fetch events in demo mode even if connection check fails
          console.log('📅 CalendarGrid: Will attempt to fetch events anyway (demo mode)');
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
        console.log('📅 CalendarGrid: Fetching calendar events from', startTime.toISOString(), 'to', endTime.toISOString());
        const events = await getMyCalendarEvents(
          startTime.toISOString(),
          endTime.toISOString()
        );
        
        console.log('📅 CalendarGrid: Fetched calendar events:', events.length, 'events');
        if (events.length > 0) {
          console.log('📅 CalendarGrid: Sample event:', {
            title: events[0].title,
            start: events[0].start,
            end: events[0].end
          });
        }
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
      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);
      const overlaps = (sessionStart < eventEnd && sessionEnd > eventStart);
      
      if (overlaps) {
        console.log('📅 Calendar conflict detected:', {
          session: `${sessionStart.toISOString()} - ${sessionEnd.toISOString()}`,
          event: `${event.title} (${eventStart.toISOString()} - ${eventEnd.toISOString()})`
        });
      }
      
      return overlaps;
    });
    
    return hasConflict;
  }, [calendarConnected, userCalendarEvents]);

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

  // Group sessions by date
  const groupSessionsByDate = () => {
    const sessionsByDate = new Map<string, Session[]>();
    
    sessions.forEach(session => {
      const date = new Date(session.start_time).toDateString();
      if (!sessionsByDate.has(date)) {
        sessionsByDate.set(date, []);
      }
      sessionsByDate.get(date)!.push(session);
    });

    // Sort sessions within each date by start time
    sessionsByDate.forEach((sessions, date) => {
      sessions.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    });

    return Array.from(sessionsByDate.entries()).sort((a, b) => 
      new Date(a[0]).getTime() - new Date(b[0]).getTime()
    );
  };

  const sessionsByDate = groupSessionsByDate();
  const timeMarkers = generateTimeMarkers();
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

  if (sessions.length === 0) {
    return (
      <div className="alert alert-info">
        <i className="bi bi-info-circle me-2"></i>
        No sessions available
      </div>
    );
  }

  if (sessionsByDate.length === 0) {
    return (
      <div className="alert alert-info">
        <i className="bi bi-info-circle me-2"></i>
        No sessions available
      </div>
    );
  }

  return (
    <div className="calendar-view" style={{ overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' }}>
      {/* Color-coded legend */}
      <div className="d-flex flex-wrap gap-3 mb-3">
        <div className="d-flex align-items-center gap-2">
          <div style={{ width: '20px', height: '20px', borderRadius: '2px', backgroundColor: '#28a745' }}></div>
          <small style={{ color: '#FF4E50', fontWeight: '500' }}>Available</small>
        </div>
        <div className="d-flex align-items-center gap-2">
          <div className="bg-warning" style={{ width: '20px', height: '20px', borderRadius: '2px' }}></div>
          <small style={{ color: '#FF4E50', fontWeight: '500' }}>Calendar Conflict</small>
        </div>
        <div className="d-flex align-items-center gap-2">
          <div className="bg-danger" style={{ width: '20px', height: '20px', borderRadius: '2px' }}></div>
          <small style={{ color: '#FF4E50', fontWeight: '500' }}>Full</small>
        </div>
        <div className="d-flex align-items-center gap-2">
          <div style={{ width: '20px', height: '20px', borderRadius: '2px', backgroundColor: '#ff7700' }}></div>
          <small style={{ color: '#FF4E50', fontWeight: '500' }}>Your Booking</small>
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
          <div style={{
            minWidth: '90px',
            width: '90px',
            position: 'sticky',
            left: 0,
            zIndex: 10,
            backgroundColor: '#0A091A' /* Black/near-black background */
          }}>
            {/* Time Header */}
            <div style={{
              height: '60px',
              borderBottom: '2px solid rgba(255, 78, 80, 0.3)', /* Red border with transparency */
              backgroundColor: '#0A091A' /* Black/near-black background */
            }}></div>
            {/* Time Markers */}
            <div style={{
              position: 'relative',
              height: timelineHeight,
              borderLeft: '2px solid rgba(255, 78, 80, 0.3)', /* Left keyline - starts at 7:00 AM */
              borderRight: '2px solid rgba(255, 78, 80, 0.3)' /* Right keyline - starts at 7:00 AM, both stop above header */
            }}>
              {timeMarkers.map((marker, index) => {
                if (!marker.isHour) return null; // Only show hour markers
                
                const position = getTimePosition(marker.time);
                
                return (
                  <div
                    key={`${marker.time}-${index}`}
                    style={{
                      position: 'absolute',
                      top: `${position}%`,
                      left: 0,
                      right: 0,
                      borderTop: '1.5px solid rgba(255, 78, 80, 0.3)', /* Red border with transparency */
                      paddingTop: '2px',
                      fontSize: '0.9rem',
                      fontWeight: '700',
                      color: '#FF4E50', /* Electric Coral red text */
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                      pointerEvents: 'none',
                      lineHeight: '1.3',
                      backgroundColor: 'transparent',
                      textAlign: 'center' /* Center time labels within their cells */
                    }}
                  >
                    {formatTimeLabel(marker.time)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Day Columns Container */}
          <div style={{ 
            position: 'relative',
            flex: 1,
            minWidth: `${Math.min(sessionsByDate.length, 5) * 120}px`,
            backgroundColor: '#0A091A' /* Black/near-black background */
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
                  <div className="text-center p-2" style={{ 
                    backgroundColor: '#0A091A', /* Black/near-black background */
                    borderRadius: '8px 8px 0 0',
                    border: 'none',
                    borderBottom: '1px solid rgba(255, 78, 80, 0.3)', /* Red border with transparency */
                    height: '60px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center'
                  }}>
                    <h6 className="mb-1 fw-bold" style={{ fontSize: '0.9rem', margin: 0, color: '#FF4E50', fontWeight: '700' }}>
                      {formatDate(date)}
                    </h6>
                    <small style={{ fontSize: '0.7rem', color: '#FF4E50', fontWeight: '500' }}>
                      {dateSessions.length} session{dateSessions.length !== 1 ? 's' : ''}
                    </small>
                  </div>

                  {/* Timeline Container */}
                  <div style={{ 
                    position: 'relative',
                    height: timelineHeight,
                    border: 'none',
                    backgroundColor: '#0A091A', /* Black/near-black background */
                    overflow: 'hidden',
                    zIndex: 1
                  }}>
                    {dateSessions.length === 0 ? (
                      <div className="text-center" style={{ 
                        fontSize: '0.8rem',
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        color: '#FF4E50' /* Electric Coral red text */
                      }}>
                        <i className="bi bi-calendar-x me-1"></i>
                        No sessions
                      </div>
                    ) : (
                      dateSessions.map((session) => {
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

                        // Determine styling
                        let slotStyle: React.CSSProperties = {};
                        
                        if (isBooked) {
                          slotStyle = { 
                            backgroundColor: '#ff7700',
                            color: '#000000',
                            borderColor: '#ff7700'
                          };
                        } else if (isFull) {
                          slotStyle = { 
                            backgroundColor: '#dc3545',
                            color: 'white',
                            borderColor: '#dc3545'
                          };
                        } else if (hasConflict) {
                          slotStyle = { 
                            backgroundColor: '#ffc107',
                            color: '#000000',
                            borderColor: '#ffc107'
                          };
                        } else {
                          slotStyle = { 
                            backgroundColor: '#28a745',
                            color: 'white',
                            borderColor: '#28a745'
                          };
                        }

                        const canClick = !isBooked && !hasConflict && isAvailable && !isFull && !bookingLoading;
                        const isConfirming = confirmingSlot === session.id;

                        return (
                          <div
                            key={session.id}
                            className={`calendar-slot calendar-slot-btn border cursor-pointer position-absolute`}
                            style={{ 
                              ...slotStyle,
                              left: '2px',
                              right: '2px',
                              top: `${roundedTop}%`,
                              height: `${roundedHeight}%`,
                              maxHeight: `${roundedHeight}%`,
                              minHeight: '0',
                              boxSizing: 'border-box',
                              position: 'absolute',
                              cursor: canClick ? 'pointer' : 'not-allowed',
                              opacity: (!canClick && !isBooked) ? 0.8 : 1,
                              transition: 'all 0.2s ease',
                              borderWidth: '1px',
                              borderRadius: '0',
                              fontSize: '0.7rem',
                              padding: '2px 4px',
                              overflow: 'hidden',
                              zIndex: isBooked ? 5 : 1,
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
                            onMouseEnter={(e) => {
                              if (canClick) {
                                e.currentTarget.style.transform = 'scale(1.02)';
                                e.currentTarget.style.boxShadow = '0 4px 8px rgba(40, 167, 69, 0.3)';
                              }
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.transform = '';
                              e.currentTarget.style.boxShadow = '';
                            }}
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
                                color: (isFull || isBooked || hasConflict) ? (isBooked ? '#000000' : hasConflict ? '#000000' : 'white') : 'white',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: 'calc(100% - 24px)',
                                pointerEvents: 'none',
                                lineHeight: '1.2',
                                opacity: 1
                              }}>
                              {formatTime(session.start_time)} - {formatTime(session.end_time)}
                            </div>

                            {/* Confirmation buttons */}
                            {isConfirming && (
                              <div className="confirmation-buttons" style={{
                                position: 'absolute',
                                top: '50%',
                                left: '50%',
                                transform: 'translate(-50%, -50%)',
                                display: 'flex',
                                gap: '8px',
                                zIndex: 10
                              }}>
                                <button
                                  className="btn btn-success btn-sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleConfirmBooking(session.id);
                                  }}
                                  title="Confirm booking"
                                >
                                  <i className="bi bi-check"></i>
                                </button>
                                <button
                                  className="btn btn-danger btn-sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCancelBooking();
                                  }}
                                  title="Cancel"
                                >
                                  <i className="bi bi-x"></i>
                                </button>
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
                                <div className="spinner-border spinner-border-sm" role="status">
                                  <span className="visually-hidden">Booking...</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CalendarGrid;
