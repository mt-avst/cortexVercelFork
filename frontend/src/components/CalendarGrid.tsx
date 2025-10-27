import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Session } from '../api/types';

interface CalendarGridProps {
  sessions: Session[];
  onBookSession: (sessionId: string) => void;
  bookingLoading: string | null;
}

interface CalendarSlot {
  date: string;
  timeSlots: TimeSlot[];
}

interface TimeSlot {
  session: Session;
  startHour: number;
  endHour: number;
  isAvailable: boolean;
}

const CalendarGrid: React.FC<CalendarGridProps> = ({ sessions, onBookSession, bookingLoading }) => {
  const navigate = useNavigate();
  const [confirmingSlot, setConfirmingSlot] = useState<string | null>(null);
  const [bookedSlots, setBookedSlots] = useState<Set<string>>(new Set());
  
  // Debug logging to help identify data freshness issues
  console.log('CalendarGrid received sessions:', sessions?.map(s => ({ id: s.id, remaining: s.remaining, booked_count: s.booked_count, capacity: s.capacity })));
  
  // Reset bookedSlots when sessions change to ensure fresh state
  useEffect(() => {
    setBookedSlots(new Set());
  }, [sessions]);
  // Group sessions by date and create time slots
  const createCalendarSlots = (): CalendarSlot[] => {
    const sessionsByDate = new Map<string, Session[]>();
    
    // Group sessions by date using UTC to match admin calendar
    sessions.forEach(session => {
      // session.start_time is already UTC from backend, parse it correctly
      const date = new Date(session.start_time).toDateString();
      if (!sessionsByDate.has(date)) {
        sessionsByDate.set(date, []);
      }
      sessionsByDate.get(date)!.push(session);
    });

    // Convert to calendar slots with exactly 5 slots per day
    return Array.from(sessionsByDate.entries()).map(([date, dateSessions]) => {
      const timeSlots: TimeSlot[] = [];
      
      // Create exactly 5 slots for this day
      for (let i = 0; i < 5; i++) {
        const session = dateSessions[i]; // Get session for this slot index
        
        if (session) {
          // Real session exists for this slot
          const startDate = new Date(session.start_time);
          const endDate = new Date(session.end_time);
          const now = new Date();
          const isAvailable = session.remaining > 0 && endDate >= now;
          
          // Debug logging
          console.log('🔍 CalendarGrid session processing:', {
            sessionId: session.id,
            startTime: session.start_time,
            endTime: session.end_time,
            capacity: session.capacity,
            bookedCount: session.booked_count,
            remaining: session.remaining,
            endDate: endDate.toISOString(),
            now: now.toISOString(),
            endDateAfterNow: endDate >= now,
            remainingGreaterThanZero: session.remaining > 0,
            isAvailable: isAvailable
          });
          
          timeSlots.push({
            session,
            startHour: startDate.getUTCHours(), // Use UTC to match admin calendar
            endHour: endDate.getUTCHours(), // Use UTC to match admin calendar
            isAvailable: isAvailable
          });
        } else {
          // No session for this slot - create empty slot with consistent time structure
          timeSlots.push({
            session: {
              id: `empty-${date}-${i}`,
              opportunity_id: '',
              start_time: '',
              end_time: '',
              capacity: 0,
              booked_count: 0,
              location_or_meet_link_optional: '',
              created_at: '',
              updated_at: '',
              remaining: 0
            },
            startHour: 0,
            endHour: 0,
            isAvailable: false
          });
        }
      }

      return {
        date,
        timeSlots
      };
    }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  };

  const calendarSlots = createCalendarSlots();

  const handleSlotClick = (slot: TimeSlot) => {
    if (slot.isAvailable && !bookingLoading && !bookedSlots.has(slot.session.id)) {
      setConfirmingSlot(slot.session.id);
    }
  };

  const handleConfirmBooking = async (sessionId: string) => {
    try {
      await onBookSession(sessionId);
      setBookedSlots(prev => {
        const newSet = new Set(prev);
        newSet.add(sessionId);
        return newSet;
      });
      setConfirmingSlot(null);
      
      // Don't navigate away - let user stay on the page to see the updated calendar
      // The parent component will handle showing success message and updating the calendar
    } catch (error) {
      setConfirmingSlot(null);
    }
  };

  const handleCancelBooking = () => {
    setConfirmingSlot(null);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric' 
    });
  };

  const formatTime = (dateString: string) => {
    // Ensure consistent UTC time formatting to match admin calendar
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC' // Force UTC to ensure consistency with admin calendar
    });
  };

  const getSlotColor = (slot: TimeSlot) => {
    // Check if this is an empty slot
    if (slot.session.id.startsWith('empty-')) return 'bg-light border';
    if (bookedSlots.has(slot.session.id)) return 'bg-secondary'; // Grey for booked slots
    if (!slot.isAvailable) {
      console.log('🔴 Slot showing as red/unavailable:', {
        sessionId: slot.session.id,
        isAvailable: slot.isAvailable,
        remaining: slot.session.remaining,
        bookedCount: slot.session.booked_count,
        capacity: slot.session.capacity,
        endTime: slot.session.end_time,
        isBooked: bookedSlots.has(slot.session.id)
      });
      return 'bg-danger'; // Red for unavailable slots (full)
    }
    console.log('🟢 Slot showing as green/available:', {
      sessionId: slot.session.id,
      isAvailable: slot.isAvailable,
      remaining: slot.session.remaining,
      bookedCount: slot.session.booked_count,
      capacity: slot.session.capacity
    });
    return 'calendar-slot-available'; // Custom green for available slots
  };

  const getSlotTextColor = (slot: TimeSlot) => {
    // Check if this is an empty slot
    if (slot.session.id.startsWith('empty-')) return 'text-muted';
    return 'text-white'; // White text for all colored slots
  };

  if (calendarSlots.length === 0) {
    return (
      <div className="alert alert-info">
        <i className="bi bi-info-circle me-2"></i>
        No sessions available
        <div className="mt-2">
          <small>Debug: Sessions count: {sessions?.length || 0}</small>
        </div>
      </div>
    );
  }

  return (
    <div className="calendar-grid">
      <div className="table-responsive">
        <table className="table table-bordered mb-0">
          <thead className="table-light">
            <tr>
              <th className="text-center" style={{ width: '120px' }}>
                <i className="bi bi-calendar-date me-1"></i>
                Slot
              </th>
              {calendarSlots.map((calendarSlot) => (
                <th key={calendarSlot.date} className="text-center" style={{ minWidth: '200px' }}>
                  <div className="fw-bold">
                    <i className="bi bi-calendar-date me-1"></i>
                    {formatDate(calendarSlot.date)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }, (_, slotIndex) => (
              <tr key={slotIndex}>
                <td className="text-center fw-bold bg-light">
                  <div className="py-2">
                    <i className="bi bi-clock me-1"></i>
                    Slot {slotIndex + 1}
                  </div>
                </td>
                {calendarSlots.map((calendarSlot) => {
                  const slot = calendarSlot.timeSlots[slotIndex];
                  return (
                    <td key={`${calendarSlot.date}-${slotIndex}`} className="p-2">
                      <div className="position-relative h-100">
                        {slot && slot.session.id.startsWith('empty-') ? (
                          <div
                            className={`btn w-100 calendar-slot-btn ${getSlotColor(slot)} ${getSlotTextColor(slot)}`}
                            style={{ 
                              fontSize: '0.9rem',
                              cursor: 'default'
                            }}
                          >
                            <div className="small">
                              <i className="bi bi-dash-circle me-1"></i>
                              Not available
                            </div>
                          </div>
                        ) : slot ? (
                          <div className="calendar-slot-container">
                            <button
                              className={`btn w-100 calendar-slot-btn ${getSlotColor(slot)} ${getSlotTextColor(slot)}`}
                              onClick={() => handleSlotClick(slot)}
                              disabled={!slot.isAvailable || bookingLoading === slot.session.id || bookedSlots.has(slot.session.id)}
                              title={
                                slot.session.id.startsWith('empty-')
                                  ? "No session available"
                                  : bookedSlots.has(slot.session.id)
                                    ? "You have booked this session"
                                    : !slot.isAvailable
                                      ? "Session is full"
                                      : bookingLoading === slot.session.id
                                        ? "Booking in progress..."
                                        : "Click to book this session"
                              }
                              style={{ 
                                fontSize: '0.9rem'
                              }}
                            >
                              <div className="fw-bold" style={{ fontSize: '0.85rem' }}>
                                {formatTime(slot.session.start_time)} - {formatTime(slot.session.end_time)}
                              </div>
                              
                              {bookingLoading === slot.session.id && (
                                <div className="position-absolute top-50 start-50 translate-middle">
                                  <div className="spinner-border spinner-border-sm" role="status">
                                    <span className="visually-hidden">Booking...</span>
                                  </div>
                                </div>
                              )}
                            </button>
                            
                            {/* Confirmation buttons */}
                            {confirmingSlot === slot.session.id && (
                              <div className="confirmation-buttons">
                                <button
                                  className="btn btn-success btn-sm confirmation-btn confirm-btn"
                                  onClick={() => handleConfirmBooking(slot.session.id)}
                                  title="Confirm booking"
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.transform = 'scale(1.1)';
                                    e.currentTarget.style.boxShadow = '0 3px 6px rgba(0, 0, 0, 0.3)';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.transform = '';
                                    e.currentTarget.style.boxShadow = '';
                                  }}
                                >
                                  <i className="bi bi-check"></i>
                                </button>
                                <button
                                  className="btn btn-danger btn-sm confirmation-btn cancel-btn"
                                  onClick={handleCancelBooking}
                                  title="Cancel"
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.transform = 'scale(1.1)';
                                    e.currentTarget.style.boxShadow = '0 3px 6px rgba(0, 0, 0, 0.3)';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.transform = '';
                                    e.currentTarget.style.boxShadow = '';
                                  }}
                                >
                                  <i className="bi bi-x"></i>
                                </button>
                              </div>
                            )}
                            
                          </div>
                        ) : (
                          <div 
                            className="btn w-100 calendar-slot-btn bg-light border text-muted" 
                            style={{ fontSize: '0.9rem', cursor: 'default' }}
                            title="No session available at this time"
                          >
                            <div className="small">
                              <i className="bi bi-dash-circle me-1"></i>
                              No session
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CalendarGrid;
